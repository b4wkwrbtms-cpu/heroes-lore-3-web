import { WorkletSynthesizer } from "spessasynth_lib";

import { Ma3Player } from "./ma3/player";
import { type Ma3Score, parseMa3Score } from "./ma3/smaf";

type MidiEvent = [time: number, kind: "midi", data: Uint8Array];
type WaveEvent = [time: number, kind: "wave", channels: number, samplingRate: number, samples: Int16Array];
type TransportEvent = MidiEvent | WaveEvent;

type WorkerOutput =
  | { type: "event"; handle: number; deadline: number; event: TransportEvent }
  | { type: "cleanup"; handle: number; deadline: number; channels: number[]; notes: [number, number][]; immediate: boolean };

type AudioState = {
  synth: WorkletSynthesizer | null;
  ma3: Ma3Player;
  ctx: AudioContext;
  clockAudioTime: number;
  clockPerformanceTime: number;
  midiGain: GainNode;
  pcmGain: GainNode;
  pcmSources: Map<number, Set<AudioBufferSourceNode>>;
};

/** How long after a stop the same background music still resumes instead of restarting. */
const MUSIC_RESUME_SECONDS = 20;
/** The FM worklet starts a score this long after it is asked to (matches its START_DELAY_SECONDS). */
const MUSIC_START_DELAY_SECONDS = 0.06;

/** Cheap content fingerprint (FNV-1a) to recognise the same song coming back on a new clip. */
function fingerprint(data: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) hash = Math.imul(hash ^ data[i], 0x01000193);
  return hash >>> 0;
}

let midiVolume = 0.5;
let pcmVolume = 0.5;

export type BgmEngine = "fm" | "gm";
const BGM_ENGINE_KEY = "wie_bgm_engine";
let bgmEngine: BgmEngine = loadBgmEngine();

/** Which synthesizer plays MA-3 scores: their own FM voices, or the General MIDI soundfont. */
export function loadBgmEngine(): BgmEngine {
  try {
    return window.localStorage.getItem(BGM_ENGINE_KEY) === "gm" ? "gm" : "fm";
  } catch {
    return "fm";
  }
}

export function setBgmEngine(value: BgmEngine): void {
  bgmEngine = value;
  try {
    window.localStorage.setItem(BGM_ENGINE_KEY, value);
  } catch {
    // storage unavailable
  }
}
let audioReady: Promise<AudioState | null> | undefined;
let currentContext: AudioContext | undefined;
let unlockInstalled = false;
let silentLoop: HTMLAudioElement | undefined;

// 0.1 s of 8 kHz 8-bit silence. Playing it in a looping <audio> element switches iOS to the media
// playback audio session, so Web Audio keeps sounding with the ringer switch on silent.
const SILENT_WAV = `data:audio/wav;base64,${btoa(
  String.fromCharCode(
    ...[0x52, 0x49, 0x46, 0x46, 0x44, 0x03, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20, 0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
      0x40, 0x1f, 0x00, 0x00, 0x40, 0x1f, 0x00, 0x00, 0x01, 0x00, 0x08, 0x00, 0x64, 0x61, 0x74, 0x61, 0x20, 0x03, 0x00, 0x00],
  ) + "\x80".repeat(800),
)}`;

/**
 * Browsers (iOS above all) only let an AudioContext run after a user gesture, and the emulator starts
 * music on its own schedule. Resume the context synchronously inside the first gestures we see.
 */
function installUnlock(): void {
  if (unlockInstalled || typeof document === "undefined") return;
  unlockInstalled = true;
  const unlock = () => {
    const ctx = currentContext;
    if (ctx && ctx.state !== "running") {
      void ctx.resume().then(() => {
        void audioReady?.then(state => {
          if (!state || state.ctx !== ctx) return;
          state.clockAudioTime = ctx.currentTime;
          state.clockPerformanceTime = performance.timeOrigin + performance.now();
        });
      }).catch(() => {});
    }
    if (!silentLoop) {
      silentLoop = document.createElement("audio");
      silentLoop.setAttribute("playsinline", "");
      silentLoop.loop = true;
      silentLoop.volume = 0.01;
      silentLoop.src = SILENT_WAV;
    }
    if (silentLoop.paused) void silentLoop.play().catch(() => {});
  };
  for (const type of ["pointerdown", "touchend", "mousedown", "keydown"] as const) {
    document.addEventListener(type, unlock, { capture: true, passive: true });
  }
}

async function initAudio(ctx: AudioContext): Promise<AudioState> {
  const midiGain = ctx.createGain();
  midiGain.gain.value = midiVolume;
  midiGain.connect(ctx.destination);

  const pcmGain = ctx.createGain();
  pcmGain.gain.value = pcmVolume;
  pcmGain.connect(ctx.destination);

  let synth: WorkletSynthesizer | null = null;
  try {
    await ctx.audioWorklet.addModule(new URL("spessasynth_processor.min.js", document.baseURI).href);
    synth = new WorkletSynthesizer(ctx);
    const buffer = await fetch("1mgm.sf2").then(response => response.arrayBuffer());
    await synth.soundBankManager.addSoundBank(buffer, "main");
    await synth.isReady;
    synth.connect(midiGain);
  } catch (error) {
    console.warn("MIDI output is unavailable:", error);
  }

  // MA-3 scores are synthesized with their own FM voices; only their sampled drums fall back to the soundfont.
  const ma3 = new Ma3Player(ctx, midiGain, (data, time) => synth?.sendMessage(data, 0, { time }));

  return {
    synth,
    ma3,
    ctx,
    clockAudioTime: ctx.currentTime,
    clockPerformanceTime: performance.timeOrigin + performance.now(),
    midiGain,
    pcmGain,
    pcmSources: new Map(),
  };
}

export function setMasterVolume(value: number): void {
  midiVolume = value;
  audioReady?.then(state => {
    if (state) state.midiGain.gain.value = value;
  });
}

export function setPcmVolume(value: number): void {
  pcmVolume = value;
  audioReady?.then(state => {
    if (state) state.pcmGain.gain.value = value;
  });
}

export class AudioPlayer {
  private readonly worker = new Worker(new URL("./audio-worker.ts", import.meta.url), { type: "module" });
  private ctx?: AudioContext;
  private readonly audioReady = Promise.resolve()
    .then(() => {
      if (this.disposed) return null;
      this.ctx = new AudioContext();
      currentContext = this.ctx;
      return initAudio(this.ctx);
    })
    .catch(error => {
      console.warn("AudioPlayer init failed, audio will be silent:", error);
      return null;
    });
  private commands: Promise<void> = Promise.resolve();
  private disposed = false;
  /** Parsed MA-3 scores by content fingerprint; null marks clips that play as General MIDI. The game recreates its
   *  clips all the time (every sound effect recreates the background music), so they are parsed once. */
  private readonly scores = new Map<number, Ma3Score | null>();

  constructor() {
    audioReady = this.audioReady;
    installUnlock();
    this.worker.onmessage = (message: MessageEvent<WorkerOutput>) => {
      void this.audioReady.then(state => {
        if (!state || this.disposed) return;

        const output = message.data;
        const time = Math.max(state.ctx.currentTime, state.clockAudioTime + (output.deadline - state.clockPerformanceTime) / 1000);

        if (output.type === "event") {
          if (output.event[1] === "midi") {
            state.synth?.sendMessage(output.event[2], 0, { time });
            return;
          }

          const [, , channels, samplingRate, samples] = output.event;
          if (channels === 0 || samplingRate === 0) return;

          const frameCount = Math.floor(samples.length / channels);
          const buffer = state.ctx.createBuffer(channels, frameCount, samplingRate);
          for (let channel = 0; channel < channels; channel++) {
            const data = buffer.getChannelData(channel);
            for (let frame = 0; frame < frameCount; frame++) {
              data[frame] = samples[frame * channels + channel] / 32768;
            }
          }

          const source = state.ctx.createBufferSource();
          source.buffer = buffer;
          source.connect(state.pcmGain);
          const sources = state.pcmSources.get(output.handle) ?? new Set<AudioBufferSourceNode>();
          sources.add(source);
          state.pcmSources.set(output.handle, sources);
          source.onended = () => {
            sources.delete(source);
            if (sources.size === 0) state.pcmSources.delete(output.handle);
          };
          source.start(time);
          return;
        }

        const cleanupTimes = output.immediate && time > state.ctx.currentTime ? [state.ctx.currentTime, time] : [time];
        for (const cleanupTime of cleanupTimes) {
          for (const [channel, note] of output.notes) {
            state.synth?.sendMessage([0x80 | channel, note, 0], 0, { time: cleanupTime });
          }
          for (const channel of output.channels) {
            state.synth?.sendMessage([0xb0 | channel, 64, 0], 0, { time: cleanupTime });
            state.synth?.sendMessage([0xb0 | channel, 120, 0], 0, { time: cleanupTime });
            state.synth?.sendMessage([0xb0 | channel, 123, 0], 0, { time: cleanupTime });
          }
        }

        if (output.immediate) {
          for (const source of state.pcmSources.get(output.handle) ?? []) {
            source.stop(state.ctx.currentTime);
          }
        }
      });
    };
  }

  /** The looping score now playing, to know where it was when the game stops it for a sound effect. */
  private music: { handle: number; key: number; startedAt: number; offset: number; duration: number } | undefined;
  /** Where the last stopped looping score left off; the same score played again soon after resumes there. */
  private musicResume: { key: number; position: number; at: number } | undefined;

  private scoreFor(key: number, source: Uint8Array): Ma3Score | null {
    const cached = this.scores.get(key);
    if (cached !== undefined) return cached;
    const score = parseMa3Score(source);
    if (this.scores.size >= 256) this.scores.delete(this.scores.keys().next().value as number);
    this.scores.set(key, score);
    return score;
  }

  public play(handle: number, duration: number, events: TransportEvent[], repeat: boolean, source?: Uint8Array): void {
    const key = bgmEngine === "fm" && source && source.length > 0 ? fingerprint(source) : undefined;
    const score = key !== undefined && source ? this.scoreFor(key, source) : null;
    this.commands = this.commands
      .then(async () => {
        const state = await this.audioReady;
        if (this.disposed) return;
        if (state?.ctx.state === "suspended") {
          await state.ctx.resume();
          state.clockAudioTime = state.ctx.currentTime;
          state.clockPerformanceTime = performance.timeOrigin + performance.now();
        }
        if (this.disposed) return;
        // An MA-3 score plays on the FM synthesizer; the worker only gets its sampled streams. Should the
        // synthesizer be unavailable, the whole clip falls back to General MIDI.
        let scheduled = events;
        // The game has a single sound channel: every sound effect stops the background music and plays it again
        // afterwards, which on the FM path restarted the song each time. Resume it where it left off instead.
        let offset = 0;
        if (score && state && repeat && key !== undefined) {
          const resume = this.musicResume;
          if (resume && resume.key === key && state.ctx.currentTime - resume.at < MUSIC_RESUME_SECONDS) offset = resume.position;
          this.musicResume = undefined;
          this.music = { handle, key, startedAt: state.ctx.currentTime + MUSIC_START_DELAY_SECONDS, offset, duration: score.duration };
        }
        if (score && key !== undefined && state && (await state.ma3.play(handle, key, score, repeat, offset))) {
          scheduled = events.filter(event => event[1] === "wave");
          if (scheduled.length === 0) return;
        }
        if (this.disposed) return;
        const buffers = scheduled.map(event => (event[1] === "midi" ? event[2].buffer : event[4].buffer));
        this.worker.postMessage({ type: "play", handle, duration, events: scheduled, repeat }, buffers);
      })
      .catch(error => console.warn("Failed to start audio playback:", error));
  }

  public stop(handle: number): void {
    this.commands = this.commands
      .then(async () => {
        const state = await this.audioReady;
        if (this.disposed) return;
        if (state && this.music?.handle === handle) {
          const music = this.music;
          const elapsed = Math.max(0, state.ctx.currentTime - music.startedAt) * 1000;
          this.musicResume = { key: music.key, position: (music.offset + elapsed) % Math.max(1, music.duration), at: state.ctx.currentTime };
          this.music = undefined;
        }
        if (state) void state.ma3.stop(handle);
        this.worker.postMessage({ type: "stop", handle });
      })
      .catch(error => console.warn("Failed to stop audio playback:", error));
  }

  public dispose(): void {
    this.disposed = true;
    this.worker.terminate();
    if (audioReady === this.audioReady) audioReady = undefined;
    if (currentContext === this.ctx) currentContext = undefined;
    void this.ctx?.close().catch(error => console.warn("Failed to close audio context:", error));
    void this.audioReady.then(state => {
      state?.ma3.dispose();
      state?.synth?.destroy();
    });
  }
}

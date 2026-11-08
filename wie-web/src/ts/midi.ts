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

let midiVolume = 0.5;
let pcmVolume = 0.5;
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
  /** Parsed MA-3 scores by clip handle; null marks clips that play as General MIDI. */
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

  private scoreFor(handle: number, source: Uint8Array | undefined): Ma3Score | null {
    const cached = this.scores.get(handle);
    if (cached !== undefined) return cached;
    const score = source ? parseMa3Score(source) : null;
    if (this.scores.size >= 64) this.scores.delete(this.scores.keys().next().value as number);
    this.scores.set(handle, score);
    return score;
  }

  public play(handle: number, duration: number, events: TransportEvent[], repeat: boolean, source?: Uint8Array): void {
    const score = this.scoreFor(handle, source);
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
        if (score && state && (await state.ma3.play(handle, score, repeat))) {
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
        if (state && this.scores.get(handle)) void state.ma3.stop(handle);
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

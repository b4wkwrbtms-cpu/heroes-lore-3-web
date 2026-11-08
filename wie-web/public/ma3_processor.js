// AudioWorklet processor that plays MA-3 SMAF scores with an FM synthesizer modelled on the Yamaha
// YMF825 (SD-1) tone generator, the same FM core the MA-3 phone chip used. Scores arrive already
// parsed (see ma3/smaf.ts); this file is plain JavaScript because worklet modules are loaded as-is.
//
// FM voices are synthesized here. Voices that reference the chip's built-in PCM drum waves cannot be
// synthesized, so their notes are handed back to the main thread as timed General MIDI percussion.

const TWO_PI = Math.PI * 2;
const TABLE_SIZE = 2048;
const TABLE_MASK = TABLE_SIZE - 1;
const MAX_ATTENUATION = 96;
const DB_STEPS = 16;
const MAX_VOICES = 32;
const LOOKAHEAD_SECONDS = 0.15;
const START_DELAY_SECONDS = 0.06;
const FM_GAIN = 1.2;
// Phase deviation in cycles produced by a full-scale modulator output (OPL-family scale, 8π).
const MOD_CYCLES = 4;
// Feedback level 0..7 → phase deviation in cycles for a full-scale averaged output (0, π/16 .. 4π).
const FEEDBACK_CYCLES = [0, 1 / 32, 1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2];
const MULTI = [0.5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 12, 12, 15, 15];
const DETUNE_UNITS = [0, 1, 2, 3, -1, -2, -3, -4];
const KSL_DB_PER_OCTAVE = [0, 3, 1.5, 6];
const LFO_HZ = [1.8, 4.0, 5.9, 7.0];
const VIBRATO_CENTS = [3.4, 6.7, 13.5, 26.8];
const TREMOLO_DB = [1.3, 2.8, 5.8, 11.8];
const BO_SEMITONES = [12, 0, -12, -24];
const CARRIERS = [[1], [0, 1], [0, 1, 2, 3], [3], [3], [1, 3], [0, 3], [0, 2, 3]];
const FEEDBACK_OPS = [[0], [0], [0, 2], [0], [0], [0, 2], [0], [0]];

const STAGE_ATTACK = 0;
const STAGE_DECAY = 1;
const STAGE_SUSTAIN = 2;
const STAGE_HOLD = 3;
const STAGE_RELEASE = 4;
const STAGE_OFF = 5;

function baseShape(group, x) {
  switch (group) {
    case 1: {
      const s = 2 * Math.sin(TWO_PI * x);
      return s > 1 ? 1 : s < -1 ? -1 : s;
    }
    case 2:
      return x < 0.25 ? 4 * x : x < 0.75 ? 2 - 4 * x : 4 * x - 4;
    case 3:
      return x < 0.5 ? 2 * x : 2 * x - 2;
    default:
      return Math.sin(TWO_PI * x);
  }
}

function waveValue(ws, x) {
  const group = ws >> 3;
  const half = x % 0.5;
  switch (ws & 7) {
    case 0:
      return baseShape(group, x);
    case 1:
      return x < 0.5 ? baseShape(group, x) : 0;
    case 2:
      return baseShape(group, half);
    case 3:
      return half < 0.25 ? baseShape(group, half) : 0;
    case 4:
      return x < 0.5 ? baseShape(group, 2 * x) : 0;
    case 5:
      return x < 0.5 ? baseShape(group, (2 * x) % 0.5) : 0;
    case 6:
      if (group === 0) return x < 0.5 ? 1 : -1;
      if (group === 1) return x < 0.5 ? 1 : 0;
      if (group === 2) return half < 0.25 ? 1 : 0;
      return x < 0.25 ? 1 : 0;
    default:
      if (group === 0) return x < 0.5 ? Math.pow(2, -32 * x) : -Math.pow(2, -32 * (1 - x));
      return baseShape(0, x);
  }
}

const WAVES = [];
for (let ws = 0; ws < 32; ws++) {
  const table = new Float32Array(TABLE_SIZE + 1);
  for (let i = 0; i < TABLE_SIZE; i++) table[i] = waveValue(ws, i / TABLE_SIZE);
  table[TABLE_SIZE] = table[0];
  WAVES.push(table);
}

const DB_TABLE = new Float32Array(MAX_ATTENUATION * DB_STEPS + 1);
for (let i = 0; i < DB_TABLE.length; i++) DB_TABLE[i] = Math.pow(10, -i / DB_STEPS / 20);
const DB_TABLE_MAX = DB_TABLE.length - 1;

function gainForDb(db) {
  if (db <= 0) return 1;
  const index = (db * DB_STEPS) | 0;
  return index >= DB_TABLE_MAX ? 0 : DB_TABLE[index];
}

/** Seconds a rate needs to travel the whole envelope range (attack: to reach the peak). */
function rateSeconds(rate, keyScale, attack) {
  if (rate === 0) return Infinity;
  const effective = Math.min(63, rate * 4 + keyScale);
  if (attack && effective >= 60) return 0;
  return (attack ? 2.82624 : 39.28) * Math.pow(2, -(effective - 4) / 4);
}

function noteFrequency(note) {
  return 440 * Math.pow(2, (note - 69) / 12);
}

function keyCode(note) {
  const block = Math.floor(note / 12) - 1;
  const high = (((note % 12) + 12) % 12) >= 7 ? 1 : 0;
  return Math.max(0, Math.min(15, block * 2 + high));
}

function velocityGain(velocity) {
  const v = Math.max(1, Math.min(127, velocity)) / 127;
  return v * v;
}

function channelGain(channel) {
  const v = (channel.volume / 127) * (channel.expression / 127);
  return v * v;
}

function panGains(pan) {
  const angle = ((pan + 1) / 2) * (Math.PI / 2);
  return [Math.cos(angle), Math.sin(angle)];
}

class FmVoice {
  constructor() {
    this.active = false;
    this.ops = 0;
    this.alg = 0;
    this.phase = new Float64Array(4);
    this.inc = new Float64Array(4);
    this.attenuation = new Float64Array(4);
    this.stage = new Int32Array(4);
    this.attackCoef = new Float64Array(4);
    this.decayRate = new Float64Array(4);
    this.sustainRate = new Float64Array(4);
    this.releaseRate = new Float64Array(4);
    this.sustainLevel = new Float64Array(4);
    this.baseAttenuation = new Float64Array(4);
    this.vibrato = new Float64Array(4);
    this.tremolo = new Float64Array(4);
    this.feedback = new Float64Array(4);
    this.history0 = new Float64Array(4);
    this.history1 = new Float64Array(4);
    this.ignoreKeyOff = new Uint8Array(4);
    this.wave = new Array(4).fill(WAVES[0]);
    this.isCarrier = new Uint8Array(4);
    this.lfoPhase = 0;
    this.lfoInc = 0;
    this.gain = 1;
    this.left = 1;
    this.right = 0;
    this.channel = 0;
    this.note = 0;
    this.offAt = Infinity;
    this.startedAt = 0;
    this.baseFrequency = 440;
    this.bendInc = new Float64Array(4);
  }

  keyOn(patch, note, velocity, channel, pan, modulation, bend, startedAt, offAt) {
    const sampleRate = globalThis.sampleRate;
    const pitch = (patch.drumKey > 0 ? patch.drumKey : note) + BO_SEMITONES[patch.bo & 3];
    const frequency = noteFrequency(pitch);
    const kc = keyCode(pitch);
    const octavesAboveRef = Math.max(0, Math.log2(frequency / 50));
    const count = patch.alg < 2 ? 2 : 4;
    this.active = true;
    this.ops = count;
    this.alg = patch.alg & 7;
    this.channel = channel;
    this.note = note;
    this.startedAt = startedAt;
    this.offAt = offAt;
    this.baseFrequency = frequency;
    this.lfoInc = LFO_HZ[patch.lfo & 3] / sampleRate;
    this.lfoPhase = 0;
    this.gain = velocityGain(velocity);
    const [left, right] = panGains(pan);
    this.left = left;
    this.right = right;
    this.isCarrier.fill(0);
    for (const op of CARRIERS[this.alg]) this.isCarrier[op] = 1;
    this.feedback.fill(0);
    for (let i = 0; i < count; i++) {
      const op = patch.ops[i];
      const keyScale = op.ksr ? kc : kc >> 2;
      const detune = DETUNE_UNITS[op.dt & 7] * 1.5 * Math.sqrt(440 / frequency);
      const ratio = MULTI[op.multi & 15] * Math.pow(2, detune / 1200);
      this.inc[i] = (frequency * ratio) / sampleRate;
      this.bendInc[i] = this.inc[i];
      this.phase[i] = 0;
      this.attenuation[i] = MAX_ATTENUATION;
      this.stage[i] = STAGE_ATTACK;
      const attackSeconds = rateSeconds(op.ar, keyScale, true);
      this.attackCoef[i] = attackSeconds === 0 || attackSeconds === Infinity ? 0 : Math.exp(-6.9 / (attackSeconds * sampleRate));
      this.decayRate[i] = MAX_ATTENUATION / (rateSeconds(op.dr, keyScale, false) * sampleRate);
      this.sustainRate[i] = MAX_ATTENUATION / (rateSeconds(op.sr, keyScale, false) * sampleRate);
      const releaseSeconds = op.rr === 0 ? 20 : rateSeconds(op.rr, keyScale, false);
      this.releaseRate[i] = MAX_ATTENUATION / (releaseSeconds * sampleRate);
      this.sustainLevel[i] = op.sl >= 15 ? 93 : op.sl * 3;
      this.baseAttenuation[i] = op.tl * 0.75 + KSL_DB_PER_OCTAVE[op.ksl & 3] * octavesAboveRef;
      const vibratoCents = (op.evb ? VIBRATO_CENTS[op.dvb & 3] : 0) + modulation * 50;
      this.vibrato[i] = (vibratoCents * Math.LN2) / 1200;
      this.tremolo[i] = op.eam ? TREMOLO_DB[op.dam & 3] : 0;
      this.ignoreKeyOff[i] = op.xof && op.sr > 0 ? 1 : 0;
      this.wave[i] = WAVES[op.ws & 31];
      this.history0[i] = 0;
      this.history1[i] = 0;
    }
    for (const op of FEEDBACK_OPS[this.alg]) this.feedback[op] = FEEDBACK_CYCLES[patch.ops[op].fb & 7];
    this.setBend(bend);
  }

  setBend(semitones) {
    const factor = Math.pow(2, semitones / 12);
    for (let i = 0; i < this.ops; i++) this.bendInc[i] = this.inc[i] * factor;
  }

  setModulation(modulation, patch) {
    for (let i = 0; i < this.ops; i++) {
      const op = patch.ops[i];
      const vibratoCents = (op.evb ? VIBRATO_CENTS[op.dvb & 3] : 0) + modulation * 50;
      this.vibrato[i] = (vibratoCents * Math.LN2) / 1200;
    }
  }

  keyOff() {
    for (let i = 0; i < this.ops; i++) {
      if (this.ignoreKeyOff[i] || this.stage[i] === STAGE_OFF) continue;
      this.stage[i] = STAGE_RELEASE;
    }
    this.offAt = Infinity;
  }

  /** Fades the voice out within a few milliseconds, for stops. */
  kill() {
    const rate = MAX_ATTENUATION / (0.005 * globalThis.sampleRate);
    for (let i = 0; i < this.ops; i++) {
      if (this.stage[i] === STAGE_OFF) continue;
      this.stage[i] = STAGE_RELEASE;
      this.releaseRate[i] = Math.max(this.releaseRate[i], rate);
      this.ignoreKeyOff[i] = 0;
    }
    this.offAt = Infinity;
  }

  envelope(i) {
    let level = this.attenuation[i];
    switch (this.stage[i]) {
      case STAGE_ATTACK:
        level *= this.attackCoef[i];
        if (level < 0.05) {
          level = 0;
          this.stage[i] = STAGE_DECAY;
        }
        break;
      case STAGE_DECAY:
        level += this.decayRate[i];
        if (level >= this.sustainLevel[i]) {
          level = this.sustainLevel[i];
          this.stage[i] = this.sustainRate[i] > 0 ? STAGE_SUSTAIN : STAGE_HOLD;
        }
        break;
      case STAGE_SUSTAIN:
        level += this.sustainRate[i];
        if (level >= MAX_ATTENUATION) {
          level = MAX_ATTENUATION;
          this.stage[i] = STAGE_OFF;
        }
        break;
      case STAGE_RELEASE:
        level += this.releaseRate[i];
        if (level >= MAX_ATTENUATION) {
          level = MAX_ATTENUATION;
          this.stage[i] = STAGE_OFF;
        }
        break;
      default:
        break;
    }
    this.attenuation[i] = level;
    return level;
  }

  /** Runs operator `i` for one sample with `modulation` cycles of phase input and returns its output. */
  operator(i, modulation, lfo) {
    let attenuation = this.envelope(i) + this.baseAttenuation[i];
    if (this.tremolo[i] > 0) attenuation += this.tremolo[i] * (0.5 + 0.5 * lfo);
    let phase = this.phase[i];
    let inc = this.bendInc[i];
    if (this.vibrato[i] !== 0) inc *= 1 + this.vibrato[i] * lfo;
    phase += inc;
    if (phase >= 1) phase -= Math.floor(phase);
    this.phase[i] = phase;
    let input = phase + modulation;
    if (this.feedback[i] > 0) input += (this.history0[i] + this.history1[i]) * 0.5 * this.feedback[i];
    const scaled = (input - Math.floor(input)) * TABLE_SIZE;
    const index = scaled | 0;
    const frac = scaled - index;
    const table = this.wave[i];
    const sample = (table[index] + (table[index + 1] - table[index]) * frac) * gainForDb(attenuation);
    this.history1[i] = this.history0[i];
    this.history0[i] = sample;
    return sample;
  }

  render(left, right, start, end, channelGainValue) {
    const gain = this.gain * channelGainValue;
    for (let n = start; n < end; n++) {
      this.lfoPhase += this.lfoInc;
      if (this.lfoPhase >= 1) this.lfoPhase -= 1;
      const lfo = Math.sin(TWO_PI * this.lfoPhase);
      let out;
      switch (this.alg) {
        case 0:
          out = this.operator(1, this.operator(0, 0, lfo) * MOD_CYCLES, lfo);
          break;
        case 1:
          out = this.operator(0, 0, lfo) + this.operator(1, 0, lfo);
          break;
        case 2:
          out = this.operator(0, 0, lfo) + this.operator(1, 0, lfo) + this.operator(2, 0, lfo) + this.operator(3, 0, lfo);
          break;
        case 3: {
          const a = this.operator(0, 0, lfo);
          const c = this.operator(2, this.operator(1, 0, lfo) * MOD_CYCLES, lfo);
          out = this.operator(3, (a + c) * MOD_CYCLES, lfo);
          break;
        }
        case 4: {
          const b = this.operator(1, this.operator(0, 0, lfo) * MOD_CYCLES, lfo);
          out = this.operator(3, this.operator(2, b * MOD_CYCLES, lfo) * MOD_CYCLES, lfo);
          break;
        }
        case 5:
          out = this.operator(1, this.operator(0, 0, lfo) * MOD_CYCLES, lfo) + this.operator(3, this.operator(2, 0, lfo) * MOD_CYCLES, lfo);
          break;
        case 6: {
          const c = this.operator(2, this.operator(1, 0, lfo) * MOD_CYCLES, lfo);
          out = this.operator(0, 0, lfo) + this.operator(3, c * MOD_CYCLES, lfo);
          break;
        }
        default:
          out = this.operator(0, 0, lfo) + this.operator(2, this.operator(1, 0, lfo) * MOD_CYCLES, lfo) + this.operator(3, 0, lfo);
          break;
      }
      const sample = out * gain;
      left[n] += sample * this.left;
      right[n] += sample * this.right;
    }
    let live = false;
    for (let i = 0; i < this.ops; i++) {
      if (this.isCarrier[i] && this.stage[i] !== STAGE_OFF) {
        live = true;
        break;
      }
    }
    if (!live) this.active = false;
  }

  /** How far gone the voice is, for stealing: released and quiet voices score highest. */
  stealScore() {
    let quietest = 0;
    for (let i = 0; i < this.ops; i++) {
      if (!this.isCarrier[i]) continue;
      const released = this.stage[i] === STAGE_RELEASE || this.stage[i] === STAGE_OFF ? 200 : 0;
      quietest = Math.max(quietest, released + this.attenuation[i]);
    }
    return quietest;
  }
}

function voiceKey(bankMsb, bankLsb, program, drumNote) {
  return ((bankMsb & 0x7f) << 21) | ((bankLsb & 0x7f) << 14) | ((program & 0x7f) << 7) | (drumNote & 0x7f);
}

/** Picks the General MIDI percussion key that stands in for one of the chip's built-in drum waves. */
function percussionKey(pcm) {
  switch (pcm.waveId) {
    case 1:
      return pcm.fs >= 22000 ? 40 : 38;
    case 2:
      if (pcm.fs <= 9000) return 41;
      if (pcm.fs <= 11000) return 43;
      if (pcm.fs <= 13000) return 45;
      if (pcm.fs <= 15500) return 47;
      if (pcm.fs <= 17000) return 48;
      return 75;
    case 3:
      return 42;
    case 4:
      return 46;
    case 5:
      return 51;
    case 6:
      return 49;
    default:
      return 42;
  }
}

class Channel {
  constructor() {
    this.bankMsb = 0;
    this.bankLsb = 0;
    this.program = 0;
    this.volume = 100;
    this.expression = 127;
    this.pan = 64;
    this.modulation = 0;
    this.bend = 0;
    this.velocity = 100;
  }
}

class Sequence {
  constructor(handle, score, repeat, sampleRate) {
    this.handle = handle;
    this.score = score;
    this.repeat = repeat;
    this.sampleRate = sampleRate;
    this.voices = new Map();
    this.pcmPrograms = new Set();
    for (const voice of score.voices) {
      this.voices.set(voiceKey(voice.bankMsb, voice.bankLsb, voice.program, voice.drumNote), voice);
      if (voice.voice.kind === "pcm") this.pcmPrograms.add(voiceKey(voice.bankMsb, voice.bankLsb, voice.program, 0));
    }
    this.channels = [];
    for (let i = 0; i < 16; i++) this.channels.push(new Channel());
    this.master = 1;
    this.position = 0;
    this.cursor = 0;
    this.lookaheadCursor = 0;
    this.lookaheadChannels = this.channels.map(() => new Channel());
    this.lookaheadMaster = 1;
    this.durationSamples = Math.max(1, Math.round((score.duration / 1000) * sampleRate));
    // The first cycle starts a little after the play request so drum hits reach the main thread in time.
    this.startDelay = Math.round(START_DELAY_SECONDS * sampleRate);
    this.position = -this.startDelay;
    this.cycleStartTime = -1;
    this.ended = false;
    this.stopping = false;
    this.active = [];
    this.pool = [];
    this.pendingMidi = [];
  }

  eventSample(index) {
    return Math.round((this.score.events[index].t / 1000) * this.sampleRate);
  }

  lookupVoice(channel, note) {
    const drum = this.voices.get(voiceKey(channel.bankMsb, channel.bankLsb, channel.program, note));
    if (drum) return drum;
    return this.voices.get(voiceKey(channel.bankMsb, channel.bankLsb, channel.program, 0));
  }

  allocate(startedAt) {
    if (this.active.length < MAX_VOICES) {
      const voice = this.pool.pop() ?? new FmVoice();
      this.active.push(voice);
      return voice;
    }
    let best = this.active[0];
    let bestScore = -1;
    for (const voice of this.active) {
      const score = voice.stealScore() + (startedAt - voice.startedAt) / this.sampleRate;
      if (score > bestScore) {
        bestScore = score;
        best = voice;
      }
    }
    return best;
  }

  applyEvent(event) {
    const channel = this.channels[event.ch ?? 0];
    switch (event.type) {
      case "on": {
        if (event.vel >= 0) channel.velocity = event.vel;
        const definition = this.lookupVoice(channel, event.note);
        if (!definition || definition.voice.kind !== "fm") return;
        const pan = definition.voice.pan ?? (channel.pan - 64) / 64;
        const voice = this.allocate(this.position);
        voice.patch = definition.voice;
        voice.keyOn(
          definition.voice,
          event.note,
          channel.velocity,
          event.ch,
          Math.max(-1, Math.min(1, pan)),
          channel.modulation / 127,
          channel.bend,
          this.position,
          this.position + Math.max(1, Math.round((event.gate / 1000) * this.sampleRate)),
        );
        break;
      }
      case "cc":
        this.applyControl(channel, event.cc, event.value);
        if (event.cc === 1) {
          for (const voice of this.active) {
            if (voice.channel === event.ch) voice.setModulation(channel.modulation / 127, voice.patch);
          }
        }
        break;
      case "pc":
        channel.program = event.program;
        break;
      case "pb":
        channel.bend = ((event.value - 8192) / 8192) * 2;
        for (const voice of this.active) {
          if (voice.channel === event.ch) voice.setBend(channel.bend);
        }
        break;
      case "volume":
        this.master = event.value / 127;
        break;
      default:
        break;
    }
  }

  applyControl(channel, cc, value) {
    switch (cc) {
      case 0:
        channel.bankMsb = value;
        break;
      case 32:
        channel.bankLsb = value;
        break;
      case 7:
        channel.volume = value;
        break;
      case 11:
        channel.expression = value;
        break;
      case 10:
        channel.pan = value;
        break;
      case 1:
        channel.modulation = value;
        break;
      default:
        break;
    }
  }

  /** Walks ahead of the playhead and emits the drum hits the main thread must play, with their times. */
  lookahead(port) {
    const horizon = this.position + LOOKAHEAD_SECONDS * this.sampleRate;
    const events = this.score.events;
    while (this.lookaheadCursor < events.length && this.eventSample(this.lookaheadCursor) <= horizon) {
      const event = events[this.lookaheadCursor++];
      const time = this.cycleStartTime + event.t / 1000;
      const channel = this.lookaheadChannels[event.ch ?? 0];
      switch (event.type) {
        case "on": {
          if (event.vel >= 0) channel.velocity = event.vel;
          const definition = this.lookupVoice(channel, event.note);
          if (!definition || definition.voice.kind !== "pcm") break;
          const key = percussionKey(definition.voice);
          const velocity = Math.max(1, Math.min(127, Math.round(channel.velocity * Math.sqrt(this.lookaheadMaster))));
          port.postMessage({ type: "midi", time, data: [0x99, key, velocity] });
          port.postMessage({ type: "midi", time: time + Math.max(0.01, event.gate / 1000), data: [0x89, key, 0] });
          break;
        }
        case "cc":
          this.applyControl(channel, event.cc, event.value);
          if ((event.cc === 7 || event.cc === 11 || event.cc === 10) && this.pcmPrograms.has(voiceKey(channel.bankMsb, channel.bankLsb, channel.program, 0))) {
            port.postMessage({ type: "midi", time, data: [0xb9, event.cc, event.value] });
          }
          break;
        case "pc":
          channel.program = event.program;
          break;
        case "volume":
          this.lookaheadMaster = event.value / 127;
          break;
        default:
          break;
      }
    }
  }

  startCycle(time) {
    this.position = 0;
    this.cursor = 0;
    this.lookaheadCursor = 0;
    this.cycleStartTime = time;
    this.lookaheadMaster = this.master;
    for (let i = 0; i < 16; i++) Object.assign(this.lookaheadChannels[i], this.channels[i]);
  }

  releaseAll() {
    for (const voice of this.active) voice.keyOff();
  }

  stop() {
    this.stopping = true;
    this.ended = true;
    for (const voice of this.active) voice.kill();
  }

  /** Renders `frames` samples into the block, advancing the sequence; returns false once it has fallen silent. */
  process(left, right, frames, blockTime, port) {
    if (this.cycleStartTime < 0) this.cycleStartTime = blockTime + this.startDelay / this.sampleRate;
    let offset = 0;
    while (offset < frames) {
      let segmentEnd = frames;
      if (!this.ended) {
        const nextEvent = this.cursor < this.score.events.length ? this.eventSample(this.cursor) : this.durationSamples;
        const boundary = Math.min(nextEvent, this.durationSamples);
        segmentEnd = Math.min(segmentEnd, offset + Math.max(0, boundary - this.position));
      }
      for (const voice of this.active) {
        if (voice.offAt !== Infinity && voice.offAt > this.position) {
          segmentEnd = Math.min(segmentEnd, offset + (voice.offAt - this.position));
        }
      }
      if (segmentEnd > offset) {
        for (const voice of this.active) {
          voice.render(left, right, offset, segmentEnd, channelGain(this.channels[voice.channel]) * this.master);
        }
        this.position += segmentEnd - offset;
        offset = segmentEnd;
      }
      for (const voice of this.active) {
        if (voice.offAt <= this.position) voice.keyOff();
      }
      if (this.ended) {
        if (offset >= frames) break;
        continue;
      }
      while (this.cursor < this.score.events.length && this.eventSample(this.cursor) <= this.position) {
        this.applyEvent(this.score.events[this.cursor++]);
      }
      if (this.position >= this.durationSamples) {
        this.releaseAll();
        if (this.repeat) {
          this.startCycle(blockTime + offset / this.sampleRate);
        } else {
          this.ended = true;
        }
      }
      if (offset >= frames) break;
    }
    if (!this.ended) this.lookahead(port);
    for (let i = this.active.length - 1; i >= 0; i--) {
      if (!this.active[i].active) this.pool.push(...this.active.splice(i, 1));
    }
    return !(this.ended && this.active.length === 0);
  }
}

class Ma3Processor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sequences = [];
    this.limiter = 1;
    this.port.onmessage = event => {
      const message = event.data;
      if (message.type === "play") {
        this.stopHandle(message.handle);
        this.sequences.push(new Sequence(message.handle, message.score, message.repeat, globalThis.sampleRate));
      } else if (message.type === "stop") {
        this.stopHandle(message.handle);
      } else if (message.type === "stopAll") {
        for (const sequence of this.sequences) sequence.stop();
      }
    };
  }

  stopHandle(handle) {
    for (const sequence of this.sequences) {
      if (sequence.handle === handle) sequence.stop();
    }
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const left = output[0];
    const right = output.length > 1 ? output[1] : output[0];
    const frames = left.length;
    const blockTime = globalThis.currentTime;
    for (let i = this.sequences.length - 1; i >= 0; i--) {
      const sequence = this.sequences[i];
      if (!sequence.process(left, right, frames, blockTime, this.port)) {
        this.sequences.splice(i, 1);
        this.port.postMessage({ type: "ended", handle: sequence.handle });
      }
    }
    // Scale to a comfortable level and catch the rare peaks with a fast limiter.
    const release = 1 - Math.exp(-1 / (0.4 * globalThis.sampleRate));
    for (let n = 0; n < frames; n++) {
      const l = left[n] * FM_GAIN;
      const r = right[n] * FM_GAIN;
      const peak = Math.max(Math.abs(l), Math.abs(r));
      if (peak * this.limiter > 0.95) this.limiter = 0.95 / peak;
      else this.limiter += (1 - this.limiter) * release;
      left[n] = l * this.limiter;
      right[n] = r * this.limiter;
    }
    return true;
  }
}

registerProcessor("ma3-processor", Ma3Processor);

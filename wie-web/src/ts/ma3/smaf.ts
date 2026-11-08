/**
 * SMAF (MMMD) reader for Mobile Standard scores: the MA-3 format the game's BGM is authored in.
 *
 * It only extracts what the FM synthesizer needs: the custom voice definitions carried as Yamaha
 * exclusives in the setup chunk and the timed sequence events. Byte layouts follow the public
 * SMAF specification and the YMF825 (SD-1) tone parameter map, which is the same FM core as MA-3.
 */

export interface Ma3Operator {
  ar: number;
  dr: number;
  sr: number;
  rr: number;
  sl: number;
  tl: number;
  ksl: number;
  ksr: boolean;
  xof: boolean;
  multi: number;
  dt: number;
  ws: number;
  fb: number;
  eam: boolean;
  dam: number;
  evb: boolean;
  dvb: number;
}

export interface Ma3FmVoice {
  kind: "fm";
  /** Connection algorithm 0-7; 0 and 1 are two-operator voices. */
  alg: number;
  /** LFO rate select 0-3. */
  lfo: number;
  /** Basic octave 0-3 (0 = one octave up, 1 = as written, 2/3 = one/two octaves down). */
  bo: number;
  /** Panpot -1 (left) .. 1 (right), or null when the voice leaves panning to the channel. */
  pan: number | null;
  /** Pitch (MIDI note) a drum voice sounds at; 0 for melodic voices. */
  drumKey: number;
  ops: Ma3Operator[];
}

export interface Ma3PcmVoice {
  kind: "pcm";
  /** Playback sampling frequency of the referenced wave. */
  fs: number;
  waveId: number;
  loop: boolean;
  loopStart: number;
  loopEnd: number;
  pan: number | null;
  tl: number;
  sr: number;
}

export interface Ma3Voice {
  bankMsb: number;
  bankLsb: number;
  program: number;
  /** Key the voice is assigned to in a drum bank; 0 for melodic voices. */
  drumNote: number;
  voice: Ma3FmVoice | Ma3PcmVoice;
}

export type Ma3Event =
  | { t: number; type: "on"; ch: number; note: number; vel: number; gate: number }
  | { t: number; type: "cc"; ch: number; cc: number; value: number }
  | { t: number; type: "pc"; ch: number; program: number }
  | { t: number; type: "pb"; ch: number; value: number }
  | { t: number; type: "volume"; value: number };

export interface Ma3Score {
  /** Length of the sequence in milliseconds. */
  duration: number;
  voices: Ma3Voice[];
  /** Events in file order; `t` and `gate` are milliseconds. */
  events: Ma3Event[];
}

const TIMEBASES: Record<number, number> = { 0: 1, 1: 2, 2: 4, 3: 5, 0x10: 10, 0x11: 20, 0x12: 40, 0x13: 50 };

class Reader {
  pos = 0;

  constructor(readonly data: Uint8Array, readonly end: number = data.length) {}

  get remaining(): number {
    return this.end - this.pos;
  }

  u8(): number {
    if (this.pos >= this.end) throw new RangeError("SMAF data truncated");
    return this.data[this.pos++];
  }

  u32(): number {
    const value = ((this.u8() << 24) | (this.u8() << 16) | (this.u8() << 8) | this.u8()) >>> 0;
    return value;
  }

  variable(): number {
    let value = 0;
    for (let i = 0; i < 4; i++) {
      const byte = this.u8();
      value = (value << 7) | (byte & 0x7f);
      if ((byte & 0x80) === 0) break;
    }
    return value;
  }

  bytes(length: number): Uint8Array {
    if (this.pos + length > this.end) throw new RangeError("SMAF data truncated");
    const slice = this.data.subarray(this.pos, this.pos + length);
    this.pos += length;
    return slice;
  }
}

/** Restores the 8-bit bytes a 7-bit clean exclusive carries as groups of one carrier byte and seven data bytes. */
function unpackSeven(packed: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < packed.length; ) {
    const carrier = packed[i++];
    for (let k = 0; k < 7 && i < packed.length; k++, i++) {
      out.push(packed[i] | ((carrier >> (6 - k)) & 1 ? 0x80 : 0));
    }
  }
  return Uint8Array.from(out);
}

function panpot(value: number, enabled: boolean): number | null {
  if (!enabled) return null;
  const pp = value & 31;
  if (pp === 15) return 0;
  return pp < 15 ? -(15 - pp) / 15 : (pp - 15) / 16;
}

function decodeOperator(b: Uint8Array, o: number): Ma3Operator {
  return {
    sr: b[o] >> 4,
    xof: (b[o] & 0x08) !== 0,
    ksr: (b[o] & 0x01) !== 0,
    rr: b[o + 1] >> 4,
    dr: b[o + 1] & 15,
    ar: b[o + 2] >> 4,
    sl: b[o + 2] & 15,
    tl: b[o + 3] >> 2,
    ksl: b[o + 3] & 3,
    dam: (b[o + 4] >> 5) & 3,
    eam: (b[o + 4] & 0x10) !== 0,
    dvb: (b[o + 4] >> 1) & 3,
    evb: (b[o + 4] & 0x01) !== 0,
    multi: b[o + 5] >> 4,
    dt: b[o + 5] & 7,
    ws: b[o + 6] >> 3,
    fb: b[o + 6] & 7,
  };
}

function decodeFmVoice(body: Uint8Array): Ma3FmVoice | null {
  const b = unpackSeven(body);
  if (b.length < 3 + 7 * 2) return null;
  const alg = b[2] & 7;
  const count = alg < 2 ? 2 : 4;
  if (b.length < 3 + 7 * count) return null;
  const ops: Ma3Operator[] = [];
  for (let i = 0; i < count; i++) ops.push(decodeOperator(b, 3 + 7 * i));
  return {
    kind: "fm",
    alg,
    lfo: (b[2] >> 6) & 3,
    bo: b[1] & 3,
    pan: panpot(b[1] >> 3, (b[2] & 0x20) !== 0),
    drumKey: b[0],
    ops,
  };
}

function decodePcmVoice(body: Uint8Array): Ma3PcmVoice | null {
  const b = unpackSeven(body);
  if (b.length < 16) return null;
  return {
    kind: "pcm",
    fs: (b[0] << 8) | b[1],
    pan: panpot(b[2] >> 3, (b[2] & 1) !== 0),
    sr: b[4] >> 4,
    tl: b[7] >> 2,
    loopStart: (b[11] << 8) | b[12],
    loopEnd: (b[13] << 8) | b[14],
    loop: (b[15] & 0x80) !== 0,
    waveId: b[15] & 0x7f,
  };
}

/** Decodes a `43 79 06 7F 01` MA-3 voice exclusive (payload after F0 and its length, F7 excluded). */
function decodeVoiceExclusive(payload: Uint8Array): Ma3Voice | null {
  if (payload.length < 11 || payload[0] !== 0x43 || payload[1] !== 0x79 || payload[2] !== 0x06 || payload[3] !== 0x7f || payload[4] !== 0x01) {
    return null;
  }
  const body = payload.subarray(10);
  const voice = (payload[9] & 1) === 0 ? decodeFmVoice(body) : decodePcmVoice(body);
  if (!voice) return null;
  return { bankMsb: payload[5], bankLsb: payload[6], program: payload[7], drumNote: payload[8], voice };
}

function exclusivePayload(data: Uint8Array): Uint8Array {
  return data.length > 0 && data[data.length - 1] === 0xf7 ? data.subarray(0, data.length - 1) : data;
}

function parseSetup(data: Uint8Array, voices: Ma3Voice[]): void {
  const reader = new Reader(data);
  while (reader.remaining > 0) {
    let status = reader.u8();
    if (status === 0xff) {
      if (reader.remaining === 0) break;
      status = reader.u8();
    }
    if (status !== 0xf0) break;
    const length = reader.variable();
    const voice = decodeVoiceExclusive(exclusivePayload(reader.bytes(Math.min(length, reader.remaining))));
    if (voice) voices.push(voice);
  }
}

function parseSequence(data: Uint8Array, timebaseD: number, timebaseG: number, events: Ma3Event[]): number {
  const reader = new Reader(data);
  let ticks = 0;
  while (reader.remaining > 0) {
    ticks += reader.variable();
    const t = ticks * timebaseD;
    const status = reader.u8();
    const ch = status & 0x0f;
    switch (status & 0xf0) {
      case 0x80: {
        const note = reader.u8();
        const gate = reader.variable() * timebaseG;
        events.push({ t, type: "on", ch, note, vel: -1, gate });
        break;
      }
      case 0x90: {
        const note = reader.u8();
        const vel = reader.u8();
        const gate = reader.variable() * timebaseG;
        events.push({ t, type: "on", ch, note, vel, gate });
        break;
      }
      case 0xa0:
        reader.bytes(2);
        break;
      case 0xb0: {
        const cc = reader.u8();
        const value = reader.u8();
        events.push({ t, type: "cc", ch, cc, value });
        break;
      }
      case 0xc0:
        events.push({ t, type: "pc", ch, program: reader.u8() });
        break;
      case 0xd0:
        reader.u8();
        break;
      case 0xe0: {
        const lsb = reader.u8();
        const msb = reader.u8();
        events.push({ t, type: "pb", ch, value: ((msb & 0x7f) << 7) | (lsb & 0x7f) });
        break;
      }
      case 0xf0: {
        if (status === 0xf0) {
          const length = reader.variable();
          const payload = exclusivePayload(reader.bytes(Math.min(length, reader.remaining)));
          if (payload.length >= 6 && payload[0] === 0x43 && payload[1] === 0x79 && payload[2] === 0x06 && payload[3] === 0x7f && payload[4] === 0x00) {
            events.push({ t, type: "volume", value: payload[5] & 0x7f });
          }
        } else if (status === 0xff) {
          const kind = reader.u8();
          if (kind === 0x2f) {
            reader.u8();
            return t;
          }
        } else {
          return t;
        }
        break;
      }
      default:
        return t;
    }
  }
  return ticks * timebaseD;
}

/**
 * Parses a SMAF file into an MA-3 score, or returns null when the file is not an uncompressed Mobile
 * Standard score with custom voices (the caller then plays it as General MIDI).
 */
export function parseMa3Score(data: Uint8Array): Ma3Score | null {
  try {
    if (data.length < 10 || data[0] !== 0x4d || data[1] !== 0x4d || data[2] !== 0x4d || data[3] !== 0x44) return null;
    const file = new Reader(data);
    file.pos = 4;
    const size = file.u32();
    const end = Math.min(data.length, 8 + size);
    const voices: Ma3Voice[] = [];
    const events: Ma3Event[] = [];
    let duration = 0;
    let tracks = 0;
    while (end - file.pos >= 8) {
      const id = String.fromCharCode(data[file.pos], data[file.pos + 1], data[file.pos + 2]);
      file.pos += 4;
      const length = file.u32();
      const chunk = new Reader(file.bytes(Math.min(length, end - file.pos)));
      if (id !== "MTR") continue;
      const format = chunk.u8();
      chunk.u8();
      const timebaseD = TIMEBASES[chunk.u8()] ?? 4;
      const timebaseG = TIMEBASES[chunk.u8()] ?? 4;
      if (format !== 2) return null;
      chunk.bytes(16);
      tracks++;
      while (chunk.remaining >= 8) {
        const sub = String.fromCharCode(chunk.u8(), chunk.u8(), chunk.u8(), chunk.u8());
        const subLength = chunk.u32();
        const body = chunk.bytes(Math.min(subLength, chunk.remaining));
        if (sub === "Mtsu") parseSetup(body, voices);
        else if (sub === "Mtsq") duration = Math.max(duration, parseSequence(body, timebaseD, timebaseG, events));
        else if (sub === "Mtsp") return null;
      }
    }
    if (tracks === 0 || voices.length === 0) return null;
    return { duration, voices, events };
  } catch {
    return null;
  }
}

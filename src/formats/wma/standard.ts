// Derived from FFmpeg 7.1.1; LGPL-2.1-or-later. See NOTICE and LICENSE.
import {BitReader} from '../vc1/bitstream.js';
import {InverseMdct, wmaSineWindow} from './imdct.js';
import {
  COEFFICIENTS,
  CRITICAL_FREQS,
  EXP_VLC,
  POW10,
  SHORT_BANDS,
  type CoefficientTable,
} from './standard-tables.js';
import type {LosslessAudio} from './lossless.js';
const f = Math.fround;

export interface StandardConfig {
  readonly sampleRate: number;
  readonly channels: number;
  readonly bytesPerSecond: number;
  readonly blockAlign: number;
  readonly extra: Uint8Array;
}

export interface StandardBackend {
  u8(length: number): Uint8Array;
  u16(length: number): Uint16Array;
  i16(length: number): Int16Array;
  i32(length: number): Int32Array;
  f32(length: number): Float32Array;
  f64(length: number): Float64Array;
  decodeFrame(state: Int32Array, reader: BitReader): void;
}
const jsMemory = {
  u8: (n: number): Uint8Array => new Uint8Array(n),
  i32: (n: number): Int32Array => new Int32Array(n),
  f32: (n: number): Float32Array => new Float32Array(n),
};

/** WMA v2 with VLC exponents, fixed or variable blocks, without noise coding. */
export class WmaStandardDecoder {
  private readonly gb = new BitReader();
  private readonly packet: Uint8Array;
  private readonly reservoir: Uint8Array;
  private readonly state: Int32Array;
  private lastLength = 0;
  private lastOffset = 0;
  private skipSamples = 4096;
  private resetLengths = true;
  private blockBits = 11;
  private previousBits = 11;
  private nextBits = 11;
  private readonly offsetBits: number;
  private readonly flags: number;
  private readonly tables: readonly CoefficientTable[];
  private readonly bands: Uint16Array[];
  private readonly transforms = Array.from(
    {length: 5},
    (_, i) => new InverseMdct(2048 >> i, 1 / 32768),
  );
  private readonly windows = Array.from({length: 5}, (_, i) => wmaSineWindow(2048 >> i));
  private readonly exponents: Float32Array[];
  private readonly exponentSize: Int32Array;
  private readonly maximumExponent: Float32Array;
  private readonly initialized: Uint8Array;
  private readonly coded: Uint8Array;
  private readonly coefficients: Float32Array[];
  private readonly levels: Float32Array[];
  private readonly transformOutput: Float32Array;
  private readonly frameOutput: Float32Array[];
  private drained = false;
  private closed = false;

  constructor(
    readonly config: StandardConfig,
    private readonly backend?: StandardBackend,
  ) {
    const extra = config.extra;
    this.flags =
      extra.length < 6
        ? 0
        : new DataView(extra.buffer, extra.byteOffset, extra.byteLength).getUint16(4, true);
    if (
      (this.flags !== 1 && this.flags !== 15) ||
      config.channels !== 2 ||
      (config.sampleRate !== 44100 && config.sampleRate !== 48000) ||
      !Number.isSafeInteger(config.blockAlign) ||
      config.blockAlign < 1 ||
      config.blockAlign > 32768 ||
      !Number.isSafeInteger(config.bytesPerSecond) ||
      config.bytesPerSecond < 8000
    )
      throw Error('Unsupported WMA Standard configuration');
    const bps = f(f(config.bytesPerSecond * 8) / f(config.channels * config.sampleRate));
    const adjusted = f(bps * 1.6);
    if (adjusted < 0.61) throw Error('Unsupported WMA Standard noise coding');
    this.offsetBits = 31 - Math.clz32(Math.trunc(f(bps * 2048) / 8 + 0.5)) + 2;
    if (this.offsetBits + 3 > 25) throw Error('Unsupported WMA Standard bitrate');
    this.tables = adjusted < 1.16 ? COEFFICIENTS.slice(0, 2) : COEFFICIENTS.slice(2, 4);
    const memory = backend ?? jsMemory;
    this.packet = memory.u8(config.blockAlign + 64);
    this.reservoir = memory.u8(32768 + 64);
    this.state = memory.i32(27);
    this.state[26] = Number(!!(this.flags & 4));
    this.exponents = [memory.f32(2048), memory.f32(2048)];
    this.exponentSize = memory.i32(2);
    this.maximumExponent = memory.f32(2);
    this.maximumExponent.fill(1);
    this.initialized = memory.u8(2);
    this.coded = memory.u8(2);
    this.coefficients = [memory.f32(2048), memory.f32(2048)];
    this.levels = [memory.f32(2048), memory.f32(2048)];
    this.transformOutput = memory.f32(4096);
    this.frameOutput = [memory.f32(4096), memory.f32(4096)];
    this.bands = Array.from({length: 5}, (_, size) => {
      const a = 4 - size;
      if (a < 3) return SHORT_BANDS[a]!;
      const length = 2048 >> size,
        bands: number[] = [];
      let previous = 0;
      for (const frequency of CRITICAL_FREQS) {
        const position = Math.min(
          length,
          Math.trunc((length * 2 * frequency + config.sampleRate * 2) / (4 * config.sampleRate)) *
            4,
        );
        if (position > previous) bands.push(position - previous);
        if (position >= length) break;
        previous = position;
      }
      return Uint16Array.from(bands);
    });
    if (backend) this.initializeBackend(backend);
  }

  private initializeBackend(memory: StandardBackend): void {
    const s = this.state;
    const copy = (
      source: ArrayLike<number>,
      target: Int16Array | Uint16Array | Int32Array | Float32Array,
    ) => {
      target.set(source);
      return target.byteOffset;
    };
    s[4] = copy(EXP_VLC.sym, memory.i16(EXP_VLC.sym.length));
    s[5] = copy(EXP_VLC.len, memory.i16(EXP_VLC.len.length));
    s[6] = copy(POW10, memory.f32(POW10.length));
    const gain = memory.f64(890);
    for (let i = 0; i < gain.length; i++) gain[i] = 2 ** (3.32192809488736234787 * (i * 0.05));
    s[7] = gain.byteOffset;
    const bands = memory.i32(5),
      counts = memory.i32(5);
    this.bands.forEach((band, i) => {
      bands[i] = copy(band, memory.u16(band.length));
      counts[i] = band.length;
    });
    s[8] = bands.byteOffset;
    s[9] = counts.byteOffset;
    s[10] = this.maximumExponent.byteOffset;
    s[11] = this.exponentSize.byteOffset;
    s[12] = this.initialized.byteOffset;
    s[13] = this.coded.byteOffset;
    for (let ch = 0; ch < 2; ch++) {
      s[14 + ch] = this.exponents[ch]!.byteOffset;
      s[16 + ch] = this.coefficients[ch]!.byteOffset;
      s[18 + ch] = this.levels[ch]!.byteOffset;
      s[21 + ch] = this.frameOutput[ch]!.byteOffset;
    }
    s[20] = this.transformOutput.byteOffset;
    const plans = memory.i32(5),
      windows = memory.i32(5);
    for (let i = 0; i < 5; i++) {
      plans[i] = this.transforms[i]!.copyPlan(memory).byteOffset;
      windows[i] = copy(this.windows[i]!, memory.f32(this.windows[i]!.length));
    }
    s[23] = plans.byteOffset;
    s[24] = windows.byteOffset;
    const tables = memory.i32(8);
    this.tables.forEach((t, i) => {
      tables[i * 4] = copy(t.vlc.sym, memory.i16(t.vlc.sym.length));
      tables[i * 4 + 1] = copy(t.vlc.len, memory.i16(t.vlc.len.length));
      tables[i * 4 + 2] = copy(t.run, memory.u16(t.run.length));
      tables[i * 4 + 3] = copy(t.level, memory.f32(t.level.length));
    });
    s[25] = tables.byteOffset;
  }

  decode(data: Uint8Array | null, time = 0): LosslessAudio[] {
    if (this.closed) throw Error('WMA Standard decoder is closed');
    const out: LosslessAudio[] = [];
    if (this.drained || data?.length === 0) return out;
    const emit = (pcm: Float32Array[], pts: number) => {
      const count = pcm[0]!.length,
        skip = Math.min(count, this.skipSamples);
      this.skipSamples -= skip;
      if (skip === count) return;
      if (skip) {
        pcm = pcm.map((p) => p.slice(skip));
        if (pts !== -1) pts += Math.round((skip * 1000) / this.config.sampleRate);
      }
      out.push({channels: pcm, time: pts});
    };
    if (!data) {
      this.drained = true;
      this.lastLength = 0;
      emit(
        this.frameOutput.map((p) => p.slice(0, 2048)),
        -1,
      );
      return out;
    }
    if (data.length > 16 * 1024 * 1024) throw Error('WMA Standard packet too large');
    try {
      for (let offset = 0; offset < data.length; offset += this.config.blockAlign) {
        if (data.length - offset < this.config.blockAlign)
          throw Error('Truncated WMA Standard packet');
        this.packet.fill(0);
        this.packet.set(data.subarray(offset, offset + this.config.blockAlign));
        const pcm = this.superframe();
        if (pcm) emit(pcm, offset ? -1 : time);
      }
      return out;
    } catch (error) {
      this.lastLength = 0;
      throw error;
    }
  }

  close(): void {
    this.closed = true;
  }

  private superframe(): Float32Array[] | null {
    const g = this.gb,
      bytes = this.config.blockAlign;
    g.reset(this.packet, bytes * 8);
    if (!(this.flags & 2)) {
      const pcm = [new Float32Array(2048), new Float32Array(2048)];
      this.frame(pcm, 0);
      return pcm;
    }
    g.skip(4);
    let frames = g.bits(4) - (this.lastLength <= 0 ? 1 : 0);
    if (frames <= 0) {
      if (frames < 0 || g.left() <= 8 || this.lastLength + bytes - 1 > 32768)
        throw Error('Invalid WMA Standard superframe');
      for (let i = 0; i < bytes - 1; i++) this.reservoir[this.lastLength + i] = g.bits(8);
      this.reservoir.fill(0, this.lastLength + bytes - 1, this.lastLength + bytes - 1 + 64);
      // Preserve the source decoder's zero-frame packet reservoir accounting.
      this.lastLength += 8 * bytes - 8;
      return null;
    }
    const pcm = [new Float32Array(frames * 2048), new Float32Array(frames * 2048)];
    const tailBits = g.bits(this.offsetBits + 3);
    if (tailBits > g.left()) throw Error('Invalid WMA Standard reservoir offset');
    let outputOffset = 0;
    if (this.lastLength > 0) {
      if (this.lastLength + Math.ceil(tailBits / 8) > 32768)
        throw Error('WMA Standard reservoir overflow');
      let left = tailBits,
        p = this.lastLength;
      while (left > 7) {
        this.reservoir[p++] = g.bits(8);
        left -= 8;
      }
      if (left) this.reservoir[p++] = g.bits(left) << (8 - left);
      this.reservoir.fill(0, p, p + 64);
      g.reset(this.reservoir, this.lastLength * 8 + tailBits);
      g.skip(this.lastOffset);
      this.frame(pcm, outputOffset);
      outputOffset += 2048;
      frames--;
    }
    const start = tailBits + 8 + this.offsetBits + 3;
    if (start >= 32768 * 8 || start > bytes * 8) throw Error('Invalid WMA Standard frame offset');
    // Reading the original packet from its absolute bit offset is equivalent to
    // the source decoder's byte slice plus relative bit offset.
    g.reset(this.packet, bytes * 8);
    g.skip(start);
    this.resetLengths = true;
    for (let i = 0; i < frames; i++, outputOffset += 2048) this.frame(pcm, outputOffset);
    const position = g.index;
    this.lastOffset = position & 7;
    this.lastLength = bytes - (position >> 3);
    if (this.lastLength < 0 || this.lastLength > 32768)
      throw Error('Invalid WMA Standard frame length');
    this.reservoir.set(this.packet.subarray(position >> 3, bytes));
    return pcm;
  }

  private frame(pcm: Float32Array[], offset: number): void {
    if (this.backend) {
      const s = this.state;
      s[0] = Number(this.resetLengths);
      s[1] = this.blockBits;
      s[2] = this.previousBits;
      s[3] = this.nextBits;
      this.backend.decodeFrame(s, this.gb);
      this.resetLengths = !!s[0];
      this.blockBits = s[1]!;
      this.previousBits = s[2]!;
      this.nextBits = s[3]!;
    } else {
      let position = 0;
      while (position < 2048) position += this.block(position);
    }
    for (let c = 0; c < 2; c++) {
      pcm[c]!.set(this.frameOutput[c]!.subarray(0, 2048), offset);
      this.frameOutput[c]!.copyWithin(0, 2048, 4096);
    }
  }

  private block(position: number): number {
    const g = this.gb;
    if (!(this.flags & 4)) {
      this.previousBits = this.blockBits = this.nextBits = 11;
    } else if (this.resetLengths) {
      this.resetLengths = false;
      this.previousBits = this.readBlockBits();
      this.blockBits = this.readBlockBits();
    } else {
      this.previousBits = this.blockBits;
      this.blockBits = this.nextBits;
    }
    if (this.flags & 4) this.nextBits = this.readBlockBits();
    const length = 1 << this.blockBits,
      size = 11 - this.blockBits;
    if (position + length > 2048) throw Error('WMA Standard frame length overflow');
    const stereo = g.bit();
    this.coded[0] = g.bit();
    this.coded[1] = g.bit();
    if (this.coded[0] || this.coded[1]) {
      let gain = 1,
        part;
      do {
        if (g.left() < 7) throw Error('Truncated WMA Standard gain');
        part = g.bits(7);
        gain += part;
      } while (part === 127);
      const coefBits = gain < 15 ? 13 : gain < 32 ? 12 : gain < 40 ? 11 : gain < 45 ? 10 : 9;
      const count = (2048 - Math.trunc((2048 * 9) / 100)) >> size;
      if (this.blockBits === 11 || g.bit())
        for (let c = 0; c < 2; c++)
          if (this.coded[c]) {
            this.exponentsFor(c, size, length);
            this.exponentSize[c] = size;
            this.initialized[c] = 1;
          }
      for (let c = 0; c < 2; c++)
        if (this.coded[c]) {
          if (!this.initialized[c]) throw Error('Uninitialized WMA Standard exponents');
          const table = this.tables[c === 1 && stereo ? 1 : 0]!;
          const levels = this.levels[c]!;
          levels.fill(0, 0, length);
          let i = 0;
          for (; i < count; i++) {
            const code = g.vlc(table.vlc, 9, 3);
            if (code > 1) {
              i += table.run[code]!;
              levels[i & (length - 1)] = g.bit() ? table.level[code]! : -table.level[code]!;
            } else if (code === 1) break;
            else {
              const level = g.bits(coefBits);
              i += g.bits(11);
              levels[i & (length - 1)] = g.bit() ? level : -level || 0;
            }
          }
          if (i > count || g.left() < 0) throw Error('Invalid WMA Standard spectral RLE');
        }
      for (let c = 0; c < 2; c++)
        if (this.coded[c]) {
          let mult = f(2 ** (3.32192809488736234787 * (gain * 0.05)) / this.maximumExponent[c]!);
          mult = f(mult * (2 / length));
          const coefs = this.coefficients[c]!,
            levels = this.levels[c]!,
            exponents = this.exponents[c]!;
          for (let i = 0; i < count; i++)
            coefs[i] = f(f(levels[i]! * exponents[(i << size) >> this.exponentSize[c]!]!) * mult);
          coefs.fill(0, count, length);
        }
      if (stereo && this.coded[1]) {
        const a = this.coefficients[0]!,
          b = this.coefficients[1]!;
        if (!this.coded[0]) {
          a.fill(0, 0, length);
          this.coded[0] = 1;
        }
        for (let i = 0; i < length; i++) {
          const value = a[i]!;
          a[i] = f(value + b[i]!);
          b[i] = f(value - b[i]!);
        }
      }
    }
    for (let c = 0; c < 2; c++) {
      if (this.coded[c]) this.transforms[size]!.full(this.coefficients[c]!, this.transformOutput);
      else if (!(stereo && c === 1)) this.transformOutput.fill(0);
      this.window(c, 1024 + position - length / 2, length);
    }
    return length;
  }

  private readBlockBits(): number {
    const value = this.gb.bits(3);
    if (value >= 5) throw Error('Invalid WMA Standard block size');
    return 11 - value;
  }

  private exponentsFor(channel: number, size: number, length: number): void {
    const g = this.gb,
      exponents = this.exponents[channel]!,
      bands = this.bands[size]!;
    let last = 36,
      offset = 0,
      maximum = 0;
    for (const band of bands) {
      last += g.vlc(EXP_VLC, 8, 3) - 60;
      if (last + 60 < 0 || last + 60 >= POW10.length)
        throw Error('WMA Standard exponent out of range');
      const value = POW10[last + 60]!;
      maximum = Math.max(maximum, value);
      exponents.fill(value, offset, offset + band);
      offset += band;
    }
    if (offset !== length) throw Error('Invalid WMA Standard exponent bands');
    this.maximumExponent[channel] = maximum;
  }

  private window(channel: number, offset: number, length: number): void {
    const out = this.frameOutput[channel]!,
      input = this.transformOutput;
    if (this.blockBits <= this.previousBits) {
      const window = this.windows[11 - this.blockBits]!;
      for (let i = 0; i < length; i++)
        out[offset + i] = f(f(input[i]! * window[i]!) + out[offset + i]!);
    } else {
      const count = 1 << this.previousBits,
        n = (length - count) / 2,
        window = this.windows[11 - this.previousBits]!;
      for (let i = 0; i < count; i++)
        out[offset + n + i] = f(f(input[n + i]! * window[i]!) + out[offset + n + i]!);
      out.set(input.subarray(n + count, n + count + n), offset + n + count);
    }
    offset += length;
    if (this.blockBits <= this.nextBits) {
      const window = this.windows[11 - this.blockBits]!;
      for (let i = 0; i < length; i++)
        out[offset + i] = f(input[length + i]! * window[length - i - 1]!);
    } else {
      const count = 1 << this.nextBits,
        n = (length - count) / 2,
        window = this.windows[11 - this.nextBits]!;
      out.set(input.subarray(length, length + n), offset);
      for (let i = 0; i < count; i++)
        out[offset + n + i] = f(input[length + n + i]! * window[count - i - 1]!);
      out.fill(0, offset + n + count, offset + n + count + n);
    }
  }
}

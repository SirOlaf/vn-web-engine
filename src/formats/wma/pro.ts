// Derived from FFmpeg 7.1.1; LGPL-2.1-or-later. See NOTICE and LICENSE.
import {BitReader} from '../vc1/bitstream.js';
import {InverseMdct, wmaSineWindow} from './imdct.js';
import {
  COEFFICIENTS,
  CRITICAL_FREQS,
  SCALE_LEVEL,
  SCALE_RUN,
  SCALE_RL_VLC,
  SCALE_VLC,
  VEC1,
  VEC2,
  VEC4,
} from './pro-tables.js';
import type {LosslessAudio} from './lossless.js';
const f = Math.fround;

export interface ProConfig {
  readonly sampleRate: number;
  readonly channels: number;
  readonly blockAlign: number;
  readonly extra: Uint8Array;
}

export interface ProBackend {
  u8(length: number): Uint8Array;
  u16(length: number): Uint16Array;
  i16(length: number): Int16Array;
  i32(length: number): Int32Array;
  f32(length: number): Float32Array;
  decodeProFrame(state: Int32Array, reader: BitReader): void;
}
type ProMemory = Pick<ProBackend, 'u8' | 'u16' | 'i32' | 'f32'>;
const jsMemory: ProMemory = {
  u8: (n) => new Uint8Array(n),
  u16: (n) => new Uint16Array(n),
  i32: (n) => new Int32Array(n),
  f32: (n) => new Float32Array(n),
};

class Channel {
  previousLength = 2048;
  count = 0;
  current = 0;
  decoded = 0;
  coefficientOffset = 0;
  transmit = 0;
  vectorCount = 0;
  quant = 0;
  reuse = false;
  scaleStep = 0;
  maximumScale = 0;
  scaleIndex = 0;
  tableIndex = 0;
  readonly lengths: Uint16Array;
  readonly output: Float32Array;
  readonly savedScales: Int32Array[];
  scales: Int32Array;
  constructor(memory: ProMemory) {
    this.lengths = memory.u16(32);
    this.output = memory.f32(3072);
    this.savedScales = [memory.i32(29), memory.i32(29)];
    this.scales = this.savedScales[0]!;
  }
}

/** Stereo 24-bit WMA Pro, 44.1 kHz, length-prefixed 2048-sample frames. */
export class WmaProDecoder {
  private readonly gb = new BitReader();
  private readonly pgb = new BitReader();
  private readonly packet: Uint8Array;
  private readonly reservoir: Uint8Array;
  private readonly state: Int32Array;
  private readonly channelState: Int32Array;
  private saved = 0;
  private frameOffset = 0;
  private packetLoss = true;
  private packetDone = false;
  private sequence = 0;
  private readonly sizeBits: number;
  private skipFrame = true;
  private trimStart = 0;
  private trimEnd = 0;
  private drained = false;
  private closed = false;
  private readonly channel: Channel[];
  private readonly bandOffsets: Int32Array[];
  private readonly scaleOffsets: Int32Array[][];
  private readonly transforms = Array.from({length: 5}, (_, i) => {
    const length = 2048 >> i;
    return new InverseMdct(length, 2 / (length * 2 ** 23));
  });
  private readonly windows = Array.from({length: 5}, (_, i) => wmaSineWindow(2048 >> i));
  private readonly active = new Int32Array(2);
  private activeCount = 0;
  private subframeLength = 0;
  private tableIndex = 0;
  private bands = 0;
  private transform = false;
  private readonly transformBand = new Uint8Array(29);
  private transmitVectors = 0;
  private readonly values = new Float32Array(4);
  private readonly scratch: Float32Array;

  constructor(
    readonly config: ProConfig,
    private readonly backend?: ProBackend,
  ) {
    const extra = config.extra;
    if (extra.length < 18) throw Error('Unsupported WMA Pro extradata');
    const view = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);
    if (
      config.channels !== 2 ||
      config.sampleRate !== 44100 ||
      view.getUint16(0, true) !== 24 ||
      view.getUint32(2, true) !== 3 ||
      view.getUint16(14, true) !== 0xe0 ||
      !Number.isSafeInteger(config.blockAlign) ||
      config.blockAlign <= 0 ||
      config.blockAlign > 32768
    )
      throw Error('Unsupported WMA Pro configuration');
    this.sizeBits = 31 - Math.clz32(config.blockAlign) + 4;
    this.packet = new Uint8Array(config.blockAlign + 64);
    const memory = backend ?? jsMemory;
    this.reservoir = memory.u8(32768 + 64);
    this.state = memory.i32(22);
    this.channelState = memory.i32(36);
    this.channel = [new Channel(memory), new Channel(memory)];
    this.scratch = memory.f32(2048);
    this.bandOffsets = Array.from({length: 5}, (_, i) => {
      const length = 2048 >> i,
        offsets = [0];
      for (const frequency of CRITICAL_FREQS) {
        if (offsets[offsets.length - 1]! >= length) break;
        const offset = (Math.trunc((length * 2 * frequency) / config.sampleRate) + 2) & ~3;
        if (offset > offsets[offsets.length - 1]!) offsets.push(offset);
        if (offset >= length) break;
      }
      offsets[offsets.length - 1] = length;
      if (offsets.length < 2) throw Error('Invalid WMA Pro frequency bands');
      return Int32Array.from(offsets);
    });
    this.scaleOffsets = this.bandOffsets.map((offsets, i) =>
      this.bandOffsets.map((old, x) => {
        const map = new Int32Array(offsets.length - 1);
        for (let b = 0; b < map.length; b++) {
          const center = ((offsets[b]! + offsets[b + 1]! - 1) << i) >> 1;
          let v = 0;
          while (old[v + 1]! << x < center) {
            if (++v >= old.length - 1) throw Error('Invalid WMA Pro scale-factor map');
          }
          map[b] = v;
        }
        return map;
      }),
    );
    if (backend) this.initializeBackend(backend);
  }

  private initializeBackend(memory: ProBackend): void {
    const s = this.state,
      channels = this.channelState;
    const copy = (
      source: ArrayLike<number>,
      target: Int16Array | Int32Array | Uint16Array | Float32Array,
    ) => {
      target.set(source);
      return target.byteOffset;
    };
    s[0] = channels.byteOffset;
    for (let ch = 0; ch < 2; ch++) {
      const c = this.channel[ch]!,
        i = ch * 18;
      channels[i] = 2048;
      channels[i + 13] = c.lengths.byteOffset;
      channels[i + 14] = c.output.byteOffset;
      channels[i + 15] = c.savedScales[0]!.byteOffset;
      channels[i + 16] = c.savedScales[1]!.byteOffset;
      channels[i + 17] = c.scales.byteOffset;
    }
    const bands = memory.i32(5),
      counts = memory.i32(5),
      maps = memory.i32(25);
    for (let i = 0; i < 5; i++) {
      const offsets = this.bandOffsets[i]!;
      bands[i] = copy(offsets, memory.i32(offsets.length));
      counts[i] = offsets.length - 1;
      for (let j = 0; j < 5; j++) {
        const map = this.scaleOffsets[i]![j]!;
        maps[i * 5 + j] = copy(map, memory.i32(map.length));
      }
    }
    s[2] = bands.byteOffset;
    s[3] = counts.byteOffset;
    s[4] = maps.byteOffset;
    const plans = memory.i32(5),
      windows = memory.i32(5);
    for (let i = 0; i < 5; i++) {
      plans[i] = this.transforms[i]!.copyPlan(memory).byteOffset;
      windows[i] = copy(this.windows[i]!, memory.f32(this.windows[i]!.length));
    }
    s[5] = plans.byteOffset;
    s[6] = windows.byteOffset;
    const quant = memory.f32(1674);
    for (let i = -903; i <= 770; i++) quant[i + 903] = 2 ** (3.32192809488736234787 * (i / 20));
    s[7] = quant.byteOffset;
    for (const [index, table] of [
      [8, SCALE_VLC],
      [10, SCALE_RL_VLC],
      [14, VEC4],
      [16, VEC2],
      [18, VEC1],
    ] as const) {
      s[index] = copy(table.sym, memory.i16(table.sym.length));
      s[index + 1] = copy(table.len, memory.i16(table.len.length));
    }
    s[12] = copy(SCALE_RUN, memory.u16(SCALE_RUN.length));
    s[13] = copy(SCALE_LEVEL, memory.i16(SCALE_LEVEL.length));
    const coefficients = memory.i32(8);
    COEFFICIENTS.forEach((table, i) => {
      coefficients[i * 4] = copy(table.vlc.sym, memory.i16(table.vlc.sym.length));
      coefficients[i * 4 + 1] = copy(table.vlc.len, memory.i16(table.vlc.len.length));
      coefficients[i * 4 + 2] = copy(table.run, memory.u16(table.run.length));
      coefficients[i * 4 + 3] = copy(table.level, memory.f32(table.level.length));
    });
    s[20] = coefficients.byteOffset;
    s[21] = this.scratch.byteOffset;
  }

  decode(data: Uint8Array | null, time = 0): LosslessAudio[] {
    if (this.closed) throw Error('WMA Pro decoder is closed');
    const out: LosslessAudio[] = [];
    if (this.drained || data?.length === 0) return out;
    // This profile's original codec has no delayed-output capability. A drain
    // does not invoke its otherwise present overlap-output callback.
    if (!data) {
      this.drained = true;
      return out;
    }
    if (data.length > 16 * 1024 * 1024) throw Error('WMA Pro packet too large');
    const emit = (pcm: Float32Array[] | null, pts: number) => {
      const start = this.trimStart,
        end = this.trimEnd;
      this.trimStart = this.trimEnd = 0;
      if (!pcm || start + end >= 2048) return;
      if (start || end) pcm = pcm.map((p) => p.slice(start, 2048 - end));
      out.push({channels: pcm, time: pts});
    };
    try {
      for (let offset = 0; offset < data.length; offset += this.config.blockAlign) {
        const bytes = this.config.blockAlign;
        if (data.length - offset < bytes) throw Error('Truncated WMA Pro packet');
        this.packet.fill(0);
        this.packet.set(data.subarray(offset, offset + bytes));
        const p = this.pgb;
        p.reset(this.packet, bytes * 8);
        this.packetDone = false;
        const sequence = p.bits(4);
        p.skip(2);
        let previous = p.bits(this.sizeBits);
        if (!this.packetLoss && ((this.sequence + 1) & 15) !== sequence) this.packetLoss = true;
        this.sequence = sequence;
        if (previous > 0) {
          if (previous >= p.left()) {
            previous = p.left();
            this.packetDone = true;
          }
          this.save(p, previous, true);
          if (!this.packetLoss) {
            const frame = this.frame();
            emit(frame.pcm, offset ? -1 : time);
          }
        }
        if (this.packetLoss) {
          this.saved = 0;
          this.packetLoss = false;
        }
        for (let i = 0; !this.packetDone; i++) {
          if (i >= 1024) throw Error('Too many WMA Pro frames in packet');
          const size = p.left() > this.sizeBits ? p.show(this.sizeBits) : 0;
          if (size && size <= p.left()) {
            this.save(p, size, false);
            const frame = this.frame();
            this.packetDone = !frame.more;
            emit(frame.pcm, -1);
          } else this.packetDone = true;
        }
        if (p.left() < 0) throw Error('Truncated WMA Pro packet');
        if (p.left() > 0) this.save(p, p.left(), false);
      }
      return out;
    } catch (error) {
      this.packetLoss = true;
      this.saved = 0;
      throw error;
    }
  }

  close(): void {
    this.closed = true;
  }

  private save(reader: BitReader, length: number, append: boolean): void {
    if (!append) {
      this.frameOffset = reader.index & 7;
      this.saved = this.frameOffset;
      this.reservoir.fill(0);
    }
    if (length <= 0 || this.saved + length > 32768 * 8) throw Error('WMA Pro reservoir overflow');
    let destination = this.saved;
    if (!append) {
      destination += length;
      const start = reader.index >> 3;
      this.reservoir.set(reader.buffer.subarray(start, start + Math.ceil(destination / 8)));
      reader.skip(length);
      length = 0;
    }
    while (length > 0) {
      if (!(destination & 7) && length >= 8) {
        const bytes = length >> 3,
          source = reader.index >> 3,
          target = destination >> 3,
          shift = reader.index & 7;
        if (!shift) this.reservoir.set(reader.buffer.subarray(source, source + bytes), target);
        else
          for (let i = 0; i < bytes; i++)
            this.reservoir[target + i] =
              (reader.buffer[source + i]! << shift) |
              (reader.buffer[source + i + 1]! >> (8 - shift));
        reader.skip(bytes * 8);
        destination += bytes * 8;
        length -= bytes * 8;
        continue;
      }
      const n = Math.min(length, 8 - (destination & 7)),
        bits = reader.bits(n);
      const byte = destination >> 3,
        shift = 8 - (destination & 7) - n;
      this.reservoir[byte] = (this.reservoir[byte]! & ~(((1 << n) - 1) << shift)) | (bits << shift);
      destination += n;
      length -= n;
    }
    this.saved = destination;
    if (destination & 7) this.reservoir[destination >> 3]! &= 255 << (8 - (destination & 7));
    this.gb.reset(this.reservoir, this.saved);
    this.gb.skip(this.frameOffset);
  }

  private frame(): {more: boolean; pcm: Float32Array[] | null} {
    const g = this.gb,
      start = this.frameOffset,
      length = g.bits(this.sizeBits);
    this.tiles();
    if (g.bit() && g.bit()) g.skip(16); // Ignored postprocessing transform metadata.
    g.skip(8); // DRC metadata.
    if (g.bit()) {
      if (g.bit()) this.trimStart = g.bits(12);
      if (g.bit()) this.trimEnd = g.bits(12);
    } else this.trimStart = this.trimEnd = 0;
    for (const c of this.channel) {
      c.decoded = 0;
      c.current = 0;
      c.reuse = false;
    }
    if (this.backend) {
      for (let i = 0; i < 2; i++) this.channelState[i * 18 + 1] = this.channel[i]!.count;
      this.backend.decodeProFrame(this.state, this.gb);
    } else {
      for (let i = 0; this.channel.some((c) => c.decoded < 2048); i++) {
        if (i >= 64) throw Error('Invalid WMA Pro subframe count');
        this.subframe();
      }
    }
    const pcm = this.skipFrame ? null : this.channel.map((c) => c.output.slice(0, 2048));
    this.skipFrame = false;
    for (const c of this.channel) c.output.copyWithin(0, 2048, 3072);
    if (length !== g.index - start + 2) throw Error('Invalid WMA Pro frame length');
    g.skip(1);
    return {more: !!g.bit(), pcm};
  }

  private tiles(): void {
    const g = this.gb,
      fixed = g.bit(),
      samples = [0, 0],
      contains = [false, false];
    let minimum = 0,
      channels = 2;
    for (const c of this.channel) c.count = 0;
    do {
      let used = false;
      for (let c = 0; c < 2; c++) {
        contains[c] =
          samples[c] === minimum && (!!fixed || channels === 1 || minimum === 1920 || !!g.bit());
        used ||= contains[c]!;
      }
      if (!used) throw Error('Empty WMA Pro tile');
      const shift = minimum === 1920 ? 4 : g.bit() ? 1 + g.bits(2) : 0;
      const length = 2048 >> shift;
      minimum += length;
      for (let i = 0; i < 2; i++) {
        const c = this.channel[i]!;
        if (contains[i]) {
          if (c.count >= 32 || samples[i]! + length > 2048) throw Error('Invalid WMA Pro tiling');
          c.lengths[c.count++] = length;
          samples[i]! += length;
        } else if (samples[i]! <= minimum) {
          if (samples[i]! < minimum) {
            channels = 0;
            minimum = samples[i]!;
          }
          channels++;
        }
      }
    } while (minimum < 2048);
  }

  private subframe(): void {
    const g = this.gb;
    let offset = 2048,
      length = 2048;
    for (const c of this.channel)
      if (c.decoded < offset) {
        offset = c.decoded;
        length = c.lengths[c.current]!;
      }
    this.activeCount = 0;
    for (let i = 0; i < 2; i++) {
      const c = this.channel[i]!;
      if (c.decoded === offset && c.lengths[c.current] === length) {
        c.decoded += length;
        c.coefficientOffset = offset + 1024;
        this.active[this.activeCount++] = i;
      }
    }
    if (!this.activeCount || !length || offset + length > 2048)
      throw Error('Invalid WMA Pro subframe');
    this.subframeLength = length;
    this.tableIndex = 11 - (31 - Math.clz32(length));
    this.bands = this.bandOffsets[this.tableIndex]!.length - 1;
    if (g.bit()) {
      let fill = g.bits(2);
      if (!fill) fill = g.bitsLong(g.bits(4)) + 1;
      if (g.index + fill > this.saved) throw Error('Invalid WMA Pro fill bits');
      g.skip(fill);
    }
    if (g.bit()) throw Error('Unsupported WMA Pro reserved bit');
    this.channelTransform();
    let any = false;
    for (let i = 0; i < this.activeCount; i++) {
      const c = this.channel[this.active[i]!]!;
      c.transmit = g.bit();
      any ||= !!c.transmit;
    }
    if (any) {
      this.transmitVectors = g.bit();
      const vectorBits = 31 - Math.clz32((length + 3) >> 2) + 1;
      for (let i = 0; i < this.activeCount; i++) {
        const c = this.channel[this.active[i]!]!;
        c.vectorCount = this.transmitVectors ? g.bits(vectorBits) << 2 : length;
        if (c.vectorCount > length) throw Error('Invalid WMA Pro vector count');
      }
      let step = (g.bits(6) << 26) >> 26;
      let quant = 135 + step;
      if (step === -32 || step === 31) {
        const sign = step === 31 ? 0 : -1;
        let extra = 0;
        while (g.index + 5 < this.saved && (step = g.bits(5)) === 31) extra += 31;
        quant += ((extra + step) ^ sign) - sign;
      }
      if (this.activeCount === 1) this.channel[this.active[0]!]!.quant = quant;
      else {
        const bits = g.bits(3);
        for (let i = 0; i < this.activeCount; i++) {
          const c = this.channel[this.active[i]!]!;
          c.quant = quant;
          if (g.bit()) c.quant += bits ? g.bits(bits) + 1 : 1;
        }
      }
      this.scaleFactors();
    }
    for (let i = 0; i < this.activeCount; i++) {
      const c = this.channel[this.active[i]!]!;
      if (c.transmit && g.index < this.saved) this.coefficientsFor(c);
      else c.output.fill(0, c.coefficientOffset, c.coefficientOffset + length);
    }
    if (any) {
      this.inverseChannelTransform();
      const offsets = this.bandOffsets[this.tableIndex]!;
      for (let i = 0; i < this.activeCount; i++) {
        const c = this.channel[this.active[i]!]!;
        for (let b = 0; b < this.bands; b++) {
          const end = Math.min(offsets[b + 1]!, length);
          const exponent = c.quant - (c.maximumScale - c.scales[b]!) * c.scaleStep;
          const quant = f(2 ** (3.32192809488736234787 * (exponent / 20)));
          for (let j = offsets[b]!; j < end; j++)
            this.scratch[j] = f(c.output[c.coefficientOffset + j]! * quant);
        }
        this.transforms[this.tableIndex]!.half(this.scratch, c.output, c.coefficientOffset);
      }
    }
    this.window();
    for (let i = 0; i < this.activeCount; i++) this.channel[this.active[i]!]!.current++;
  }

  private channelTransform(): void {
    const g = this.gb;
    if (g.bit()) throw Error('Unsupported WMA Pro channel transform bit');
    this.transform = false;
    if (this.activeCount === 2) {
      if (g.bit()) {
        if (g.bit()) throw Error('Unsupported WMA Pro channel transform type');
      } else this.transform = true;
    }
    if (this.transform) {
      if (g.bit()) this.transformBand.fill(1, 0, this.bands);
      else for (let i = 0; i < this.bands; i++) this.transformBand[i] = g.bit();
    }
  }

  private scaleFactors(): void {
    const g = this.gb;
    for (let i = 0; i < this.activeCount; i++) {
      const c = this.channel[this.active[i]!]!;
      const scales = c.savedScales[1 - c.scaleIndex]!;
      c.scales = scales;
      if (c.reuse) {
        const map = this.scaleOffsets[this.tableIndex]![c.tableIndex]!;
        const old = c.savedScales[c.scaleIndex]!;
        for (let b = 0; b < this.bands; b++) scales[b] = old[map[b]!]!;
      }
      if (!c.current || g.bit()) {
        if (!c.reuse) {
          c.scaleStep = g.bits(2) + 1;
          let value = Math.trunc(45 / c.scaleStep);
          for (let b = 0; b < this.bands; b++) {
            value += g.vlc(SCALE_VLC, 8, 3);
            scales[b] = value;
          }
        } else {
          for (let b = 0; b < this.bands; b++) {
            const index = g.vlc(SCALE_RL_VLC, 9, 3);
            let skip, value, sign;
            if (!index) {
              const code = g.bits(14);
              value = code >> 6;
              sign = (code & 1) - 1;
              skip = (code & 63) >> 1;
            } else if (index === 1) break;
            else {
              if (index < 0) throw Error('Invalid WMA Pro scale code');
              skip = SCALE_RUN[index]!;
              value = SCALE_LEVEL[index]!;
              sign = g.bit() - 1;
            }
            b += skip;
            if (b >= this.bands) throw Error('Invalid WMA Pro scale factor coding');
            scales[b] = scales[b]! + ((value ^ sign) - sign);
          }
        }
        c.scaleIndex = 1 - c.scaleIndex;
        c.tableIndex = this.tableIndex;
        c.reuse = true;
      }
      let maximum = scales[0]!;
      for (let b = 1; b < this.bands; b++) maximum = Math.max(maximum, scales[b]!);
      c.maximumScale = maximum;
    }
  }

  private coefficientsFor(c: Channel): void {
    const g = this.gb,
      length = this.subframeLength,
      table = COEFFICIENTS[g.bit()]!;
    const out = c.output,
      base = c.coefficientOffset,
      values = this.values;
    let rl = false,
      coefficient = 0,
      zeros = 0;
    while ((this.transmitVectors || !rl) && coefficient + 3 < c.vectorCount) {
      let index = g.vlc(VEC4, 9, 2);
      if (index < 0) {
        for (let i = 0; i < 4; i += 2) {
          index = g.vlc(VEC2, 9, 2);
          if (index < 0) {
            for (let j = 0; j < 2; j++) {
              let value = g.vlc(VEC1, 9, 2);
              if (value < 0) throw Error('Invalid WMA Pro vector code');
              if (value === 100) value = (value + this.largeValue()) >>> 0;
              values[i + j] = value;
            }
          } else {
            values[i] = index >> 4;
            values[i + 1] = index & 15;
          }
        }
      } else {
        values[0] = index >> 12;
        values[1] = (index >> 8) & 15;
        values[2] = (index >> 4) & 15;
        values[3] = index & 15;
      }
      for (let i = 0; i < 4; i++) {
        const value = values[i]!;
        if (value) {
          out[base + coefficient] = g.bit() ? value : -value;
          zeros = 0;
        } else {
          out[base + coefficient] = 0;
          if (++zeros > length >> 8) rl = true;
        }
        coefficient++;
      }
    }
    if (coefficient < length) {
      out.fill(0, base + coefficient, base + length);
      const escapeBits = 31 - Math.clz32(length);
      for (; coefficient < length; coefficient++) {
        const code = g.vlc(table.vlc, 9, 3);
        let value;
        if (code > 1) {
          coefficient += table.run[code]!;
          value = table.level[code]!;
        } else if (code === 1) break;
        else {
          value = this.largeValue();
          if (g.bit()) {
            if (g.bit()) {
              if (g.bit()) throw Error('Invalid WMA Pro coefficient escape');
              coefficient += g.bits(escapeBits) + 4;
            } else coefficient += g.bits(2) + 1;
          }
        }
        out[base + (coefficient & (length - 1))] = g.bit() ? value : -value || 0;
      }
      if (coefficient > length) throw Error('WMA Pro spectral RLE overflow');
    }
  }

  private largeValue(): number {
    const g = this.gb;
    let n = 8;
    if (g.bit()) {
      n += 8;
      if (g.bit()) {
        n += 8;
        if (g.bit()) n += 7;
      }
    }
    return g.bitsLong(n);
  }

  private inverseChannelTransform(): void {
    if (!this.transform) return;
    const a = this.channel[this.active[0]!]!,
      b = this.channel[this.active[1]!]!;
    const offsets = this.bandOffsets[this.tableIndex]!;
    for (let band = 0; band < this.bands; band++) {
      for (let i = offsets[band]!; i < Math.min(offsets[band + 1]!, this.subframeLength); i++) {
        const x = a.output[a.coefficientOffset + i]!,
          y = b.output[b.coefficientOffset + i]!;
        if (this.transformBand[band]) {
          a.output[a.coefficientOffset + i] = f(f(0 + f(x * 1)) + f(y * -1));
          b.output[b.coefficientOffset + i] = f(f(0 + f(x * 1)) + f(y * 1));
        } else {
          a.output[a.coefficientOffset + i] = f(x * (181 / 128));
          b.output[b.coefficientOffset + i] = f(y * (181 / 128));
        }
      }
    }
  }

  private window(): void {
    for (let channel = 0; channel < this.activeCount; channel++) {
      const c = this.channel[this.active[channel]!]!,
        out = c.output;
      const length = Math.min(c.previousLength, this.subframeLength),
        half = length / 2;
      const start = c.coefficientOffset - half,
        window = this.windows[11 - (31 - Math.clz32(length))]!;
      for (let i = 0, j = half - 1; i < half; i++, j--) {
        const x = out[start + i]!,
          y = out[start + half + j]!,
          wi = window[i]!,
          wj = window[half + j]!;
        out[start + i] = f(f(x * wj) - f(y * wi));
        out[start + half + j] = f(f(x * wi) + f(y * wj));
      }
      c.previousLength = this.subframeLength;
    }
  }
}

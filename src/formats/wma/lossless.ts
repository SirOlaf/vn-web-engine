// Derived from FFmpeg 7.1.1; LGPL-2.1-or-later. See NOTICE and LICENSE.
import {BitReader} from '../vc1/bitstream.js';

export interface LosslessConfig {
  readonly sampleRate: number;
  readonly channels: number;
  readonly blockAlign: number;
  readonly extra: Uint8Array;
}

export interface LosslessAudio {
  readonly channels: Float32Array[];
  readonly time: number;
}

export interface LosslessBackend {
  u8(length: number): Uint8Array;
  i16(length: number): Int16Array;
  i32(length: number): Int32Array;
  decodeChannel(state: Int32Array, reader: BitReader): void;
  finish(state: Int32Array): void;
}
type LosslessMemory = Pick<LosslessBackend, 'u8' | 'i16' | 'i32'>;
const jsMemory: LosslessMemory = {
  u8: (n: number) => new Uint8Array(n),
  i16: (n: number) => new Int16Array(n),
  i32: (n: number) => new Int32Array(n),
};

class Lms {
  order = 0;
  scaling = 0;
  recent = 0;
  readonly coefs: Int16Array;
  readonly previous: Int16Array | Int32Array;
  readonly updates: Int16Array;
  constructor(bits: number, memory: LosslessMemory) {
    this.coefs = memory.i16(264);
    this.updates = memory.i16(520);
    this.previous = bits === 16 ? memory.i16(1040) : memory.i32(520);
  }
}

class Channel {
  count = 0;
  current = 0;
  decoded = 0;
  transientCounter = 0;
  speed = 0;
  average = 0;
  coded = 1;
  lmsCount = 0;
  readonly lengths = new Uint16Array(32);
  readonly residues: Int32Array;
  readonly acPrevious: Int32Array;
  readonly lms: Lms[];
  constructor(bits: number, memory: LosslessMemory) {
    this.residues = memory.i32(16384);
    this.acPrevious = memory.i32(16);
    this.lms = Array.from({length: 8}, () => new Lms(bits, memory));
  }
}

/** Stereo, 16/24-bit WMA Lossless with the surveyed 0x1a1 compression flags.
 * All prediction sums wrap at 32 bits, including the 24-bit sample path. */
export class WmaLosslessDecoder {
  readonly bits: number;
  readonly samples = 2048;
  private readonly channels: Channel[];
  private readonly gb = new BitReader();
  private readonly pgb = new BitReader();
  private readonly reservoir: Uint8Array;
  private readonly channelState: Int32Array;
  private readonly packet: Uint8Array;
  private saved = 0;
  private frameOffset = 0;
  private packetLoss = true;
  private packetDone = false;
  private sequence = 0;
  private readonly sizeBits: number;
  private closed = false;
  private drained = false;
  private drainTime = -1;
  private acFilter = 0;
  private interChannel = 0;
  private multiLms = 0;
  private acOrder = 0;
  private acScaling = 0;
  private readonly acCoefs: Int16Array;
  private multiOrder = 0;
  private multiScaling = 0;
  private multiRecent = 0;
  private readonly multiCoefs: Int16Array;
  private readonly multiCurrent: Int16Array;
  private readonly multiPrevious: Int32Array;
  private readonly multiUpdates: Int32Array;
  private readonly predictions = new Int32Array(2);
  private movingScaling = 0;
  private quantStep = 1;
  private readonly output: Float32Array[];
  private outputSamples = 0;

  constructor(
    readonly config: LosslessConfig,
    private readonly backend?: LosslessBackend,
  ) {
    const e = config.extra,
      view = new DataView(e.buffer, e.byteOffset, e.byteLength);
    if (e.length < 18) throw Error('Unsupported WMA Lossless extradata');
    this.bits = view.getUint16(0, true);
    if (
      config.channels !== 2 ||
      (config.sampleRate !== 44100 && config.sampleRate !== 48000) ||
      (this.bits !== 16 && this.bits !== 24) ||
      view.getUint32(2, true) !== 3 ||
      view.getUint16(14, true) !== 0x1a1 ||
      !Number.isInteger(config.blockAlign) ||
      config.blockAlign <= 0 ||
      config.blockAlign > 65536
    )
      throw Error('Unsupported WMA Lossless configuration');
    this.sizeBits = 31 - Math.clz32(config.blockAlign) + 4;
    this.packet = new Uint8Array(config.blockAlign + 64);
    const memory = backend ?? jsMemory;
    this.reservoir = memory.u8(65536 + 64);
    this.channelState = memory.i32(58);
    this.channels = [new Channel(this.bits, memory), new Channel(this.bits, memory)];
    this.acCoefs = memory.i16(16);
    this.multiCoefs = memory.i16(128);
    this.multiCurrent = memory.i16(4);
    this.multiPrevious = memory.i32(128);
    this.multiUpdates = memory.i32(128);
    this.output = Array.from({length: 2}, () => {
      const storage = memory.i32(2048);
      return new Float32Array(storage.buffer, storage.byteOffset, storage.length);
    });
  }

  decode(data: Uint8Array | null, time = 0): LosslessAudio[] {
    if (this.closed) throw Error('WMA Lossless decoder is closed');
    const out: LosslessAudio[] = [];
    if (this.drained || data?.length === 0) return out;
    const emit = (pts: number) => {
      const count = this.outputSamples;
      if (!count) return;
      out.push({
        time: pts,
        channels: this.output.map((plane) => plane.slice(0, count)),
      });
      this.outputSamples = 0;
    };
    try {
      if (!data) {
        this.drained = true;
        for (let i = 0; this.saved > this.gb.index && i < 1024; i++) {
          const more = this.frame();
          emit(this.drainTime);
          if (!more) {
            this.saved = 0;
            break;
          }
        }
        return out;
      }
      if (data.length > 16 * 1024 * 1024) throw Error('WMA Lossless packet too large');
      let offset = 0,
        pts = time;
      // A media object may contain several codec packets. The non-byte-aligned
      // offset is retained between calls to the codec's frame callback.
      while (offset < data.length) {
        const size = Math.min(this.config.blockAlign, data.length - offset);
        this.packet.fill(0);
        this.packet.set(data.subarray(offset, offset + size));
        this.pgb.reset(this.packet, size * 8);
        this.packetDone = false;
        const sequence = this.pgb.bits(4);
        this.pgb.skip(1);
        if (this.pgb.bit()) throw Error('Unsupported WMA Lossless bitstream splicing');
        let previous = this.pgb.bits(this.sizeBits);
        if (!this.packetLoss && ((this.sequence + 1) & 15) !== sequence)
          throw Error('WMA Lossless packet sequence discontinuity');
        this.sequence = sequence;
        if (previous > 0) {
          const left = this.pgb.left();
          if (previous >= left) {
            previous = left;
            this.packetDone = true;
          }
          this.save(this.pgb, previous, true);
          if (previous < left && !this.packetLoss) {
            this.frame();
            emit(pts);
            pts = -1;
          }
        }
        if (this.packetLoss) {
          this.saved = 0;
          this.packetLoss = false;
        }
        this.drainTime = this.pgb.index >> 3 >= data.length - offset ? pts : -1;
        // Consuming the codec packet header clears AVPacket.pts even when the
        // callback completes no frame. Only a cross-packet frame above retains it.
        pts = -1;
        // With no length prefixes, the previous packet reservoir is decoded
        // until its trailer says the final complete frame has been reached.
        for (let frames = 0; !this.packetDone; frames++) {
          if (frames >= 1024) throw Error('Too many WMA Lossless frames in packet');
          if (this.saved > this.gb.index) {
            this.packetDone = !this.frame();
            emit(pts);
            pts = -1;
          } else this.packetDone = true;
        }
        if (this.pgb.left() < 0) throw Error('Truncated WMA Lossless packet');
        if (this.pgb.left() > 0) this.save(this.pgb, this.pgb.left(), false);
        offset += size;
      }
      return out;
    } catch (error) {
      this.packetLoss = true;
      this.saved = 0;
      this.outputSamples = 0;
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
    if (length <= 0 || this.saved + length + 8 > 65536 * 8)
      throw Error('WMA Lossless bit reservoir overflow');
    let destination = this.saved;
    if (!append) {
      destination += length;
      const bytes = Math.ceil(destination / 8),
        start = reader.index >> 3;
      this.reservoir.set(reader.buffer.subarray(start, start + bytes));
      reader.skip(length);
      length = 0;
    }
    while (length > 0) {
      if (!(destination & 7) && length >= 8) {
        const bytes = length >> 3,
          source = reader.index >> 3,
          target = destination >> 3;
        const shift = reader.index & 7;
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
      const n = Math.min(length, 8 - (destination & 7));
      const bits = reader.bits(n),
        byte = destination >> 3,
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

  private frame(): boolean {
    const g = this.gb;
    this.outputSamples = this.samples;
    this.tiles();
    g.skip(8); // DRC metadata does not alter decoded PCM.
    if (g.bit()) {
      if (g.bit()) g.skip(12);
      if (g.bit()) {
        this.outputSamples -= g.bits(12);
        if (this.outputSamples <= 0) throw Error('Invalid WMA Lossless end trim');
      }
    }
    for (const c of this.channels) {
      c.decoded = 0;
      c.current = 0;
    }
    for (let i = 0; this.channels.some((c) => c.decoded < this.samples); i++) {
      if (i >= 64) throw Error('Invalid WMA Lossless subframe count');
      this.subframe();
    }
    if (g.left() < 1) throw Error('Truncated WMA Lossless frame');
    return !!g.bit();
  }

  private tiles(): void {
    const g = this.gb,
      lengths = [0, 0],
      contains = [false, false];
    const fixed = g.bit();
    let minimum = 0,
      count = 2;
    for (const c of this.channels) c.count = 0;
    do {
      let used = false;
      for (let c = 0; c < 2; c++) {
        contains[c] =
          lengths[c] === minimum && (!!fixed || count === 1 || minimum === 1920 || !!g.bit());
        used ||= contains[c]!;
      }
      if (!used) throw Error('Empty WMA Lossless subframe');
      const length = minimum === 1920 ? 128 : 128 * (g.bits(4) + 1);
      minimum += length;
      for (let c = 0; c < 2; c++) {
        const ch = this.channels[c]!;
        if (contains[c]) {
          if (ch.count >= 32 || lengths[c]! + length > this.samples)
            throw Error('Invalid WMA Lossless tiling');
          ch.lengths[ch.count++] = length;
          lengths[c]! += length;
        } else if (lengths[c]! <= minimum) {
          if (lengths[c]! < minimum) {
            count = 0;
            minimum = lengths[c]!;
          }
          count++;
        }
      }
    } while (minimum < this.samples);
  }

  private clear(): void {
    this.acCoefs.fill(0);
    this.multiCoefs.fill(0);
    this.multiCurrent.fill(0);
    this.multiPrevious.fill(0);
    this.multiUpdates.fill(0);
    for (const c of this.channels) {
      c.acPrevious.fill(0);
      for (let i = 0; i < c.lmsCount; i++) {
        const l = c.lms[i]!;
        l.coefs.fill(0);
        l.previous.fill(0);
        l.updates.fill(0);
      }
      c.average = 0;
    }
  }

  private filterHeader(): void {
    const g = this.gb;
    this.clear();
    if (g.bit()) throw Error('Unsupported WMA Lossless arithmetic coding');
    this.acFilter = g.bit();
    this.interChannel = g.bit();
    this.multiLms = g.bit();
    if (this.acFilter) {
      this.acOrder = g.bits(4) + 1;
      this.acScaling = g.bits(4);
      for (let i = 0; i < this.acOrder; i++) this.acCoefs[i] = g.bitsLong(this.acScaling) + 1;
    }
    if (this.multiLms) {
      this.multiOrder = (g.bits(4) + 1) * 2;
      this.multiScaling = g.bits(4);
      if (g.bit()) {
        const n = g.bitsLong(ceilLog2(this.multiScaling + 1)) + 2;
        for (let i = 0; i < this.multiOrder * 4; i++) this.multiCoefs[i] = g.bitsLong(n);
        this.multiCurrent[2] = g.bitsLong(n);
      }
    }
    const send = g.bit();
    for (const c of this.channels) {
      c.lmsCount = g.bits(3) + 1;
      for (let i = 0; i < c.lmsCount; i++) {
        const l = c.lms[i]!;
        l.order = (g.bits(7) + 1) * 8;
        if (l.order > 256) throw Error('Unsupported WMA Lossless predictor order');
      }
      for (let i = 0; i < c.lmsCount; i++) c.lms[i]!.scaling = g.bits(4);
      if (send)
        for (let i = 0; i < c.lmsCount; i++) {
          const l = c.lms[i]!,
            count = g.bitsLong(ceilLog2(l.order)) + 1;
          const n = g.bitsLong(ceilLog2(l.scaling + 1)) + 2;
          if (count > l.coefs.length || n > 32)
            throw Error('Invalid WMA Lossless predictor coefficients');
          for (let j = 0; j < count; j++)
            l.coefs[j] = (g.bitsLong(n) << (32 - n)) >> (30 - l.scaling);
        }
      for (let i = 0; i < c.lmsCount; i++) {
        const l = c.lms[i]!;
        l.coefs.fill(0, l.order, l.order + 8);
        l.recent = l.order;
      }
      c.transientCounter = this.samples;
    }
    this.movingScaling = g.bits(3);
    this.quantStep = g.bits(8) + 1;
    this.multiRecent = this.multiOrder * 2;
  }

  private subframe(): void {
    const g = this.gb;
    let offset = this.samples,
      length = this.samples;
    for (const c of this.channels)
      if (c.decoded < offset) {
        offset = c.decoded;
        length = c.lengths[c.current]!;
      }
    const selected = this.channels.map(
      (c) => c.decoded === offset && c.lengths[c.current] === length,
    );
    if (!length || offset + length > this.samples) throw Error('Invalid WMA Lossless subframe');
    for (let i = 0; i < 2; i++) if (selected[i]) this.channels[i]!.decoded += length;
    const seekable = g.bit();
    if (seekable) this.filterHeader();
    const raw = g.bit();
    if (!raw && !this.channels[0]!.lms[0]!.order)
      throw Error('WMA Lossless requires a seekable tile');
    for (const c of this.channels) c.coded = raw ? 1 : g.bit();
    if (!raw && g.bit()) throw Error('Unsupported WMA Lossless inverse LPC filter');
    const padding = g.bit() ? g.bits(5) : 0;
    if (padding > this.bits || (raw && padding === this.bits))
      throw Error('Invalid WMA Lossless padding');
    if (raw) {
      for (const c of this.channels)
        for (let i = 0; i < length; i++) c.residues[i] = signed(g, this.bits - padding);
    } else {
      for (const c of this.channels) {
        if (c.coded) {
          if (this.backend) this.decodeChannel(c, length, seekable);
          else {
            this.residues(c, length, !!seekable);
            this.updateSpeed(c, seekable ? 16 : 8);
            this.predict(c, length);
          }
        } else c.residues.fill(0, 0, length);
      }
      if (!this.backend) {
        if (this.multiLms) this.predictMulti(length);
        if (this.interChannel && (this.channels[0]!.coded || this.channels[1]!.coded)) {
          const a = this.channels[0]!.residues,
            b = this.channels[1]!.residues;
          for (let i = 0; i < length; i++) {
            a[i] = a[i]! - (b[i]! >> 1);
            b[i] = b[i]! + a[i]!;
          }
        }
        if (this.acFilter) this.predictAc(length);
        if (this.quantStep !== 1)
          for (const c of this.channels)
            for (let i = 0; i < length; i++)
              c.residues[i] = Math.imul(c.residues[i]!, this.quantStep);
      }
    }
    if (this.backend) this.finish(length, raw, padding, offset, selected);
    for (let c = 0; c < 2; c++)
      if (selected[c]) {
        const channel = this.channels[c]!,
          dest = this.output[c]!;
        if (!this.backend)
          for (let j = 0; j < length; j++) {
            // Both source formats become Q31 before conversion to planar float.
            const shift = 32 - this.bits + padding;
            dest[offset + j] = shift >= 32 ? 0 : (channel.residues[j]! << shift) / 2147483648;
          }
        channel.current++;
      }
  }

  private finish(
    length: number,
    raw: number,
    padding: number,
    offset: number,
    selected: boolean[],
  ): void {
    // Shared reconstruction state: sizes/flags, predictor scalars and arena pointers.
    const s = this.channelState;
    s[0] = length;
    s[1] = this.bits;
    s[2] = raw;
    s[3] = this.interChannel;
    s[4] = this.multiLms;
    s[5] = this.acFilter;
    s[6] = this.quantStep;
    s[7] = this.acOrder;
    s[8] = this.acScaling;
    s[9] = this.acCoefs.byteOffset;
    s[10] = this.multiOrder;
    s[11] = this.multiScaling;
    s[12] = this.multiRecent;
    s[13] = this.multiCoefs.byteOffset;
    s[14] = this.multiCurrent.byteOffset;
    s[15] = this.multiPrevious.byteOffset;
    s[16] = this.multiUpdates.byteOffset;
    for (let c = 0; c < 2; c++) {
      s[17 + c] = this.channels[c]!.residues.byteOffset;
      s[19 + c] = this.channels[c]!.acPrevious.byteOffset;
      s[22 + c] = selected[c] ? this.output[c]!.byteOffset + offset * 4 : 0;
      s[24 + c] = this.channels[c]!.coded;
    }
    s[21] = 32 - this.bits + padding;
    this.backend!.finish(s);
    this.multiRecent = s[12]!;
  }

  private decodeChannel(c: Channel, length: number, seekable: number): void {
    const s = this.channelState;
    s[0] = c.average;
    s[1] = c.transientCounter;
    s[2] = c.speed;
    s[3] = this.bits;
    s[4] = this.movingScaling;
    s[5] = length;
    s[6] = seekable;
    s[7] = this.interChannel;
    s[8] = c.lmsCount;
    s[9] = c.residues.byteOffset;
    for (let i = 0; i < c.lmsCount; i++) {
      const l = c.lms[i]!,
        p = 10 + i * 6;
      s[p] = l.order;
      s[p + 1] = l.scaling;
      s[p + 2] = l.recent;
      s[p + 3] = l.coefs.byteOffset;
      s[p + 4] = l.previous.byteOffset;
      s[p + 5] = l.updates.byteOffset;
    }
    this.backend!.decodeChannel(s, this.gb);
    c.average = s[0]! >>> 0;
    c.transientCounter = s[1]!;
    c.speed = s[2]!;
    for (let i = 0; i < c.lmsCount; i++) c.lms[i]!.recent = s[12 + i * 6]!;
  }

  private residues(c: Channel, length: number, seekable: boolean): void {
    const g = this.gb;
    if (g.bit()) {
      g.bits(31 - Math.clz32(length));
      c.transientCounter = Math.max(c.transientCounter, this.samples / 2);
    }
    let i = 0;
    if (seekable) {
      c.average = (g.bitsLong(this.bits) << (this.movingScaling + 1)) >>> 0;
      c.residues[i++] = signed(g, this.bits + this.interChannel);
    }
    for (; i < length; i++) {
      let quotient = 0;
      while (g.bit()) {
        quotient++;
        if (g.left() <= 0) throw Error('Truncated WMA Lossless residue');
      }
      if (quotient >= 32) quotient = (quotient + g.bitsLong(g.bits(5) + 1)) >>> 0;
      const mean = ((c.average + (1 << this.movingScaling)) >>> 0) >>> (this.movingScaling + 1);
      let residue = quotient;
      if (mean > 1) {
        const n = ceilLog2(mean);
        residue = ((quotient << n) + g.bitsLong(n)) >>> 0;
      }
      c.average = (residue + c.average - (c.average >>> this.movingScaling)) >>> 0;
      c.residues[i] = (residue >>> 1) ^ -(residue & 1);
    }
  }

  private updateSpeed(c: Channel, speed: number): void {
    if (speed === c.speed) return;
    for (let i = c.lmsCount - 1; i >= 0; i--) {
      const l = c.lms[i]!;
      for (let j = 0; j < l.order; j++) {
        const p = j + l.recent;
        l.updates[p] = speed === 16 ? l.updates[p]! * 2 : Math.trunc(l.updates[p]! / 2);
      }
    }
    c.speed = speed;
  }

  private predict(c: Channel, length: number): void {
    const range = 1 << (this.bits - 1);
    for (let i = c.lmsCount - 1; i >= 0; i--) {
      const l = c.lms[i]!,
        aligned = (l.order + (this.bits === 16 ? 15 : 7)) & (this.bits === 16 ? -16 : -8);
      for (let j = 0; j < length; j++) {
        const residue = c.residues[j]!,
          sign = Math.sign(residue);
        let pred = (1 << l.scaling) >>> 1;
        for (let k = 0; k < aligned; k++) {
          pred = (pred + Math.imul(l.coefs[k]!, l.previous[l.recent + k]!)) | 0;
          l.coefs[k] = l.coefs[k]! + sign * l.updates[l.recent + k]!;
        }
        const input = (residue + (pred >> l.scaling)) | 0;
        let recent = l.recent;
        if (recent) recent--;
        else {
          l.previous.copyWithin(l.order, 0, l.order);
          l.updates.copyWithin(l.order, 0, l.order);
          recent = l.order - 1;
        }
        l.previous[recent] = Math.max(-range, Math.min(range - 1, input));
        l.updates[recent] = Math.sign(input) * c.speed;
        l.updates[recent + (l.order >> 4)]! >>= 2;
        l.updates[recent + (l.order >> 3)]! >>= 1;
        l.recent = recent;
        // The tail is already zero; advancing the window exposes one live entry.
        l.updates[recent + l.order] = 0;
        c.residues[j] = input;
      }
    }
  }

  private predictMulti(length: number): void {
    const range = 1 << (this.bits - 1),
      order = this.multiOrder * 2,
      predictions = this.predictions;
    for (let sample = 0; sample < length; sample++) {
      predictions.fill(0);
      for (let ch = 0; ch < 2; ch++) {
        const c = this.channels[ch]!;
        if (!c.coded) continue;
        let pred = 0;
        for (let i = 0; i < order; i++)
          pred =
            (pred +
              Math.imul(
                this.multiPrevious[this.multiRecent + i]!,
                this.multiCoefs[i + order * ch]!,
              )) |
            0;
        for (let i = 0; i < ch; i++)
          pred =
            (pred +
              Math.imul(this.channels[i]!.residues[sample]!, this.multiCurrent[i + 2 * ch]!)) |
            0;
        pred = (pred + ((1 << this.multiScaling) >>> 1)) >> this.multiScaling;
        predictions[ch] = pred;
        c.residues[sample] = c.residues[sample]! + pred;
      }
      for (let ch = 0; ch < 2; ch++) {
        const sign = Math.sign((this.channels[ch]!.residues[sample]! - predictions[ch]!) | 0);
        if (sign) {
          for (let i = 0; i < order; i++)
            this.multiCoefs[i + ch * order] =
              this.multiCoefs[i + ch * order]! + sign * this.multiUpdates[this.multiRecent + i]!;
          for (let i = 0; i < ch; i++)
            this.multiCurrent[ch * 2 + i] =
              this.multiCurrent[ch * 2 + i]! +
              sign * Math.sign(this.channels[i]!.residues[sample]!);
        }
      }
      for (let ch = 1; ch >= 0; ch--) {
        const value = this.channels[ch]!.residues[sample]!;
        this.multiRecent--;
        this.multiPrevious[this.multiRecent] = Math.max(-range, Math.min(range - 1, value));
        this.multiUpdates[this.multiRecent] = Math.sign(value);
      }
      if (!this.multiRecent) {
        this.multiPrevious.copyWithin(order, 0, order);
        this.multiUpdates.copyWithin(order, 0, order);
        this.multiRecent = order;
      }
    }
  }

  private predictAc(length: number): void {
    for (const c of this.channels) {
      for (let i = 0; i < length; i++) {
        let pred = 0;
        for (let j = 0; j < this.acOrder; j++) {
          const value = i <= j ? c.acPrevious[j - i]! : c.residues[i - j - 1]!;
          pred = (pred + Math.imul(this.acCoefs[j]!, value)) | 0;
        }
        c.residues[i] = c.residues[i]! + (pred >> this.acScaling);
      }
      for (let j = this.acOrder - 1; j >= 0; j--)
        c.acPrevious[j] = length <= j ? c.acPrevious[j - length]! : c.residues[length - j - 1]!;
    }
  }
}

function ceilLog2(value: number): number {
  return value <= 1 ? 0 : 32 - Math.clz32(value - 1);
}
function signed(reader: BitReader, n: number): number {
  return (reader.bitsLong(n) << (32 - n)) >> (32 - n);
}

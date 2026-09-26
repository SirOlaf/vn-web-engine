import {BitReader} from '../../core/bits.js';
import {checkRange} from '../../core/binary.js';
import {synthesisMatrix} from './synthesis.js';
import * as T from './tables.js';

const BITRATES = [32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384];
const SAMPLE_RATES = [44100, 48000, 32000];

export interface Mp2Header {
  readonly frameBytes: number;
  readonly sampleRate: number;
  readonly channels: 1 | 2;
  /** Bits per second. */
  readonly bitrate: number;
  readonly samplesPerFrame: 1152;
  readonly hasCrc: boolean;
  /** Stereo, joint stereo, dual channel, or mono (0–3). */
  readonly mode: number;
  readonly modeExtension: number;
  readonly bitrateIndex: number;
  readonly sampleRateIndex: number;
}

/** MPEG-1 Layer II header. A partial header returns null; unsupported or
 * malformed complete headers throw. Free-format framing is not supported. */
export function readMp2Header(bytes: Uint8Array, offset = 0): Mp2Header | null {
  checkRange(bytes.length, offset, 0);
  if (bytes.length - offset < 4) return null;
  const b0 = bytes[offset]!,
    b1 = bytes[offset + 1]!,
    b2 = bytes[offset + 2]!,
    b3 = bytes[offset + 3]!;
  if (b0 !== 255 || (b1 & 0xe0) !== 0xe0) throw new Error('Invalid MP2 frame sync');
  if (((b1 >>> 3) & 3) !== 3) throw new Error('MP2 decoder requires MPEG-1 audio');
  if (((b1 >>> 1) & 3) !== 2) throw new Error('MP2 decoder requires Layer II audio');
  const encodedBitrate = b2 >>> 4,
    sampleRateIndex = (b2 >>> 2) & 3;
  if (encodedBitrate === 0) throw new Error('Free-format MP2 framing is unsupported');
  if (encodedBitrate === 15 || sampleRateIndex === 3 || (b3 & 3) === 2)
    throw new Error('Invalid MP2 header field');
  const bitrateIndex = encodedBitrate - 1,
    rate = BITRATES[bitrateIndex]!,
    sampleRate = SAMPLE_RATES[sampleRateIndex]!;
  const mode = b3 >>> 6,
    channels = mode === 3 ? 1 : 2;
  if ((channels === 1 && rate > 192) || (channels === 2 && [32, 48, 56, 80].includes(rate)))
    throw new Error('Invalid MPEG-1 Layer II bitrate/channel combination');
  return {
    frameBytes: Math.floor((144000 * rate) / sampleRate) + ((b2 >>> 1) & 1),
    sampleRate,
    channels,
    bitrate: rate * 1000,
    samplesPerFrame: 1152,
    hasCrc: (b1 & 1) === 0,
    mode,
    modeExtension: (b3 >>> 4) & 3,
    bitrateIndex,
    sampleRateIndex,
  };
}

export interface Mp2PcmFrame {
  /** Independent planar PCM buffers; retained frames are never overwritten. */
  readonly channels: Float32Array[];
  readonly sampleRate: number;
  /** Cumulative sample index per channel, starting at zero. */
  readonly startSample: number;
}

/** Incremental MPEG-1 Layer II elementary-stream decoder. Synthesis history
 * persists across frames/chunks. Stream format changes require a new decoder.
 * Arithmetic adapted from MIT-licensed JSMpeg; see LICENSE and source.json. */
export class Mp2Decoder {
  private pending = new Uint8Array();
  private failed = false;
  private ended = false;
  private format: Mp2Header | null = null;
  private nextSample = 0;
  private readonly window = new Float32Array(1024);
  private readonly history = [new Float32Array(1024), new Float32Array(1024)];
  private readonly accumulator = new Float64Array(32);
  private historyPosition = 0;
  private readonly samples = Array.from({length: 2}, () =>
    Array.from({length: 32}, () => new Float64Array(3)),
  );

  constructor() {
    this.window.set(T.SYNTHESIS_WINDOW);
    this.window.set(T.SYNTHESIS_WINDOW, 512);
  }

  push(bytes: Uint8Array): Mp2PcmFrame[] {
    if (this.failed || this.ended) throw new Error('MP2 decoder cannot accept more data');
    if (bytes.length + this.pending.length > 1024 * 1024)
      throw new Error('MP2 input chunk exceeds memory limit');
    const data = new Uint8Array(this.pending.length + bytes.length);
    data.set(this.pending);
    data.set(bytes, this.pending.length);
    const output: Mp2PcmFrame[] = [];
    let offset = 0;
    try {
      while (offset < data.length) {
        const header = readMp2Header(data, offset);
        if (header === null || data.length - offset < header.frameBytes) break;
        if (output.length >= 256)
          throw new Error('Too many MP2 frames in one chunk; feed smaller chunks');
        if (
          this.format !== null &&
          (header.sampleRate !== this.format.sampleRate || header.channels !== this.format.channels)
        )
          throw new Error('MP2 stream format changed without a decoder reset');
        this.format = header;
        const channels = this.frame(data.subarray(offset, offset + header.frameBytes), header);
        output.push({channels, sampleRate: header.sampleRate, startSample: this.nextSample});
        this.nextSample += 1152;
        offset += header.frameBytes;
      }
      this.pending = data.slice(offset);
    } catch (error) {
      this.failed = true;
      throw error;
    }
    return output;
  }

  flush(): void {
    if (this.failed || this.ended) throw new Error('MP2 decoder already closed');
    if (this.pending.length) {
      this.failed = true;
      throw new Error('Truncated MP2 frame at end of stream');
    }
    this.ended = true;
  }

  private frame(bytes: Uint8Array, header: Mp2Header): Float32Array[] {
    const bits = new BitReader(bytes);
    bits.skip(32);
    const crc = header.hasCrc ? bits.read(16) : null;
    const bitrateClass = T.QUANT_LUT_STEP_1[header.channels === 1 ? 0 : 1]![header.bitrateIndex]!;
    const limits = T.QUANT_LUT_STEP_2[bitrateClass]![header.sampleRateIndex]!;
    const table = limits >>> 6,
      subbands = limits & 63;
    const bound = header.mode === 1 ? Math.min((header.modeExtension + 1) * 4, subbands) : subbands;
    const allocation: (T.Quantizer | null)[][] = Array.from({length: 2}, () =>
      new Array<T.Quantizer | null>(32).fill(null),
    );
    const selection = [new Uint8Array(32), new Uint8Array(32)];
    const factors = Array.from({length: 2}, () =>
      Array.from({length: 32}, () => new Uint8Array(3)),
    );
    const readAllocation = (subband: number): T.Quantizer | null => {
      const info = T.QUANT_LUT_STEP_3[table]![subband]!;
      const index = T.QUANT_LUT_STEP4[info & 15]![bits.read(info >>> 4)]!;
      return index === 0 ? null : T.QUANTIZERS[index - 1]!;
    };
    for (let sb = 0; sb < subbands; sb++) {
      allocation[0]![sb] = readAllocation(sb);
      if (header.channels === 2)
        allocation[1]![sb] = sb < bound ? readAllocation(sb) : allocation[0]![sb]!;
    }
    for (let sb = 0; sb < subbands; sb++)
      for (let ch = 0; ch < header.channels; ch++)
        if (allocation[ch]![sb]) selection[ch]![sb] = bits.read(2);
    if (crc !== null && crc16(bytes, bits.position) !== crc)
      throw new Error('MP2 protected-header CRC mismatch');
    for (let sb = 0; sb < subbands; sb++)
      for (let ch = 0; ch < header.channels; ch++) {
        if (!allocation[ch]![sb]) continue;
        const scale = factors[ch]![sb]!;
        switch (selection[ch]![sb]) {
          case 0:
            scale[0] = bits.read(6);
            scale[1] = bits.read(6);
            scale[2] = bits.read(6);
            break;
          case 1:
            scale[0] = scale[1] = bits.read(6);
            scale[2] = bits.read(6);
            break;
          case 2:
            scale[0] = scale[1] = scale[2] = bits.read(6);
            break;
          case 3:
            scale[0] = bits.read(6);
            scale[1] = scale[2] = bits.read(6);
            break;
        }
      }
    const output = Array.from({length: header.channels}, () => new Float32Array(1152));
    let outputOffset = 0;
    for (let part = 0; part < 3; part++)
      for (let granule = 0; granule < 4; granule++) {
        for (let sb = 0; sb < subbands; sb++) {
          const shared = sb >= bound;
          let raw: number[] | null = null;
          for (let ch = 0; ch < header.channels; ch++) {
            const quantizer = allocation[ch]![sb],
              target = this.samples[ch]![sb]!;
            if (!quantizer) {
              target.fill(0);
              continue;
            }
            if (!shared || ch === 0) raw = quantizedSamples(bits, quantizer);
            reconstruct(raw!, quantizer, factors[ch]![sb]![part]!, target);
          }
        }
        for (let ch = 0; ch < header.channels; ch++)
          for (let sb = subbands; sb < 32; sb++) this.samples[ch]![sb]!.fill(0);
        for (let sample = 0; sample < 3; sample++) {
          this.historyPosition = (this.historyPosition - 64) & 1023;
          for (let ch = 0; ch < header.channels; ch++) {
            const history = this.history[ch]!;
            synthesisMatrix(this.samples[ch]!, sample, history, this.historyPosition);
            this.accumulator.fill(0);
            let windowIndex = 512 - (this.historyPosition >>> 1);
            let historyIndex = (this.historyPosition % 128) >>> 1;
            while (historyIndex < 1024) {
              for (let i = 0; i < 32; i++)
                this.accumulator[i] =
                  this.accumulator[i]! + this.window[windowIndex++]! * history[historyIndex++]!;
              historyIndex += 96;
              windowIndex += 32;
            }
            historyIndex = 1120 - historyIndex;
            windowIndex -= 480;
            while (historyIndex < 1024) {
              for (let i = 0; i < 32; i++)
                this.accumulator[i] =
                  this.accumulator[i]! + this.window[windowIndex++]! * history[historyIndex++]!;
              historyIndex += 96;
              windowIndex += 32;
            }
            for (let i = 0; i < 32; i++)
              output[ch]![outputOffset + i] = this.accumulator[i]! / 32768;
          }
          outputOffset += 32;
        }
      }
    return output;
  }
}

function quantizedSamples(bits: BitReader, quantizer: T.Quantizer): number[] {
  const {levels, group, bits: width} = quantizer;
  if (group) {
    let value = bits.read(width);
    if (value >= levels ** 3) throw new Error('Invalid grouped MP2 sample code');
    const first = value % levels;
    value = Math.floor(value / levels);
    return [first, value % levels, Math.floor(value / levels)];
  }
  const values = [bits.read(width), bits.read(width), bits.read(width)];
  if (values.some((value) => value >= levels)) throw new Error('Invalid MP2 sample code');
  return values;
}

function reconstruct(
  raw: number[],
  quantizer: T.Quantizer,
  factor: number,
  output: Float64Array,
): void {
  // Mid-tread uniform requantization and the ISO scalefactor progression.
  // Keep normalized values through synthesis instead of the reference core's
  // inverted, approximate integer samples and half-amplitude output gain.
  const scale = factor === 63 ? 0 : 2 ** (1 - factor / 3);
  for (let i = 0; i < 3; i++)
    output[i] = ((2 * raw[i]! + 1 - quantizer.levels) / quantizer.levels) * scale;
}

/** Layer II protection covers the low header word, allocation and scfsi only. */
function crc16(bytes: Uint8Array, protectedEnd: number): number {
  let crc = 0xffff;
  for (const [start, end] of [
    [16, 32],
    [48, protectedEnd],
  ])
    for (let bit = start!; bit < end!; bit++) {
      const value = (bytes[bit >>> 3]! >>> (7 - (bit & 7))) & 1;
      const carry = (crc >>> 15) ^ value;
      crc = ((crc << 1) ^ (carry ? 0x8005 : 0)) & 0xffff;
    }
  return crc;
}

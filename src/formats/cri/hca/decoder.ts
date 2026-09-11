import {BitReader} from '../../../core/bits.js';
import type {HcaHeader} from './header.js';
import {hcaCrc} from './header.js';
import {
  QUANT_BITS,
  QUANT_VALUES,
  QUANT_LENGTHS,
  RESOLUTION,
  SCALE,
  STEP,
  HFR_SCALE,
} from './tables.js';
import {HcaImdct} from './imdct.js';
class Channel {
  readonly hfr = new Uint8Array(128);
  readonly scale = new Uint8Array(128);
  readonly resolution = new Uint8Array(128);
  readonly gain = new Float32Array(128);
  readonly spectrum = new Float32Array(128);
  readonly transform = new HcaImdct();
}
/** One sequential decoder per voice. decodeBlock returns 1024 untrimmed PCM samples/channel. */
export class HcaDecoder {
  private readonly channels: Channel[];
  private blockIndex = 0;
  private failed = false;
  constructor(readonly header: HcaHeader) {
    this.channels = Array.from({length: header.channels}, () => new Channel());
  }
  reset(): void {
    this.blockIndex = 0;
    this.failed = false;
    for (const ch of this.channels) {
      ch.scale.fill(0);
      ch.resolution.fill(0);
      ch.gain.fill(0);
      ch.spectrum.fill(0);
      ch.transform.reset();
    }
  }
  decodeBlock(bytes: Uint8Array): Float32Array[] {
    if (this.failed) throw new Error('HCA decoder must be reset after a failed block');
    try {
      return this.decode(bytes);
    } catch (error) {
      this.failed = true;
      throw new Error(
        `HCA block ${this.blockIndex}: ${error instanceof Error ? error.message : error}`,
        {cause: error},
      );
    }
  }
  private decode(bytes: Uint8Array): Float32Array[] {
    const h = this.header,
      groups = h.bandsPerHfrGroup
        ? Math.ceil((h.totalBands - h.baseBands) / h.bandsPerHfrGroup)
        : 0;
    if (this.blockIndex >= h.blockCount) throw new Error('End of HCA stream');
    if (bytes.length !== h.blockSize) throw new Error('Incorrect block size');
    if (hcaCrc(bytes) !== 0) throw new Error('CRC mismatch');
    // The checksum is readable as speculative lookahead, but never consumable payload.
    const bits = new BitReader(bytes);
    if (bits.read(16) !== 0xffff) throw new Error('Unsupported block sync');
    const noise = bits.read(9),
      boundary = bits.read(7);
    for (const ch of this.channels) {
      const width = bits.read(3);
      ch.scale.fill(0);
      if (width) {
        let scale = bits.read(6);
        ch.scale[0] = scale;
        for (let band = 1; band < h.baseBands; band++) {
          if (width >= 6) scale = bits.read(6);
          else {
            const delta = bits.read(width),
              escape = (1 << width) - 1;
            scale = delta === escape ? bits.read(6) : scale + delta - (escape >>> 1);
          }
          // Native 1401a80a0 masks the stored scale while preserving the delta accumulator.
          ch.scale[band] = scale & 63;
        }
      }
      for (let group = 0; group < groups; group++) ch.hfr[group] = bits.read(6);
      for (let band = 0; band < h.baseBands; band++) {
        const scale = ch.scale[band]!;
        let resolution = 0;
        if (scale) {
          const curve =
            Math.floor((noise * 256 - boundary + band) / 256) - Math.floor((scale * 5) / 2) + 1;
          resolution = curve < 0 ? 15 : curve < RESOLUTION.length ? RESOLUTION[curve]! : 0;
          resolution = Math.max(h.minResolution, Math.min(h.maxResolution, resolution));
        }
        ch.resolution[band] = resolution;
        ch.gain[band] = SCALE[scale]! * STEP[resolution]!;
      }
    }
    const output = this.channels.map(() => new Float32Array(1024));
    for (let subframe = 0; subframe < 8; subframe++) {
      for (let c = 0; c < this.channels.length; c++) {
        const ch = this.channels[c]!;
        ch.spectrum.fill(0);
        for (let band = 0; band < h.baseBands; band++) {
          const resolution = ch.resolution[band]!,
            width = QUANT_BITS[resolution]!;
          const code = bits.peek(width);
          let value: number;
          if (resolution < 8) {
            const index = resolution * 16 + code;
            bits.skip(QUANT_LENGTHS[index]!);
            value = QUANT_VALUES[index]!;
          } else {
            const magnitude = code >>> 1;
            value = code & 1 ? -magnitude : magnitude;
            bits.skip(width - (magnitude === 0 ? 1 : 0));
          }
          ch.spectrum[band] = value * ch.gain[band]!;
        }
        if (groups) {
          let low = h.baseBands - 1,
            high = h.baseBands;
          for (let group = 0; group < groups; group++)
            for (
              let j = 0;
              j < h.bandsPerHfrGroup && high < h.totalBands && low >= 0;
              j++, high++, low--
            ) {
              ch.spectrum[high] =
                HFR_SCALE[Math.max(0, ch.hfr[group]! - ch.scale[low]! + 63)]! * ch.spectrum[low]!;
            }
          ch.spectrum[high - 1] = 0;
        }
        ch.transform.process(ch.spectrum, output[c]!, subframe * 128);
      }
    }
    if (bits.position > (bytes.length - 2) * 8)
      throw new Error('Coefficient data overlaps checksum');
    this.blockIndex++;
    return output;
  }
}

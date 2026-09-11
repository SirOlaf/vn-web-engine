import type {ByteSource} from '../../../core/source.js';
import type {PcmClip} from '../../../audio/pcm.js';
import {HcaDecoder} from './decoder.js';
import {hcaHeaderSize, parseHcaHeader} from './header.js';
import type {HcaHeader} from './header.js';
export interface HcaDecodeOptions {
  maxPcmBytes?: number;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}
/** Container/source handling is separate from the synchronous per-block DSP decoder. */
export class HcaStream {
  private constructor(
    readonly source: ByteSource,
    readonly header: HcaHeader,
  ) {}
  static async open(source: ByteSource): Promise<HcaStream> {
    const size = hcaHeaderSize(await source.read(0, 8));
    return new HcaStream(source, parseHcaHeader(await source.read(0, size), source.size));
  }
  async decode(options: HcaDecodeOptions = {}): Promise<PcmClip> {
    const h = this.header,
      bytes = h.sampleCount * h.channels * 4;
    if (bytes > (options.maxPcmBytes ?? 128 * 1024 * 1024))
      throw new Error('Decoded audio exceeds PCM memory limit');
    options.signal?.throwIfAborted();
    const channels = Array.from({length: h.channels}, () => new Float32Array(h.sampleCount));
    const decoder = new HcaDecoder(h);
    for (let first = 0; first < h.blockCount; first += 64) {
      options.signal?.throwIfAborted();
      const count = Math.min(64, h.blockCount - first);
      const packed = await this.source.read(
        h.headerSize + first * h.blockSize,
        count * h.blockSize,
      );
      for (let i = 0; i < count; i++) {
        const pcm = decoder.decodeBlock(packed.subarray(i * h.blockSize, (i + 1) * h.blockSize));
        const audibleStart = (first + i) * 1024 - h.encoderDelay;
        const from = Math.max(0, -audibleStart),
          to = Math.min(1024, h.sampleCount - audibleStart);
        if (to > from)
          for (let c = 0; c < h.channels; c++) {
            const dest = channels[c]!,
              src = pcm[c]!;
            for (let n = from; n < to; n++) dest[audibleStart + n] = src[n]! * h.volume;
          }
      }
      options.onProgress?.((first + count) / h.blockCount);
    }
    return {
      sampleRate: h.sampleRate,
      sampleCount: h.sampleCount,
      channels,
      ...(h.loop ? {loop: {start: h.loop.start, end: h.loop.end}} : {}),
    };
  }
}

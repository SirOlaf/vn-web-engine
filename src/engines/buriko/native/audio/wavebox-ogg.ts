import {
  parseBurikoWaveBoxHeader,
  BurikoWaveBoxError,
  type BurikoWaveBoxHeader,
} from './wavebox-header.js';
import {decodeBurikoOggVorbis, type BurikoVorbisPcmLink} from './ogg-vorbis.js';
import {BURIKO_BP_ABI_172, type BurikoBpAbi} from '../../bp/abi.js';

export interface BurikoWaveBoxOggOptions {
  readonly gain: number;
  readonly prefer24Bit: boolean;
  readonly abi?: BurikoBpAbi;
}

/** The eight tables at 1401ca510 map encoded Vorbis planes into native output channels. */
const nativeChannelOrder: readonly (readonly number[])[] = [
  [],
  [0],
  [0, 1],
  [0, 2, 1],
  [0, 1, 2, 3],
  [0, 2, 1, 3, 4],
  [0, 2, 1, 4, 5, 3],
  [0, 2, 1, 5, 6, 4, 3],
  [0, 2, 1, 4, 5, 6, 7, 3],
];

/** 14011b090: binary32 -> binary64 scaling, CVTTSD2SI32, then signed saturation. */
export function quantizeBurikoVorbisSample(sample: number, gain: number, bits: 16 | 24): number {
  const scale = bits === 16 ? 32768 : 8388608;
  const scaled = Math.fround(sample) * scale * gain;
  const truncated = Math.trunc(scaled);
  const integer =
    !Number.isFinite(truncated) || truncated < -2147483648 || truncated > 2147483647
      ? -2147483648
      : truncated;
  return Math.max(-scale, Math.min(scale - 1, integer));
}

/** 1.69 ov_read00478d44: round Float32*32768 to nearest-even i32 and clamp
 * to i16 first. 00475604 then applies gain at PC=53; __ftol004790a4 truncates
 * to i64, and the caller saturates its signed low DWORD (including wrap/indefinite). */
export function quantizeBuriko169VorbisSample(sample: number, gain: number): number {
  const scaled = Math.fround(sample) * 32768;
  const floor = Math.floor(scaled),
    fraction = scaled - floor;
  const rounded = fraction > 0.5 || (fraction === 0.5 && floor % 2 !== 0) ? floor + 1 : floor;
  const integer =
    !Number.isFinite(rounded) || rounded < -2147483648 || rounded > 2147483647
      ? -2147483648
      : rounded;
  const pcm = Math.max(-32768, Math.min(32767, integer));
  const gained = pcm * gain;
  const low =
    !Number.isFinite(gained) || gained < -(2 ** 63) || gained >= 2 ** 63
      ? 0
      : Math.trunc(gained) | 0;
  return Math.max(-32768, Math.min(32767, low));
}

/** Decoded Vorbis storage plus native producer position; the outer CWaveStreamCtrl owns loop counts/FIFO. */
export class BurikoWaveBoxOggDecoder {
  private decodedPosition = 0;
  private sourcePosition = 0;
  private enabled: number;
  private loopStart: number;
  readonly totalVorbisFrames: number;
  constructor(
    readonly header: BurikoWaveBoxHeader,
    readonly links: readonly BurikoVorbisPcmLink[],
    readonly outputBits: 16 | 24,
    readonly gain: number,
    readonly abi: BurikoBpAbi = BURIKO_BP_ABI_172,
  ) {
    if (header.codec !== 3)
      throw new BurikoWaveBoxError(0x11000004, 'Buriko Ogg model requires codec3');
    if (abi.compatibility === '1.69' && outputBits !== 16)
      throw new RangeError('Buriko 1.69 Vorbis output is signed 16-bit PCM');
    this.enabled = header.loopEnabled;
    this.loopStart = header.loopStartFrame;
    this.totalVorbisFrames = links.reduce((sum, link) => sum + link.frames, 0);
  }
  get sourceFrameCount(): number {
    return this.header.sourceFrameCount;
  }
  get channels(): number {
    return this.header.channels;
  }
  get sampleRate(): number {
    return this.header.sampleRate;
  }
  get decodedFramePosition(): number {
    return this.decodedPosition;
  }
  get loopEnabled(): number {
    return this.enabled;
  }
  get loopStartFrame(): number {
    return this.loopStart;
  }
  overrideLoop(enabled: number): void {
    this.enabled = enabled >>> 0;
    this.loopStart = 0;
  }
  reset(): void {
    this.decodedPosition = 0;
    this.sourcePosition = 0;
  }
  restartLoop(): void {
    this.decodedPosition = this.loopStart;
    // ov_pcm_seek rejects positions beyond the PCM end without changing its source position.
    if (this.loopStart <= this.totalVorbisFrames) this.sourcePosition = this.loopStart;
  }
  readFrameBytes(count: number): Uint8Array {
    count = Math.min(count >>> 0, (this.sourceFrameCount - this.decodedPosition) >>> 0);
    const bytesPerSample = this.outputBits >>> 3,
      bytesPerFrame = Math.imul(this.channels, bytesPerSample) >>> 0;
    if (bytesPerFrame === 0)
      throw new RangeError('Buriko Ogg reader divides by zero PCM frame size');
    const available = Math.min(count, this.totalVorbisFrames - this.sourcePosition);
    const bytes = new Uint8Array(available * bytesPerFrame),
      view = new DataView(bytes.buffer);
    if (available === 0) return bytes;
    const legacy = this.abi.compatibility === '1.69';
    const order = legacy ? undefined : nativeChannelOrder[this.channels];
    let outputFrame = 0,
      linkBase = 0;
    for (const link of this.links) {
      const linkEnd = linkBase + link.frames;
      if (this.sourcePosition >= linkEnd) {
        linkBase = linkEnd;
        continue;
      }
      const first = this.sourcePosition - linkBase,
        frames = Math.min(available - outputFrame, link.frames - first);
      for (let channel = 0; channel < this.channels; channel++) {
        const plane = link.planes[channel];
        if (plane === undefined || first + frames > plane.length)
          throw new Error('Buriko Ogg reader accesses undefined Vorbis channel storage');
        const outputChannel = order?.[channel] ?? channel;
        for (let frame = 0; frame < frames; frame++) {
          const value = legacy
            ? quantizeBuriko169VorbisSample(plane[first + frame]!, this.gain)
            : quantizeBurikoVorbisSample(plane[first + frame]!, this.gain, this.outputBits);
          const at = (outputFrame + frame) * bytesPerFrame + outputChannel * bytesPerSample;
          if (this.outputBits === 16) view.setInt16(at, value, true);
          else {
            bytes[at] = value & 255;
            bytes[at + 1] = (value >> 8) & 255;
            bytes[at + 2] = (value >> 16) & 255;
          }
        }
      }
      this.sourcePosition += frames;
      outputFrame += frames;
      if (outputFrame === available) break;
      linkBase = linkEnd;
    }
    this.decodedPosition = (this.decodedPosition + outputFrame) >>> 0;
    return bytes;
  }
}

export async function createBurikoWaveBoxOggDecoder(
  bytes: Uint8Array,
  options: BurikoWaveBoxOggOptions,
  Context?: typeof OfflineAudioContext,
): Promise<BurikoWaveBoxOggDecoder> {
  const header = parseBurikoWaveBoxHeader(bytes);
  if (header.codec !== 3)
    throw new BurikoWaveBoxError(0x11000004, 'Buriko Ogg model requires codec3');
  // Native callbacks expose physical byte64 as Ogg offset0, independent of header.resetDataOffset.
  const links = await decodeBurikoOggVorbis(bytes.subarray(64), Context);
  return new BurikoWaveBoxOggDecoder(
    header,
    links,
    options.prefer24Bit && options.abi?.compatibility !== '1.69' ? 24 : 16,
    options.gain,
    options.abi,
  );
}

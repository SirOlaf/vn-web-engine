import {parseAokanaWaveBoxHeader, AokanaWaveBoxError, type AokanaWaveBoxHeader} from './wavebox-header.js';
import {decodeAokanaOggVorbis, type AokanaVorbisPcmLink} from './ogg-vorbis.js';

/** The eight tables at 1401ca510 map encoded Vorbis planes into native output channels. */
const nativeChannelOrder: readonly (readonly number[])[] = [
  [], [0], [0, 1], [0, 2, 1], [0, 1, 2, 3], [0, 2, 1, 3, 4],
  [0, 2, 1, 4, 5, 3], [0, 2, 1, 5, 6, 4, 3], [0, 2, 1, 4, 5, 6, 7, 3],
];

/** 14011b090: binary32 -> binary64 scaling, CVTTSD2SI32, then signed saturation. */
export function quantizeAokanaVorbisSample(sample: number, gain: number, bits: 16 | 24): number {
  const scale = bits === 16 ? 32768 : 8388608;
  const scaled = Math.fround(sample) * scale * gain;
  const truncated = Math.trunc(scaled);
  const integer = !Number.isFinite(truncated) || truncated < -2147483648 || truncated > 2147483647 ? -2147483648 : truncated;
  return Math.max(-scale, Math.min(scale - 1, integer));
}

/** Decoded Vorbis storage plus native producer position; the outer CWaveStreamCtrl owns loop counts/FIFO. */
export class AokanaWaveBoxOggDecoder {
  private decodedPosition = 0;
  private sourcePosition = 0;
  private enabled: number;
  private loopStart: number;
  readonly totalVorbisFrames: number;
  constructor(
    readonly header: AokanaWaveBoxHeader,
    readonly links: readonly AokanaVorbisPcmLink[],
    readonly outputBits: 16 | 24,
    readonly gain: number,
  ) {
    if (header.codec !== 3) throw new AokanaWaveBoxError(0x11000004, 'Aokana Ogg model requires codec3');
    this.enabled = header.loopEnabled;
    this.loopStart = header.loopStartFrame;
    this.totalVorbisFrames = links.reduce((sum, link) => sum + link.frames, 0);
  }
  get sourceFrameCount(): number {return this.header.sourceFrameCount;}
  get channels(): number {return this.header.channels;}
  get sampleRate(): number {return this.header.sampleRate;}
  get decodedFramePosition(): number {return this.decodedPosition;}
  get loopEnabled(): number {return this.enabled;}
  get loopStartFrame(): number {return this.loopStart;}
  overrideLoop(enabled: number): void {this.enabled = enabled >>> 0; this.loopStart = 0;}
  reset(): void {this.decodedPosition = 0; this.sourcePosition = 0;}
  restartLoop(): void {
    this.decodedPosition = this.loopStart;
    // ov_pcm_seek rejects positions beyond the PCM end without changing its source position.
    if (this.loopStart <= this.totalVorbisFrames) this.sourcePosition = this.loopStart;
  }
  readFrameBytes(count: number): Uint8Array {
    count = Math.min(count >>> 0, (this.sourceFrameCount - this.decodedPosition) >>> 0);
    const bytesPerSample = this.outputBits >>> 3, bytesPerFrame = Math.imul(this.channels, bytesPerSample) >>> 0;
    if (bytesPerFrame === 0) throw new RangeError('Aokana Ogg reader divides by zero PCM frame size');
    const available = Math.min(count, this.totalVorbisFrames - this.sourcePosition);
    const bytes = new Uint8Array(available * bytesPerFrame), view = new DataView(bytes.buffer);
    if (available === 0) return bytes;
    const order = nativeChannelOrder[this.channels];
    let outputFrame = 0, linkBase = 0;
    for (const link of this.links) {
      const linkEnd = linkBase + link.frames;
      if (this.sourcePosition >= linkEnd) {linkBase = linkEnd; continue;}
      const first = this.sourcePosition - linkBase, frames = Math.min(available - outputFrame, link.frames - first);
      for (let channel = 0; channel < this.channels; channel++) {
        const plane = link.planes[channel];
        if (plane === undefined || first + frames > plane.length) throw new Error('Aokana Ogg reader accesses undefined Vorbis channel storage');
        const outputChannel = order?.[channel] ?? channel;
        for (let frame = 0; frame < frames; frame++) {
          const value = quantizeAokanaVorbisSample(plane[first + frame]!, this.gain, this.outputBits);
          const at = (outputFrame + frame) * bytesPerFrame + outputChannel * bytesPerSample;
          if (this.outputBits === 16) view.setInt16(at, value, true);
          else {bytes[at] = value & 255; bytes[at + 1] = (value >> 8) & 255; bytes[at + 2] = (value >> 16) & 255;}
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

export async function createAokanaWaveBoxOggDecoder(
  bytes: Uint8Array,
  options: {readonly gain: number; readonly prefer24Bit: boolean},
  Context?: typeof OfflineAudioContext,
): Promise<AokanaWaveBoxOggDecoder> {
  const header = parseAokanaWaveBoxHeader(bytes);
  if (header.codec !== 3) throw new AokanaWaveBoxError(0x11000004, 'Aokana Ogg model requires codec3');
  // Native callbacks expose physical byte64 as Ogg offset0, independent of header.resetDataOffset.
  const links = await decodeAokanaOggVorbis(bytes.subarray(64), Context);
  return new AokanaWaveBoxOggDecoder(header, links, options.prefer24Bit ? 24 : 16, options.gain);
}

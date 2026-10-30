import {allocateFrame, type YuvFrame} from './frame.js';
import {Vc1Decoder, Vc1Error} from '../formats/vc1/decoder.js';
import {WmaStandardDecoder} from '../formats/wma/standard.js';
import {WmaProDecoder} from '../formats/wma/pro.js';
import {WmaLosslessDecoder} from '../formats/wma/lossless.js';
import {
  createWmaStandardDecoder,
  createWmaProDecoder,
  createWmaLosslessDecoder,
} from '../formats/wma/wasm-decoder.js';

export type WindowsMediaCodec =
  | {
      readonly kind: 'video';
      /** BITMAPINFOHEADER FourCC: WMV3 (Video 9 Simple/Main) or WVC1 (VC-1 Advanced). */
      readonly codec: number;
      readonly width: number;
      readonly height: number;
      readonly extra: Uint8Array;
    }
  | {
      readonly kind: 'audio';
      /** WAVEFORMATEX tag: 0x161 WMA, 0x162 WMA Pro, 0x163 WMA Lossless. */
      readonly codec: number;
      readonly sampleRate: number;
      readonly channels: number;
      readonly bytesPerSecond: number;
      readonly blockAlign: number;
      readonly bitsPerSample: number;
      readonly extra: Uint8Array;
    };

export interface WindowsMediaPicture {
  readonly frame: YuvFrame;
  /** Presentation time in milliseconds, -1 when the decoder has none. */
  readonly time: number;
}
export interface WindowsMediaAudio {
  readonly channels: Float32Array[];
  readonly time: number;
}

/** Progressive VC-1 video and stereo WMA audio, with Rust SIMD acceleration and
 * an identical JavaScript fallback. Returned frames and PCM belong to the caller. */
export class WindowsMediaDecoder {
  private video: Vc1Decoder | undefined;
  private audio: WmaStandardDecoder | WmaProDecoder | WmaLosslessDecoder | undefined;
  private closed = false;
  private drained = false;
  private index = 0;
  readonly accelerated: boolean;

  constructor(
    readonly codec: WindowsMediaCodec,
    options: {wasm?: boolean} = {},
  ) {
    try {
      if (codec.kind === 'video') {
        this.video = new Vc1Decoder(codec.codec, codec.width, codec.height, codec.extra, options);
        this.accelerated = this.video.accelerated;
      } else {
        const factory =
          codec.codec === 0x161
            ? createWmaStandardDecoder
            : codec.codec === 0x162
              ? createWmaProDecoder
              : codec.codec === 0x163
                ? createWmaLosslessDecoder
                : undefined;
        if (!factory) throw Error('Unsupported WMA tag');
        const accelerated = options.wasm === false ? null : factory(codec);
        this.accelerated = !!accelerated;
        this.audio =
          accelerated ??
          (codec.codec === 0x161
            ? new WmaStandardDecoder(codec)
            : codec.codec === 0x162
              ? new WmaProDecoder(codec)
              : new WmaLosslessDecoder(codec));
      }
    } catch (cause) {
      throw Error(`Unsupported Windows Media ${codec.kind} codec 0x${codec.codec.toString(16)}`, {
        cause,
      });
    }
  }

  /** Decodes one complete media object. `null` drains delayed output; repeated
   * drains are empty, while submitting another nonempty object is an error. */
  decode(
    data: Uint8Array | null,
    time = 0,
    _key = false,
  ): (WindowsMediaPicture | WindowsMediaAudio)[] {
    if (this.closed) throw Error('Windows Media decoder is closed');
    if (data?.length === 0) return [];
    if (this.drained) {
      if (data) throw Error('Windows Media decode error -541478725');
      return [];
    }
    if (!data) this.drained = true;
    // The original bridge passes packet PTS through a signed 32-bit ABI.
    time |= 0;
    try {
      if (this.audio) return this.audio.decode(data, time);
      const video = this.video!,
        out: WindowsMediaPicture[] = [];
      do {
        const picture = video.decode(data, time);
        if (!picture) break;
        const width = video.width,
          height = video.height,
          frame = allocateFrame(width, height);
        for (let plane = 0; plane < 3; plane++) {
          const target = plane === 0 ? frame.y : plane === 1 ? frame.cb : frame.cr,
            source = plane === 0 ? picture.y : plane === 1 ? picture.cb : picture.cr,
            stride = plane ? picture.chromaStride : picture.stride,
            targetStride = plane ? frame.stride >> 1 : frame.stride,
            w = plane ? (width + 1) >> 1 : width,
            rows = plane ? (height + 1) >> 1 : height;
          for (let y = 0; y < rows; y++)
            target.set(source.subarray(y * stride, y * stride + w), y * targetStride);
        }
        frame.index = this.index++;
        frame.pictureType = picture.type;
        out.push({frame, time: picture.time});
      } while (data === null);
      return out;
    } catch (cause) {
      const code = cause instanceof Vc1Error ? cause.code : -1094995529;
      throw Error('Windows Media decode error ' + code, {cause});
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.audio?.close();
    this.audio = undefined;
    this.video = undefined;
  }
}

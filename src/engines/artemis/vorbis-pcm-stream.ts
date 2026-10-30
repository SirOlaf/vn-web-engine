import {VorbisChunkDecoder, VorbisDecodeError} from '../../audio/vorbis-codec.js';
import type {SseRounding} from '../../core/sse-integer.js';
import {artemisVorbisPcm16} from './vorbis-pcm.js';
import {artemisRevision} from './revision.js';

export interface ArtemisVorbisStreamOptions {
  readonly hash: string;
  readonly rounding: SseRounding;
  /** Frames of the first PCM batch; later batches hold at least `chunkFrames`. */
  readonly firstFrames: number;
  readonly chunkFrames: number;
}
export type ArtemisVorbisStreamInput =
  /** Loads the codec ahead of the first stream; a failure surfaces when a stream opens. */
  | {readonly kind: 'warm'}
  | {readonly kind: 'open'; readonly options: ArtemisVorbisStreamOptions}
  | {readonly kind: 'bytes'; readonly bytes: Uint8Array; readonly last: boolean};
export type ArtemisVorbisStreamOutput =
  | {readonly kind: 'open'; readonly sampleRate: number; readonly channels: number}
  /** Little-endian interleaved PCM16, in order. */
  | {readonly kind: 'pcm'; readonly bytes: Uint8Array}
  | {readonly kind: 'done'}
  | {readonly kind: 'error'; readonly message: string; readonly encodedDataError: boolean};

/**
 * Decodes one Ogg Vorbis file whose bytes arrive in order and reports Rev.3179 PCM16
 * (`artemisVorbisPcm16`) as it is decoded. The concatenated PCM equals the eager
 * `decodeArtemisVorbisBytes` result: frames past the EOS granule are withheld once the last
 * page is read, before its packets decode. Runs in a worker or, without workers, in-thread.
 */
export class ArtemisVorbisPcmChunks {
  private readonly decoder: VorbisChunkDecoder;
  private emitted = 0;
  private sampleRate = 0;
  private failed = false;
  constructor(
    private readonly options: ArtemisVorbisStreamOptions,
    private readonly send: (output: ArtemisVorbisStreamOutput) => void,
  ) {
    artemisRevision(options.hash);
    this.decoder = new VorbisChunkDecoder(options.firstFrames, options.chunkFrames, {
      onOpen: ({sampleRate, channels}) => {
        this.sampleRate = sampleRate;
        send({kind: 'open', sampleRate, channels});
      },
      onChunk: (planes, frames) => {
        const limit = this.decoder.finalGranule ?? Infinity,
          count = Math.max(0, Math.min(frames, limit - this.emitted));
        if (count === 0) return;
        this.emitted += count;
        send({
          kind: 'pcm',
          bytes: artemisVorbisPcm16(
            options.hash,
            {
              sampleRate: this.sampleRate,
              frames: count,
              planes: planes.map((plane) => plane.subarray(0, count)),
            },
            options.rounding,
          ),
        });
      },
    });
  }
  async push(bytes: Uint8Array, last: boolean): Promise<void> {
    if (this.failed) return;
    try {
      await this.decoder.push(bytes, last);
      if (!last) return;
      this.decoder.finish();
      this.decoder.free();
      this.send({kind: 'done'});
    } catch (error) {
      this.failed = true;
      this.decoder.free();
      this.send({
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
        encodedDataError: error instanceof VorbisDecodeError,
      });
    }
  }
  close(): void {
    this.failed = true;
    this.decoder.free();
  }
}

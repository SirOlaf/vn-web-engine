import {WorkerPool} from '../../platform/worker-pool.js';
import {sseInt32, type SseRounding} from '../../core/sse-integer.js';
import {
  decodeArtemisVorbisBytes,
  type ArtemisVorbisRequest,
  type ArtemisVorbisResponse,
} from './vorbis-byte-decode.js';
import type {ArtemisVorbisBytes} from './vorbis-source.js';
import {artemisRevision} from './revision.js';

/** Actual reusable codec workers; rounding is an explicit installation policy. */
export class ArtemisVorbisPcmDecoder {
  private pool: WorkerPool<ArtemisVorbisRequest, ArtemisVorbisResponse> | undefined;
  private closed = false;
  constructor(
    private readonly hash: string,
    private readonly rounding: SseRounding,
  ) {
    artemisRevision(hash);
    sseInt32(0, rounding);
  }
  async decode(bytes: Uint8Array): Promise<ArtemisVorbisBytes | null> {
    if (this.closed) throw Error('Artemis Vorbis decoder closed');
    const request = {hash: this.hash, rounding: this.rounding, bytes: bytes.slice()};
    if (typeof Worker === 'undefined') {
      const pcm = await decodeArtemisVorbisBytes(request);
      if (this.closed) throw Error('Artemis Vorbis decoder closed during decode');
      return pcm;
    }
    this.pool ??= new WorkerPool(
      () => new Worker(new URL('./vorbis-pcm-worker.js', import.meta.url), {type: 'module'}),
    );
    const response = await this.pool.run(request, [request.bytes.buffer]);
    if (this.closed) throw Error('Artemis Vorbis decoder closed during decode');
    if (!response) throw Error('Artemis Vorbis PCM worker failed');
    if ('error' in response) throw Error(response.error);
    return response.pcm;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pool?.terminate();
  }
}

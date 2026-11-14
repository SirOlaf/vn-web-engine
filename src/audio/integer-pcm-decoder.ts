import {WorkerPool} from '../platform/worker-pool.js';
import {
  integerPcmClip,
  type IntegerPcmFormat,
  type IntegerPcmRequest,
  type IntegerPcmResponse,
} from './integer-pcm-codec.js';
import type {PcmClip} from './pcm.js';

/** Owned reusable workers for 8/16-bit PCM. No audio context or device is opened. */
export class IntegerPcmDecoder {
  private closed = false;
  private pool: WorkerPool<IntegerPcmRequest, IntegerPcmResponse> | undefined;
  async decode(bytes: Uint8Array, format: IntegerPcmFormat): Promise<PcmClip> {
    if (this.closed) throw Error('Integer PCM decoder closed');
    const request = {bytes: bytes.slice(), format: {...format}};
    if (typeof Worker === 'undefined') return integerPcmClip(request);
    this.pool ??= new WorkerPool(
      () => new Worker(new URL('./integer-pcm-worker.js', import.meta.url), {type: 'module'}),
    );
    const response = await this.pool.run(request, [request.bytes.buffer]);
    if (this.closed) throw Error('Integer PCM decoder closed during decode');
    if (!response) throw Error('Integer PCM worker failed');
    if ('error' in response) throw Error(response.error);
    return response.clip;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pool?.terminate();
  }
}

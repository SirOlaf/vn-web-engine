import type {PcmClip} from './pcm.js';
import type {AudioResponse, AudioSource} from './worker-protocol.js';

/** Worker ownership for engine playback; decoding never blocks the UI thread. */
export class HcaWorkerDecoder {
  private disposed = false;
  private readonly pending = new Map<Worker, (error: Error) => void>();
  decode(source: AudioSource): Promise<PcmClip> {
    if (this.disposed) return Promise.reject(new Error('Audio decoder is disposed'));
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./decode-worker.js', import.meta.url), {type: 'module'});
      const cleanup = () => {
        this.pending.delete(worker);
        worker.terminate();
      };
      const fail = (error: Error) => {
        cleanup();
        reject(error);
      };
      this.pending.set(worker, fail);
      worker.onerror = (event) => fail(new Error(event.message || 'Audio worker failed'));
      worker.onmessage = (event: MessageEvent<AudioResponse>) => {
        const data = event.data;
        if (data.type === 'error') fail(new Error(data.message));
        else if (data.type === 'complete') {
          cleanup();
          resolve(data.clip);
        }
      };
      try {
        worker.postMessage({type: 'decode', source});
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  dispose(): void {
    this.disposed = true;
    for (const fail of this.pending.values())
      fail(new Error('Audio decoder disposed during loading'));
  }
}

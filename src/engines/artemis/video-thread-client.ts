import type {ArtemisTheoraThreadOpener} from './video.js';
import type {ArtemisTheoraThreadRequest, ArtemisTheoraThreadResponse} from './video-thread.js';

export interface ArtemisTheoraThreadWorkerHost {
  onmessage: ((event: MessageEvent<ArtemisTheoraThreadResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(value: ArtemisTheoraThreadRequest, transfers: Transferable[]): void;
  terminate(): void;
}

/** Decode threads of each video in its own worker (`video-thread-worker.ts`), so Theora
 * decoding and conversion leave the main thread. One request is in flight at a time: the
 * open, then each new target. Until its answer arrives `settle` reports the threads busy;
 * the answer's picture is copied into the video surface and its buffer goes back to the
 * worker with the next target. */
export function workerTheoraThreads(
  createWorker: () => ArtemisTheoraThreadWorkerHost = () =>
    new Worker(new URL('./video-thread-worker.js', import.meta.url), {type: 'module'}),
): ArtemisTheoraThreadOpener {
  return (main, loop, mask) => {
    const worker = createWorker();
    let pending = true,
      failure: string | null = null,
      state: Extract<ArtemisTheoraThreadResponse, {type: 'state'}> | null = null,
      spare: ArrayBuffer | null = null;
    worker.onmessage = ({data}) => {
      pending = false;
      if (data.type === 'error') failure = data.message;
      else state = data;
    };
    worker.onerror = (event) => {
      pending = false;
      failure = event.message || 'Artemis video worker failed';
    };
    // Copies own their storage (a Node Buffer's slice would share it).
    const copies = [new Uint8Array(main), ...(mask ? [new Uint8Array(mask)] : [])];
    try {
      worker.postMessage(
        {type: 'open', main: copies[0]!, loop, mask: copies[1] ?? null},
        copies.map((c) => c.buffer),
      );
    } catch (error) {
      worker.terminate();
      throw error;
    }
    return {
      hasMask: mask !== null,
      settle(pixels) {
        if (failure !== null) throw Error(failure);
        if (pending || !state) return null;
        const answer = state;
        let picture = false;
        if (answer.picture) {
          pixels.set(new Uint8Array(answer.picture));
          spare = answer.picture;
          picture = true;
          state = {...answer, picture: null};
        }
        return {ended: answer.ended, decoded: answer.decoded, picture};
      },
      setTarget(frame) {
        pending = true;
        const buffer = spare;
        spare = null;
        worker.postMessage({type: 'target', frame, buffer}, buffer ? [buffer] : []);
      },
      close() {
        worker.onmessage = null;
        worker.onerror = null;
        worker.terminate();
      },
    };
  };
}

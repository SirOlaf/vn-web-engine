import {openWorkerSource} from '../core/worker-source.js';
import {HcaStream} from '../formats/cri/hca/stream.js';
import type {AudioRequest, AudioResponse} from './worker-protocol.js';
// Small explicit worker interface avoids mixing DOM and WebWorker ambient libraries.
const worker = globalThis as unknown as {
  onmessage: ((event: MessageEvent<AudioRequest>) => void) | null;
  postMessage(message: AudioResponse, transfer?: Transferable[]): void;
};
worker.onmessage = async (event) => {
  try {
    if (event.data.type !== 'decode') throw new Error('Unknown audio worker request');
    const descriptor = event.data.source;
    const source = openWorkerSource(descriptor);
    const started = performance.now(),
      stream = await HcaStream.open(source);
    worker.postMessage({type: 'header', header: stream.header});
    const clip = await stream.decode({
      onProgress: (fraction) => worker.postMessage({type: 'progress', fraction}),
    });
    worker.postMessage(
      {type: 'complete', clip, elapsedMs: performance.now() - started},
      clip.channels.map((c) => c.buffer as ArrayBuffer),
    );
  } catch (error) {
    worker.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

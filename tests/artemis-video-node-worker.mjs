import {parentPort} from 'node:worker_threads';
globalThis.postMessage = (value, transfers) => parentPort.postMessage(value, transfers);
await import('../dist/engines/artemis/video-thread-worker.js');
parentPort.on('message', (data) => globalThis.onmessage({data}));

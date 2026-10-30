import {Worker} from 'node:worker_threads';
/** Node diagnostic adapter for browser worker modules and real transfers. */
export function createNodeBrowserWorker(moduleURL) {
  const raw = new Worker(new URL('./node-browser-worker-thread.mjs', import.meta.url), {
    workerData: {moduleURL: String(moduleURL)},
  });
  const host = {
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage: (data, transfers) => raw.postMessage(data, transfers),
    terminate: () => raw.terminate(),
  };
  raw.on('message', (data) => host.onmessage?.({data}));
  raw.on('error', (error) => host.onerror?.(error));
  raw.on('messageerror', (error) => host.onmessageerror?.(error));
  return host;
}

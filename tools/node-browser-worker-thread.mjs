import {parentPort, workerData} from 'node:worker_threads';
globalThis.postMessage = (value, transfers) => parentPort.postMessage(value, transfers);
globalThis.self = globalThis;
const ready = import(workerData.moduleURL);
parentPort.on('message', async (data) => {
  await ready;
  globalThis.onmessage({data});
});

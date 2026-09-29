import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker as ThreadWorker} from 'node:worker_threads';
import {decodeBurikoResource} from '../dist/engines/buriko/native/resource-decode.js';
import {setBurikoDecodeWorkersEnabled} from '../dist/engines/buriko/native/resource-decode-offload.js';
import {
  BurikoDistributedAllocator,
  BurikoDistributedProcessing,
} from '../dist/engines/buriko/native/distributed-processing.js';
import {WorkerPool} from '../dist/platform/worker-pool.js';
import {
  getRuntimePerformanceSnapshot,
  startRuntimePerformanceRecording,
  stopRuntimePerformanceRecording,
} from '../dist/platform/runtime-performance.js';
import {encode as encodeCbg, residuals, xorshift} from './buriko-cbg-fixtures.mjs';
import {encode as encodeDsc, huffmanLengths, sample} from './buriko-dsc-fixtures.mjs';

// A module Worker on a worker thread: the real worker module runs with the browser's message
// surface (onmessage, postMessage and transfer lists).
const bootstrap = `
const {parentPort, workerData} = require('node:worker_threads');
const queued = [];
let handler = null;
Object.defineProperty(globalThis, 'onmessage', {
  get: () => handler,
  set(value) {
    handler = value;
    for (const data of queued.splice(0)) handler({data});
  },
});
globalThis.postMessage = (message, transfer) => parentPort.postMessage(message, transfer);
parentPort.on('message', (data) => (handler ? handler({data}) : queued.push(data)));
import(workerData);
`;
class ModuleWorker {
  constructor(url) {
    this.thread = new ThreadWorker(bootstrap, {eval: true, workerData: url.href});
    this.thread.on('message', (data) => this.onmessage?.({data}));
    this.thread.on('error', (error) => this.onerror?.({error, preventDefault() {}}));
    // Listeners reference the thread's port, so release the thread after attaching them.
    this.thread.unref();
  }
  postMessage(message, transfer) {
    this.thread.postMessage(message, transfer);
  }
  terminate() {
    this.thread.terminate();
  }
}
globalThis.Worker = ModuleWorker;

const processing = new BurikoDistributedProcessing(new BurikoDistributedAllocator(1), 1);

/** Decodes with and without workers; returns both outcomes and the worker-applied count. */
async function decodeBoth(bytes, extent) {
  const run = async () => {
    const destination =
      extent === undefined
        ? undefined
        : {bytes: new Uint8Array(extent).fill(0xa5), initialized: new Uint8Array(extent)};
    try {
      const result = await decodeBurikoResource(bytes.slice(), processing, 0, 0, destination);
      return {
        status: result.status,
        bytes: result.bytes === null ? null : Uint8Array.from(result.bytes),
        destination,
      };
    } catch (error) {
      return {error: `${error.constructor.name}: ${error.message}`, destination};
    }
  };
  startRuntimePerformanceRecording();
  let offThread;
  try {
    offThread = await run();
  } finally {
    stopRuntimePerformanceRecording();
  }
  const applied = getRuntimePerformanceSnapshot()
    .aggregates.filter((aggregate) => /^buriko\.decode\..*\.worker-applied$/.test(aggregate.name))
    .reduce((total, aggregate) => total + aggregate.total, 0);
  setBurikoDecodeWorkersEnabled(false);
  try {
    return {offThread, inThread: await run(), applied};
  } finally {
    setBurikoDecodeWorkersEnabled(true);
  }
}

test('worker-decoded DSC and legacy CompressedBG match in-thread decoding, publication and faults', async () => {
  const random = xorshift(0x2468ace1);
  for (const depth of [8, 24, 32]) {
    const width = 700,
      height = 400,
      bytes = encodeCbg({
        width,
        height,
        depth,
        residuals: residuals(random, width * height * (depth >>> 3)),
        seed: 0x13579bdf + depth,
      }),
      extent = 16 + width * height * (depth === 24 ? 4 : depth >>> 3);
    for (const target of [undefined, extent]) {
      const {offThread, inThread, applied} = await decodeBoth(bytes, target);
      assert.equal(applied, 1, `depth ${depth} decoded by a worker`);
      assert.equal(offThread.status, 0);
      assert.deepEqual(offThread, inThread, `depth ${depth}, destination ${target}`);
    }
    // A checksum mismatch and a short destination keep their in-thread status and fault.
    const corrupt = bytes.slice();
    corrupt[44] ^= 1;
    for (const [input, target] of [
      [corrupt, extent],
      [bytes, extent - 1],
    ]) {
      const {offThread, inThread} = await decodeBoth(input, target);
      assert.deepEqual(offThread, inThread);
      assert.ok(offThread.status === 5 || offThread.error !== undefined);
    }
  }
  // A truncated bitstream fails in the worker and reruns in-thread, raising the native fault.
  const truncated = encodeCbg({
    width: 512,
    height: 512,
    depth: 32,
    residuals: residuals(random, 512 * 512 * 4),
    seed: 7,
  }).subarray(0, -64);
  const failed = await decodeBoth(truncated, 16 + 512 * 512 * 4);
  assert.equal(failed.applied, 0);
  assert.match(failed.offThread.error, /Truncated BURIKO bitstream/);
  assert.deepEqual(failed.offThread, failed.inThread);

  const dsc = encodeDsc(sample(random, 400_000), huffmanLengths(random), 0x9e3779b9);
  const {offThread, inThread, applied} = await decodeBoth(dsc.bytes);
  assert.equal(applied, 1);
  assert.deepEqual(offThread.bytes, dsc.expected);
  assert.deepEqual(offThread, inThread);
  processing.dispose();
});

test('a worker pool that cannot start workers resolves jobs as unavailable', async () => {
  const pool = new WorkerPool(() => {
    throw new Error('blocked');
  });
  assert.equal(await pool.run({}), undefined);
  assert.equal(pool.available, false);
  const failing = new WorkerPool(
    () => new ModuleWorker(new URL('data:text/javascript,throw new Error("boot")')),
  );
  assert.equal(await failing.run({}), undefined);
  assert.equal(failing.available, false);
});

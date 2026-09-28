import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoDataCodecWorkers} from '../dist/engines/buriko/native/data-codec-workers.js';
import {decodeBurikoSdcInto} from '../dist/engines/buriko/native/sdc.js';
import {BurikoStructCodecScratch} from '../dist/engines/buriko/native/struct-codec-scratch.js';
import {
  BurikoDistributedAllocator,
  BurikoDistributedProcessing,
} from '../dist/engines/buriko/native/distributed-processing.js';
import {legacyCbg, modernCbg} from './aokana-resource-direct-fixtures.mjs';
import {hostPointer} from '../dist/engines/buriko/bp/memory.js';

test('codec worker joins completed valid encodes before their source storage retires', async () => {
  const workers = new BurikoDataCodecWorkers(() => new Date(Date.UTC(2026, 8, 19, 12, 34, 56)));
  const source = new TextEncoder().encode('AB'.repeat(20));
  const firstBytes = new Uint8Array(128);
  const first = workers.startEncode(
    hostPointer(firstBytes, 0),
    hostPointer(source, 0),
    source.length,
  );
  assert.ok(first);
  await workers.joinPending();
  assert.equal(first.done, true);
  assert.equal(workers.hasPendingWork(), false);
  const firstDecoded = new Uint8Array(source.length);
  assert.equal(
    decodeBurikoSdcInto(hostPointer(firstDecoded, 0), hostPointer(firstBytes, 0)),
    source.length,
  );
  assert.deepEqual(firstDecoded, source);

  const secondBytes = new Uint8Array(128);
  const second = workers.startEncode(
    hostPointer(secondBytes, 0),
    hostPointer(source, 0),
    source.length,
  );
  assert.ok(second);
  const closing = workers.closeAndJoin();
  assert.equal(workers.closeAndJoin(), closing);
  await closing;
  assert.equal(second.done, true);
  assert.equal(workers.hasPendingWork(), false);
  const secondDecoded = new Uint8Array(source.length);
  assert.equal(
    decodeBurikoSdcInto(hostPointer(secondDecoded, 0), hostPointer(secondBytes, 0)),
    source.length,
  );
  assert.deepEqual(secondDecoded, source);
});

test('large record-table encoding services host tasks before publishing completion and closing', async () => {
  const workers = new BurikoDataCodecWorkers(() => new Date(0));
  const scratch = new BurikoStructCodecScratch();
  const size = 4096,
    count = 1024;
  const source = new Uint8Array(size * count).fill(0x41);
  const output = new Uint8Array(16384);
  const worker = workers.startStructEncode(
    hostPointer(output, 0),
    hostPointer(source, 0),
    size,
    count,
    scratch,
    {
      show() {
        assert.fail('valid record-table encoding must fit its scratch allocation');
      },
    },
  );
  assert.ok(worker);
  // Enqueued after worker startup: this can run before completion only if work yields.
  const serviced = new Promise((resolve) =>
    setTimeout(
      () =>
        resolve({
          done: worker.done,
          owner: scratch.section.owner,
        }),
      0,
    ),
  );
  const closing = workers.closeAndJoin();
  try {
    const during = await serviced;
    assert.equal(during.done, false);
    assert.equal(during.owner, worker);
    await closing;
    assert.equal(worker.done, true);
    assert.equal(workers.hasPendingWork(), false);
    assert.equal(scratch.section.owner, null);
    const expected = new Uint8Array(24 + size + 2 * (count - 1));
    expected.set(new TextEncoder().encode('DCFS FORMAT 1.00'));
    const header = new DataView(expected.buffer);
    header.setUint32(16, size, true);
    header.setUint32(20, count, true);
    expected.fill(0x41, 24, 24 + size);
    for (let i = 24 + size; i < expected.length; i += 2) expected.set([0x80, 0x20], i);
    const decoded = new Uint8Array(expected.length);
    assert.equal(
      decodeBurikoSdcInto(hostPointer(decoded, 0), hostPointer(output, 0)),
      expected.length,
    );
    assert.deepEqual(decoded, expected);
  } finally {
    await closing;
    await scratch.dispose();
  }
});

test('a released image-codec worker cannot resume writes through borrowed BP storage', async () => {
  const workers = new BurikoDataCodecWorkers();
  const processing = new BurikoDistributedProcessing(new BurikoDistributedAllocator(1), 2);
  const source = modernCbg();
  const output = new Uint8Array(272).fill(0x55);
  let worker;
  let released = false;
  worker = workers.startDecode(
    {
      view() {
        // Release at the first async continuation after the destination is borrowed.
        queueMicrotask(() => {
          if (!released) {
            released = true;
            workers.release(worker);
          }
        });
        return output;
      },
      offset: 0,
    },
    hostPointer(source, 0),
    source.length,
    processing,
  );
  await assert.rejects(workers.joinPending(), /released native record/);
  assert.equal(released, true);
  assert.equal(worker.done, false);
  assert.equal(new DataView(output.buffer).getUint16(0, true), 8);
  assert.deepEqual(Array.from(output.subarray(16, 20)), [0x55, 0x55, 0x55, 170]);
  processing.dispose();
});

test('legacy image workers service host tasks before completion and validate resumed output borrows', async (t) => {
  // Expire every host slice deterministically, independent of the machine's decode speed.
  let clock = 0;
  t.mock.method(performance, 'now', () => (clock += 5));
  const processing = new BurikoDistributedProcessing(new BurikoDistributedAllocator(1), 1);
  const source = legacyCbg();
  try {
    for (const retire of [false, true]) {
      const workers = new BurikoDataCodecWorkers();
      const output = new Uint8Array(24).fill(0x55);
      const worker = workers.startDecode(
        hostPointer(output, 0),
        hostPointer(source, 0),
        source.length,
        processing,
      );
      assert.ok(worker);
      let suspended;
      const serviced = new Promise((resolve) =>
        setTimeout(() => {
          suspended = {done: worker.done, bytes: output.slice()};
          if (retire) workers.release(worker);
          resolve();
        }, 0),
      );
      const joined = workers.joinPending();
      // Attach the rejection handler before the worker resumes.
      const completed = retire ? assert.rejects(joined, /released native record/) : joined;
      await serviced;
      assert.equal(suspended.done, false);
      assert.deepEqual(suspended.bytes.subarray(0, 16), source.subarray(16, 32));
      assert.deepEqual([...suspended.bytes.subarray(16)], Array(8).fill(0x55));
      await completed;
      if (retire) {
        assert.equal(worker.done, false);
        assert.deepEqual(output, suspended.bytes);
      } else {
        assert.equal(workers.hasPendingWork(), false);
        assert.equal(worker.done, true);
        assert.equal(worker.result, output.length);
        assert.deepEqual([...output.subarray(16)], [1, 1, 1, 0, 2, 2, 2, 0]);
      }
    }
  } finally {
    processing.dispose();
  }
});

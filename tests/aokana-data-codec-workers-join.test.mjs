import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoDataCodecWorkers} from '../dist/engines/buriko/native/data-codec-workers.js';
import {decodeBurikoSdcInto} from '../dist/engines/buriko/native/sdc.js';

test('codec worker joins completed valid encodes before their source storage retires', async () => {
  const workers = new BurikoDataCodecWorkers(() => new Date(Date.UTC(2026, 8, 19, 12, 34, 56)));
  const source = new TextEncoder().encode('AB'.repeat(20));
  const firstBytes = new Uint8Array(128);
  const first = workers.startEncode(
    {bytes: firstBytes, offset: 0},
    {bytes: source, offset: 0},
    source.length,
  );
  assert.ok(first);
  await workers.joinPending();
  assert.equal(first.done, true);
  assert.equal(workers.hasPendingWork(), false);
  const firstDecoded = new Uint8Array(source.length);
  assert.equal(
    decodeBurikoSdcInto({bytes: firstDecoded, offset: 0}, {bytes: firstBytes, offset: 0}),
    source.length,
  );
  assert.deepEqual(firstDecoded, source);

  const secondBytes = new Uint8Array(128);
  const second = workers.startEncode(
    {bytes: secondBytes, offset: 0},
    {bytes: source, offset: 0},
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
    decodeBurikoSdcInto({bytes: secondDecoded, offset: 0}, {bytes: secondBytes, offset: 0}),
    source.length,
  );
  assert.deepEqual(secondDecoded, source);
});

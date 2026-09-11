import test from 'node:test';
import assert from 'node:assert/strict';
import {runtime, literal} from './sc3-fixtures.mjs';
import {RawAssets} from '../dist/engines/mages/games/chaos-head-noah/sc3/raw-assets.js';
import {loadSystemData} from '../dist/engines/mages/games/chaos-head-noah/sc3/opcodes/system-data.js';
test('owned system data publishes only between passes and is freed on replacement', async () => {
  const vm = runtime([0, 0x31, ...literal(66), 0, 3]);
  await vm.boot();
  const s = vm.state,
    requests = [],
    raw = new RawAssets(s, {
      size: () => 3,
      read: async (bank, id) => {
        requests.push([bank, id]);
        return Uint8Array.of(7, 9, 11);
      },
    }),
    c = vm.context(0),
    origin = c.getBigUint64(0x158, true);
  const h = {
    state: s,
    context: c,
    rawAssets: raw,
    skip: (n) => c.setBigUint64(0x158, c.getBigUint64(0x158, true) + BigInt(n), true),
    expression: () => vm.expression(0),
    retry: () => {
      c.setBigUint64(0x158, origin, true);
      s.put(0x179cd24, 1);
    },
  };
  loadSystemData(h);
  assert.equal(s.get(0x17a0c80), 1);
  assert.equal(s.get(0x587230), 2048);
  const pointer = Number(s.view(0x5872c0, 8).getBigUint64(0, true));
  await raw.settle();
  assert.equal(s.get(0x587270), 1);
  assert.equal(raw.byte(pointer), undefined);
  raw.publish();
  assert.equal(s.get(0x587270), 0);
  assert.equal(s.get(0x587230), 3);
  loadSystemData(h);
  assert.equal(s.get(0x17a0c80), 0);
  assert.equal(s.view(0x17ac1b0, 8).getBigUint64(0, true), BigInt(pointer));
  assert.equal(s.view(0x5872c0, 8).getBigUint64(0, true), 0n);
  assert.equal(s.variable(0x3404 / 4), 0);
  assert.deepEqual(
    [raw.byte(pointer), raw.byte(pointer + 2), raw.byte(pointer + 3)],
    [7, 11, undefined],
  );
  c.setBigUint64(0x158, origin, true);
  s.flags[0xe7] |= 4;
  loadSystemData(h);
  assert.equal(raw.byte(pointer), undefined);
  assert.equal(s.view(0x17ac1b0, 8).getBigUint64(0, true), 0n);
  assert.equal(s.flags[0x98] & 64, 64);
  assert.deepEqual(requests, [[2, 66]]);
});

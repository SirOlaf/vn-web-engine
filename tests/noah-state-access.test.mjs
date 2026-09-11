import {test} from 'node:test';
import assert from 'node:assert/strict';
import {NoahState} from '../dist/engines/mages/games/chaos-head-noah/sc3/noah-state.js';

// Original scalar path is the independent reference, including validation order.
function originalPut(s, address, value, width = 4) {
  const v = s.view(address, width);
  if (width === 1) v.setUint8(0, value);
  else if (width === 2) v.setUint16(0, value, true);
  else if (width === 4) v.setUint32(0, value, true);
  else if (width === 8) v.setBigUint64(0, BigInt(value), true);
  else throw new Error(`Invalid state write width ${width}`);
}
const outcome = (f) => {
  try {
    return {value: f()};
  } catch (e) {
    return {error: e.constructor.name, message: e.message};
  }
};
const equalBytes = (a, b) =>
  a.regions.forEach((r, i) => assert.deepEqual(r.bytes, b.regions[i].bytes));
test('scalar access matches original views at every region boundary, width and unaligned offset', () => {
  const a = new NoahState(() => 0),
    b = new NoahState(() => 0);
  for (const r of a.regions)
    for (const width of [1, 2, 4, 8])
      for (const offset of [0, 1, 3, r.bytes.length - width, r.bytes.length - width + 1, -1]) {
        const address = r.address + offset;
        for (const value of [-1, 0, 0x12345678, 0x100000001, Number.MAX_SAFE_INTEGER]) {
          assert.deepEqual(
            outcome(() => a.put(address, value, width)),
            outcome(() => originalPut(b, address, value, width)),
          );
          assert.deepEqual(
            outcome(() => a.get(address)),
            outcome(() => b.view(address, 4).getInt32(0, true)),
          );
        }
      }
  equalBytes(a, b);
  for (const address of [NaN, Infinity, -1, 0x531000 + 0.5, 0x531000, 0x874fff])
    for (const width of [-1, 0, 0.5, 3, 9, NaN, Infinity]) {
      assert.deepEqual(
        outcome(() => a.put(address, 7, width)),
        outcome(() => originalPut(b, address, 7, width)),
      );
    }
  for (const value of [NaN, Infinity, -Infinity, 1.5])
    for (const width of [1, 2, 4, 8])
      assert.deepEqual(
        outcome(() => a.put(0x531001, value, width)),
        outcome(() => originalPut(b, 0x531001, value, width)),
      );
  equalBytes(a, b);
});
test('cached scalar views preserve external aliases, overlapping regions and replacement byte offsets', () => {
  const s = new NoahState(() => 0),
    address = 0x531003;
  s.put(address, 0x12345678);
  const alias = s.bytes(address, 8),
    view = s.view(address, 8);
  alias[0] = 0xef;
  assert.equal(s.get(address), 0x123456ef);
  s.put(address + 1, 0xabcd, 2);
  assert.equal(view.getUint16(1, true), 0xabcd);
  const first = {address, bytes: new Uint8Array(8)};
  s.regions.unshift(first);
  s.put(address, -7);
  assert.equal(s.get(address), -7);
  assert.equal(view.getUint8(0), 0xef);
  const backing = new Uint8Array(32);
  first.bytes = backing.subarray(5, 13);
  s.put(address, 0x11223344);
  assert.deepEqual([...backing.subarray(5, 9)], [0x44, 0x33, 0x22, 0x11]);
  s.regions.shift();
  assert.equal(s.get(address), view.getInt32(0, true));
});

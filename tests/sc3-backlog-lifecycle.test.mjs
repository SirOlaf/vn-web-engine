import test from 'node:test';
import assert from 'node:assert/strict';
import {NoahState} from '../dist/engines/mages/games/chaos-head-noah/sc3/noah-state.js';
import {BacklogText} from '../dist/engines/mages/games/chaos-head-noah/sc3/backlog-text.js';
import {drawGlobalWaitMarker} from '../dist/engines/mages/games/chaos-head-noah/sc3/scene-notification-draw.js';
import {drawBacklogText} from '../dist/engines/mages/games/chaos-head-noah/sc3/backlog-draw.js';
import {initializeBacklog} from '../dist/engines/mages/games/chaos-head-noah/sc3/opcodes/backlog.js';
import {recordMessageHistory} from '../dist/engines/mages/games/chaos-head-noah/sc3/opcodes/message-wait.js';

function fixture() {
  const state = new NoahState(() => 0);
  state.initialize();
  [0, 10, 10, 0, 1, 100, 0, 0, 24, 24, 600, 600, 0, 0, 32, 32, 16, 16, 8, 4, 0, 0, 0, 0].forEach(
    (n, i) => state.put(0x7fbf00 + i * 2, n, 2),
  );
  const bytes = new Uint8Array([0x81, 0x90, 0xff]);
  const backlog = new BacklogText(state, {
    byte: (a) => bytes[a - 100],
    message: () => {
      throw Error('Unexpected name');
    },
    expression: () => {
      throw Error('Unexpected expression');
    },
  });
  return {state, backlog};
}
function record(h) {
  h.state.put(0x179e680, 100, 8);
  recordMessageHistory(h, 0);
}

test('wait-marker suppression clears exactly twelve bytes and preserves the adjacent history cursor', () => {
  const {state: s} = fixture();
  for (const index of [1, 17, 399])
    for (const flags of [4, 5, 7]) {
      s.setVariable(0x2104 / 4, flags);
      s.put(0x7cb03c, 83);
      s.bytes(0x732a0c, 24).fill(0xa5);
      s.put(0x732a1c, index);
      assert.deepEqual(drawGlobalWaitMarker({state: s}), []);
      assert.equal(s.get(0x7cb03c), 0);
      assert.ok(s.bytes(0x732a10, 12).every((x) => x === 0));
      assert.equal(s.get(0x732a0c) >>> 0, 0xa5a5a5a5);
      assert.equal(s.get(0x732a1c), index);
    }
});

test('opening history then recording more lines preserves chronological metadata through both ring wraps', () => {
  const h = fixture(),
    s = h.state;
  let recorded = 0;
  // Start near the token ring boundary, then exercise metadata eviction as well.
  s.put(0x719a04, 49998);
  for (const target of [3, 8, 399, 400, 407]) {
    while (recorded < target) {
      record(h);
      recorded++;
    }
    const count = Math.min(recorded, 400),
      head = Math.max(0, recorded - 400) % 400;
    assert.equal(s.get(0x810074), count);
    assert.equal(s.get(0x73799c), head);
    assert.equal(s.get(0x732a1c), recorded % 400);
    initializeBacklog(s);
    for (let row = 0; row < count; row++) {
      const entry = (head + row) % 400,
        start = s.get(0x7cb040 + entry * 4);
      assert.equal(s.get(0x80fa30 + row * 4), entry);
      assert.equal(s.get(0x66d8e0 + entry * 4), 1, `row ${row} after ${recorded} lines`);
      assert.equal(start, (49998 + recorded - count + row) % 50000);
      assert.equal(s.view(0x6cf810 + start * 2, 2).getUint16(0, true), 400);
      assert.ok(s.get(0x7379a0 + entry * 4) > 0);
    }
    s.setVariable(0x2104 / 4, 4);
    for (let frame = 0; frame < 3; frame++) {
      drawGlobalWaitMarker(h);
      drawBacklogText(s, 255);
    }
    assert.equal(s.get(0x732a1c), recorded % 400, 'opening history changed its insertion cursor');
    s.setVariable(0x2104 / 4, 0);
  }
});

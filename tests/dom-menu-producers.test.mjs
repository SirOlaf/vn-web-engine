import test from 'node:test';
import assert from 'node:assert/strict';
import {NoahState} from '../dist/engines/mages/games/chaos-head-noah/sc3/noah-state.js';
import {
  beginTextFrame,
  collectTextFrame,
} from '../dist/engines/mages/games/chaos-head-noah/sc3/dom-text-data.js';
import {drawExtras} from '../dist/engines/mages/games/chaos-head-noah/sc3/extras-draw.js';
import {drawConfig} from '../dist/engines/mages/games/chaos-head-noah/sc3/config-draw.js';
import {drawSavePage} from '../dist/engines/mages/games/chaos-head-noah/sc3/save-menu-draw.js';
import {drawMusicRoom} from '../dist/engines/mages/games/chaos-head-noah/sc3/music-room-draw.js';
import {musicRoomTracks} from '../dist/engines/mages/games/chaos-head-noah/sc3/opcodes/music-room.js';
import {compileNativeRectangles} from '../dist/engines/mages/games/chaos-head-noah/sc3/rectangle-submit.js';
const strings = (frame) => frame.slots.map((slot) => slot.glyphs.map((g) => g.text).join(''));

test('Extras exposes decimal fields, padding and saturation without tagging baked labels', () => {
  const s = new NoahState(() => 0);
  s.put(0x5af948, 32);
  s.setVariable(0x1f44 / 4, 3723);
  s.put(0x5afac4, 42);
  s.put(0x5a9ac8, 123);
  s.put(0x5b09e4, 7);
  const draw = drawExtras(s),
    before = JSON.stringify(draw),
    frame = collectTextFrame(draw.commands);
  assert.deepEqual(strings(frame), ['  1', '02', '03', ' 42', '123', '7', '9']);
  assert.equal(frame.omit.size, 15);
  assert.ok(!frame.omit.has(draw.commands[0]));
  const digits = draw.sprites.filter((d) => d.source.y === 1266);
  assert.ok(digits.every((d) => frame.omit.has(d)));
  assert.deepEqual(
    frame.slots[0].glyphs.map((g) => g.x),
    [1522, 1548, 1574],
  );
  assert.ok(
    frame.slots.every((slot) =>
      slot.glyphs.every((g) => g.raster.texture === 149 && g.raster.source.height === 40),
    ),
  );
  assert.equal(JSON.stringify(draw), before);
  beginTextFrame(s);
  s.setVariable(0x1f44 / 4, 0xffffffff);
  const capped = collectTextFrame(drawExtras(s).commands);
  assert.deepEqual(strings(capped).slice(0, 3), ['999', '59', '59']);
  assert.deepEqual(
    capped.slots.map((x) => x.id),
    frame.slots.map((x) => x.id),
  );
});

test('Extras preserves native fixed-width truncation of oversized counters', () => {
  const s = new NoahState(() => 0);
  s.put(0x5af948, 32);
  s.put(0x5afac4, 0xffffffff);
  const frame = collectTextFrame(drawExtras(s).commands);
  assert.equal(strings(frame)[3], '295');
});

test('all Settings tabs keep baked labels and controller artwork native', () => {
  const s = new NoahState(() => 0);
  s.setVariable(0x218c / 4, 32);
  s.put(0x5b0440, 0x14020bbb8, 8);
  for (let tab = 0; tab < 5; tab++) {
    s.put(0x5b09b4, tab);
    const frame = collectTextFrame(drawConfig(s).commands);
    assert.equal(frame.slots.length, 0);
    assert.equal(frame.omit.size, 0);
  }
});

test('save numbers remain distinct across page transitions and compiled rectangles', () => {
  const s = new NoahState(() => 0);
  s.put(0x5afa84, 1);
  const vm = {
    state: s,
    dataByte: () => 255,
    messageAddress: () => 100,
    textExpression: () => {
      throw Error('Unexpected expression');
    },
  };
  const first = drawSavePage(vm, 159, 0, 8, 256),
    second = drawSavePage(vm, 159, 1, 8, 256),
    commands = [...first.commands, ...second.commands];
  const frame = collectTextFrame(commands);
  assert.deepEqual(
    strings(frame),
    Array.from({length: 16}, (_, i) => String(i + 1).padStart(3, '0')),
  );
  assert.equal(new Set(frame.slots.map((s) => s.id)).size, 16);
  assert.equal(frame.omit.size, 48);
  const base = 0x1d1b200 + 159 * 0x1b0;
  s.put(base + 0x32, 1, 1);
  s.put(base + 0x76, 2048, 2);
  s.put(base + 0x78, 2048, 2);
  const compiled = compileNativeRectangles(s, commands),
    after = collectTextFrame(compiled);
  assert.deepEqual(strings(after), strings(frame));
  assert.equal(after.omit.size, 48);
  assert.ok(
    after.slots.every((slot) =>
      slot.glyphs.every((g) => g.raster.texture === 159 && g.raster.source.y === 1276),
    ),
  );
  s.put(0x5afa84, 2); // Keep records in range via quick-save indirection.
  const invalid = collectTextFrame(drawSavePage(vm, 159, 99, 16, 256).commands);
  assert.ok(invalid.slots.every((slot) => slot.glyphs.some((g) => g.text === undefined)));
  assert.equal(invalid.omit.size, 0);
});

test('music labels pair native offset passes through both direct and surface-206 presentation', () => {
  for (const fade of [32, 16]) {
    const s = new NoahState(() => 0);
    s.setVariable(0x218c / 4, fade);
    s.put(0x5451e8, 410);
    s.put(0x5451c0, 286);
    s.bytes(0x5425b0, 3).set([128, 11, 255]);
    for (let i = 0; i < 12; i++) s.bytes(0x17acbd0 + musicRoomTracks[i], 1)[0] = i % 2;
    const vm = {
      state: s,
      dataByte: (a) => (a === 100 ? 128 : a === 101 ? 11 : a === 102 ? 255 : 0),
      messageAddress: () => 100,
      textExpression: () => {
        throw Error('Unexpected expression');
      },
    };
    const draw = drawMusicRoom(vm),
      before = JSON.stringify(draw),
      frame = collectTextFrame(draw.commands);
    assert.equal(frame.slots.length, 31); // title + 12 numbers + 6 locked + 12 unlocked labels
    const paired = frame.slots.filter((slot) => slot.glyphs[0].shadows?.length);
    assert.equal(paired.length, 19);
    assert.ok(paired.every((slot) => slot.glyphs.length === 1 && slot.glyphs[0].text === 'A'));
    for (const slot of paired) {
      const g = slot.glyphs[0];
      assert.deepEqual(g.shadows, [
        {x: 1.5, y: 1.5, color: 0x5c3ab4, alpha: fade === 32 ? 128 : (128 * 128) / 255},
      ]);
    }
    assert.equal(JSON.stringify(draw), before);
  }
});

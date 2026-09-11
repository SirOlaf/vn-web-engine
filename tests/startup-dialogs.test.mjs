import test from 'node:test';
import assert from 'node:assert/strict';
import {runtime} from './sc3-fixtures.mjs';
import {BitmapFont} from '../dist/graphics/bitmap-font.js';
import {MessageBoxes} from '../dist/engines/mages/games/chaos-head-noah/sc3/message-boxes.js';
import {NoahState} from '../dist/engines/mages/games/chaos-head-noah/sc3/noah-state.js';
test('dialog fade retries retain PC and context result until native counter reaches its endpoint', async () => {
  const vm = runtime([0, 67, 6, 0, 3]);
  await vm.boot();
  vm.context(0).setInt32(0x1c, 77, true);
  for (let n = 1; n <= 32; n++) {
    assert.equal(vm.runContext(0, 1), 'yield');
    assert.equal(vm.pc(0), 16);
    assert.equal(vm.state.variable(0xcfe), n);
  }
  assert.equal(vm.runContext(0, 1), 'budget');
  assert.equal(vm.pc(0), 19);
  assert.equal(vm.context(0).getInt32(0x1c, true), 77);
});
test('native dialog measurement stall faults explicitly rather than dropping an unsupported control', () => {
  const state = new NoahState(() => 0),
    box = new MessageBoxes(state, {
      byte: () => 0,
      expression: () => {
        throw Error('unused');
      },
      hit: () => false,
      sound: () => {},
    });
  assert.throws(() => box.measure(0), /cannot advance/);
});
test('cross-region clears validate the entire span before mutating and preserve surrounding bytes', () => {
  const s = new NoahState(() => 0);
  s.bytes(0x874ffc, 4).fill(1);
  s.bytes(0x875000, 4).fill(2);
  s.zero(0x874ffe, 4);
  assert.deepEqual([...s.bytes(0x874ffc, 4)], [1, 1, 0, 0]);
  assert.deepEqual([...s.bytes(0x875000, 4)], [0, 0, 2, 2]);
  const end = 0x176e528 + 8;
  s.bytes(end - 4, 4).fill(9);
  assert.throws(() => s.zero(end - 2, 4), /Unmapped/);
  assert.deepEqual([...s.bytes(end - 4, 4)], [9, 9, 9, 9]);
});
test('glyph cropping respects atlas rows, alpha, caching and invalid source bounds', () => {
  const image = {
    width: 3,
    height: 2,
    pixels: Uint8Array.from([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255, 255, 0, 255, 255, 0, 255,
      255, 255,
    ]),
  };
  const font = new BitmapFont(image),
    r = {x: 1, y: 0, width: 2, height: 2},
    glyph = font.glyph(r);
  assert.deepEqual(
    [...glyph.straightPixels()],
    [0, 255, 0, 255, 0, 0, 255, 255, 255, 0, 255, 255, 0, 255, 255, 255],
  );
  assert.equal(font.glyph(r), glyph);
  assert.throws(() => font.glyph({...r, x: 2}), /outside/);
  font.dispose();
  assert.throws(() => glyph.pixels, /disposed/);
  assert.throws(() => new BitmapFont({...image, pixels: new Uint8Array(0)}), /Invalid/);
});

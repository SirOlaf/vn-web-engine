import test from 'node:test';
import assert from 'node:assert/strict';
import {blendSprite} from '../dist/engines/rscript/graphics/blend.js';
import {filterLayerImage} from '../dist/engines/rscript/graphics/filters.js';
import {createSurface} from '../dist/engines/rscript/graphics/pixels.js';
import {RScriptScreen, RScriptSprite} from '../dist/engines/rscript/graphics/sprite.js';

test('RScript blending mixes by transparency and applies fade and tone tables', () => {
  const pixel = (surface) => surface.data[0] >>> 0;
  const draw = (source, target, state) => {
    blendSprite(
      target,
      source,
      0,
      0,
      {left: 0, top: 0, right: 1, bottom: 1},
      {
        mode: 0,
        alpha: 0,
        mask: 0,
        maskLevel: 0,
        color: 0,
        ...state,
      },
    );
    return pixel(target);
  };
  // Mode 0 mixes by the source transparency byte; 0xFF is invisible.
  assert.equal(draw(createSurface(1, 1, 0x80ffffff), createSurface(1, 1)), 0x7f7f7f);
  assert.equal(draw(createSurface(1, 1, 0xff123456), createSurface(1, 1, 0x654321)), 0x654321);
  // Mode 2 uses the global level as a transparency floor.
  assert.equal(
    draw(createSurface(1, 1, 0x00ffffff), createSurface(1, 1), {mode: 2, alpha: 128}),
    0x7f7f7f,
  );
  // Mode 3 darkens the source by the level before mixing; mode 4 brightens it.
  assert.equal(
    draw(createSurface(1, 1, 0x00808080), createSurface(1, 1), {mode: 3, alpha: 128}),
    0x404040,
  );
  assert.equal(
    draw(createSurface(1, 1, 0x00000000), createSurface(1, 1), {mode: 4, alpha: 128}),
    0x808080,
  );
});

test('RScript sprite trees draw in priority order and redraw only dirty areas', () => {
  const screen = new RScriptScreen(4, 2);
  const back = new RScriptSprite(),
    front = new RScriptSprite();
  back.setSurface(createSurface(4, 2, 0x0000ff));
  front.setSurface(createSurface(2, 2, 0x00ff00));
  screen.add(front, 2);
  screen.add(back, 1);
  back.show(true);
  front.show(true);
  assert.deepEqual(screen.render(), {left: 0, top: 0, right: 4, bottom: 2});
  assert.deepEqual(
    [...screen.surface.data.subarray(0, 4)],
    [0x00ff00, 0x00ff00, 0x0000ff, 0x0000ff],
  );
  front.setPosition(2, 0);
  assert.deepEqual(screen.render(), {left: 0, top: 0, right: 4, bottom: 2});
  assert.deepEqual(
    [...screen.surface.data.subarray(0, 4)],
    [0x0000ff, 0x0000ff, 0x00ff00, 0x00ff00],
  );
  assert.equal(screen.render(), null);
  screen.setPriority(back, 3);
  screen.render();
  assert.deepEqual(
    [...screen.surface.data.subarray(0, 4)],
    [0x0000ff, 0x0000ff, 0x0000ff, 0x0000ff],
  );
});

test('RScript layer load filters recolour and keep transparency', () => {
  // B, G, R and a half transparency byte.
  const source = {width: 1, height: 1, data: Uint32Array.of(0x80_30_60_90)};
  const filtered = (flags) => filterLayerImage(source, flags).data[0] >>> 0;
  assert.equal(filtered(1), 0x80_00_00_00, 'silhouette');
  assert.equal(filtered(2), 0x80_cf_9f_6f, 'negative');
  assert.equal(filtered(3), 0x80_60_60_60, 'grey: (0x90 + 0x60 + 0x30) / 3');
  // Level 128 brightens by del row 1 and 127 darkens by add row 0: both nearly neutral.
  const neutral = {width: 1, height: 1, data: Uint32Array.of(0x00_80_80_80)};
  const sepia = filterLayerImage(neutral, 4).data[0] >>> 0;
  // A mid grey takes the tint colour almost unchanged (0x8B4513).
  assert.ok(Math.abs(((sepia >>> 16) & 0xff) - 0x8b) <= 1);
  assert.ok(Math.abs(((sepia >>> 8) & 0xff) - 0x45) <= 1);
  assert.ok(Math.abs((sepia & 0xff) - 0x13) <= 1);
  // Unknown flags leave the shared surface untouched.
  assert.equal(filterLayerImage(source, 0), source);
  assert.equal(source.data[0] >>> 0, 0x80_30_60_90);
});

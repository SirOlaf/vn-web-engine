import test from 'node:test';
import assert from 'node:assert/strict';
import {blendSprite} from '../dist/engines/rscript/graphics/blend.js';
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

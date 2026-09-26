import test from 'node:test';
import assert from 'node:assert/strict';
import {aokanaSpriteBounds} from '../dist/engines/buriko/games/aokana/native/sprite-bounds.js';

const input = {width: 4, height: 3, extraWidth: 0, centerX: 0, centerY: 0,
  angle: 0, scaleX: 65536, scaleY: 65536, phaseX: 0, phaseY: 0};

test('ordinary sprite bounds retain pivot offsets and signed Q16 corner rotation', () => {
  assert.deepEqual(aokanaSpriteBounds(input), {offsetY: 0, offsetX: 0, width: 4, height: 3});
  assert.deepEqual(aokanaSpriteBounds({...input, centerX: 2 * 65536, centerY: 65536}),
    {offsetY: 1, offsetX: 2, width: 4, height: 3});
  assert.deepEqual(aokanaSpriteBounds({...input, angle: 180 * 65536}),
    {offsetY: 2, offsetX: 3, width: 4, height: 3});
});

test('ordinary sprite bounds use distinct lower-X and upper-Y rounding after scale and phase', () => {
  assert.deepEqual(aokanaSpriteBounds({...input, width: 3, height: 3, scaleX: 32768, scaleY: 32768,
    centerX: 32768, centerY: 32768, phaseX: 32768, phaseY: 32768}),
    {offsetY: 1, offsetX: 1, width: 3, height: 3});
  assert.deepEqual(aokanaSpriteBounds({...input, width: 4, height: 2, extraWidth: 32768}),
    {offsetY: 0, offsetX: 1, width: 6, height: 2});
});

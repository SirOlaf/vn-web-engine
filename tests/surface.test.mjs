import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Surface, SurfaceTargets} from '../dist/graphics/surface.js';
const pixel = (s, x = 0, y = 0) => [
  ...s.pixels.subarray((y * s.width + x) * 4, (y * s.width + x + 1) * 4),
];
test('off-screen alpha survives repeated composition without double multiplication', () => {
  const a = new Surface(1, 1),
    b = new Surface(1, 1),
    c = new Surface(1, 1);
  a.clear([255, 0, 0, 128]);
  b.blit(a);
  c.clear([0, 0, 255, 255]);
  c.blit(b);
  assert.deepEqual(pixel(b), [128, 0, 0, 128]);
  assert.deepEqual(pixel(c), [128, 0, 127, 255]);
  assert.deepEqual([...b.straightPixels()], [255, 0, 0, 128]);
});
test('copy replaces transparent pixels while source-over preserves their destination', () => {
  const a = new Surface(1, 1),
    b = new Surface(1, 1);
  b.clear([1, 2, 3, 255]);
  b.blit(a);
  assert.deepEqual(pixel(b), [1, 2, 3, 255]);
  b.blit(a, {blend: 'copy'});
  assert.deepEqual(pixel(b), [0, 0, 0, 0]);
});
test('overlapping self-blit snapshots source pixels before any writes', () => {
  const s = new Surface(4, 1);
  s.uploadStraight(Uint8Array.from([1, 0, 0, 255, 2, 0, 0, 255, 3, 0, 0, 255, 4, 0, 0, 255]));
  s.blit(s, {
    source: {x: 0, y: 0, width: 3, height: 1},
    destination: {x: 1, y: 0, width: 3, height: 1},
    blend: 'copy',
  });
  assert.deepEqual(
    [0, 1, 2, 3].map((x) => pixel(s, x)[0]),
    [1, 1, 2, 3],
  );
});
test('clipping preserves sampling coordinates and nearest scaling uses pixel centers', () => {
  const s = new Surface(2, 1),
    d = new Surface(4, 1);
  s.uploadStraight(Uint8Array.from([255, 0, 0, 255, 0, 0, 255, 255]));
  d.blit(s, {
    destination: {x: 0, y: 0, width: 4, height: 1},
    clip: {x: 1, y: 0, width: 2, height: 1},
  });
  assert.deepEqual(
    [0, 1, 2, 3].map((x) => pixel(d, x)),
    [
      [0, 0, 0, 0],
      [255, 0, 0, 255],
      [0, 0, 255, 255],
      [0, 0, 0, 0],
    ],
  );
});
test('linear sampling, opacity, target lifetime and invalid operations are explicit', () => {
  const targets = new SurfaceTargets(),
    a = targets.create(180, 2, 1),
    b = targets.create(181, 1, 1);
  a.uploadStraight(Uint8Array.from([255, 0, 0, 255, 0, 0, 255, 255]));
  b.blit(a, {destination: {x: 0, y: 0, width: 1, height: 1}, filter: 'linear', opacity: 0.5});
  assert.deepEqual(pixel(b), [64, 0, 64, 128]);
  assert.throws(() => targets.create(180, 1, 1));
  assert.throws(() => b.blit(a, {opacity: 2}));
  targets.release(180);
  assert.throws(() => a.clear());
  assert.throws(() => targets.get(180));
  targets.dispose();
  assert.throws(() => b.pixels);
});

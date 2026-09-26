import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBitmapStorage} from '../dist/engines/buriko/native/bitmap.js';
import {BurikoBitmapCompositor} from '../dist/engines/buriko/native/bitmap-compositor.js';
import {
  burikoAlignedAffineSource,
  burikoBitmapAffineCoordinates,
  blendTransformedBurikoBitmap,
  transformBurikoBitmap,
} from '../dist/engines/buriko/native/bitmap-affine.js';
import {burikoBitmapOperationPoints} from '../dist/engines/buriko/native/bitmap-operation-jobs.js';
import {
  BurikoDistributedAllocator,
  BurikoDistributedProcessing,
} from '../dist/engines/buriko/native/distributed-processing.js';

const identity = {x: 0, y: 0, pivotX: 0, pivotY: 0, angle: 0, scaleX: 65536, scaleY: 65536};
const gray = (value) => Math.imul(value, 0x1010101) >>> 0;
function bitmap(width, height, values, format = 2, padding = 0) {
  const stride = width * 4 + padding;
  const bytes = new Uint8Array(stride * height).fill(0xa5);
  const view = new DataView(bytes.buffer);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      view.setUint32(y * stride + x * 4, values[y * width + x] ?? 0, true);
  return {
    storage: new BurikoBitmapStorage(bytes, true),
    offset: 0,
    stride,
    width,
    height,
    format,
    bytesPerPixel: 4,
  };
}
function pixels(bitmap) {
  return Array.from({length: bitmap.height}, (_, y) =>
    Array.from({length: bitmap.width}, (_, x) =>
      bitmap.storage.view.getUint32(bitmap.offset + y * bitmap.stride + x * 4, true),
    ),
  ).flat();
}

test('affine integral containment crops the actual source and retains row padding', () => {
  const compositor = new BurikoBitmapCompositor();
  const source = bitmap(
    5,
    4,
    Array.from({length: 20}, (_, i) => gray(i + 1)),
    2,
    4,
  );
  const destination = bitmap(2, 2, [0, 0, 0, 0], 2, 4);
  const transform = {...identity, x: 65536, pivotX: 2 * 65536, pivotY: 65536};
  const aligned = burikoAlignedAffineSource(destination, source, transform);
  assert.equal(aligned.storage, source.storage);
  assert.equal(aligned.offset, source.stride + 4);
  assert.equal(aligned.width, 2);
  assert.equal(aligned.height, 2);
  assert.equal(transformBurikoBitmap(compositor, destination, source, transform, 0, 1), 0);
  assert.deepEqual(pixels(destination), [7, 8, 12, 13].map(gray));
  assert.deepEqual(Array.from(destination.storage.bytes.slice(8, 12)), [165, 165, 165, 165]);
  const coordinates = burikoBitmapAffineCoordinates(identity);
  assert.deepEqual(coordinates, {
    startX: 0,
    startY: 0,
    columnX: 65536,
    columnY: 0,
    rowX: 0,
    rowY: 65536,
  });
});

test('affine nearest rotation follows the independent row and column increments', () => {
  const source = bitmap(2, 3, [1, 2, 3, 4, 5, 6].map(gray));
  const destination = bitmap(3, 2, Array(6).fill(0));
  const transform = {...identity, pivotX: 65536, angle: 90 * 65536};
  transformBurikoBitmap(new BurikoBitmapCompositor(), destination, source, transform, 0, 0);
  assert.deepEqual(pixels(destination), [2, 4, 6, 1, 3, 5].map(gray));
});

test('affine bilinear uses four-bit fractions, horizontal flooring, and zero border samples', () => {
  const compositor = new BurikoBitmapCompositor();
  const source = bitmap(2, 2, [1, 6, 12, 21].map(gray));
  const center = bitmap(1, 1, [0]);
  transformBurikoBitmap(compositor, center, source, {...identity, x: -0x8fff, y: -0x8fff}, 0, 1);
  assert.deepEqual(pixels(center), [gray(9)]);
  const destination = bitmap(3, 3, Array(9).fill(0));
  transformBurikoBitmap(compositor, destination, source, {...identity, x: 0x8000, y: 0x8000}, 0, 1);
  assert.deepEqual(pixels(destination), [0, 1, 1, 3, 9, 6, 3, 8, 5].map(gray));
});

test('affine copy dimming preserves alpha and RGB conversion supplies covered alpha', () => {
  const compositor = new BurikoBitmapCompositor();
  const transform = {...identity, x: -1};
  const input = [0x10101010, 0x20303030, 0x30505050];
  for (const sampling of [0, 1]) {
    const destination = bitmap(3, 1, [0, 0, 0]);
    transformBurikoBitmap(compositor, destination, bitmap(3, 1, input), transform, 128, sampling);
    assert.deepEqual(pixels(destination), [0x10080808, 0x20181818, 0x30282828]);
    transformBurikoBitmap(
      compositor,
      destination,
      bitmap(3, 1, input, 1),
      transform,
      128,
      sampling,
    );
    assert.deepEqual(pixels(destination), [0xff080808, 0xff181818, 0xff282828]);
  }
});

test('affine blending retains Q7 RGB and alpha-table coefficients in pair and tail pixels', () => {
  const compositor = new BurikoBitmapCompositor();
  const transform = {...identity, x: -1};
  for (const sampling of [0, 1]) {
    const destination = bitmap(3, 1, [200, 200, 200].map(gray), 1);
    blendTransformedBurikoBitmap(
      compositor,
      destination,
      bitmap(3, 1, [16, 48, 80].map(gray), 1),
      transform,
      3,
      sampling,
    );
    assert.deepEqual(pixels(destination), [17, 49, 80].map(gray));
    const alphaTarget = bitmap(3, 1, Array(3).fill(0x07282828), 1);
    const alphaSource = bitmap(3, 1, [0x00646464, 0x80c8c8c8, 0xfef0f0f0]);
    blendTransformedBurikoBitmap(compositor, alphaTarget, alphaSource, transform, 64, sampling);
    assert.deepEqual(pixels(alphaTarget), [0x07282828, 0x07646464, 0x07bebebe]);
  }
});

test('affine distributed jobs retain the real shared pool and subtract completed Q16 rows', () => {
  const processing = new BurikoDistributedProcessing(new BurikoDistributedAllocator(3), 3);
  const compositor = new BurikoBitmapCompositor();
  compositor.processing = processing;
  const source = bitmap(
    70,
    105,
    Array.from({length: 70 * 105}, (_, i) => gray((i * 13) & 255)),
  );
  const destination = bitmap(65, 101, Array(65 * 101).fill(0));
  const transform = {...identity, x: -32768, y: -32768};
  const plan = {count: 3, increment: Math.floor((101 * 65536) / 3)};
  assert.deepEqual(burikoBitmapOperationPoints([transform.x, transform.y], plan), [
    [-32768, -32768],
    [-32768, -32768 - 33 * 65536],
    [-32768, -32768 - 67 * 65536],
  ]);
  transformBurikoBitmap(compositor, destination, source, transform, 0, 0, true);
  assert.equal(compositor.processing, processing);
  assert.deepEqual(
    pixels(destination),
    Array.from({length: 65 * 101}, (_, i) =>
      gray((((Math.floor(i / 65) + 1) * 70 + (i % 65) + 1) * 13) & 255),
    ),
  );
});

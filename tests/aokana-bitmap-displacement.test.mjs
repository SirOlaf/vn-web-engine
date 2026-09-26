import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBitmapStorage} from '../dist/engines/buriko/games/aokana/native/bitmap.js';
import {AokanaBitmapCompositor} from '../dist/engines/buriko/games/aokana/native/bitmap-compositor.js';
import {displaceAokanaBitmap} from '../dist/engines/buriko/games/aokana/native/bitmap-displacement.js';

const gray = (value) => Math.imul(value, 0x1010101) >>> 0;
function bitmap(width, height, values, format = 2, padding = 4) {
  const stride = width * 4 + padding;
  const bytes = new Uint8Array(stride * height).fill(0xa5);
  const view = new DataView(bytes.buffer);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      view.setUint32(y * stride + x * 4, values[y * width + x] ?? 0, true);
  return {
    storage: new AokanaBitmapStorage(bytes, true),
    offset: 0,
    stride,
    width,
    height,
    format,
    bytesPerPixel: 4,
  };
}
function map(width, height, points) {
  const stride = width * 6 + 2;
  const bytes = new Uint8Array(stride * height).fill(0xa5);
  const view = new DataView(bytes.buffer);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const [dx, dy, index = 0] = points[y * width + x];
      const offset = y * stride + x * 6;
      view.setInt16(offset, dx, true);
      view.setInt16(offset + 2, dy, true);
      view.setUint16(offset + 4, index, true);
    }
  return {
    storage: new AokanaBitmapStorage(bytes, true),
    offset: 0,
    stride,
    width,
    height,
    format: 6,
    bytesPerPixel: 6,
  };
}
function pixels(bitmap) {
  return Array.from({length: bitmap.height}, (_, y) =>
    Array.from({length: bitmap.width}, (_, x) =>
      bitmap.storage.view.getUint32(y * bitmap.stride + x * 4, true),
    ),
  ).flat();
}

test('displacement nearest rounds signed products before pair and tail sampling', () => {
  const compositor = new AokanaBitmapCompositor();
  compositor.filterProperty = 1;
  const source = bitmap(3, 3, [0, 16, 32, 64, 80, 96, 128, 144, 160].map(gray));
  const table = Uint32Array.of(0x40004000);
  const output = bitmap(3, 3, []);
  assert.equal(
    displaceAokanaBitmap(
      compositor,
      output,
      source,
      source,
      map(3, 3, Array(9).fill([2, 2])),
      table,
      0,
    ),
    0,
  );
  assert.deepEqual(pixels(output), [80, 96, 0, 144, 160, 0, 0, 0, 0].map(gray));
  displaceAokanaBitmap(
    compositor,
    output,
    source,
    source,
    map(3, 3, Array(9).fill([-2, -2])),
    table,
    0,
  );
  assert.deepEqual(pixels(output), pixels(source));
});

test('displacement bilinear retains Q4 horizontal-then-vertical flooring and zero border samples', () => {
  const compositor = new AokanaBitmapCompositor();
  compositor.filterProperty = 1;
  for (const format of [1, 2]) {
    const source = bitmap(3, 3, [0, 16, 32, 64, 80, 96, 128, 144, 160].map(gray), format);
    const output = bitmap(3, 3, [], format);
    assert.equal(
      displaceAokanaBitmap(
        compositor,
        output,
        source,
        source,
        map(3, 3, Array(9).fill([2, 2])),
        Uint32Array.of(0x40004000),
        1,
      ),
      0,
    );
    assert.deepEqual(pixels(output), [40, 56, 32, 104, 120, 64, 68, 76, 40].map(gray));
    for (let row = 0; row < 3; row++)
      assert.deepEqual(
        Array.from(output.storage.bytes.slice(row * output.stride + 12, (row + 1) * output.stride)),
        [165, 165, 165, 165],
      );
  }
});

test('displacement uses the real full-image descriptor around its cropped source pointer', () => {
  const compositor = new AokanaBitmapCompositor();
  compositor.filterProperty = 1;
  const full = bitmap(
    5,
    4,
    Array.from({length: 20}, (_, index) => gray(index + 1)),
  );
  const source = {...full, offset: full.stride + 4, width: 3, height: 2};
  const output = bitmap(3, 2, []);
  for (const bilinear of [0, 1]) {
    displaceAokanaBitmap(
      compositor,
      output,
      source,
      full,
      map(3, 2, Array(6).fill([4, 0])),
      Uint32Array.of(0x40004000),
      bilinear,
    );
    assert.deepEqual(pixels(output), [8, 9, 10, 13, 14, 15].map(gray));
  }
});

test('displacement shares the compositor property selecting rectangular or linear source spans', () => {
  const compositor = new AokanaBitmapCompositor();
  const full = bitmap(4, 2, [1, 2, 3, 4, 5, 6, 7, 8].map(gray), 2, 0);
  const source = {...full, offset: 4, width: 3, height: 1};
  const output = bitmap(3, 1, []),
    displacement = map(3, 1, [
      [0, 0],
      [0, 0],
      [4, 0],
    ]);
  for (const bilinear of [0, 1]) {
    compositor.filterProperty = 1;
    displaceAokanaBitmap(
      compositor,
      output,
      source,
      full,
      displacement,
      Uint32Array.of(0x40004000),
      bilinear,
    );
    assert.deepEqual(pixels(output), [2, 3, 0].map(gray));
    compositor.filterProperty = 0;
    displaceAokanaBitmap(
      compositor,
      output,
      source,
      full,
      displacement,
      Uint32Array.of(0x40004000),
      bilinear,
    );
    assert.deepEqual(pixels(output), [2, 3, 5].map(gray));
  }
});

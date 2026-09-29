import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBitmapStorage} from '../dist/engines/buriko/native/bitmap.js';
import {
  blendBurikoAlpha,
  blendBurikoAlphaWithTransparency,
  burikoAlphaPairPixel,
  burikoAlphaTailPixel,
} from '../dist/engines/buriko/native/bitmap-alpha.js';
import {tryBurikoBitmapRgbaWasm} from '../dist/engines/buriko/native/bitmap-alpha-wasm.js';
import {setBurikoBitmapResidencyEnabled} from '../dist/engines/buriko/native/bitmap-resident.js';

let seed = 0x1b873593;
const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
const alphas = [0, 0, 0, 1, 2, 127, 128, 200, 253, 254, 255, 255, 255];

/** A padded crop of generated RGBA pixels, resident or in an ordinary buffer. */
function bitmap(width, height, resident, padding = 3) {
  const stride = (width + padding) * 4,
    offset = stride * 2 + 8,
    length = offset + stride * height + 16;
  const storage = resident
    ? BurikoBitmapStorage.allocate(length, true)
    : new BurikoBitmapStorage(new Uint8Array(length), true);
  const view = storage.view;
  // Runs of one alpha, like glyph interiors and margins, exercise whole-group fast paths.
  let run = 0,
    alpha = 0;
  for (let index = 0; index < length >>> 2; index++) {
    if (run === 0) {
      run = 1 + (random() % 12);
      alpha = random() % 3 === 0 ? -1 : alphas[random() % alphas.length];
    }
    run--;
    const value = alpha < 0 ? alphas[random() % alphas.length] : alpha;
    view.setUint32(index * 4, ((random() & 0xffffff) | (value << 24)) >>> 0, true);
  }
  return {storage, offset, stride, width, height, format: 2, bytesPerPixel: 4};
}

/** The checked per-pixel traversal of blendBurikoAlpha(WithTransparency). */
function reference(destination, source, weight, opaque) {
  const input = source.storage.view,
    output = destination.storage.view;
  for (let y = 0; y < source.height; y++) {
    const from = source.offset + y * source.stride,
      to = destination.offset + y * destination.stride;
    let x = 0;
    for (; x + 1 < source.width; x += 2) {
      const first = input.getUint32(from + x * 4, true),
        second = input.getUint32(from + x * 4 + 4, true);
      if (first >>> 24 === 0 && second >>> 24 === 0) continue;
      if (opaque && first >>> 24 === 255 && second >>> 24 === 255) {
        output.setUint32(to + x * 4, first, true);
        output.setUint32(to + x * 4 + 4, second, true);
        continue;
      }
      const oldFirst = output.getUint32(to + x * 4, true),
        oldSecond = output.getUint32(to + x * 4 + 4, true);
      output.setUint32(to + x * 4, burikoAlphaPairPixel(first, oldFirst, weight), true);
      output.setUint32(to + x * 4 + 4, burikoAlphaPairPixel(second, oldSecond, weight), true);
    }
    if (x < source.width) {
      const pixel = input.getUint32(from + x * 4, true);
      if (pixel >>> 24 !== 0)
        output.setUint32(
          to + x * 4,
          opaque && pixel >>> 24 === 255
            ? pixel
            : burikoAlphaTailPixel(pixel, output.getUint32(to + x * 4, true), weight),
          true,
        );
    }
  }
}

test('WebAssembly RGBA-over-RGBA blending matches the checked TypeScript traversal', () => {
  setBurikoBitmapResidencyEnabled(true);
  // Resident planes blend in place, ordinary ones are staged, and a small ordinary source
  // (a glyph) is copied into resident scratch beside a resident destination.
  for (const residency of ['resident', 'staged', 'scratch'])
    for (const [weight, opaque] of [
      [0, true],
      [0, false],
      [1, false],
      [64, false],
      [128, false],
      [200, false],
      [255, false],
    ])
      for (const [width, height] of [
        [151, 40],
        [256, 9],
        [41, 63],
        [9, 8],
      ]) {
        if (residency === 'staged' && (width * height < 1024 || width < 128)) continue;
        const source = bitmap(width, height, residency === 'resident'),
          destination = bitmap(width, height, residency !== 'staged', 600),
          expected = bitmap(width, height, false, 600);
        expected.storage.bytes.set(destination.storage.bytes);
        const label = `${residency} ${weight} ${opaque} ${width}x${height}`;
        assert.equal(
          tryBurikoBitmapRgbaWasm(
            destination,
            source,
            destination.storage.view,
            source.storage.view,
            width,
            height,
            weight,
            opaque,
          ),
          true,
          label,
        );
        reference(expected, source, weight, opaque);
        assert.deepEqual(destination.storage.bytes, expected.storage.bytes, label);
      }
});

test('the wrapped RGBA kernels take the WebAssembly path with identical results', () => {
  for (const [kernel, weight, opaque] of [
    [(d, s) => blendBurikoAlpha(d, s), 0, true],
    [(d, s) => blendBurikoAlphaWithTransparency(d, s, 90), 90, false],
  ]) {
    const source = bitmap(200, 30, true),
      destination = bitmap(200, 30, true),
      expected = bitmap(200, 30, false);
    expected.storage.bytes.set(destination.storage.bytes);
    kernel(destination, source);
    reference(expected, source, weight, opaque);
    assert.deepEqual(destination.storage.bytes, expected.storage.bytes);
  }
  // Weight 256 stays in JavaScript: its tail may divide by zero.
  const source = bitmap(64, 20, true),
    destination = bitmap(64, 20, true);
  assert.equal(
    tryBurikoBitmapRgbaWasm(
      destination,
      source,
      destination.storage.view,
      source.storage.view,
      64,
      20,
      256,
      false,
    ),
    false,
  );
});

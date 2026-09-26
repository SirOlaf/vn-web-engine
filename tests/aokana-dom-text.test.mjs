import {blendBurikoAlphaWithTransparency} from '../dist/engines/buriko/native/bitmap-alpha.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allocateBurikoBitmap,
  cropBurikoBitmap,
  fillBurikoBitmap,
} from '../dist/engines/buriko/native/bitmap.js';
import {clearBurikoBitmap} from '../dist/engines/buriko/native/bitmap-copy.js';
import {BurikoBitmapCompositor} from '../dist/engines/buriko/native/bitmap-compositor.js';
import {
  recordRasterText,
  readRasterText,
  rasterTextBitmap,
  visibleRasterText,
} from '../dist/text/raster-text.js';
import {rasterTextSlots} from '../dist/text/browser-raster-text.js';
import {slotText} from '../dist/text/glyph-slots.js';

const compositor = new BurikoBitmapCompositor();
const bitmap = (w, h, color = 0, format = 1) => {
  const value = allocateBurikoBitmap(w, h, format);
  fillBurikoBitmap(value, color);
  return value;
};
const glyph = (text) => {
  const value = bitmap(4, 8, 0xffffff);
  recordRasterText(value, text, {size: 8, width: 4});
  return value;
};

test('raster text survives offscreen composition, clipping, snapshots and scrolling without changing native bytes', () => {
  const a = glyph('A'),
    b = glyph('B'),
    surface = bitmap(24, 24),
    reference = bitmap(24, 24);
  // A native-only copy provides the same pixel inputs without presentation provenance.
  const nativeGlyph = {...a, storage: new a.storage.constructor(a.storage.bytes.slice(), true)};
  compositor.draw(surface, 4, 8, a, 0, 0);
  compositor.draw(surface, 8, 8, b, 0, 0);
  compositor.draw(reference, 4, 8, nativeGlyph, 0, 0);
  compositor.draw(reference, 8, 8, nativeGlyph, 0, 0);
  assert.deepEqual(surface.storage.bytes, reference.storage.bytes);
  assert.equal(slotText(rasterTextSlots(readRasterText(surface))[0].slot).text, 'AB');
  assert.ok(rasterTextBitmap(surface).storage.bytes.every((v) => v === 0));
  const snapshot = {
    ...surface,
    storage: surface.storage.cloneRange(0, surface.storage.bytes.length),
  };
  const input = {...snapshot};
  cropBurikoBitmap(input, {left: 4, top: 8, right: 11, bottom: 15});
  compositor.draw(surface, 0, 0, input, 0x80, 0);
  assert.equal(
    readRasterText(surface)
      .filter((g) => g.y === 0)
      .map((g) => g.text)
      .join(''),
    'AB',
  );
  clearBurikoBitmap(surface, {left: 0, top: 0, right: 7, bottom: 7});
  assert.equal(
    readRasterText(surface).some((g) => g.y === 0),
    false,
  );
  surface.storage.release();
  assert.equal(readRasterText(surface).length, 0);
  assert.equal(
    readRasterText(snapshot)
      .map((g) => g.text)
      .join(''),
    'AB',
  );
  assert.deepEqual(snapshot.storage.bytes, reference.storage.bytes);
});

test('partial damage and opaque overlays keep only visible semantic text, and full clears retire it', () => {
  const surface = bitmap(12, 8),
    a = glyph('A');
  compositor.draw(surface, 0, 0, a, 0, 0);
  clearBurikoBitmap(surface, {left: 0, top: 0, right: 1, bottom: 7});
  assert.equal(readRasterText(surface)[0].clip.x, 2);
  assert.equal(visibleRasterText(surface)[0].text, 'A');
  // Alpha artwork is a later opaque cover, without a text-specific clear.
  const cover = bitmap(4, 8, 0xff778899, 2);
  compositor.draw(surface, 0, 0, cover, 0, 0);
  assert.equal(visibleRasterText(surface).length, 0);
  fillBurikoBitmap(surface, 0);
  assert.equal(readRasterText(surface).length, 0);
  assert.equal(rasterTextBitmap(surface), surface);
});

test('textless alpha replay cannot introduce a native divide fault, while native transparent tails still fault', () => {
  const source = bitmap(3, 3, 0xffffffff, 2),
    destination = bitmap(3, 3, 0, 2);
  recordRasterText(source, 'A', {size: 3, width: 3});
  assert.equal(compositor.draw(destination, 0, 0, source, 1, 128), 0);
  assert.equal(readRasterText(destination)[0].text, 'A');
  assert.ok(rasterTextBitmap(destination).storage.bytes.every((v) => v === 0));
  assert.throws(
    () => blendBurikoAlphaWithTransparency(bitmap(3, 3, 0, 2), bitmap(3, 3, 0xffffffff, 2), 256),
    /division by zero/,
  );
});

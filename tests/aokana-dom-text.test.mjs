import {blendBurikoAlphaWithTransparency} from '../dist/engines/buriko/native/bitmap-alpha.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allocateBurikoBitmap,
  cropBurikoBitmap,
  fillBurikoBitmap,
} from '../dist/engines/buriko/native/bitmap.js';
import {clearBurikoBitmap} from '../dist/engines/buriko/native/bitmap-copy.js';
import {decorateBurikoBitmapText} from '../dist/engines/buriko/native/bitmap-dom-text.js';
import {BurikoBitmapCompositor} from '../dist/engines/buriko/native/bitmap-compositor.js';
import {
  recordRasterText,
  readRasterText,
  rasterTextBitmap,
  visibleRasterText,
  hasRasterText,
  withRasterText,
  clearRasterTextPresentation,
} from '../dist/text/raster-text.js';
import {rasterTextSlots} from '../dist/text/browser-raster-text.js';
import {slotText} from '../dist/text/glyph-slots.js';
import {
  startRuntimePerformanceRecording,
  stopRuntimePerformanceRecording,
  getRuntimePerformanceSnapshot,
} from '../dist/platform/runtime-performance.js';

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

test('native weight, glyph stretch and edge effects travel with composited glyphs into slots', () => {
  const styled = (text, x, effect) => {
    const value = bitmap(4, 8, 0xffffff);
    recordRasterText(value, text, {size: 8, width: 4, weight: 700, stretch: 0.75});
    decorateBurikoBitmapText(value, effect, 1, 1);
    // The effect pass is decorative ink: it removes its own ink but adds no glyph.
    const edge = bitmap(6, 10, 0xffffff);
    recordRasterText(edge, '', {decorative: true, color: effect.color});
    compositor.draw(surface, x, 0, edge, 0, 0);
    compositor.draw(surface, x + 1, 1, value, 0, 0);
  };
  const surface = bitmap(40, 12),
    outline = {mode: 2, color: 0xffffff, opacity: 192},
    shadow = {mode: 1, color: 0x102030, opacity: 256};
  styled('A', 0, outline);
  styled('B', 6, outline);
  styled('C', 20, shadow);
  const slots = rasterTextSlots(readRasterText(surface));
  assert.deepEqual(
    slots.map(({slot}) => slotText(slot).text),
    ['AB', 'C'],
  );
  const [edged, shaded] = slots.map(({slot}) => slot);
  assert.equal(edged.weight, 700);
  assert.equal(edged.stretch, 0.75);
  const {weights, ...edge} = slotText(edged).outline;
  assert.deepEqual(edge, {radiusX: 1, radiusY: 1, color: 0xffffff, alpha: 191});
  // Native radius-one edges sum full orthogonal coverage and sqrt(2) - 1 of each diagonal.
  assert.deepEqual(
    weights.map((w) => Math.round(w * 1000) / 1000),
    [0.414, 1, 0.414, 1, 1, 1, 0.414, 1, 0.414],
  );
  // The outline's dilation widens the slot's clip past the glyph cells.
  assert.equal(slotText(edged).clip.x, 0);
  assert.deepEqual(slotText(shaded).shadows, [{x: 1, y: 1, color: 0x102030, alpha: 255}]);
  assert.equal(slotText(shaded).outline, undefined);
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

test('raster paragraphs keep faded glyphs, cropped fragments and hanging dialogue rows in source order', () => {
  const make = (id, text, x, y, alpha) => ({
    id,
    text,
    x,
    y,
    width: 16,
    height: 24,
    size: 24,
    clip: {x, y, width: 16, height: 24},
    family: 'monospace',
    bold: false,
    vertical: false,
    color: 0xffffff,
    alpha,
  });
  const glyphs = [
    make(1, 'A', 10, 10, 255),
    make(2, 'B', 26, 10, 96),
    make(3, 'C', 42, 10, 192),
    make(4, 'D', 26, 46, 255),
    make(5, 'E', 42, 46, 160),
    make(6, 'F', 26, 82, 255),
  ];
  // Native damage uploads can expose disjoint strips of the same glyph.
  const fragment = {...glyphs[1], clip: {x: 26, y: 10, width: 8, height: 24}};
  glyphs[1].clip = {x: 34, y: 10, width: 8, height: 24};
  const slots = rasterTextSlots([...glyphs, fragment]);
  assert.equal(slots.length, 1);
  assert.equal(slotText(slots[0].slot).text, 'ABCDEF');
  assert.deepEqual(
    slots[0].slot.glyphs.map((g) => g.line),
    [0, 0, 0, 1, 1, 2],
  );
  assert.deepEqual(slots[0].slot.glyphs[1].clip, {x: 26, y: 10, width: 16, height: 24});
  const previousId = slots[0].slot.id;
  glyphs[1].alpha = 255;
  // Retained damage strips can precede a freshly opaque glyph with the same
  // identity. The new style must retire the old fade across the continuous run.
  const refreshed = rasterTextSlots([fragment, ...glyphs]);
  assert.equal(refreshed[0].slot.id, previousId);
  assert.equal(refreshed[0].slot.glyphs[1].alpha, 255);
  const fading = {...glyphs[1], alpha: 64};
  assert.equal(rasterTextSlots([...glyphs, fading])[0].slot.glyphs[1].alpha, 64);
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

test('cropped clears retire stale textless planes without losing retained snapshots', () => {
  for (const direct of [false, true]) {
    const surface = bitmap(12, 8),
      a = glyph('A');
    if (direct)
      surface.storage = new surface.storage.constructor(
        new Uint8Array(surface.storage.bytes.length + 1).subarray(1),
        true,
      );
    compositor.draw(surface, 4, 0, a, 0, 0);
    const snapshot = {
      ...surface,
      storage: surface.storage.cloneRange(0, surface.storage.bytes.length),
    };
    const nativeSnapshot = snapshot.storage.bytes.slice(),
      blankSnapshot = rasterTextBitmap(snapshot).storage.bytes.slice();
    for (let pass = 0; pass < 2; pass++)
      for (let row = 0; row < 8; row += 2) {
        const strip = {...surface, offset: row * surface.stride, height: 2};
        if (direct) {
          strip.storage.bytes.fill(0, strip.offset, strip.offset + strip.height * strip.stride);
          clearRasterTextPresentation(strip);
        } else clearBurikoBitmap(strip);
      }
    assert.equal(hasRasterText(surface), false);
    assert.equal(rasterTextBitmap(surface), surface);
    assert.ok(surface.storage.bytes.every((value) => value === 0));
    let calls = 0;
    const operation = withRasterText((destination) => {
      calls++;
      destination.storage.bytes[0] = 17;
    });
    operation(surface);
    assert.equal(calls, 1);
    assert.equal(surface.storage.bytes[0], 17);
    surface.storage.release();
    assert.equal(readRasterText(snapshot)[0].text, 'A');
    assert.deepEqual(snapshot.storage.bytes, nativeSnapshot);
    assert.deepEqual(rasterTextBitmap(snapshot).storage.bytes, blankSnapshot);
  }
});

test('empty glyph metadata cannot retire decorative ink and repeated misses reuse a byte witness', () => {
  const surface = bitmap(12, 8, 0xffffff);
  recordRasterText(surface, '', {decorative: true});
  const alternate = rasterTextBitmap(surface).storage;
  startRuntimePerformanceRecording();
  try {
    for (let repeat = 0; repeat < 10; repeat++)
      clearBurikoBitmap(surface, {left: 0, top: 0, right: 11, bottom: 3});
    assert.equal(readRasterText(surface).length, 0);
    assert.equal(rasterTextBitmap(surface).storage, alternate);
    assert.equal(surface.storage.bytes[4 * surface.stride], 255);
    assert.equal(alternate.bytes[4 * surface.stride], 0);
    const checks = () =>
      getRuntimePerformanceSnapshot().aggregates.find(
        (item) => item.name === 'text.raster.retirement-checks',
      )?.count ?? 0;
    assert.equal(checks(), 1);
    for (let repeat = 0; repeat < 2; repeat++)
      clearBurikoBitmap(surface, {left: 0, top: 4, right: 11, bottom: 7});
    assert.equal(hasRasterText(surface), false);
    assert.equal(checks(), 2);
    assert.ok(surface.storage.bytes.every((value) => value === 0));
  } finally {
    stopRuntimePerformanceRecording();
  }
});

test('recurring text and decorative overlays retain their planes without repeated scans or clones', () => {
  for (const decorative of [false, true]) {
    const surface = bitmap(12, 16),
      source = bitmap(4, 8, 0xffffff);
    recordRasterText(source, decorative ? '' : 'A', {decorative, size: 8, width: 4});
    compositor.draw(surface, 4, 8, source, 0, 0);
    const alternate = rasterTextBitmap(surface).storage,
      native = surface.storage.bytes.slice(),
      textless = alternate.bytes.slice();
    startRuntimePerformanceRecording();
    try {
      for (let frame = 0; frame < 4; frame++) {
        for (let row = 0; row < 16; row += 2)
          clearBurikoBitmap({...surface, offset: row * surface.stride, height: 2});
        compositor.draw(surface, 4, 8, source, 0, 0);
        assert.equal(rasterTextBitmap(surface).storage, alternate);
        assert.deepEqual(surface.storage.bytes, native);
        assert.deepEqual(alternate.bytes, textless);
        assert.equal(readRasterText(surface).length, decorative ? 0 : 1);
      }
      const aggregates = getRuntimePerformanceSnapshot().aggregates;
      assert.equal(
        aggregates.some((item) => item.name === 'text.raster.retirement-checks'),
        false,
      );
      assert.equal(
        aggregates.find((item) => item.name === 'text.raster.replay.source-glyphs').total,
        decorative ? 0 : 4,
      );
    } finally {
      stopRuntimePerformanceRecording();
    }
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {packMaskTiles} from '../dist/graphics/mask-atlas.js';
test('mixed-size mask tiles retain fractional raster extents and isolated borders across pages', () => {
  const sizes = Array.from({length: 500}, (_, i) => ({
      width: 1.5 + ((i * 17) % 90),
      height: 1 + ((i * 31) % 75),
    })),
    tiles = packMaskTiles(sizes, 128);
  assert.ok(tiles.at(-1).page > 0);
  tiles.forEach((t, i) => {
    assert.equal(t.width, Math.ceil(sizes[i].width));
    assert.equal(t.height, Math.ceil(sizes[i].height));
    assert.ok(t.x >= 1 && t.y >= 1 && t.x + t.width + 1 <= 128 && t.y + t.height + 1 <= 128);
    for (const other of tiles.slice(0, i))
      if (other.page === t.page)
        assert.ok(
          t.x + t.width + 1 <= other.x - 1 ||
            other.x + other.width + 1 <= t.x - 1 ||
            t.y + t.height + 1 <= other.y - 1 ||
            other.y + other.height + 1 <= t.y - 1,
        );
  });
});
test('mask atlas rejects unsupported dimensions instead of truncating output', () => {
  for (const width of [0, 0.5, -1, NaN, Infinity, 127])
    assert.throws(() => packMaskTiles([{width, height: 1}], 128));
  assert.deepEqual(packMaskTiles([], 128), []);
  assert.deepEqual(
    packMaskTiles(
      [
        {width: 126, height: 126},
        {width: 126, height: 126},
      ],
      128,
    ).map((t) => t.page),
    [0, 1],
  );
});

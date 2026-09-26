import test from 'node:test';
import assert from 'node:assert/strict';
import {allocateBurikoBitmap, fillBurikoBitmap} from '../dist/engines/buriko/native/bitmap.js';
import {bitmapRead32} from '../dist/engines/buriko/native/bitmap-scalar.js';
import {BurikoParticleVariants} from '../dist/engines/buriko/native/particle-images.js';

test('particle variants produce all 32 native scale banks with independent frame selection', () => {
  const first = allocateBurikoBitmap(64, 64, 2),
    second = allocateBurikoBitmap(64, 64, 2);
  fillBurikoBitmap(first, 0xff102030);
  fillBurikoBitmap(second, 0xff908070);
  const variants = new BurikoParticleVariants();
  assert.equal(variants.configureImages('snow', 2, [first, second], 2, 32768, 8192), 0);
  const images = variants.snowImages[2];
  assert.equal(images.count, 2);
  assert.equal(images.duration, 32768);
  assert.equal(images.durationSpread, 8192);
  for (let scale = 0; scale < 32; scale++) {
    assert.equal(images.scales[scale].length, 2);
    assert.equal(images.scales[scale][0].width, 64 - scale * 2);
    assert.equal(images.scales[scale][0].height, 64 - scale * 2);
  }
  assert.equal(bitmapRead32(images.scales[0][0], 0), 0xff102030);
  assert.equal(bitmapRead32(images.scales[0][1], 0), 0xff908070);
  assert.equal(bitmapRead32(images.scales[31][0], 0), 0xff102030);
  assert.equal(bitmapRead32(images.scales[31][1], 0), 0xff908070);
  assert.equal(variants.fireflyImages[2].count, 0);
  assert.equal(variants.configureImages('special', 3, [first], 1, 100, 7, 63), 0);
  assert.equal(variants.hasSpecial(3), true);
  assert.equal(variants.specialOptions[3], 63);
  assert.equal(variants.setSpecialOption(3, 128), 0);
  assert.equal(variants.specialOptions[3], 128);
});

test('particle global configuration preserves Q8 conversions and raw transition/fade values', () => {
  const variants = new BurikoParticleVariants();
  assert.equal(
    variants.configureSnow(7, [-256, 512, -768, -1024, -1280, 1536, -1792, 2048, -2304, 2560]),
    true,
  );
  assert.deepEqual([...variants.snowParameters[7]], [1, 1, 2, 3, -4, 5, 6, 7, 8, 9, 10]);
  assert.equal(
    variants.configureFirefly(
      8,
      [
        100, 200, -256, -512, -768, -1024, -1280, 1536, -1792, 2048, -2304, 300, 400, 2560, 0, 13,
        0x80,
      ],
    ),
    true,
  );
  assert.deepEqual(
    [...variants.fireflyParameters[8]],
    [1, 100, 200, 1, -2, 3, -4, 5, 6, 7, 8, 9, 300, 400, 10, 1, 13, 0x80],
  );
});

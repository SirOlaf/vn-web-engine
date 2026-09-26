import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaParticleVariants} from '../dist/engines/buriko/games/aokana/native/particle-images.js';
import {
  AokanaFireflyMovement,
  AokanaFireflyParticle,
  AokanaSnowParticle,
} from '../dist/engines/buriko/games/aokana/native/particle-objects.js';
import {AokanaCrtRandom} from '../dist/engines/buriko/games/aokana/native/system-timing.js';
import {AokanaBitmapCompositor} from '../dist/engines/buriko/games/aokana/native/bitmap-compositor.js';
import {
  allocateAokanaBitmap,
  fillAokanaBitmap,
} from '../dist/engines/buriko/games/aokana/native/bitmap.js';
import {bitmapRead32} from '../dist/engines/buriko/games/aokana/native/bitmap-scalar.js';

function frames(variants, kind, colors, option = 0) {
  const images = colors.map((color) => {
    const bitmap = allocateAokanaBitmap(32, 32, 2);
    fillAokanaBitmap(bitmap, color);
    return bitmap;
  });
  assert.equal(variants.configureImages(kind, 0, images, colors.length, 32768, 0, option), 0);
}
function fireflyParameters(variants, values = {}) {
  const {life = 5, vx = 1, vy = 2, vz = 3, duration = 2} = values;
  variants.configureFirefly(0, [
    life,
    0,
    0,
    2560,
    0,
    vx * 256,
    0,
    vy * 256,
    0,
    vz * 256,
    0,
    duration,
    0,
    256,
    2,
    2,
    0x20,
  ]);
}

test('snow particles preserve Q16 frame progression, Q8 air and constant integer movement', () => {
  const variants = new AokanaParticleVariants();
  frames(variants, 'snow', [0xff102030, 0xff405060]);
  variants.configureSnow(0, [0, 2560, 0, 256, 0, 512, 0, -256, 0, 512]);
  const particle = new AokanaSnowParticle(0, variants, new AokanaCrtRandom());
  assert.deepEqual(particle.position(), {x: 0, y: 10, z: 0});
  particle.applyAir({x: 128, y: 256, z: -128});
  assert.deepEqual(particle.position(), {x: 1, y: 12, z: -1});
  assert.equal(particle.update(), 1);
  assert.deepEqual(particle.position(), {x: 2, y: 14, z: -2});
  assert.equal(particle.frame(), 0);
  assert.equal(particle.update(), 1);
  assert.equal(particle.frame(), 1);
  assert.equal(bitmapRead32(particle.image(0), 0), 0xff405060);
  assert.equal(particle.update(), 1);
  assert.equal(particle.update(), 1);
  assert.equal(particle.frame(), 0);
  assert.equal(particle.transparency(), 0);
  assert.equal(particle.blendMode(), 0x20);
});

test('firefly particles follow lifespan, transition and fade counters independently', () => {
  const variants = new AokanaParticleVariants();
  frames(variants, 'firefly', [0xff102030, 0xff405060]);
  fireflyParameters(variants);
  const particle = new AokanaFireflyParticle(
    0,
    variants,
    new AokanaCrtRandom(),
    new AokanaFireflyMovement(),
    new AokanaBitmapCompositor(),
  );
  assert.equal(particle.transparency(), 256);
  for (let age = 1; age <= 5; age++) {
    assert.equal(particle.update(), 1);
    assert.deepEqual(particle.position(), {x: age, y: 10 + age * 2, z: age * 3});
    assert.equal(particle.transparency(), [0, 128, 0, 0, 128, 256][age]);
  }
  assert.equal(particle.update(), 0);
  assert.equal(particle.active, 1);
});

test('firefly movement retains normalization, lifetime adjustment and half-away angle rotation', () => {
  const variants = new AokanaParticleVariants();
  frames(variants, 'firefly', [0xff112233]);
  fireflyParameters(variants, {life: 8, vx: 3, vy: 4, vz: 0});
  const normalized = new AokanaFireflyMovement();
  normalized.configure([0, 0, 0, 1, 512, 0, 65536, 65536, 65536, 1, 1, 0, 0, 0]);
  const first = new AokanaFireflyParticle(
    0,
    variants,
    new AokanaCrtRandom(),
    normalized,
    new AokanaBitmapCompositor(),
  );
  assert.equal(first.update(), 1);
  assert.deepEqual(first.position(), {x: 1, y: 11, z: 0});
  fireflyParameters(variants, {life: 10, vx: 1, vy: 0, vz: 0, duration: 1});
  const rotated = new AokanaFireflyMovement();
  rotated.configure([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 90 * 65536 * 256, 0]);
  const second = new AokanaFireflyParticle(
    0,
    variants,
    new AokanaCrtRandom(),
    rotated,
    new AokanaBitmapCompositor(),
  );
  assert.equal(second.update(), 1);
  assert.deepEqual(second.position(), {x: 1, y: 10, z: 0});
  assert.equal(second.update(), 1);
  assert.deepEqual(second.position(), {x: 1, y: 10, z: -1});
});

test('firefly special images use independent animation counts and the concrete alpha mixer', () => {
  const variants = new AokanaParticleVariants();
  frames(variants, 'firefly', [0xfffefcf8]);
  frames(variants, 'special', [0xff000000], 128);
  fireflyParameters(variants);
  const particle = new AokanaFireflyParticle(
    0,
    variants,
    new AokanaCrtRandom(),
    new AokanaFireflyMovement(),
    new AokanaBitmapCompositor(),
  );
  assert.equal(particle.refreshSpecial(0), true);
  const image = particle.image(0);
  assert.equal(image.width, 32);
  assert.equal(image.height, 32);
  assert.equal(bitmapRead32(image, 0), 0xff7d7c7a);
  assert.equal(particle.releaseImage(), 1);
});

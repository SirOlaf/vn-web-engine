import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AokanaDisplayTexture,
  aokanaDisplayTextureSize,
} from '../dist/engines/buriko/games/aokana/native/display-texture.js';
import {
  aokanaPresentationCubicWeight,
  aokanaPresentationLinearRgbInto,
  aokanaPresentationTextureSample,
  aokanaPresentationTextureSampleInto,
  aokanaCubicPresentationSample,
} from '../dist/engines/buriko/games/aokana/native/presentation-sampling.js';

test('native logarithm sizing and the shader a=-1 kernel retain their exact ordinary values', () => {
  assert.deepEqual(aokanaDisplayTextureSize(800, 600), [1024, 1024]);
  assert.deepEqual(aokanaDisplayTextureSize(1280, 720), [2048, 1024]);
  assert.deepEqual(aokanaDisplayTextureSize(1024, 512), [1024, 512]);
  assert.deepEqual(
    [1.5, 0.5, -0.5, -1.5].map(aokanaPresentationCubicWeight),
    [-0.125, 0.625, 0.625, -0.125],
  );
  assert.deepEqual(
    [1.25, 0.25, -0.75, -1.75].map(aokanaPresentationCubicWeight),
    [-0.140625, 0.890625, 0.296875, -0.046875],
  );
});

test('fixed point and linear sample paths preserve normalized channels and their distinct positions', () => {
  const texture = new AokanaDisplayTexture(2, 1, 21);
  texture.storage.bytes.set([0, 0, 255, 255, 255, 0, 0, 0]);
  assert.deepEqual(aokanaPresentationTextureSample(texture, 0.5, 0.5, 'point'), [0, 0, 1, 0]);
  assert.deepEqual(
    aokanaPresentationTextureSample(texture, 0.5, 0.5, 'linear'),
    [0.5, 0, 0.5, 0.5],
  );
});

test('cubic edge taps are discarded and their surviving weights are renormalized', () => {
  const texture = new AokanaDisplayTexture(4, 1, 22);
  texture.storage.bytes.set([0, 0, 0, 0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 255, 0]);
  const color = aokanaCubicPresentationSample(texture, 3, 1, 0.1875, 0.5, 'point');
  const expected = Math.fround(0.296875 * Math.fround(1 / 1.140625));
  assert.deepEqual(color, [expected, 0, 0, 1]);
  assert.deepEqual(
    aokanaCubicPresentationSample(texture, 3, 1, 0.375, 0.5, 'linear'),
    [1, 0, 0, 1],
  );
});

test('raster RGB path matches the native linear sampler across interior and border coordinates', () => {
  const texture = new AokanaDisplayTexture(4, 3, 21);
  texture.storage.bytes.forEach((_, index) => {
    texture.storage.bytes[index] = (index * 37 + 11) & 255;
  });
  const output = [0, 0, 0, 0];
  const reference = [0, 0, 0, 0];
  const scratch = {a: [0, 0, 0, 0], b: [0, 0, 0, 0], c: [0, 0, 0, 0], d: [0, 0, 0, 0]};
  const read = {validated: false};
  for (let yi = -3; yi <= 15; yi++)
    for (let xi = -3; xi <= 18; xi++) {
      const u = Math.fround(xi / 16);
      const v = Math.fround(yi / 12);
      const x = Math.fround(Math.fround(u) * Math.fround(texture.width));
      const y = Math.fround(Math.fround(v) * Math.fround(texture.height));
      const px = Math.fround(x - 0.5);
      const py = Math.fround(y - 0.5);
      const nx = Math.floor(px);
      const ny = Math.floor(py);
      aokanaPresentationLinearRgbInto(
        texture,
        nx,
        ny,
        Math.fround(px - nx),
        Math.fround(py - ny),
        output,
        read,
      );
      aokanaPresentationTextureSampleInto(texture, u, v, 'linear', reference, scratch);
      assert.deepEqual(output.slice(0, 3), reference.slice(0, 3));
    }
});

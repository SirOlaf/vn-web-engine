import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AokanaParticleAir,
  aokanaParticleRandom,
} from '../dist/engines/buriko/games/aokana/native/particle-air.js';

test('particle random consumes two 15-bit CRT draws for inclusive signed ranges', () => {
  const samples = [0, 0, 1, 2, 32767, 32767, 3, 7, 9, 11];
  let cursor = 0;
  const random = {next: () => samples[cursor++]};
  assert.equal(aokanaParticleRandom(random, 0), 0);
  assert.equal(aokanaParticleRandom(random, 100), 32770 % 101);
  assert.equal(aokanaParticleRandom(random, 0x7fffffff), 0x3fffffff);
  assert.equal(aokanaParticleRandom(random, -99), -((3 * 32768 + 7) % 98));
  assert.equal(aokanaParticleRandom(random, -0x80000000), -294923);
  assert.equal(cursor, 10);
});

test('particle air holds and interpolates independently randomized Q8 endpoints', () => {
  const samples = [0, 0, 0, 0, 0, 1, 0, 2, 0, 4, 0, 3, 0, 0];
  let cursor = 0;
  const random = {next: () => samples[cursor++] ?? 0};
  const air = new AokanaParticleAir(random);
  assert.deepEqual(air.current(), {enabled: 0, vector: {x: 0, y: 0, z: 0}});
  air.advance();
  air.setInterval(10);
  air.configure(1, 10 << 8, 2 << 8, 20 << 8, 3 << 8, 30 << 8, 4 << 8, 10, 0, 20, 0);
  assert.equal(cursor, 14);
  assert.deepEqual(air.current(), {enabled: 1, vector: {x: 0, y: 0, z: 0}});
  air.advance();
  assert.deepEqual(air.current().vector, {x: 8, y: 18, z: 28});
  air.advance();
  assert.deepEqual(air.current().vector, {x: 8, y: 18, z: 28});
  air.advance();
  assert.deepEqual(air.current().vector, {x: 10, y: 19, z: 27});
  air.advance();
  assert.deepEqual(air.current().vector, {x: 12, y: 20, z: 26});
});

test('particle air rate changes preserve current transition and zero durations become one step', () => {
  const air = new AokanaParticleAir({next: () => 0});
  air.setInterval(10);
  air.configure(1, -257, 0, 511, 0, -1, 0, 0, 0, 0, 0);
  air.advance();
  assert.deepEqual(air.current().vector, {x: -2, y: 1, z: -1});
  assert.equal(air.phase, 1);
  assert.equal(air.duration, 1);
  air.setInterval(0);
  assert.equal(air.enabled, 1);
  air.advance();
  assert.equal(air.phase, 0);
  air.configure(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  assert.deepEqual(air.current(), {enabled: 0, vector: {x: 0, y: 0, z: 0}});
});

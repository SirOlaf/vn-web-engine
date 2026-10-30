import test from 'node:test';
import assert from 'node:assert/strict';
import {EmoteMeshCombinators} from '../dist/native/emotedriver/runtime/clip/combinators.js';
import {EMOTEDRIVER_X64_SHA256, EMOTEDRIVER_X86_SHA256} from '../dist/native/emotedriver/build.js';

const definition = () => ({
  key: 'shape',
  rangeBegin: 0,
  rangeEnd: 1,
  meshCount: 3,
  neutralIndex: 0,
  raw: Float32Array.from({length: 96}, (_, i) => Math.floor(i / 32)),
});

test('mesh combinators use interchangeable variable sources and patch targets', () => {
  let value = 0;
  const writes = [];
  const registry = new EmoteMeshCombinators({getVariable: () => value}, EMOTEDRIVER_X64_SHA256);
  const target = {
    meshType: 1,
    applyCombinatorPatch: (patch) => writes.push(patch?.slice() ?? null),
  };
  registry.register(target, [definition()], {});
  assert.deepEqual(writes, [null]);
  value = 0.25;
  registry.update();
  assert.deepEqual(writes.at(-1), new Float32Array(32).fill(0.5));
  registry.update();
  assert.equal(writes.length, 2);
  value = 1;
  registry.update();
  assert.deepEqual(writes.at(-1), new Float32Array(32).fill(2));
  assert.deepEqual(writes[1], new Float32Array(32).fill(0.5));
  value = 0;
  registry.update();
  assert.equal(writes.at(-1), null);
});

test('unregistering one clip retains other owners sharing the variable', () => {
  let value = 0;
  const registry = new EmoteMeshCombinators({getVariable: () => value}, EMOTEDRIVER_X64_SHA256);
  const a = {},
    b = {},
    writes = [0, 0, 0];
  const target = (i, meshType = 1) => ({meshType, applyCombinatorPatch: () => writes[i]++});
  registry.register(target(0), [definition()], a);
  registry.register(target(1), [definition()], b);
  registry.register(target(2, 2), [definition()], b);
  assert.deepEqual(writes, [1, 1, 0]);
  registry.unregister(a);
  value = 1;
  registry.update();
  assert.deepEqual(writes, [1, 2, 0]);
  assert.equal(registry.empty, false);
  registry.unregister(b);
  assert.equal(registry.empty, true);
  value = 0;
  registry.update();
  assert.deepEqual(writes, [1, 2, 0]);
  registry.clear();
});

test('mesh combinators require the supported exact driver image', () => {
  const source = {getVariable: () => assert.fail('must not read variables')};
  assert.throws(() => new EmoteMeshCombinators(source, '3.9.8'), /unsupported DLL build/);
  assert.throws(() => new EmoteMeshCombinators(source, EMOTEDRIVER_X86_SHA256), /mesh combinators/);
});

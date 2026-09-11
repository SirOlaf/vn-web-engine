import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runtime, literal} from './sc3-fixtures.mjs';
import {NoahState} from '../dist/engines/mages/games/chaos-head-noah/sc3/noah-state.js';
import {advanceRain, rainAtPriority} from '../dist/engines/mages/games/chaos-head-noah/sc3/rain.js';
import {drawSceneHud} from '../dist/engines/mages/games/chaos-head-noah/sc3/scene-hud-draw.js';
import {sceneDrawContexts} from '../dist/engines/mages/games/chaos-head-noah/sc3/scene-contexts.js';
import {captureStartupFrame} from '../dist/engines/mages/games/chaos-head-noah/sc3/startup-frame.js';

test('scene draw collection obeys group visibility, signed cutoff and native swap order', async () => {
  const vm = runtime([0, 3]);
  await vm.boot();
  const ids = [0, vm.allocateContext(0), vm.allocateContext(0), vm.allocateContext(1)];
  for (const [i, id] of ids.entries()) {
    const c = vm.context(id);
    c.setUint32(0, c.getUint32(0, true) | 0x20000000, true);
    c.setInt32(0x80, [700, 700, 400, 710][i], true);
  }
  const collected = () => sceneDrawContexts(vm).map((c) => c.getUint32(0x70, true));
  assert.deepEqual(collected(), [ids[2], ids[1], ids[0], ids[3]]);
  vm.state.put(0x17ac228, 700);
  assert.deepEqual(collected(), [ids[0], ids[1], ids[3]]);
  vm.state.put(0x17ab884, 0);
  assert.deepEqual(collected(), [ids[0], ids[1]]);
  vm.context(ids[1]).setUint32(0, 0, true);
  assert.deepEqual(collected(), [ids[0]]);
});

test('checkpoint HUD completes its 150-pass hold and fade, and visibility gates pause it', () => {
  const s = new NoahState(() => 0);
  s.put(0x17ac1c4, 150);
  let visible = 0;
  for (let i = 0; i < 166; i++) {
    const draws = drawSceneHud(s);
    if (draws.length) visible++;
    if (i === 15) assert.equal(s.get(0x17ac31c), 256);
  }
  assert.equal(visible, 165);
  assert.equal(s.get(0x17ac31c), 0);
  assert.equal(s.get(0x17abc98), 0);
  assert.equal(s.get(0x17abdb4), 0);
  for (const [address, mask] of [
    [0x136, 128],
    [0x9b, 16],
  ]) {
    s.put(0x17ac1c4, 150);
    s.flags[address] = mask;
    assert.deepEqual(drawSceneHud(s), []);
    assert.equal(s.get(0x17ac1c4), 150);
    s.flags[address] = 0;
  }
});

test('rain updates the full active bank and consumes RNG only on strict near-plane respawn', () => {
  let calls = 0;
  const s = new NoahState(() => {
    calls++;
    return 0;
  });
  s.setVariable(0x5dc8 / 4, 1);
  s.setVariable(0x5dd4 / 4, 65536);
  s.setVariable(0x5ddc / 4, 2000);
  for (let i = 0; i < 2000; i++) s.view(0x57ae38 + i * 12, 4).setFloat32(0, -999, true);
  advanceRain(s);
  assert.equal(calls, 0);
  advanceRain(s);
  assert.equal(calls, 4000);
  assert.equal(s.view(0x57ae38 + 1999 * 12, 4).getFloat32(0, true), 1000);
  assert.equal(s.get(0x54d400 + 1999 * 8), -2000);
  assert.equal(s.get(0x56cdbc), 0);
  assert.equal(s.view(0x57ae38 + 2000 * 12, 4).getFloat32(0, true), 0);
});

test('both rain priority pairs issue independent near/far draws without advancing particles', () => {
  const s = new NoahState(() => 0);
  s.put(0x56cdb8, 2);
  for (const [a, n] of [
    [0x5dcc, 256],
    [0x5de4, 3000],
    [0x5df0, 500],
    [0x5de8, 4],
    [0x5dec, 4],
    [0x5e04, 4],
    [0x5e08, 4],
  ])
    s.setVariable(a / 4, n);
  for (let i = 0; i < 2; i++) {
    s.view(0x57ae30 + i * 12, 4).setFloat32(0, 10, true);
    s.view(0x57ae34 + i * 12, 4).setFloat32(0, 10, true);
    s.view(0x57ae38 + i * 12, 4).setFloat32(0, i ? 0 : -500, true);
    s.put(0x570e60 + i * 4, 256);
  }
  const before = s.bytes(0x57ae30, 24).slice(),
    draws = rainAtPriority(s, 4);
  assert.equal(draws.length, 4);
  assert.deepEqual(draws[0].vertices, draws[2].vertices);
  assert.deepEqual(draws[1].vertices, draws[3].vertices);
  assert.deepEqual(s.bytes(0x57ae30, 24), before);
});

test('renderer consumes the native trailing RNG call even with no drawable contexts', async () => {
  const vm = runtime([0, 3]);
  await vm.boot();
  let calls = 0;
  vm.state.random15 = () => ++calls;
  for (let i = 0; i < 12; i++) vm.state.put(0x17ab880 + i * 4, 0);
  captureStartupFrame(vm, 1);
  assert.equal(calls, 1);
});

test('text hide opacity advances once per VM scheduling pass, including budget continuations', async () => {
  const vm = runtime([0xfe, ...literal(1), 0xfe, ...literal(2), 0, 3]);
  await vm.boot();
  vm.state.put(0x17adc88, 256);
  vm.state.flags[0x9b] |= 16;
  assert.equal(vm.runFrame(1), 'budget');
  assert.equal(vm.state.get(0x17adc88), 240);
  vm.runFrame(1);
  assert.equal(vm.state.get(0x17adc88), 240);
});

test('application draw boundary commits staged atlases before readiness filtering', async () => {
  const vm = runtime([0, 3]);
  await vm.boot();
  for (let i = 0; i < 12; i++) vm.state.put(0x17ab880 + i * 4, 0);
  const c = vm.context(0);
  vm.state.put(0x17ab880, 0x20000000);
  c.setUint32(0, c.getUint32(0, true) | 0x20000000, true);
  c.setInt32(0x84, 6, true);
  vm.state.put(0x17ac1c4, 150);
  const pixels = new Uint8Array(4096 * 1024 * 4);
  pixels.fill(255);
  vm.textures.load(80, {width: 4096, height: 1024, pixels, colorType: 6, bitDepth: 8});
  const a = 0x1d1b200 + 80 * 0x1b0;
  assert.equal(vm.state.bytes(a + 0x32, 1)[0], 0);
  assert.ok(vm.textures.resources.get(80).pending);
  vm.state.put(0x586a54, 0x10000);
  vm.state.put(0x587340, 0);
  const frame = captureStartupFrame(vm, 1);
  assert.ok(
    frame.draw.commands.some((d) => d.kind === 'triangles' && d.texture === 80),
    'The real draw traversal must submit the staged HUD atlas',
  );
  assert.ok(frame.textures.get(80).pixels.some((n) => n !== 0));
  assert.equal(vm.textures.resources.get(80).pending, undefined);
  assert.equal(vm.state.bytes(a + 0x32, 1)[0], 1);
  assert.equal(vm.state.bytes(0x1dd97e9, 1)[0], 0);
  assert.equal(vm.state.get(0x586a54), 0);
});

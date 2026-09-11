import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runtime, literal} from './sc3-fixtures.mjs';
import {png} from './png-fixtures.mjs';
import {NoahState} from '../dist/engines/mages/games/chaos-head-noah/sc3/noah-state.js';
import {
  NoahTextures,
  SURFACE_BASE,
  SURFACE_STRIDE,
} from '../dist/engines/mages/games/chaos-head-noah/sc3/textures.js';
const image = (width, height, pixels, type = 6) => ({
  width,
  height,
  pixels: Uint8Array.from(pixels),
  colorType: type,
  bitDepth: 8,
});
const a = (id) => SURFACE_BASE + id * SURFACE_STRIDE;
test('texture staging retains transparent RGB, metadata and explicit visibility', () => {
  const s = new NoahState(() => 0),
    t = new NoahTextures(s);
  t.load(91, image(2, 1, [1, 2, 3, 0, 4, 5, 6, 128]));
  const r = t.resources.get(91);
  assert.equal(s.view(a(91) + 0x68, 2).getUint16(0, true), 2);
  assert.equal(s.get(a(91) + 0x58), 8);
  assert.equal(s.bytes(a(91) + 0x120, 1)[0], 1);
  assert.equal(s.bytes(a(91) + 0x32, 1)[0], 0);
  assert.deepEqual([...r.pending.pixels], [1, 2, 3, 0, 4, 5, 6, 128]);
  assert.deepEqual([...r.image.pixels], Array(8).fill(0));
  t.commit(91);
  assert.deepEqual([...r.image.pixels], [1, 2, 3, 0, 4, 5, 6, 128]);
  assert.equal(r.pending, undefined);
  assert.equal(s.bytes(a(91) + 0x120, 1)[0], 0);
  assert.equal(s.bytes(a(91) + 0x32, 1)[0], 1);
  assert.equal(s.view(a(91) + 0x148, 8).getBigUint64(0, true), 0n);
});
test('texture replacement and retained allocations follow different native paths', () => {
  const s = new NoahState(() => 0),
    t = new NoahTextures(s);
  s.put(0x1dd97e9, 1, 1);
  t.load(1, image(2, 1, [1, 1, 1, 255, 2, 2, 2, 255]));
  const original = t.resources.get(1),
    pointer = s.view(a(1) + 0x128, 8).getBigUint64(0, true);
  s.put(a(1) + 0x1a8, 1, 1);
  t.load(1, image(1, 1, [9, 8, 7, 255]));
  assert.equal(t.resources.get(1), original);
  assert.equal(s.view(a(1) + 0x128, 8).getBigUint64(0, true), pointer);
  assert.deepEqual([...original.image.pixels], [9, 8, 7, 255, 0, 0, 0, 0]);
  s.put(a(1) + 0x1a8, 0, 1);
  t.load(1, image(1, 1, [3, 4, 5, 255]));
  assert.notEqual(t.resources.get(1), original);
  assert.equal(t.resources.get(1).image.width, 1);
  t.release(1);
  assert.equal(t.resources.has(1), false);
  assert.equal(s.bytes(a(1) + 0x30, 1)[0], 0);
  assert.equal(s.get(a(1) + 0x3c), -1);
  assert.equal(s.view(a(1) + 0x1aa, 2).getUint16(0, true), 65535);
  t.load(512, image(1, 1, [0, 0, 0, 0]));
  assert.equal(t.diagnostics.length, 1);
  assert.throws(() => t.load(-1, image(1, 1, [0, 0, 0, 0])), /range/);
});
test('surface-release opcode gates before operands and resets the complete live descriptor', async () => {
  const vm = runtime([1, 1, ...literal(168), 0, 3]);
  await vm.boot();
  const start = vm.pc(0),
    address = a(168);
  vm.textures.createRgba(168, 2, 3);
  vm.state.put(address + 0x37, 0xa5, 1);
  vm.state.put(address + 0x42, 0x5aa5, 2);
  vm.state.put(address + 0x57, 0x5a, 1);
  vm.state.put(address + 0x1a8, 0xa5, 1);
  vm.state.put(address + 0x1aa, 0x1234, 2);
  vm.state.put(0x81007c, 1);
  vm.context(0).setInt32(0x1c, 123, true);
  assert.equal(vm.runFrame(), 'complete');
  assert.equal(vm.pc(0), start);
  assert.equal(vm.context(0).getInt32(0x1c, true), 123);
  assert.equal(vm.textures.resources.has(168), true);
  vm.state.put(0x81007c, 0);
  assert.equal(vm.runFrame(), 'complete');
  assert.ok(vm.pc(0) > start);
  assert.equal(vm.textures.resources.has(168), false);
  assert.deepEqual([...vm.state.bytes(address + 0x30, 7)], Array(7).fill(0));
  assert.equal(vm.state.bytes(address + 0x37, 1)[0], 0xa5);
  assert.equal(vm.state.bytes(address + 0x38, 1)[0], 0);
  assert.equal(vm.state.get(address + 0x3c), -1);
  assert.equal(vm.state.view(address + 0x40, 2).getUint16(0, true), 0);
  assert.equal(vm.state.view(address + 0x42, 2).getUint16(0, true), 0x5aa5);
  assert.deepEqual([...vm.state.bytes(address + 0x44, 16)], Array(16).fill(255));
  assert.equal(vm.state.view(address + 0x54, 2).getUint16(0, true), 0xff00);
  assert.equal(vm.state.bytes(address + 0x56, 1)[0], 0);
  assert.equal(vm.state.bytes(address + 0x57, 1)[0], 0x5a);
  for (const [offset, size] of [
    [0x58, 16],
    [0x68, 18],
    [0x98, 8],
    [0x120, 2],
    [0x128, 128],
  ])
    assert.deepEqual([...vm.state.bytes(address + offset, size)], Array(size).fill(0));
  assert.equal(vm.state.bytes(address + 0x1a8, 1)[0], 0xa5);
  assert.equal(vm.state.view(address + 0x1aa, 2).getUint16(0, true), 0x1234);
});
test('surface release preserves the native 512 edge and positive error branch', () => {
  const s = new NoahState(() => 0),
    t = new NoahTextures(s),
    edge = a(512);
  s.bytes(edge, SURFACE_STRIDE).fill(0x5a);
  s.put(edge + 0x28, 15, 8);
  s.put(edge + 0x30, 1, 1);
  t.release(512);
  assert.equal(s.bytes(edge + 0x30, 1)[0], 0);
  assert.deepEqual([...s.bytes(edge + 0x128, 128)], Array(128).fill(0));
  assert.equal(s.bytes(edge + 0x1a8, 1)[0], 0x5a);
  const before = s.regions.map((r) => r.bytes.slice());
  t.release(513);
  assert.equal(t.diagnostics.at(-1), 'GSLreleaseSurface: target 513 out of range');
  assert.deepEqual(
    s.regions.map((r) => r.bytes),
    before,
  );
  assert.throws(() => t.release(-1), /precedes the mapped surface table/);
});
test('surface release preserves native heap-string storage while clearing inline storage', () => {
  const s = new NoahState(() => 0),
    t = new NoahTextures(s),
    heap = a(8),
    inline = a(9),
    pointer = 0x123456789abcdef0n;
  s.put(heap + 0x30, 1, 1);
  s.view(heap + 0x10, 8).setBigUint64(0, pointer, true);
  s.view(heap + 0x28, 8).setBigUint64(0, 16n, true);
  t.release(8);
  assert.equal(s.view(heap + 0x10, 8).getBigUint64(0, true), pointer);
  s.put(inline + 0x30, 1, 1);
  s.put(inline + 0x10, 0x5a, 1);
  s.view(inline + 0x28, 8).setBigUint64(0, 15n, true);
  t.release(9);
  assert.equal(s.bytes(inline + 0x10, 1)[0], 0);
});
test('native R8/A8 texture formats retain channel semantics and odd-width source stride', () => {
  const s = new NoahState(() => 0),
    t = new NoahTextures(s);
  t.load(1, image(1, 2, [12, 12, 12, 255, 34, 34, 34, 255], 0));
  assert.equal(s.get(a(1) + 0x44), 0xa0);
  assert.deepEqual([...t.resources.get(1).pending.pixels], [12, 0, 0, 255, 0, 0, 0, 255]);
  t.load(2, image(2, 1, [99, 99, 99, 12, 88, 88, 88, 34], 4));
  assert.equal(s.get(a(2) + 0x44), 0xa1);
  assert.deepEqual([...t.resources.get(2).pending.pixels], [0, 0, 0, 12, 0, 0, 0, 34]);
});
function textureVm() {
  const bytes = png({width: 1, height: 1, raw: Buffer.from([0, 1, 2, 3, 0])}),
    vm = runtime([1, 2, ...literal(91), ...literal(2), ...literal(20), 0, 3]);
  return {bytes, vm};
}
test('texture opcode does not consume gated operands and requires all three native phases', async () => {
  const {bytes, vm} = textureVm(); // Provider is captured at construction; install methods on the supplied object.
  // Tests use the same injected archive interface as browser and CLI.
  const {Sc3Runtime} = await import('../dist/engines/mages/games/chaos-head-noah/sc3/runtime.js');
  const v = new Sc3Runtime(
    vm.platform,
    {...vm.assets, textures: {size: () => bytes.length, read: async () => bytes}},
    vm.options,
  );
  await v.boot();
  const start = v.pc(0);
  v.state.put(0x81007c, 1);
  v.context(0).setInt32(0x1c, 123, true);
  v.runFrame();
  assert.equal(v.pc(0), start);
  assert.equal(v.context(0).getInt32(0x1c, true), 123);
  v.state.put(0x81007c, 0);
  v.runFrame();
  assert.equal(v.state.get(0x176e528), 1);
  assert.equal(v.state.get(0x5872ac), 1);
  assert.equal(v.state.variable(0x3404 / 4), 1);
  await v.settleLoads();
  assert.equal(v.state.get(0x5872ac), 1);
  v.publishLoadCompletions();
  v.runFrame();
  assert.equal(v.pc(0), start);
  assert.equal(v.state.get(0x176e528), 8);
  assert.equal(v.state.get(0x58726c), 0);
  assert.equal(v.state.get(0x179cd20), bytes.length);
  assert.equal(v.state.view(0x179cd28, 8).getBigUint64(0, true), 0x500000000n);
  assert.ok(v.textures.resources.get(91).pending);
  v.runFrame();
  assert.equal(v.state.get(0x176e528), 0);
  assert.equal(v.state.variable(0x3404 / 4), 0);
  assert.equal(v.state.variable(0x3394 / 4), 0);
  assert.ok(v.pc(0) > start);
});
test('texture decode errors fault at the original opcode instead of blank-texture success', async () => {
  const {vm} = textureVm();
  const {Sc3Runtime} = await import('../dist/engines/mages/games/chaos-head-noah/sc3/runtime.js');
  const v = new Sc3Runtime(
    vm.platform,
    {...vm.assets, textures: {size: () => 8, read: async () => new Uint8Array(8)}},
    vm.options,
  );
  await v.boot();
  v.runFrame();
  await v.settleLoads();
  v.publishLoadCompletions();
  assert.throws(() => v.runFrame(), /PC 0x10.*Texture codec failed/);
  assert.equal(v.textures.resources.has(91), false);
  assert.equal(v.state.get(0x176e528), 1);
});
test('raw save-thumbnail upload clips into existing RGBA storage and obeys deferred visibility', () => {
  const s = new NoahState(() => 0),
    t = new NoahTextures(s),
    bytes = Uint8Array.of(9, 8, 7, 255, 6, 5, 4, 128, 3, 2, 1, 0);
  const before = s.bytes(a(209), SURFACE_STRIDE).slice();
  t.uploadRgba(209, bytes, 3, 1);
  assert.deepEqual(s.bytes(a(209), SURFACE_STRIDE), before);
  assert.equal(t.resources.size, 0);
  t.load(209, image(2, 2, Array(16).fill(77)));
  t.commit(209);
  t.uploadRgba(209, bytes, 3, 1);
  const r = t.resources.get(209);
  assert.deepEqual([...r.image.pixels], Array(16).fill(77));
  assert.deepEqual([...r.pending.pixels], [9, 8, 7, 255, 6, 5, 4, 128, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(s.bytes(a(209) + 0x120, 1)[0], 1);
  assert.equal(s.bytes(a(209) + 0x32, 1)[0], 0);
  const captured = r.image;
  s.put(0x1dd97e9, 1, 1);
  t.uploadRgba(209, bytes, 3, 1);
  assert.equal(r.pending, undefined);
  assert.equal(r.image.pixels[0], 9);
  assert.notEqual(r.image, captured);
  assert.deepEqual([...captured.pixels], Array(16).fill(77));
  assert.equal(s.bytes(a(209) + 0x32, 1)[0], 1);
});

test('thumbnail readback crops the captured staging image on the following host pump', () => {
  const s = new NoahState(() => 0),
    t = new NoahTextures(s);
  t.createRenderTarget(8, 208, 256, 135);
  const pixels = new Uint8Array(256 * 135 * 4);
  for (let y = 0; y < 135; y++)
    for (let x = 0; x < 256; x++) pixels.set([x, y, x ^ y, 255], (y * 256 + x) * 4);
  t.requestThumbnailReadback();
  t.advanceReadbacks();
  assert.equal(s.bytes(a(208) + 0x121, 1)[0], 2);
  t.publishRenderTarget(208, {width: 256, height: 135, pixels});
  assert.equal(s.bytes(0x587350, 4)[3], 0);
  t.publishRenderTarget(208, {width: 256, height: 135, pixels: new Uint8Array(pixels.length)});
  t.advanceReadbacks();
  const result = s.bytes(0x587350, 240 * 135 * 4);
  for (let y = 0; y < 135; y++)
    assert.deepEqual(
      result.subarray(y * 240 * 4, (y + 1) * 240 * 4),
      pixels.subarray(y * 256 * 4, (y * 256 + 240) * 4),
    );
  assert.equal(s.bytes(a(208) + 0x121, 1)[0], 255);
  assert.equal(s.view(a(208) + 0x168, 8).getBigUint64(0, true), 0n);
});

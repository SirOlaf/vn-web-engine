import test from 'node:test';
import assert from 'node:assert/strict';
import {D3d11Lifetime, D3d11Object} from '../dist/native/d3d11/runtime/com.js';
import {
  createBufferStorage,
  createTexture2DStorage,
} from '../dist/native/d3d11/runtime/resources.js';
import {gpuTextureByteLength} from '../dist/graphics/block-texture.js';
import {
  createShaderResourceViewStorage,
  createRenderTargetViewStorage,
  createDepthStencilViewStorage,
} from '../dist/native/d3d11/runtime/views.js';

const INVALID = 0x80070057 | 0;
const bufferDesc = (changes = {}) => ({
  byteWidth: 16,
  usage: 0,
  bindFlags: 1,
  cpuAccessFlags: 0,
  miscFlags: 0,
  structureByteStride: 0,
  ...changes,
});
const textureDesc = (changes = {}) => ({
  width: 4,
  height: 4,
  mipLevels: 1,
  arraySize: 1,
  format: 61,
  sampleDesc: {count: 1, quality: 0},
  usage: 0,
  bindFlags: 8,
  cpuAccessFlags: 0,
  miscFlags: 0,
  ...changes,
});
function owner(disposeBindings = () => {}) {
  const destroyed = [];
  const lifetime = new D3d11Lifetime(disposeBindings);
  const device = new D3d11Object(lifetime, [], () => destroyed.push('device'), true);
  return {lifetime, device, destroyed, resourceDestroyed: (resource) => destroyed.push(resource)};
}
const initial = (bytes, pitch = 0) => ({
  data: Uint8Array.from(bytes),
  rowPitch: pitch,
  slicePitch: 0,
});

function deferredOwner() {
  const host = owner(),
    pending = new Map(),
    synchronized = [];
  host.defer = (resource, value) => {
    resource.revision++;
    pending.set(resource, {revision: resource.revision, value});
  };
  host.synchronizeResource = (resource) => {
    synchronized.push(resource);
    const write = pending.get(resource);
    if (write && write.revision === resource.revision)
      for (const level of resource.levels) level.bytes.fill(write.value);
    pending.delete(resource);
  };
  return {...host, synchronized};
}

test('native resource CPU reads and preserving maps observe deferred device writes', () => {
  const host = deferredOwner();
  const texture = createTexture2DStorage(
    host,
    textureDesc({usage: 3, bindFlags: 0, cpuAccessFlags: 0x30000}),
    null,
  ).value;
  host.defer(texture, 17);
  const read = texture.map(0, 1, 0);
  assert.equal(read.hr, 0);
  assert.ok(read.value.data.every((n) => n === 17));
  texture.unmap(0);
  host.defer(texture, 42);
  const write = texture.map(0, 3, 0);
  assert.ok(write.value.data.every((n) => n === 42));
  write.value.data[5] = 9;
  texture.unmap(0);
  assert.deepEqual(
    [...texture.storage(0).bytes],
    [42, 42, 42, 42, 42, 9, 42, 42, 42, 42, 42, 42, 42, 42, 42, 42],
  );
  texture.release();
  host.device.release();
});

test('native partial updates and copies preserve deferred data while whole copies replace the destination', () => {
  const host = deferredOwner();
  const source = createTexture2DStorage(host, textureDesc(), null).value;
  const target = createTexture2DStorage(host, textureDesc(), null).value;
  host.defer(source, 7);
  source.update(
    0,
    {left: 1, top: 1, front: 0, right: 3, bottom: 2, back: 1},
    new Uint8Array([9, 10]),
    2,
  );
  assert.equal(source.storage(0).bytes[0], 7);
  assert.deepEqual([...source.storage(0).bytes.subarray(5, 7)], [9, 10]);
  host.defer(target, 3);
  target.copyFrom(0, 0, 0, 0, source, 0, {left: 1, top: 1, front: 0, right: 3, bottom: 2, back: 1});
  assert.deepEqual([...target.storage(0).bytes.subarray(0, 4)], [9, 10, 3, 3]);
  host.defer(source, 21);
  host.defer(target, 31);
  host.synchronized.length = 0;
  target.copyAllFrom(source);
  assert.deepEqual(host.synchronized, [source]);
  assert.ok(target.storage(0).bytes.every((n) => n === 21));
  source.release();
  target.release();
  host.device.release();
});

test('native invalid operations and WRITE_DISCARD do not synchronize bytes that will not be preserved', () => {
  const host = deferredOwner();
  const texture = createTexture2DStorage(host, textureDesc(), null).value;
  assert.throws(() => texture.update(0, null, new Uint8Array(1), 4), /Truncated/);
  assert.equal(texture.map(0, 1, 0).hr, INVALID);
  assert.deepEqual(host.synchronized, []);
  const dynamic = createTexture2DStorage(
    host,
    textureDesc({usage: 2, cpuAccessFlags: 0x10000, mipLevels: 2}),
    null,
  ).value;
  host.defer(dynamic, 77);
  const mapped = dynamic.map(0, 4, 0);
  assert.equal(mapped.hr, 0);
  assert.deepEqual(host.synchronized, []);
  mapped.value.data.fill(5);
  dynamic.unmap(0);
  assert.ok(dynamic.storage(0).bytes.every((n) => n === 5));
  assert.ok(dynamic.storage(1).bytes.every((n) => n === 0));
  texture.release();
  dynamic.release();
  host.device.release();
});

test('native Map(DO_NOT_WAIT) returns still-drawing before synchronization when the device is not ready', () => {
  const host = deferredOwner();
  const texture = createTexture2DStorage(
    host,
    textureDesc({usage: 3, bindFlags: 0, cpuAccessFlags: 0x20000}),
    null,
  ).value;
  host.defer(texture, 19);
  host.resourceReady = () => false;
  assert.deepEqual(texture.map(0, 1, 0x100000), {hr: 0x887a000a | 0, value: null});
  assert.deepEqual(host.synchronized, []);
  assert.equal(texture.levels[0].mapped, null);
  host.resourceReady = () => true;
  const mapped = texture.map(0, 1, 0x100000);
  assert.equal(mapped.hr, 0);
  assert.ok(mapped.value.data.every((n) => n === 19));
  texture.unmap(0);
  texture.release();
  host.device.release();
});

test('D3D11 resource creation owns descriptors/data and a child can reacquire its device', () => {
  const host = owner(),
    desc = textureDesc({width: 3, height: 2});
  const input = initial([1, 2, 3, 99, 4, 5, 6], 4);
  const {value: texture, hr} = createTexture2DStorage(host, desc, [input]);
  assert.equal(hr, 0);
  assert.deepEqual([...texture.storage(0).bytes], [1, 2, 3, 4, 5, 6]);
  input.data.fill(0);
  desc.sampleDesc.count = 8;
  desc.width = 99;
  const output = texture.getDesc();
  output.sampleDesc.count = 16;
  output.height = 99;
  assert.equal(texture.getDesc().sampleDesc.count, 1);
  assert.equal(texture.getDesc().width, 3);
  assert.equal(texture.getDesc().height, 2);
  assert.equal(texture.getType(), 3);
  assert.equal(texture.queryInterface('48570b85-d1ee-4fcd-a250-eb350722b037').hr, 0x80004002 | 0);
  const resource = texture.queryInterface('dc8e63f3-d12b-4952-b47b-5e45026a862d');
  assert.equal(resource.value, texture);
  resource.value.release();
  host.device.release();
  assert.equal(texture.getDevice(), host.device);
  host.device.release();
  assert.equal(host.lifetime.closed, false);
  texture.release();
  assert.deepEqual(host.destroyed, [texture, 'device']);
  assert.equal(host.lifetime.closed, true);
  assert.throws(() => texture.storage(0), /released/);
});

test('D3D11 dynamic vertex maps isolate borrowed writes and preserve untouched NO_OVERWRITE bytes', () => {
  const host = owner();
  const {value: buffer} = createBufferStorage(
    host,
    bufferDesc({usage: 2, cpuAccessFlags: 0x10000}),
    initial(Array.from({length: 16}, (_, i) => i)),
  );
  assert.equal(buffer.map(0, 1, 0).hr, INVALID);
  assert.equal(buffer.map(0, 4, 0x100000).hr, INVALID);
  const mapped = buffer.map(0, 5, 0).value;
  assert.equal(mapped.rowPitch, 16);
  assert.equal(mapped.depthPitch, 16);
  mapped.data.set([80, 81], 6);
  assert.equal(buffer.map(0, 2, 0).hr, INVALID);
  assert.throws(() => buffer.storage(0), /mapped/);
  buffer.unmap(0);
  assert.deepEqual(
    [...buffer.storage(0).bytes],
    [0, 1, 2, 3, 4, 5, 80, 81, 8, 9, 10, 11, 12, 13, 14, 15],
  );
  mapped.data.fill(255);
  assert.equal(buffer.storage(0).bytes[0], 0);
  assert.equal(buffer.revision, 1);
  const discarded = buffer.map(0, 4, 0).value;
  discarded.data.fill(42);
  buffer.unmap(0);
  assert.deepEqual([...buffer.storage(0).bytes], Array(16).fill(42));
  assert.throws(() => buffer.unmap(0), /unmapped/);
  buffer.release();
  host.device.release();
});

test('D3D11 updates snapshot padded rows, copy bounded regions and retain independent staging reads', () => {
  const host = owner();
  const a = createTexture2DStorage(host, textureDesc(), null).value;
  const b = createTexture2DStorage(host, textureDesc(), null).value;
  const staging = createTexture2DStorage(
    host,
    textureDesc({usage: 3, bindFlags: 0, cpuAccessFlags: 0x30000}),
    null,
  ).value;
  const input = Uint8Array.from([11, 12, 99, 21, 22]);
  a.update(0, {left: 1, top: 1, front: 0, right: 3, bottom: 3, back: 1}, input, 3);
  input.fill(0);
  b.copyFrom(0, 0, 0, 0, a, 0, {left: 1, top: 1, front: 0, right: 3, bottom: 3, back: 1});
  assert.deepEqual([...b.storage(0).bytes], [11, 12, 0, 0, 21, 22, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  staging.copyAllFrom(b);
  const read = staging.map(0, 1, 0x100000).value;
  assert.equal(read.data[4], 21);
  read.data.fill(255);
  staging.unmap(0);
  assert.equal(staging.storage(0).bytes[4], 21);
  const write = staging.map(0, 3, 0).value;
  write.data[4] = 84;
  staging.unmap(0);
  b.copyAllFrom(staging);
  assert.equal(b.storage(0).bytes[4], 84);
  assert.equal(a.storage(0).bytes[5], 11);
  assert.throws(() => b.copyFrom(0, 3, 0, 0, a, 0, null), /box/);
  assert.throws(() => b.copyFrom(0, 0, 0, 0, b, 0, null), /itself/);
  const previous = b.storage(0).bytes.slice();
  b.update(0, {left: 2, right: 2, top: 0, bottom: 4, front: 0, back: 1}, new Uint8Array(), 0);
  assert.deepEqual(b.storage(0).bytes, previous);
  for (const resource of [a, b, staging]) resource.release();
  host.device.release();
});

test('D3D11 block-compressed mip/array storage agrees with shared uploads and copies complete edge blocks', () => {
  const host = owner();
  for (const [format, gpu, blockBytes] of [
    [71, 'bc1', 8],
    [74, 'bc2', 16],
    [77, 'bc3', 16],
    [98, 'bc7', 16],
  ]) {
    const desc = textureDesc({width: 12, height: 12, mipLevels: 0, arraySize: 2, format});
    const inputs = [0, 1, 2, 3, 4, 5, 6, 7].map((index) => {
      const width = Math.max(1, 12 >> (index % 4)),
        height = Math.max(1, 12 >> (index % 4));
      const rowPitch = Math.ceil(width / 4) * blockBytes + 8;
      return initial(Array(Math.ceil(height / 4) * rowPitch).fill(index + 1), rowPitch);
    });
    const source = createTexture2DStorage(host, desc, inputs).value;
    const destination = createTexture2DStorage(host, desc, null).value;
    assert.equal(source.getDesc().mipLevels, 4);
    for (let i = 0; i < 8; i++) {
      const level = source.storage(i);
      assert.equal(level.bytes.length, gpuTextureByteLength(gpu, level.width, level.height));
      assert.ok(level.bytes.every((byte) => byte === i + 1));
    }
    destination.copyFrom(5, 4, 0, 0, source, 1, {
      left: 4,
      top: 0,
      front: 0,
      right: 6,
      bottom: 6,
      back: 1,
    });
    const level = destination.storage(5);
    assert.ok(level.bytes.subarray(blockBytes, blockBytes * 2).every((byte) => byte === 2));
    assert.ok(level.bytes.subarray(blockBytes * 3).every((byte) => byte === 2));
    assert.throws(
      () =>
        destination.update(
          0,
          {left: 1, top: 0, front: 0, right: 12, bottom: 12, back: 1},
          inputs[0].data,
          inputs[0].rowPitch,
        ),
      /box/,
    );
    destination.copyAllFrom(source);
    for (let i = 0; i < 8; i++)
      assert.deepEqual(destination.storage(i).bytes, source.storage(i).bytes);
    source.release();
    destination.release();
  }
  host.device.release();
});

test('D3D11 validation-only calls allocate no interface and reject unsupported or inconsistent resources', () => {
  const host = owner();
  assert.deepEqual(createBufferStorage(host, bufferDesc(), null, true), {hr: 1, value: null});
  assert.deepEqual(createTexture2DStorage(host, textureDesc(), null, true), {hr: 1, value: null});
  for (const changes of [
    {byteWidth: 0},
    {usage: 1},
    {bindFlags: 5},
    {bindFlags: 4, byteWidth: 15},
    {usage: 2},
    {usage: 3},
    {miscFlags: 64},
    {byteWidth: NaN},
  ]) {
    assert.equal(createBufferStorage(host, bufferDesc(changes), null, true).hr, INVALID);
  }
  for (const changes of [
    {width: 0},
    {format: 0},
    {sampleDesc: {count: 4, quality: 0}},
    {mipLevels: 99},
    {usage: 1},
    {usage: 3},
    {format: 71, bindFlags: 0x28},
    {format: 71, width: 7},
    {format: 45},
    {miscFlags: 1},
    {cpuAccessFlags: 1},
  ]) {
    assert.equal(createTexture2DStorage(host, textureDesc(changes), null, true).hr, INVALID);
  }
  assert.equal(createTexture2DStorage(host, textureDesc(), [initial([1, 2], 4)], true).hr, INVALID);
  assert.deepEqual(host.destroyed, []);
  host.device.release();
  assert.deepEqual(host.destroyed, ['device']);
});

test('D3D11 buffer boxes are byte-based and constant-buffer updates require the whole buffer', () => {
  const host = owner();
  const buffer = createBufferStorage(host, bufferDesc(), initial(Array(16).fill(1))).value;
  buffer.update(
    0,
    {left: 3, top: 0, front: 0, right: 6, bottom: 1, back: 1},
    Uint8Array.of(7, 8, 9),
    0,
  );
  assert.deepEqual([...buffer.storage(0).bytes.subarray(2, 7)], [1, 7, 8, 9, 1]);
  const constant = createBufferStorage(host, bufferDesc({bindFlags: 4}), null).value;
  assert.throws(
    () =>
      constant.update(
        0,
        {left: 0, top: 0, front: 0, right: 16, bottom: 1, back: 1},
        new Uint8Array(16),
        0,
      ),
    /cannot be updated/,
  );
  constant.update(0, null, new Uint8Array(16).fill(5), 0);
  assert.ok(constant.storage(0).bytes.every((byte) => byte === 5));
  buffer.release();
  constant.release();
  host.device.release();
});

test('D3D11 dynamic texture discard retires all old mip contents without permitting NO_OVERWRITE', () => {
  const host = owner();
  const texture = createTexture2DStorage(
    host,
    textureDesc({usage: 2, cpuAccessFlags: 0x10000, mipLevels: 0}),
    [initial(Array(16).fill(1), 4), initial(Array(4).fill(2), 2), initial([3], 1)],
  ).value;
  assert.equal(texture.map(1, 4, 0).hr, INVALID);
  assert.equal(texture.map(0, 5, 0).hr, INVALID);
  const top = texture.map(0, 4, 0).value;
  top.data.fill(7);
  texture.unmap(0);
  assert.ok(texture.storage(0).bytes.every((byte) => byte === 7));
  assert.ok(texture.storage(1).bytes.every((byte) => byte === 0));
  texture.release();
  host.device.release();
});

test('D3D11 texture views retain resources, copy descriptors and return independently owned resource handles', () => {
  const host = owner();
  const texture = createTexture2DStorage(
    host,
    textureDesc({bindFlags: 0x28, mipLevels: 0}),
    null,
  ).value;
  const desc = {
    format: 61,
    viewDimension: 4,
    texture2D: {mostDetailedMip: 1, mipLevels: 0xffffffff},
  };
  const srv = createShaderResourceViewStorage(host, texture, desc).value;
  const rtv = createRenderTargetViewStorage(host, texture, null).value;
  desc.texture2D.mostDetailedMip = 2;
  const returned = srv.getDesc();
  returned.texture2D.mostDetailedMip = 2;
  assert.deepEqual(srv.getDesc(), {
    format: 61,
    viewDimension: 4,
    texture2D: {mostDetailedMip: 1, mipLevels: 2},
  });
  assert.deepEqual(rtv.getDesc(), {format: 61, viewDimension: 4, texture2D: {mipSlice: 0}});
  assert.equal(srv.queryInterface('dfdba067-0b8d-4865-875b-d7b4516cc164').hr, 0x80004002 | 0);
  const base = srv.queryInterface('839d1216-bb2e-412b-b7f4-a9dbebe08ed1');
  assert.equal(base.value, srv);
  base.value.release();
  texture.release();
  host.device.release();
  const alias = srv.getResource();
  assert.equal(alias, texture);
  assert.equal(srv.getDevice(), host.device);
  host.device.release();
  srv.release();
  rtv.release();
  assert.deepEqual(host.destroyed, []);
  alias.release();
  assert.deepEqual(host.destroyed, [texture, 'device']);
  assert.throws(() => srv.getResource(), /released/);
});

test('D3D11 final caller release breaks a context/view/resource binding cycle', () => {
  let binding;
  const host = owner(() => binding.releaseBinding());
  const texture = createTexture2DStorage(host, textureDesc(), null).value;
  const srv = createShaderResourceViewStorage(host, texture, null).value;
  binding = srv;
  srv.retainBinding();
  texture.release();
  srv.release();
  assert.deepEqual(host.destroyed, []);
  host.device.release();
  assert.deepEqual(host.destroyed, [texture, 'device']);
  assert.equal(srv.live, false);
});

test('D3D11 view validation rejects foreign resources, missing bindings and incompatible mip/format descriptions', () => {
  const host = owner(),
    foreign = owner();
  const texture = createTexture2DStorage(host, textureDesc(), null).value;
  assert.deepEqual(createShaderResourceViewStorage(host, texture, null, true), {
    hr: 1,
    value: null,
  });
  assert.equal(createShaderResourceViewStorage(foreign, texture, null).hr, INVALID);
  assert.equal(createRenderTargetViewStorage(host, texture, null).hr, INVALID);
  assert.equal(createDepthStencilViewStorage(host, texture, null).hr, INVALID);
  for (const desc of [
    {format: 65, viewDimension: 4, texture2D: {mostDetailedMip: 0, mipLevels: 1}},
    {format: 61, viewDimension: 5, texture2D: {mostDetailedMip: 0, mipLevels: 1}},
    {format: 61, viewDimension: 4, texture2D: {mostDetailedMip: 1, mipLevels: 1}},
    {format: 61, viewDimension: 4, texture2D: {mostDetailedMip: 0, mipLevels: 0}},
  ])
    assert.equal(createShaderResourceViewStorage(host, texture, desc, true).hr, INVALID);
  const depth = createTexture2DStorage(
    host,
    textureDesc({format: 45, bindFlags: 0x40}),
    null,
  ).value;
  const dsv = createDepthStencilViewStorage(host, depth, null).value;
  assert.deepEqual(dsv.getDesc(), {
    format: 45,
    viewDimension: 3,
    flags: 0,
    texture2D: {mipSlice: 0},
  });
  assert.equal(
    createDepthStencilViewStorage(host, depth, {...dsv.getDesc(), flags: 4}, true).hr,
    INVALID,
  );
  assert.equal(
    createDepthStencilViewStorage(host, depth, {...dsv.getDesc(), texture2D: {mipSlice: 1}}, true)
      .hr,
    INVALID,
  );
  const colors = createTexture2DStorage(host, textureDesc({bindFlags: 0x28}), null).value;
  assert.equal(
    createRenderTargetViewStorage(
      host,
      colors,
      {format: 61, viewDimension: 4, texture2D: {mipSlice: 1}},
      true,
    ).hr,
    INVALID,
  );
  texture.release();
  assert.equal(createShaderResourceViewStorage(host, texture, null).hr, INVALID);
  colors.release();
  dsv.release();
  depth.release();
  host.device.release();
  foreign.device.release();
  assert.equal(host.lifetime.closed, true);
});

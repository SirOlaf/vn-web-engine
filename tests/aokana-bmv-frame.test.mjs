import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeBurikoBmvIndexedFrame} from '../dist/engines/buriko/native/bmv-frame.js';
import {decodeBurikoBfFrame} from '../dist/engines/buriko/native/bf-frame.js';
import {allocateBurikoBitmap} from '../dist/engines/buriko/native/bitmap.js';
import {BurikoBmvRegistry} from '../dist/engines/buriko/native/bmv-registry.js';
import {
  BurikoDistributedAllocator,
  BurikoDistributedProcessing,
} from '../dist/engines/buriko/native/distributed-processing.js';

function frame(version, color, alpha) {
  // Single-symbol DC/AC trees yield zero coefficients: neutral BGR128.
  const header = new Uint8Array(200),
    view = new DataView(header.buffer);
  header[0] = header[16] = 1;
  const row = color ? [1, 192, 1, 0, 0, 0] : [1, 0, 0, 0, 0];
  view.setUint32(192, 200, true);
  view.setUint32(196, 200 + row.length, true);
  const literals = Array.from({length: 8}, () => [0, ...new Array(8).fill(alpha)]).flat();
  return Uint8Array.from([
    ...header,
    ...row,
    ...(version === 0x10001 ? [1, 0, 0, 0] : []),
    ...literals,
  ]);
}
function movie(version) {
  const first = frame(version, true, 170),
    second = frame(version, false, 85),
    output = new Uint8Array(200 + first.length + second.length),
    view = new DataView(output.buffer);
  output.set(new TextEncoder().encode('BF_Movie_______\0'));
  view.setUint32(0x10, version, true);
  view.setUint32(0x14, 8, true);
  view.setUint32(0x18, 8, true);
  view.setUint32(0x1c, 32, true);
  view.setUint32(0x20, 1, true);
  view.setUint32(0x24, 40, true);
  view.setUint32(0x28, 2, true);
  output.fill(1, 0x40, 0xc0);
  view.setUint32(0xc0, 200, true);
  view.setUint32(0xc4, 200 + first.length, true);
  output.set(first, 200);
  output.set(second, 200 + first.length);
  return output;
}

test('registered modern BMV versions decode into actual retained bitmap storage', () => {
  const allocator = new BurikoDistributedAllocator(1),
    processing = new BurikoDistributedProcessing(allocator, 2),
    registry = new BurikoBmvRegistry(allocator);
  for (const version of [0x10000, 0x10001]) {
    const encoded = movie(version),
      handle = new Uint8Array(4),
      metadata = new Uint8Array(20);
    assert.equal(
      registry.register(
        {bytes: handle, offset: 0},
        {bytes: metadata, offset: 0},
        encoded,
        encoded.length,
      ),
      0,
    );
    const id = new DataView(handle.buffer).getUint32(0, true),
      resource = registry.find(id).resource,
      destination = allocateBurikoBitmap(8, 8, 1),
      backing = destination.storage.bytes;
    assert.equal(decodeBurikoBmvIndexedFrame(resource.bytes, 0, destination, processing), 0);
    assert.equal(destination.storage.bytes, backing);
    for (let pixel = 0; pixel < 64; pixel++)
      assert.deepEqual(
        Array.from(backing.subarray(pixel * 4, pixel * 4 + 4)),
        [128, 128, 128, 170],
      );
    destination.storage.range(0, 256, true);
    if (version === 0x10001) {
      const ordinaryDefault = decodeBurikoBfFrame(
        frame(version, true, 170),
        8,
        8,
        32,
        new Uint8Array(128).fill(1),
        processing,
      );
      assert.deepEqual(ordinaryDefault.bytes, backing);
      assert.deepEqual(ordinaryDefault.initialized, new Uint8Array(256).fill(1));
    }
    assert.deepEqual(destination.storage.initializedRange(0, 256), new Uint8Array(256).fill(1));
    assert.equal(decodeBurikoBmvIndexedFrame(resource.bytes, 1, destination, processing), 0);
    for (let pixel = 0; pixel < 64; pixel++)
      assert.deepEqual(Array.from(backing.subarray(pixel * 4, pixel * 4 + 4)), [128, 128, 128, 85]);
    assert.equal(registry.remove(id), 0);
  }
});

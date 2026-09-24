import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaBitmapCompositor} from '../dist/engines/buriko/games/aokana/native/bitmap-compositor.js';
import {
  bitmapRead32,
  bitmapWrite32,
} from '../dist/engines/buriko/games/aokana/native/bitmap-scalar.js';
import {AokanaDistributedAllocator} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {AokanaNativeFonts} from '../dist/engines/buriko/games/aokana/native/fonts.js';
import {createGroup90RawSurfaceExport} from '../dist/engines/buriko/games/aokana/native/group-90-raw-surface-export.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';
import {AokanaRawSurfaceExport} from '../dist/engines/buriko/games/aokana/native/raw-surface-export.js';
import {AokanaSurfaces} from '../dist/engines/buriko/games/aokana/native/surfaces.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';

test('90:15 exports packed BGR pixels into BP memory for a real raw surface import', () => {
  const text = new AokanaNativeText(),
    compositor = new AokanaBitmapCompositor(),
    surfaces = new AokanaSurfaces(
      new AokanaNativeFonts(text),
      compositor,
      new AokanaDistributedAllocator(2),
    ),
    memory = new AokanaBpMemory(new Uint8Array(128)),
    thread = new AokanaBpThread({id: 1, operandCapacity: 8, moduleCapacity: 0, frameCapacity: 0}),
    slot = createGroup90RawSurfaceExport(new AokanaRawSurfaceExport(surfaces), {
      threadFatal() {
        assert.fail('ordinary raw surface export');
      },
    })[0];
  assert.equal(slot.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[0x90][0x15]);
  assert.equal(surfaces.allocate(0, 2, 2, 1), 1);
  const source = surfaces.snapshot(0),
    original = [0xaa112233, 0xbb445566, 0xcc778899, 0xddaabbcc];
  original.forEach((pixel, i) => bitmapWrite32(source, source.offset + i * 4, pixel));
  [64, 32, 64, 0].forEach((value) => push32(thread, value));
  assert.equal(slot.execute({thread, memory, diagnostics: {}}), 0);
  assert.equal(thread.stackIndex, 0);
  assert.equal(new DataView(memory.globalMemory.buffer).getUint32(32, true), 12);
  assert.deepEqual(
    Array.from(memory.globalMemory.subarray(64, 76)),
    [0x33, 0x22, 0x11, 0x66, 0x55, 0x44, 0x99, 0x88, 0x77, 0xcc, 0xbb, 0xaa],
  );
  assert.deepEqual(
    original.map((_, i) => bitmapRead32(source, source.offset + i * 4)),
    original,
  );
  assert.equal(surfaces.importRaw(1, 2, 2, 1, {bytes: memory.globalMemory, offset: 64}), 1);
  const imported = surfaces.snapshot(1);
  assert.deepEqual(
    original.map((_, i) => bitmapRead32(imported, imported.offset + i * 4)),
    [0x112233, 0x445566, 0x778899, 0xaabbcc],
  );
});

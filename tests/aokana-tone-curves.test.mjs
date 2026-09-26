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
import {createGroup90ToneCurves} from '../dist/engines/buriko/games/aokana/native/group-90-tone-curves.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';
import {AokanaRawSurfaceExport} from '../dist/engines/buriko/games/aokana/native/raw-surface-export.js';
import {AokanaSurfaces} from '../dist/engines/buriko/games/aokana/native/surfaces.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';

test('90:CC/CD live tone curves transform RGB and RGBA pair/tail pixels consumed by raw export', () => {
  const text = new AokanaNativeText(),
    surfaces = new AokanaSurfaces(
      new AokanaNativeFonts(text),
      new AokanaBitmapCompositor(),
      new AokanaDistributedAllocator(1),
    ),
    memory = new AokanaBpMemory(new Uint8Array(256)),
    thread = new AokanaBpThread({id: 1, operandCapacity: 16, moduleCapacity: 0, frameCapacity: 0}),
    slots = createGroup90ToneCurves(surfaces, {
      threadFatal() {
        assert.fail('ordinary tone curve');
      },
    }),
    view = new DataView(memory.globalMemory.buffer),
    call = (secondary, args) => {
      const slot = slots.find((item) => item.secondary === secondary);
      assert.equal(slot.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[0x90][secondary]);
      args.forEach((arg) => push32(thread, arg));
      assert.equal(slot.execute({thread, memory, diagnostics: {}}), 0);
      assert.equal(thread.stackIndex, 0);
    },
    pixels = (index) => {
      const b = surfaces.snapshot(index);
      return [0, 1, 2].map((i) => bitmapRead32(b, b.offset + i * 4));
    };
  [63, 96, 127, 160, 191, 224].forEach((n, i) => view.setUint32(32 + i * 4, n, true));
  call(0xcc, [17, 32]);
  const rgb = [0x11ffffff, 0x22000000, 0x33ffffff],
    rgba = [0xffffffff, 0x80000000, 0x40ffffff];
  for (const [index, format, values] of [
    [0, 1, rgb],
    [1, 2, rgba],
  ]) {
    assert.equal(surfaces.allocate(index, 3, 1, format), 1);
    const bitmap = surfaces.snapshot(index);
    values.forEach((value, i) => bitmapWrite32(bitmap, bitmap.offset + i * 4, value));
  }
  // White luminance65280 times monoRGB(64,128,192)>>16 hits x=(63,127,191).
  // Curve ordinates(96,160,224) then filmRGB(32,64,128) give RGB(24,114,225).
  call(0xcd, [2, 0, 0x4080c0, 256, 17, 0x204080, 8, 256]);
  call(0xcd, [3, 1, 0x4080c0, 256, 17, 0x204080, 38, 256]);
  assert.deepEqual(pixels(2), [0x1872e1, 0, 0x1872e1]);
  assert.deepEqual(pixels(3), [0xff1872e1, 0x80000000, 0x401872e1]);
  assert.deepEqual(pixels(0), rgb);
  assert.deepEqual(pixels(1), rgba);
  // Updating this live key to ordinates128 gives film RGB(34,66,129).
  for (const offset of [36, 44, 52]) view.setUint32(offset, 128, true);
  call(0xcc, [17, 32]);
  call(0xcd, [4, 1, 0x4080c0, 256, 17, 0x204080, 8, 256]);
  assert.deepEqual(pixels(4), [0xff224281, 0x80000000, 0x40224281]);
  assert.equal(
    new AokanaRawSurfaceExport(surfaces).export(
      {bytes: memory.globalMemory, offset: 128},
      {bytes: memory.globalMemory, offset: 112},
      64,
      4,
    ),
    0,
  );
  assert.equal(view.getUint32(112, true), 12);
  assert.deepEqual(
    Array.from(memory.globalMemory.subarray(128, 140)),
    [129, 66, 34, 255, 0, 0, 0, 128, 129, 66, 34, 64],
  );
  call(0xcc, [17, 0]);
  assert.equal(surfaces.toneCurves.find(17), null);
});

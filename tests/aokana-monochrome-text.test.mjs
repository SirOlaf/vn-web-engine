import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, pop32, push32} from '../dist/engines/buriko/bp/state.js';
import {BurikoBitmapCompositor} from '../dist/engines/buriko/native/bitmap-compositor.js';
import {BurikoBrowserFontFace} from '../dist/engines/buriko/native/font-browser.js';
import {BurikoDistributedAllocator} from '../dist/engines/buriko/native/distributed-processing.js';
import {BurikoNativeFonts} from '../dist/engines/buriko/native/fonts.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';
import {BurikoSurfaces} from '../dist/engines/buriko/native/surfaces.js';
import {BurikoMonochromeSurfaceText} from '../dist/engines/buriko/native/surface-monochrome-text.js';
import {createGroup92MonochromeText} from '../dist/engines/buriko/native/group-92-monochrome-text.js';
import {BURIKO_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/native/inventory.js';

test('monochrome cache renders mixed-width text with percentage lines and wrapping', async () => {
  const text = new BurikoNativeText();
  const fonts = new BurikoNativeFonts(text, {
    async queryCharset() {
      return 128;
    },
    async create(parameters) {
      assert.deepEqual(parameters, {
        face: '等幅',
        height: 8,
        width: 4,
        weight: 700,
        italic: false,
        charset: 128,
        pitchAndFamily: 1,
      });
      return {
        // Only the host coverage primitive is synthetic; actual packed-DIB conversion is shared.
        rasterText(value, width, height) {
          const bytes = new Uint8Array(width * height);
          assert.equal(width, 32);
          assert.equal(height, 8);
          if (value === 'A') bytes[0] = 255;
          else if (value === '漢') bytes[width + 1] = 255;
          else assert.fail('ordinary fixture glyph');
          return {bytes, stride: width};
        },
        rasterMonochrome: BurikoBrowserFontFace.prototype.rasterMonochrome,
      };
    },
  });
  const registeredFont = fonts.registerName(text.encodeWide('等幅', 0), 0);
  const compositor = new BurikoBitmapCompositor();
  compositor.defaultFormat = 1;
  const surfaces = new BurikoSurfaces(fonts, compositor, new BurikoDistributedAllocator(1));
  assert.equal(surfaces.allocate(1, 16, 16, 1), 1);
  surfaces.fill(1, 0);
  const service = new BurikoMonochromeSurfaceText(surfaces);
  const [slot] = createGroup92MonochromeText(service, {
    threadFatal() {
      assert.fail('ordinary monochrome text operation');
    },
  });
  assert.equal(slot.primary, 0x92);
  assert.equal(slot.secondary, 0x1e);
  assert.equal(slot.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[0x92][0x1e]);
  const thread = new BurikoBpThread({
    id: 1,
    operandCapacity: 16,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const memory = new BurikoBpMemory(new Uint8Array(128));
  memory.globalMemory.set(text.encodeWide('A\x03\x32\n漢\x04AA', 1), 16);
  const context = {thread, memory, diagnostics: {}};
  for (const value of [1, 0, 0, 16, registeredFont, 8, 1, 1, 0x203040]) push32(thread, value);
  assert.equal(await slot.execute(context), 0);
  assert.equal(pop32(thread), 24); // 4+1,8+1,4+1,4+1 across both line advances.
  assert.equal(thread.stackIndex, 0);
  const bitmap = surfaces.snapshot(1);
  const colored = new Set([0, 5 * 16 + 1, 4 * 16 + 9, 8 * 16]);
  assert.deepEqual(
    Array.from({length: 256}, (_, index) =>
      bitmap.storage.view.getUint32(
        bitmap.offset + Math.floor(index / 16) * bitmap.stride + (index % 16) * 4,
        true,
      ),
    ),
    Array.from({length: 256}, (_, index) => (colored.has(index) ? 0x203040 : 0)),
  );
  service.dispose();
});

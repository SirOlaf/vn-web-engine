import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaBitmapCompositor} from '../dist/engines/buriko/games/aokana/native/bitmap-compositor.js';
import {AokanaBrowserFontFace} from '../dist/engines/buriko/games/aokana/native/font-browser.js';
import {AokanaDistributedAllocator} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {AokanaNativeFonts} from '../dist/engines/buriko/games/aokana/native/fonts.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {AokanaSurfaces} from '../dist/engines/buriko/games/aokana/native/surfaces.js';
import {AokanaMonochromeSurfaceText} from '../dist/engines/buriko/games/aokana/native/surface-monochrome-text.js';
import {createGroup92MonochromeText} from '../dist/engines/buriko/games/aokana/native/group-92-monochrome-text.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';

test('monochrome cache renders mixed-width text with percentage lines and wrapping', async () => {
  const text = new AokanaNativeText();
  const fonts = new AokanaNativeFonts(text, {
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
        rasterMonochrome: AokanaBrowserFontFace.prototype.rasterMonochrome,
      };
    },
  });
  const registeredFont = fonts.registerName(text.encodeWide('等幅', 0), 0);
  const compositor = new AokanaBitmapCompositor();
  compositor.defaultFormat = 1;
  const surfaces = new AokanaSurfaces(fonts, compositor, new AokanaDistributedAllocator(1));
  assert.equal(surfaces.allocate(1, 16, 16, 1), 1);
  surfaces.fill(1, 0);
  const service = new AokanaMonochromeSurfaceText(surfaces);
  const [slot] = createGroup92MonochromeText(service, {
    threadFatal() {
      assert.fail('ordinary monochrome text operation');
    },
  });
  assert.equal(slot.primary, 0x92);
  assert.equal(slot.secondary, 0x1e);
  assert.equal(slot.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[0x92][0x1e]);
  const thread = new AokanaBpThread({
    id: 1,
    operandCapacity: 16,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const memory = new AokanaBpMemory(new Uint8Array(128));
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

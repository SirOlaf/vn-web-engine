import test from 'node:test';
import assert from 'node:assert/strict';
import {BlobSource} from '../dist/core/source.js';
import {SourceFileSystem} from '../dist/platform/filesystem.js';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, pop32, push32} from '../dist/engines/buriko/bp/state.js';
import {
  BurikoProgramFiles,
  BurikoProgramMedia,
} from '../dist/engines/buriko/native/program-files.js';
import {BurikoMountedProgramPaths} from '../dist/engines/buriko/native/program-paths.js';
import {BurikoProgramResources} from '../dist/engines/buriko/native/program-resources.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';
import {
  BurikoDistributedAllocator,
  BurikoDistributedProcessing,
} from '../dist/engines/buriko/native/distributed-processing.js';
import {BurikoEngineErrors} from '../dist/engines/buriko/native/engine-errors.js';
import {BurikoEngineDialogs} from '../dist/engines/buriko/native/engine-dialogs.js';
import {BurikoBitmapCompositor} from '../dist/engines/buriko/native/bitmap-compositor.js';
import {BurikoNativeFonts} from '../dist/engines/buriko/native/fonts.js';
import {BurikoSurfaces} from '../dist/engines/buriko/native/surfaces.js';
import {createGroup92ImmediateBmp} from '../dist/engines/buriko/native/group-92-immediate-bmp.js';
import {BURIKO_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/native/inventory.js';

test('immediate BMP opcode loads a qualified mounted file and copies its bottom-up padded pixels', async () => {
  const bmp = new Uint8Array(70),
    header = new DataView(bmp.buffer);
  header.setUint16(0, 0x4d42, true);
  header.setUint32(2, bmp.length, true);
  header.setUint32(10, 54, true);
  header.setUint32(14, 40, true);
  header.setInt32(18, 2, true);
  header.setInt32(22, 2, true);
  header.setUint16(26, 1, true);
  header.setUint16(28, 24, true);
  header.setUint32(34, 16, true);
  // Stored bottom row blue/white, top row red/green, each with two padding bytes.
  bmp.set([255, 0, 0, 255, 255, 255, 0xa5, 0xa5, 0, 0, 255, 0, 255, 0, 0xa5, 0xa5], 54);
  const backing = new SourceFileSystem((path) => path.toLowerCase());
  backing.attach('/images/ordinary.bmp', new BlobSource(new Blob([bmp])));
  const text = new BurikoNativeText(),
    media = new BurikoProgramMedia();
  media.setDriveType(2, 3);
  const files = new BurikoProgramFiles(
    backing,
    text,
    media,
    new BurikoMountedProgramPaths([{native: 'C:\\', mounted: '/'}], 'C:\\game'),
  );
  const dialogs = new BurikoEngineDialogs();
  const errors = new BurikoEngineErrors(files, dialogs, Uint8Array.of(0), Uint8Array.of(0));
  const allocator = new BurikoDistributedAllocator(1);
  const resources = new BurikoProgramResources(
    files,
    {
      nativeFileRoot: 'C:\\primary\\',
      primaryRoot: text.encodeWide('C:\\primary\\', 1),
      secondaryRoot: text.encodeWide('C:\\secondary\\', 1),
      secondaryMediaPath: 'C:\\secondary\\',
      searchDirectoriesEnabled: 1,
      searchDirectories: [text.encodeWide('other', 1)],
      retryTitle: Uint8Array.of(0),
      retryMessage: Uint8Array.of(0),
      quitConfirmation: Uint8Array.of(0),
    },
    dialogs,
    errors,
    new BurikoDistributedProcessing(allocator, 1),
  );
  const surfaces = new BurikoSurfaces(
    new BurikoNativeFonts(text),
    new BurikoBitmapCompositor(),
    allocator,
  );
  const memory = new BurikoBpMemory(new Uint8Array(128));
  memory.globalMemory.set(text.encodeWide('C:\\images\\ordinary.bmp', 1), 16);
  const thread = new BurikoBpThread({
    id: 1,
    operandCapacity: 16,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const [slot] = createGroup92ImmediateBmp(surfaces, resources);
  assert.equal(slot.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[0x92][0x1f]);
  push32(thread, 1);
  push32(thread, 16);
  assert.equal(await slot.execute({thread, memory, diagnostics: {}}), 0);
  assert.equal(pop32(thread), 0);
  assert.equal(thread.stackIndex, 0);
  const pixels = (surface) =>
    [0, 1, 2, 3].map((index) => {
      assert.equal(
        surfaces.readPixel({bytes: memory.globalMemory, offset: 8}, surface, index % 2, index >> 1),
        0,
      );
      return new DataView(memory.globalMemory.buffer).getUint32(8, true);
    });
  assert.deepEqual(pixels(1), [0xff0000, 0x00ff00, 0x0000ff, 0xffffff]);
  assert.equal(surfaces.importRaw(2, 2, 2, 1, {bytes: new Uint8Array(12), offset: 0}), 1);
  assert.equal(surfaces.drawSurface(2, 0, 0, 1, 0x80, 0), 0);
  assert.deepEqual(pixels(2), [0xff0000, 0x00ff00, 0x0000ff, 0xffffff]);
});

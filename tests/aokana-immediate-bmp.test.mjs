import test from 'node:test';
import assert from 'node:assert/strict';
import {BlobSource} from '../dist/core/source.js';
import {SourceFileSystem} from '../dist/platform/filesystem.js';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {
  AokanaProgramFiles,
  AokanaProgramMedia,
} from '../dist/engines/buriko/games/aokana/native/program-files.js';
import {AokanaMountedProgramPaths} from '../dist/engines/buriko/games/aokana/native/program-paths.js';
import {AokanaProgramResources} from '../dist/engines/buriko/games/aokana/native/program-resources.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {
  AokanaDistributedAllocator,
  AokanaDistributedProcessing,
} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {AokanaEngineErrors} from '../dist/engines/buriko/games/aokana/native/engine-errors.js';
import {AokanaEngineDialogs} from '../dist/engines/buriko/games/aokana/native/engine-dialogs.js';
import {AokanaBitmapCompositor} from '../dist/engines/buriko/games/aokana/native/bitmap-compositor.js';
import {AokanaNativeFonts} from '../dist/engines/buriko/games/aokana/native/fonts.js';
import {AokanaSurfaces} from '../dist/engines/buriko/games/aokana/native/surfaces.js';
import {createGroup92ImmediateBmp} from '../dist/engines/buriko/games/aokana/native/group-92-immediate-bmp.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';

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
  const text = new AokanaNativeText(),
    media = new AokanaProgramMedia();
  media.setDriveType(2, 3);
  const files = new AokanaProgramFiles(
    backing,
    text,
    media,
    new AokanaMountedProgramPaths([{native: 'C:\\', mounted: '/'}], 'C:\\game'),
  );
  const dialogs = new AokanaEngineDialogs();
  const errors = new AokanaEngineErrors(files, dialogs, Uint8Array.of(0), Uint8Array.of(0));
  const allocator = new AokanaDistributedAllocator(1);
  const resources = new AokanaProgramResources(
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
    new AokanaDistributedProcessing(allocator, 1),
  );
  const surfaces = new AokanaSurfaces(
    new AokanaNativeFonts(text),
    new AokanaBitmapCompositor(),
    allocator,
  );
  const memory = new AokanaBpMemory(new Uint8Array(128));
  memory.globalMemory.set(text.encodeWide('C:\\images\\ordinary.bmp', 1), 16);
  const thread = new AokanaBpThread({
    id: 1,
    operandCapacity: 16,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const [slot] = createGroup92ImmediateBmp(surfaces, resources);
  assert.equal(slot.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[0x92][0x1f]);
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

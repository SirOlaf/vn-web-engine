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
import {createGroup80ResourceRead} from '../dist/engines/buriko/games/aokana/native/group-80-resource-read.js';
import {
  AokanaDistributedAllocator,
  AokanaDistributedProcessing,
} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {AokanaEngineErrors} from '../dist/engines/buriko/games/aokana/native/engine-errors.js';
import {AokanaEngineDialogs} from '../dist/engines/buriko/games/aokana/native/engine-dialogs.js';
import {modernCbg, legacyCbg, singleArchive} from './aokana-resource-direct-fixtures.mjs';

test('80:30/31 decode into actual BP caller bytes through loose and archive owners with exact slice results', async () => {
  const backing = new SourceFileSystem((path) => path.toLowerCase());
  backing.attach('/game/Motion.cbg', new BlobSource(new Blob([modernCbg(8, 8, 32, true)])));
  backing.attach(
    '/game/Pack.arc',
    new BlobSource(new Blob([singleArchive('Legacy', legacyCbg())])),
  );
  backing.attach('/game/Raw.bin', new BlobSource(new Blob([Uint8Array.of(8, 9, 10, 11)])));
  const text = new AokanaNativeText(),
    media = new AokanaProgramMedia();
  media.setDriveType(2, 3);
  const files = new AokanaProgramFiles(
    backing,
    text,
    media,
    new AokanaMountedProgramPaths([{native: 'C:\\', mounted: '/'}], 'C:\\game'),
  );
  // Actual resource owners remain composed; successful resources do not enter modal/retry UI.
  const dialogs = new AokanaEngineDialogs(),
    errors = new AokanaEngineErrors(files, dialogs, Uint8Array.of(0), Uint8Array.of(0));
  const processing = new AokanaDistributedProcessing(new AokanaDistributedAllocator(1), 1);
  const resources = new AokanaProgramResources(
    files,
    {
      nativeFileRoot: 'C:\\game\\',
      primaryRoot: text.encodeWide('C:\\game\\', 1),
      secondaryRoot: Uint8Array.of(0),
      secondaryMediaPath: '',
      searchDirectoriesEnabled: 0,
      searchDirectories: [],
      retryTitle: Uint8Array.of(0),
      retryMessage: Uint8Array.of(0),
      quitConfirmation: Uint8Array.of(0),
    },
    dialogs,
    errors,
    processing,
  );
  const bytes = new Uint8Array(4096),
    memory = new AokanaBpMemory(bytes),
    thread = new AokanaBpThread({
      id: 1,
      operandCapacity: 16,
      moduleCapacity: 16,
      frameCapacity: 16,
    }),
    slots = createGroup80ResourceRead(resources);
  const put = (offset, value) => bytes.set(text.encodeWide(value, 1), offset);
  const invoke = async (slot, ...args) => {
    for (const value of args) push32(thread, value);
    assert.equal(await slots.find((s) => s.secondary === slot).execute({thread, memory}), 0);
    const result = pop32(thread);
    assert.equal(thread.stackIndex, 0);
    return result;
  };
  put(32, 'Motion.cbg');
  for (let i = 1040; i < 1296; i += 4) bytes.set([19, 37, 53, 73], i);
  assert.equal(await invoke(0x30, 1024, 0, 32), 272);
  assert.equal(new DataView(bytes.buffer).getUint16(1024, true), 8);
  for (let i = 1040; i < 1296; i += 4)
    assert.deepEqual(Array.from(bytes.subarray(i, i + 4)), [19, 37, 53, 170]);
  assert.equal(await invoke(0x31, 1024, 0, 32, 0, 0), 0);
  for (let i = 1040; i < 1296; i += 4)
    assert.deepEqual(Array.from(bytes.subarray(i, i + 4)), [19, 37, 53, 170]);
  put(32, 'Legacy');
  put(256, 'Pack.arc');
  assert.equal(await invoke(0x30, 2048, 256, 32), 24);
  assert.deepEqual(Array.from(bytes.subarray(2064, 2072)), [1, 1, 1, 0, 2, 2, 2, 0]);
  assert.equal(new DataView(bytes.buffer).getUint16(2052, true), 32);
  assert.equal(await invoke(0x31, 2500, 256, 32, 20, 4), 0);
  assert.deepEqual(Array.from(bytes.subarray(2500, 2504)), [2, 2, 2, 0]);
  put(32, 'Raw.bin');
  assert.equal(await invoke(0x31, 2600, 0, 32, 1, 2), 0);
  assert.deepEqual(Array.from(bytes.subarray(2600, 2602)), [9, 10]);
  assert.equal(
    await resources.size(text.encodeWide('Pack.arc', 1), text.encodeWide('Legacy', 1)),
    24,
  );
  assert.deepEqual(
    Array.from(
      (
        await resources.readModule(
          text.encodeWide('Pack.arc', 1),
          text.encodeWide('Legacy', 1),
          false,
        )
      ).subarray(16),
    ),
    [1, 1, 1, 0, 2, 2, 2, 0],
  );
  processing.dispose();
});

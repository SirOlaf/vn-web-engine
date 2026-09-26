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
import {createGroup80ResourceRead} from '../dist/engines/buriko/native/group-80-resource-read.js';
import {
  BurikoDistributedAllocator,
  BurikoDistributedProcessing,
} from '../dist/engines/buriko/native/distributed-processing.js';
import {BurikoEngineErrors} from '../dist/engines/buriko/native/engine-errors.js';
import {BurikoEngineDialogs} from '../dist/engines/buriko/native/engine-dialogs.js';
import {modernCbg, legacyCbg, singleArchive} from './aokana-resource-direct-fixtures.mjs';

test('80:30/31 decode into actual BP caller bytes through loose and archive owners with exact slice results', async () => {
  const backing = new SourceFileSystem((path) => path.toLowerCase());
  backing.attach('/game/Motion.cbg', new BlobSource(new Blob([modernCbg(8, 8, 32, true)])));
  backing.attach(
    '/game/Pack.arc',
    new BlobSource(new Blob([singleArchive('Legacy', legacyCbg())])),
  );
  backing.attach('/game/Raw.bin', new BlobSource(new Blob([Uint8Array.of(8, 9, 10, 11)])));
  const text = new BurikoNativeText(),
    media = new BurikoProgramMedia();
  media.setDriveType(2, 3);
  const files = new BurikoProgramFiles(
    backing,
    text,
    media,
    new BurikoMountedProgramPaths([{native: 'C:\\', mounted: '/'}], 'C:\\game'),
  );
  // Actual resource owners remain composed; successful resources do not enter modal/retry UI.
  const dialogs = new BurikoEngineDialogs(),
    errors = new BurikoEngineErrors(files, dialogs, Uint8Array.of(0), Uint8Array.of(0));
  const processing = new BurikoDistributedProcessing(new BurikoDistributedAllocator(1), 1);
  const resources = new BurikoProgramResources(
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
    memory = new BurikoBpMemory(bytes),
    thread = new BurikoBpThread({
      id: 1,
      operandCapacity: 16,
      moduleCapacity: 16,
      frameCapacity: 16,
    }),
    slots = createGroup80ResourceRead(resources);
  const actor = {},
    observedActors = [],
    load = resources.load.bind(resources),
    loadPartial = resources.loadPartial.bind(resources);
  resources.load = (...args) => {
    observedActors.push(args[4]);
    return load(...args);
  };
  resources.loadPartial = (...args) => {
    observedActors.push(args[5]);
    return loadPartial(...args);
  };
  const put = (offset, value) => bytes.set(text.encodeWide(value, 1), offset);
  const invoke = async (slot, ...args) => {
    for (const value of args) push32(thread, value);
    assert.equal(await slots.find((s) => s.secondary === slot).execute({thread, memory, actor}), 0);
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
  assert.equal(observedActors.length, 5);
  assert.ok(observedActors.every((value) => value === actor));
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

import test from 'node:test';
import assert from 'node:assert/strict';
import {BlobSource} from '../dist/core/source.js';
import {SourceFileSystem} from '../dist/platform/filesystem.js';
import {WindowsFileSystem, windowsFileKey} from '../dist/platform/windows-filesystem.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {
  AokanaProgramFiles,
  AokanaProgramMedia,
} from '../dist/engines/buriko/games/aokana/native/program-files.js';
import {AokanaProgramResources} from '../dist/engines/buriko/games/aokana/native/program-resources.js';
import {AokanaResourceLoadingState} from '../dist/engines/buriko/games/aokana/native/resource-loading.js';
import {
  AokanaDistributedAllocator,
  AokanaDistributedProcessing,
} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {modernCbg, singleArchive} from './aokana-resource-direct-fixtures.mjs';
const bytes = (value) => new TextEncoder().encode(value);

test('actual resource FIFO decodes initialized loose and archive CBG with a captured worker actor', async () => {
  const sources = new SourceFileSystem(windowsFileKey),
    fs = new WindowsFileSystem(sources, {
      cwd: 'C:\\game',
      mounts: [{windows: 'C:\\', virtual: '/'}],
    }),
    media = new AokanaProgramMedia();
  media.setDriveType(2, 3);
  const files = new AokanaProgramFiles(fs, new AokanaNativeText(), media),
    allocator = new AokanaDistributedAllocator(2),
    mainActor = allocator.currentActor,
    workerActor = {},
    processing = new AokanaDistributedProcessing(allocator, 2),
    unavailable = () => assert.fail('ordinary initialized resource fixture'),
    resources = new AokanaProgramResources(
      files,
      {
        nativeFileRoot: 'C:\\game\\',
        primaryRoot: bytes('C:\\game\\'),
        secondaryRoot: bytes('C:\\disc\\'),
        secondaryMediaPath: 'C:\\disc\\',
        searchDirectoriesEnabled: 0,
        searchDirectories: [],
        retryTitle: bytes('Media'),
        retryMessage: bytes('Insert'),
        quitConfirmation: bytes('Quit?'),
      },
      {show: unavailable},
      {fatal: unavailable},
      processing,
    ),
    loading = new AokanaResourceLoadingState(resources),
    encoded = modernCbg();
  sources.attach('/game/image', new BlobSource(new Blob([encoded])));
  sources.attach('/game/data.arc', new BlobSource(new Blob([singleArchive('entry', encoded)])));
  const first = {bytes: null},
    second = {bytes: null},
    firstResult = {value: 0},
    secondResult = {value: 0};
  try {
    loading.enqueueOwned(first, firstResult, null, bytes('image'));
    loading.enqueueOwned(second, secondResult, bytes('data.arc'), bytes('entry'));
    assert.equal(await loading.processNext(workerActor), true);
    assert.equal(firstResult.value, 272);
    assert.equal(second.bytes, null);
    assert.equal(await loading.processNext(workerActor), true);
    assert.equal(secondResult.value, 272);
    for (const output of [first.bytes, second.bytes]) {
      const header = new DataView(output.buffer, output.byteOffset, output.byteLength);
      assert.equal(header.getUint16(0, true), 8);
      assert.equal(header.getUint16(2, true), 8);
      for (let offset = 16; offset < 272; offset += 4)
        assert.deepEqual([...output.subarray(offset, offset + 4)], [128, 128, 128, 170]);
    }
    assert.equal(loading.hasPending, false);
    assert.equal(allocator.currentActor, mainActor);
  } finally {
    processing.dispose();
  }
});

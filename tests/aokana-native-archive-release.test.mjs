import test from 'node:test';
import assert from 'node:assert/strict';
import {BlobSource} from '../dist/core/source.js';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {
  AokanaDistributedAllocator,
  AokanaDistributedProcessing,
} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {createGroup81ArchiveRelease} from '../dist/engines/buriko/games/aokana/native/group-81-archive-release.js';
import {
  AokanaProgramFiles,
  AokanaProgramMedia,
} from '../dist/engines/buriko/games/aokana/native/program-files.js';
import {AokanaProgramResources} from '../dist/engines/buriko/games/aokana/native/program-resources.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';
import {SourceFileSystem} from '../dist/platform/filesystem.js';
import {WindowsFileSystem, windowsFileKey} from '../dist/platform/windows-filesystem.js';

const bytes = (value) => new TextEncoder().encode(value);

function archive() {
  const output = new Uint8Array(144),
    view = new DataView(output.buffer);
  output.set(bytes('BURIKO ARC20'));
  view.setUint32(12, 1, true);
  output.set(bytes('entry'), 16);
  view.setUint32(112, 0, true);
  view.setUint32(116, 0, true);
  return output;
}

function setup() {
  const sources = new SourceFileSystem(windowsFileKey),
    fileSystem = new WindowsFileSystem(sources, {
      cwd: 'C:\\game',
      mounts: [{windows: 'C:\\', virtual: '/'}],
    }),
    text = new AokanaNativeText(),
    media = new AokanaProgramMedia();
  media.setDriveType(2, 3);
  const files = new AokanaProgramFiles(fileSystem, text, media),
    unavailable = () => assert.fail('Archive release opened an unexpected diagnostic'),
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
      {fatal: unavailable, threadFatal: unavailable},
      new AokanaDistributedProcessing(new AokanaDistributedAllocator(1), 1),
    );
  return {
    resources,
    mount(path) {
      sources.attach(path, new BlobSource(new Blob([archive()])));
    },
  };
}

test('archive release opens and clears one valid primary archive cache node', async () => {
  const state = setup();
  state.mount('/game/primary.arc');
  assert.equal(await state.resources.releaseArchive(bytes('primary.arc')), 0);
});

test('archive release falls back from a missing primary archive to available secondary media', async () => {
  const state = setup();
  state.mount('/disc/secondary.arc');
  assert.equal(await state.resources.releaseArchive(bytes('secondary.arc')), 0);
});

test('81 3C pushes the raw release result and balances the operand stack', async () => {
  const state = setup(),
    memoryBytes = new Uint8Array(128),
    memory = new AokanaBpMemory(memoryBytes),
    thread = new AokanaBpThread({
      id: 1,
      operandCapacity: 8,
      moduleCapacity: 0,
      frameCapacity: 0,
    }),
    [definition] = createGroup81ArchiveRelease(state.resources);
  state.mount('/game/data.arc');
  memoryBytes.set(bytes('data.arc\0'), 32);
  push32(thread, 32);
  assert.equal(await definition.execute({thread, memory, diagnostics: {}}), 0);
  assert.equal(pop32(thread), 0);
  assert.equal(thread.stackIndex, 0);
  assert.equal(definition.primary, 0x81);
  assert.equal(definition.secondary, 0x3c);
  assert.equal(definition.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[0x81][0x3c]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {BlobSource} from '../dist/core/source.js';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, pop32, push32} from '../dist/engines/buriko/bp/state.js';
import {
  BurikoDistributedAllocator,
  BurikoDistributedProcessing,
} from '../dist/engines/buriko/native/distributed-processing.js';
import {createGroup81ArchiveRelease} from '../dist/engines/buriko/native/group-81-archive-release.js';
import {
  BurikoProgramFiles,
  BurikoProgramMedia,
} from '../dist/engines/buriko/native/program-files.js';
import {BurikoProgramResources} from '../dist/engines/buriko/native/program-resources.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';
import {BURIKO_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/native/inventory.js';
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
    text = new BurikoNativeText(),
    media = new BurikoProgramMedia();
  media.setDriveType(2, 3);
  const files = new BurikoProgramFiles(fileSystem, text, media),
    unavailable = () => assert.fail('Archive release opened an unexpected diagnostic'),
    resources = new BurikoProgramResources(
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
      new BurikoDistributedProcessing(new BurikoDistributedAllocator(1), 1),
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
    memory = new BurikoBpMemory(memoryBytes),
    thread = new BurikoBpThread({
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
  assert.equal(definition.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[0x81][0x3c]);
});

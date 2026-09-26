import test from 'node:test';
import assert from 'node:assert/strict';
import {BlobSource} from '../dist/core/source.js';
import {SourceFileSystem} from '../dist/platform/filesystem.js';
import {MemoryStore} from '../dist/platform/store.js';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, pop32, push32} from '../dist/engines/buriko/bp/state.js';
import {BurikoNativeLocks} from '../dist/engines/buriko/native/exclusion-locks.js';
import {createGroup80Locks} from '../dist/engines/buriko/native/group-80-locks.js';
import {createGroup80ResourceSettings} from '../dist/engines/buriko/native/group-80-resource-settings.js';
import {BURIKO_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/native/inventory.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';
import {BurikoNativeRegistry} from '../dist/engines/buriko/native/windows-registry.js';
import {
  BurikoProgramFiles,
  BurikoProgramMedia,
} from '../dist/engines/buriko/native/program-files.js';
import {BurikoProgramResources} from '../dist/engines/buriko/native/program-resources.js';
import {BurikoMountedProgramPaths} from '../dist/engines/buriko/native/program-paths.js';
import {BurikoSpecialFolders} from '../dist/engines/buriko/native/special-folders.js';
import {
  BurikoDistributedAllocator,
  BurikoDistributedProcessing,
} from '../dist/engines/buriko/native/distributed-processing.js';

const bytes = (value) => new TextEncoder().encode(value);
function vm(slots) {
  const thread = new BurikoBpThread({
    id: 1,
    operandCapacity: 32,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const memory = new BurikoBpMemory(new Uint8Array(2048));
  for (const slot of slots)
    assert.equal(slot.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[0x80][slot.secondary]);
  return {
    thread,
    memory,
    async call(slot, args = [], returnsValue = true) {
      const before = thread.stackIndex;
      for (const value of args) push32(thread, value);
      assert.equal(
        await slots.find((entry) => entry.secondary === slot).execute({thread, memory}),
        0,
      );
      assert.equal(thread.stackIndex, before + Number(returnsValue));
      return returnsValue ? pop32(thread) : undefined;
    },
    text(value, address = 32) {
      memory.globalMemory.set(bytes(value + '\0'), address);
      return address;
    },
    read(address) {
      return new TextDecoder().decode(memory.globalMemory.subarray(address)).split('\0')[0];
    },
  };
}

test('all five lock wrappers share native IDs and translate successful recursive and contended operations', async () => {
  const firstActor = {},
    secondActor = {},
    actors = {currentActor: firstActor};
  const locks = new BurikoNativeLocks(actors);
  locks.initializeEngine();
  const slots = createGroup80Locks(locks),
    state = vm(slots);
  assert.equal(slots.length, 5);
  const id = await state.call(0xb0);
  assert.equal(id, 6);
  assert.equal(locks.engine.create(), 7);
  assert.equal(await state.call(0xb0), 8);
  assert.equal(await state.call(0xb4, [id]), 0);
  assert.equal(await state.call(0xb5, [id]), 0);
  assert.deepEqual(
    locks.script.snapshot().find((item) => item.id === id),
    {id, admitted: 2, acquired: 2, owner: firstActor},
  );
  actors.currentActor = secondActor;
  assert.equal(await state.call(0xb4, [id]), 2);
  actors.currentActor = firstActor;
  assert.equal(await state.call(0xb6, [id]), 0);
  assert.equal(await state.call(0xb6, [id]), 0);
  assert.equal(await state.call(0xb1, [id]), 0);
  assert.deepEqual(
    locks.script.snapshot().map((item) => item.id),
    [8],
  );
});

function resourceSetup() {
  const text = new BurikoNativeText(),
    sources = new SourceFileSystem();
  const media = new BurikoProgramMedia();
  media.setDriveType(2, 3);
  const paths = new BurikoMountedProgramPaths([{native: 'C:\\', mounted: '/drive'}], 'C:\\game');
  const files = new BurikoProgramFiles(sources, text, media, paths);
  const configuration = {
    nativeFileRoot: 'C:\\game\\',
    primaryRoot: bytes('C:\\game\\'),
    secondaryRoot: bytes('C:\\disc\\'),
    secondaryMediaPath: 'C:\\disc\\',
    searchDirectoriesEnabled: 0,
    searchDirectories: [],
    retryTitle: bytes('Media'),
    retryMessage: bytes('Insert'),
    quitConfirmation: bytes('Quit?'),
  };
  const fatal = () => assert.fail('Synthetic resource settings do not open a diagnostic');
  const resources = new BurikoProgramResources(
    files,
    configuration,
    {show: fatal},
    {fatal},
    new BurikoDistributedProcessing(new BurikoDistributedAllocator(1), 1),
  );
  const profile = {
    shellAllocatorAvailable: true,
    windows: 'C:\\Windows',
    programFiles: 'C:\\Programs',
    currentUser: {
      desktop: 'C:\\Users\\Reader\\Desktop',
      programs: 'C:\\Users\\Reader\\Programs',
      documents: 'C:\\Users\\Reader\\Documents',
      profile: 'C:\\Users\\Reader',
    },
    shellUser: {
      desktop: 'C:\\Users\\Shell\\Desktop',
      programs: 'C:\\Users\\Shell\\Programs',
      documents: 'C:\\Users\\Shell\\Documents',
      profile: 'C:\\Users\\Shell',
    },
    elevated: false,
    shellTokenAvailable: true,
    debugPrivilegeAvailable: false,
    shellAccountName: 'Shell',
  };
  const folders = new BurikoSpecialFolders(
    text,
    new BurikoNativeRegistry(new MemoryStore()),
    configuration,
    profile,
  );
  files.specialFolders = folders;
  const slots = createGroup80ResourceSettings(resources, folders);
  return {
    ...vm(slots),
    slots,
    resources,
    configuration,
    folders,
    mount(path, value) {
      sources.attach(path, new BlobSource(new Blob([value])));
    },
  };
}

test('resource search wrappers copy newest-first names and affect actual size lookup without pushing setter results', async () => {
  const state = resourceSetup();
  assert.equal(state.slots.length, 6);
  state.mount('/drive/game/first/item', Uint8Array.of(1, 2, 3));
  state.mount('/drive/game/second/item', Uint8Array.of(4, 5, 6, 7, 8));
  await state.call(0x37, [state.text('first')], false);
  await state.call(0x37, [state.text('second')], false);
  state.text('changed');
  assert.deepEqual(
    state.configuration.searchDirectories.map((v) => new TextDecoder().decode(v)),
    ['second', 'first'],
  );
  await state.call(0x36, [7], false);
  assert.equal(state.configuration.searchDirectoriesEnabled, 7);
  assert.equal(await state.call(0x35, [0, state.text('item')]), 5);
  await state.call(0x36, [0], false);
  assert.equal(await state.call(0x35, [0, state.text('item')]), 0);
  assert.equal(state.thread.stackIndex, 0);
});

test('folder wrappers preserve output order and read the shared mutable resource and shell roots', async () => {
  const state = resourceSetup();
  assert.equal(await state.call(0x3a, [512, 1]), 1);
  assert.equal(state.read(512), 'C:\\Users\\Reader\\Desktop');
  assert.equal(await state.call(0x3d, [512, 0]), 1);
  assert.equal(state.read(512), 'C:\\game\\');
  state.configuration.primaryRoot = bytes('C:\\other\\');
  assert.equal(await state.call(0x3d, [512, 0]), 1);
  assert.equal(state.read(512), 'C:\\other\\');
  state.folders.profile.elevated = true;
  assert.equal(await state.call(0x3a, [512, 1]), 1);
  assert.equal(state.read(512), 'C:\\Users\\Shell\\Desktop');
  assert.equal(state.thread.stackIndex, 0);
});

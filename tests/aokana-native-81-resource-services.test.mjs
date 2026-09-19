import test from 'node:test';
import assert from 'node:assert/strict';
import {BlobSource} from '../dist/core/source.js';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpScheduler} from '../dist/engines/buriko/games/aokana/bp/scheduler.js';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaNativeClock} from '../dist/engines/buriko/games/aokana/native/clock.js';
import {
  AokanaDistributedAllocator,
  AokanaDistributedProcessing,
} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {createGroup81ResourceServices} from '../dist/engines/buriko/games/aokana/native/group-81-resource-services.js';
import {AokanaVmControlState} from '../dist/engines/buriko/games/aokana/native/group-80-threads.js';
import {updateNativeChecksum} from '../dist/engines/buriko/games/aokana/native/group-81-hash.js';
import {AokanaProcedureState} from '../dist/engines/buriko/games/aokana/native/procedure.js';
import {
  AokanaProgramFiles,
  AokanaProgramMedia,
} from '../dist/engines/buriko/games/aokana/native/program-files.js';
import {AokanaProgramResources} from '../dist/engines/buriko/games/aokana/native/program-resources.js';
import {AokanaResourceLoadingState} from '../dist/engines/buriko/games/aokana/native/resource-loading.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';
import {SourceFileSystem} from '../dist/platform/filesystem.js';
import {WindowsFileSystem, windowsFileKey} from '../dist/platform/windows-filesystem.js';

const bytes = (value) => new TextEncoder().encode(value);

function checksumMetadata(payload) {
  const checksum = new Uint8Array(8);
  updateNativeChecksum({bytes: checksum, offset: 0}, {bytes: payload, offset: 0}, payload.length);
  return new DataView(checksum.buffer).getBigUint64(0, true);
}

function archive(payload, metadata = 1n) {
  const output = new Uint8Array(144 + payload.length),
    view = new DataView(output.buffer);
  output.set(bytes('BURIKO ARC20'));
  view.setUint32(12, 1, true);
  output.set(bytes('entry'), 16);
  view.setUint32(112, 0, true);
  view.setUint32(116, payload.length, true);
  view.setBigUint64(120, metadata, true);
  output.set(payload, 144);
  return output;
}

function setup() {
  const sources = new SourceFileSystem(windowsFileKey),
    fs = new WindowsFileSystem(sources, {
      cwd: 'C:\\game',
      mounts: [{windows: 'C:\\', virtual: '/'}],
    }),
    text = new AokanaNativeText(),
    media = new AokanaProgramMedia();
  media.setDriveType(2, 3);
  const files = new AokanaProgramFiles(fs, text, media),
    allocator = new AokanaDistributedAllocator(1),
    unavailable = () => assert.fail('Successful synthetic resource service opened a diagnostic'),
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
      new AokanaDistributedProcessing(allocator, 1),
    ),
    loading = new AokanaResourceLoadingState(resources),
    thread = new AokanaBpThread({
      id: 1,
      operandCapacity: 32,
      moduleCapacity: 0,
      frameCapacity: 0,
    }),
    memory = new AokanaBpMemory(new Uint8Array(1024)),
    scheduler = new AokanaBpScheduler(thread, () => 1),
    procedures = new AokanaProcedureState(),
    clock = new AokanaNativeClock(() => 100),
    control = new AokanaVmControlState(),
    slots = createGroup81ResourceServices(loading, scheduler, procedures, clock, control),
    context = {thread, memory, diagnostics: {}};
  let nextText = 32;
  return {
    loading,
    thread,
    memory,
    scheduler,
    control,
    slots,
    mount(path, data) {
      sources.attach(path, new BlobSource(new Blob([data])));
    },
    name(value) {
      const address = nextText;
      nextText += value.length + 16;
      memory.globalMemory.set(bytes(value + '\0'), address);
      return address;
    },
    async call(secondary, ...arguments_) {
      arguments_.forEach((value) => push32(thread, value));
      return slots.find((slot) => slot.secondary === secondary).execute(context);
    },
  };
}

test('81 30 synchronous branch reads one explicit stored range and pushes its raw status', async () => {
  const state = setup(),
    payload = Uint8Array.of(5, 7, 11, 13, 17),
    destination = 512;
  state.mount('/game/data.arc', archive(payload));
  const archiveName = state.name('data.arc'),
    resourceName = state.name('entry');
  assert.equal(await state.call(0x30, destination, archiveName, resourceName, 1, 3), 0);
  assert.equal(pop32(state.thread), 0);
  assert.deepEqual(
    state.memory.globalMemory.slice(destination, destination + 3),
    Uint8Array.of(7, 11, 13),
  );
  assert.equal(state.loading.activeProcedures, 0);
  assert.equal(state.loading.hasPending, false);
});

test('81 30 asynchronous whole stored read uses one-shot scheduling and the shared cache', async () => {
  const state = setup(),
    payload = Uint8Array.of(19, 23, 29, 31, 37),
    destination = 512;
  state.mount('/game/data.arc', archive(payload));
  state.loading.cache.configure(1024);
  const archiveName = state.name('data.arc'),
    resourceName = state.name('entry');
  state.control.asynchronousResourceLoads = 1;
  assert.equal(await state.call(0x30, destination, archiveName, resourceName, 0, 0), 2);
  assert.equal(state.control.asynchronousResourceLoads, 0);
  assert.equal(state.thread.stackIndex, 0);
  assert.equal(state.loading.activeProcedures, 1);
  assert.equal(state.loading.hasPending, true);
  assert.equal(await state.scheduler.root.pollProcess(false), 0);
  assert.equal(await state.loading.processNext(), true);
  assert.equal(await state.scheduler.root.pollProcess(false), 1);
  assert.equal(state.scheduler.root.process, null);
  assert.equal(state.loading.activeProcedures, 0);
  assert.equal(state.thread.stackIndex, 0);
  assert.deepEqual(
    state.memory.globalMemory.slice(destination, destination + payload.length),
    payload,
  );
  assert.deepEqual(state.loading.cache.read(bytes('DATA.ARC'), bytes('ENTRY')), payload);

  state.memory.globalMemory.fill(0, destination, destination + payload.length);
  state.control.asynchronousResourceLoads = 1;
  assert.equal(await state.call(0x30, destination, archiveName, resourceName, 0, 0), 2);
  assert.equal(state.control.asynchronousResourceLoads, 0);
  assert.equal(state.loading.hasPending, false);
  assert.equal(state.loading.activeProcedures, 1);
  assert.equal(await state.scheduler.root.pollProcess(false), 1);
  assert.equal(state.loading.activeProcedures, 0);
  assert.equal(state.thread.stackIndex, 0);
  assert.deepEqual(
    state.memory.globalMemory.slice(destination, destination + payload.length),
    payload,
  );
});

test('81 34 reads stored bytes and archive metadata through the shared FIFO before pushing health zero', async () => {
  const state = setup(),
    payload = Uint8Array.of(41, 43, 47, 53, 59);
  state.mount('/game/data.arc', archive(payload, checksumMetadata(payload)));
  const archiveName = state.name('data.arc'),
    resourceName = state.name('entry');
  for (const slot of state.slots)
    assert.equal(slot.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[slot.primary][slot.secondary]);
  assert.equal(await state.call(0x34, archiveName, resourceName), 2);
  assert.equal(state.thread.stackIndex, 0);
  assert.equal(state.loading.activeProcedures, 1);
  assert.equal(state.loading.hasPending, true);
  assert.equal(await state.scheduler.root.pollProcess(false), 0);
  assert.equal(await state.loading.processNext(), true);
  assert.equal(await state.scheduler.root.pollProcess(false), 1);
  assert.equal(state.scheduler.root.process, null);
  assert.equal(state.loading.activeProcedures, 0);
  assert.equal(pop32(state.thread), 0);
});

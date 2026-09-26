import test from 'node:test';
import assert from 'node:assert/strict';
import {StoredFileSystem} from '../dist/platform/filesystem.js';
import {MemoryStore} from '../dist/platform/store.js';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, pop32, push32} from '../dist/engines/buriko/bp/state.js';
import {
  BurikoProgramFiles,
  BurikoProgramMedia,
} from '../dist/engines/buriko/native/program-files.js';
import {BurikoMountedProgramPaths} from '../dist/engines/buriko/native/program-paths.js';
import {BurikoProgramResources} from '../dist/engines/buriko/native/program-resources.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';
import {BurikoEngineDialogs} from '../dist/engines/buriko/native/engine-dialogs.js';
import {BurikoEngineErrors} from '../dist/engines/buriko/native/engine-errors.js';
import {
  BurikoDistributedAllocator,
  BurikoDistributedProcessing,
} from '../dist/engines/buriko/native/distributed-processing.js';

import {BurikoBpScheduler} from '../dist/engines/buriko/bp/scheduler.js';
import {BurikoNativeClock} from '../dist/engines/buriko/native/clock.js';
import {BurikoProcedureState} from '../dist/engines/buriko/native/procedure.js';
import {BurikoResourceLoadingState} from '../dist/engines/buriko/native/resource-loading.js';
import {BurikoDataCodecWorkers} from '../dist/engines/buriko/native/data-codec-workers.js';
import {createGroup80DataDecode} from '../dist/engines/buriko/native/group-80-data-decode.js';

test('80:CF decodes ordinary raw and SDC records through actual scheduled workers', async () => {
  const fs = new StoredFileSystem(new MemoryStore()),
    text = new BurikoNativeText(),
    encode = (s) => text.encodeWide(s, 1),
    files = new BurikoProgramFiles(
      fs,
      text,
      new BurikoProgramMedia(),
      new BurikoMountedProgramPaths([{native: 'C:\\', mounted: '/'}], 'C:\\'),
    ),
    dialogs = new BurikoEngineDialogs(),
    errors = new BurikoEngineErrors(files, dialogs, encode('C:\\'), encode('C:\\')),
    processing = new BurikoDistributedProcessing(new BurikoDistributedAllocator(1), 1),
    resources = new BurikoProgramResources(
      files,
      {
        nativeFileRoot: 'C:\\',
        primaryRoot: encode('C:\\'),
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
    ),
    loading = new BurikoResourceLoadingState(resources),
    memory = new BurikoBpMemory(new Uint8Array(0x1000)),
    root = new BurikoBpThread({id: 0, operandCapacity: 8, moduleCapacity: 0, frameCapacity: 0}),
    thread = new BurikoBpThread({id: 1, operandCapacity: 8, moduleCapacity: 256, frameCapacity: 0}),
    scheduler = new BurikoBpScheduler(root, () => 1),
    node = scheduler.append(thread),
    workers = new BurikoDataCodecWorkers(() => new Date(Date.UTC(2026, 8, 19, 12, 34, 56, 0))),
    [slot] = createGroup80DataDecode(
      workers,
      loading,
      scheduler,
      new BurikoProcedureState(),
      new BurikoNativeClock(() => 0),
    ),
    raw = new TextEncoder().encode('RAW data payload!');
  memory.globalMemory.fill(0x5a);
  memory.globalMemory.set(raw, 0x100);
  thread.moduleMemory.fill(0xa5);
  const invoke = async (source, destination, count) => {
    push32(thread, destination);
    push32(thread, source);
    push32(thread, count);
    assert.equal(slot.execute({thread, memory}), 2);
    assert.equal(loading.activeProcedures, 1);
    assert.equal(node.pollProcess(false), 0);
    assert.equal(thread.stackIndex, 0);
    assert.equal(await scheduler.run(), 0);
    assert.equal(workers.hasPendingWork(), false);
    assert.equal(thread.stackIndex, 0);
    assert.equal(loading.activeProcedures, 1);
    assert.equal(await scheduler.run(), 0);
    assert.equal(node.process, null);
    assert.equal(loading.activeProcedures, 0);
    const result = pop32(thread);
    assert.equal(thread.stackIndex, 0);
    return result;
  };
  try {
    assert.equal(await invoke(0x100, 0x10000008, raw.length), raw.length);
    assert.deepEqual(thread.moduleMemory.subarray(8, 8 + raw.length), raw);
    assert.equal(thread.moduleMemory[7], 0xa5);
    assert.equal(thread.moduleMemory[8 + raw.length], 0xa5);
    const encoded = new Uint8Array(41),
      header = new DataView(encoded.buffer);
    encoded.set(new TextEncoder().encode('SDC FORMAT 1.00\0'));
    header.setUint32(20, 9, true);
    header.setUint32(24, 40, true);
    header.setUint16(28, 1063, true);
    header.setUint16(30, 203, true);
    encoded.set([1, 155, 196, 222, 66, 128, 205, 75, 15], 32);
    memory.globalMemory.set(encoded, 0x200);
    assert.equal(await invoke(0x200, 0x10000050, encoded.length), 40);
    assert.deepEqual(
      thread.moduleMemory.subarray(80, 120),
      new TextEncoder().encode('AB'.repeat(20)),
    );
    assert.equal(thread.moduleMemory[79], 0xa5);
    assert.equal(thread.moduleMemory[120], 0xa5);
    assert.deepEqual(memory.globalMemory.subarray(0x200, 0x229), encoded);
  } finally {
    processing.dispose();
  }
});

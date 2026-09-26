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
import {createGroup80StructCodec} from '../dist/engines/buriko/native/group-80-struct-codec.js';
import {BurikoStructCodecScratch} from '../dist/engines/buriko/native/struct-codec-scratch.js';
import {encodeBurikoDcfs} from '../dist/engines/buriko/native/dcfs.js';
import {decodeBurikoSdcInto} from '../dist/engines/buriko/native/sdc.js';

test('80:C4/C5 encode and restore an embedded record table through the shared worker and scratch owners', async () => {
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
    scratch = new BurikoStructCodecScratch(4096),
    slots = createGroup80StructCodec(
      workers,
      loading,
      scratch,
      scheduler,
      new BurikoProcedureState(),
      new BurikoNativeClock(() => 0),
    ),
    encodeSlot = slots.find((slot) => slot.secondary === 0xc4),
    decodeSlot = slots.find((slot) => slot.secondary === 0xc5),
    plain = new TextEncoder().encode('ABCDEFGHABxyEFGHABxyEFGZ');
  thread.moduleMemory.fill(0xa5);
  thread.moduleMemory.set(plain, 16);
  const expected = new Uint8Array(40),
    header = new DataView(expected.buffer);
  expected.set(new TextEncoder().encode('DCFS FORMAT 1.00'));
  header.setUint32(16, 8, true);
  header.setUint32(20, 3, true);
  expected.set(new TextEncoder().encode('ABCDEFGH'), 24);
  expected.set([2, 2, 120, 121, 4, 7, 1, 90], 32);
  const direct = new Uint8Array(128),
    result = {value: 0};
  assert.equal(
    encodeBurikoDcfs(
      {bytes: direct, offset: 0},
      result,
      {bytes: thread.moduleMemory, offset: 16},
      8,
      3,
    ),
    0,
  );
  assert.equal(result.value, 40);
  assert.deepEqual(direct.subarray(0, 40), expected);
  push32(thread, 0x100);
  push32(thread, 0x10000010);
  push32(thread, 8);
  push32(thread, 3);
  try {
    assert.equal(encodeSlot.execute({thread, memory}), 2);
    assert.equal(loading.activeProcedures, 1);
    assert.equal(node.pollProcess(false), 0);
    assert.equal(thread.stackIndex, 0);
    // The actual scheduler's existing host-task yield permits the independent encoder to run.
    assert.equal(await scheduler.run(), 0);
    assert.equal(workers.hasPendingWork(), false);
    assert.equal(loading.activeProcedures, 1);
    assert.equal(await scheduler.run(), 0);
    assert.equal(node.process, null);
    assert.equal(loading.activeProcedures, 0);
    const encodedCount = pop32(thread);
    assert.ok(encodedCount > 32 && encodedCount < 256);
    assert.equal(thread.stackIndex, 0);
    const decoded = new Uint8Array(128);
    assert.equal(
      decodeBurikoSdcInto({bytes: decoded, offset: 0}, {bytes: memory.globalMemory, offset: 0x100}),
      40,
    );
    assert.deepEqual(decoded.subarray(0, 40), expected);
    push32(thread, 0x10000080);
    push32(thread, 0x100);
    assert.equal(decodeSlot.execute({thread, memory}), 0);
    assert.equal(pop32(thread), 3);
    assert.equal(thread.stackIndex, 0);
    assert.deepEqual(thread.moduleMemory.subarray(128, 152), plain);
    assert.deepEqual(thread.moduleMemory.subarray(16, 40), plain);
    assert.equal(thread.moduleMemory[127], 0xa5);
    assert.equal(thread.moduleMemory[152], 0xa5);
    assert.equal(scratch.section.owner, null);
  } finally {
    await scratch.dispose();
    processing.dispose();
  }
});

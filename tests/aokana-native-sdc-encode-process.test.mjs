import test from 'node:test';
import assert from 'node:assert/strict';
import {StoredFileSystem} from '../dist/platform/filesystem.js';
import {MemoryStore} from '../dist/platform/store.js';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {
  AokanaProgramFiles,
  AokanaProgramMedia,
} from '../dist/engines/buriko/games/aokana/native/program-files.js';
import {AokanaMountedProgramPaths} from '../dist/engines/buriko/games/aokana/native/program-paths.js';
import {AokanaProgramResources} from '../dist/engines/buriko/games/aokana/native/program-resources.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {AokanaEngineDialogs} from '../dist/engines/buriko/games/aokana/native/engine-dialogs.js';
import {AokanaEngineErrors} from '../dist/engines/buriko/games/aokana/native/engine-errors.js';
import {
  AokanaDistributedAllocator,
  AokanaDistributedProcessing,
} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';

import {AokanaBpScheduler} from '../dist/engines/buriko/games/aokana/bp/scheduler.js';
import {AokanaNativeClock} from '../dist/engines/buriko/games/aokana/native/clock.js';
import {AokanaProcedureState} from '../dist/engines/buriko/games/aokana/native/procedure.js';
import {AokanaResourceLoadingState} from '../dist/engines/buriko/games/aokana/native/resource-loading.js';
import {AokanaDataCodecWorkers} from '../dist/engines/buriko/games/aokana/native/data-codec-workers.js';
import {createGroup80SdcEncode} from '../dist/engines/buriko/games/aokana/native/group-80-sdc-encode.js';
import {decodeAokanaSdcInto} from '../dist/engines/buriko/games/aokana/native/sdc.js';

test('80:C0 schedules actual encoding and publishes its result through the shared wait process', async () => {
  const fs = new StoredFileSystem(new MemoryStore()),
    text = new AokanaNativeText(),
    encode = (s) => text.encodeWide(s, 1),
    files = new AokanaProgramFiles(
      fs,
      text,
      new AokanaProgramMedia(),
      new AokanaMountedProgramPaths([{native: 'C:\\', mounted: '/'}], 'C:\\'),
    ),
    dialogs = new AokanaEngineDialogs(),
    errors = new AokanaEngineErrors(files, dialogs, encode('C:\\'), encode('C:\\')),
    processing = new AokanaDistributedProcessing(new AokanaDistributedAllocator(1), 1),
    resources = new AokanaProgramResources(
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
    loading = new AokanaResourceLoadingState(resources),
    memory = new AokanaBpMemory(new Uint8Array(0x1000)),
    root = new AokanaBpThread({id: 0, operandCapacity: 8, moduleCapacity: 0, frameCapacity: 0}),
    thread = new AokanaBpThread({id: 1, operandCapacity: 8, moduleCapacity: 256, frameCapacity: 0}),
    scheduler = new AokanaBpScheduler(root, () => 1),
    node = scheduler.append(thread),
    workers = new AokanaDataCodecWorkers(() => new Date(Date.UTC(2026, 8, 19, 12, 34, 56, 0))),
    [slot] = createGroup80SdcEncode(
      workers,
      loading,
      scheduler,
      new AokanaProcedureState(),
      new AokanaNativeClock(() => 0),
    ),
    plain = new TextEncoder().encode('AB'.repeat(20));
  memory.globalMemory.set(plain, 0x100);
  thread.moduleMemory.fill(0xa5);
  push32(thread, 0x10000008);
  push32(thread, 0x100);
  push32(thread, plain.length);
  try {
    assert.equal(slot.execute({thread, memory}), 2);
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
    assert.equal(pop32(thread), 41);
    assert.equal(thread.stackIndex, 0);
    const expected = new Uint8Array(41),
      header = new DataView(expected.buffer);
    expected.set(new TextEncoder().encode('SDC FORMAT 1.00\0'));
    header.setUint32(20, 9, true);
    header.setUint32(24, 40, true);
    header.setUint16(28, 1063, true);
    header.setUint16(30, 203, true);
    expected.set([1, 155, 196, 222, 66, 128, 205, 75, 15], 32);
    assert.deepEqual(thread.moduleMemory.subarray(8, 49), expected);
    assert.equal(thread.moduleMemory[7], 0xa5);
    assert.equal(thread.moduleMemory[49], 0xa5);
    const restored = new Uint8Array(80);
    assert.equal(
      decodeAokanaSdcInto({bytes: restored, offset: 0}, {bytes: thread.moduleMemory, offset: 8}),
      40,
    );
    assert.deepEqual(restored.subarray(0, 40), plain);
  } finally {
    processing.dispose();
  }
});

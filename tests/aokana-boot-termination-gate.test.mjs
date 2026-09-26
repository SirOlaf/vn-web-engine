import test from 'node:test';
import assert from 'node:assert/strict';
import {BlobSource} from '../dist/core/source.js';
import {MountedFileSystem, SourceFileSystem} from '../dist/platform/filesystem.js';
import {
  BurikoProgramFiles,
  BurikoProgramMedia,
} from '../dist/engines/buriko/native/program-files.js';
import {BurikoMountedProgramPaths} from '../dist/engines/buriko/native/program-paths.js';
import {BurikoProgramResources} from '../dist/engines/buriko/native/program-resources.js';
import {BurikoEngineErrors} from '../dist/engines/buriko/native/engine-errors.js';
import {BurikoEngineDialogs} from '../dist/engines/buriko/native/engine-dialogs.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';
import {
  BurikoDistributedAllocator,
  BurikoDistributedProcessing,
} from '../dist/engines/buriko/native/distributed-processing.js';
import {BurikoBpThread} from '../dist/engines/buriko/bp/state.js';
import {BurikoBpScheduler} from '../dist/engines/buriko/bp/scheduler.js';
import {BurikoBpDiagnostics} from '../dist/engines/buriko/native/diagnostics.js';
import {BurikoVmControlState} from '../dist/engines/buriko/native/group-80-threads.js';
import {BurikoBootProgramLoader} from '../dist/engines/buriko/native/boot-program-loader.js';
import {BurikoResourceLoadingState} from '../dist/engines/buriko/native/resource-loading.js';
import {BurikoBootTerminationGate} from '../dist/engines/buriko/native/boot-termination-gate.js';
import {singleArchive} from './aokana-resource-direct-fixtures.mjs';

test('ECB90 lower distinguishes selected restart, quit and live procedure retirement', async () => {
  const module = new Uint8Array(12),
    header = new DataView(module.buffer);
  header.setUint32(0, 8, true);
  header.setUint32(4, 4, true);
  module.set([0x11, 0x22, 0x33, 0x44], 8);
  const source = new SourceFileSystem();
  source.attach('/system.arc', new BlobSource(new Blob([singleArchive('ipl._bp', module)])));
  const mounted = new MountedFileSystem();
  mounted.mount('/game', source);

  const text = new BurikoNativeText(),
    media = new BurikoProgramMedia(),
    paths = new BurikoMountedProgramPaths([{native: 'C:\\game', mounted: '/game'}], 'C:\\game');
  media.setDriveType(2, 3);
  const files = new BurikoProgramFiles(mounted, text, media, paths),
    dialogs = new BurikoEngineDialogs(),
    errors = new BurikoEngineErrors(
      files,
      dialogs,
      text.encodeWide('C:\\game\\', 1),
      text.encodeWide('C:\\game\\', 1),
    ),
    processing = new BurikoDistributedProcessing(new BurikoDistributedAllocator(1), 1),
    resources = new BurikoProgramResources(
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
    ),
    loading = new BurikoResourceLoadingState(resources),
    control = new BurikoVmControlState(),
    scheduler = new BurikoBpScheduler(
      new BurikoBpThread({
        id: control.allocateThreadId(),
        operandCapacity: 0,
        moduleCapacity: 0,
        frameCapacity: 0,
      }),
    ),
    loader = new BurikoBootProgramLoader(
      resources,
      control,
      scheduler,
      new BurikoBpDiagnostics(() => {}),
    ),
    gate = new BurikoBootTerminationGate(scheduler, loading),
    archive = text.encodeWide('system.arc', 1),
    name = text.encodeWide('ipl._bp', 1);
  try {
    assert.strictEqual(gate.scheduler, scheduler);
    assert.strictEqual(gate.loading, loading);
    assert.equal(gate.restartRequested, true);
    assert.equal(gate.terminationRequested, false);
    assert.equal(gate.canRetireChildren, false);

    assert.equal(gate.beginOuterReset(), true);
    assert.equal(gate.restartRequested, false);
    gate.beginSuccessfulBoot(await loader.appendSelectedProgram(archive, name));
    gate.observeSchedulerResult(0);
    gate.observePumpResult(2);
    assert.equal(gate.terminationRequested, false);

    loading.enterProcedure();
    gate.observeSchedulerResult(2);
    assert.equal(gate.terminationRequested, true);
    assert.equal(gate.restartRequested, true);
    assert.equal(gate.canRetireChildren, false);
    gate.observePumpResult(-1);
    assert.equal(gate.restartRequested, true);
    loading.leaveProcedure();
    assert.equal(gate.canRetireChildren, true);

    scheduler.removeAllChildren();
    assert.equal(gate.beginOuterReset(), true);
    assert.equal(gate.restartRequested, false);
    assert.equal(gate.terminationRequested, true);
    gate.beginSuccessfulBoot(await loader.appendSelectedProgram(archive, name));
    assert.equal(gate.terminationRequested, false);
    gate.observePumpResult(-1);
    assert.equal(gate.terminationRequested, true);
    assert.equal(gate.restartRequested, false);
    gate.observeSchedulerResult(1);
    assert.equal(gate.restartRequested, false);
    assert.equal(gate.canRetireChildren, true);
    scheduler.removeAllChildren();
    assert.equal(gate.beginOuterReset(), false);
  } finally {
    processing.dispose();
  }
});

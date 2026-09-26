import test from 'node:test';
import assert from 'node:assert/strict';
import {BlobSource} from '../dist/core/source.js';
import {MountedFileSystem, SourceFileSystem} from '../dist/platform/filesystem.js';
import {
  AokanaProgramFiles,
  AokanaProgramMedia,
} from '../dist/engines/buriko/games/aokana/native/program-files.js';
import {AokanaMountedProgramPaths} from '../dist/engines/buriko/games/aokana/native/program-paths.js';
import {AokanaProgramResources} from '../dist/engines/buriko/games/aokana/native/program-resources.js';
import {AokanaEngineErrors} from '../dist/engines/buriko/games/aokana/native/engine-errors.js';
import {AokanaEngineDialogs} from '../dist/engines/buriko/games/aokana/native/engine-dialogs.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {
  AokanaDistributedAllocator,
  AokanaDistributedProcessing,
} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {AokanaBpThread} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaBpScheduler} from '../dist/engines/buriko/games/aokana/bp/scheduler.js';
import {AokanaBpDiagnostics} from '../dist/engines/buriko/games/aokana/native/diagnostics.js';
import {AokanaVmControlState} from '../dist/engines/buriko/games/aokana/native/group-80-threads.js';
import {AokanaBootProgramLoader} from '../dist/engines/buriko/games/aokana/native/boot-program-loader.js';
import {AokanaResourceLoadingState} from '../dist/engines/buriko/games/aokana/native/resource-loading.js';
import {AokanaBootTerminationGate} from '../dist/engines/buriko/games/aokana/native/boot-termination-gate.js';
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

  const text = new AokanaNativeText(),
    media = new AokanaProgramMedia(),
    paths = new AokanaMountedProgramPaths([{native: 'C:\\game', mounted: '/game'}], 'C:\\game');
  media.setDriveType(2, 3);
  const files = new AokanaProgramFiles(mounted, text, media, paths),
    dialogs = new AokanaEngineDialogs(),
    errors = new AokanaEngineErrors(
      files,
      dialogs,
      text.encodeWide('C:\\game\\', 1),
      text.encodeWide('C:\\game\\', 1),
    ),
    processing = new AokanaDistributedProcessing(new AokanaDistributedAllocator(1), 1),
    resources = new AokanaProgramResources(
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
    loading = new AokanaResourceLoadingState(resources),
    control = new AokanaVmControlState(),
    scheduler = new AokanaBpScheduler(
      new AokanaBpThread({
        id: control.allocateThreadId(),
        operandCapacity: 0,
        moduleCapacity: 0,
        frameCapacity: 0,
      }),
    ),
    loader = new AokanaBootProgramLoader(
      resources,
      control,
      scheduler,
      new AokanaBpDiagnostics(() => {}),
    ),
    gate = new AokanaBootTerminationGate(scheduler, loading),
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

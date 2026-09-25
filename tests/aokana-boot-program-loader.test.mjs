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
import {
  AokanaEngineDialogs,
  AokanaNativeCursor,
} from '../dist/engines/buriko/games/aokana/native/engine-dialogs.js';
import {AokanaDiagnosticDialogs} from '../dist/engines/buriko/games/aokana/native/modal.js';
import {AokanaNativeClock} from '../dist/engines/buriko/games/aokana/native/clock.js';
import {AokanaNativeInput} from '../dist/engines/buriko/games/aokana/native/input.js';
import {AokanaNativeDisplayState} from '../dist/engines/buriko/games/aokana/native/display-state.js';
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
import {singleArchive} from './aokana-resource-direct-fixtures.mjs';

test('ED170 lower appends a copied mounted program under the actual scheduler root', async () => {
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
    clock = new AokanaNativeClock(() => 0),
    display = new AokanaNativeDisplayState(16, 8),
    input = new AokanaNativeInput(display, clock),
    dialogs = new AokanaEngineDialogs(
      new AokanaDiagnosticDialogs({}, {}),
      text,
      clock,
      input,
      new AokanaNativeCursor({style: {}}),
      {isPresent: () => false, refresh() {}},
      display,
      null,
      Uint8Array.of(0),
    ),
    errors = new AokanaEngineErrors(
      files,
      dialogs,
      text.encodeWide('C:\\game\\', 1),
      text.encodeWide('C:\\game\\', 1),
    ),
    allocator = new AokanaDistributedAllocator(1),
    processing = new AokanaDistributedProcessing(allocator, 1),
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
    control = new AokanaVmControlState(),
    root = new AokanaBpThread({
      id: control.allocateThreadId(),
      operandCapacity: 0,
      moduleCapacity: 0,
      frameCapacity: 0,
    }),
    scheduler = new AokanaBpScheduler(root),
    loader = new AokanaBootProgramLoader(
      resources,
      control,
      scheduler,
      new AokanaBpDiagnostics(() => {}),
    ),
    archiveName = text.encodeWide('system.arc', 1),
    moduleName = text.encodeWide('ipl._bp', 1);
  try {
    const id = await loader.appendSelectedProgram(archiveName, moduleName);
    assert.equal(id, 1);
    assert.equal(control.nextThreadId, 2);
    const node = scheduler.firstThread;
    assert.equal(node, scheduler.root.next);
    assert.equal(node.state, scheduler.findById(id).state);
    assert.equal(node.next, null);
    assert.equal(node.state.operandStack.length, 0x1000);
    assert.equal(node.state.moduleCapacity, 0x800000);
    assert.equal(node.state.frameCapacity, 0x400000);
    assert.equal(node.state.moduleSize, 4);
    assert.deepEqual([...node.state.moduleMemory.subarray(0, 4)], [0x11, 0x22, 0x33, 0x44]);
    assert.deepEqual([...node.state.modules[0].name], [...new TextEncoder().encode('ipl._bp')]);
    moduleName.fill(0x58);
    assert.deepEqual([...node.state.modules[0].name], [...new TextEncoder().encode('ipl._bp')]);
    assert.equal(scheduler.remove(node), true);
  } finally {
    processing.dispose();
  }
});

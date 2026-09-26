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
import {
  BurikoEngineDialogs,
  BurikoNativeCursor,
} from '../dist/engines/buriko/native/engine-dialogs.js';
import {BurikoDiagnosticDialogs} from '../dist/engines/buriko/native/modal.js';
import {BurikoNativeClock} from '../dist/engines/buriko/native/clock.js';
import {BurikoNativeInput} from '../dist/engines/buriko/native/input.js';
import {BurikoNativeDisplayState} from '../dist/engines/buriko/native/display-state.js';
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

  const text = new BurikoNativeText(),
    media = new BurikoProgramMedia(),
    paths = new BurikoMountedProgramPaths([{native: 'C:\\game', mounted: '/game'}], 'C:\\game');
  media.setDriveType(2, 3);
  const files = new BurikoProgramFiles(mounted, text, media, paths),
    clock = new BurikoNativeClock(() => 0),
    display = new BurikoNativeDisplayState(16, 8),
    input = new BurikoNativeInput(display, clock),
    dialogs = new BurikoEngineDialogs(
      new BurikoDiagnosticDialogs({}, {}),
      text,
      clock,
      input,
      new BurikoNativeCursor({style: {}}),
      {isPresent: () => false, refresh() {}},
      display,
      null,
      Uint8Array.of(0),
    ),
    errors = new BurikoEngineErrors(
      files,
      dialogs,
      text.encodeWide('C:\\game\\', 1),
      text.encodeWide('C:\\game\\', 1),
    ),
    allocator = new BurikoDistributedAllocator(1),
    processing = new BurikoDistributedProcessing(allocator, 1),
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
    control = new BurikoVmControlState(),
    root = new BurikoBpThread({
      id: control.allocateThreadId(),
      operandCapacity: 0,
      moduleCapacity: 0,
      frameCapacity: 0,
    }),
    scheduler = new BurikoBpScheduler(root),
    loader = new BurikoBootProgramLoader(
      resources,
      control,
      scheduler,
      new BurikoBpDiagnostics(() => {}),
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

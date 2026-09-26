import test from 'node:test';
import assert from 'node:assert/strict';
import {StoredFileSystem} from '../dist/platform/filesystem.js';
import {MemoryStore} from '../dist/platform/store.js';
import {BurikoMountedFileMetadata} from '../dist/engines/buriko/native/file-metadata.js';
import {BurikoMountedProgramPaths} from '../dist/engines/buriko/native/program-paths.js';
import {
  BurikoProgramFiles,
  BurikoProgramMedia,
} from '../dist/engines/buriko/native/program-files.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';
import {BurikoEngineDialogs} from '../dist/engines/buriko/native/engine-dialogs.js';
import {BurikoEngineErrors} from '../dist/engines/buriko/native/engine-errors.js';
import {
  BurikoDistributedAllocator,
  BurikoDistributedProcessing,
} from '../dist/engines/buriko/native/distributed-processing.js';
import {BurikoProgramResources} from '../dist/engines/buriko/native/program-resources.js';
import {BurikoLaunchSelection} from '../dist/engines/buriko/native/launch-selection.js';
import {createGroup80Launch} from '../dist/engines/buriko/native/group-80-launch.js';
import {BurikoBootProgramLoader} from '../dist/engines/buriko/native/boot-program-loader.js';
import {BurikoVmControlState} from '../dist/engines/buriko/native/group-80-threads.js';
import {BurikoBpThread, pop32, push32} from '../dist/engines/buriko/bp/state.js';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpScheduler} from '../dist/engines/buriko/bp/scheduler.js';
import {BurikoBpDiagnostics} from '../dist/engines/buriko/native/diagnostics.js';
import {singleArchive} from './aokana-resource-direct-fixtures.mjs';

function moduleBytes(payload) {
  const result = new Uint8Array(8 + payload.length),
    view = new DataView(result.buffer);
  view.setUint32(0, 8, true);
  view.setUint32(4, payload.length, true);
  result.set(payload, 8);
  return result;
}

async function mountedLaunch(commandLineTailWide) {
  const filesOnDisk = [
    ['/game/aokana.exe', Uint8Array.of(1)],
    ['/game/startup dir/system.arc', singleArchive('ipl._bp', moduleBytes([1, 2]))],
    ['/game/restart/next.arc', singleArchive('next._bp', moduleBytes([9, 8, 7]))],
  ];
  const backing = new StoredFileSystem(new MemoryStore(), (path) => path.toLowerCase());
  await backing.commit(filesOnDisk.map(([path, data]) => ({kind: 'write', path, data})));
  const record = (path, kind) => ({
    path,
    kind,
    attributes: kind === 'directory' ? 0x10 : 0x20,
    creationTime: null,
    accessTime: null,
    writeTime: 123n,
  });
  const mounted = new BurikoMountedFileMetadata(backing, {
      records: [
        record('/game', 'directory'),
        record('/game/startup dir', 'directory'),
        record('/game/restart', 'directory'),
        ...filesOnDisk.map(([path]) => record(path, 'file')),
      ],
      volumes: [{path: '/', identity: {}, writable: true}],
      canonical: (path) => path.toLowerCase(),
      currentFileTime: () => 123n,
      accessTimePolicy: 'disabled',
    }),
    paths = new BurikoMountedProgramPaths([{native: 'C:\\', mounted: '/'}], 'C:\\game'),
    text = new BurikoNativeText(),
    media = new BurikoProgramMedia();
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
        secondaryRoot: Uint8Array.of(88, 0),
        secondaryMediaPath: 'X:',
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
    launch = new BurikoLaunchSelection(
      files,
      paths,
      resources,
      errors,
      text,
      'C:\\game\\aokana.exe',
      commandLineTailWide,
    );
  return {files, paths, text, errors, processing, resources, launch};
}

test('launch selection shares roots and boot names with mounted ED170 resource append', async () => {
  const graph = await mountedLaunch('"C:\\game\\startup dir" "Execute as a launcher."');
  const {paths, text, errors, processing, resources, launch} = graph;
  try {
    await launch.configureFromCommandLine();
    assert.equal(launch.launcherFlag, 1);
    assert.equal(launch.mutexEnabled, 1);
    assert.equal(resources.configuration.nativeFileRoot, 'C:\\game\\startup dir\\');
    assert.equal(
      text.decodeAuto({bytes: resources.configuration.primaryRoot, offset: 0}),
      'C:\\game\\startup dir\\',
    );
    assert.equal(
      text.decodeAuto({bytes: errors.saveRoot.bytes, offset: 0}),
      'C:\\game\\startup dir\\',
    );
    assert.notEqual(errors.saveRoot.bytes, resources.configuration.primaryRoot);
    assert.equal(
      text.decodeAuto({bytes: errors.workingDirectory, offset: 0}),
      resources.configuration.nativeFileRoot,
    );
    assert.equal(paths.currentDirectory, 'C:\\game\\startup dir');
    assert.equal(resources.configuration.secondaryRoot[0], 0);
    assert.equal(resources.configuration.secondaryMediaPath, '');
    const archive = new Uint8Array(784),
      module = new Uint8Array(784);
    launch.copyBootNames(archive, module);
    assert.equal(text.decodeAuto({bytes: archive, offset: 0}), 'system.arc');
    assert.equal(text.decodeAuto({bytes: module, offset: 0}), 'ipl._bp');

    const bpBytes = new Uint8Array(512),
      memory = new BurikoBpMemory(bpBytes),
      vmThread = new BurikoBpThread({
        id: 9,
        operandCapacity: 8,
        moduleCapacity: 0,
        frameCapacity: 0,
      }),
      slots = createGroup80Launch(launch),
      restartSlot = slots.find((slot) => slot.secondary === 0x6b),
      launcherSlot = slots.find((slot) => slot.secondary === 0xfd);
    assert.equal(restartSlot.nativeAddress, 0x1400e8460);
    assert.equal(launcherSlot.nativeAddress, 0x1400e5f00);
    assert.equal(await launcherSlot.execute({thread: vmThread, memory}), 0);
    assert.equal(pop32(vmThread), 1);
    bpBytes.set(text.encodeWide('C:\\game\\restart\\next.arc', 1), 0x100);
    bpBytes.set(text.encodeWide('next._bp', 1), 0x180);
    push32(vmThread, 0x100); // path is below the module in the native stack.
    push32(vmThread, 0x180);
    assert.equal(await restartSlot.execute({thread: vmThread, memory}), 5);
    assert.equal(vmThread.stackIndex, 0);
    launch.copyBootNames(archive, module);
    assert.equal(text.decodeAuto({bytes: archive, offset: 0}), 'next.arc');
    assert.equal(text.decodeAuto({bytes: module, offset: 0}), 'next._bp');
    assert.equal(resources.configuration.nativeFileRoot, 'C:\\game\\restart\\');
    assert.equal(paths.currentDirectory, 'C:\\game\\restart');
    assert.equal(
      text.decodeAuto({bytes: errors.workingDirectory, offset: 0}),
      resources.configuration.nativeFileRoot,
    );
    assert.equal(launch.launcherFlag, 1); // Restart selection leaves startup policy alone.
    assert.equal(await launcherSlot.execute({thread: vmThread, memory}), 0);
    assert.equal(pop32(vmThread), 1);

    const control = new BurikoVmControlState(),
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
      );
    assert.equal(await loader.appendSelectedProgram(archive, module), 1);
    assert.deepEqual([...scheduler.firstThread.state.moduleMemory.subarray(0, 3)], [9, 8, 7]);
    assert.deepEqual(
      [...scheduler.firstThread.state.modules[0].name],
      [...new TextEncoder().encode('next._bp')],
    );
  } finally {
    processing.dispose();
  }
});

test('launch tail alone controls the independent mutex flag and zero-token default', async () => {
  const noMutex = await mountedLaunch('"C:\\game\\startup dir" "Do not use mutex."');
  try {
    await noMutex.launch.configureFromCommandLine();
    assert.equal(noMutex.launch.launcherFlag, 0);
    assert.equal(noMutex.launch.mutexEnabled, 0);
  } finally {
    noMutex.processing.dispose();
  }
  const defaultLaunch = await mountedLaunch('   ');
  try {
    await defaultLaunch.launch.configureFromCommandLine();
    assert.equal(defaultLaunch.resources.configuration.nativeFileRoot, 'C:\\game\\');
    const archive = new Uint8Array(784),
      module = new Uint8Array(784);
    defaultLaunch.launch.copyBootNames(archive, module);
    assert.equal(defaultLaunch.text.decodeAuto({bytes: archive, offset: 0}), 'system.arc');
    assert.equal(defaultLaunch.text.decodeAuto({bytes: module, offset: 0}), 'ipl._bp');
    assert.equal(defaultLaunch.launch.launcherFlag, 0);
    assert.equal(defaultLaunch.launch.mutexEnabled, 1);
  } finally {
    defaultLaunch.processing.dispose();
  }
});

test('restart selection holds caller names across mounted directory work', async () => {
  const graph = await mountedLaunch('');
  try {
    const path = graph.text.encodeWide('C:\\game\\startup dir', 1),
      module = graph.text.encodeWide('ipl._bp', 1),
      selected = graph.launch.selectPathAndModule(path, module);
    path[0] = module[0] = 88;
    await selected;
    const archive = new Uint8Array(784),
      copiedModule = new Uint8Array(784);
    graph.launch.copyBootNames(archive, copiedModule);
    assert.equal(graph.resources.configuration.nativeFileRoot, 'C:\\game\\startup dir\\');
    assert.equal(graph.text.decodeAuto({bytes: archive, offset: 0}), 'system.arc');
    assert.equal(graph.text.decodeAuto({bytes: copiedModule, offset: 0}), 'ipl._bp');
  } finally {
    graph.processing.dispose();
  }
});

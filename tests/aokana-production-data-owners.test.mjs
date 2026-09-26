import test from 'node:test';
import assert from 'node:assert/strict';
import {MountedFileSystem, StoredFileSystem} from '../dist/platform/filesystem.js';
import {MemoryStore} from '../dist/platform/store.js';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaMemorySpeakerBackend} from '../dist/engines/buriko/games/aokana/native/audio/speaker-backend.js';
import {AokanaMountedFileMetadata} from '../dist/engines/buriko/games/aokana/native/file-metadata.js';
import {AokanaMountedProgramPaths} from '../dist/engines/buriko/games/aokana/native/program-paths.js';
import {AokanaProgramMedia} from '../dist/engines/buriko/games/aokana/native/program-files.js';
import {AokanaProductionDataOwners} from '../dist/engines/buriko/games/aokana/native/production-data-owners.js';
import {AokanaProductionNativeFragments} from '../dist/engines/buriko/games/aokana/native/production-native-fragments.js';
import {AokanaProductionDisplayResourceGraph} from '../dist/engines/buriko/games/aokana/native/production-display-resource-graph.js';
import {AokanaWaitTiming} from '../dist/engines/buriko/games/aokana/native/procedure.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';

class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.style = {};
    this.listeners = new Map();
    this.children = [];
  }
  addEventListener(name, listener) {
    this.listeners.set(name, listener);
  }
  removeEventListener(name, listener) {
    if (this.listeners.get(name) === listener) this.listeners.delete(name);
  }
  append(child) {
    this.children.push(child);
  }
  setAttribute(name, value) {
    this[name] = value;
  }
  getBoundingClientRect() {
    return {left: 0, top: 0, right: 800, bottom: 600};
  }
  getContext() {
    assert.fail('data owner fixture must not initialize a display device');
  }
  focus() {}
  remove() {}
}

test('one production data bundle binds the actual graph, BP memory and partial wrappers', async () => {
  const files = new StoredFileSystem(new MemoryStore(), (path) => path.toLowerCase());
  const backing = new MountedFileSystem();
  backing.mount('/game', files);
  const mounted = new AokanaMountedFileMetadata(backing, {
    records: [],
    volumes: [{path: '/', identity: {}, writable: true}],
    canonical: (path) => path.toLowerCase(),
    currentFileTime: () => 123n,
    accessTimePolicy: 'disabled',
  });
  const paths = new AokanaMountedProgramPaths(
    [
      {native: 'C:\\game', mounted: '/game'},
      {native: 'D:\\Drops', mounted: '/drops'},
    ],
    'C:\\game',
  );
  const text = new AokanaNativeText();
  const encode = (value) => text.encodeWide(value, 1);
  const document = {createElement: (tag) => new Element(tag)};
  const parent = document.createElement('div');
  const canvas = document.createElement('canvas');
  const graphInputs = {
    document,
    parent,
    canvas,
    navigator: {},
    readViewportScreenMapping: () => ({
      originX: 0,
      originY: 0,
      nativePixelsPerCssX: 1,
      nativePixelsPerCssY: 1,
    }),
    monitors: [[0, 0, 800, 600]],
    selectedMonitor: 0,
    primaryMonitor: 0,
    clientOrigin: [0, 0],
    adapters: [
      {
        monitor: 0,
        pixelShaderVersion: 0,
        mode: {width: 800, height: 600, refreshRate: 60, format: 22},
      },
    ],
    damageCapacity: 16,
    childMetrics: {
      frameWidth: 0,
      frameHeight: 0,
      verticalScrollbarWidth: 0,
      horizontalScrollbarHeight: 0,
    },
    nativeWindowTitle: encode('Aokana'),
    preferredDialogTitle: null,
    cursorResource: null,
    performance: {now: () => 0},
    readSystemTime: () => new Date(Date.UTC(2026, 8, 19, 12, 34, 56)),
    cpuHost: {
      cpuid: () => [0, 0, 0, 0],
      readTimestampCounter: () => 0n,
      setCurrentThreadAffinity: () => 1n,
      logicalProcessorCount: () => 1,
      logicalProcessorInformation: () => [{relationship: 0, processorMask: 1n}],
    },
    registryStore: new MemoryStore(),
    specialFolderProfile: {
      shellAllocatorAvailable: false,
      windows: null,
      programFiles: null,
      currentUser: {desktop: null, programs: null, documents: null, profile: null},
      shellUser: {desktop: null, programs: null, documents: null, profile: null},
      elevated: false,
      shellTokenAvailable: false,
      debugPrivilegeAvailable: false,
      shellAccountName: null,
    },
    readUserDefaultUiLanguage: () => 0x409,
    localizedText: null,
    processorCount: 1,
    executablePathWide: 'C:\\game\\aokana.exe',
    commandLineTailWide: '   ',
    drop: {mountedRoot: '/drops', nativeRoot: 'D:\\Drops'},
    resource: {
      mounted,
      paths,
      media: new AokanaProgramMedia(),
      configuration: {
        nativeFileRoot: 'C:\\game\\',
        primaryRoot: encode('C:\\game\\'),
        secondaryRoot: Uint8Array.of(0),
        secondaryMediaPath: '',
        searchDirectoriesEnabled: 0,
        searchDirectories: [],
        retryTitle: Uint8Array.of(0),
        retryMessage: Uint8Array.of(0),
        quitConfirmation: Uint8Array.of(0),
      },
      errorDirectory: encode('C:\\game\\'),
      workingDirectory: encode('C:\\game\\'),
      audioRootWide: 'C:\\game\\',
      backend: new AokanaMemorySpeakerBackend(1000),
      output: {prefer24Bit: false},
      resourceWorkerCount: 1,
      sleep: async () => {},
    },
  };
  const graph = new AokanaProductionDisplayResourceGraph(graphInputs);
  try {
    const memory = new AokanaBpMemory(new Uint8Array(0x1000));
    const owners = new AokanaProductionDataOwners(graph, memory);
    const catalog = new AokanaProductionNativeFragments(graph, owners);
    const definitions = catalog.nativeDefinitions();
    const keys = definitions.map(({primary, secondary}) => `${primary}:${secondary}`);
    assert.equal(new Set(keys).size, keys.length);
    for (const secondary of [0x24, 0x25, 0x26])
      assert.equal(
        definitions.some((entry) => entry.primary === 0x80 && entry.secondary === secondary),
        false,
      );
    assert.equal(owners.save.resources, graph.resource.resources);
    assert.equal(owners.save.memory, memory);
    assert.equal(owners.persistence.memory, memory);
    assert.equal(owners.persistence.strings, owners.strings);
    assert.equal(owners.persistence.bits, owners.bits);
    assert.equal(owners.procedures.manager, graph.manager);
    assert.equal(graph.particleFrames.particles, graph.particles);
    assert.equal(graph.manager.locks, graph.resource.locks);
    assert.equal(graph.surfaces.allocator, graph.allocator);
    const secondGraph = new AokanaProductionDisplayResourceGraph({
      ...graphInputs,
      parent: document.createElement('div'),
      canvas: document.createElement('canvas'),
      drop: {mountedRoot: '/drops2', nativeRoot: 'E:\\Drops'},
      resource: {
        ...graphInputs.resource,
        paths: new AokanaMountedProgramPaths(
          [
            {native: 'C:\\game', mounted: '/game'},
            {native: 'E:\\Drops', mounted: '/drops2'},
          ],
          'C:\\game',
        ),
      },
    });
    try {
      assert.throws(
        () => new AokanaProductionDataOwners(secondGraph, memory),
        /memory already belongs to another production graph/,
      );
      const secondMemory = new AokanaBpMemory(new Uint8Array(0x1000));
      const secondOwners = new AokanaProductionDataOwners(secondGraph, secondMemory);
      assert.equal(secondOwners.memory, secondMemory);
      assert.equal(secondOwners.procedures.manager, secondGraph.manager);
      assert.throws(
        () => new AokanaProductionNativeFragments(secondGraph, owners),
        /same production graph/,
      );
    } finally {
      await secondGraph.shutdown();
    }

    const thread = new AokanaBpThread({
      id: 1,
      operandCapacity: 16,
      moduleCapacity: 512,
      frameCapacity: 0,
    });
    const invoke = (primary, secondary, args = [], output = false) => {
      for (const value of args) push32(thread, value);
      const definition = definitions.find(
        (entry) => entry.primary === primary && entry.secondary === secondary,
      );
      assert.ok(definition);
      assert.equal(definition.execute({thread, memory}), 0);
      const result = output ? pop32(thread) : undefined;
      assert.equal(thread.stackIndex, 0);
      return result;
    };
    invoke(0x80, 0x74, [0x87654321]);
    assert.equal(owners.save.cipher, 0x87654321);
    memory.globalMemory.set(new TextEncoder().encode('Aokana\0'), 0x200);
    invoke(0x80, 0xea, [0x200]);
    assert.deepEqual(
      graph.externalMutexName.readAnsiName(),
      new TextEncoder().encode('Uninstaller for Aokana is executing.\0'),
    );
    invoke(0x80, 0xe8, [0x400]);
    assert.deepEqual(
      memory.globalMemory.subarray(0x400, 0x400 + owners.productIdentity.bytes.length),
      owners.productIdentity.bytes,
    );
    assert.ok(definitions.some((entry) => entry.primary === 0x80 && entry.secondary === 0xf4));
    assert.ok(definitions.some((entry) => entry.primary === 0x80 && entry.secondary === 0xf5));
    invoke(0x80, 0x14, [0x12345678]);
    invoke(0x80, 0x15, [0x87654321]);
    assert.equal(graph.input.skipAllowed, 0x12345678);
    assert.equal(graph.input.skipForced, 0x87654321);

    const scriptActor = {};
    graph.allocator.withActor(scriptActor, () => {
      const lockId = invoke(0x80, 0xb0, [], true);
      assert.equal(lockId, 6);
      assert.equal(invoke(0x80, 0xb4, [lockId], true), 0);
      assert.equal(invoke(0x80, 0xb5, [lockId], true), 0);
      assert.deepEqual(graph.manager.locks.script.snapshot(), [
        {id: lockId, admitted: 2, acquired: 2, owner: scriptActor},
      ]);
      assert.equal(invoke(0x80, 0xb6, [lockId], true), 0);
      assert.equal(invoke(0x80, 0xb6, [lockId], true), 0);
      assert.equal(invoke(0x80, 0xb1, [lockId], true), 0);
      assert.deepEqual(graph.manager.locks.script.snapshot(), []);
    });

    owners.textSelection.interval = 777;
    owners.independentIcon.setMap(4, (index) => index + 7);
    invoke(0x90, 0xaf, [0x87654321]);
    assert.deepEqual(
      [
        owners.bitmapSelection.foregroundOnly,
        owners.textSelection.foregroundOnly,
        owners.independentIcon.foregroundOnly,
      ],
      [0x87654321, 0x87654321, 0x87654321],
    );
    assert.equal(
      owners.resetSelectionForegroundDefaults(graph, memory),
      'selection-foreground-defaults-reset',
    );
    assert.deepEqual(
      [
        owners.bitmapSelection.foregroundOnly,
        owners.textSelection.foregroundOnly,
        owners.independentIcon.foregroundOnly,
      ],
      [0, 0, 0],
    );
    assert.equal(owners.textSelection.interval, 777);
    assert.equal(owners.independentIcon.map(4)[0], 7);

    const procedureControl = definitions.find(
      (entry) => entry.primary === 0x80 && entry.secondary === 0x50,
    );
    assert.ok(procedureControl);
    const firstWait = new AokanaWaitTiming(thread, owners.procedureState, graph.clock, 100);
    assert.equal(firstWait.poll(), 0);
    push32(thread, 0);
    assert.equal(procedureControl.execute({thread, memory}), 1);
    assert.equal(thread.stackIndex, 0);
    assert.equal(firstWait.poll(), 1);

    push32(thread, 0x87654321);
    assert.equal(procedureControl.execute({thread, memory}), 1);
    assert.equal(thread.stackIndex, 0);
    assert.equal(owners.procedureState.enabled, 0x87654321);
    const secondWait = new AokanaWaitTiming(thread, owners.procedureState, graph.clock, 100);
    assert.equal(secondWait.poll(), 0);
    const nextId = owners.procedureState.nextId;
    assert.equal(
      owners.resetProcedureExecutionForProgram(graph, memory),
      'procedure-execution-reset',
    );
    assert.equal(owners.procedureState.enabled, 1);
    assert.equal(owners.procedureState.nextId, nextId);
    const thirdWait = new AokanaWaitTiming(thread, owners.procedureState, graph.clock, 100);
    assert.equal(thirdWait.poll(), 0);
    firstWait.dispose();
    secondWait.dispose();
    thirdWait.dispose();

    invoke(0x81, 0xd0, [0x10000040, 2], true);
    assert.equal(new DataView(thread.moduleMemory.buffer).getUint32(0x40, true), 1);
    owners.records.clear();
    invoke(0x81, 0xd0, [0x10000040, 2], true);
    assert.equal(new DataView(thread.moduleMemory.buffer).getUint32(0x40, true), 1);

    // Record-set writes and reads supply the live BP bytes searched by B8/B9.
    const recordId = memory.readU32(thread, 0x10000040);
    for (const [index, value] of [7, 3, 7].entries()) {
      memory.writeU32(thread, 0x10000120, value);
      assert.equal(invoke(0x81, 0xd2, [0, recordId, index, 0x10000120, 4], true), 0);
      assert.equal(invoke(0x81, 0xd4, [0x300 + index * 8, 0x10000140, recordId, index], true), 0);
      assert.equal(memory.readU32(thread, 0x10000140), 4);
    }
    assert.equal(invoke(0x81, 0xb8, [0x300, 3, 8, 7, 2, 0], true), 0);
    assert.equal(invoke(0x81, 0xb8, [0x300, 3, 8, 3, 2, 0], true), 1);
    assert.equal(invoke(0x81, 0xb8, [0x300, 3, 8, 8, 2, 0], true), 0xffffffff);
    assert.equal(invoke(0x81, 0xb9, [0x10000180, 0x300, 3, 8, 7, 2, 0], true), 2);
    assert.deepEqual(
      [memory.readU32(thread, 0x10000180), memory.readU32(thread, 0x10000184)],
      [0, 2],
    );
    memory.writeU32(thread, 0x380, 3);
    assert.equal(invoke(0x81, 0xb8, [0x300, 3, 8, 0x380, 0x0004ffff, 0], true), 1);

    // The same retained record set supplies a three-byte hash input via BP memory.
    thread.moduleMemory.set([97, 98, 99], 0x120);
    assert.equal(invoke(0x81, 0xd2, [0, recordId, 3, 0x10000120, 3], true), 0);
    assert.equal(invoke(0x81, 0xd4, [0x3a0, 0x10000140, recordId, 3], true), 0);
    assert.equal(memory.readU32(thread, 0x10000140), 3);
    invoke(0x81, 0xe9, [0x3d0, 0x3a0, 3]);
    assert.deepEqual(
      memory.globalMemory.subarray(0x3d0, 0x3d8),
      Uint8Array.of(0x06, 0xb4, 0x50, 0x00, 0x12, 0xcc, 0x26, 0x60),
    );
    invoke(0x81, 0xea, [0x3c0, 0x3a0, 3]);
    assert.equal(
      Buffer.from(memory.globalMemory.subarray(0x3c0, 0x3d0)).toString('hex'),
      '900150983cd24fb0d6963f7d28e17f72',
    );

    thread.moduleMemory.set(new TextEncoder().encode('entry\0'), 0x80);
    assert.equal(invoke(0x80, 0xdc, [7, 0x10000080], true), 0);
    assert.equal(owners.persistence.strings.count(7), 1);
    owners.strings.reset(0);
    assert.equal(invoke(0x80, 0xd9, [7], true), 0);
    assert.ok(definitions.some((entry) => entry.primary === 0xc0 && entry.secondary === 0x00));
  } finally {
    await graph.shutdown();
  }
});

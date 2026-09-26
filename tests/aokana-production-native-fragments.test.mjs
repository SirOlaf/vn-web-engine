import test from 'node:test';
import assert from 'node:assert/strict';
import {MountedFileSystem, StoredFileSystem} from '../dist/platform/filesystem.js';
import {MemoryStore} from '../dist/platform/store.js';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, pop32, push32} from '../dist/engines/buriko/bp/state.js';
import {BurikoMemorySpeakerBackend} from '../dist/engines/buriko/native/audio/speaker-backend.js';
import {BurikoMountedFileMetadata} from '../dist/engines/buriko/native/file-metadata.js';
import {BurikoMountedProgramPaths} from '../dist/engines/buriko/native/program-paths.js';
import {BurikoProgramMedia} from '../dist/engines/buriko/native/program-files.js';
import {BurikoProductionDataOwners} from '../dist/engines/buriko/native/production-data-owners.js';
import {BurikoProductionNativeFragments} from '../dist/engines/buriko/native/production-native-fragments.js';
import {BurikoProductionDisplayResourceGraph} from '../dist/engines/buriko/native/production-display-resource-graph.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';

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
  append(...children) {
    for (const child of children) {
      this.children.push(child);
      child.parent = this;
    }
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
  remove() {
    if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
}

function oneImportedText(text) {
  const bytes = [];
  const word = (value) =>
    bytes.push(value & 255, (value >>> 8) & 255, (value >>> 16) & 255, value >>> 24);
  const string = (value) => bytes.push(...text.encodeWide(value, 1));
  word(1);
  string('項目');
  word(1);
  string('名前');
  string('青');
  return Uint8Array.from(bytes);
}

function expectedFileChecksum(bytes) {
  let rolling = 0n;
  let rollingSum = 0;
  let rollingXor = 0;
  let byteSum = 0;
  let byteXor = 0;
  for (const byte of bytes) {
    rolling = (rolling * 233n + BigInt(byte)) & 0xffffffffn;
    const low = Number(rolling & 255n);
    rollingSum = (rollingSum + low) & 255;
    rollingXor ^= low;
    byteSum = (byteSum + byte) & 255;
    byteXor ^= byte;
  }
  const result = new Uint8Array(8);
  new DataView(result.buffer).setUint32(0, Number(rolling), true);
  result.set([rollingSum, rollingXor, byteSum, byteXor], 4);
  return result;
}

test('partial production catalog routes BP calls through graph and mounted resource owners', async () => {
  const files = new StoredFileSystem(new MemoryStore(), (path) => path.toLowerCase());
  await files.commit([
    {kind: 'write', path: '/Zulu.bin', data: Uint8Array.of(1)},
    {kind: 'write', path: '/Alpha.bin', data: Uint8Array.of(2)},
  ]);
  const backing = new MountedFileSystem();
  backing.mount('/game', files);
  const mounted = new BurikoMountedFileMetadata(backing, {
    records: [],
    volumes: [{path: '/', identity: {}, writable: true}],
    canonical: (path) => path.toLowerCase(),
    currentFileTime: () => 123n,
    accessTimePolicy: 'disabled',
    namespace: {
      entries: [
        {path: '/game/zulu.bin', name: 'Zulu.bin', shortName: null},
        {path: '/game/alpha.bin', name: 'Alpha.bin', shortName: null},
      ],
      newShortNames: 'disabled',
      fold: (name) => name.toUpperCase(),
    },
    move: {
      contents: 'ordinary-single-stream',
      security: 'unsupported',
      copiedTimes: 'preserve-source',
      copyDeleteFailure: 'success-retain-source',
    },
  });
  const paths = new BurikoMountedProgramPaths(
    [
      {native: 'C:\\game', mounted: '/game'},
      {native: 'D:\\Drops', mounted: '/drops'},
    ],
    'C:\\game',
  );
  const text = new BurikoNativeText();
  const encode = (value) => text.encodeWide(value, 1);
  let frameMilliseconds = 0;
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
    nativeWindowTitle: encode('Buriko'),
    productIdentity: encode('AoNoKanataNoFourRhythmUEDL'),
    preferredDialogTitle: null,
    cursorResource: null,
    performance: {now: () => frameMilliseconds},
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
      shellAllocatorAvailable: true,
      windows: 'C:\\game\\Windows',
      programFiles: 'C:\\Program Files',
      currentUser: {
        desktop: 'C:\\Users\\Current\\Desktop',
        programs: 'C:\\Users\\Current\\Programs',
        documents: 'C:\\Users\\Current\\Documents',
        profile: 'C:\\Users\\Current',
      },
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
      media: new BurikoProgramMedia(),
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
      backend: new BurikoMemorySpeakerBackend(1000),
      output: {prefer24Bit: false},
      resourceWorkerCount: 1,
      sleep: async () => {},
    },
  };
  assert.throws(
    () =>
      new BurikoProductionDisplayResourceGraph({...graphInputs, specialFolderProfile: undefined}),
    /folder inputs/,
  );
  assert.throws(
    () =>
      new BurikoProductionDisplayResourceGraph({
        ...graphInputs,
        specialFolderProfile: {...graphInputs.specialFolderProfile, currentUser: {}},
      }),
    /folder inputs/,
  );
  const graph = new BurikoProductionDisplayResourceGraph(graphInputs);
  let titlePanel = null;
  let titleEditorId = null;
  let titleEditorTarget = null;
  try {
    const memory = new BurikoBpMemory(new Uint8Array(0x1000));
    const owners = new BurikoProductionDataOwners(graph, memory);
    const catalog = new BurikoProductionNativeFragments(graph, owners);
    const definitions = catalog.nativeDefinitions();
    const keys = definitions.map(({primary, secondary}) => `${primary}:${secondary}`);
    assert.equal(new Set(keys).size, keys.length);
    assert.equal(keys.includes('144:63'), true); // 90:3F uses the manager's native fatal branch.
    assert.deepEqual(
      definitions
        .filter(
          ({primary, secondary}) =>
            primary === 0x81 && [0x0b, 0x0e, 0x64, 0x66, 0x6d, 0x6f].includes(secondary),
        )
        .map(({secondary}) => secondary),
      [0x0b, 0x66, 0x6d, 0x6f],
    );
    const thread = new BurikoBpThread({
      id: 1,
      operandCapacity: 16,
      moduleCapacity: 512,
      frameCapacity: 0,
    });
    const invoke = async (primary, secondary, args = [], output = false) => {
      for (const value of args) push32(thread, value);
      const definition = definitions.find(
        (entry) => entry.primary === primary && entry.secondary === secondary,
      );
      assert.ok(definition, `missing ${primary.toString(16)}:${secondary.toString(16)}`);
      assert.equal(await definition.execute({thread, memory}), 0);
      const result = output ? pop32(thread) : undefined;
      assert.equal(thread.stackIndex, 0);
      return result;
    };
    assert.equal(graph.dialogs.fallbackTitle, graph.title.bytes);
    assert.equal(graph.children.nativeWindowTitle, graph.title.bytes);
    assert.equal(graph.properties.nativeWindowTitle, graph.title.bytes);
    assert.equal(graph.properties.text, graph.text);
    assert.equal(graph.properties.messages, graph.messages);
    const caption = graph.text.encodeWide('蒼空', 0);
    memory.globalMemory.set(caption, 0x900);
    const setTitle = definitions.find(
      ({primary, secondary}) => primary === 0x80 && secondary === 0x66,
    );
    assert.ok(setTitle);
    push32(thread, 0x900);
    assert.throws(
      () => setTitle.execute({thread, memory: new BurikoBpMemory(new Uint8Array(0x1000))}),
      /aggregate BP memory/,
    );
    assert.equal(pop32(thread), 0x900);
    await invoke(0x80, 0x66, [0x900]);
    assert.equal(document.title, '蒼空');
    assert.deepEqual([...graph.title.bytes.subarray(0, caption.length)], [...caption]);
    const beforePanels = parent.children.length;
    const beforeTargets = new Set(
      Array.from({length: 8}, (_, index) => index + 1).filter((target) =>
        graph.messages.hasTarget(target),
      ),
    );
    assert.equal(
      graph.properties.create(
        {bytes: memory.globalMemory, offset: 0x980},
        null,
        null,
        null,
        120,
        180,
      ),
      0,
    );
    titleEditorId = new DataView(memory.globalMemory.buffer).getUint32(0x980, true);
    titlePanel = parent.children.at(-1);
    assert.equal(parent.children.length, beforePanels + 1);
    assert.equal(titlePanel.children[0].textContent, '蒼空');
    titleEditorTarget = Array.from({length: 8}, (_, index) => index + 1).find(
      (target) => !beforeTargets.has(target) && graph.messages.hasTarget(target),
    );
    assert.ok(titleEditorTarget);
    const readAdapter = definitions.find(
      ({primary, secondary}) => primary === 0x81 && secondary === 0x0b,
    );
    for (const address of [0xd00, 0xd40, 0xd80]) push32(thread, address);
    assert.throws(
      () => readAdapter.execute({thread, memory: new BurikoBpMemory(new Uint8Array(0x1000))}),
      /aggregate BP memory/,
    );
    assert.deepEqual([pop32(thread), pop32(thread), pop32(thread)], [0xd80, 0xd40, 0xd00]);
    assert.equal(thread.stackIndex, 0);

    const identifier = graph.display.adapterIdentifier;
    identifier.set(new TextEncoder().encode('  Buriko   Adapter  \0'), 0x200);
    const identifierWords = new DataView(identifier.buffer);
    [0x1122, 0x3344, 0x5566, 0x7788].forEach((value, index) =>
      identifierWords.setUint16(0x420 + index * 2, value, true),
    );
    memory.globalMemory.fill(0xa5, 0xd00, 0xe00);
    await invoke(0x81, 0x0b, [0xd00, 0xd40, 0xd80]);
    assert.deepEqual(
      [...memory.globalMemory.subarray(0xd00, 0xd10)],
      [...new TextEncoder().encode('Buriko Adapter\0'), 0xa5],
    );
    assert.deepEqual(
      [0, 4, 8, 12].map((offset) =>
        new DataView(memory.globalMemory.buffer).getUint32(0xd40 + offset, true),
      ),
      [0x7788, 0x5566, 0x3344, 0x1122],
    );
    assert.deepEqual([...memory.globalMemory.subarray(0xd80, 0xd90)], Array(16).fill(0xa5));

    await invoke(0x81, 0x66, [7]);
    assert.equal(graph.display.windowStyleOption, 7);
    assert.equal(parent['data-buriko-window-style'], '90ce0000');
    graph.display.fullscreen = 1;
    await invoke(0x81, 0x66, [0]);
    assert.equal(graph.display.windowStyleOption, 0);
    assert.equal(parent['data-buriko-window-style'], '90ce0000');
    graph.display.fullscreen = 0;
    await invoke(0x81, 0x66, [0]);
    assert.equal(parent['data-buriko-window-style'], '90ca0000');

    assert.equal(await invoke(0x81, 0x6d, [], true), 0);
    assert.equal(await invoke(0x81, 0x6f, [2], true), 1);
    assert.equal(graph.device.filterMode, 2);
    assert.equal(await invoke(0x81, 0x6f, [4], true), 0);
    assert.equal(graph.device.filterMode, 2);
    graph.display.pixelShaderVersion = 0xffff0300;
    assert.equal(await invoke(0x81, 0x6d, [], true), 0x0300);
    assert.equal(await invoke(0x81, 0x6f, [4], true), 1);
    assert.equal(graph.device.filterMode, 4);

    assert.equal(graph.frames.metrics.clock, graph.clock);
    assert.equal(graph.frames.metrics.raster, graph.device);
    assert.equal(graph.controller.mouseTrails.registry, graph.registry);
    assert.equal(graph.folders.registry, graph.registry);
    assert.equal(graph.folders.text, graph.text);
    assert.equal(graph.folders.roots, graph.resource.resources.configuration);
    assert.equal(graph.resource.files.specialFolders, graph.folders);
    assert.equal(graph.fileEnumeration.files, graph.resource.files);
    assert.equal(graph.fileEnumeration.metadata, mounted);
    const importedPacked = new TextEncoder().encode('Zulu.bin\0Alpha.bin\0');
    memory.globalMemory.set(encode('C:\\game\\*.bin'), 0x200);
    assert.equal(await invoke(0x80, 0x24, [0x200, 0], true), 2);
    assert.equal(await invoke(0x80, 0x25, [0x300, 128, 0x200, 0, 0], true), 2);
    assert.deepEqual(
      memory.globalMemory.subarray(0x300, 0x300 + importedPacked.length),
      importedPacked,
    );
    assert.equal(await invoke(0x80, 0x25, [0, 0, 0x200, 0, 0], true), importedPacked.length);
    await invoke(0x80, 0x06, [1]);
    graph.frames.metrics.begin();
    frameMilliseconds = 1;
    graph.frames.metrics.end(1);
    await invoke(0x80, 0x07, [0xa00, 0]);
    assert.equal(new DataView(memory.globalMemory.buffer).getUint32(0xa00, true), 1);
    await invoke(0x80, 0x07, [0xa00, 1]);
    assert.equal(new DataView(memory.globalMemory.buffer).getUint32(0xa00, true), 1000);
    await invoke(0x80, 0x06, [0]);
    await invoke(0x80, 0x07, [0xa00, 0]);
    assert.equal(new DataView(memory.globalMemory.buffer).getUint32(0xa00, true), 1);
    await invoke(0x80, 0x06, [1]);
    await invoke(0x80, 0x07, [0xa00, 0]);
    assert.equal(new DataView(memory.globalMemory.buffer).getUint32(0xa00, true), 0);
    graph.manager.setRenderPixelBudget(4321);
    assert.equal(await invoke(0x80, 0x0b, [], true), 4321);
    assert.equal(await invoke(0x80, 0x09, [], true), graph.display.lastPresentMilliseconds);
    assert.equal(await invoke(0x81, 0x61, [], true), graph.display.effectiveDisplayMode());
    await invoke(0x81, 0x65, [7]);
    assert.equal(graph.display.positionLock, 7);
    await invoke(0x80, 0x6c, [1]);
    assert.equal(await invoke(0x80, 0x6d, [0x10000060], true), 0);
    await invoke(0x80, 0xa1, [17, 29]);
    assert.equal(await invoke(0x80, 0xa0, [0x10000040], true), 1);
    assert.deepEqual(
      [...thread.moduleMemory.subarray(0x40, 0x4c)],
      [0, 0, 0, 0, 17, 0, 0, 0, 29, 0, 0, 0],
    );
    await invoke(0x80, 0x68, [2]);
    assert.equal(graph.host.closePolicy, 2);
    assert.equal(graph.controller.manager, graph.manager);
    assert.equal(graph.controller.device, graph.device);
    assert.equal(graph.controller.host, graph.host);
    assert.equal(graph.receiver.controller, graph.controller);
    assert.equal(graph.receiver.messages, graph.messages);
    assert.equal(graph.resource.errors.files, graph.resource.files);
    assert.equal(graph.resource.errors.dialogs, graph.dialogs);
    const toggleKeys = new DataView(memory.globalMemory.buffer);
    toggleKeys.setUint32(0xb00, 0x77, true);
    toggleKeys.setUint32(0xb04, 0x79, true);
    toggleKeys.setUint32(0xb08, 0, true);
    await invoke(0x80, 0x62, [1, 0xb00]);
    assert.equal(graph.controller.containsModeToggleKey(0x77), true);
    assert.equal(graph.controller.containsModeToggleKey(0x79), true);
    await invoke(0x80, 0x62, [0, 0]);
    assert.equal(graph.controller.containsModeToggleKey(0x77), false);
    assert.equal(graph.display.modeChangePending, 0);
    assert.equal(graph.messages.send('main', 0x100, 0x77, 0), 0);
    assert.equal(graph.display.modeChangePending, 0);
    assert.equal(graph.messages.send('main', 0x101, 0x77, 0), 0);
    await invoke(0x80, 0x62, [2, 0xb00]);
    assert.equal(graph.messages.send('main', 0x100, 0x77, 0), 0);
    assert.equal(graph.display.modeChangePending, 1);
    assert.equal(graph.device.fullscreen, 0);
    assert.equal(graph.keyboard.messages, graph.messages);
    assert.equal(graph.focusedHotkeyRegistration.keyboard, graph.keyboard);
    assert.equal(graph.keyboard.hotkeys, graph.focusedHotkeyRegistration);
    assert.equal(graph.printScreenHotkeys.messages, graph.messages);
    assert.equal(graph.printScreenHotkeys.registration, graph.focusedHotkeyRegistration);
    assert.equal(graph.focusedHotkeyRegistration.scope, 'focused-title-window');
    const hotkeyWaiter = new BurikoBpThread({
      id: 3,
      operandCapacity: 4,
      moduleCapacity: 0,
      frameCapacity: 0,
    });
    graph.waits.register(hotkeyWaiter, 0x312);
    const keyEvent = (code, keyCode, type) => ({
      code,
      keyCode,
      type,
      repeat: false,
      getModifierState: () => false,
    });
    await invoke(0x81, 0x69, [1]);
    graph.keyboard.post('main', keyEvent('ControlLeft', 17, 'keydown'));
    graph.keyboard.post('main', keyEvent('ShiftRight', 16, 'keydown'));
    graph.keyboard.post('main', keyEvent('PrintScreen', 44, 'keydown'));
    const hotkeyMessage = graph.messages.take();
    assert.deepEqual(hotkeyMessage, {
      target: 'main',
      message: 0x312,
      wParam: 6,
      lParam: 0x002c0006,
    });
    assert.equal(graph.messages.isPhysical(hotkeyMessage), true);
    assert.equal(graph.messages.dispatch(hotkeyMessage), 0);
    const hotkeyEvent = graph.waits.consume(hotkeyWaiter, 0x312);
    assert.equal(hotkeyEvent?.received, true);
    assert.equal(hotkeyEvent.value1, 6n);
    assert.equal(hotkeyEvent.value2, 0x002c0006n);
    graph.waits.unregister(hotkeyWaiter, 0x312);
    for (const key of [17, 16]) {
      const message = graph.messages.take();
      assert.equal(message.wParam, key);
      graph.messages.dispatch(message);
    }
    for (const [code, keyCode] of [
      ['PrintScreen', 44],
      ['ShiftRight', 16],
      ['ControlLeft', 17],
    ])
      graph.keyboard.post('main', keyEvent(code, keyCode, 'keyup'));
    for (let index = 0; index < 3; index++) graph.messages.dispatch(graph.messages.take());
    await invoke(0x81, 0x69, [0]);
    graph.keyboard.post('main', keyEvent('PrintScreen', 44, 'keydown'));
    const ordinaryPrintScreen = graph.messages.take();
    assert.equal(ordinaryPrintScreen.message, 0x100);
    assert.equal(ordinaryPrintScreen.wParam, 44);
    graph.messages.dispatch(ordinaryPrintScreen);
    graph.keyboard.post('main', keyEvent('PrintScreen', 44, 'keyup'));
    graph.messages.dispatch(graph.messages.take());
    assert.equal(graph.messages.pending, 0);
    assert.equal(graph.syntheticMouse.input, graph.input);
    assert.equal(graph.syntheticMouse.messages, graph.messages);
    assert.equal(graph.receiver.waits, graph.waits);
    const waiter = new BurikoBpThread({
      id: 2,
      operandCapacity: 4,
      moduleCapacity: 0,
      frameCapacity: 0,
    });
    for (const message of [0x201, 0x202, 0x20b, 0x20c]) graph.waits.register(waiter, message);
    while (graph.notifications.take() !== null) {}
    graph.input.setPhysicalKey(0x11, true);
    graph.input.setPhysicalKey(0x06, true);
    graph.display.requestedWidth = graph.display.logicalWidth;
    graph.display.requestedHeight = graph.display.logicalHeight;
    graph.input.pointerScreenX = 0x12345;
    graph.input.pointerScreenY = -2;
    const eventCount = graph.input.inputEventCount;
    assert.equal(await invoke(0x81, 0x1e, [1], true), 1);
    assert.equal(await invoke(0x81, 0x1e, [6], true), 1);
    assert.equal(await invoke(0x81, 0x1e, [3], true), 0);
    assert.equal(graph.messages.pending, 0);
    assert.equal(graph.input.inputEventCount, eventCount + 2);
    assert.deepEqual(graph.input.clickPosition(0), [0x2345, 0xfffe]);
    assert.deepEqual(graph.input.clickPosition(4), [0x2345, 0xfffe]);
    assert.deepEqual(graph.notifications.take(), {type: 3, value1: 1, value2: 0});
    assert.deepEqual(graph.notifications.take(), {type: 3, value1: 6, value2: 0});
    assert.equal(graph.notifications.take(), null);
    for (const [message, parameter] of [
      [0x201, 0x49],
      [0x202, 0x48],
      [0x20b, 0x20048],
      [0x20c, 0x20048],
    ]) {
      const event = graph.waits.consume(waiter, message);
      assert.equal(event?.received, true);
      assert.equal(event.value1, BigInt(parameter));
      assert.equal(event.value2, 0xfffe2345n);
      graph.waits.unregister(waiter, message);
    }
    assert.equal(graph.pathDirectory.files, graph.resource.files);
    assert.equal(graph.pathDirectory.metadata, mounted);
    assert.equal(graph.resource.files.text, graph.text);
    memory.globalMemory.set(graph.text.encodeWide('C:\\game\\Save', 1), 0x600);
    assert.equal(await invoke(0x80, 0x28, [0x600], true), 1);
    memory.globalMemory.set(encode('C:\\game\\*.*'), 0x200);
    assert.equal(await invoke(0x80, 0x26, [0x300, 128, 0x200, 0], true), 1);
    assert.deepEqual(
      memory.globalMemory.subarray(0x300, 0x305),
      new TextEncoder().encode('Save\0'),
    );
    assert.equal(await invoke(0x80, 0x26, [0, 0, 0x200, 0], true), 5);
    assert.equal(await invoke(0x80, 0x2a, [0x600], true), 1);
    assert.equal(await invoke(0x80, 0x2c, [0x600], true), 0x10);
    assert.equal(await invoke(0x80, 0x2d, [0x600, 0x12], true), 1);
    assert.equal(await mounted.getAttributes('/game/save'), 0x12);
    memory.globalMemory.set(graph.text.encodeWide('C:\\game\\Save\\state.dat', 1), 0x680);
    assert.equal(await invoke(0x80, 0x2b, [0x780, 0x800, 0x880, 0x900, 0x680], true), 1);
    const pathPart = (address) => {
      const end = memory.globalMemory.indexOf(0, address);
      return new TextDecoder().decode(memory.globalMemory.subarray(address, end));
    };
    assert.deepEqual([0x780, 0x800, 0x880, 0x900].map(pathPart), [
      'C:',
      '\\game\\Save\\',
      'state',
      '.dat',
    ]);
    assert.equal(await invoke(0x80, 0x29, [0x600], true), 1);
    assert.equal(await invoke(0x80, 0x2a, [0x600], true), 0);
    assert.equal(graph.resourceFileServices.resources, graph.resource.resources);
    assert.equal(graph.resource.resources.files, graph.resource.files);
    memory.globalMemory.set(Uint8Array.of(4, 6, 8), 0x4e0);
    memory.globalMemory.set(encode('BindingA.bin'), 0x500);
    memory.globalMemory.set(encode('BindingB.bin'), 0x540);
    memory.globalMemory.set(encode('C:\\game\\BindingA.bin'), 0x580);
    memory.globalMemory.set(encode('C:\\game\\BindingB.bin'), 0x5c0);
    memory.globalMemory.set(encode('C:\\game\\BindingC.bin'), 0x700);
    assert.equal(await invoke(0x80, 0x32, [0x500, 0x4e0, 3], true), 1);
    assert.equal(await invoke(0x80, 0x34, [0, 0x500], true), 1);
    assert.equal(await invoke(0x80, 0x32, [0x540, 0x4e0, 1], true), 1);
    await mounted.setAttributes('/game/bindingb.bin', 0x21);
    assert.equal(await invoke(0x80, 0x2f, [0x5c0, 0x580], true), 1);
    assert.equal(await mounted.getAttributes('/game/bindingb.bin'), 0x20);
    assert.deepEqual(
      await (await graph.resource.files.open(encode('C:\\game\\BindingB.bin'))).source.read(0, 3),
      Uint8Array.of(4, 6, 8),
    );
    assert.equal(await invoke(0x80, 0x27, [0x700, 0x5c0], true), 1);
    assert.equal((await graph.resource.files.open(encode('C:\\game\\BindingB.bin'))).source, null);
    assert.deepEqual(
      await (await graph.resource.files.open(encode('C:\\game\\BindingC.bin'))).source.read(0, 3),
      Uint8Array.of(4, 6, 8),
    );
    assert.equal(await invoke(0x80, 0x33, [0, 0x500], true), 1);
    assert.equal(await invoke(0x80, 0x34, [0, 0x500], true), 0);
    assert.equal(await invoke(0x80, 0x33, [0x700, 0], true), 1);
    await mounted.createDirectory('/game/addon');
    assert.equal(
      await graph.resource.files.write(
        encode('C:\\game\\Addon\\Found.bin'),
        Uint8Array.of(2, 4, 6, 8, 10),
      ),
      5,
    );
    memory.globalMemory.set(encode('Addon'), 0x360);
    memory.globalMemory.set(encode('Found.bin'), 0x380);
    assert.equal(await invoke(0x80, 0x35, [0, 0x380], true), 0);
    await invoke(0x80, 0x36, [1]);
    await invoke(0x80, 0x37, [0x360]);
    assert.equal(graph.resource.resources.configuration.searchDirectoriesEnabled, 1);
    assert.deepEqual(
      [...graph.resource.resources.configuration.searchDirectories[0]],
      [...new TextEncoder().encode('Addon')],
    );
    assert.equal(await invoke(0x80, 0x35, [0, 0x380], true), 5);
    await mounted.createDirectory('/game/alt');
    memory.globalMemory.set(encode('C:\\game\\Alt'), 0x3a0);
    assert.equal(await invoke(0x80, 0x3e, [0x3a0], true), 1);
    assert.equal(await invoke(0x80, 0x3d, [0x3c0, 0], true), 1);
    assert.deepEqual(
      [...memory.globalMemory.subarray(0x3c0, 0x3c0 + encode('C:\\game\\Alt\\').length)],
      [...encode('C:\\game\\Alt\\')],
    );
    assert.equal(graph.resource.resources.configuration.nativeFileRoot, 'C:\\game\\Alt\\');
    assert.equal(graph.resourceFilePresence.resources, graph.resource.resources);
    assert.equal(graph.resourceFilePresence.messages, graph.localized);
    assert.equal(graph.resource.resources.dialogs, graph.dialogs);
    graph.resource.files.media.setDriveType(2, 3);
    await graph.resource.files.write(encode('C:\\game\\Alt\\Present.bin'), new Uint8Array());
    memory.globalMemory.set(encode('Present.bin'), 0x910);
    assert.equal(await invoke(0x80, 0x3c, [0x910, 0, 0], true), 1);
    assert.equal((await mounted.stat('/game/alt/present.bin')).size, 0);
    assert.equal(graph.fileChecksum.resources, graph.resource.resources);
    const altContents = Uint8Array.of(3, 5, 8, 13, 21);
    const gameContents = Uint8Array.of(34, 55, 89);
    assert.equal(
      await graph.resource.files.write(encode('C:\\game\\Alt\\Check.bin'), altContents),
      altContents.length,
    );
    assert.equal(
      await graph.resource.files.write(encode('C:\\game\\Check.bin'), gameContents),
      gameContents.length,
    );
    memory.globalMemory.set(encode('Check.bin'), 0x940);
    memory.globalMemory.fill(0xa5, 0x97f, 0x989);
    assert.equal(await invoke(0x80, 0xe9, [0x980, 0x940], true), 1);
    assert.deepEqual(memory.globalMemory.subarray(0x980, 0x988), expectedFileChecksum(altContents));
    assert.equal(memory.globalMemory[0x97f], 0xa5);
    assert.equal(memory.globalMemory[0x988], 0xa5);
    assert.equal(await invoke(0x80, 0x3a, [0x3e0, 1], true), 1);
    assert.deepEqual(
      [
        ...memory.globalMemory.subarray(
          0x3e0,
          0x3e0 + encode('C:\\Users\\Current\\Desktop').length,
        ),
      ],
      [...encode('C:\\Users\\Current\\Desktop')],
    );
    const registryKey = await graph.registry.createKey(
      0x80000002,
      'SOFTWARE\\Microsoft\\Windows\\CurrentVersion',
      0x2011b,
    );
    assert.equal(registryKey.result, 0);
    const installed = 'D:\\Programs\0';
    const registryBytes = new Uint8Array(installed.length * 2);
    const registryView = new DataView(registryBytes.buffer);
    for (let index = 0; index < installed.length; index++)
      registryView.setUint16(index * 2, installed.charCodeAt(index), true);
    assert.equal(
      await graph.registry.setValue(registryKey.handle, 'ProgramFilesDir', 1, registryBytes),
      0,
    );
    assert.equal(graph.registry.closeKey(registryKey.handle), 0);
    assert.equal(await invoke(0x80, 0x3a, [0x420, 5], true), 1);
    assert.deepEqual(
      [...memory.globalMemory.subarray(0x420, 0x420 + encode('D:\\Programs').length)],
      [...encode('D:\\Programs')],
    );
    assert.equal(graph.registry.openHandleCount, 0);
    assert.equal(graph.installerQueries.registry, graph.registry);
    assert.equal(graph.installerQueries.folders, graph.folders);
    assert.equal(graph.installerQueries.files, graph.resource.files);
    const installerKey = await graph.registry.createKey(
      0x80000002,
      'Software\\Sprite\\AoNoKanataNoFourRhythmUEDL',
      0x20006,
    );
    assert.equal(installerKey.result, 0);
    const installedFolder = '"C:\\game\\Installed"\0';
    const installedFolderBytes = new Uint8Array(installedFolder.length * 2);
    const installedFolderView = new DataView(installedFolderBytes.buffer);
    for (let index = 0; index < installedFolder.length; index++)
      installedFolderView.setUint16(index * 2, installedFolder.charCodeAt(index), true);
    assert.equal(
      await graph.registry.setValue(
        installerKey.handle,
        'InstalledFolder',
        1,
        installedFolderBytes,
      ),
      0,
    );
    assert.equal(graph.registry.closeKey(installerKey.handle), 0);
    memory.globalMemory.set(encode('Sprite'), 0xb00);
    await invoke(0x80, 0xe8, [0xb40]);
    assert.equal(
      graph.text.decodeAuto({bytes: memory.globalMemory, offset: 0xb40}),
      'AoNoKanataNoFourRhythmUEDL',
    );
    memory.globalMemory.set(encode('aokana.path'), 0xb80);
    assert.equal(await invoke(0x80, 0xf8, [0xc00, 0xb00, 0xb40], true), 1);
    assert.equal(
      graph.text.decodeAuto({bytes: memory.globalMemory, offset: 0xc00}),
      'C:\\game\\Installed',
    );
    assert.equal(graph.registry.openHandleCount, 0);
    assert.equal(await invoke(0x80, 0xf9, [0xb00, 0xb40], true), 1);
    assert.equal(
      await graph.registry.storage.hasKey({
        hive: 'HKLM',
        view: '64',
        path: 'Software\\Sprite\\AoNoKanataNoFourRhythmUEDL',
      }),
      false,
    );
    await mounted.createDirectory('/game/windows');
    await mounted.createDirectory('/game/installed');
    await graph.resource.files.write(
      encode('C:\\game\\Windows\\aokana.path'),
      encode('C:\\game\\Installed\\'),
    );
    await graph.resource.files.write(
      encode('C:\\game\\Installed\\content.txt'),
      Uint8Array.of(11, 23, 37),
    );
    await invoke(0x80, 0xfb, [0xc40]);
    assert.equal(
      graph.text.decodeAuto({bytes: memory.globalMemory, offset: 0xc40}),
      'C:\\game\\Windows',
    );
    assert.equal(await invoke(0x80, 0xfa, [0xc80, 0xb80], true), 1);
    assert.equal(
      graph.text.decodeAuto({bytes: memory.globalMemory, offset: 0xc80}),
      'C:\\game\\Installed',
    );
    graph.folders.combine(
      {bytes: memory.globalMemory, offset: 0xe00},
      {bytes: memory.globalMemory, offset: 0xc80},
      1,
      {bytes: encode('content.txt'), offset: 0},
    );
    const installedContent = await graph.resource.files.open(memory.globalMemory.subarray(0xe00));
    assert.ok(installedContent.source);
    assert.deepEqual(
      await graph.resource.files.read(installedContent.source, 0, 3),
      Uint8Array.of(11, 23, 37),
    );
    assert.equal(await invoke(0x80, 0xfe, [], true), 1);
    memory.globalMemory.set(encode('C:\\game'), 0x440);
    assert.equal(await invoke(0x80, 0x3e, [0x440], true), 1);
    assert.equal(await invoke(0x80, 0xe9, [0x980, 0x940], true), 1);
    assert.deepEqual(
      memory.globalMemory.subarray(0x980, 0x988),
      expectedFileChecksum(gameContents),
    );
    assert.equal(memory.globalMemory[0x97f], 0xa5);
    assert.equal(memory.globalMemory[0x988], 0xa5);
    await graph.resource.files.write(encode('C:\\game\\Raw.bin'), Uint8Array.of(8, 9, 10, 11));
    thread.moduleMemory.set(encode('Raw.bin'), 0x80);
    assert.equal(await invoke(0x80, 0x31, [0x100000a0, 0, 0x10000080, 1, 2], true), 0);
    assert.deepEqual([...thread.moduleMemory.subarray(0xa0, 0xa2)], [9, 10]);
    assert.equal(await invoke(0x81, 0x35, [0, 0x10000080], true), 4);
    thread.moduleMemory.set(encode('C:\\game\\Raw.bin'), 0xb0);
    assert.equal(
      await invoke(0x81, 0x2c, [0x100001a0, 0x100001b0, 0x100001c0, 0x100000b0], true),
      1,
    );
    assert.equal(
      await invoke(0x81, 0x2d, [0x100000b0, 0x100001a0, 0x100001b0, 0x100001c0], true),
      1,
    );
    thread.moduleMemory.set(encode('Virtual.arc'), 0x150);
    thread.moduleMemory.set(encode('Raw.bin'), 0x170);
    const pointers = new DataView(thread.moduleMemory.buffer);
    pointers.setUint32(0x190, 0x10000170, true);
    pointers.setUint32(0x194, 0, true);
    assert.equal(await invoke(0x80, 0x38, [0x10000150, 0x10000190], true), 1);
    assert.equal(await invoke(0x80, 0x38, [0x10000150, 0x10000190], true), 0);
    assert.equal(graph.resource.errors, graph.resource.resources.errors);
    await invoke(0x81, 0x6a, [0x89abcdef]);
    assert.equal(graph.resource.errors.getCaptureEnabled(), 0x89abcdef);
    assert.equal(await invoke(0x81, 0x6b, [0], true), 0);
    assert.equal(graph.resource.errors.captureFirst(Uint8Array.of(65, 66, 0)), 1);
    memory.globalMemory.fill(0xa5, 0x200, 0x204);
    assert.equal(await invoke(0x81, 0x6b, [0x200], true), 3);
    assert.deepEqual([...memory.globalMemory.subarray(0x200, 0x204)], [65, 66, 0, 0xa5]);

    await graph.resource.files.write(encode('C:\\game\\Script.bin'), Uint8Array.of(3, 5, 7, 9));
    await graph.start({automatic: false});
    assert.equal(graph.resource.worker.scripts, graph.resource.scripts);
    memory.globalMemory.set(encode('C:\\game\\Script.bin'), 0x300);
    assert.equal(await invoke(0x81, 0x28, [0x220, 0x300, 0], true), 0);
    const scriptId = new DataView(memory.globalMemory.buffer).getUint32(0x220, true);
    assert.equal(scriptId, 1);
    assert.equal(await invoke(0x81, 0x2b, [0x224, scriptId, 1], true), 0);
    assert.equal(await graph.resource.worker.processOne(), 'script');
    assert.equal(new DataView(memory.globalMemory.buffer).getUint32(0x224, true), 1);
    assert.equal(await invoke(0x81, 0x2a, [0x224, scriptId, 0x240, 2], true), 0);
    assert.equal(await graph.resource.worker.processOne(), 'script');
    assert.deepEqual([...memory.globalMemory.subarray(0x240, 0x242)], [5, 7]);
    assert.equal(new DataView(memory.globalMemory.buffer).getUint32(0x224, true), 2);
    assert.equal(await invoke(0x81, 0x29, [0x224, scriptId], true), 0);
    assert.equal(await graph.resource.worker.processOne(), 'script');
    assert.equal(new DataView(memory.globalMemory.buffer).getUint32(0x224, true), 1);
    assert.equal(graph.resource.scripts.find(scriptId), null);

    assert.equal(graph.localized.text, graph.text);
    assert.equal(await invoke(0x81, 0x00, [1], true), 1);
    assert.equal(graph.text.codePage, 65001);
    memory.globalMemory.set(new TextEncoder().encode('abc\0'), 0x300);
    assert.equal(await invoke(0x81, 0x27, [0x300], true), 0x80000000);
    assert.equal(await invoke(0x81, 0x20, [0x340, 0x300, 2], true), 3);
    assert.deepEqual([...new Uint16Array(memory.globalMemory.buffer, 0x340, 4)], [97, 98, 99, 0]);
    graph.localized.load(new TextEncoder().encode('KEY=base\n@languageid=411\nKEY=Japanese\n'));
    const key = {bytes: new TextEncoder().encode('KEY\0'), offset: 0};
    const readLocalized = () => {
      const result = graph.localized.lookup(key);
      assert.ok(result);
      const end = result.bytes.indexOf(0, result.offset);
      return new TextDecoder().decode(result.bytes.subarray(result.offset, end));
    };
    assert.equal(readLocalized(), 'base');
    assert.equal(await invoke(0x81, 0x02, [0x411], true), 0x411);
    assert.equal(readLocalized(), 'Japanese');
    assert.equal(await invoke(0x81, 0x01, [], true), 1);
    assert.equal(await invoke(0x81, 0x03, [], true), graph.localized.language.value);
    assert.equal(graph.localized.importedMessages.text, graph.text);
    const imported = oneImportedText(graph.text);
    memory.globalMemory.set(imported, 0x400);
    memory.globalMemory.set(graph.text.encodeWide('項目', 0), 0x480);
    memory.globalMemory.set(graph.text.encodeWide('名前', 0), 0x4a0);
    memory.globalMemory.fill(0xa5, 0x4c0, 0x4c5);
    assert.equal(await invoke(0x81, 0xd8, [0x400, imported.length], true), 1);
    assert.equal(await invoke(0x81, 0xda, [0x4c0, 0x480, 0x4a0], true), 3);
    assert.deepEqual(
      [...memory.globalMemory.subarray(0x4c0, 0x4c4)],
      [...graph.text.encodeWide('青', 1)],
    );
    graph.localized.clear();
    memory.globalMemory.fill(0xa5, 0x4c0, 0x4c5);
    assert.equal(await invoke(0x81, 0xda, [0x4c0, 0x480, 0x4a0], true), 0);
    assert.deepEqual([...memory.globalMemory.subarray(0x4c0, 0x4c5)], Array(5).fill(0xa5));
    assert.equal(await invoke(0x81, 0x6e, [], true), 1);
    for (const [primary, secondary] of [
      [0x80, 0x30],
      [0x81, 0x39],
      [0x81, 0x3c],
    ])
      assert.ok(
        definitions.some((entry) => entry.primary === primary && entry.secondary === secondary),
      );
  } finally {
    await graph.shutdown();
  }
  assert.ok(!parent.children.includes(titlePanel));
  assert.equal(graph.properties.destroy(titleEditorId), 0x80000007);
  assert.equal(graph.messages.hasTarget(titleEditorTarget), false);
  graph.properties.dispose();
});

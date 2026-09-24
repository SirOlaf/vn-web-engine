import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaNativeClock} from '../dist/engines/buriko/games/aokana/native/clock.js';
import {AokanaBpDiagnostics} from '../dist/engines/buriko/games/aokana/native/diagnostics.js';
import {AokanaNativeDisplayState} from '../dist/engines/buriko/games/aokana/native/display-state.js';
import {
  AokanaEngineDialogs,
  AokanaNativeCursor,
} from '../dist/engines/buriko/games/aokana/native/engine-dialogs.js';
import {AokanaFileSelectionService} from '../dist/engines/buriko/games/aokana/native/file-selection.js';
import {createGroup81FileSelection} from '../dist/engines/buriko/games/aokana/native/group-81-file-selection.js';
import {AokanaNativeInput} from '../dist/engines/buriko/games/aokana/native/input.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';

const encode = (value) => new TextEncoder().encode(value);
const OUTPUT = 0x100;

function setup() {
  const events = [],
    requests = [],
    memoryBytes = new Uint8Array(8192).fill(0xa5),
    memory = new AokanaBpMemory(memoryBytes),
    thread = new AokanaBpThread({
      id: 1,
      operandCapacity: 16,
      moduleCapacity: 0,
      frameCapacity: 0,
    }),
    diagnostics = new AokanaBpDiagnostics(() => {}),
    display = new AokanaNativeDisplayState(1920, 1080);
  display.fullscreen = 1;
  display.displayFlag = 0;

  let tick = 100,
    inputClears = 0,
    nextAddress = 0x500,
    observeHost = () => {},
    openResult = null,
    saveResult = null;
  const clock = new AokanaNativeClock(() => tick);
  clock.suspensionEnabled = true;
  const nativeBegin = clock.beginSuspension.bind(clock),
    nativeEnd = clock.endSuspension.bind(clock);
  clock.beginSuspension = (force) => {
    events.push(['clock-begin', force]);
    return nativeBegin(force);
  };
  clock.endSuspension = () => {
    events.push(['clock-end']);
    return nativeEnd();
  };

  const input = new AokanaNativeInput(display, clock),
    nativeClear = input.clearTransientKeys.bind(input);
  input.clearTransientKeys = () => {
    inputClears++;
    nativeClear();
  };
  const surface = {style: {cursor: ''}},
    cursor = new AokanaNativeCursor(surface);
  cursor.setVisible(0);
  const device = {
      isPresent: () => true,
      refresh(dialogBoxMode) {
        events.push(['refresh', dialogBoxMode]);
      },
    },
    dialogs = new AokanaEngineDialogs(
      {},
      new AokanaNativeText(),
      clock,
      input,
      cursor,
      device,
      display,
      null,
      encode('Aokana\0'),
    ),
    mainWindowIdentity = {},
    host = {
      async selectOpenFile(request) {
        events.push(['host', 'open']);
        requests.push({kind: 'open', request});
        observeHost('open', request);
        return openResult;
      },
      async selectSaveFile(request) {
        events.push(['host', 'save']);
        requests.push({kind: 'save', request});
        observeHost('save', request);
        return saveResult;
      },
    },
    service = new AokanaFileSelectionService(dialogs, clock, mainWindowIdentity, host),
    [definition] = createGroup81FileSelection(service),
    context = {thread, memory, diagnostics};

  function storeBytes(bytes) {
    const address = nextAddress;
    memoryBytes.set(bytes, address);
    nextAddress += bytes.length + 8;
    return address;
  }
  function storeText(value) {
    return storeBytes(Uint8Array.of(...encode(value), 0));
  }
  function storeAddressArray(addresses) {
    nextAddress = (nextAddress + 3) & ~3;
    const address = nextAddress,
      view = new DataView(memoryBytes.buffer);
    addresses.forEach((value, index) => view.setUint32(address + index * 4, value, true));
    nextAddress += addresses.length * 4 + 8;
    return address;
  }
  async function invoke({
    output = OUTPUT,
    count,
    descriptionAddresses = 0,
    patternAddresses = 0,
    title = 0,
    initialDirectory = 0,
    mode,
  }) {
    for (const value of [
      output,
      count,
      descriptionAddresses,
      patternAddresses,
      title,
      initialDirectory,
      mode,
    ])
      push32(thread, value);
    assert.equal(await definition.execute(context), 0);
    const result = pop32(thread);
    assert.equal(thread.stackIndex, 0);
    return result;
  }

  return {
    clock,
    cursor,
    definition,
    display,
    events,
    invoke,
    mainWindowIdentity,
    memoryBytes,
    requests,
    surface,
    storeAddressArray,
    storeText,
    inputClearCount: () => inputClears,
    setHostObserver(value) {
      observeHost = value;
    },
    setOpenResult(value) {
      openResult = value;
    },
    setSaveResult(value) {
      saveResult = value;
    },
    setTick(value) {
      tick = value;
    },
  };
}

test('81 38 opens with exact ANSI request bytes and the shared display/clock lifecycle', async () => {
  const state = setup(),
    firstDescription = state.storeText('Images'),
    secondDescription = state.storeText('Scripts'),
    firstPattern = state.storeText('*.png;*.jpg'),
    secondPattern = state.storeText('*.ks'),
    descriptions = state.storeAddressArray([firstDescription, secondDescription]),
    patterns = state.storeAddressArray([firstPattern, secondPattern]),
    title = state.storeText('Pick a file'),
    initialDirectory = state.storeText('C:\\game\\data'),
    expectedTitle = encode('Pick a file\0'),
    expectedInitialDirectory = encode('C:\\game\\data\0'),
    expectedFilter = encode('Images\0*.png;*.jpg\0Scripts\0*.ks\0\0'),
    selected = encode('C:\\picked\\image.png\0');
  state.setOpenResult(selected);
  state.setHostObserver((kind, request) => {
    assert.equal(kind, 'open');
    assert.deepEqual(state.memoryBytes.slice(OUTPUT, OUTPUT + 0x30c), new Uint8Array(0x30c));
    state.setTick(200);
    assert.equal(state.clock.read(), 100n);
    assert.deepEqual(request.filter, expectedFilter);
    assert.deepEqual(request.title, expectedTitle);
    assert.deepEqual(request.initialDirectory, expectedInitialDirectory);
  });

  assert.equal(
    await state.invoke({
      count: 2,
      descriptionAddresses: descriptions,
      patternAddresses: patterns,
      title,
      initialDirectory,
      mode: 0,
    }),
    0,
  );
  assert.equal(state.requests.length, 1);
  const [{request}] = state.requests;
  assert.equal(request.structureSize, 0x98);
  assert.equal(request.owner, state.mainWindowIdentity);
  assert.equal(request.filterIndex, 1);
  assert.equal(request.fileCapacity, 0x30c);
  assert.deepEqual(request.defaultExtension, Uint8Array.of(0));
  assert.equal(request.flags, 0x1804);
  assert.deepEqual(state.memoryBytes.slice(OUTPUT, OUTPUT + selected.length), selected);
  assert.deepEqual(
    state.memoryBytes.slice(OUTPUT + selected.length, OUTPUT + 0x30c),
    new Uint8Array(0x30c - selected.length),
  );
  assert.equal(state.memoryBytes[OUTPUT - 1], 0xa5);
  assert.equal(state.memoryBytes[OUTPUT + 0x30c], 0xa5);
  assert.deepEqual(state.events, [
    ['refresh', true],
    ['clock-begin', true],
    ['host', 'open'],
    ['clock-end'],
    ['refresh', false],
  ]);
  assert.equal(state.display.modalDepth, 0);
  assert.equal(state.cursor.requestedVisibility, 0);
  assert.equal(state.surface.style.cursor, 'none');
  assert.equal(state.inputClearCount(), 0);
  assert.equal(state.definition.primary, 0x81);
  assert.equal(state.definition.secondary, 0x38);
  assert.equal(state.definition.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[0x81][0x38]);
});

test('81 38 routes save cancellation with native flags and leaves the cleared output', async () => {
  const state = setup(),
    description = state.storeText('All files'),
    pattern = state.storeText('*.*'),
    descriptions = state.storeAddressArray([description]),
    patterns = state.storeAddressArray([pattern]);
  state.setSaveResult(null);
  assert.equal(
    await state.invoke({
      count: 1,
      descriptionAddresses: descriptions,
      patternAddresses: patterns,
      mode: 1,
    }),
    0xffffffff,
  );
  assert.equal(state.requests.length, 1);
  const [{kind, request}] = state.requests;
  assert.equal(kind, 'save');
  assert.equal(request.flags, 0x806);
  assert.equal(request.title, null);
  assert.equal(request.initialDirectory, null);
  assert.deepEqual(request.filter, encode('All files\0*.*\0\0'));
  assert.deepEqual(state.memoryBytes.slice(OUTPUT, OUTPUT + 0x30c), new Uint8Array(0x30c));
  assert.equal(state.memoryBytes[OUTPUT - 1], 0xa5);
  assert.equal(state.memoryBytes[OUTPUT + 0x30c], 0xa5);
  assert.deepEqual(state.events, [
    ['refresh', true],
    ['clock-begin', true],
    ['host', 'save'],
    ['clock-end'],
    ['refresh', false],
  ]);
  assert.equal(state.display.modalDepth, 0);
  assert.equal(state.cursor.requestedVisibility, 0);
  assert.equal(state.inputClearCount(), 0);
});

test('81 38 restores modal state for invalid mode and returns seven early for zero filters', async () => {
  const state = setup(),
    description = state.storeText('Text'),
    pattern = state.storeText('*.txt'),
    descriptions = state.storeAddressArray([description]),
    patterns = state.storeAddressArray([pattern]);
  assert.equal(
    await state.invoke({
      count: 1,
      descriptionAddresses: descriptions,
      patternAddresses: patterns,
      mode: 2,
    }),
    4,
  );
  assert.equal(state.requests.length, 0);
  assert.deepEqual(state.memoryBytes.slice(OUTPUT, OUTPUT + 0x30c), new Uint8Array(0x30c));
  assert.deepEqual(state.events, [
    ['refresh', true],
    ['clock-begin', true],
    ['clock-end'],
    ['refresh', false],
  ]);
  assert.equal(state.display.modalDepth, 0);
  assert.equal(state.inputClearCount(), 0);

  state.memoryBytes.fill(0x6b, OUTPUT, OUTPUT + 0x30c);
  const events = state.events.slice();
  assert.equal(await state.invoke({count: 0, mode: 99}), 7);
  assert.deepEqual(state.events, events);
  assert.deepEqual(
    state.memoryBytes.slice(OUTPUT, OUTPUT + 0x30c),
    new Uint8Array(0x30c).fill(0x6b),
  );
  assert.equal(state.requests.length, 0);
  assert.equal(state.display.modalDepth, 0);
  assert.equal(state.cursor.requestedVisibility, 0);
  assert.equal(state.inputClearCount(), 0);
});

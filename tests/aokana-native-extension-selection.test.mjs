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
import {createGroup80FileSelection} from '../dist/engines/buriko/games/aokana/native/group-80-file-selection.js';
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
    service,
    context,
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

test('80 3B formats one raw extension filter and uses the same concrete picker and modal owners', async () => {
  const state = setup(),
    [definition] = createGroup80FileSelection(state.service),
    description = state.storeText('Images'),
    extension = state.storeText('png'),
    title = state.storeText('Select image'),
    directory = state.storeText('C:\\game'),
    selected = encode('C:\\game\\picture.png\0');
  state.setOpenResult(selected);
  state.setHostObserver((kind, request) => {
    assert.equal(kind, 'open');
    assert.deepEqual(request.filter, encode('Images(*.png)\0*.png\0\0'));
    assert.deepEqual(request.defaultExtension, Uint8Array.of(0));
    assert.deepEqual(request.title, encode('Select image\0'));
    assert.deepEqual(request.initialDirectory, encode('C:\\game\0'));
    assert.equal(state.display.modalDepth, 1);
  });
  for (const value of [OUTPUT, description, extension, title, directory, 0])
    push32(state.context.thread, value);
  assert.equal(await definition.execute(state.context), 0);
  assert.equal(pop32(state.context.thread), 0);
  assert.equal(state.context.thread.stackIndex, 0);
  assert.deepEqual(state.memoryBytes.subarray(OUTPUT, OUTPUT + selected.length), selected);
  assert.deepEqual(state.events, [
    ['refresh', true],
    ['clock-begin', true],
    ['host', 'open'],
    ['clock-end'],
    ['refresh', false],
  ]);
  assert.equal(state.display.modalDepth, 0);
});

test('81 38 ordinary open retains the nonnull empty default-extension contract', async () => {
  const state = setup(),
    description = state.storeText('Scripts'),
    pattern = state.storeText('*.bp'),
    descriptions = state.storeAddressArray([description]),
    patterns = state.storeAddressArray([pattern]),
    selected = encode('C:\\game\\chapter.bp\0');
  state.setOpenResult(selected);
  assert.equal(
    await state.invoke({
      count: 1,
      descriptionAddresses: descriptions,
      patternAddresses: patterns,
      mode: 0,
    }),
    0,
  );
  assert.deepEqual(state.requests[0].request.defaultExtension, Uint8Array.of(0));
  assert.deepEqual(state.requests[0].request.filter, encode('Scripts\0*.bp\0\0'));
  assert.deepEqual(state.memoryBytes.subarray(OUTPUT, OUTPUT + selected.length), selected);
  assert.equal(state.display.modalDepth, 0);
});

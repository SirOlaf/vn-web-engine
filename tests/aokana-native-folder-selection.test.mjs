import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, pop32, push32} from '../dist/engines/buriko/bp/state.js';
import {BurikoBpDiagnostics} from '../dist/engines/buriko/native/diagnostics.js';
import {BurikoFolderSelectionService} from '../dist/engines/buriko/native/folder-selection.js';
import {createGroup81FolderSelection} from '../dist/engines/buriko/native/group-81-folder-selection.js';
import {BurikoNativeLanguage} from '../dist/engines/buriko/native/group-81-language.js';
import {BurikoImportedTextMaps} from '../dist/engines/buriko/native/imported-text-maps.js';
import {BURIKO_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/native/inventory.js';
import {BurikoLocalizedMessages} from '../dist/engines/buriko/native/localized-messages.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';

const encode = (value) => new TextEncoder().encode(value);
const OUTPUT = 0x100;

function setup(localizedSource = null) {
  const text = new BurikoNativeText(),
    language = new BurikoNativeLanguage(() => 0x409),
    localized = new BurikoLocalizedMessages(text, language, new BurikoImportedTextMaps(text));
  if (localizedSource !== null) assert.equal(localized.load(localizedSource), 1);
  const memoryBytes = new Uint8Array(4096).fill(0xa5),
    memory = new BurikoBpMemory(memoryBytes),
    thread = new BurikoBpThread({
      id: 1,
      operandCapacity: 8,
      moduleCapacity: 0,
      frameCapacity: 0,
    }),
    diagnostics = new BurikoBpDiagnostics(() => {}),
    mainWindowIdentity = {},
    requests = [];
  let nextAddress = 0x500,
    selected = null;
  const host = {
      async selectFolder(request) {
        requests.push(request);
        return selected;
      },
    },
    service = new BurikoFolderSelectionService(localized, mainWindowIdentity, host),
    [definition] = createGroup81FolderSelection(service),
    context = {thread, memory, diagnostics};

  function storeText(value) {
    const bytes = encode(`${value}\0`),
      address = nextAddress;
    memoryBytes.set(bytes, address);
    nextAddress += bytes.length + 8;
    return address;
  }
  async function invoke(title, initialPath) {
    for (const value of [OUTPUT, title, initialPath]) push32(thread, value);
    assert.equal(await definition.execute(context), 0);
    const result = pop32(thread);
    assert.equal(thread.stackIndex, 0);
    return result;
  }

  return {
    definition,
    invoke,
    mainWindowIdentity,
    memoryBytes,
    requests,
    storeText,
    text,
    setSelected(value) {
      selected = value;
    },
  };
}

test('81 3A sends the exact configured folder request and always writes accepted paths as UTF-8', async () => {
  const state = setup(),
    title = state.storeText('Choose a folder'),
    initialPath = state.storeText('C:\\game\\data'),
    selected = 'C:\\蒼空\\data',
    expected = encode(`${selected}\0`);
  state.text.selectMode(0);
  state.setSelected(selected);
  assert.equal(await state.invoke(title, initialPath), 1);
  assert.equal(state.requests.length, 1);
  assert.deepEqual(state.requests[0], {
    owner: state.mainWindowIdentity,
    rootItemIdentifier: 0x11,
    displayNameCapacity: 784,
    title: 'Choose a folder',
    flags: 3,
    initialFolder: 'C:\\game\\data',
    centerOnInitialize: true,
    image: 0,
  });
  assert.deepEqual(state.memoryBytes.slice(OUTPUT, OUTPUT + expected.length), expected);
  assert.equal(state.memoryBytes[OUTPUT - 1], 0xa5);
  assert.equal(state.memoryBytes[OUTPUT + expected.length], 0xa5);
  assert.equal(state.definition.primary, 0x81);
  assert.equal(state.definition.secondary, 0x3a);
  assert.equal(state.definition.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[0x81][0x3a]);
});

test('81 3A resolves the localized default prompt and preserves output on cancellation', async () => {
  const prompt = 'フォルダーを選択してください',
    state = setup(encode(`PLEASESELECTTHEFOLDER=${prompt}\n`)),
    before = state.memoryBytes.slice(OUTPUT, OUTPUT + 784);
  state.setSelected(null);
  assert.equal(await state.invoke(0, 0), 0);
  assert.equal(state.requests.length, 1);
  assert.deepEqual(state.requests[0], {
    owner: state.mainWindowIdentity,
    rootItemIdentifier: 0x11,
    displayNameCapacity: 784,
    title: prompt,
    flags: 3,
    initialFolder: null,
    centerOnInitialize: true,
    image: 0,
  });
  assert.deepEqual(state.memoryBytes.slice(OUTPUT, OUTPUT + 784), before);
});

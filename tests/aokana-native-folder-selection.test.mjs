import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaBpDiagnostics} from '../dist/engines/buriko/games/aokana/native/diagnostics.js';
import {AokanaFolderSelectionService} from '../dist/engines/buriko/games/aokana/native/folder-selection.js';
import {createGroup81FolderSelection} from '../dist/engines/buriko/games/aokana/native/group-81-folder-selection.js';
import {AokanaNativeLanguage} from '../dist/engines/buriko/games/aokana/native/group-81-language.js';
import {AokanaImportedTextMaps} from '../dist/engines/buriko/games/aokana/native/imported-text-maps.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';
import {AokanaLocalizedMessages} from '../dist/engines/buriko/games/aokana/native/localized-messages.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';

const encode = (value) => new TextEncoder().encode(value);
const OUTPUT = 0x100;

function setup(localizedSource = null) {
  const text = new AokanaNativeText(),
    language = new AokanaNativeLanguage(() => 0x409),
    localized = new AokanaLocalizedMessages(text, language, new AokanaImportedTextMaps(text));
  if (localizedSource !== null) assert.equal(localized.load(localizedSource), 1);
  const memoryBytes = new Uint8Array(4096).fill(0xa5),
    memory = new AokanaBpMemory(memoryBytes),
    thread = new AokanaBpThread({
      id: 1,
      operandCapacity: 8,
      moduleCapacity: 0,
      frameCapacity: 0,
    }),
    diagnostics = new AokanaBpDiagnostics(() => {}),
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
    service = new AokanaFolderSelectionService(localized, mainWindowIdentity, host),
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
  assert.equal(state.definition.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[0x81][0x3a]);
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

import test from 'node:test';
import assert from 'node:assert/strict';
import {BlobSource} from '../dist/core/source.js';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {
  AokanaDistributedAllocator,
  AokanaDistributedProcessing,
} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {createGroup81ArchiveSelection} from '../dist/engines/buriko/games/aokana/native/group-81-archive-selection.js';
import {
  AokanaProgramFiles,
  AokanaProgramMedia,
} from '../dist/engines/buriko/games/aokana/native/program-files.js';
import {AokanaProgramResources} from '../dist/engines/buriko/games/aokana/native/program-resources.js';
import {AokanaSelectionDialog} from '../dist/engines/buriko/games/aokana/native/selection-dialog.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';
import {SourceFileSystem} from '../dist/platform/filesystem.js';
import {WindowsFileSystem, windowsFileKey} from '../dist/platform/windows-filesystem.js';

const bytes = (value) => new TextEncoder().encode(value);

function archive(names) {
  const output = new Uint8Array(16 + names.length * 128),
    view = new DataView(output.buffer);
  output.set(bytes('BURIKO ARC20'));
  view.setUint32(12, names.length, true);
  names.forEach((name, index) => output.set(bytes(`${name}\0`), 16 + index * 128));
  return output;
}

function setup(choice) {
  const sources = new SourceFileSystem(windowsFileKey),
    fileSystem = new WindowsFileSystem(sources, {
      cwd: 'C:\\game',
      mounts: [{windows: 'C:\\', virtual: '/'}],
    }),
    text = new AokanaNativeText(),
    media = new AokanaProgramMedia();
  media.setDriveType(2, 3);
  const files = new AokanaProgramFiles(fileSystem, text, media),
    unavailable = () => assert.fail('Archive selection opened an unexpected diagnostic'),
    resources = new AokanaProgramResources(
      files,
      {
        nativeFileRoot: 'C:\\game\\',
        primaryRoot: bytes('C:\\game\\'),
        secondaryRoot: bytes('C:\\disc\\'),
        secondaryMediaPath: 'C:\\disc\\',
        searchDirectoriesEnabled: 0,
        searchDirectories: [],
        retryTitle: bytes('Media'),
        retryMessage: bytes('Insert'),
        quitConfirmation: bytes('Quit?'),
      },
      {show: unavailable},
      {fatal: unavailable, threadFatal: unavailable},
      new AokanaDistributedProcessing(new AokanaDistributedAllocator(1), 1),
    ),
    requests = [],
    selection = new AokanaSelectionDialog(
      {
        async withNativeModal(operation) {
          return operation();
        },
        async chooseList(title, prompt, items) {
          requests.push({title, prompt, items});
          return choice;
        },
      },
      text,
    ),
    memoryBytes = new Uint8Array(1024).fill(0xa5),
    memory = new AokanaBpMemory(memoryBytes),
    thread = new AokanaBpThread({
      id: 1,
      operandCapacity: 16,
      moduleCapacity: 0,
      frameCapacity: 0,
    }),
    [definition] = createGroup81ArchiveSelection(resources, selection);
  let nextText = 32;
  return {
    definition,
    memoryBytes,
    requests,
    name(value) {
      const address = nextText,
        encoded = bytes(`${value}\0`);
      nextText += encoded.length + 8;
      memoryBytes.set(encoded, address);
      return address;
    },
    mount(path, names) {
      sources.attach(path, new BlobSource(new Blob([archive(names)])));
    },
    async invoke(output, title, prompt, path) {
      for (const value of [output, title, prompt, path]) push32(thread, value);
      assert.equal(await definition.execute({thread, memory, diagnostics: {}}), 0);
      const result = pop32(thread);
      assert.equal(thread.stackIndex, 0);
      return result;
    },
  };
}

test('81 3B selects an entry from a relative primary-root archive in index order', async () => {
  const state = setup({accepted: true, index: 1});
  state.mount('/game/data.arc', ['Zeta', 'Alpha']);
  const path = state.name('data.arc'),
    prompt = state.name('Choose'),
    title = state.name('Archive'),
    output = 768;
  assert.equal(await state.invoke(output, title, prompt, path), 0);
  assert.deepEqual(state.requests, [
    {title: 'Archive', prompt: 'Choose', items: ['zeta', 'alpha']},
  ]);
  assert.deepEqual(state.memoryBytes.slice(output, output + 6), bytes('alpha\0'));
  assert.equal(state.definition.primary, 0x81);
  assert.equal(state.definition.secondary, 0x3b);
  assert.equal(state.definition.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[0x81][0x3b]);
});

test('81 3B maps cancellation to raw FFFFFFFF and preserves the output', async () => {
  const state = setup({accepted: false, index: null});
  state.mount('/game/data.arc', ['First', 'Second']);
  const path = state.name('C:\\GAME\\DATA.ARC'),
    prompt = state.name('Choose'),
    title = state.name('Archive'),
    output = 768;
  assert.equal(await state.invoke(output, title, prompt, path), 0xffffffff);
  assert.deepEqual(state.memoryBytes.slice(output, output + 8), new Uint8Array(8).fill(0xa5));
  assert.deepEqual(state.requests[0].items, ['first', 'second']);
});

test('81 3B returns one for a missing archive without entering the dialog or writing output', async () => {
  const state = setup({accepted: true, index: 0}),
    path = state.name('missing.arc'),
    prompt = state.name('Choose'),
    title = state.name('Archive'),
    output = 768;
  assert.equal(await state.invoke(output, title, prompt, path), 1);
  assert.deepEqual(state.requests, []);
  assert.deepEqual(state.memoryBytes.slice(output, output + 8), new Uint8Array(8).fill(0xa5));
});

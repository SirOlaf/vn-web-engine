import test from 'node:test';
import assert from 'node:assert/strict';
import {BlobSource} from '../dist/core/source.js';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, pop32, push32} from '../dist/engines/buriko/bp/state.js';
import {
  BurikoDistributedAllocator,
  BurikoDistributedProcessing,
} from '../dist/engines/buriko/native/distributed-processing.js';
import {createGroup81ArchiveNames} from '../dist/engines/buriko/native/group-81-archive-names.js';
import {
  BurikoProgramFiles,
  BurikoProgramMedia,
} from '../dist/engines/buriko/native/program-files.js';
import {BurikoProgramResources} from '../dist/engines/buriko/native/program-resources.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';
import {SourceFileSystem} from '../dist/platform/filesystem.js';
import {WindowsFileSystem, windowsFileKey} from '../dist/platform/windows-filesystem.js';

const bytes = (value) => new TextEncoder().encode(value);
const put = (output, offset, value) =>
  new DataView(output.buffer, output.byteOffset, output.byteLength).setUint32(offset, value, true);

function archive(names, packed) {
  const recordSize = packed ? 32 : 128;
  const output = new Uint8Array(16 + names.length * recordSize);
  output.set(bytes(packed ? 'PackFile    ' : 'BURIKO ARC20'));
  put(output, 12, names.length);
  for (let index = 0; index < names.length; index++) {
    const offset = 16 + index * recordSize;
    output.set(bytes(names[index] + '\0'), offset);
    put(output, offset + (packed ? 16 : 96), 0);
    put(output, offset + (packed ? 20 : 100), 0);
  }
  return output;
}

function setup(packed) {
  const sources = new SourceFileSystem(windowsFileKey);
  const fileSystem = new WindowsFileSystem(sources, {
    cwd: 'C:\\game',
    mounts: [{windows: 'C:\\', virtual: '/'}],
  });
  const text = new BurikoNativeText();
  const media = new BurikoProgramMedia();
  media.setDriveType(2, 3);
  const files = new BurikoProgramFiles(fileSystem, text, media);
  const unavailable = () => assert.fail('Archive-name enumeration opened an unexpected dialog');
  const resources = new BurikoProgramResources(
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
    new BurikoDistributedProcessing(new BurikoDistributedAllocator(1), 1),
  );
  sources.attach('/game/data.arc', new BlobSource(new Blob([archive(['Zeta', 'Alpha'], packed)])));
  const memoryBytes = new Uint8Array(1024).fill(0xa5);
  const memory = new BurikoBpMemory(memoryBytes);
  const thread = new BurikoBpThread({
    id: 1,
    operandCapacity: 16,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const [definition] = createGroup81ArchiveNames(resources);
  let nextText = 32;
  const name = (value) => {
    const address = nextText;
    const encoded = bytes(value + '\0');
    nextText += encoded.length + 8;
    memoryBytes.set(encoded, address);
    return address;
  };
  const context = {thread, memory, diagnostics: {}};
  const invoke = async (packedNames, outputValue, path) => {
    for (const value of [packedNames, outputValue, path]) push32(thread, value);
    assert.equal(await definition.execute(context), 0);
    const result = pop32(thread);
    assert.equal(thread.stackIndex, 0);
    return result;
  };
  return {definition, memoryBytes, name, invoke};
}

test('81 39 enumerates cached ARC20 and PackFile names in native path and output order', async () => {
  const expected = bytes('zeta\0alpha\0');
  for (const packed of [false, true]) {
    const state = setup(packed);
    assert.equal(state.definition.primary, 0x81);
    assert.equal(state.definition.secondary, 0x39);
    assert.equal(state.definition.nativeAddress, 0x1400eb870);
    const relative = state.name('data.arc');
    const absolute = state.name('C:\\GAME\\DATA.ARC');
    const missing = state.name('missing.arc');

    assert.equal(await state.invoke(0, 400, relative), 0);
    assert.equal(new DataView(state.memoryBytes.buffer).getUint32(400, true), expected.length);

    assert.equal(await state.invoke(512, 404, absolute), 0);
    assert.equal(new DataView(state.memoryBytes.buffer).getUint32(404, true), 2);
    assert.deepEqual(state.memoryBytes.slice(512, 512 + expected.length), expected);
    assert.equal(state.memoryBytes[512 + expected.length], 0xa5);

    new DataView(state.memoryBytes.buffer).setUint32(408, 0x89abcdef, true);
    state.memoryBytes.fill(0xa5, 640, 656);
    assert.equal(await state.invoke(640, 408, missing), 1);
    assert.equal(new DataView(state.memoryBytes.buffer).getUint32(408, true), 0x89abcdef);
    assert.deepEqual(state.memoryBytes.slice(640, 656), new Uint8Array(16).fill(0xa5));
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, pop32, push32} from '../dist/engines/buriko/bp/state.js';
import {BurikoBpDiagnostics} from '../dist/engines/buriko/native/diagnostics.js';
import {createGroup81DriveFileRead} from '../dist/engines/buriko/native/group-81-drive-file-read.js';
import {
  BurikoDriveGeometryProfile,
  BurikoProgramFiles,
  BurikoProgramMedia,
} from '../dist/engines/buriko/native/program-files.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';
import {BURIKO_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/native/inventory.js';
import {SourceFileSystem} from '../dist/platform/filesystem.js';
import {WindowsFileSystem, windowsFileKey} from '../dist/platform/windows-filesystem.js';

const encode = (value) => new TextEncoder().encode(value);

class RecordingSource {
  constructor(bytes) {
    this.bytes = bytes.slice();
    this.size = bytes.length;
    this.reads = [];
  }
  async read(offset, length) {
    this.reads.push([offset, length]);
    return this.bytes.slice(offset, offset + length);
  }
}

function setup() {
  const sources = new SourceFileSystem(windowsFileKey),
    fileSystem = new WindowsFileSystem(sources, {
      cwd: 'C:\\game',
      mounts: [{windows: 'C:\\', virtual: '/'}],
    }),
    files = new BurikoProgramFiles(fileSystem, new BurikoNativeText(), new BurikoProgramMedia()),
    sectors = Array(26).fill(null);
  sectors[2] = 4;
  const profile = new BurikoDriveGeometryProfile(sectors),
    roots = [],
    host = {
      readBytesPerSector(root) {
        roots.push(root);
        return profile.readBytesPerSector(root);
      },
    },
    [definition] = createGroup81DriveFileRead(files, host),
    memoryBytes = new Uint8Array(1024).fill(0xa5),
    memory = new BurikoBpMemory(memoryBytes),
    thread = new BurikoBpThread({
      id: 1,
      operandCapacity: 16,
      moduleCapacity: 0,
      frameCapacity: 0,
    }),
    context = {thread, memory, diagnostics: new BurikoBpDiagnostics(() => {})};
  let nextText = 16;
  return {
    definition,
    memoryBytes,
    roots,
    mount(path, bytes) {
      const source = new RecordingSource(bytes);
      sources.attach(path, source);
      return source;
    },
    name(value) {
      const address = nextText,
        bytes = encode(`${value}\0`);
      nextText += bytes.length + 8;
      memoryBytes.set(bytes, address);
      return address;
    },
    async invoke(destination, outputSize, path, requestedLength) {
      for (const value of [destination, outputSize, path, requestedLength]) push32(thread, value);
      assert.equal(await definition.execute(context), 0);
      const result = pop32(thread);
      assert.equal(thread.stackIndex, 0);
      return result;
    },
  };
}

test('81 32 reads a requested prefix through the lowercase drive root and aligned range', async () => {
  const state = setup(),
    contents = Uint8Array.from({length: 12}, (_, index) => index + 1),
    source = state.mount('/game/data.bin', contents),
    path = state.name('C:\\GAME\\DATA.BIN'),
    outputSize = 480,
    destination = 512;
  assert.equal(await state.invoke(destination, outputSize, path, 5), 0);
  assert.deepEqual(state.roots, ['c:\\']);
  assert.deepEqual(source.reads, [[0, 8]]);
  assert.equal(new DataView(state.memoryBytes.buffer).getUint32(outputSize, true), 5);
  assert.deepEqual(state.memoryBytes.slice(destination, destination + 5), contents.slice(0, 5));
  assert.equal(state.memoryBytes[destination - 1], 0xa5);
  assert.equal(state.memoryBytes[destination + 5], 0xa5);
  assert.equal(state.definition.primary, 0x81);
  assert.equal(state.definition.secondary, 0x32);
  assert.equal(state.definition.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[0x81][0x32]);
});

test('81 32 treats zero as whole-file length and clamps a longer request at EOF', async () => {
  const state = setup(),
    whole = Uint8Array.of(10, 20, 30, 40, 50, 60),
    short = Uint8Array.of(70, 80, 90),
    wholeSource = state.mount('/game/whole.bin', whole),
    shortSource = state.mount('/game/short.bin', short),
    wholePath = state.name('c:\\game\\whole.bin'),
    shortPath = state.name('C:\\game\\short.bin');

  assert.equal(await state.invoke(512, 480, wholePath, 0), 0);
  assert.equal(new DataView(state.memoryBytes.buffer).getUint32(480, true), whole.length);
  assert.deepEqual(state.memoryBytes.slice(512, 512 + whole.length), whole);
  assert.deepEqual(wholeSource.reads, [[0, whole.length]]);

  assert.equal(await state.invoke(640, 608, shortPath, 10), 0);
  assert.equal(new DataView(state.memoryBytes.buffer).getUint32(608, true), short.length);
  assert.deepEqual(state.memoryBytes.slice(640, 640 + short.length), short);
  assert.deepEqual(shortSource.reads, [[0, short.length]]);
  assert.deepEqual(state.roots, ['c:\\', 'c:\\']);
});

test('81 32 rejects invalid drive syntax and maps an ordinary missing file to one', async () => {
  const state = setup(),
    invalidPath = state.name('1:\\game\\file.bin'),
    missingPath = state.name('C:\\game\\missing.bin');
  assert.equal(await state.invoke(512, 480, invalidPath, 4), 8);
  assert.deepEqual(state.roots, []);
  assert.deepEqual(state.memoryBytes.slice(480, 520), new Uint8Array(40).fill(0xa5));

  assert.equal(await state.invoke(640, 608, missingPath, 4), 1);
  assert.deepEqual(state.roots, ['c:\\']);
  assert.deepEqual(state.memoryBytes.slice(608, 648), new Uint8Array(40).fill(0xa5));
});

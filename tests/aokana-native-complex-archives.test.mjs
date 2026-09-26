import test from 'node:test';
import assert from 'node:assert/strict';
import {StoredFileSystem} from '../dist/platform/filesystem.js';
import {MemoryStore} from '../dist/platform/store.js';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, pop32, push32} from '../dist/engines/buriko/bp/state.js';
import {
  BurikoProgramFiles,
  BurikoProgramMedia,
} from '../dist/engines/buriko/native/program-files.js';
import {BurikoMountedProgramPaths} from '../dist/engines/buriko/native/program-paths.js';
import {BurikoProgramResources} from '../dist/engines/buriko/native/program-resources.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';
import {createGroup80ComplexArchives} from '../dist/engines/buriko/native/group-80-complex-archives.js';
import {createGroup80ResourceRead} from '../dist/engines/buriko/native/group-80-resource-read.js';
import {
  BurikoDistributedAllocator,
  BurikoDistributedProcessing,
} from '../dist/engines/buriko/native/distributed-processing.js';
import {BurikoEngineErrors} from '../dist/engines/buriko/native/engine-errors.js';
import {BurikoEngineDialogs} from '../dist/engines/buriko/native/engine-dialogs.js';

function arc(entries) {
  const base = 16 + entries.length * 128,
    bytes = new Uint8Array(base + entries.reduce((sum, entry) => sum + entry.data.length, 0)),
    view = new DataView(bytes.buffer),
    encode = new TextEncoder();
  bytes.set(encode.encode('BURIKO ARC20'));
  view.setUint32(12, entries.length, true);
  let offset = 0;
  entries.forEach((entry, index) => {
    const record = 16 + index * 128;
    bytes.set(encode.encode(entry.name), record);
    view.setUint32(record + 96, offset, true);
    view.setUint32(record + 100, entry.data.length, true);
    view.setBigUint64(record + 104, entry.metadata, true);
    bytes.set(entry.data, base + offset);
    offset += entry.data.length;
  });
  return bytes;
}

test('80:38 registers ordered real component archives in the shared resource cache and releases their private indexes', async () => {
  const fs = new StoredFileSystem(new MemoryStore(), (path) => path.toLowerCase());
  const first = [{name: 'Shared', data: Uint8Array.of(3, 5, 7), metadata: 0n}],
    second = [
      {name: 'Shared', data: Uint8Array.of(21, 22, 23), metadata: 9n},
      {name: 'OnlySecond', data: Uint8Array.of(10, 11, 12, 13), metadata: 77n},
      {name: 'Empty', data: new Uint8Array(), metadata: 88n},
    ];
  await fs.commit([
    {kind: 'write', path: '/game/first.arc', data: arc(first)},
    {kind: 'write', path: '/game/second.arc', data: arc(second)},
  ]);
  const text = new BurikoNativeText(),
    encode = (s) => text.encodeWide(s, 1),
    media = new BurikoProgramMedia();
  media.setDriveType(2, 3);
  const files = new BurikoProgramFiles(
      fs,
      text,
      media,
      new BurikoMountedProgramPaths([{native: 'C:\\', mounted: '/'}], 'C:\\game'),
    ),
    dialogs = new BurikoEngineDialogs(),
    errors = new BurikoEngineErrors(files, dialogs, Uint8Array.of(0), Uint8Array.of(0)),
    processing = new BurikoDistributedProcessing(new BurikoDistributedAllocator(1), 1);
  const resources = new BurikoProgramResources(
    files,
    {
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
    dialogs,
    errors,
    processing,
  );
  const archives = resources.archives,
    bytes = new Uint8Array(4096),
    memory = new BurikoBpMemory(bytes),
    thread = new BurikoBpThread({
      id: 1,
      operandCapacity: 16,
      moduleCapacity: 16,
      frameCapacity: 16,
    }),
    slots = [...createGroup80ComplexArchives(archives), ...createGroup80ResourceRead(resources)];
  const put = (offset, value) => bytes.set(encode(value), offset);
  const invoke = async (slot, ...args) => {
    for (const value of args) push32(thread, value);
    assert.equal(
      await slots.find((value) => value.secondary === slot).execute({thread, memory}),
      0,
    );
    const result = pop32(thread);
    assert.equal(thread.stackIndex, 0);
    return result;
  };
  put(32, 'Combined');
  put(128, 'FIRST.ARC');
  put(256, 'Second.arc');
  const view = new DataView(bytes.buffer);
  view.setUint32(512, 128, true);
  view.setUint32(516, 256, true);
  view.setUint32(520, 0, true);
  assert.equal(await invoke(0x38, 32, 512), 1);
  put(32, 'COMBINED');
  assert.equal(await invoke(0x38, 32, 512), 0);
  const logical = encode('C:\\game\\combined'),
    firstPath = encode('C:\\game\\first.arc'),
    secondPath = encode('C:\\game\\second.arc');
  // Keep an ordinary root node for the second physical archive; release then reaches the
  // complex node's virtual method for first.arc and updates its actual private subcache.
  assert.equal(await archives.size(secondPath, encode('Shared')), 3);
  assert.equal(await archives.size(logical, encode('Shared')), 3);
  assert.equal(await archives.metadata(logical, encode('Shared')), 0n);
  assert.equal(await archives.metadata(logical, encode('OnlySecond')), 77n);
  assert.equal(await archives.contains(logical, encode('Empty')), true);
  assert.equal(await archives.size(logical, encode('Empty')), 0);
  assert.deepEqual(
    (await archives.enumerateNames(secondPath)).map((name) =>
      text.decodeAuto({bytes: name, offset: 0}),
    ),
    ['shared', 'onlysecond', 'empty'],
  );
  put(768, 'Shared');
  assert.equal(await invoke(0x30, 1024, 32, 768), 3);
  assert.deepEqual(Array.from(bytes.subarray(1024, 1027)), [3, 5, 7]);
  put(768, 'OnlySecond');
  assert.equal(await invoke(0x31, 1056, 32, 768, 1, 2), 0);
  assert.deepEqual(Array.from(bytes.subarray(1056, 1058)), [11, 12]);
  assert.equal(await archives.release(logical), 0x80000010);
  assert.equal(await archives.contains(logical, encode('OnlySecond')), true);
  await fs.commit([
    {
      kind: 'write',
      path: '/game/first.arc',
      data: arc([{name: 'Shared', data: Uint8Array.of(40, 41, 42, 43, 44), metadata: 99n}]),
    },
  ]);
  assert.equal(await archives.size(logical, encode('Shared')), 3);
  assert.equal(await archives.release(firstPath), 0);
  assert.equal(await archives.size(logical, encode('Shared')), 5);
  assert.equal(await archives.metadata(logical, encode('Shared')), 99n);
  assert.deepEqual(
    Array.from((await resources.load(encode('combined'), encode('Shared'), false)).bytes),
    [40, 41, 42, 43, 44],
  );
  archives.clear();
  assert.equal(await archives.size(logical, encode('Shared')), 0x80000010);
  assert.equal(await archives.size(secondPath, encode('OnlySecond')), 4);
  processing.dispose();
});

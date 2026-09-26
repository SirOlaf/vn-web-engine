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
import {BurikoEngineDialogs} from '../dist/engines/buriko/native/engine-dialogs.js';
import {BurikoEngineErrors} from '../dist/engines/buriko/native/engine-errors.js';
import {
  BurikoDistributedAllocator,
  BurikoDistributedProcessing,
} from '../dist/engines/buriko/native/distributed-processing.js';
import {BurikoSaveSlots} from '../dist/engines/buriko/native/save-slots.js';
import {createGroup80SaveSlots} from '../dist/engines/buriko/native/group-80-save-slots.js';
import {createGroup80GlobalMemory} from '../dist/engines/buriko/native/group-80-global-memory.js';

test('80:70/71 configure and clear the actual BP globals consumed by ordinary save slots', async () => {
  const fs = new StoredFileSystem(new MemoryStore(), (p) => p.toLowerCase()),
    text = new BurikoNativeText(),
    encode = (s) => text.encodeWide(s, 1),
    media = new BurikoProgramMedia();
  media.setDriveType(2, 3);
  const files = new BurikoProgramFiles(
      fs,
      text,
      media,
      new BurikoMountedProgramPaths([{native: 'C:\\', mounted: '/'}], 'C:\\'),
    ),
    dialogs = new BurikoEngineDialogs(),
    errors = new BurikoEngineErrors(files, dialogs, encode('C:\\save\\'), encode('C:\\')),
    processing = new BurikoDistributedProcessing(new BurikoDistributedAllocator(1), 1),
    resources = new BurikoProgramResources(
      files,
      {
        nativeFileRoot: 'C:\\assets\\',
        primaryRoot: encode('C:\\assets\\'),
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
    ),
    memory = new BurikoBpMemory(new Uint8Array(0x10000)),
    save = new BurikoSaveSlots(resources, memory, () => new Date(2026, 8, 19, 12, 34, 56, 123)),
    slots = [...createGroup80GlobalMemory(errors), ...createGroup80SaveSlots(save)],
    thread = new BurikoBpThread({
      id: 1,
      operandCapacity: 8,
      moduleCapacity: 1024,
      frameCapacity: 0,
    });
  const invoke = async (slot, args = [], outputs = 0) => {
    for (const value of args) push32(thread, value);
    assert.equal(await slots.find((s) => s.secondary === slot).execute({thread, memory}), 0);
    const result = Array.from({length: outputs}, () => pop32(thread));
    assert.equal(thread.stackIndex, 0);
    return outputs === 1 ? result[0] : result;
  };
  const read = async (path) => {
    const file = await fs.open(path);
    return file.read(0, file.size);
  };
  try {
    assert.equal(await invoke(0x70, [1], 1), 1);
    memory.writeU32(thread, 0x100, 0x12345678);
    memory.writeU32(thread, 0x1ffc, 0x90abcdef);
    assert.equal(memory.readU32(thread, 0x100), 0x12345678);
    assert.equal(memory.readU32(thread, 0x1ffc), 0x90abcdef);
    thread.moduleMemory.set(encode('Working globals'), 16);
    await invoke(0x74, [0]);
    await invoke(0x78, [1, 0x10000010]);
    const stored = await read('/save/BGI0001.cad'),
      expected = new Uint8Array(0x2000),
      view = new DataView(expected.buffer);
    view.setUint32(0x100, 0x12345678, true);
    view.setUint32(0x1ffc, 0x90abcdef, true);
    assert.equal(stored.length, 0x2040);
    assert.deepEqual(stored.subarray(64), expected);
    await invoke(0x71);
    assert.equal(memory.readU32(thread, 0x100), 0);
    assert.equal(memory.readU32(thread, 0x1ffc), 0);
    await invoke(0x78, [2, 0x10000010]);
    const cleared = await read('/save/BGI0002.cad');
    assert.equal(cleared.length, 0x2040);
    assert.deepEqual(cleared.subarray(64), new Uint8Array(0x2000));
    assert.deepEqual(
      thread.moduleMemory.subarray(16, 16 + encode('Working globals').length),
      encode('Working globals'),
    );
  } finally {
    await processing.dispose();
  }
});

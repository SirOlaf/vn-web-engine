import test from 'node:test';
import assert from 'node:assert/strict';
import {StoredFileSystem} from '../dist/platform/filesystem.js';
import {MemoryStore} from '../dist/platform/store.js';
import {randomByteGenerator} from '../dist/formats/buriko/binary.js';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {
  AokanaProgramFiles,
  AokanaProgramMedia,
} from '../dist/engines/buriko/games/aokana/native/program-files.js';
import {AokanaMountedProgramPaths} from '../dist/engines/buriko/games/aokana/native/program-paths.js';
import {AokanaProgramResources} from '../dist/engines/buriko/games/aokana/native/program-resources.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {AokanaSaveSlots} from '../dist/engines/buriko/games/aokana/native/save-slots.js';
import {createGroup80SaveSlots} from '../dist/engines/buriko/games/aokana/native/group-80-save-slots.js';
import {AokanaPersistentMemory} from '../dist/engines/buriko/games/aokana/native/persistence.js';
import {
  AokanaDistributedAllocator,
  AokanaDistributedProcessing,
} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {AokanaEngineErrors} from '../dist/engines/buriko/games/aokana/native/engine-errors.js';
import {AokanaEngineDialogs} from '../dist/engines/buriko/games/aokana/native/engine-dialogs.js';

test('80:74/78–7B save encrypted and plain slots through shared files, preserving the live BP prefix on load', async () => {
  const fs = new StoredFileSystem(new MemoryStore(), (p) => p.toLowerCase()),
    text = new AokanaNativeText(),
    encode = (value) => text.encodeWide(value, 1),
    media = new AokanaProgramMedia();
  media.setDriveType(2, 3);
  const files = new AokanaProgramFiles(
      fs,
      text,
      media,
      new AokanaMountedProgramPaths([{native: 'C:\\', mounted: '/'}], 'C:\\'),
    ),
    dialogs = new AokanaEngineDialogs(),
    errors = new AokanaEngineErrors(files, dialogs, encode('C:\\save\\'), encode('C:\\')),
    processing = new AokanaDistributedProcessing(new AokanaDistributedAllocator(1), 1),
    resources = new AokanaProgramResources(
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
    memory = new AokanaBpMemory(new Uint8Array(0x1000)),
    persistent = new AokanaPersistentMemory(),
    now = new Date(2026, 8, 19, 12, 34, 56, 123),
    service = new AokanaSaveSlots(resources, memory, () => now),
    slots = createGroup80SaveSlots(service),
    thread = new AokanaBpThread({
      id: 1,
      operandCapacity: 16,
      moduleCapacity: 4096,
      frameCapacity: 0,
    });
  const invoke = async (slot, args = [], outputs = 1) => {
    for (const value of args) push32(thread, value);
    assert.equal(await slots.find((s) => s.secondary === slot).execute({thread, memory}), 0);
    const result = Array.from({length: outputs}, () => pop32(thread)).reverse();
    assert.equal(thread.stackIndex, 0);
    return outputs === 1 ? result[0] : result;
  };
  const read = async (name) => {
    const f = await fs.open(name);
    return f.read(0, f.size);
  };
  try {
    for (let i = 0; i < memory.globalMemory.length; i++) memory.globalMemory[i] = (i * 7 + 3) & 255;
    persistent.bytes.fill(0x73);
    thread.moduleMemory.set(encode('First chapter'), 16);
    const original = memory.globalMemory.slice(),
      persistentOriginal = persistent.bytes.slice();
    assert.equal(service.cipher, 1);
    assert.deepEqual(await invoke(0x78, [7, 0x10000010], 0), []);
    const stored = await read('/save/BGI0007.cad'),
      header = new DataView(stored.buffer, stored.byteOffset, 64);
    assert.equal(stored.length, original.length + 64);
    assert.deepEqual(
      Array.from({length: 8}, (_, i) => header.getUint16(i * 2, true)),
      [2026, 9, 6, 19, 12, 34, 56, 123],
    );
    assert.equal(text.decodeAuto({bytes: stored, offset: 16}), 'First chapter');
    const next = randomByteGenerator(123),
      encrypted = Uint8Array.from(original, (v) => (v + next()) & 255);
    assert.deepEqual(stored.subarray(64), encrypted);
    assert.equal(
      stored[56],
      encrypted.reduce((a, b) => (a + b) & 255, 0),
    );
    assert.equal(
      stored[57],
      encrypted.reduce((a, b) => a ^ b, 0),
    );
    assert.deepEqual(Array.from(stored.subarray(58, 64)), [next(), next(), 1, 0, 0, 0]);
    assert.equal(await invoke(0x7a, [0x10000100, 7]), 0);
    assert.deepEqual(thread.moduleMemory.subarray(256, 320), stored.subarray(0, 64));
    assert.equal(await invoke(0x7b, [7]), 0);
    memory.globalMemory.fill(0x6a);
    assert.equal(await invoke(0x79, [7]), 0);
    assert.deepEqual(memory.globalMemory.subarray(0, 0x400), new Uint8Array(0x400).fill(0x6a));
    assert.deepEqual(memory.globalMemory.subarray(0x400), original.subarray(0x400));
    assert.deepEqual(persistent.bytes, persistentOriginal);
    assert.deepEqual(await invoke(0x74, [0], 0), []);
    thread.moduleMemory.set(encode('Plain chapter'), 16);
    const plainOriginal = memory.globalMemory.slice();
    assert.deepEqual(await invoke(0x78, [0xffffffff, 0x10000010], 0), []);
    const plain = await read('/save/BGI-0001.cad');
    assert.deepEqual(plain.subarray(64), plainOriginal);
    assert.deepEqual(plain.subarray(56, 64), new Uint8Array(8));
    assert.equal(await invoke(0x7b, [0xffffffff]), 0);
    memory.globalMemory.fill(0x42);
    assert.equal(await invoke(0x79, [0xffffffff]), 0);
    assert.deepEqual(memory.globalMemory.subarray(0, 0x400), new Uint8Array(0x400).fill(0x42));
    assert.deepEqual(memory.globalMemory.subarray(0x400), plainOriginal.subarray(0x400));
    assert.deepEqual(persistent.bytes, persistentOriginal);
  } finally {
    await processing.dispose();
  }
});

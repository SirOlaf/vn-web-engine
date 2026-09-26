import test from 'node:test';
import assert from 'node:assert/strict';
import {StoredFileSystem} from '../dist/platform/filesystem.js';
import {MemoryStore} from '../dist/platform/store.js';
import {decodeSdc} from '../dist/formats/buriko/compressed-resource.js';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {
  AokanaProgramFiles,
  AokanaProgramMedia,
} from '../dist/engines/buriko/games/aokana/native/program-files.js';
import {AokanaMountedProgramPaths} from '../dist/engines/buriko/games/aokana/native/program-paths.js';
import {AokanaProgramResources} from '../dist/engines/buriko/games/aokana/native/program-resources.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {
  AokanaPersistentMemory,
  AokanaPersistence,
} from '../dist/engines/buriko/games/aokana/native/persistence.js';
import {createGroup80Persistence} from '../dist/engines/buriko/games/aokana/native/group-80-persistence.js';
import {AokanaNamedBitArrays} from '../dist/engines/buriko/games/aokana/native/named-bit-arrays.js';
import {AokanaStringLists} from '../dist/engines/buriko/games/aokana/native/string-lists.js';
import {AokanaNativeDisplayState} from '../dist/engines/buriko/games/aokana/native/display-state.js';
import {AokanaDisplayAdapters} from '../dist/engines/buriko/games/aokana/native/display-adapters.js';
import {
  AokanaDistributedAllocator,
  AokanaDistributedProcessing,
} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {AokanaEngineErrors} from '../dist/engines/buriko/games/aokana/native/engine-errors.js';
import {AokanaEngineDialogs} from '../dist/engines/buriko/games/aokana/native/engine-dialogs.js';
import {legacyGdb, shortModernGdb} from './aokana-persistence-fixtures.mjs';

const ptr = (bytes, offset = 0) => ({bytes, offset});
const text = new AokanaNativeText(),
  encode = (s) => text.encodeWide(s, 1);

async function setup() {
  const fs = new StoredFileSystem(new MemoryStore(), (path) => path.toLowerCase());
  await fs.commit([{kind: 'write', path: '/save/directory-marker', data: Uint8Array.of(1)}]);
  const media = new AokanaProgramMedia();
  media.setDriveType(2, 3);
  const files = new AokanaProgramFiles(
      fs,
      text,
      media,
      new AokanaMountedProgramPaths([{native: 'C:\\', mounted: '/'}], 'C:\\'),
    ),
    dialogs = new AokanaEngineDialogs(),
    initialRoot = encode('C:\\initial\\'),
    errors = new AokanaEngineErrors(files, dialogs, initialRoot, encode('C:\\')),
    processing = new AokanaDistributedProcessing(new AokanaDistributedAllocator(1), 1),
    resources = new AokanaProgramResources(
      files,
      {
        nativeFileRoot: 'C:\\assets\\',
        primaryRoot: initialRoot,
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
    memory = new AokanaBpMemory(new Uint8Array(0x10000)),
    persistent = new AokanaPersistentMemory(),
    strings = new AokanaStringLists(),
    bits = new AokanaNamedBitArrays(),
    display = new AokanaNativeDisplayState(1920, 1080);
  display.requestedWidth = 640;
  display.requestedHeight = 480;
  display.monitors = [[0, 0, 1920, 1080]];
  // An explicit current-window rectangle and UTC wall-time profile, not fake filesystem/UI results.
  const adapters = new AokanaDisplayAdapters(
      display,
      [
        {
          monitor: 0,
          pixelShaderVersion: 0,
          mode: {width: 1920, height: 1080, refreshRate: 60, format: 22},
        },
      ],
      0,
      () => [100, 120, 740, 600],
    ),
    persistence = new AokanaPersistence(
      resources,
      memory,
      persistent,
      strings,
      bits,
      adapters,
      () => new Date('2026-09-19T12:34:56.123Z'),
    ),
    slots = createGroup80Persistence(persistence),
    thread = new AokanaBpThread({
      id: 1,
      operandCapacity: 16,
      moduleCapacity: 4096,
      frameCapacity: 0,
    });
  const put = (offset, value) => {
    thread.moduleMemory.set(encode(value), offset);
    return 0x10000000 + offset;
  };
  const invoke = async (slot, args = [], outputs = 1) => {
    for (const value of args) push32(thread, value);
    assert.equal(await slots.find((s) => s.secondary === slot).execute({thread, memory}), 0);
    const result = Array.from({length: outputs}, () => pop32(thread)).reverse();
    assert.equal(thread.stackIndex, 0);
    return outputs === 1 ? result[0] : result;
  };
  assert.equal(await invoke(0x39, [put(16, 'C:\\save\\')]), 1);
  assert.equal(text.decodeAuto(ptr(errors.errorDirectory)), 'C:\\save\\');
  assert.equal(text.decodeAuto(ptr(resources.configuration.primaryRoot)), 'C:\\initial\\');
  assert.equal(persistence.root, errors.saveRoot);
  return {
    fs,
    memory,
    persistent,
    strings,
    bits,
    display,
    processing,
    resources,
    persistence,
    thread,
    put,
    invoke,
  };
}

test('39 and80:80–85 save and restore the two distinct allocations and shared registries through real files', async () => {
  const s = await setup(),
    {memory, persistent, strings, bits, thread, put, invoke} = s;
  for (let i = 0; i < 0x400; i++) memory.globalMemory[i] = i & 255;
  memory.globalMemory.fill(0x5a, 0x400);
  const expectedPrefix = memory.globalMemory.slice(0, 0x400);
  thread.moduleMemory.set([3, 5, 7, 9, 11, 13], 512);
  assert.deepEqual(await invoke(0x82, [15, 0x10000200, 6], 0), []);
  assert.deepEqual(await invoke(0x83, [0x10000220, 15, 6], 0), []);
  assert.deepEqual(Array.from(thread.moduleMemory.subarray(544, 550)), [3, 5, 7, 9, 11, 13]);
  persistent.bytes[0x90000] = 42;
  const expectedPersistent = persistent.bytes.slice();
  assert.equal(await invoke(0x84, [put(128, 'alpha')]), 1);
  assert.equal(await invoke(0x84, [put(128, 'beta')]), 1);
  assert.equal(await invoke(0x85, [put(128, 'alpha')]), 1);
  strings.append(7, ptr(encode('temporary')));
  strings.reset(1);
  assert.equal(strings.count(7), 0);
  assert.equal(strings.count(0x80000000), 2);
  bits.replaceData(ptr(encode('flags')), 12, ptr(Uint8Array.of(0xa0, 0x80)));
  bits.replaceData(ptr(encode('extra')), 9, ptr(Uint8Array.of(0x40, 0)));
  const expectedBits = bits.snapshots();
  assert.equal(await invoke(0x81), 1);
  const source = await s.fs.open('/save/BGI.gdb'),
    stored = await source.read(0, source.size),
    plain = decodeSdc(stored),
    view = new DataView(plain.buffer);
  assert.equal(new DataView(stored.buffer).getUint32(16, true), 123);
  assert.equal(view.getUint32(28, true), 0x400);
  assert.equal(view.getUint32(0x420, true), 0x100000);
  assert.deepEqual(plain.subarray(32, 0x420), expectedPrefix);
  assert.deepEqual(plain.subarray(0x424, 0x100424), expectedPersistent);
  assert.deepEqual(bits.snapshots(), expectedBits);
  memory.globalMemory.fill(0x66);
  persistent.bytes.fill(0x77);
  strings.append(0x80000000, ptr(encode('later')));
  bits.replaceData(ptr(encode('later')), 8, ptr(Uint8Array.of(255)));
  assert.deepEqual(await invoke(0x80, [], 3), [100, 120, 0]);
  assert.deepEqual(memory.globalMemory.subarray(0, 0x400), expectedPrefix);
  assert.equal(memory.globalMemory[0x400], 0x66);
  assert.deepEqual(persistent.bytes, expectedPersistent);
  assert.deepEqual(bits.snapshots(), expectedBits);
  assert.equal(strings.contains(0x80000000, ptr(encode('later'))), 1);
  assert.equal(strings.count(0x80000000), 2);
  // A supported modern record may save shorter regions: BP remainder is retained; persistent
  // remainder is zero-filled. This is deliberately different from the separate C13C0 service.
  await s.fs.commit([{kind: 'write', path: '/save/BGI.gdb', data: shortModernGdb()}]);
  memory.globalMemory.fill(0x44);
  persistent.bytes.fill(0x55);
  s.display.fullscreen = 1;
  assert.deepEqual(await invoke(0x80, [], 3), [0, 0, 0]);
  assert.deepEqual(Array.from(memory.globalMemory.subarray(0, 4)), [7, 8, 0x44, 0x44]);
  assert.deepEqual(Array.from(persistent.bytes.subarray(0, 4)), [90, 91, 0, 0]);
  assert.equal(strings.count(0x80000000), 0);
  assert.deepEqual(bits.snapshots(), []);
  s.processing.dispose();
});

test('GDB file load supports both ordinary compact and large legacy layouts with actual prefix and registry mutation', async () => {
  const s = await setup();
  for (const compact of [true, false]) {
    await s.fs.commit([{kind: 'write', path: '/save/BGI.gdb', data: legacyGdb(compact)}]);
    s.memory.globalMemory.fill(0x66);
    s.persistent.bytes.fill(0x77);
    assert.deepEqual(await s.invoke(0x80, [], 3), compact ? [100, 120, 0] : [640, 300, 0]);
    assert.equal(s.memory.globalMemory[0], compact ? 0x31 : 0x32);
    assert.equal(s.memory.globalMemory[0x3ff], compact ? 0x31 : 0x32);
    assert.equal(s.memory.globalMemory[0x400], 0x66);
    assert.equal(s.persistent.bytes[0x3ffff], compact ? 0x51 : 0x52);
    assert.equal(s.persistent.bytes[0x40000], 0);
    assert.equal(s.strings.count(0x80000000), 2);
    assert.equal(s.strings.contains(0x80000000, ptr(encode('legacy-second'))), 0);
    assert.deepEqual(
      s.bits.snapshots().map((entry) => text.decodeAuto(ptr(entry.name))),
      ['legacy-extra', 'legacy-flag'],
    );
    assert.deepEqual(Array.from(s.bits.read(ptr(encode('legacy-flag'))).data), [0xa0]);
  }
  s.processing.dispose();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {StoredFileSystem} from '../dist/platform/filesystem.js';
import {MemoryStore} from '../dist/platform/store.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';
import {
  BurikoProgramFiles,
  BurikoProgramMedia,
} from '../dist/engines/buriko/native/program-files.js';
import {BurikoNativeFile} from '../dist/engines/buriko/native/native-file.js';
import {BurikoScriptFiles} from '../dist/engines/buriko/native/script-files.js';
import {BurikoAsyncCriticalSection} from '../dist/engines/buriko/native/async-critical-section.js';
import {BurikoDistributedAllocator} from '../dist/engines/buriko/native/distributed-processing.js';
import {createGroup81Files} from '../dist/engines/buriko/native/group-81-files.js';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, pop32, push32} from '../dist/engines/buriko/bp/state.js';
import {BURIKO_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/native/inventory.js';
const bytes = (value) => new TextEncoder().encode(value),
  pointer = (value) => ({bytes: bytes(value + '\0'), offset: 0});
const readFile = async (fs, path) => {
  const source = await fs.open(path);
  return new TextDecoder().decode(await source.read(0, source.size));
};

test('mounted output and CFileDX cursors preserve overwrite tails and OPEN_ALWAYS starts at zero', async () => {
  const fs = new StoredFileSystem(new MemoryStore()),
    files = new BurikoProgramFiles(fs, new BurikoNativeText(), new BurikoProgramMedia());
  await fs.commit([{kind: 'write', path: '/output', data: bytes('previous')}]);
  const output = await files.createOutput(bytes('/output'));
  assert.equal(output.size(), 0n);
  assert.equal(await output.write(bytes('abcdef')), 6);
  assert.equal(output.seekAbsolute(2n), true);
  assert.equal(await output.write(bytes('XY')), 2);
  assert.equal(await readFile(fs, '/output'), 'abXYef');
  output.close();
  const native = new BurikoNativeFile(files);
  assert.equal(await native.openWrite(pointer('/output'), 1), 1);
  assert.equal(native.size(), 6n);
  assert.equal(await native.write(pointer('Q'), 1), 1);
  assert.equal(await readFile(fs, '/output'), 'QbXYef');
  assert.equal(native.seekAbsolute(native.size()), true);
  assert.equal(await native.write(pointer('!'), 1), 1);
  native.close();
  const input = new BurikoNativeFile(files),
    result = {bytes: new Uint8Array(16), offset: 2};
  assert.equal(await input.openRead(pointer('/output')), 1);
  assert.equal(input.size(), 7n);
  assert.equal(input.seekAbsolute(1n), true);
  assert.equal(await input.read(result, 12), 6);
  assert.equal(new TextDecoder().decode(result.bytes.slice(2, 8)), 'bXYef!');
  input.close();
});

test('all four file wrappers retain transfer pointers and publish queued completion through the shared worker step', async () => {
  const fs = new StoredFileSystem(new MemoryStore()),
    files = new BurikoProgramFiles(fs, new BurikoNativeText(), new BurikoProgramMedia()),
    allocator = new BurikoDistributedAllocator(1),
    worker = {},
    registry = new BurikoScriptFiles(files, allocator, async () => {
      await registry.processFirst(worker);
    });
  await fs.commit([{kind: 'write', path: '/data', data: bytes('abcdef')}]);
  registry.initialize();
  const thread = new BurikoBpThread({
      id: 1,
      operandCapacity: 16,
      moduleCapacity: 256,
      frameCapacity: 0,
    }),
    memory = new BurikoBpMemory(),
    slots = createGroup81Files(registry);
  assert.equal(slots.length, 4);
  for (const slot of slots)
    assert.equal(slot.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[0x81][slot.secondary]);
  const path = memory.resolve(thread, 0x10000020),
    source = memory.resolve(thread, 0x10000060);
  path.bytes.set(pointer('/data').bytes, path.offset);
  source.bytes.set(bytes('XYZ'), source.offset);
  const call = async (secondary, args) => {
    args.forEach((value) => push32(thread, value));
    assert.equal(
      await slots.find((slot) => slot.secondary === secondary).execute({thread, memory}),
      0,
    );
    assert.equal(pop32(thread), 0);
  };
  await call(0x28, [0x10000000, 0x10000020, 2]);
  const id = memory.readU32(thread, 0x10000000);
  assert.equal(id, 1);
  await call(0x2a, [0x10000004, id, 0x10000060, 3]);
  assert.equal(memory.readU32(thread, 0x10000004), 0);
  source.bytes.set(bytes('MNO'), source.offset);
  assert.equal(await registry.processFirst(worker), 0);
  assert.equal(memory.readU32(thread, 0x10000004), 3);
  assert.equal(await readFile(fs, '/data'), 'MNOdef');
  await call(0x2b, [0x10000008, id, 0xffffffff]);
  assert.equal(await registry.processFirst(worker), 0);
  assert.equal(memory.readU32(thread, 0x10000008), 1);
  source.bytes[source.offset] = 33;
  await call(0x2a, [0x1000000c, id, 0x10000060, 1]);
  await call(0x29, [0x10000010, id]);
  assert.equal(await registry.processFirst(worker), 0);
  assert.equal(await registry.processFirst(worker), 0);
  assert.equal(memory.readU32(thread, 0x10000010), 1);
  assert.equal(await readFile(fs, '/data'), 'MNOdef!');
  assert.equal(registry.find(id), null);
  assert.equal(await registry.processFirst(worker), 1);
  await call(0x28, [0x10000000, 0x10000020, 0]);
  assert.equal(memory.readU32(thread, 0x10000000), 2);
  await registry.shutdown();
  assert.equal(registry.find(2), null);
  assert.equal(thread.stackIndex, 0);
});

test('script read releases its section during mounted I/O and preserves a normally appended next job', async () => {
  const backing = new StoredFileSystem(new MemoryStore());
  await backing.commit([{kind: 'write', path: '/input', data: bytes('abcdefgh')}]);
  let observe = false,
    registry,
    id;
  const completion = {bytes: new Uint8Array(8), offset: 0},
    seekCompletion = {bytes: completion.bytes, offset: 4},
    observations = [];
  const fs = {
    stat: (path) => backing.stat(path),
    list: (path) => backing.list(path),
    commit: (changes) => backing.commit(changes),
    async open(path) {
      const source = await backing.open(path);
      return {
        size: source.size,
        async read(at, count) {
          if (observe) {
            observations.push([registry.section.owner, registry.find(id).busy]);
            await registry.queueSeek(seekCompletion, id, 0);
          }
          return source.read(at, count);
        },
      };
    },
  };
  const files = new BurikoProgramFiles(fs, new BurikoNativeText(), new BurikoProgramMedia()),
    allocator = new BurikoDistributedAllocator(1),
    worker = {};
  registry = new BurikoScriptFiles(files, allocator, async () => {
    await registry.processFirst(worker);
  });
  registry.initialize();
  const handle = {bytes: new Uint8Array(4), offset: 0};
  assert.equal(await registry.open(handle, pointer('/input'), 0), 0);
  id = new DataView(handle.bytes.buffer).getUint32(0, true);
  const output = {bytes: new Uint8Array(16), offset: 3};
  assert.equal(await registry.queueTransfer(completion, id, output, 4), 0);
  observe = true;
  assert.equal(await registry.processFirst(worker), 0);
  observe = false;
  assert.deepEqual(observations, [[null, 1]]);
  assert.equal(registry.find(id).busy, 0);
  assert.equal(new TextDecoder().decode(output.bytes.slice(3, 7)), 'abcd');
  assert.equal(new DataView(completion.bytes.buffer).getUint32(0, true), 4);
  assert.equal(registry.hasPending, true);
  assert.equal(await registry.processFirst(worker), 0);
  assert.equal(new DataView(completion.bytes.buffer).getUint32(4, true), 1);
  await registry.shutdown();
});

test('async recursive section carries explicit actor ownership through ordinary nesting and queued acquisition', async () => {
  const section = new BurikoAsyncCriticalSection(),
    first = {},
    second = {};
  section.initialize();
  await section.enter(first);
  await section.enter(first);
  const waiting = section.enter(second);
  assert.equal(section.owner, first);
  assert.equal(section.depth, 2);
  section.leave(first);
  assert.equal(section.owner, first);
  section.leave(first);
  await waiting;
  assert.equal(section.owner, second);
  assert.equal(section.depth, 1);
  section.leave(second);
  assert.equal(section.owner, null);
  section.dispose();
});

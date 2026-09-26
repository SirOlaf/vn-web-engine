import test from 'node:test';
import assert from 'node:assert/strict';
import {StoredFileSystem} from '../dist/platform/filesystem.js';
import {MemoryStore} from '../dist/platform/store.js';
import {AokanaMountedFileMetadata} from '../dist/engines/buriko/games/aokana/native/file-metadata.js';
import {
  AokanaProgramFiles,
  AokanaProgramMedia,
} from '../dist/engines/buriko/games/aokana/native/program-files.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {AokanaMountedProgramPaths} from '../dist/engines/buriko/games/aokana/native/program-paths.js';
import {createGroup81FileTimestamps} from '../dist/engines/buriko/games/aokana/native/group-81-file-timestamps.js';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';

const bytes = (text) => new TextEncoder().encode(text),
  ticks = (iso) => BigInt(Date.parse(iso)) * 10000n + 116444736000000000n,
  base = ticks('2026-09-01T00:00:00.000Z');
async function fixture(accessTimePolicy = 'disabled') {
  const canonical = (path) => path.toLowerCase(),
    backing = new StoredFileSystem(new MemoryStore(), canonical);
  await backing.commit([{kind: 'write', path: '/existing', data: bytes('preserved content')}]);
  const clock = {now: base + 30000000n},
    metadata = new AokanaMountedFileMetadata(backing, {
      canonical,
      volumes: [{path: '/', identity: {}, writable: true}],
      records: [
        {
          path: '/',
          kind: 'directory',
          attributes: 0x10,
          creationTime: base,
          accessTime: base,
          writeTime: base,
        },
        {
          path: '/existing',
          kind: 'file',
          attributes: 0x20,
          creationTime: base,
          accessTime: base + 10000000n,
          writeTime: base + 20000000n,
        },
      ],
      currentFileTime: () => clock.now,
      accessTimePolicy,
    }),
    paths = new AokanaMountedProgramPaths([{native: 'C:\\Game', mounted: '/'}], 'C:\\Game'),
    files = new AokanaProgramFiles(
      metadata,
      new AokanaNativeText(),
      new AokanaProgramMedia(),
      paths,
    );
  return {backing, clock, metadata, files};
}
async function content(files, path) {
  const source = await files.open(path);
  return new TextDecoder().decode(await source.read(0, source.size));
}

test('one mounted metadata owner follows normal writes, attributes and persistent empty directories', async () => {
  const {backing, clock, metadata, files} = await fixture();
  assert.equal(files.metadata, metadata);
  const before = await metadata.getTimes('/existing'),
    output = await files.createOutput(bytes('EXISTING\0'), true);
  assert.deepEqual(await metadata.getTimes('/existing'), before);
  await output.write(bytes('kept'));
  assert.equal(await content(backing, '/existing'), 'kepterved content');
  assert.deepEqual(await metadata.getTimes('/existing'), {...before, writeTime: clock.now});
  output.close();
  await metadata.setAttributes('/existing', 0x82);
  assert.equal(await metadata.getAttributes('/existing'), 2);
  await metadata.createDirectory('/empty');
  assert.equal((await metadata.stat('/empty')).kind, 'directory');
  assert.deepEqual(
    (await metadata.list('/')).map((info) => info.path),
    ['/empty', '/existing'],
  );
  clock.now += 10000000n;
  const child = await files.createOutput(bytes('empty\\child\0'));
  await child.write(bytes('abc'));
  child.close();
  assert.deepEqual(await metadata.getTimes('/empty/child'), {
    creationTime: clock.now,
    accessTime: clock.now,
    writeTime: clock.now,
  });
  await metadata.commit([{kind: 'delete', path: '/empty/child'}]);
  assert.deepEqual(await metadata.list('/empty'), []);
  await metadata.removeDirectory('/empty');
  assert.deepEqual(
    (await metadata.list('/')).map((info) => info.path),
    ['/existing'],
  );
  const snapshot = metadata.snapshot();
  snapshot.find((record) => record.path === '/existing').attributes = 0;
  assert.equal(await metadata.getAttributes('/existing'), 2);
});

test('both timestamp wrappers preserve file bytes and convert the three UTC records in native order', async () => {
  const {backing, metadata, files} = await fixture(),
    memory = new AokanaBpMemory(new Uint8Array()),
    thread = new AokanaBpThread({
      id: 1,
      operandCapacity: 16,
      moduleCapacity: 256,
      frameCapacity: 0,
    }),
    slots = createGroup81FileTimestamps(files);
  for (const slot of slots)
    assert.equal(slot.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[0x81][slot.secondary]);
  const path = 0x100000d0,
    creation = 0x10000020,
    access = 0x10000040,
    write = 0x10000060;
  const pointer = memory.resolve(thread, path);
  pointer.bytes.set(bytes('existing\0'), pointer.offset);
  const records = [
    [2025, 2, 6, 3, 4, 5, 6, 7],
    [2026, 8, 0, 10, 11, 12, 13, 14],
    [2027, 12, 4, 20, 21, 22, 23, 24],
  ];
  const locations = [creation, access, write];
  records.forEach((fields, index) =>
    fields.forEach((value, field) => memory.writeU16(thread, locations[index] + field * 2, value)),
  );
  const call = async (secondary, args) => {
    args.forEach((value) => push32(thread, value));
    assert.equal(
      await slots.find((slot) => slot.secondary === secondary).execute({thread, memory}),
      0,
    );
    assert.equal(pop32(thread), 1);
  };
  await call(0x2d, [path, creation, access, write]);
  const expected = [
    ticks('2025-02-03T04:05:06.007Z'),
    ticks('2026-08-10T11:12:13.014Z'),
    ticks('2027-12-20T21:22:23.024Z'),
  ];
  assert.deepEqual(await metadata.getTimes('/existing'), {
    creationTime: expected[0],
    accessTime: expected[1],
    writeTime: expected[2],
  });
  assert.equal(await content(backing, '/existing'), 'preserved content');
  await call(0x2c, [creation, access, write, path]);
  const fieldsAt = (address) =>
    Array.from({length: 8}, (_, index) => memory.readU16(thread, address + index * 2));
  records.forEach((fields, index) => {
    const actual = fieldsAt(locations[index]);
    const wanted = fields.slice();
    wanted[2] = new Date(Number((expected[index] - 116444736000000000n) / 10000n)).getUTCDay();
    assert.deepEqual(actual, wanted);
  });
  const finalWrite = fieldsAt(write);
  await call(0x2c, [creation, creation, creation, path]);
  assert.deepEqual(fieldsAt(creation), finalWrite);
  assert.equal(thread.stackIndex, 0);
});

test('the selected immediate access-time profile updates only after actual bytes are read', async () => {
  const {clock, metadata, files} = await fixture('immediate'),
    before = await metadata.getTimes('/existing'),
    source = await metadata.open('/existing');
  assert.deepEqual(await metadata.getTimes('/existing'), before);
  const output = await files.createOutput(bytes('existing\0'), true);
  output.close();
  assert.deepEqual(await metadata.getTimes('/existing'), before);
  assert.equal(new TextDecoder().decode(await source.read(0, 4)), 'pres');
  assert.deepEqual(await metadata.getTimes('/existing'), {...before, accessTime: clock.now});
});

test('imported empty directories stay removed through the shared snapshot and can be recreated normally', async () => {
  const backing = new StoredFileSystem(new MemoryStore()),
    imported = {
      stat: (path) =>
        path === '/imported'
          ? Promise.resolve({path, kind: 'directory', size: 0})
          : backing.stat(path),
      list: (path) =>
        path === '/'
          ? Promise.resolve([{path: '/imported', kind: 'directory', size: 0}])
          : path === '/imported'
            ? Promise.resolve([])
            : backing.list(path),
      open: (path) => backing.open(path),
      commit: (changes) => backing.commit(changes),
    },
    profile = {
      records: [
        {
          path: '/',
          kind: 'directory',
          attributes: 0x10,
          creationTime: base,
          accessTime: base,
          writeTime: base,
        },
      ],
      volumes: [{path: '/', identity: {}, writable: true}],
      canonical: (path) => path,
      currentFileTime: () => base + 10000n,
      accessTimePolicy: 'disabled',
    },
    original = new AokanaMountedFileMetadata(imported, profile);
  assert.deepEqual(
    (await original.list('/')).map((info) => info.path),
    ['/imported'],
  );
  await original.removeDirectory('/imported');
  assert.deepEqual(await original.list('/'), []);
  const restored = new AokanaMountedFileMetadata(imported, {
    ...profile,
    ...original.snapshotState(),
  });
  assert.deepEqual(await restored.list('/'), []);
  await restored.createDirectory('/imported');
  assert.deepEqual(
    (await restored.list('/')).map((info) => info.path),
    ['/imported'],
  );
  assert.equal((await restored.stat('/imported')).kind, 'directory');
  assert.deepEqual(restored.snapshotState().removedDirectories, []);
});

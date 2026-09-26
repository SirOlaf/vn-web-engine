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
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';
import {BurikoEngineErrors} from '../dist/engines/buriko/native/engine-errors.js';
import {BurikoEngineDialogs} from '../dist/engines/buriko/native/engine-dialogs.js';
import {BurikoBacklog} from '../dist/engines/buriko/native/backlog.js';
import {createGroup80Backlog} from '../dist/engines/buriko/native/group-80-backlog.js';

test('80:90/91/94–97 share copied backlog records with bounded history and retained optional output', async () => {
  const fs = new StoredFileSystem(new MemoryStore(), (p) => p.toLowerCase()),
    text = new BurikoNativeText(),
    encode = (s) => text.encodeWide(s, 1),
    media = new BurikoProgramMedia(),
    files = new BurikoProgramFiles(
      fs,
      text,
      media,
      new BurikoMountedProgramPaths([{native: 'C:\\', mounted: '/'}], 'C:\\'),
    ),
    errors = new BurikoEngineErrors(
      files,
      new BurikoEngineDialogs(),
      encode('C:\\save\\'),
      encode('C:\\'),
    ),
    backlog = new BurikoBacklog(),
    slots = createGroup80Backlog(backlog, errors),
    memory = new BurikoBpMemory(new Uint8Array(0x1000)),
    thread = new BurikoBpThread({
      id: 1,
      operandCapacity: 32,
      moduleCapacity: 4096,
      frameCapacity: 0,
    }),
    bytes = thread.moduleMemory,
    view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const put = (offset, s) => {
    bytes.set(encode(s), offset);
    return 0x10000000 + offset;
  };
  const string = (offset) => text.decodeAuto({bytes, offset});
  const invoke = async (slot, args = [], outputs = 0) => {
    for (const value of args) push32(thread, value);
    assert.equal(await slots.find((s) => s.secondary === slot).execute({thread, memory}), 0);
    const result = Array.from({length: outputs}, () => pop32(thread)).reverse();
    assert.equal(thread.stackIndex, 0);
    return outputs === 1 ? result[0] : result;
  };
  assert.equal(await invoke(0x91, [], 1), 0);
  await invoke(0x90, [2]);
  const first = [1, 2, 3, 4, 5, 6, 7, 8, 9],
    archive = put(16, 'voice.arc'),
    file = put(64, 'voice001'),
    name = put(112, 'Speaker'),
    message = put(160, 'First message');
  await invoke(0x94, [...first, archive, file, name, message]);
  bytes.fill(0, 16, 256);
  const packed = 512;
  view.setUint32(packed, 10, true);
  for (let i = 1; i < 9; i++) view.setUint32(packed + 0x3c + i * 4, 10 + i, true);
  put(packed + 0xa0, 'next.arc');
  put(packed + 0xc0, 'voice002');
  put(packed + 0xe0, 'Other');
  put(packed + 0x100, 'Second message');
  put(packed + 0x200, 'reading list');
  await invoke(0x96, [0x10000000 + packed]);
  bytes.fill(0, packed, packed + 1024);
  assert.equal(await invoke(0x91, [], 1), 2);
  const output = 2048;
  bytes.fill(0x5a, output, output + 1024);
  assert.equal(await invoke(0x97, [0x10000000 + output, 0], 1), 1);
  assert.equal(view.getUint32(output, true), 10);
  assert.deepEqual(
    Array.from({length: 8}, (_, i) => view.getUint32(output + 0x40 + i * 4, true)),
    [11, 12, 13, 14, 15, 16, 17, 18],
  );
  assert.equal(string(output + 0xa0), 'next.arc');
  assert.equal(string(output + 0xc0), 'voice002');
  assert.equal(string(output + 0xe0), 'Other');
  assert.equal(string(output + 0x100), 'Second message');
  assert.equal(string(output + 0x200), 'reading list');
  assert.equal(bytes[output + 0x200 + 13], 0x5a);
  bytes.fill(0x69, output, output + 1024);
  assert.equal(await invoke(0x95, [0x10000000 + output, 1], 1), 1);
  assert.equal(view.getUint32(output, true), 1);
  assert.equal(string(output + 0xa0), 'voice.arc');
  assert.equal(string(output + 0x100), 'First message');
  assert.deepEqual(bytes.subarray(output + 0x200, output + 1024), new Uint8Array(512).fill(0x69));
  await invoke(0x94, [21, 22, 23, 24, 25, 26, 27, 28, 29, 0, 0, 0, put(160, 'Third message')]);
  assert.equal(await invoke(0x91, [], 1), 2);
  assert.equal(await invoke(0x97, [0x10000000 + output, 0], 1), 1);
  assert.equal(view.getUint32(output, true), 21);
  assert.equal(string(output + 0xa0), '');
  assert.equal(string(output + 0x100), 'Third message');
  assert.deepEqual(bytes.subarray(output + 0x200, output + 1024), new Uint8Array(512).fill(0x69));
  assert.equal(await invoke(0x95, [0x10000000 + output, 1], 1), 1);
  assert.equal(view.getUint32(output, true), 10);
  await invoke(0x90, [2]);
  assert.equal(await invoke(0x91, [], 1), 0);
});

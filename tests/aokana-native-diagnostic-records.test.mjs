import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AokanaBpThread,
  AokanaBpSharedThread,
} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {listThreadModules, attachModule} from '../dist/engines/buriko/games/aokana/bp/modules.js';
import {AokanaBpDiagnostics} from '../dist/engines/buriko/games/aokana/native/diagnostics.js';
import {
  AokanaDiagnosticCounts,
  AokanaPooledAllocationDiagnostics,
} from '../dist/engines/buriko/games/aokana/native/diagnostic-records.js';
import {createGroupE0Records} from '../dist/engines/buriko/games/aokana/native/group-e0-records.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';
import {MemoryStore} from '../dist/platform/store.js';
import {StoredFileSystem, FileError} from '../dist/platform/filesystem.js';
import {
  AokanaProgramFiles,
  AokanaProgramMedia,
} from '../dist/engines/buriko/games/aokana/native/program-files.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {
  formatAokanaModuleList,
  createGroupE0Modules,
} from '../dist/engines/buriko/games/aokana/native/group-e0-modules.js';
import {AokanaSelectionDialog} from '../dist/engines/buriko/games/aokana/native/selection-dialog.js';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {
  copyAokanaBitmapGroupDescription,
  formatAokanaBitmapGroups,
} from '../dist/engines/buriko/games/aokana/native/bitmap-group-description.js';
import {createGroupE0BitmapDescription} from '../dist/engines/buriko/games/aokana/native/group-e0-bitmap-description.js';

const pointer = (size) => ({bytes: new Uint8Array(size), offset: 0});
const view = (p) => new DataView(p.bytes.buffer, p.bytes.byteOffset + p.offset);
const thread = () =>
  new AokanaBpThread({id: 4, operandCapacity: 4, moduleCapacity: 128, frameCapacity: 128});
const ascii = (text) => new TextEncoder().encode(text);
function attach(target, name) {
  const bytes = new Uint8Array(12);
  new DataView(bytes.buffer).setUint32(0, 8, true);
  new DataView(bytes.buffer).setUint32(4, 4, true);
  return attachModule(target, ascii(name), bytes);
}

test('native counter registration keeps bank order, clears counts and retains flags', () => {
  const counts = new AokanaDiagnosticCounts();
  assert.deepEqual(
    counts.banks.map((entry) => entry.bank),
    [0x7f, 0x80, 0x81, 0x90, 0x91, 0x92, 0xa0, 0xb0, 0xc0, 0xd0],
  );
  assert.equal(counts.enumerate(null), 0);
  const data = pointer(8),
    flags = pointer(8);
  data.bytes.fill(0xff);
  flags.bytes.fill(2);
  assert.equal(counts.register(0x180, 2, data, flags), 1);
  assert.deepEqual([...data.bytes], Array(8).fill(0));
  assert.equal(counts.register(0x180, 1, null, null), 0);
  view(data).setUint32(0, 0xffffffff, true);
  assert.equal(counts.setFlags(0x180, 2, 0), 4);
  assert.equal(counts.setFlags(0xe0, 0, 0), 3);
  assert.equal(counts.setFlags(0x180, 0, 3), 0);
  assert.equal(counts.enumerate(null), 0);
  counts.clear();
  assert.equal(view(flags).getUint32(0, true), 3);
  assert.equal(counts.register(0x180, 0, null, null), 1);
  assert.equal(counts.register(0x180, 0, null, null), 0);
});

test('native count enumeration preserves sequential writes when output aliases later counts', () => {
  const counts = new AokanaDiagnosticCounts(),
    data = pointer(16),
    flags = pointer(8);
  counts.dispose();
  counts.register(0x144, 2, data, flags);
  view(data).setUint32(0, 1, true);
  assert.equal(counts.enumerate(data), 2);
  assert.deepEqual([...new Uint32Array(data.bytes.buffer)], [0x4400, 0x4400, 0x4401, 0x4400]);
  counts.dispose();
  counts.register(1, 1, pointer(4), null);
  assert.equal(counts.enumerate(null), 0);
  view(counts.banks[0].counts).setUint32(0, 1, true);
  assert.throws(() => counts.enumerate(null), /null flags/);
});

test('module dumps retain borrowed-region ordering, local-only child dumps and raw name pointers', () => {
  const owner = thread();
  attach(owner, 'base');
  attach(owner, 'second');
  const a = new AokanaBpSharedThread({id: 5, operandCapacity: 2});
  const b = new AokanaBpSharedThread({id: 6, operandCapacity: 2});
  assert.equal(
    a.initialize(owner, 20, 10, 0, () => {}),
    0,
  );
  assert.equal(
    b.initialize(owner, 20, 10, 0, () => {}),
    0,
  );
  attach(a, 'child A');
  attach(b, 'child B');
  const full = listThreadModules(a, true);
  assert.deepEqual(
    full.map((module) => module.base),
    [108, 88, 4, 0],
  );
  assert.deepEqual(
    listThreadModules(a, false).map((module) => module.base),
    [108],
  );
  assert.equal(full[0].name, a.modules[0].name);
  a.instructionStart = 109;
  const diagnostic = new AokanaBpDiagnostics(() => {});
  const text = new TextDecoder().decode(diagnostic.formatThreadMessage(a, ascii('test')));
  assert.match(text, /Program \[ child A \]/);
  assert.match(text, /IP in program \[ \$00000001 \]/);
});

test('pooled allocation diagnostics preserve disabled state, raw module names and newest-first removal', () => {
  const records = new AokanaPooledAllocationDiagnostics(),
    owner = thread();
  assert.equal(records.record(1, 2, owner), 0);
  records.enabled = -1;
  assert.equal(records.record(1, 2, owner), 0);
  attach(owner, 'main');
  owner.instructionStart = 1;
  assert.equal(records.record(0x81234567, 0xffffffff, owner), 1);
  assert.equal(records.record(0x81234567, 2, owner), 1);
  assert.match(
    new TextDecoder().decode(records.records[1].text),
    /Address \[ \$81234567 \] : Size \[ -1 \] : Thread \[ 4 \] , Program \[ main \] , IP \[ \$00000001 \]\n/,
  );
  assert.equal(records.remove(0x81234567), 1);
  assert.match(new TextDecoder().decode(records.records[0].text), /Size \[ -1 \]/);
  records.enabled = 0;
  assert.equal(records.remove(0x81234567), 1);
  assert.equal(records.remove(0x81234567), 0);
  records.enabled = 1;
  owner.modules[0].name = new Uint8Array(200).fill(65);
  assert.throws(() => records.record(1, 2, owner), /sprintf stack/);
  assert.equal(records.records.length, 0);
});

test('E0 state bindings match all four verified entry points', () => {
  const slots = createGroupE0Records(
    new AokanaDiagnosticCounts(),
    new AokanaPooledAllocationDiagnostics(),
  );
  assert.deepEqual(
    slots.map((entry) => entry.secondary),
    [0x90, 0x91, 0x93, 0xc0],
  );
  for (const slot of slots)
    assert.equal(slot.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[slot.primary][slot.secondary]);
});

test('native output creation distinguishes empty success and retains prior writes across failure', async () => {
  const filesystem = new StoredFileSystem(new MemoryStore()),
    files = new AokanaProgramFiles(filesystem, new AokanaNativeText(), new AokanaProgramMedia());
  await filesystem.commit([{kind: 'write', path: '/counts.log', data: ascii('old')}]);
  const file = await files.createOutput(ascii('/counts.log'));
  assert.ok(file);
  assert.equal((await filesystem.stat('/counts.log')).size, 0);
  assert.equal(await file.write(ascii('first\n')), 6);
  const commit = filesystem.commit.bind(filesystem);
  filesystem.commit = async () => {
    throw new DOMException('synthetic full storage', 'QuotaExceededError');
  };
  assert.equal(await file.write(ascii('failed\n')), 0);
  filesystem.commit = commit;
  assert.equal(await file.write(ascii('last\n')), 5);
  file.close();
  file.close();
  assert.equal(await file.write(ascii('closed')), 0);
  const source = await filesystem.open('/counts.log');
  assert.equal(new TextDecoder().decode(await source.read(0, source.size)), 'first\nlast\n');
  filesystem.commit = async () => {
    throw new FileError('READ_ONLY', '/failed');
  };
  assert.equal(await files.createOutput(ascii('/failed')), null);
});

test('module list formatting reverses the borrowed dump and retains the modal output alias', async () => {
  const owner = thread();
  attach(owner, 'one');
  attach(owner, 'two');
  assert.equal(
    new TextDecoder().decode(formatAokanaModuleList(owner)).split('\0')[0],
    'one - $000000\ntwo - $000004\n',
  );
  const events = [],
    selection = new AokanaSelectionDialog(
      {
        withNativeModal: async (operation) => {
          events.push('enter');
          const result = await operation();
          events.push('leave');
          return result;
        },
        chooseList: async (caption, prompt, items) => {
          events.push([caption, prompt, items]);
          return {accepted: true, index: 1};
        },
      },
      new AokanaNativeText(),
    );
  const [slot] = createGroupE0Modules(selection, ascii('Engine\0'));
  assert.equal(await slot.execute({thread: owner}), 0);
  assert.deepEqual(events, [
    'enter',
    ['Engine', 'Thread [ 4 ]', ['one - $000000', 'two - $000004']],
    'leave',
  ]);
  events.length = 0;
  await assert.rejects(slot.execute({thread: thread()}), /outside|unterminated/);
  assert.deepEqual(events, ['enter']);
});

function groupsFixture() {
  const memory = new AokanaBpMemory(new Uint8Array(4096)),
    owner = thread();
  const data = new DataView(memory.globalMemory.buffer);
  data.setUint32(64, 1, true);
  data.setUint32(68, 128, true);
  data.setUint32(128, 1, true);
  data.setUint32(136, 256, true);
  [1, 0, -2, 3, -4, 5, 6, -7, 8, 9, 10, 11, -1].forEach((value, index) =>
    data.setInt32(256 + index * 4, value, true),
  );
  return {memory, owner, data, source: memory.resolve(owner, 64)};
}

test('grouped bitmap descriptions copy all units before formatting and preserve exact fixed fields', () => {
  const {memory, owner, data, source} = groupsFixture();
  const result = copyAokanaBitmapGroupDescription(source, memory, owner);
  assert.equal(result.result, 0);
  data.setInt32(256, 0, true);
  const output = memory.resolve(owner, 512),
    text = new AokanaNativeText();
  const size = formatAokanaBitmapGroups(output, result.description, text);
  const expected =
    '- Group [ 0 ] -\n\n\tUnit [   0 ] / Validity : TRUE  / Visibility : FALSE / Position(   -2,    3 ) / Origin(   -4,    5 ) / Bitmaps : 6 / ChangeInterval : -7 / BaseBitmaps( 8, 9, 10, 11 ) / BitmapForVPD : -1\n\n';
  assert.equal(
    new TextDecoder().decode(output.bytes.subarray(output.offset, output.offset + size)),
    expected,
  );
  assert.equal(output.bytes[output.offset + size], 0);
  assert.equal(formatAokanaBitmapGroups(null, result.description, text), size);
  assert.equal(
    createGroupE0BitmapDescription(text)[0].nativeAddress,
    AOKANA_NATIVE_SLOT_ADDRESSES[0xe0][0x3f],
  );
});

test('bitmap group allocation uses low16 counts but formatter consumes full signed counts', () => {
  const {memory, owner, data, source} = groupsFixture(),
    text = new AokanaNativeText();
  data.setUint32(128, 0x80000001, true);
  const skipped = copyAokanaBitmapGroupDescription(source, memory, owner);
  assert.equal(skipped.result, 0);
  const destination = pointer(2048);
  destination.bytes.fill(0xcc);
  const length = formatAokanaBitmapGroups(destination, skipped.description, text);
  assert.equal(
    new TextDecoder().decode(destination.bytes.subarray(0, length)),
    '- Group [ 0 ] -\n\n\n',
  );
  data.setUint32(128, 0x10001, true);
  const overread = copyAokanaBitmapGroupDescription(source, memory, owner);
  assert.equal(overread.result, 0);
  destination.bytes.fill(0xcc);
  assert.throws(
    () => formatAokanaBitmapGroups(destination, overread.description, text),
    /outside backing/,
  );
  assert.ok(destination.bytes.every((byte) => byte === 0xcc));
});

test('bitmap descriptor validation resolves addresses before counts and skips later groups after failure', () => {
  const {memory, owner, data, source} = groupsFixture();
  data.setUint32(64, 0, true);
  data.setUint32(68, 0x80000001, true);
  assert.throws(() => copyAokanaBitmapGroupDescription(source, memory, owner), /pooled allocation/);
  data.setUint32(64, 2, true);
  data.setUint32(68, 128, true);
  data.setUint32(128, 0, true);
  data.setUint32(136, 256, true);
  data.setUint32(128 + 0x40 + 8, 0x80000001, true);
  assert.deepEqual(copyAokanaBitmapGroupDescription(source, memory, owner), {result: 3});
  assert.throws(() => copyAokanaBitmapGroupDescription(null, memory, owner), /null description/);
});

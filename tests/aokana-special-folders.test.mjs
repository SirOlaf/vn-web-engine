import assert from 'node:assert/strict';
import test from 'node:test';
import {AokanaMountedProgramPaths} from '../dist/engines/buriko/games/aokana/native/program-paths.js';
import {AokanaSpecialFolders} from '../dist/engines/buriko/games/aokana/native/special-folders.js';
import {AokanaNativeRegistry} from '../dist/engines/buriko/games/aokana/native/windows-registry.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {MemoryStore} from '../dist/platform/store.js';
import {StoredFileSystem} from '../dist/platform/filesystem.js';
import {
  AokanaProgramFiles,
  AokanaProgramMedia,
} from '../dist/engines/buriko/games/aokana/native/program-files.js';
import {
  AokanaDiagnosticCounts,
  AokanaPooledAllocationDiagnostics,
} from '../dist/engines/buriko/games/aokana/native/diagnostic-records.js';
import {createGroupE0Files} from '../dist/engines/buriko/games/aokana/native/group-e0-files.js';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';

const ascii = (value) => new TextEncoder().encode(value);
const pointer = (value = 784) => ({
  bytes: typeof value === 'number' ? new Uint8Array(value) : ascii(value + '\0'),
  offset: 0,
});
const string = (value) =>
  new TextDecoder().decode(value.bytes.subarray(value.offset)).split('\0')[0];
function fixture() {
  const text = new AokanaNativeText(),
    registry = new AokanaNativeRegistry(new MemoryStore());
  const currentUser = {
    desktop: 'C:\\Users\\Current\\Desktop',
    programs: 'C:\\Users\\Current\\Programs',
    documents: 'C:\\Users\\Current\\Documents',
    profile: 'C:\\Users\\Current',
  };
  const shellUser = {
    desktop: 'C:\\Users\\Shell\\Desktop',
    programs: 'C:\\Users\\Shell\\Programs',
    documents: 'C:\\Users\\Shell\\Documents',
    profile: 'C:\\Users\\Shell',
  };
  const profile = {
    shellAllocatorAvailable: true,
    windows: 'C:\\Windows',
    programFiles: 'C:\\Program Files',
    currentUser,
    shellUser,
    elevated: false,
    shellTokenAvailable: true,
    debugPrivilegeAvailable: true,
    shellAccountName: 'Shell',
  };
  const roots = {primaryRoot: ascii('C:\\Game\\'), secondaryRoot: Uint8Array.of(0)};
  const folders = new AokanaSpecialFolders(text, registry, roots, profile);
  return {text, registry, profile, roots, folders};
}

test('mounted DOS and UNC paths retain explicit drive directories and longest mount selection', () => {
  const paths = new AokanaMountedProgramPaths(
    [
      {native: 'C:\\', mounted: '/drive'},
      {native: 'C:\\Game', mounted: '/game'},
      {native: 'D:\\', mounted: '/media'},
      {native: '\\\\server\\share', mounted: '/network'},
    ],
    'C:\\Game',
  );
  assert.equal(paths.resolve('folder\\.\\file.bin'), '/game/folder/file.bin');
  assert.equal(paths.resolve('C:/GAME/../Game/a'), '/game/a');
  assert.equal(paths.resolve('\\Windows\\log.txt'), '/drive/Windows/log.txt');
  assert.equal(paths.resolve('D:records.txt'), '/media/records.txt');
  paths.setCurrentDirectory('D:\\Data');
  assert.equal(paths.resolve('C:local.txt'), '/game/local.txt');
  assert.equal(paths.resolve('..\\other'), '/media/other');
  assert.equal(paths.resolve('\\\\SERVER\\share\\folder\\a'), '/network/folder/a');
  assert.equal(paths.resolveNative('..\\..\\..\\item'), 'D:\\item');
});

test('special folders share mutable resource roots and encode shell paths independently of selected codepage', async () => {
  const {folders, roots, profile} = fixture(),
    output = pointer();
  assert.equal(folders.resourceRoot(output, 0), 1);
  assert.equal(string(output), 'C:\\Game\\');
  roots.primaryRoot = ascii('C:\\Other');
  assert.equal(folders.resourceRoot(output, 0), 1);
  assert.equal(string(output), 'C:\\Other');
  assert.equal(folders.resourceRoot(output, 1), 0);
  assert.equal(string(output), 'C:\\Other');
  profile.currentUser.desktop = 'C:\\Users\\日本\\Desktop';
  for (const [selector, expected] of [
    [0, 'C:\\Windows'],
    [1, profile.currentUser.desktop],
    [2, profile.currentUser.programs],
    [3, profile.currentUser.documents],
    [4, 'C:\\Program Files'],
  ]) {
    assert.equal(await folders.query(output, selector), 1);
    assert.equal(string(output), expected);
  }
  assert.equal(await folders.query(output, 8), 0);
  assert.equal(string(output), 'C:\\Program Files');
});

test('elevated folder profile selects shell mappings and preserves byte-sensitive fallback prefix rules', async () => {
  const {folders, profile} = fixture(),
    output = pointer();
  profile.elevated = true;
  await folders.query(output, 1);
  assert.equal(string(output), 'C:\\Users\\Shell\\Desktop');
  profile.shellTokenAvailable = false;
  await folders.query(output, 1);
  assert.equal(string(output), 'C:\\Users\\Shell\\Desktop');
  profile.currentUser.desktop = 'c:\\Users\\Current\\Desktop';
  await folders.query(output, 1);
  assert.equal(string(output), 'c:\\Users\\Current\\Desktop');
  profile.currentUser.desktop = 'C:\\Users\\CurrentExtra\\Desktop';
  await folders.query(output, 1);
  assert.equal(string(output), 'C:\\Users\\ShellExtra\\Desktop');
  profile.debugPrivilegeAvailable = false;
  await folders.query(output, 1);
  assert.equal(string(output), 'C:\\Users\\CurrentExtra\\Desktop');
});

test('ProgramFilesDir comes from the shared 64-bit registry and closes the opened key', async () => {
  const {folders, registry} = fixture(),
    output = pointer();
  const opened = await registry.createKey(
    0x80000002,
    'SOFTWARE\\Microsoft\\Windows\\CurrentVersion',
    0x2011b,
  );
  const path = 'D:\\Applications\0',
    bytes = new Uint8Array(path.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < path.length; index++)
    view.setUint16(index * 2, path.charCodeAt(index), true);
  await registry.setValue(opened.handle, 'ProgramFilesDir', 1, bytes);
  registry.closeKey(opened.handle);
  assert.equal(await folders.query(output, 5), 1);
  assert.equal(string(output), 'D:\\Applications');
  assert.equal(registry.openHandleCount, 0);
});

test('native path combination converts CP932 separately and preserves an aliasing output', () => {
  const {folders, text} = fixture(),
    output = pointer();
  output.bytes.set(ascii('C:\\Game\\\0'));
  const name = {bytes: text.encodeWide('日本.log', 0), offset: 0};
  folders.combine(output, output, 0, name);
  assert.equal(string(output), 'C:\\Game\\日本.log');
  folders.combine(output, pointer('C:\\Game\\'), 1, pointer('log'));
  assert.equal(string(output), 'C:\\Game\\\\log');
});

function writerFixture() {
  const f = fixture(),
    filesystem = new StoredFileSystem(new MemoryStore());
  const paths = new AokanaMountedProgramPaths([{native: 'C:\\', mounted: '/drive'}], 'C:\\Game');
  const files = new AokanaProgramFiles(filesystem, f.text, new AokanaProgramMedia(), paths);
  files.specialFolders = f.folders;
  const counts = new AokanaDiagnosticCounts(),
    allocations = new AokanaPooledAllocationDiagnostics();
  const slots = createGroupE0Files(files, f.folders, counts, allocations);
  const thread = new AokanaBpThread({
    id: 1,
    operandCapacity: 8,
    moduleCapacity: 64,
    frameCapacity: 64,
  });
  const memory = new AokanaBpMemory(new Uint8Array(1024));
  const execute = async (slot, name, selector) => {
    memory.globalMemory.set(ascii(name + '\0'), 64);
    push32(thread, 64);
    push32(thread, selector);
    assert.equal(
      await slots.find((definition) => definition.secondary === slot).execute({thread, memory}),
      0,
    );
    return pop32(thread);
  };
  const read = async (path) => {
    const source = await filesystem.open(path);
    return new TextDecoder().decode(await source.read(0, source.size));
  };
  return {...f, filesystem, files, counts, allocations, slots, execute, read};
}

test('E0 count files keep bank order, full hexadecimal widths and signed decimal counts', async () => {
  const {counts, slots, execute, read} = writerFixture();
  counts.dispose();
  const data = pointer(1028),
    flags = pointer(1028);
  counts.register(0x180, 257, data, flags);
  const view = new DataView(data.bytes.buffer);
  view.setUint32(4, 0xffffffff, true);
  view.setUint32(8, 2, true);
  flags.bytes[8] = 1;
  view.setUint32(1024, 3, true);
  assert.equal(await execute(0x92, 'counts.log', 0), 0);
  assert.equal(await read('/drive/Game/counts.log'), '0x18001 : -1\n0x180100 : 3\n');
  for (const slot of slots)
    assert.equal(slot.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[slot.primary][slot.secondary]);
});

test('E0 output creates empty files, writes stored byte order and ignores individual write failures', async () => {
  const {filesystem, allocations, execute, read} = writerFixture();
  assert.equal(await execute(0x92, 'empty.log', 1), 0);
  assert.equal(await read('/drive/Users/Current/Desktop/empty.log'), '');
  allocations.records.push(
    {address: 1, text: ascii('newest\n')},
    {address: 2, text: ascii('older\n')},
  );
  const commit = filesystem.commit.bind(filesystem);
  let writes = 0;
  filesystem.commit = async (changes) => {
    if (++writes === 2) throw new DOMException('synthetic storage denial', 'NotAllowedError');
    return commit(changes);
  };
  assert.equal(await execute(0xc2, 'records.log', 0), 0);
  assert.equal(await read('/drive/Game/records.log'), 'older\n');
  assert.equal(await execute(0x92, 'ignored.log', 2), 1);
  filesystem.commit = async () => {
    throw new DOMException('synthetic storage denial', 'NotAllowedError');
  };
  assert.equal(await execute(0x92, 'denied.log', 0), 2);
});

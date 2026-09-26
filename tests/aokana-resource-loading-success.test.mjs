import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';
import {BurikoBitmapPreloadCache} from '../dist/engines/buriko/native/bitmap-preload-cache.js';
import {BurikoResourceCache} from '../dist/engines/buriko/native/resource-cache.js';
import {BurikoResourceLoadingState} from '../dist/engines/buriko/native/resource-loading.js';
import {BurikoProgramResources} from '../dist/engines/buriko/native/program-resources.js';
import {
  BurikoProgramFiles,
  BurikoProgramMedia,
} from '../dist/engines/buriko/native/program-files.js';
import {
  BurikoDistributedAllocator,
  BurikoDistributedProcessing,
} from '../dist/engines/buriko/native/distributed-processing.js';
import {SourceFileSystem} from '../dist/platform/filesystem.js';
import {WindowsFileSystem, windowsFileKey} from '../dist/platform/windows-filesystem.js';
import {BlobSource} from '../dist/core/source.js';

const bytes = (value) => new TextEncoder().encode(value);

test('bitmap preload keys retain byte encoding while copies, duplicate insertion and consumption share one cache', () => {
  const text = new BurikoNativeText(),
    cache = new BurikoBitmapPreloadCache(text);
  const archive = bytes('DATA.ARC'),
    name = bytes('Face'),
    payload = Uint8Array.of(4, 5, 6);
  assert.equal(cache.insert(archive, name, payload), 1);
  archive.fill(90);
  name.fill(90);
  payload.fill(99);
  assert.equal(cache.insert(bytes('data.arc'), bytes('face'), Uint8Array.of(8)), 0);
  assert.equal(cache.size(bytes('DATA.arc'), bytes('FACE')), 3);
  const copy = cache.read(bytes('data.arc'), bytes('face'));
  assert.deepEqual(copy, Uint8Array.of(4, 5, 6));
  copy.fill(88);
  assert.deepEqual(cache.read(bytes('DATA.ARC'), bytes('FACE'), 1), Uint8Array.of(4, 5, 6));
  assert.equal(cache.size(bytes('data.arc'), bytes('face')), null);
  const cp932 = text.encodeWide('あABC', 0),
    utf8 = text.encodeWide('あabc', 1);
  assert.equal(cache.insert(null, cp932, Uint8Array.of(11)), 1);
  assert.equal(cache.insert(null, utf8, Uint8Array.of(12)), 1);
  assert.deepEqual(cache.read(null, cp932), Uint8Array.of(11));
  assert.deepEqual(cache.read(null, utf8), Uint8Array.of(12));
  cache.clear();
  assert.equal(cache.size(null, cp932), null);
});

test('preload archive null and empty-string matches preserve native newest-first asymmetry', () => {
  const cache = new BurikoBitmapPreloadCache(new BurikoNativeText());
  assert.equal(cache.insert(null, bytes('x'), Uint8Array.of(1)), 1);
  assert.equal(cache.insert(bytes(''), bytes('x'), Uint8Array.of(2)), 1);
  assert.deepEqual(cache.read(null, bytes('x'), 1), Uint8Array.of(2));
  assert.deepEqual(cache.read(null, bytes('x'), 1), Uint8Array.of(1));
  assert.equal(cache.insert(bytes(''), bytes('y'), Uint8Array.of(3)), 1);
  assert.equal(cache.insert(null, bytes('y'), Uint8Array.of(4)), 0);
});

test('optional resource cache decodes wide keys and promotes size queries before ordinary capacity eviction', () => {
  const text = new BurikoNativeText(),
    cache = new BurikoResourceCache(text);
  cache.configure(12);
  for (const [name, n] of [
    ['first', 1],
    ['second', 2],
    ['third', 3],
  ])
    assert.equal(cache.insert(null, bytes(name), new Uint8Array(4).fill(n)), 1);
  assert.equal(cache.size(null, bytes('FIRST')), 4);
  cache.insert(null, bytes('fourth'), new Uint8Array(4).fill(4));
  assert.equal(cache.size(null, bytes('second')), null);
  assert.equal(cache.bytesUsed, 12);
  assert.deepEqual(cache.read(null, bytes('first')), new Uint8Array(4).fill(1));
  cache.configure(12);
  assert.equal(cache.bytesUsed, 0);
  cache.insert(text.encodeWide('あARC', 0), text.encodeWide('あBMP', 0), Uint8Array.of(7, 8));
  const read = cache.read(text.encodeWide('あarc', 1), text.encodeWide('あbmp', 1));
  assert.deepEqual(read, Uint8Array.of(7, 8));
  read[0] = 99;
  assert.deepEqual(
    cache.read(text.encodeWide('あarc', 1), text.encodeWide('あbmp', 1)),
    Uint8Array.of(7, 8),
  );
  cache.insert(null, bytes('dup'), Uint8Array.of(1));
  cache.insert(null, bytes('dup'), Uint8Array.of(2));
  assert.deepEqual(cache.read(null, bytes('dup')), Uint8Array.of(2));
});

function setup() {
  const sources = new SourceFileSystem(windowsFileKey);
  const fs = new WindowsFileSystem(sources, {
    cwd: 'C:\\game',
    mounts: [{windows: 'C:\\', virtual: '/'}],
  });
  const text = new BurikoNativeText(),
    media = new BurikoProgramMedia();
  media.setDriveType(2, 3);
  const files = new BurikoProgramFiles(fs, text, media);
  const processing = new BurikoDistributedProcessing(new BurikoDistributedAllocator(1), 1);
  const unavailable = () =>
    assert.fail('Successful synthetic resource lookup does not open a dialog');
  const resources = new BurikoProgramResources(
    files,
    {
      nativeFileRoot: 'C:\\game\\',
      primaryRoot: bytes('C:\\game\\'),
      secondaryRoot: bytes('C:\\disc\\'),
      secondaryMediaPath: 'C:\\disc\\',
      searchDirectoriesEnabled: 1,
      searchDirectories: [bytes('sub')],
      retryTitle: bytes('Media'),
      retryMessage: bytes('Insert'),
      quitConfirmation: bytes('Quit?'),
    },
    {show: unavailable},
    {fatal: unavailable},
    processing,
  );
  return {
    loading: new BurikoResourceLoadingState(resources),
    mount(path, data) {
      sources.attach(path, new BlobSource(new Blob([data])));
    },
  };
}

function archive(payload, metadata = 0x123456789abcdefn) {
  const output = new Uint8Array(144 + payload.length),
    view = new DataView(output.buffer);
  output.set(bytes('BURIKO ARC20'));
  view.setUint32(12, 1, true);
  output.set(bytes('entry'), 16);
  view.setUint32(116, payload.length, true);
  view.setBigUint64(120, metadata, true);
  output.set(payload, 144);
  return output;
}

test('actual resource FIFO copies names, processes one head and preserves the native result ordering', async () => {
  const {loading, mount} = setup();
  mount('/game/sub/first', Uint8Array.of(1, 2, 3));
  mount('/game/a.arc', archive(Uint8Array.of(4, 5, 6, 7)));
  const first = {bytes: null},
    second = {bytes: null},
    a = {value: 9},
    b = {value: 9};
  const name = bytes('first');
  loading.enqueueOwned(first, a, null, name);
  loading.enqueueOwned(second, b, bytes('a.arc'), bytes('entry'));
  name.fill(88);
  assert.deepEqual([a.value, b.value, loading.hasPending], [0, 0, true]);
  const active = loading.processNext();
  assert.equal(loading.processNext(), active);
  assert.equal(await active, true);
  assert.deepEqual(first.bytes, Uint8Array.of(1, 2, 3));
  assert.deepEqual([a.value, b.value, second.bytes, loading.hasPending], [3, 0, null, true]);
  assert.equal(await loading.processNext(), true);
  assert.deepEqual(second.bytes, Uint8Array.of(4, 5, 6, 7));
  assert.equal(b.value, 4);
  assert.equal(loading.hasPending, false);
  assert.equal(await loading.processNext(), false);
  loading.enterProcedure();
  loading.enterProcedure();
  loading.leaveProcedure();
  assert.equal(loading.activeProcedures, 1);
  loading.leaveProcedure();
  assert.equal(loading.activeProcedures, 0);
});

test('queued raw reads use stored ranges and archive metadata through the existing archive cache', async () => {
  const {loading, mount} = setup();
  const payload = Uint8Array.of(20, 21, 22, 23, 24, 25);
  mount('/game/a.arc', archive(payload));
  const output = {bytes: null},
    status = {value: 7},
    metadata = {value: 0n};
  loading.enqueue(output, null, status, metadata, bytes('a.arc'), bytes('entry'), 2, 3);
  await loading.processNext();
  assert.equal(status.value, 3);
  assert.deepEqual(output.bytes, Uint8Array.of(22, 23, 24));
  assert.equal(metadata.value, 0x123456789abcdefn);
  loading.enqueue(output, null, status, metadata, bytes('a.arc'), bytes('entry'));
  await loading.processNext();
  assert.equal(status.value, 6);
  assert.deepEqual(output.bytes, payload);
  mount('/disc/loose', Uint8Array.of(10, 11, 12, 13));
  const direct = new Uint8Array(4).fill(77);
  loading.enqueue(null, {bytes: direct, offset: 1}, status, null, null, bytes('loose'), 1, 2);
  await loading.processNext();
  assert.equal(status.value, 2);
  assert.deepEqual(direct, Uint8Array.of(77, 11, 12, 77));
});

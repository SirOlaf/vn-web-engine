import assert from 'node:assert/strict';
import test from 'node:test';
import {MemoryStore} from '../dist/platform/store.js';
import {aokanaRegistryFold} from '../dist/engines/buriko/games/aokana/native/registry-case.js';
import {AokanaNativeRegistry} from '../dist/engines/buriko/games/aokana/native/windows-registry.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {
  AokanaBrowserDesktop,
  AokanaWallpaper,
  createGroupB0Wallpaper,
} from '../dist/engines/buriko/games/aokana/native/wallpaper.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';

const hkcu = 0xffffffff80000001n;
const bytes = (value) => ({bytes: new TextEncoder().encode(value + '\0'), offset: 0});

test('registry preserves raw values, independent handles and persistent title storage', async () => {
  const store = new MemoryStore();
  const registry = new AokanaNativeRegistry(store);
  const first = await registry.createKey(hkcu, 'Software\\Aokana', 3);
  assert.equal(first.disposition, 1);
  assert.ok(first.handle > 0xffffffffn);
  const second = await registry.createKey(0x80000001, 'software\\aokana\\\\', 1);
  assert.equal(second.disposition, 2);
  assert.notEqual(second.handle, first.handle);
  const data = Uint8Array.of(0xff, 0, 0x81);
  assert.equal(await registry.setValue(first.handle, 'Value\0ignored', 0xfedcba98, data), 0);
  data[0] = 0;
  assert.deepEqual(await registry.queryValue(second.handle, 'value'), {
    result: 0,
    value: {type: 0xfedcba98, data: Uint8Array.of(0xff, 0, 0x81)},
  });
  assert.equal(await registry.setValue(second.handle, 'Value', 1, data), 5);
  assert.equal(registry.closeKey(first.handle), 0);
  assert.equal(registry.closeKey(first.handle), 6);
  const reopened = new AokanaNativeRegistry(store);
  const opened = await reopened.openKey(hkcu, 'Software\\Aokana', 1);
  assert.deepEqual(await reopened.queryValue(opened.handle, 'VALUE'), {
    result: 0,
    value: {type: 0xfedcba98, data: Uint8Array.of(0xff, 0, 0x81)},
  });
});

test('registry retains predefined root identity and Win64 path/error distinctions', async () => {
  const registry = new AokanaNativeRegistry(new MemoryStore());
  assert.deepEqual(await registry.openKey(hkcu, null, 0x300), {result: 0, handle: hkcu});
  assert.equal(registry.openHandleCount, 0);
  const created = await registry.createKey(hkcu, '', 3);
  assert.notEqual(created.handle, hkcu);
  const copied = await registry.openKey(created.handle, '', 1);
  assert.notEqual(copied.handle, created.handle);
  assert.deepEqual(await registry.createKey(hkcu, '\\Bad', 3), {result: 161});
  assert.deepEqual(await registry.openKey(hkcu, '\\Bad', 3), {result: 161, handle: 0n});
  assert.deepEqual(await registry.openKey(hkcu, 'Missing', 3), {result: 2, handle: 0n});
  assert.deepEqual(await registry.openKey(0, '', 1), {result: 6, handle: 0n});
  const classes = await registry.openKey(0xffffffff80000000n, '\\', 1);
  assert.equal(classes.result, 0);
  assert.ok(classes.handle > 0xffffffffn);
  assert.equal(registry.closeKey(hkcu), 0);
  assert.equal(registry.closeKey(0xffffffff80000004n), 6);
});

test('wallpaper writes native UTF-16 bytes in order and leaks the key before browser failure', async () => {
  const records = [],
    registry = new AokanaNativeRegistry(new MemoryStore()),
    storage = registry.storage;
  const original = storage.setValue.bind(storage);
  storage.setValue = async (key, name, value) => {
    records.push([name, value.type, [...value.data]]);
    await original(key, name, value);
  };
  const calls = [];
  const desktop = new AokanaBrowserDesktop();
  desktop.setWallpaper = (path, flags) => {
    calls.push([path, flags]);
    return false;
  };
  const wallpaper = new AokanaWallpaper(registry, desktop, new AokanaNativeText());
  await wallpaper.set(bytes('wallpaper.bmp'), 1, 0);
  assert.deepEqual(records, [
    ['WallpaperStyle', 1, [50, 0, 0, 0]],
    ['TileWallpaper', 1, [48, 0, 0, 0]],
  ]);
  assert.deepEqual(calls, [['wallpaper.bmp', 3]]);
  assert.equal(registry.openHandleCount, 1);
  await assert.rejects(wallpaper.set(null, 0, 1), /null native filename/);
  assert.equal(registry.openHandleCount, 2);
  assert.deepEqual(records.slice(2), [
    ['WallpaperStyle', 1, [48, 0, 0, 0]],
    ['TileWallpaper', 1, [49, 0, 0, 0]],
  ]);
  assert.equal(new AokanaBrowserDesktop().setWallpaper('x', 3), false);
  const [slot] = createGroupB0Wallpaper(wallpaper);
  assert.equal(slot.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[0xb0][0xf0]);
});

test('wallpaper ignores write errors but diagnoses an unwritten handle before decoding', async () => {
  const registry = new AokanaNativeRegistry(new MemoryStore()),
    storage = registry.storage,
    events = [];
  storage.setValue = async (_key, name) => {
    events.push(name);
    throw new DOMException('synthetic denied write', 'NotAllowedError');
  };
  const desktop = new AokanaBrowserDesktop();
  desktop.setWallpaper = (path, flags) => {
    events.push([path, flags]);
    return false;
  };
  const wallpaper = new AokanaWallpaper(registry, desktop, new AokanaNativeText());
  await wallpaper.set(bytes('x'), 0, 0);
  assert.deepEqual(events, ['WallpaperStyle', 'TileWallpaper', ['x', 3]]);
  storage.createKey = async () => {
    throw new DOMException('synthetic quota', 'QuotaExceededError');
  };
  await assert.rejects(wallpaper.set(null, 0, 0), /unwritten native registry handle/);
  assert.equal(registry.openHandleCount, 1);
  assert.equal(events.length, 3);
});

test('registry Unicode profile is nonexpanding and retains every original UTF-16 name', async () => {
  assert.equal(aokanaRegistryFold('ßσςıé\u1f80'), 'ßΣΣIÉ\u1f88');
  assert.equal(
    aokanaRegistryFold('\ud800\udc00\ud801\udc28\ud800\udfff'),
    '\ud800\udc00\ud801\udc28\ud800\udfff',
  );
  assert.notEqual(aokanaRegistryFold('é'), aokanaRegistryFold('e\u0301'));
  const store = new MemoryStore(),
    registry = new AokanaNativeRegistry(store);
  const key = await registry.createKey(hkcu, 'Software\\蒼の彼方\\Straße\\\ud800a', 3);
  assert.equal(key.result, 0);
  assert.equal(await registry.setValue(key.handle, 'é\udfff', 1, Uint8Array.of(0xd8)), 0);
  const reopened = await registry.openKey(hkcu, 'software\\蒼の彼方\\STRAßE\\\ud800A', 1);
  assert.equal(reopened.result, 0);
  assert.equal((await registry.queryValue(reopened.handle, 'É\udfff')).result, 0);
  assert.equal((await registry.openKey(hkcu, 'Software\\蒼の彼方\\STRASSE\\\ud800a', 1)).result, 2);
  assert.equal((await registry.openKey(hkcu, 'Software\\蒼の彼方\\Straße\\%ud800a', 1)).result, 2);
  assert.deepEqual(
    await registry.storage.enumerate({
      hive: 'HKCU',
      view: '64',
      path: 'Software\\蒼の彼方\\Straße\\\ud800a',
    }),
    {
      subkeys: [],
      values: [{name: 'é\udfff', type: 1, data: Uint8Array.of(0xd8)}],
    },
  );
  const records = await store.snapshot();
  assert.ok(records.has('registry:HKCU:64/SOFTWARE'));
  assert.ok([...records.keys()].some((key) => key.endsWith('/%ud800A')));
});

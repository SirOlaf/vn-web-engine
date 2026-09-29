import assert from 'node:assert/strict';
import test from 'node:test';

import {gameDirectoryFiles} from '../dist/game-directory.js';
import {selectMagesExecutable} from '../dist/engines/mages/executable.js';

const file = (webkitRelativePath) => ({
  name: webkitRelativePath.split('/').at(-1),
  webkitRelativePath,
});

test('game directory selection finds root executable and direct Data archives', () => {
  const selected = gameDirectoryFiles([
    file('CHAOS HEAD NOAH/readme.txt'),
    file('CHAOS HEAD NOAH/Data/script.cpk'),
    file('CHAOS HEAD NOAH/Data/._script.cpk'),
    file('CHAOS HEAD NOAH/._Game.exe'),
    file('CHAOS HEAD NOAH/Game.exe'),
    file('CHAOS HEAD NOAH/Data/mes00.CPK'),
    file('CHAOS HEAD NOAH/Data/cache/ignored.cpk'),
  ]);

  assert.deepEqual(
    selected.executables.map(({name}) => name),
    ['Game.exe'],
  );
  assert.deepEqual(
    selected.archives.map(({name}) => name),
    ['mes00.CPK', 'script.cpk'],
  );
});

test('game directory selection requires the installation layout', () => {
  assert.throws(() => gameDirectoryFiles([file('Data/script.cpk')]), /containing Data\/\*\.cpk/);
  assert.throws(
    () => gameDirectoryFiles([file('Game/Game.exe'), file('Other/Data/script.cpk')]),
    /single game folder/,
  );
});

/** Minimal PE whose only resource is a VS_VERSIONINFO string table. */
function versionedExecutable(strings) {
  const utf16 = (text) => [...text].flatMap((c) => [c.charCodeAt(0), 0]).concat(0, 0);
  const pad = (bytes) => (bytes.length % 4 ? [...bytes, 0, 0] : bytes);
  const block = (key, valueLength, type, value, children = []) => {
    let body = pad([0, 0, valueLength & 255, valueLength >> 8, type, 0, ...utf16(key)]);
    body = pad([...body, ...value]);
    for (const child of children) body = pad([...body, ...child]);
    body[0] = body.length & 255;
    body[1] = body.length >> 8;
    return body;
  };
  const entries = Object.entries(strings).map(([key, value]) =>
    block(key, value.length + 1, 1, utf16(value)),
  );
  const version = block(
    'VS_VERSION_INFO',
    0,
    0,
    [],
    [block('StringFileInfo', 0, 1, [], [block('041104b0', 0, 1, [], entries)])],
  );
  const rsrcRva = 0x1000,
    rsrcRaw = 0x200;
  const dir = (id, target, leaf = false) => [
    ...new Array(12).fill(0),
    0,
    0,
    1,
    0,
    ...u32(id),
    ...u32(leaf ? target : target | 0x80000000),
  ];
  const u32 = (v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
  const tree = [...dir(16, 0x18), ...dir(1, 0x30), ...dir(0x411, 0x48, true)];
  const data = [...u32(rsrcRva + 0x58), ...u32(version.length), 0, 0, 0, 0, 0, 0, 0, 0];
  const rsrc = [...tree, ...data, ...version];
  const bytes = new Uint8Array(rsrcRaw + rsrc.length + 0x200);
  const view = new DataView(bytes.buffer);
  bytes.set([0x4d, 0x5a]);
  view.setUint32(0x3c, 0x40, true);
  bytes.set([0x50, 0x45, 0, 0], 0x40);
  view.setUint16(0x44, 0x8664, true);
  view.setUint16(0x46, 1, true);
  view.setUint16(0x54, 0xf0, true);
  view.setUint16(0x58, 0x20b, true);
  view.setUint32(0x58 + 60, rsrcRaw, true);
  view.setUint32(0x58 + 108, 16, true);
  view.setUint32(0x58 + 112 + 16, rsrcRva, true);
  view.setUint32(0x58 + 112 + 20, rsrc.length, true);
  const section = 0x58 + 0xf0;
  bytes.set(
    [...'.rsrc'].map((c) => c.charCodeAt(0)),
    section,
  );
  view.setUint32(section + 8, rsrc.length, true);
  view.setUint32(section + 12, rsrcRva, true);
  view.setUint32(section + 16, rsrc.length, true);
  view.setUint32(section + 20, rsrcRaw, true);
  bytes.set(rsrc, rsrcRaw);
  return bytes;
}

test('MAGES executable selection identifies storefront-renamed builds', async () => {
  const entry = (path, bytes) => ({
    path,
    source: {
      size: bytes.length,
      read: async (offset, length) => bytes.slice(offset, offset + length),
    },
  });
  const game = entry(
    '/Game_Steam.exe',
    versionedExecutable({CompanyName: 'MAGES.', OriginalFilename: 'Game.exe'}),
  );
  const uninstaller = entry(
    '/unins000.exe',
    versionedExecutable({FileDescription: 'Setup/Uninstall'}),
  );
  assert.equal(await selectMagesExecutable([uninstaller, game]), game);
  const canonical = entry('/Game.exe', new Uint8Array(0));
  assert.equal(await selectMagesExecutable([game, canonical]), canonical);
  assert.equal(await selectMagesExecutable([uninstaller]), undefined);
  const copy = entry('/Game_Copy.exe', await game.source.read(0, game.source.size));
  await assert.rejects(selectMagesExecutable([game, copy]), /Multiple game executables/);
});

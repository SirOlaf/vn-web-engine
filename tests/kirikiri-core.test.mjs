import assert from 'node:assert/strict';
import test from 'node:test';
import {deflateSync} from 'node:zlib';
import {adler32} from '../dist/core/inflate.js';
import {sha256} from '../dist/core/sha256.js';
import {XP3_FILE_PROTECTED} from '../dist/formats/kirikiri/xp3.js';
import {applyCxTinyFilter, cxMemberName} from '../dist/formats/kirikiri/cx-archive.js';
import {KirikiriCore} from '../dist/engines/kirikiri/core/kirikiri-core.js';
import {FileMedia, StorageSystem} from '../dist/engines/kirikiri/core/storage.js';
import {decodeTextStorage} from '../dist/engines/kirikiri/core/text-stream.js';
import {KIRIKIRI_CORE_REVISIONS} from '../dist/engines/kirikiri/revision.js';
import {NEKOPARA_VOL1_TPM} from '../dist/native/nekopara_vol1.tpm/library.js';
import {VariantSlot} from '../dist/engines/kirikiri/tjs2/runtime/slot.js';
import {TjsError} from '../dist/engines/kirikiri/tjs2/runtime/errors.js';
import * as V from '../dist/engines/kirikiri/tjs2/runtime/variant.js';
import {buildXp3, chunk, concat, u16, u32, utf16} from './kirikiri-xp3-fixtures.mjs';

/** An in-memory Windows installation; names compare case-insensitively. */
class MemoryFiles {
  constructor(entries) {
    this.files = new Map(Object.entries(entries).map(([k, v]) => [k.toLowerCase(), v]));
  }
  exists(local) {
    return this.files.has(local.toLowerCase());
  }
  list(dir) {
    const d = dir.toLowerCase();
    return [...this.files.keys()]
      .filter((k) => k.startsWith(d) && !k.slice(d.length).includes('\\'))
      .map((k) => k.slice(d.length));
  }
  async open(local) {
    const bytes = this.files.get(local.toLowerCase());
    return {size: bytes.length, read: async (o, n) => bytes.slice(o, o + n)};
  }
  write(local, data) {
    this.files.set(local.toLowerCase(), data);
  }
}

const bom16 = (s) => concat(Uint8Array.of(0xff, 0xfe), utf16(s));
const FILTER = {keyMask: 0x1548e29c, zeroKey: 0xd7};

/** A CxDec archive: members stored under MD5 names, encrypted, listed in eliF chunks. */
function cxArchive(members) {
  const files = [],
    names = [];
  for (const [name, plain] of Object.entries(members)) {
    const adler = adler32(plain),
      stored = plain.slice();
    applyCxTinyFilter(FILTER, adler, stored);
    files.push({
      name: cxMemberName(name),
      flags: XP3_FILE_PROTECTED,
      adler,
      segments: [{bytes: stored, compress: true}],
    });
    names.push(chunk('eliF', concat(u32(adler), u16(name.length), utf16(name), u16(0))));
  }
  return buildXp3(files, names);
}

const clock = {
  tickCount: () => 0,
  time: () => 0,
  localTime: () => ({hours: 1, minutes: 2, seconds: 3}),
};

function storage(files = new MemoryFiles({})) {
  const s = new StorageSystem(
    new FileMedia(files),
    () => {},
    () => 0,
  );
  s.setCurrentDirectory('c:\\game\\');
  return s;
}

test('storage names normalize like TVPNormalizeStorageName', () => {
  const s = storage();
  assert.equal(s.normalize('c:\\Game\\Data\\A.TJS'), 'file://./c/game/data/a.tjs');
  assert.equal(s.normalize('sub/x.png'), 'file://./c/game/sub/x.png');
  assert.equal(s.normalize('/c/other//y.txt'), 'file://./c/other/y.txt');
  assert.equal(s.normalize('a/b/../c'), 'file://./c/game/a/c');
  assert.equal(s.normalize('a/b/c/.../d'), 'file://./c/game/a/d', 'n dots climb n-1 levels');
  assert.equal(s.normalize('a/b/..'), 'file://./c/game/a/');
  assert.equal(
    s.normalize('data.xp3>Dir\\\\Sub/File.TXT'),
    'file://./c/game/data.xp3>dir/sub/file.txt',
  );
  assert.equal(s.normalize('FILE://./C/X'), 'file://./c/x');
  assert.equal(s.normalize('//server/share/f'), 'file://server/share/f');
  assert.throws(() => s.normalize('../../../x'), TjsError);
  assert.throws(() => s.normalize('http://x/y'), TjsError, 'unregistered media');
  assert.equal(s.getLocallyAccessibleName('file://./c/game/a.tjs'), 'c:\\game\\a.tjs');
});

test('auto paths find storages by name; the last path listing a name wins', () => {
  const files = new MemoryFiles({
    'c:\\game\\one\\a.txt': new Uint8Array(1),
    'c:\\game\\two\\a.txt': new Uint8Array(1),
    'c:\\game\\two\\b.txt': new Uint8Array(1),
  });
  const s = storage(files);
  assert.equal(s.getPlacedPath('a.txt'), '');
  s.addAutoPath('one/');
  s.addAutoPath('two/');
  assert.equal(s.getPlacedPath('a.txt'), 'file://./c/game/two/a.txt');
  assert.equal(s.getPlacedPath('B.TXT'), 'file://./c/game/two/b.txt');
  assert.throws(() => s.addAutoPath('one'), TjsError, 'a delimiter must end the path');
  s.removeAutoPath('two/');
  assert.equal(s.getPlacedPath('a.txt'), 'file://./c/game/one/a.txt');
});

test('text storages decode BOMs, cipher modes and compression', async () => {
  const opts = {encoding: 'UTF-8', decodeAnsi: () => 'ansi'};
  assert.equal(decodeTextStorage('x', bom16('abc\0def'), '', opts), 'abc');
  const mode1 = utf16('Hi').map((b, i, a) => b);
  const swapped = new Uint8Array(mode1.length);
  for (let i = 0; i < mode1.length; i += 2) {
    const ch = mode1[i] | (mode1[i + 1] << 8);
    const c = ((ch & 0xaaaa) >> 1) | ((ch & 0x5555) << 1);
    swapped[i] = c & 0xff;
    swapped[i + 1] = c >> 8;
  }
  assert.equal(
    decodeTextStorage('x', concat(Uint8Array.of(0xfe, 0xfe, 1, 0xff, 0xfe), swapped), '', opts),
    'Hi',
  );
  const raw = utf16('compressed'),
    packed = new Uint8Array(deflateSync(raw));
  const sizes = new DataView(new ArrayBuffer(16));
  sizes.setBigUint64(0, BigInt(packed.length), true);
  sizes.setBigUint64(8, BigInt(raw.length), true);
  const z = concat(Uint8Array.of(0xfe, 0xfe, 2, 0xff, 0xfe), new Uint8Array(sizes.buffer), packed);
  assert.equal(await decodeTextStorage('x', z, '', opts), 'compressed');
  assert.equal(
    decodeTextStorage('x', Uint8Array.of(0xef, 0xbb, 0xbf, 0xe3, 0x81, 0x82), '', opts),
    'あ',
  );
  assert.equal(decodeTextStorage('x', new TextEncoder().encode('plain'), '', opts), 'plain');
  assert.equal(
    decodeTextStorage('x', Uint8Array.of(0x82, 0xa0), '', {...opts, encoding: 'Shift_JIS'}),
    'ansi',
  );
  assert.equal(
    decodeTextStorage('x', concat(Uint8Array.of(1, 2, 3), bom16('off')), 'o3', opts),
    'off',
  );
  assert.throws(() => decodeTextStorage('x', Uint8Array.of(0xc0, 0x80), '', opts), TjsError);
});

async function bootGame(extraFiles = {}) {
  const tpmBytes = new TextEncoder().encode('stand-in for nekopara_vol1.tpm');
  const tpmHash = Array.from(await sha256(tpmBytes), (b) => b.toString(16).padStart(2, '0')).join(
    '',
  );
  const files = new MemoryFiles({
    'c:\\game\\game.exe': new Uint8Array(0),
    'c:\\game\\plugin\\nekopara_vol1.tpm': tpmBytes,
    'c:\\game\\data.xp3': cxArchive({
      'startup.tjs': bom16('Scripts.execStorage("system/Initialize.tjs");'),
      'system/Initialize.tjs': bom16('// init'),
    }),
    'c:\\game\\voice.xp3': cxArchive({'ch/v001.ogg': new Uint8Array([1, 2, 3])}),
    ...extraFiles,
  });
  const log = [];
  const core = await KirikiriCore.create({
    revision: [...KIRIKIRI_CORE_REVISIONS.values()][0],
    executablePath: 'c:\\game\\game.exe',
    uiLanguage: 0x0409,
    files,
    libraries: [{...NEKOPARA_VOL1_TPM, identities: [{kind: 'image', sha256: tpmHash}]}],
    clock,
    output: (line) => log.push(line),
  });
  const blocks = [];
  core.engine.executor = {
    runByteCode: () => false,
    run(block, result) {
      blocks.push(block);
      return 0;
    },
  };
  return {core, files, log, blocks};
}

test('start-up links the tpm and runs startup.tjs from archive://data.xp3/', async () => {
  const {core, log, blocks} = await bootGame();
  await core.start();
  assert.equal(core.projectDir, 'file://./c/game/data.xp3>');
  assert.deepEqual(core.plugins.names, ['c:\\game\\plugin\\nekopara_vol1.tpm']);
  assert.equal(core.storage.normalize('x.tjs'), 'archive://data.xp3/x.tjs');
  assert.equal(core.getCommandLine('-debugwin'), '', 'the tpm clears -debugwin');
  assert.deepEqual(
    blocks.map((b) => [b.name, b.mode, b.text]),
    [['startup.tjs', 'statements', 'Scripts.execStorage("system/Initialize.tjs");']],
  );
  assert.ok(log.some((l) => l.endsWith('(info) Loading nekopara_vol1.tpm')));
  core.shutdown();
});

test('Scripts, Storages and the tpm hooks work through TJS objects', async () => {
  const {core, blocks} = await bootGame();
  await core.start();
  const global = core.engine.global;
  const member = (o, name) => {
    const r = new VariantSlot();
    assert.ok(o.propGet(0, name, r, o) >= 0, name);
    return r.take();
  };
  const call = async (o, name, args) => {
    const r = new VariantSlot();
    const code = await core.engine.suspender.run(() => o.funcCall(0, name, r, args, o));
    assert.ok(code >= 0, `${name} → ${code}`);
    return r.take();
  };
  const Storages = member(global, 'Storages').object;
  const Scripts = member(global, 'Scripts').object;
  // The tpm's hook rewrites an archive beside the executable to the archive medium.
  await call(Storages, 'addAutoPath', [V.str('file://./c/game/voice.xp3>ch/')]);
  assert.deepEqual(
    await call(Storages, 'getPlacedPath', [V.str('V001.ogg')]),
    V.str('archive://voice.xp3/ch/v001.ogg'),
  );
  assert.deepEqual(await call(Storages, 'isExistentStorage', [V.str('nothing.ogg')]), V.int(0));
  assert.deepEqual(await call(Storages, 'extractStorageExt', [V.str('a/b.c.TJS')]), V.str('.TJS'));
  await call(Scripts, 'execStorage', [V.str('system/Initialize.tjs')]);
  assert.equal(blocks.at(-1).name, 'initialize.tjs', 'the placed, normalized name');
  assert.equal(blocks.at(-1).text, '// init');
  await call(Scripts, 'eval', [V.str('1+1'), V.str('expr'), V.int(3)]);
  assert.deepEqual(
    [blocks.at(-1).mode, blocks.at(-1).name, blocks.at(-1).lineOffset],
    ['expression', 'expr', 3],
  );
  const Plugins = member(global, 'Plugins').object;
  const list = await call(Plugins, 'getList', []);
  assert.deepEqual(
    await call(list.object, 'join', [V.str(',')]),
    V.str('c:\\game\\plugin\\nekopara_vol1.tpm'),
  );
  core.shutdown();
});

test('saveStruct writes UTF-16 text that reads back', async () => {
  const {core, files} = await bootGame();
  await core.start();
  const arr = core.engine.createArray();
  arr.funcCall(0, 'push', null, [V.str('a"b'), V.int(2)], arr);
  const r = new VariantSlot();
  assert.equal(
    arr.funcCall(0, 'saveStruct', r, [V.str('file://./c/game/save.txt'), V.str('c')], arr),
    0,
  );
  const saved = files.files.get('c:\\game\\save.txt');
  assert.deepEqual([...saved.slice(0, 5)], [0xfe, 0xfe, 1, 0xff, 0xfe]);
  const text = await core.readText('file://./c/game/save.txt', '');
  assert.equal(text, '(const) [\r\n "a\\"b",\r\n 2\r\n]');
  core.shutdown();
});

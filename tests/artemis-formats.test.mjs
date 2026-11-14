import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {PfsArchive} from '../dist/formats/artemis/pfs.js';
import {parseAsb} from '../dist/formats/artemis/asb.js';
import {ArtemisFiles} from '../dist/engines/artemis/files.js';

const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const str = (s) => {
  const b = Buffer.from(s);
  return Buffer.concat([u32(b.length), b, Buffer.alloc(1)]);
};
const memory = (bytes) => ({
  size: bytes.length,
  read: async (offset, size) => bytes.subarray(offset, offset + size),
});

function pfs(files, trailer = Buffer.from('offset-table')) {
  const indexSize =
    4 + files.reduce((n, [name]) => n + 16 + Buffer.byteLength(name), 0) + trailer.length;
  let offset = 7 + indexSize;
  const rows = files.map(([name, body]) => {
    const b = Buffer.from(name),
      row = Buffer.concat([u32(b.length), b, u32(0), u32(offset), u32(body.length)]);
    offset += body.length;
    return row;
  });
  const index = Buffer.concat([u32(files.length), ...rows, trailer]);
  const key = createHash('sha1').update(index).digest();
  const bodies = files.map(([, body]) => Buffer.from(body.map((b, i) => b ^ key[i % 20])));
  return new Uint8Array(Buffer.concat([Buffer.from('pf8'), u32(index.length), index, ...bodies]));
}

test('PF8 lazily decrypts Unicode entries and partial reads without mutating borrowed ciphertext', async () => {
  const body = Uint8Array.from({length: 70}, (_, i) => i * 3);
  const bytes = pfs([['script\\雪.ast', body]]),
    original = bytes.slice(),
    reads = [];
  const source = memory(bytes);
  const archive = await PfsArchive.open({
    size: source.size,
    read: async (o, n) => {
      reads.push([o, n]);
      return source.read(o, n);
    },
  });
  const entry = archive.find('script/雪.ast');
  assert.equal(reads.length, 2);
  assert.equal(archive.find('SCRIPT/雪.ast'), undefined);
  const slice = archive.entrySource(entry);
  assert.deepEqual(await slice.read(19, 31), body.slice(19, 50));
  assert.deepEqual(await archive.read(entry), body);
  assert.deepEqual(bytes, original);
  await assert.rejects(slice.read(70, 1), /Invalid range/);
  assert.throws(() => archive.entrySource({...entry}), /Foreign/);
});

test('PF8 refuses unsupported versions, impossible counts, short reads and out-of-bounds payloads', async () => {
  const bytes = pfs([['a', Buffer.from('123')]]);
  const version = bytes.slice();
  version[2] = 55;
  await assert.rejects(PfsArchive.open(memory(version)), /Unsupported PFS/);
  const count = bytes.slice();
  new DataView(count.buffer).setUint32(7, 0xffffffff, true);
  await assert.rejects(PfsArchive.open(memory(count)), /entry count/);
  await assert.rejects(PfsArchive.open(memory(bytes.slice(0, -1))), /Invalid range/);
  await assert.rejects(
    PfsArchive.open({size: bytes.length, read: async () => new Uint8Array()}),
    /Truncated/,
  );
});

test('Artemis overlays continue across numeric gaps, retain the winning key and prefer empty loose files', async () => {
  const base = pfs([
    ['system/auth.lua', Buffer.from('base')],
    ['script/雪.ast', Buffer.from('old')],
  ]);
  const early = pfs([['script/雪.ast', Buffer.from('early')]]);
  const late = pfs([['script/雪.ast', Buffer.from('late')]], Buffer.from('different index key'));
  const installed = new Map([
    ['game.pfs', memory(base)],
    ['game.pfs.000', memory(early)],
    ['game.pfs.012', memory(late)],
    ['system/auth.lua', memory(Buffer.alloc(0))],
  ]);
  const files = await ArtemisFiles.mount('game.pfs', (parts) => installed.get(parts.join('/')));
  assert.deepEqual(
    files.archives.map((a) => a.name),
    ['game.pfs', 'game.pfs.000', 'game.pfs.012'],
  );
  assert.equal(Buffer.from(await files.read('script\\雪.ast')).toString(), 'late');
  assert.equal((await files.read('system/auth.lua')).byteLength, 0);
  assert.equal(await files.read('absent'), null);
  // An empty name fails like the native loose open, so lyc can fall back to color.
  assert.equal(await files.read(''), null);
  await assert.rejects(files.open('../outside'), /Unsupported/);
  await assert.rejects(files.open(':bg/file'), /Unsupported/);
});

function asb(records) {
  return new Uint8Array(
    Buffer.concat([Buffer.from([65, 83, 66, 17, 0]), u32(records.length), ...records]),
  );
}
const label = (name) => Buffer.concat([u32(1), str(name)]);
const tag = (name, line, args = []) =>
  Buffer.concat([
    u32(0),
    str(name),
    u32(line),
    u32(args.length),
    ...args.flatMap(([k, v]) => [str(k), str(v)]),
  ]);

test('ASB preserves tag arguments/source lines and labels point into the tag sequence', () => {
  const bytes = asb([
    label('top'),
    tag('print', 42, [
      ['data', '雪'],
      ['__proto__', 'literal'],
      ['data', '花'],
    ]),
    label('last'),
    tag('return', 44),
  ]);
  const program = parseAsb(bytes);
  assert.equal(program.reservedByte, 17);
  assert.equal(program.records.length, 4);
  assert.deepEqual(
    [...program.labels],
    [
      ['top', 0],
      ['last', 1],
    ],
  );
  assert.deepEqual(
    program.tags.map((t) => [t.name, t.sourceLine]),
    [
      ['print', 42],
      ['return', 44],
    ],
  );
  assert.equal(program.tags[0].args.get('data'), '花');
  assert.equal(program.tags[0].args.get('__proto__'), 'literal');
});

test('ASB refuses malformed records/strings and trailing bytes instead of returning a partial program', () => {
  const bytes = asb([tag('return', 1)]);
  assert.throws(() => parseAsb(bytes.slice(0, -1)), /Invalid range/);
  assert.throws(() => parseAsb(Buffer.concat([bytes, Buffer.alloc(1)])), /Trailing/);
  const version = bytes.slice();
  version[4] = 1;
  assert.throws(() => parseAsb(version), /Unsupported ASB/);
  assert.throws(() => parseAsb(asb([Buffer.concat([u32(2), str('invalid')])])), /record kind/);
  const badString = asb([label('x')]);
  badString[badString.length - 1] = 1;
  assert.throws(() => parseAsb(badString), /terminator/);
});

test('Magic paths substitute one native alias and preserve overlay/empty loose precedence', async () => {
  const archive = pfs([
    ['system/auth.lua', Buffer.from('archive')],
    ['script/雪.ast', Buffer.from('base')],
  ]);
  const overlay = pfs([['script/雪.ast', Buffer.from('overlay')]]);
  const sources = new Map([
    ['game.pfs', memory(archive)],
    ['game.pfs.012', memory(overlay)],
    ['system/auth.lua', memory(new Uint8Array())],
  ]);
  const files = await ArtemisFiles.mount('game.pfs', (parts) => sources.get(parts.join('/')));
  files.setMagicPath('sys', 'system');
  assert.equal((await files.read(':sys/auth.lua')).length, 0);
  files.setMagicPath('脚本', 'script');
  assert.equal(Buffer.from(await files.read(':脚本\\雪.ast')).toString(), 'overlay');
  assert.equal(files.resolvePath(':sys'), 'system');
  assert.equal(await files.open(':sys/'), null);
  assert.throws(() => files.resolvePath(':SYS/auth.lua'), /Unsupported Artemis magic/);
  files.setMagicPath('sys', 'script');
  assert.equal(Buffer.from(await files.read(':sys/雪.ast')).toString(), 'overlay');
  files.setMagicPath('sys', '');
  assert.throws(() => files.resolvePath(':sys/a'), /Unsupported Artemis magic/);
  assert.throws(() => files.setMagicPath('x', '../outside'), /Unsupported/);
  assert.throws(() => files.setMagicPath('x', ':脚本'), /Unsupported/);
});

test('Artemis read-ahead serves the next block files from memory and keeps loose files first', async () => {
  const archive = memory(
    pfs([
      ['image/fg/no/a_base.png', Buffer.from('normal')],
      ['image/fg/bu/a_base.png', Buffer.from('bust')],
      ['image/face/a_face.png', Buffer.from('face')],
      ['sound/vo/11/z1.ogg', Buffer.from('voice')],
      ['system/loose.png', Buffer.from('archive')],
    ]),
  );
  let reads = 0;
  const counted = {size: archive.size, read: (...args) => (reads++, archive.read(...args))};
  const installed = new Map([
    ['game.pfs', counted],
    ['system/loose.png', memory(Buffer.from('loose'))],
  ]);
  const files = await ArtemisFiles.mount('game.pfs', (parts) => installed.get(parts.join('/')));
  files.setMagicPath('fg', 'image/fg');
  files.setMagicPath('vo', 'sound/vo');
  files.setMagicPath('sys', 'system');
  files.readAhead([
    {directory: ':fg/no/', name: 'a_base'},
    {directory: ':fg/no/', name: 'a_face'},
    {directory: ':vo/', name: '11/z1'},
    {directory: ':sys/', name: 'loose'},
    {name: 'missing'},
  ]);
  for (let i = 0; i < 20; i++) await new Promise(setImmediate);
  const before = reads;
  assert.equal(before > 0, true);
  const text = async (path) => Buffer.from(await files.read(path)).toString();
  assert.equal(await text(':fg/no/a_base.png'), 'normal');
  assert.equal(await text('image/face/a_face.png'), 'face');
  assert.equal(await text(':vo/11/z1.ogg'), 'voice');
  assert.equal(reads, before);
  // Only the directory's own match was read; the bust image comes from the archive.
  assert.equal(await text(':fg/bu/a_base.png'), 'bust');
  assert.equal(reads, before + 1);
  assert.equal(await text(':sys/loose.png'), 'loose');
  // Every read of a read-ahead file returns new bytes.
  const source = await files.open(':vo/11/z1.ogg');
  const first = await source.read(0, 5);
  first.fill(0);
  assert.equal(Buffer.from(await source.read(0, 5)).toString(), 'voice');
});

test('Artemis scenario jumps name the files their target shows first', async () => {
  const {artemisJumpNames} = await import('../dist/engines/artemis/read-ahead.js');
  const source = Buffer.from(`astver = 2.0
astname = "ast"
ast = {
block_00000={
{"bg",file="early",path=":bg/"},
{"text"},
text={ja={{"x"}}},
linknext="block_00001",
},
block_00001={
{"bg",file="scene",time=500,path=":bg/"},
{"fg",path=":fg/no/",ch="a",file="a_base",face="a_face",mode=3},
{"bgm",file="bgm07"},
linknext="block_00002",
},
block_00002={
{"text"},
text={vo={{"vo",ch="a",file="11/z1"}},ja={{"x"}}},
linknext="block_00003",
},
block_00003={
{"bg",file="later",path=":bg/"},
},
block_00004={
{"msgoff"},
{"excall",file="next",label="top",call=1},
{"exreturn"},
},
label={top={block="block_00000",label=1},scene={block="block_00001",label=1},flow={block="block_00004",label=1}},
}`);
  const names = [];
  assert.deepEqual(artemisJumpNames(source, 's.ast', {file: 's', label: 'scene'}, names), []);
  assert.deepEqual(names.map((n) => `${n.directory ?? ''}${n.name}`).sort(), [
    ':bg/scene',
    ':fg/no/a',
    ':fg/no/a_base',
    ':fg/no/a_face',
    ':vo/11/z1',
    'bgm07',
  ]);
  // The game's sound tables translate tag names into the files they play.
  const mapped = [];
  artemisJumpNames(source, 's.ast', {file: 's', label: 'scene'}, mapped, (tag, name) =>
    tag === 'bgm' ? {directory: ':bgm/', name: `${name}_file`} : undefined,
  );
  assert.deepEqual(
    mapped.filter((n) => n.directory === ':bgm/'),
    [{directory: ':bgm/', name: 'bgm07_file'}],
  );
  // A return resumes after the tag that called; a flow script's next call is returned.
  const flow = [];
  assert.deepEqual(
    artemisJumpNames(source, 's.ast', {file: 's', block: 'block_00004', count: 1}, flow),
    [{file: 'next', label: 'top'}],
  );
  assert.deepEqual(flow, []);
  // Without the label the scenario starts at `top`.
  const top = [];
  artemisJumpNames(source, 's.ast', {file: 's', label: 'missing'}, top);
  assert.deepEqual(
    top.map((n) => n.name),
    ['early'],
  );
});

test('Artemis PSD merged raw and RLE planes preserve stage white-matte recovery and transparent RGB', async () => {
  const {psd} = await import('./artemis-image-fixtures.mjs');
  const {decodeArtemisPsd} = await import('../dist/formats/artemis/psd.js');
  const planes = [
      [255, 17, 12],
      [191, 33, 34],
      [127, 49, 56],
      [128, 0, 255],
    ],
    expected = [255, 127, 0, 128, 17, 33, 49, 0, 12, 34, 56, 255];
  for (const compression of [0, 1]) {
    const bytes = psd({
        width: 3,
        height: 1,
        planes,
        compression,
        sections: [
          [1, 2],
          [3, 4, 5],
          [6, 7],
        ],
      }),
      snapshot = bytes.slice();
    const image = decodeArtemisPsd(bytes);
    assert.deepEqual([image.width, image.height], [3, 1]);
    assert.deepEqual([...image.pixels], expected);
    assert.deepEqual(bytes, snapshot);
  }
  const rgb = decodeArtemisPsd(psd({width: 1, height: 1, planes: [[1], [2], [3]]}));
  assert.deepEqual([...rgb.pixels], [1, 2, 3, 255]);
  const zeroAlpha = decodeArtemisPsd(
    psd({
      width: 2,
      height: 1,
      planes: [
        [1, 4],
        [2, 5],
        [3, 6],
        [0, 0],
      ],
    }),
  );
  assert.deepEqual([...zeroAlpha.pixels], [1, 2, 3, 255, 4, 5, 6, 255]);
});

test('Artemis PSD RLE follows native repeat129 header and channel-major row ordering', async () => {
  const {psd} = await import('./artemis-image-fixtures.mjs');
  const {decodeArtemisPsd} = await import('../dist/formats/artemis/psd.js');
  const image = decodeArtemisPsd(
    psd({
      width: 129,
      height: 2,
      planes: [[], [], []],
      compression: 1,
      rows: [
        [128, 10],
        [128, 20],
        [128, 30],
        [128, 40],
        [128, 50],
        [128, 60],
      ],
    }),
  );
  assert.deepEqual([...image.pixels.slice(0, 4)], [10, 30, 50, 255]);
  assert.deepEqual([...image.pixels.slice(129 * 4, 129 * 4 + 4)], [20, 40, 60, 255]);
  assert.deepEqual([...image.pixels.slice(-4)], [20, 40, 60, 255]);
});

test('Artemis PSD refuses unsupported layouts and incomplete rows before publishing partial images', async () => {
  const {psd} = await import('./artemis-image-fixtures.mjs');
  const {decodeArtemisPsd} = await import('../dist/formats/artemis/psd.js');
  const valid = psd({
    width: 2,
    height: 1,
    planes: [
      [1, 2],
      [3, 4],
      [5, 6],
    ],
  });
  for (const [offset, value, method] of [
    [4, 2, 'writeUInt16BE'],
    [12, 5, 'writeUInt16BE'],
    [22, 16, 'writeUInt16BE'],
    [24, 1, 'writeUInt16BE'],
    [18, 0xffffffff, 'writeUInt32BE'],
  ]) {
    const bytes = Buffer.from(valid);
    bytes[method](value, offset);
    assert.throws(() => decodeArtemisPsd(bytes), /Unsupported/);
  }
  assert.throws(() => decodeArtemisPsd(valid.slice(0, -1)), /Invalid range/);
  for (const row of [[0, 1], [1, 1], [255], [254, 1]])
    assert.throws(
      () =>
        decodeArtemisPsd(
          psd({width: 2, height: 1, planes: [[], [], []], compression: 1, rows: [row, row, row]}),
        ),
      /row|Truncated/,
    );
});

test('Shared JPEG metadata reader preserves entropy/restart bytes and removes EXIF/ICC between scans', async () => {
  const {readJpegHeader} = await import('../dist/formats/jpeg/header.js');
  const segment = (marker, payload) =>
    Buffer.concat([
      Buffer.from([255, marker, (payload.length + 2) >>> 8, (payload.length + 2) & 255]),
      Buffer.from(payload),
    ]);
  const frame = segment(192, [8, 0, 3, 0, 2, 3, 1, 17, 0, 2, 17, 0, 3, 17, 0]),
    scan = segment(218, [3, 1, 0, 2, 0, 3, 0, 0, 63, 0]),
    entropy = Buffer.from([17, 255, 0, 225, 255, 208, 34]),
    plain = Buffer.concat([
      Buffer.from([255, 216]),
      frame,
      scan,
      entropy,
      scan,
      Buffer.from([51, 255, 217, 91]),
    ]),
    encoded = Buffer.concat([
      Buffer.from([255, 216]),
      segment(225, [69, 120, 105, 102, 0, 0]),
      frame,
      scan,
      entropy,
      segment(226, [73, 67, 67]),
      scan,
      Buffer.from([51, 255, 217, 91]),
    ]),
    container = new Uint8Array(encoded.length + 4);
  container.set(encoded, 2);
  const view = container.subarray(2, -2),
    snapshot = view.slice();
  const unchanged = readJpegHeader(view);
  assert.equal(unchanged.bytes, view);
  assert.deepEqual(
    [unchanged.width, unchanged.height, unchanged.components, unchanged.precision],
    [2, 3, 3, 8],
  );
  const stripped = readJpegHeader(view, true);
  assert.deepEqual([...stripped.bytes], [...plain]);
  assert.deepEqual(view, snapshot);
  assert.throws(
    () => readJpegHeader(new Uint8Array([255, 216, 255, 225, 0, 8, 1])),
    /segment length/,
  );
  assert.throws(() => readJpegHeader(new Uint8Array([255, 216, 255, 217])), /header missing/);
});

test('Plain CFile reads bypass archive overlays and pack magic aliases', async () => {
  const installed = new Map([
    ['game.pfs', memory(pfs([['system/module.lua', Buffer.from('archive')]]))],
    ['system/empty.lua', memory(Buffer.alloc(0))],
    ['system/plain.lua', memory(Buffer.from('plain'))],
  ]);
  const files = await ArtemisFiles.mount('game.pfs', (parts) => installed.get(parts.join('/')));
  files.setMagicPath('system', 'system');
  assert.equal(await files.readPlain('system/module.lua'), null);
  assert.equal(Buffer.from(await files.read('system/module.lua')).toString(), 'archive');
  assert.equal((await files.readPlain('system/empty.lua')).length, 0);
  assert.equal(Buffer.from(await files.readPlain('system\\plain.lua')).toString(), 'plain');
  await assert.rejects(files.readPlain(':system/plain.lua'), /Unsupported/);
  assert.equal(Buffer.from(await files.read(':system/plain.lua')).toString(), 'plain');
});

test('Rendered font files index fixed code ranges per version', async () => {
  const {artemisRftEntry, artemisRftSettingsEntry, artemisRftVersion} =
    await import('../dist/formats/artemis/rft.js');
  const {rft} = await import('./artemis-rft-fixtures.mjs');
  const glyph = Buffer.from([1, 2, 3]);
  const unicode = rft({ini: 'x', entries: new Map([[0x3042, glyph]])});
  assert.equal(artemisRftVersion(unicode), 3);
  assert.equal(unicode.length - 4, 63455 * 8 + 1 + 3);
  assert.deepEqual(artemisRftSettingsEntry(unicode), artemisRftEntry(unicode, 0, true));
  const at = artemisRftEntry(unicode, 0x3042, true);
  assert.deepEqual([...unicode.subarray(at.offset, at.offset + at.size)], [1, 2, 3]);
  assert.deepEqual(artemisRftEntry(unicode, 0x41, true), {offset: 0, size: 0});
  // Space, the C1 gap, surrogates and codes above the BMP are outside the Unicode ranges.
  for (const code of [0x20, 0x7f, 0xd800, 0x10000])
    assert.equal(artemisRftEntry(unicode, code, true), undefined);
  // A non-UTF-8 CHARSET indexes the same file by the Shift-JIS ranges after code 0.
  const shiftJis = rft({ini: 'x', unicodeRanges: false, entries: new Map([[0x82a0, glyph]])});
  assert.equal(artemisRftEntry(shiftJis, 0x82a0, false).size, 3);
  assert.equal(artemisRftEntry(shiftJis, 0x80, false), undefined);
  // rft0 starts its third range at 8141; rft1 and rft2 at 8140; neither indexes code 0.
  const old = rft({version: 0, entries: new Map([[0x8141, glyph]])});
  assert.equal(artemisRftEntry(old, 0x8141, false).size, 3);
  assert.equal(artemisRftEntry(old, 0x8140, false), undefined);
  assert.equal(artemisRftEntry(old, 0, false), undefined);
  const one = rft({version: 1, entries: new Map([[0x8140, glyph]])});
  assert.equal(artemisRftEntry(one, 0x8140, false).size, 3);
  assert.equal(artemisRftVersion(new Uint8Array([0x72, 0x66, 0x74, 0x34])), undefined);
  assert.throws(() => artemisRftEntry(new Uint8Array(4), 0x41, false), /magic/);
  const truncated = unicode.slice(0, 100);
  assert.throws(() => artemisRftEntry(truncated, 0x3042, true), /index exceeds/);
});

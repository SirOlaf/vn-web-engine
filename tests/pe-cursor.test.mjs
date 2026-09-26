import test from 'node:test';
import assert from 'node:assert/strict';
import {deflateSync} from 'node:zlib';
import {PeCursorReader} from '../dist/formats/pe/cursor.js';
import {parsePeResources} from '../dist/formats/pe/resources.js';

function dib({width = 32, height = 32, depth = 24, x = 9, y = 2, core = false} = {}) {
  const header = core ? 12 : 40,
    colors = depth <= 8 ? 1 << depth : 0;
  const b = Buffer.alloc(
    4 +
      header +
      colors * (core ? 3 : 4) +
      (Math.ceil((width * depth) / 32) * 4 + Math.ceil(width / 32) * 4) * height,
  );
  b.writeUInt16LE(x, 0);
  b.writeUInt16LE(y, 2);
  b.writeUInt32LE(header, 4);
  if (core) {
    b.writeUInt16LE(width, 8);
    b.writeUInt16LE(height * 2, 10);
    b.writeUInt16LE(1, 12);
    b.writeUInt16LE(depth, 14);
  } else {
    b.writeInt32LE(width, 8);
    b.writeInt32LE(height * 2, 12);
    b.writeUInt16LE(1, 16);
    b.writeUInt16LE(depth, 18);
    b.writeUInt32LE(b.length - 44 - colors * 4, 24);
  }
  b.fill(0x5a, 4 + header + colors * (core ? 3 : 4));
  return b;
}
function group(images) {
  const b = Buffer.alloc(6 + images.length * 14);
  b.writeUInt16LE(2, 2);
  b.writeUInt16LE(images.length, 4);
  images.forEach(({id = 1, bytes, width = 32, height = 32, depth = 24, png = false}, i) => {
    const p = 6 + i * 14;
    b.writeUInt16LE(width, p);
    b.writeUInt16LE(height * (png ? 1 : 2), p + 2);
    b.writeUInt16LE(1, p + 4);
    b.writeUInt16LE(depth, p + 6);
    b.writeUInt32LE(bytes.length, p + 8);
    b.writeUInt16LE(id, p + 12);
  });
  return b;
}
function fixture(entries, {plus = true} = {}) {
  const scratch = Buffer.alloc(1024 * 1024),
    root = 0x200,
    rva = 0x1000,
    leaves = [],
    directories = [];
  let end = 0;
  const alloc = (size) => {
    const p = end;
    end = (end + size + 3) & ~3;
    return p;
  };
  function tree(items, level) {
    const field = ['type', 'id', 'language'][level],
      groups = new Map();
    for (const item of items) {
      const key = item[field];
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    const keys = [...groups.keys()].sort((a, b) =>
      typeof a === typeof b ? (a < b ? -1 : 1) : typeof a === 'string' ? -1 : 1,
    );
    const p = alloc(16 + keys.length * 8);
    directories.push(root + p);
    scratch.writeUInt16LE(keys.filter((k) => typeof k === 'string').length, root + p + 12);
    scratch.writeUInt16LE(keys.filter((k) => typeof k === 'number').length, root + p + 14);
    keys.forEach((key, i) => {
      const entry = root + p + 16 + i * 8;
      if (typeof key === 'string') {
        const text = Buffer.from(key, 'utf16le'),
          name = alloc(2 + text.length);
        scratch.writeUInt16LE(text.length / 2, root + name);
        text.copy(scratch, root + name + 2);
        scratch.writeUInt32LE((name | 0x80000000) >>> 0, entry);
      } else scratch.writeUInt32LE(key, entry);
      if (level < 2)
        scratch.writeUInt32LE((tree(groups.get(key), level + 1) | 0x80000000) >>> 0, entry + 4);
      else {
        assert.equal(groups.get(key).length, 1);
        const item = groups.get(key)[0],
          data = alloc(16),
          payload = alloc(item.bytes.length);
        scratch.writeUInt32LE(data, entry + 4);
        scratch.writeUInt32LE(rva + payload, root + data);
        scratch.writeUInt32LE(item.bytes.length, root + data + 4);
        item.bytes.copy(scratch, root + payload);
        leaves.push({...item, entry, data: root + data, payload: root + payload});
      }
    });
    return p;
  }
  tree(entries, 0);
  const optional = 0x98,
    optionalSize = plus ? 240 : 224,
    directory = optional + (plus ? 112 : 96),
    section = optional + optionalSize;
  scratch.write('MZ');
  scratch.writeUInt32LE(0x80, 60);
  scratch.write('PE\0\0', 0x80);
  scratch.writeUInt16LE(1, 0x86);
  scratch.writeUInt16LE(optionalSize, 0x94);
  scratch.writeUInt16LE(plus ? 0x20b : 0x10b, optional);
  scratch.writeUInt32LE(root, optional + 60);
  scratch.writeUInt32LE(16, directory - 4);
  scratch.writeUInt32LE(rva, directory + 16);
  scratch.writeUInt32LE(end, directory + 20);
  scratch.write('.rsrc', section);
  scratch.writeUInt32LE(end + 0x1000, section + 8);
  scratch.writeUInt32LE(rva, section + 12);
  scratch.writeUInt32LE(end, section + 16);
  scratch.writeUInt32LE(root, section + 20);
  return {
    bytes: Buffer.from(scratch.subarray(0, root + end)),
    leaves,
    directories,
    directory,
    section,
  };
}
function simple(options = {}, peOptions) {
  const bytes = dib(options),
    metadata = {bytes, ...options};
  return fixture(
    [
      {type: 1, id: 1, language: 1041, bytes},
      {type: 12, id: 108, language: 1041, bytes: group([metadata])},
    ],
    peOptions,
  );
}

test('selected PE resources remain readable beside packed resource payloads', () => {
  const image = fixture([
    {type: 1, id: 1, language: 1041, bytes: dib()},
    {type: 16, id: 1, language: 1041, bytes: Buffer.from('version resource')},
  ]);
  // A packer leaves the directory and version data backed, but moves the cursor
  // payload into the section's virtual-only tail.
  image.bytes.writeUInt32LE(image.bytes.length + 0x1000, image.directory + 20);
  image.bytes.writeUInt32LE(0x700000, image.leaves[0].data);
  assert.throws(() => parsePeResources(image.bytes), /Unmapped or ambiguous/);
  const versions = parsePeResources(image.bytes, [16]);
  assert.equal(versions.length, 1);
  assert.equal(Buffer.from(versions[0].bytes).toString(), 'version resource');
  assert.throws(() => new PeCursorReader(image.bytes), /Unmapped or ambiguous/);
});
function chunk(type, data) {
  const b = Buffer.alloc(data.length + 12);
  b.writeUInt32BE(data.length);
  b.write(type, 4);
  data.copy(b, 8);
  let crc = 0xffffffff;
  for (const value of b.subarray(4, -4)) {
    crc ^= value;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  b.writeUInt32BE((crc ^ 0xffffffff) >>> 0, b.length - 4);
  return b;
}
function pngImage() {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(16);
  header.writeUInt32BE(16, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([3, 0, 4, 0, 137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc(16 * 65))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const plus of [false, true])
  test(`PE${plus ? '32+' : '32'} extraction relocates hotspots and preserves complete DIB/mask`, () => {
    const {bytes} = simple({}, {plus}),
      padded = Buffer.concat([Buffer.alloc(7), bytes, Buffer.alloc(9)]);
    const reader = new PeCursorReader(padded.subarray(7, 7 + bytes.length));
    assert.deepEqual(reader.list(), [{kind: 'static', id: 108, language: 1041}]);
    const cursor = reader.read(108),
      b = Buffer.from(cursor.bytes);
    assert.equal(cursor.kind, 'static');
    assert.equal(b.length, 3262);
    assert.deepEqual(cursor.images, [
      {
        resourceId: 1,
        language: 1041,
        width: 32,
        height: 32,
        hotspotX: 9,
        hotspotY: 2,
        bitDepth: 24,
        encoding: 'dib',
      },
    ]);
    assert.deepEqual([...b.subarray(0, 12)], [0, 0, 2, 0, 1, 0, 32, 32, 0, 0, 9, 0]);
    assert.equal(b.readUInt16LE(12), 2);
    assert.equal(b.readUInt32LE(14), 3240);
    assert.equal(b.readUInt32LE(18), 22);
    assert.deepEqual(b.subarray(22), dib().subarray(4));
    cursor.bytes.fill(0);
    assert.equal(reader.read(108).bytes[2], 2);
    assert.equal(reader.read(999), undefined);
  });

test('multi-image CUR supports indexed/core DIBs, row padding, and 256 dimension encoding', () => {
  const metadata = [
    {id: 1, width: 17, height: 9, depth: 1, core: true},
    {id: 2, width: 256, height: 256, depth: 32},
    {id: 3, width: 23, height: 11, depth: 4},
    {id: 4, width: 32, height: 32, depth: 8},
    {id: 5, width: 32, height: 32, depth: 16},
  ].map((m) => ({...m, bytes: dib(m)}));
  const entries = metadata.map((m) => ({type: 1, id: m.id, language: 0, bytes: m.bytes}));
  entries.push({type: 12, id: 'pointer', language: 0, bytes: group(metadata)});
  const cursor = new PeCursorReader(fixture(entries).bytes).read('pointer'),
    b = Buffer.from(cursor.bytes);
  assert.equal(b.readUInt16LE(4), 5);
  assert.equal(b[22], 0);
  assert.equal(b[23], 0);
  let offset = 86;
  metadata.forEach((m, i) => {
    assert.equal(b.readUInt32LE(18 + i * 16), offset);
    assert.deepEqual(b.subarray(offset, offset + m.bytes.length - 4), m.bytes.subarray(4));
    offset += m.bytes.length - 4;
  });
  assert.equal(offset, b.length);
});

test('language selection is deterministic and never links an unrelated image language', () => {
  const image = dib(),
    g = group([{bytes: image}]);
  const entries = [1041, 1033].map((language) => ({type: 12, id: 108, language, bytes: g}));
  entries.push({type: 1, id: 1, language: 0, bytes: image});
  let reader = new PeCursorReader(fixture(entries).bytes);
  assert.equal(reader.read(108).language, 1033);
  assert.equal(reader.read(108, 1041).images[0].language, 0);
  assert.throws(() => reader.read(108, 1031), /language unavailable/);
  for (const language of [-1, 65536, 1.5, NaN])
    assert.throws(() => reader.read(108, language), /Invalid cursor language/);
  entries.push({type: 12, id: 108, language: 0, bytes: g});
  reader = new PeCursorReader(fixture(entries).bytes);
  assert.equal(reader.read(108).language, 0);
  assert.equal(reader.read(108, 1031).language, 0);
  entries[2].language = 1033;
  assert.throws(
    () => new PeCursorReader(fixture(entries).bytes).read(108, 1041),
    /Missing RT_CURSOR/,
  );
});

test('PNG payloads produce complete CUR files and reject corrupt PNG envelopes', () => {
  const image = pngImage(),
    metadata = {id: 1, bytes: image, width: 16, height: 16, depth: 32, png: true};
  const make = (b) =>
    new PeCursorReader(
      fixture([
        {type: 1, id: 1, language: 0, bytes: b},
        {type: 12, id: 108, language: 0, bytes: group([{...metadata, bytes: b}])},
      ]).bytes,
    ).read(108);
  const cursor = make(image);
  assert.deepEqual(cursor.images[0], {
    resourceId: 1,
    language: 0,
    width: 16,
    height: 16,
    hotspotX: 3,
    hotspotY: 4,
    bitDepth: 32,
    encoding: 'png',
  });
  assert.deepEqual(Buffer.from(cursor.bytes.subarray(22)), image.subarray(4));
  const corrupt = Buffer.from(image);
  corrupt[24] ^= 1;
  assert.throws(() => make(corrupt), /CRC/);
  assert.throws(() => make(image.subarray(0, -1)), /range/);
  assert.throws(() => make(image.subarray(0, -12)), /IEND/);
  assert.throws(() => make(Buffer.concat([image, Buffer.from([0])])), /PNG end/);
});

test('ANI is explicitly reported with RIFF bytes rather than a fabricated static frame', () => {
  const ani = Buffer.alloc(56);
  ani.write('RIFF');
  ani.writeUInt32LE(48, 4);
  ani.write('ACONanih', 8);
  ani.writeUInt32LE(36, 16);
  ani.writeUInt32LE(36, 20);
  const make = (bytes) =>
    new PeCursorReader(fixture([{type: 21, id: 108, language: 0, bytes}]).bytes);
  const reader = make(ani),
    result = reader.read(108);
  assert.deepEqual(reader.list(), [{kind: 'ani', id: 108, language: 0}]);
  assert.equal(result.kind, 'ani');
  assert.deepEqual(Buffer.from(result.bytes), ani);
  result.bytes.fill(0);
  assert.equal(reader.read(108).bytes[0], 82);
  for (const offset of [0, 4, 8, 16]) {
    const bad = Buffer.from(ani);
    bad.writeUInt32LE(0xffffffff, offset);
    assert.throws(() => make(bad).read(108), /ANI|range/);
  }
});

test('bounds all PE truncations and rejects virtual tails, bad headers, and data directories', () => {
  const f = simple();
  for (let n = 0; n < f.bytes.length; n++)
    assert.throws(() => parsePeResources(f.bytes.subarray(0, n)), `accepted length ${n}`);
  const mutations = [
    [0, 0],
    [60, 0xffffffff],
    [0x80, 0],
    [0x94, 0],
    [0x98, 0],
    [0x98 + 60, 1],
    [f.directory - 4, 17],
    [f.directory + 16, 0xffffffff],
    [f.directory + 20, 15],
    [f.section + 20, 0xffffffff],
    [f.leaves[0].data, 0x1000 + f.bytes.length],
    [f.leaves[0].data + 4, 0xffffffff],
    [f.leaves[0].data + 12, 1],
  ];
  for (const [offset, value] of mutations) {
    const b = Buffer.from(f.bytes);
    b.writeUInt32LE(value, offset);
    assert.throws(() => parsePeResources(b), `accepted offset ${offset}`);
  }
  const empty = Buffer.from(f.bytes);
  empty.writeUInt32LE(0, f.directory + 16);
  empty.writeUInt32LE(0, f.directory + 20);
  assert.deepEqual(parsePeResources(empty), []);
  const short = Buffer.from(f.bytes);
  short.writeUInt32LE(2, f.directory - 4);
  assert.deepEqual(parsePeResources(short), []);
});

test('resource tree rejects cycles, wrong depth, duplicate IDs, bad names and out-of-directory pointers', () => {
  const f = simple();
  for (const [offset, value] of [
    [0x214, 0x80000000],
    [0x214, 0x7fffffff],
    [0x214, 0x800fffff],
    [0x218, 1],
    [f.leaves[0].entry + 4, 0x80000000],
    [f.leaves[0].entry + 4, f.bytes.length],
  ]) {
    const b = Buffer.from(f.bytes);
    b.writeUInt32LE(value, offset);
    assert.throws(() => parsePeResources(b));
  }
  const named = fixture([{type: 'type', id: 'pointer', language: 0, bytes: Buffer.from([1])}]);
  assert.equal(parsePeResources(named.bytes)[0].id, 'pointer');
  const bad = Buffer.from(named.bytes);
  bad.writeUInt32LE(0x800fffff, 0x210);
  assert.throws(() => parsePeResources(bad), /range/);
  const count = Buffer.from(f.bytes);
  count.writeUInt16LE(65535, 0x20e);
  assert.throws(() => parsePeResources(count), /range|limit/);
});

test('rejects malformed cursor group headers, references, dimensions, hotspots, DIBs and masks', () => {
  const f = simple(),
    image = f.leaves.find((r) => r.type === 1),
    g = f.leaves.find((r) => r.type === 12);
  const cases = [
    [g.payload, 1, 2],
    [g.payload + 2, 1, 2],
    [g.payload + 4, 0, 2],
    [g.payload + 4, 257, 2],
    [g.payload + 6, 31, 2],
    [g.payload + 8, 32, 2],
    [g.payload + 10, 2, 2],
    [g.payload + 12, 32, 2],
    [g.payload + 14, 1, 4],
    [g.payload + 18, 99, 2],
    [image.payload, 32, 2],
    [image.payload + 2, 32, 2],
    [image.payload + 4, 13, 4],
    [image.payload + 8, 257, 4],
    [image.payload + 12, 63, 4],
    [image.payload + 16, 2, 2],
    [image.payload + 18, 3, 2],
    [image.payload + 20, 1, 4],
    [image.payload + 24, 0xffffffff, 4],
    [image.payload + 36, 0xffffffff, 4],
  ];
  for (const [offset, value, size] of cases) {
    const b = Buffer.from(f.bytes);
    if (size === 2) b.writeUInt16LE(value, offset);
    else b.writeUInt32LE(value, offset);
    assert.throws(() => new PeCursorReader(b).read(108), `accepted offset ${offset}`);
  }
  const truncated = Buffer.from(f.bytes);
  truncated.writeUInt32LE(image.bytes.length - 1, image.data + 4);
  truncated.writeUInt32LE(image.bytes.length - 1, g.payload + 14);
  assert.throws(() => new PeCursorReader(truncated).read(108), /range/);
  for (const size of [0, 3072, 3200]) {
    const b = Buffer.from(f.bytes);
    b.writeUInt32LE(size, image.payload + 24);
    assert.equal(new PeCursorReader(b).read(108).bytes.length, 3262);
  }
});

test('cursor hash lookup works without Web Crypto and still rejects different content', async () => {
  const {createHash} = await import('node:crypto'),
    bytes = simple().bytes;
  const original = new PeCursorReader(bytes),
    entry = original.list()[0],
    cursor = original.read(entry.id, entry.language);
  const hash = createHash('sha256').update(cursor.bytes).digest('hex'),
    descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  try {
    Object.defineProperty(globalThis, 'crypto', {configurable: true, value: {}});
    const reader = new PeCursorReader(bytes);
    const [found, matches] = await Promise.all([reader.readByHash(hash), reader.findByHash(hash)]);
    assert.deepEqual(found.bytes, cursor.bytes);
    assert.deepEqual(matches, [entry]);
    assert.equal(await reader.readByHash('0'.repeat(64)), undefined);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
    else delete globalThis.crypto;
  }
});

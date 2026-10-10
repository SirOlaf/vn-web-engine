import test from 'node:test';
import assert from 'node:assert/strict';
import {deflateSync} from 'node:zlib';
import {md5Hex} from '../dist/core/md5.js';
import {adler32} from '../dist/core/inflate.js';
import {XP3_FILE_PROTECTED, Xp3Archive} from '../dist/formats/kirikiri/xp3.js';
import {
  CX_TINY_FILTERS,
  CxArchive,
  applyCxTinyFilter,
  cxMemberName,
  cxTinyKey,
} from '../dist/formats/kirikiri/cx-archive.js';
import {PsbFile, PsbResource} from '../dist/formats/kirikiri/psb.js';
import {
  EMOTE_PSB_KEYS,
  applyPsbKeystream,
  decryptPsbBody,
} from '../dist/formats/kirikiri/psb-filter.js';
import {intArray, nameTrie} from './kirikiri-psb-fixtures.mjs';

class MemorySource {
  constructor(bytes) {
    this.bytes = bytes;
    this.size = bytes.length;
  }
  async read(offset, length) {
    return this.bytes.slice(offset, offset + length);
  }
}

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let p = 0;
  for (const part of parts) out.set(part, (p += part.length) - part.length);
  return out;
};
const u16 = (v) => Uint8Array.of(v & 0xff, v >>> 8);
const u32 = (v) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v, true);
  return b;
};
const u64 = (v) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(v), true);
  return b;
};
const utf16 = (s) => {
  const b = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) b.set(u16(s.charCodeAt(i)), i * 2);
  return b;
};
const chunk = (tag, body) => concat(new TextEncoder().encode(tag), u64(body.length), body);
const MARK = Uint8Array.of(0x58, 0x50, 0x33, 0x0d, 0x0a, 0x20, 0x0a, 0x1a, 0x8b, 0x67, 0x01);

/** Version-2 archive: cushion at 0x17 chains to a zlib index after the member data. */
function buildXp3(members, extraChunks = []) {
  const header = 0x28;
  let offset = header;
  const blobs = [],
    files = [];
  for (const m of members) {
    const segments = m.segments.map((plain) => {
      const stored = plain.compress ? new Uint8Array(deflateSync(plain.bytes)) : plain.bytes,
        segment = concat(
          u32(plain.compress ? 1 : 0),
          u64(offset),
          u64(plain.bytes.length),
          u64(stored.length),
        );
      blobs.push(stored);
      offset += stored.length;
      return segment;
    });
    const size = m.segments.reduce((n, s) => n + s.bytes.length, 0);
    files.push(
      chunk(
        'File',
        concat(
          chunk(
            'info',
            concat(u32(m.flags ?? 0), u64(size), u64(size), u16(m.name.length), utf16(m.name)),
          ),
          chunk('segm', concat(...segments)),
          chunk('adlr', u32(m.adler)),
        ),
      ),
    );
  }
  const index = concat(...extraChunks, ...files),
    packed = new Uint8Array(deflateSync(index));
  return concat(
    MARK,
    u64(0x17),
    u32(1),
    Uint8Array.of(0x80),
    u64(0),
    u64(offset),
    ...blobs,
    Uint8Array.of(1),
    u64(packed.length),
    u64(index.length),
    packed,
  );
}

test('md5 matches RFC 1321 test suite', () => {
  const hex = (s) => md5Hex(new TextEncoder().encode(s));
  assert.equal(hex(''), 'd41d8cd98f00b204e9800998ecf8427e');
  assert.equal(hex('abc'), '900150983cd24fb0d6963f7d28e17f72');
  assert.equal(
    hex('12345678901234567890123456789012345678901234567890123456789012345678901234567890'),
    '57edf4a22be3c955ac49da2e2107b67a',
  );
});

test('XP3 reads chained zlib indices and multi-segment members', async () => {
  const a = new TextEncoder().encode('hello '),
    b = new TextEncoder().encode('world, compressed world');
  const bytes = buildXp3([
    {
      name: 'Dir\\Text.TXT',
      adler: 7,
      segments: [{bytes: a}, {bytes: b, compress: true}],
    },
  ]);
  const archive = await Xp3Archive.open(new MemorySource(bytes));
  assert.equal(archive.entries.length, 1);
  const entry = archive.find('dir/text.txt');
  assert.ok(entry);
  assert.equal(entry.adler32, 7);
  assert.deepEqual(
    entry.segments.map((s) => s.compressed),
    [false, true],
  );
  assert.equal(
    new TextDecoder().decode(await archive.read(entry)),
    'hello world, compressed world',
  );
  assert.equal(await Xp3Archive.isXp3(new MemorySource(bytes.subarray(1))), false);
});

test('CxDec archive resolves hashed names and removes the tiny filter', async () => {
  const filter = {keyMask: 0x1548e29c, zeroKey: 0xd7},
    plain = new TextEncoder().encode('//startup'),
    adler = adler32(plain),
    stored = plain.slice();
  applyCxTinyFilter(filter, adler, stored);
  assert.notDeepEqual(stored, plain);
  const name = 'System/Initialize.tjs',
    eliF = chunk('eliF', concat(u32(adler), u16(name.length), utf16(name), u16(0)));
  const bytes = buildXp3(
    [
      {
        name: cxMemberName(name),
        flags: XP3_FILE_PROTECTED,
        adler,
        segments: [{bytes: stored, compress: true}],
      },
    ],
    [eliF],
  );
  const cx = new CxArchive(await Xp3Archive.open(new MemorySource(bytes)), filter);
  assert.deepEqual(cx.names, [{adler32: adler, name}]);
  // ASCII letters are folded before hashing; the lookup is therefore case-insensitive.
  assert.deepEqual(await cx.read('system/initialize.TJS'), plain);
});

test('CxDec tiny key folds the masked Adler-32 and substitutes zero', () => {
  const filter = CX_TINY_FILTERS.get(
    '26903726725a45bab530d153e8f06f0607268783c89b3bf3ad300a960259a792',
  );
  assert.ok(filter);
  // Values observed in nekopara vol.1 data.xp3 (AppConfig.tjs, startup.tjs).
  assert.equal(cxTinyKey(filter, 0x6094b719), 0x79);
  assert.equal(cxTinyKey(filter, 0xb4d804c0), 0x8b);
  assert.equal(cxTinyKey(filter, filter.keyMask), filter.zeroKey);
  assert.equal(cxMemberName('AppConfig.tjs'), '70be707b6a772e9a371c8aa01cdfd7a9');
});

/** A version-2 PSB with names, scalars, strings, a list, an object and one resource. */
function samplePsb() {
  const names = ['alpha', 'beta', 'title'],
    trie = nameTrie(names),
    strings = ['hello', '日本語'],
    stringData = concat(
      ...strings.map((s) => concat(new TextEncoder().encode(s), Uint8Array.of(0))),
    ),
    resource = Uint8Array.of(9, 8, 7);
  const list = (values) => {
    const offsets = [];
    let at = 0;
    for (const v of values) offsets.push((at += v.length) - v.length);
    return concat(Uint8Array.of(0x20), intArray(offsets), ...values);
  };
  const object = (pairs) => {
    const values = pairs.map(([, v]) => v),
      offsets = [];
    let at = 0;
    for (const v of values) offsets.push((at += v.length) - v.length);
    return concat(
      Uint8Array.of(0x21),
      intArray(pairs.map(([k]) => k)),
      intArray(offsets),
      ...values,
    );
  };
  const root = object([
    [0, Uint8Array.of(0x06, 0xfe, 0xff)], // alpha: -2 (2-byte signed)
    [
      1,
      list([
        Uint8Array.of(0x01),
        Uint8Array.of(0x03),
        Uint8Array.of(0x15, 1),
        Uint8Array.of(0x19, 0),
      ]),
    ],
    [2, concat(Uint8Array.of(0x1f), new Uint8Array(new Float64Array([1.5]).buffer))],
  ]);
  const tables = [intArray(trie.charset), intArray(trie.tree), intArray(trie.indices)];
  const namesBlock = concat(...tables),
    stringOffsets = intArray([0, 6]),
    chunkOffsets = intArray([0]),
    chunkLengths = intArray([resource.length]);
  let at = 0x28;
  const layout = {};
  for (const [key, block] of Object.entries({
    names: namesBlock,
    strings: stringOffsets,
    stringData,
    chunkOffsets,
    chunkLengths,
    chunkData: resource,
    root,
  })) {
    layout[key] = at;
    at += block.length;
  }
  const bytes = concat(
    new TextEncoder().encode('PSB\0'),
    u16(2),
    u16(0),
    u32(0x28),
    u32(layout.names),
    u32(layout.strings),
    u32(layout.stringData),
    u32(layout.chunkOffsets),
    u32(layout.chunkLengths),
    u32(layout.chunkData),
    u32(layout.root),
    namesBlock,
    stringOffsets,
    stringData,
    chunkOffsets,
    chunkLengths,
    resource,
    root,
  );
  return {bytes, names};
}

const assertSampleTree = (psb, names) => {
  assert.deepEqual(psb.names, names);
  const value = psb.root;
  assert.equal(value.alpha, -2);
  assert.equal(value.title, 1.5);
  assert.equal(value.beta[0], null);
  assert.equal(value.beta[1], true);
  assert.equal(value.beta[2], '日本語');
  assert.ok(value.beta[3] instanceof PsbResource);
  assert.deepEqual([...value.beta[3].bytes], [9, 8, 7]);
};

test('PSB decodes names, scalars, strings, lists, objects and resources', () => {
  const {bytes, names} = samplePsb();
  assertSampleTree(new PsbFile(bytes), names);
});

test('E-mote keystream matches the runtime key', () => {
  const key = EMOTE_PSB_KEYS.get(
    'a3b693b605d67812e489b1fb62cd341012b5514fc9114a032fee4685e70b3a86',
  );
  assert.equal(key, 742877301);
  // Keystream recovered from an emotewin.xp3 member: ciphertext XOR its decoded name table.
  const stream = new Uint8Array(8);
  applyPsbKeystream(key, stream);
  assert.deepEqual([...stream], [0x8d, 0x3b, 0xad, 0xf5, 0xa0, 0x6d, 0x5f, 0x32]);
});

test('E-mote PSB body filter covers only the header-declared range', () => {
  const {bytes, names} = samplePsb(),
    key = 742877301,
    view = new DataView(bytes.buffer),
    start = view.getUint32(8, true),
    end = view.getUint32(24, true),
    filtered = decryptPsbBody(bytes, key);
  assert.deepEqual(filtered.subarray(0, start), bytes.subarray(0, start));
  assert.notDeepEqual(filtered.subarray(start, end), bytes.subarray(start, end));
  assert.deepEqual(filtered.subarray(end), bytes.subarray(end));
  assertSampleTree(new PsbFile(decryptPsbBody(filtered, key)), names);
  assert.throws(() => decryptPsbBody(Uint8Array.of(1, 2, 3, 4), key), /Not a PSB/);
});

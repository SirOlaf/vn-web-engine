import assert from 'node:assert/strict';
import test from 'node:test';
import {BurikoBitmapStorage} from '../dist/engines/buriko/native/bitmap.js';
import {
  blendBurikoAlpha,
  blendBurikoAlphaWithTransparency,
  blendBurikoAlphaIntoRgb,
} from '../dist/engines/buriko/native/bitmap-alpha.js';
import {
  copyBurikoBitmapRows,
  clearBurikoBitmap,
} from '../dist/engines/buriko/native/bitmap-copy.js';

function bitmap(words, width = words.length, height = 1) {
  const bytes = new Uint8Array(new Uint32Array(words).buffer);
  return {
    storage: new BurikoBitmapStorage(bytes, true),
    offset: 0,
    stride: width * 4,
    width,
    height,
    format: 2,
    bytesPerPixel: 4,
  };
}
function words(bitmap) {
  return Array.from(new Uint32Array(bitmap.storage.bytes.buffer));
}

// Synthetic input/output captured from the isolated native 14003d690 instruction span.
// The paired pixel and odd tail intentionally receive different rounding and shortcut paths.
const normalVectors = [
  [
    0x005fec55, 0x011cd425, 0x0047331e, 0x0199f0f6, 0x01d7a49e, 0x013ab7c9, 0x0198eff5, 0x0178bb60,
    0x013ab7c9,
  ],
  [
    0x01185317, 0x01366237, 0x01247500, 0x01da74d0, 0x01810788, 0x01c91c43, 0x01786372, 0x015a345e,
    0x01754821,
  ],
  [
    0x11801e50, 0x0120c25a, 0x11103008, 0x57b10701, 0x572538d9, 0x570ffc74, 0x62a70a0e, 0x572438d7,
    0x620fd760,
  ],
  [
    0x7ff9c65b, 0x0115251c, 0x7fd77c0d, 0x80d8a625, 0x80e739b6, 0x80f86b12, 0xbfecba48, 0x80e438b3,
    0xbfe1750e,
  ],
  [
    0xfefdcc52, 0x0152f6a1, 0xfe2ba588, 0xffa198ff, 0xff706752, 0xffb47dcb, 0xfffbcb52, 0xff6f6751,
    0xff2ba487,
  ],
  [
    0xff33d793, 0x011d6813, 0xffe2633c, 0x0125971c, 0x010dfbb4, 0x01361d4f, 0xff32d692, 0x0114b062,
    0xffe2633c,
  ],
];

test('normal alpha blend retains measured SSE pair rounding and integer odd-tail results', () => {
  for (const vector of normalVectors) {
    const destination = bitmap(vector.slice(3, 6));
    blendBurikoAlpha(destination, bitmap(vector.slice(0, 3)));
    assert.deepEqual(words(destination), vector.slice(6));
  }
});

test('fractional alpha blend retains each native float32 rounding step', () => {
  const vectors = [
    [
      1, 0x7fc36689, 0x8009f02d, 0x7ffc25c6, 0x817d53c3, 0x81da0429, 0x817a0a6d, 0xbfaa5f9c,
      0xc04f9f2b, 0xbfce1ba6,
    ],
    [
      127, 0x7f3e3a89, 0x804fe42d, 0x7fda39c6, 0x813217c3, 0x819f6829, 0x81b90e6d, 0xa03624ab,
      0xa07e992a, 0xa0c51e8f,
    ],
    [
      255, 0x7f493a89, 0x8092e42d, 0x7f1539c6, 0x81c117c3, 0x81066829, 0x81b80e6d, 0x81c016c2,
      0x81056728, 0x81b70d6c,
    ],
  ];
  for (const vector of vectors) {
    const destination = bitmap(vector.slice(4, 7));
    blendBurikoAlphaWithTransparency(destination, bitmap(vector.slice(1, 4)), vector[0]);
    assert.deepEqual(words(destination), vector.slice(7));
  }
});

test('native zero-denominator tail faults after completing its paired writes', () => {
  const destination = bitmap([0x00b134a8, 0x00ebfaf4, 0x0066d22e]);
  const source = bitmap([0x4052f23a, 0xbfa597ca, 0x401cd779]);
  assert.throws(
    () => blendBurikoAlphaWithTransparency(destination, source, 256),
    /division by zero/,
  );
  assert.deepEqual(words(destination), [0, 0, 0x0066d22e]);
});

test('opaque alpha-to-RGB pairs copy alpha while the opaque odd tail clears it', () => {
  const destination = bitmap([0x05060708, 0x15161718, 0x25262728]);
  blendBurikoAlphaIntoRgb(destination, bitmap([0xfe123456, 0xffabcdef, 0xfe123456]));
  assert.deepEqual(words(destination), [0xfe123456, 0xffabcdef, 0x00123456]);
});

test('native block copies preserve overlapping 8-byte store order', () => {
  const source = bitmap([1, 2, 3, 4, 5, 6], 4);
  const destination = {...source, offset: 4};
  copyBurikoBitmapRows(destination, source);
  assert.deepEqual(words(source), [1, 1, 2, 2, 4, 6]);
});

test('alpha blend snapshots each overlapping pair before writing it', () => {
  const shared = bitmap([0xff000001, 0xff000002, 0xff000003, 0xff000004]);
  const destination = {...shared, offset: 4};
  const source = {...shared, width: 3};
  blendBurikoAlpha(destination, source);
  // The odd tail observes the second word written by the preceding MOVQ pair.
  assert.deepEqual(words(shared), [0xff000001, 0xff000001, 0xff000002, 0xff000002]);
});

test('alpha blend retains native range and unwritten-source faults', () => {
  const destination = bitmap([0xff010203, 0xff040506]);
  const source = bitmap([0xffaabbcc, 0xffddeeff]);
  source.storage = new BurikoBitmapStorage(source.storage.bytes, false);
  source.storage.written(0, 4);
  assert.throws(() => blendBurikoAlpha(destination, source), /unwritten native allocation/);
  assert.deepEqual(words(destination), [0xff010203, 0xff040506]);

  const shortSource = {...bitmap([0xffaabbcc]), width: 2};
  assert.throws(() => blendBurikoAlpha(destination, shortSource), /outside native allocation/);
});

test('native block copies keep earlier stores when a later source block is unwritten', () => {
  const source = bitmap([1, 2, 3, 4, 5, 6]);
  source.storage = new BurikoBitmapStorage(source.storage.bytes, false);
  source.storage.written(0, 8);
  const destination = bitmap([0, 0, 0, 0, 0, 0]);
  assert.throws(() => copyBurikoBitmapRows(destination, source), /unwritten native allocation/);
  assert.deepEqual(words(destination), [1, 2, 0, 0, 0, 0]);
});

test('failed optional clear cropping clears the original bitmap and retains row padding', () => {
  const target = bitmap([1, 2, 0x12345678, 3, 4, 0xabcdef00], 2, 2);
  target.stride = 12;
  clearBurikoBitmap(target, {left: 20, top: 20, right: 30, bottom: 30});
  assert.deepEqual(words(target), [0, 0, 0x12345678, 0, 0, 0xabcdef00]);
});

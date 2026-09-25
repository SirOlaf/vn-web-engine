import test from 'node:test';
import assert from 'node:assert/strict';
import {Arc20Archive} from '../dist/formats/buriko/arc20.js';
import {decodeDsc} from '../dist/formats/buriko/dsc.js';
import {decodeSdc} from '../dist/formats/buriko/compressed-resource.js';
import {decodeBse} from '../dist/formats/buriko/bse.js';
import {decodeCompressedBgV1, frequencyTree} from '../dist/formats/buriko/compressed-bg.js';
import {BfMovie} from '../dist/formats/buriko/bf-movie.js';
import {movieIdct} from '../dist/formats/buriko/movie-idct.js';
import {readTimeEvents} from '../dist/formats/buriko/time-event.js';
const put = (b, p, n) => new DataView(b.buffer).setUint32(p, n, true);
const text = (b, s, p = 0) => b.set(new TextEncoder().encode(s), p);
const source = (b) => ({
  size: b.length,
  async read(p, n) {
    assert.ok(p >= 0 && p + n <= b.length);
    return b.slice(p, p + n);
  },
});
// Independent integer arithmetic for the native wrapping product recurrence.
function random(seed) {
  let state = BigInt(seed);
  return () => {
    const product = (state * 22695477n) & 0xffffffffn;
    state = (product + 1n) & 0xffffffffn;
    return Number((product >> 16n) & 255n);
  };
}
const varint = (n) => {
  const a = [];
  do {
    const b = n % 128;
    n = Math.floor(n / 128);
    a.push(b | (n ? 128 : 0));
  } while (n);
  return a;
};
function encrypted(input, seed) {
  const rng = random(seed);
  return Uint8Array.from(input, (b) => (b + rng()) & 255);
}
test('ARC20 retains duplicate names and rejects out-of-file entries', async () => {
  const b = new Uint8Array(274);
  text(b, 'BURIKO ARC20');
  put(b, 12, 2);
  for (let i = 0; i < 2; i++) {
    text(b, 'duplicate', 16 + i * 128);
    put(b, 112 + i * 128, i);
    put(b, 116 + i * 128, 1);
  }
  b.set([31, 47], 272);
  const a = await Arc20Archive.open(source(b));
  assert.deepEqual(
    a.entries.map((e) => e.name),
    ['duplicate', 'duplicate'],
  );
  assert.deepEqual(await a.read(1), Uint8Array.of(47));
  put(b, 244, 3);
  await assert.rejects(Arc20Archive.open(source(b)));
});
test('DSC canonical symbols and overlapping distance-two backreference', () => {
  const b = new Uint8Array(0x223);
  text(b, 'DSC FORMAT 1.00\0');
  put(b, 16, 0xffffffff);
  put(b, 20, 6);
  put(b, 24, 3);
  const lengths = new Uint8Array(512);
  lengths[65] = 1;
  lengths[66] = 2;
  lengths[258] = 2;
  b.set(encrypted(lengths, 0xffffffff), 32);
  // A=0, B=10, length4=11, distance2=000000000000.
  b.set([0b01011000, 0, 0], 0x220);
  assert.equal(new TextDecoder().decode(decodeDsc(b)), 'ABABAB');
  put(b, 20, 5);
  assert.throws(() => decodeDsc(b));
});
test('SDC checks stored bytes and handles overlap', () => {
  const input = Uint8Array.of(1, 65, 66, 0x90, 0),
    seed = 0xdeadbeef,
    b = new Uint8Array(32 + input.length);
  text(b, 'SDC FORMAT 1.00\0');
  put(b, 16, seed);
  put(b, 20, input.length);
  put(b, 24, 6);
  b.set(encrypted(input, seed), 32);
  const d = new DataView(b.buffer);
  d.setUint16(28, b.subarray(32).reduce((a, n) => a + n, 0) & 65535, true);
  d.setUint16(
    30,
    b.subarray(32).reduce((a, n) => a ^ n, 0),
    true,
  );
  assert.equal(new TextDecoder().decode(decodeSdc(b)), 'ABABAB');
  b[34] ^= 1;
  assert.throws(() => decodeSdc(b), /checksum/);
});
test('BSE signed overflow, permutation and rotations preserve bytes after first64', () => {
  const decoded = Uint8Array.from({length: 79}, (_, i) => (i * 13 + 17) & 255),
    b = new Uint8Array(95);
  text(b, 'BSE 1.1\0');
  new DataView(b.buffer).setUint16(8, 0x101, true);
  put(b, 12, 0xf1234567);
  b.set(decoded, 16);
  let seed = BigInt.asIntN(32, 0xf1234567n);
  const rng = () => {
    const x =
      BigInt.asIntN(32, (BigInt.asIntN(32, seed * 127n) >> 7n) + seed * 83n + 53n) ^ 0xb97a7e5cn;
    const u = BigInt.asUintN(32, x);
    seed = BigInt.asIntN(32, (u >> 16n) | (u << 16n));
    return Number(seed & 32767n);
  };
  const used = new Set();
  for (let i = 0; i < 64; i++) {
    let p = rng() & 63;
    while (used.has(p)) p = (p + 1) & 63;
    used.add(p);
    const shift = rng() & 7,
      direction = rng() & 1,
      add = rng(),
      v = decoded[p];
    b[16 + p] =
      ((direction ? (v >>> shift) | (v << (8 - shift)) : (v << shift) | (v >>> (8 - shift))) +
        add) &
      255;
  }
  b[10] = decoded.subarray(0, 64).reduce((a, n) => a + n, 0) & 255;
  b[11] = decoded.subarray(0, 64).reduce((a, n) => a ^ n, 0);
  assert.deepEqual(decodeBse(b), decoded);
  b[10] ^= 1;
  assert.throws(() => decodeBse(b), /checksum/);
});
test('CompressedBG tree ties, zero runs and 24-bit native expansion', () => {
  // Intermediate [0, 6]: zero literal bytes then six zero residual bytes.
  const weights = new Array(256).fill(0);
  weights[0] = weights[6] = 1;
  const table = Uint8Array.from(weights),
    b = new Uint8Array(305);
  text(b, 'CompressedBG___\0');
  const d = new DataView(b.buffer);
  d.setUint16(16, 2, true);
  d.setUint16(18, 1, true);
  d.setUint16(20, 24, true);
  put(b, 32, 2);
  put(b, 36, 1);
  put(b, 40, 256);
  b[44] = 2;
  b[45] = 0;
  d.setUint16(46, 1, true);
  b.set(encrypted(table, 1), 48);
  b[304] = 0b01000000;
  const image = decodeCompressedBgV1(b);
  assert.equal(image.bitDepth, 32);
  assert.equal(image.flags, 7);
  assert.deepEqual(image.pixels, new Uint8Array(8));
  const tree = frequencyTree([1, 1, 2]);
  assert.deepEqual(tree.children[3], [0, 1]);
  assert.deepEqual(tree.children[4], [2, 3]);
  b[44] ^= 1;
  assert.throws(() => decodeCompressedBgV1(b), /checksum/);
});
test('CompressedBG fast Huffman prefixes preserve invalid singleton branches', () => {
  const weights = new Uint8Array(256),
    b = new Uint8Array(48 + 256 + 1);
  weights[0] = 1;
  text(b, 'CompressedBG___\0');
  const d = new DataView(b.buffer);
  d.setUint16(16, 1, true);
  d.setUint16(18, 1, true);
  d.setUint16(20, 8, true);
  put(b, 32, 1);
  put(b, 36, 1);
  put(b, 40, 256);
  b[44] = b[45] = 1;
  d.setUint16(46, 1, true);
  b.set(encrypted(weights, 1), 48);
  b[304] = 0x80;
  assert.throws(() => decodeCompressedBgV1(b), /Invalid CompressedBG code/);
});
function frame(depth, changed, alphaMode = 1) {
  const frequencies = new Array(192).fill(0);
  frequencies[0] = frequencies[16] = 1;
  const row = changed ? [1, ...varint(192), 0, 0] : [0, 0];
  const start = 192 + (depth === 32 ? 8 : 4);
  const header = Uint8Array.from([...frequencies, ...new Array(depth === 32 ? 8 : 4).fill(0)]);
  put(header, 192, start);
  let alpha = [];
  if (depth === 32) {
    put(header, 196, start + row.length);
    if (alphaMode === 1) alpha = [1, 0, 0, 0, 2, 170, 63, 120];
    else {
      const size = changed ? 65 : 1,
        weights = new Array(256).fill(0);
      weights[changed ? 1 : 0] = size;
      alpha = [2, 0, 0, 0, size, 0, 0, 0, ...weights, ...new Array(Math.ceil(size / 8)).fill(0)];
    }
  }
  return Uint8Array.from([...header, ...row, ...alpha]);
}
function movie(depth, frames) {
  const start = 192 + frames.length * 4,
    b = new Uint8Array(start + frames.reduce((n, f) => n + f.length, 0));
  text(b, 'BF_Movie_______\0');
  put(b, 16, 0x10001);
  put(b, 20, 8);
  put(b, 24, 8);
  put(b, 28, depth);
  put(b, 32, depth === 32 ? 2 : 1);
  put(b, 36, 30);
  put(b, 40, frames.length);
  put(b, 44, 1);
  b.fill(1, 64, 192);
  let p = start;
  frames.forEach((f, i) => {
    put(b, 192 + i * 4, p);
    b.set(f, p);
    p += f.length;
  });
  return b;
}
for (const depth of [24, 32])
  for (const mode of [1, 2])
    test(`BF_Movie ${depth}-bit, alpha mode${mode}, retained blocks and backward replay`, async () => {
      const m = await BfMovie.open(
        source(movie(depth, [frame(depth, true, mode), frame(depth, false, mode)])),
      );
      const first = await m.frame(0),
        next = await m.frame(1);
      assert.deepEqual(next, first);
      assert.deepEqual(await m.frame(0), first);
      for (let p = 0; p < 256; p += 4)
        assert.deepEqual(Array.from(first.subarray(p, p + 4)), [
          128,
          128,
          128,
          depth === 24 ? 0 : mode === 1 ? 170 : 1,
        ]);
      await assert.rejects(m.frame(2));
    });
test('IDCT DC normalization, negative rounding and saturation', () => {
  const c = new Int16Array(64),
    q = new Uint8Array(64).fill(1);
  for (const [dc, value] of [
    [0, 128],
    [8, 129],
    [-1, 127],
    [32767, 255],
    [-32768, 0],
  ]) {
    c[0] = dc;
    assert.deepEqual(movieIdct(c, q), new Uint8Array(64).fill(value));
  }
});
test('time-event fixed and string records are bounded and preserve values', () => {
  const b = new Uint8Array(71);
  text(b, 'BurikoTimeEvent\0');
  put(b, 16, 65536);
  put(b, 20, 1);
  put(b, 24, 1);
  put(b, 64, 123);
  text(b, 'ok', 68);
  assert.deepEqual(readTimeEvents(b).events, [{value: 123, text: 'ok'}]);
  assert.throws(() => readTimeEvents(b.subarray(0, 70)), /Unterminated/);
});

test('BF_Movie retains native second-child frequency scan order', async () => {
  const row = frame(32, true, 1).slice(0, 205);
  // Native tree pairs [2,0], then [1,internal], giving 1=0 and 2=10.
  // A conventional minimum-pair tree would pair [2,1] and decode different bytes.
  const weights = new Uint8Array(256);
  weights.set([10, 2, 1]);
  const bits = '0' + '10'.repeat(64),
    encoded = new Uint8Array(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i++) if (bits[i] === '1') encoded[i >>> 3] |= 1 << (7 - (i & 7));
  const payload = Uint8Array.from([...row, 2, 0, 0, 0, 65, 0, 0, 0, ...weights, ...encoded]);
  const m = await BfMovie.open(source(movie(32, [payload]))),
    pixels = await m.frame(0);
  for (let p = 3; p < pixels.length; p += 4) assert.equal(pixels[p], 2);
});

test('IDCT horizontal and vertical AC orientation agrees with cosine basis', () => {
  const q = new Uint8Array(64).fill(1);
  for (const index of [1, 8, 9, 7, 56]) {
    const coefficients = new Int16Array(64);
    coefficients[index] = 40;
    const pixels = movieIdct(coefficients, q),
      u = index % 8,
      v = Math.floor(index / 8);
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++) {
        const value =
          (40 / 4) *
          (u ? 1 : Math.SQRT1_2) *
          (v ? 1 : Math.SQRT1_2) *
          Math.cos(((2 * x + 1) * u * Math.PI) / 16) *
          Math.cos(((2 * y + 1) * v * Math.PI) / 16);
        assert.ok(Math.abs(pixels[y * 8 + x] - (128 + Math.floor(value))) <= 1);
      }
  }
});

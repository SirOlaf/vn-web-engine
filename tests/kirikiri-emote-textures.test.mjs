import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DXT5_EMOTEDRIVER,
  DXT5_FOUR_COLOR,
  Dxt5Decoder,
  dxt5ByteLength,
} from '../dist/graphics/s3tc.js';
import {swapRedBlue} from '../dist/graphics/pixel-order.js';
import {decodeEmoteIcon, decodePsbRl} from '../dist/formats/kirikiri/psb-rl.js';
import {emoteRgba8ByteOrder, readEmoteTexture} from '../dist/formats/kirikiri/emote-texture.js';
import {PsbResource} from '../dist/formats/kirikiri/psb.js';

/** Textbook per-texel BC3 reference, written independently of the decoders under test. */
function referenceTexel(block, texel, mode) {
  const a0 = block[0],
    a1 = block[1];
  let bits = 0n;
  for (let i = 0; i < 6; i++) bits |= BigInt(block[2 + i]) << BigInt(8 * i);
  const ai = Number((bits >> BigInt(3 * texel)) & 7n);
  let alpha;
  if (ai === 0) alpha = a0;
  else if (ai === 1) alpha = a1;
  else if (a0 > a1) alpha = Math.floor(((8 - ai) * a0 + (ai - 1) * a1) / 7);
  else if (ai === 6) alpha = 0;
  else if (ai === 7) alpha = 255;
  else alpha = Math.floor(((6 - ai) * a0 + (ai - 1) * a1) / 5);
  const raw0 = block[8] + block[9] * 256,
    raw1 = block[10] + block[11] * 256;
  const rgb = (raw) => {
    const r = Math.floor(raw / 2048),
      g = Math.floor(raw / 32) % 64,
      b = raw % 32;
    return [r * 8 + Math.floor(r / 4), g * 4 + Math.floor(g / 16), b * 8 + Math.floor(b / 4)];
  };
  const c0 = rgb(raw0),
    c1 = rgb(raw1);
  const ci = (block[12 + (texel >> 2)] >> (2 * (texel & 3))) & 3;
  let color;
  if (ci === 0) color = c0;
  else if (ci === 1) color = c1;
  else if (mode === DXT5_EMOTEDRIVER && raw0 <= raw1)
    color = c0.map((v, i) => Math.floor((v + c1[i]) / 2));
  else if (ci === 2) color = c0.map((v, i) => Math.floor((2 * v + c1[i]) / 3));
  else color = c0.map((v, i) => Math.floor((v + 2 * c1[i]) / 3));
  return [...color, alpha];
}

function referenceDecode(blocks, width, height, mode) {
  const out = new Uint8Array(width * height * 4),
    blocksX = Math.ceil(width / 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const index = Math.floor(y / 4) * blocksX + Math.floor(x / 4),
        block = blocks.subarray(index * 16, index * 16 + 16);
      out.set(referenceTexel(block, (y % 4) * 4 + (x % 4), mode), (y * width + x) * 4);
    }
  return out;
}

/** Block from alpha endpoints/indices (16 x 0..7) and color endpoints/indices (16 x 0..3). */
function makeBlock(a0, a1, alphaIndices, color0, color1, colorIndices) {
  const block = new Uint8Array(16);
  block[0] = a0;
  block[1] = a1;
  let bits = 0n;
  alphaIndices.forEach((index, i) => (bits |= BigInt(index) << BigInt(3 * i)));
  for (let i = 0; i < 6; i++) block[2 + i] = Number((bits >> BigInt(8 * i)) & 0xffn);
  block[8] = color0 & 0xff;
  block[9] = color0 >> 8;
  block[10] = color1 & 0xff;
  block[11] = color1 >> 8;
  let indices = 0;
  colorIndices.forEach((index, i) => (indices |= index << (2 * i)));
  new DataView(block.buffer).setUint32(12, indices >>> 0, true);
  return block;
}

const allAlpha = [0, 1, 2, 3, 4, 5, 6, 7, 7, 6, 5, 4, 3, 2, 1, 0];
const allColor = [0, 1, 2, 3, 3, 2, 1, 0, 0, 1, 2, 3, 3, 2, 1, 0];
const wasm = new Dxt5Decoder(),
  software = new Dxt5Decoder({wasm: false});

test('DXT5 eight-alpha mode interpolates sevenths and truncates', () => {
  const block = makeBlock(255, 0, allAlpha, 0xffff, 0, allColor);
  const out = wasm.decode(block, 4, 4);
  const alphas = Array.from({length: 8}, (_, i) => out[i * 4 + 3]);
  assert.deepEqual(alphas, [255, 0, 218, 182, 145, 109, 72, 36]);
});

test('DXT5 six-alpha mode interpolates fifths and appends 0 and 255', () => {
  for (const [a0, a1] of [
    [0, 255],
    [90, 90],
  ]) {
    const block = makeBlock(a0, a1, allAlpha, 0xffff, 0, allColor);
    const out = wasm.decode(block, 4, 4);
    const alphas = Array.from({length: 8}, (_, i) => out[i * 4 + 3]);
    const expected =
      a0 === 0 ? [0, 255, 51, 102, 153, 204, 0, 255] : [90, 90, 90, 90, 90, 90, 0, 255];
    assert.deepEqual(alphas, expected);
  }
});

test('DXT5 color endpoints widen by bit replication and use four colors', () => {
  // color0 = red (0xf800) > color1 = blue (0x001f).
  const block = makeBlock(255, 255, new Array(16).fill(0), 0xf800, 0x001f, allColor);
  const out = wasm.decode(block, 4, 4, DXT5_EMOTEDRIVER);
  const texel = (i) => Array.from(out.subarray(i * 4, i * 4 + 3));
  assert.deepEqual(texel(0), [255, 0, 0]);
  assert.deepEqual(texel(1), [0, 0, 255]);
  assert.deepEqual(texel(2), [170, 0, 85]);
  assert.deepEqual(texel(3), [85, 0, 170]);
  const odd = wasm.decode(makeBlock(255, 255, allAlpha, 0x8410, 0x0821, allColor), 4, 4);
  // 0x8410: r=16 -> 132, g=32 -> 130, b=16 -> 132. 0x0821: r=1 -> 8, g=1 -> 4, b=1 -> 8.
  assert.deepEqual(Array.from(odd.subarray(0, 3)), [132, 130, 132]);
  assert.deepEqual(Array.from(odd.subarray(4, 7)), [8, 4, 8]);
});

test('DXT5 color0 <= color1: four-color by default, three-color in emotedriver mode', () => {
  for (const [c0, c1] of [
    [0x001f, 0xf800],
    [0x7bef, 0x7bef],
  ]) {
    const block = makeBlock(200, 100, allAlpha, c0, c1, allColor);
    const four = wasm.decode(block, 4, 4, DXT5_FOUR_COLOR);
    const three = wasm.decode(block, 4, 4, DXT5_EMOTEDRIVER);
    if (c0 === 0x001f) {
      assert.deepEqual(Array.from(four.subarray(8, 11)), [85, 0, 170]);
      assert.deepEqual(Array.from(four.subarray(12, 15)), [170, 0, 85]);
      assert.deepEqual(Array.from(three.subarray(8, 11)), [127, 0, 127]);
      assert.deepEqual(Array.from(three.subarray(12, 15)), [127, 0, 127]);
    }
    // Alpha is independent of the color mode.
    for (let i = 3; i < 64; i += 4) assert.equal(four[i], three[i]);
    assert.deepEqual(four, referenceDecode(block, 4, 4, DXT5_FOUR_COLOR));
    assert.deepEqual(three, referenceDecode(block, 4, 4, DXT5_EMOTEDRIVER));
  }
});

test('Wasm, JavaScript and reference DXT5 decoders agree on random surfaces', () => {
  assert.equal(wasm.accelerated, true);
  assert.equal(software.accelerated, false);
  let seed = 0x12345678;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) >>> 24) & 0xff;
  for (const [width, height] of [
    [4, 4],
    [16, 8],
    [5, 3],
    [13, 17],
    [1, 1],
  ]) {
    const blocks = Uint8Array.from({length: dxt5ByteLength(width, height)}, random);
    for (const mode of [DXT5_FOUR_COLOR, DXT5_EMOTEDRIVER]) {
      const expected = referenceDecode(blocks, width, height, mode);
      assert.deepEqual(wasm.decode(blocks, width, height, mode), expected, `${width}x${height}`);
      assert.deepEqual(software.decode(blocks, width, height, mode), expected);
    }
  }
  assert.throws(() => wasm.decode(new Uint8Array(15), 4, 4), RangeError);
});

test('swapRedBlue converts BGRA and RGBA in both directions', () => {
  const bgra = Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8);
  assert.deepEqual(swapRedBlue(bgra), Uint8Array.of(3, 2, 1, 4, 7, 6, 5, 8));
  swapRedBlue(bgra, bgra);
  swapRedBlue(bgra, bgra);
  assert.deepEqual(bgra, Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8));
});

/** Straightforward RL encoder: runs of 3..130 equal units, literals of 1..128 units. */
function encodeRl(data, unit) {
  const units = data.length / unit,
    out = [];
  const same = (a, b) => {
    for (let k = 0; k < unit; k++) if (data[a * unit + k] !== data[b * unit + k]) return false;
    return true;
  };
  let i = 0,
    literal = [];
  const flush = () => {
    while (literal.length) {
      const chunk = literal.splice(0, 128);
      out.push(chunk.length - 1);
      for (const u of chunk) for (let k = 0; k < unit; k++) out.push(data[u * unit + k]);
    }
  };
  while (i < units) {
    let run = 1;
    while (i + run < units && run < 130 && same(i, i + run)) run++;
    if (run >= 3) {
      flush();
      out.push(0x80 | (run - 3));
      for (let k = 0; k < unit; k++) out.push(data[i * unit + k]);
      i += run;
    } else literal.push(i++);
  }
  flush();
  return Uint8Array.from(out);
}

test('RL decodes literals and runs of whole units', () => {
  // 2 literal units, a run of 3, a run of 130 (0xff).
  const stream = Uint8Array.of(
    0x01,
    1,
    2,
    3,
    4,
    5,
    6,
    7,
    8,
    0x80,
    9,
    9,
    9,
    9,
    0xff,
    0xaa,
    0xbb,
    0xcc,
    0xdd,
  );
  const out = decodePsbRl(stream, 4, (2 + 3 + 130) * 4);
  assert.deepEqual(out.subarray(0, 8), Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8));
  assert.deepEqual(out.subarray(8, 20), new Uint8Array(12).fill(9));
  for (let i = 20; i < out.length; i += 4)
    assert.deepEqual(out.subarray(i, i + 4), Uint8Array.of(0xaa, 0xbb, 0xcc, 0xdd));
  assert.deepEqual(
    decodePsbRl(Uint8Array.of(0x7f, ...new Array(128).fill(7)), 1, 128),
    new Uint8Array(128).fill(7),
  );
});

test('RL round-trips and rejects malformed streams', () => {
  let seed = 7;
  const random = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 28) & 3;
  for (const unit of [1, 4]) {
    const data = Uint8Array.from({length: 1000 * unit}, random);
    assert.deepEqual(decodePsbRl(encodeRl(data, unit), unit, data.length), data);
  }
  assert.throws(() => decodePsbRl(Uint8Array.of(0x01, 1, 2, 3, 4), 4, 8), /truncated/);
  assert.throws(() => decodePsbRl(Uint8Array.of(0x80, 1, 2, 3), 4, 12), /truncated/);
  assert.throws(() => decodePsbRl(Uint8Array.of(0x81, 1, 2, 3, 4), 4, 12), /overruns/);
  assert.throws(() => decodePsbRl(Uint8Array.of(0x00, 1, 2, 3, 4), 4, 8), /produced 4 of 8/);
});

test('E-mote icons decode RL pixels directly or through a palette', () => {
  const pixels = Uint8Array.of(0x80, 10, 20, 30, 40, 0x00, 1, 2, 3, 4);
  const direct = decodeEmoteIcon({
    width: 2,
    height: 2,
    compress: 'RL',
    pixel: new PsbResource(0, pixels),
  });
  assert.deepEqual(
    direct.bgra,
    Uint8Array.of(10, 20, 30, 40, 10, 20, 30, 40, 10, 20, 30, 40, 1, 2, 3, 4),
  );
  const paletted = decodeEmoteIcon({
    width: 3,
    height: 1,
    compress: 'RL',
    pixel: new PsbResource(0, Uint8Array.of(0x02, 1, 0, 1)),
    pal: new PsbResource(1, Uint8Array.of(0, 0, 0, 0, 9, 8, 7, 6)),
  });
  assert.deepEqual(paletted.bgra, Uint8Array.of(9, 8, 7, 6, 0, 0, 0, 0, 9, 8, 7, 6));
  const raw = decodeEmoteIcon({
    width: 1,
    height: 1,
    pixel: new PsbResource(0, Uint8Array.of(1, 2, 3, 4)),
  });
  assert.deepEqual(raw.bgra, Uint8Array.of(1, 2, 3, 4));
});

test('E-mote texture descriptors list level 0 and mip levels with byte order by spec', () => {
  const texture = readEmoteTexture({
    type: 'DXT5',
    width: 8,
    height: 8,
    truncated_width: 8,
    truncated_height: 8,
    pixel: new PsbResource(2, new Uint8Array(64)),
    mipMapLevel: 3,
    mipMap: [
      {width: 4, height: 4, pixel: new PsbResource(1, new Uint8Array(16))},
      {width: 2, height: 2, pixel: new PsbResource(0, new Uint8Array(16))},
    ],
  });
  assert.deepEqual(
    texture.levels.map((level) => [level.width, level.height, level.pixels.length]),
    [
      [8, 8, 64],
      [4, 4, 16],
      [2, 2, 16],
    ],
  );
  assert.equal(texture.mipMapLevel, 3);
  assert.throws(
    () =>
      readEmoteTexture({
        type: 'RGBA8',
        width: 2,
        height: 2,
        pixel: new PsbResource(0, new Uint8Array(15)),
      }),
    /RGBA8 level 2x2/,
  );
  assert.equal(emoteRgba8ByteOrder('win'), 'bgra');
  assert.equal(emoteRgba8ByteOrder('common'), 'rgba');
});

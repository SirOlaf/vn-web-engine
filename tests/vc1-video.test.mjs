import assert from 'node:assert/strict';
import test from 'node:test';
import * as D from '../dist/formats/vc1/dsp.js';
import {VC1_VIDEO_WASM_BINARY} from '../dist/formats/vc1/wasm-binary.js';
import {
  Vc1Decoder,
  FOURCC_WMV3,
  FOURCC_WVC1,
  VC1_PACKET_LIMIT,
} from '../dist/formats/vc1/reference.js';
import {Vc1Decoder as PortableDecoder} from '../dist/formats/vc1/decoder.js';

// Synthetic 16×16 Main-profile stream: quantizer 8, no AC or DC differentials.
// The default DC predictor and inverse transform produce constant sample value 143.
// The following P picture skips the single macroblock. No media fixture is used.
const mainExtra = Buffer.from('4ff94801', 'hex');
const mainI = Buffer.from('00100bc0', 'hex');
const mainP = Buffer.from('28200840', 'hex');
const main = () => new Vc1Decoder(FOURCC_WMV3, 16, 16, mainExtra);

function constantPicture(picture, type, time, value) {
  assert.equal(picture.type, type);
  assert.equal(picture.time, time);
  assert.equal(picture.stride, 16);
  assert.equal(picture.chromaStride, 8);
  for (const [plane, size] of [
    [picture.y, 256],
    [picture.cb, 64],
    [picture.cr, 64],
  ])
    assert.deepEqual(plane.subarray(0, size), new Uint8Array(size).fill(value));
}

const bits = (text) =>
  Buffer.from(
    text
      .padEnd(Math.ceil(text.length / 8) * 8, '0')
      .match(/.{8}/g)
      .map((x) => parseInt(x, 2)),
  );
const field = (width, value) => value.toString(2).padStart(width, '0');
function advancedExtra({rangeY = false, rangeUv = false, interlace = false} = {}) {
  const sequence = bits(
    '11' +
      '000' +
      '01' +
      '000' +
      '00000' +
      '0' +
      field(12, 7) +
      field(12, 7) +
      '0' +
      Number(interlace) +
      '00' +
      '1000',
  );
  const entry = bits(
    '01000000000000' +
      Number(rangeY) +
      (rangeY ? '001' : '') +
      Number(rangeUv) +
      (rangeUv ? '001' : ''),
  );
  return Buffer.concat([Buffer.from([0, 0, 1, 15]), sequence, Buffer.from([0, 0, 1, 14]), entry]);
}

test('VC-1 Main emits I and skipped P pictures immediately with packet timestamps', () => {
  const decoder = main();
  constantPicture(decoder.decode(mainI, 12), 1, 12, 143);
  constantPicture(decoder.decode(mainP, 45), 2, 45, 143);
  constantPicture(decoder.decode(mainI, 78), 1, 78, 143);
  assert.equal(decoder.decode(null, 0), null);
  assert.equal(decoder.decode(null, 0), null);
});

test('VC-1 Advanced delays reference pictures and drains the last picture once', () => {
  const decoder = new Vc1Decoder(FOURCC_WVC1, 16, 16, advancedExtra());
  // I header: 110 type, rounding, quantizer 8, HALFQP 0; raw AC-prediction plane,
  // TRANSACFRM/TRANSDCTAB zero, CBP zero, raw AC-prediction zero and six zero DCs.
  const intra = bits('110' + '1' + '01000' + '0' + '00000' + '000' + '1' + '0' + '11110000');
  assert.equal(decoder.decode(intra, 12), null);
  constantPicture(decoder.decode(bits('1111'), 45), 1, 12, 128);
  constantPicture(decoder.decode(null, 0), 2, 45, 128);
  assert.equal(decoder.decode(null, 0), null);
});

test('VC-1 keeps decoder state private between streams', () => {
  const first = main();
  const second = main();
  constantPicture(first.decode(mainI, 1), 1, 1, 143);
  constantPicture(second.decode(mainI, 200), 1, 200, 143);
  constantPicture(first.decode(mainP, 2), 2, 2, 143);
  constantPicture(second.decode(mainP, 201), 2, 201, 143);
});

test('VC-1 refuses unsupported tools and bounds storage before allocation', () => {
  for (const [width, height] of [
    [0, 16],
    [-1, 16],
    [16.5, 16],
    [4097, 16],
    [16, 2161],
    [NaN, 16],
  ])
    assert.throws(() => new Vc1Decoder(FOURCC_WMV3, width, height, mainExtra), /dimensions/);
  assert.throws(() => new Vc1Decoder(FOURCC_WMV3, 16, 16, new Uint8Array(1)), /decode error/);
  assert.throws(() => main().decode(new Uint8Array(VC1_PACKET_LIMIT + 1), 0), /packet size/);
  for (const [options, message] of [
    [{rangeY: true}, /luma range mapping/],
    [{rangeUv: true}, /chroma range mapping/],
    [{interlace: true}, /interlaced coding/],
  ])
    assert.throws(() => new Vc1Decoder(FOURCC_WVC1, 16, 16, advancedExtra(options)), message);
  const decoder = new Vc1Decoder(FOURCC_WVC1, 16, 16, advancedExtra());
  assert.throws(() => decoder.decode(bits('1110' + '1' + '01000' + '0'), 1), /B pictures/);
});

for (const wasm of [false, true]) {
  test(`VC-1 facade runs synthetic I/P pictures with wasm=${wasm}`, () => {
    const decoder = new PortableDecoder(FOURCC_WMV3, 16, 16, mainExtra, {wasm});
    assert.equal(decoder.accelerated, wasm);
    constantPicture(decoder.decode(mainI, 12), 1, 12, 143);
    for (let time = 45; time < 300; time += 33)
      constantPicture(decoder.decode(mainP, time), 2, time, 143);
    assert.equal(decoder.decode(null, 0), null);
    const leadingP = new PortableDecoder(FOURCC_WMV3, 16, 16, mainExtra, {wasm});
    constantPicture(leadingP.decode(mainP, 99), 2, 99, 128);
  });
}

for (const wasm of [false, true]) {
  test(`VC-1 skipped references keep storage alive across later I pictures, wasm=${wasm}`, () => {
    const decoder = new PortableDecoder(FOURCC_WVC1, 16, 16, advancedExtra(), {wasm});
    const header = '110' + '1' + '01000' + '0' + '00000' + '000' + '1' + '0';
    assert.equal(decoder.decode(bits(header + '11110000'), 12), null);
    constantPicture(decoder.decode(bits('1111'), 45), 1, 12, 128);
    constantPicture(decoder.decode(bits('1111'), 78), 2, 45, 128);
    // DC differential +1 in the first luma block, propagated to its three neighbours.
    const previous = decoder.decode(bits(header + '0101110000'), 111);
    constantPicture(previous, 2, 78, 128);
    const current = decoder.decode(null, 0);
    assert.equal(current.type, 1);
    assert.equal(current.time, 111);
    assert.deepEqual(current.y.subarray(0, 256), new Uint8Array(256).fill(129));
    assert.deepEqual(current.cb.subarray(0, 64), new Uint8Array(64).fill(128));
    assert.deepEqual(current.cr.subarray(0, 64), new Uint8Array(64).fill(128));
    assert.equal(decoder.decode(null, 0), null);
  });
}

test('VC-1 SIMD kernels preserve reference arithmetic across transforms, prediction and filters', () => {
  const k = new WebAssembly.Instance(
    new WebAssembly.Module(Buffer.from(VC1_VIDEO_WASM_BINARY, 'base64')),
  ).exports;
  k.memory.grow(4);
  const start = (Number(k.__heap_base.value) + 15) & ~15;
  const block = new Int16Array(k.memory.buffer, start, 64);
  const dst = new Uint8Array(k.memory.buffer, start + 256, 2048);
  const src = new Uint8Array(k.memory.buffer, start + 256 + 2048, 2048);
  let seed = 0x675893;
  const random = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed >>> 0;
  };
  const fill = (a, max = 256) => {
    for (let i = 0; i < a.length; i++) a[i] = random() % max;
  };
  let checks = 0;
  const check = (label, fn, native) => {
    const expected = dst.slice(),
      b = block.slice();
    fn(expected, b);
    native();
    assert.deepEqual(dst, expected, label + ' pixels');
    assert.deepEqual(block, b, label + ' coefficients');
    checks++;
  };
  for (let trial = 0; trial < 200; trial++) {
    fill(block, 4096);
    for (let i = 0; i < 64; i++) block[i] -= 2048;
    fill(dst);
    fill(src);
    check(
      '8x8',
      (_, b) => D.invTrans8x8(b, 0),
      () => k.vc1_tx8(block.byteOffset),
    );
    for (const [name, w, h] of [
      ['invTrans8x4', 8, 4],
      ['invTrans4x8', 4, 8],
      ['invTrans4x4', 4, 4],
    ]) {
      fill(block, 4096);
      for (let i = 0; i < 64; i++) block[i] -= 2048;
      check(
        name,
        (d, b) => D[name](d, 128, 32, b, 0),
        () => k.vc1_tx_small(dst.byteOffset + 128, 32, block.byteOffset, w, h),
      );
    }
    for (const [name, mode] of [
      ['putPixelsClamped', 0],
      ['putSignedPixelsClamped', 1],
      ['addPixelsClamped', 2],
    ]) {
      fill(block, 65536);
      check(
        name,
        (d, b) => D[name](b, 0, d, 128, 32),
        () => k.vc1_pixels(block.byteOffset, dst.byteOffset + 128, 32, mode),
      );
    }
    for (const [name, w, h] of [
      ['invTrans8x8Dc', 8, 8],
      ['invTrans8x4Dc', 8, 4],
      ['invTrans4x8Dc', 4, 8],
      ['invTrans4x4Dc', 4, 4],
    ]) {
      const dc = (random() & 65535) - 32768;
      check(
        name,
        (d) => D[name](d, 128, 32, dc),
        () => k.vc1_tx_dc(dst.byteOffset + 128, 32, w, h, dc),
      );
    }
    for (const n of [8, 16])
      for (const rnd of [0, 1])
        for (const avg of [false, true]) {
          for (let h = 0; h < 4; h++)
            for (let v = 0; v < 4; v++)
              check(
                'mspel ' + [n, rnd, avg, h, v],
                (d) => D.mspelMc(d, 128, src, 128, 32, n, h, v, rnd, avg),
                () =>
                  k.vc1_mspel(dst.byteOffset + 128, src.byteOffset + 128, 32, n, h, v, rnd, +avg),
              );
          for (let xy = 0; xy < 4; xy++)
            check(
              'hpel',
              (d) => D.hpelMc(d, 128, src, 128, 32, n, xy, !!rnd, avg),
              () => k.vc1_hpel(dst.byteOffset + 128, src.byteOffset + 128, 32, n, xy, rnd, +avg),
            );
          for (let x = 0; x < 8; x++)
            for (let y = 0; y < 8; y++)
              check(
                'chroma',
                (d) => D.chromaMc(d, 128, src, 128, 32, 8, 8, x, y, !!rnd, avg),
                () =>
                  k.vc1_chroma(
                    dst.byteOffset + 128,
                    src.byteOffset + 128,
                    32,
                    8,
                    8,
                    x,
                    y,
                    rnd,
                    +avg,
                  ),
              );
        }
    // Correlated and uncorrelated samples exercise both filter decisions and clipping.
    fill(dst, trial & 1 ? 16 : 256);
    for (const pq of [1, 4, 8, 16, 31])
      for (const len of [4, 8, 16]) {
        check(
          'vloop',
          (d) => D.vLoopFilter(d, 256, 32, len, pq),
          () => k.vc1_loop(dst.byteOffset + 256, 1, 32, len, pq),
        );
        check(
          'hloop',
          (d) => D.hLoopFilter(d, 264, 32, len, pq),
          () => k.vc1_loop(dst.byteOffset + 264, 32, 1, len, pq),
        );
      }
  }
  assert.equal(checks, 142600);
});

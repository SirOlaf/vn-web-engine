import {test} from 'node:test';
import assert from 'node:assert/strict';
import {crc32} from 'node:zlib';
import {decodePng, pngCrc} from '../dist/formats/png/decode.js';
import {png, chunk} from './png-fixtures.mjs';
test('PNG RGBA filters 0–4 preserve straight color under zero alpha', async () => {
  const target = [10, 20, 30, 0, 40, 50, 60, 128],
    raw = Buffer.from([
      0,
      ...target,
      1,
      10,
      20,
      30,
      0,
      30,
      30,
      30,
      128,
      2,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      3,
      5,
      10,
      15,
      0,
      15,
      15,
      15,
      64,
      4,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
    ]);
  const image = await decodePng(png({width: 2, height: 5, raw}));
  assert.deepEqual([...image.pixels], Array(5).fill(target).flat());
});
test('PNG palette/sub-byte expansion and transparent grayscale/RGB samples', async () => {
  const palette = chunk('PLTE', Buffer.from([255, 0, 0, 0, 0, 255])),
    alpha = chunk('tRNS', Buffer.from([0, 128]));
  const indexed = await decodePng(
    png({
      width: 3,
      height: 1,
      type: 3,
      depth: 1,
      extras: [palette, alpha],
      raw: Buffer.from([0, 0x40]),
    }),
  );
  assert.deepEqual([...indexed.pixels], [255, 0, 0, 0, 0, 0, 255, 128, 255, 0, 0, 0]);
  const gray = await decodePng(
    png({
      width: 4,
      height: 1,
      type: 0,
      depth: 2,
      extras: [chunk('tRNS', Buffer.from([0, 2]))],
      raw: Buffer.from([0, 0x1b]),
    }),
  );
  assert.deepEqual(
    [...gray.pixels],
    [0, 0, 0, 255, 85, 85, 85, 255, 170, 170, 170, 0, 255, 255, 255, 255],
  );
  const rgb = await decodePng(
    png({
      width: 1,
      height: 1,
      type: 2,
      extras: [chunk('tRNS', Buffer.from([0, 1, 0, 2, 0, 3]))],
      raw: Buffer.from([0, 1, 2, 3]),
    }),
  );
  assert.deepEqual([...rgb.pixels], [1, 2, 3, 0]);
});
test('PNG 16-bit samples and grayscale-alpha convert to RGBA8', async () => {
  const image = await decodePng(
    png({width: 1, height: 1, type: 4, depth: 16, raw: Buffer.from([0, 0x12, 0x34, 0xab, 0xcd])}),
  );
  assert.deepEqual([...image.pixels], [0x12, 0x12, 0x12, 0xab]);
});
test('PNG Adam7 reconstructs all passes including tiny-image empty passes', async () => {
  for (const [width, height] of [
    [1, 1],
    [3, 5],
    [9, 9],
  ]) {
    const rows = [],
      expected = [];
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) expected.push(x * 10, y * 10, 33, 255);
    for (const [sx, sy, dx, dy] of [
      [0, 0, 8, 8],
      [4, 0, 8, 8],
      [0, 4, 4, 8],
      [2, 0, 4, 4],
      [0, 2, 2, 4],
      [1, 0, 2, 2],
      [0, 1, 1, 2],
    ])
      for (let y = sy; y < height && sx < width; y += dy) {
        rows.push(0);
        for (let x = sx; x < width; x += dx) rows.push(x * 10, y * 10, 33, 255);
      }
    const image = await decodePng(png({width, height, interlace: 1, raw: Buffer.from(rows)}));
    assert.deepEqual([...image.pixels], expected);
  }
});
test('PNG trailing bytes remain strict unless the consumer stops at IEND', async () => {
  const base = png({width: 1, height: 1, raw: Buffer.from([0, 11, 22, 33, 44])});
  const padded = Buffer.concat([base, Buffer.from([91, 82, 73])]);
  await assert.rejects(decodePng(padded), /Trailing PNG bytes/);
  assert.deepEqual(await decodePng(padded, {trailingBytes: 'ignore'}), await decodePng(base));
  const broken = Buffer.from(padded);
  broken[base.length - 13] ^= 1;
  await assert.rejects(decodePng(broken, {trailingBytes: 'ignore'}), /IDAT CRC mismatch/);
});

test("PNG ancillary CRC errors: rejected by default, dropped with libpng's default CRC action", async () => {
  const corrupt = (b) => ((b[b.length - 1] ^= 1), b);
  const raw = Buffer.from([0, 9, 8, 7]),
    discard = {ancillaryCrcErrors: 'discard'};
  const plain = await decodePng(png({width: 1, height: 1, type: 2, raw}));
  const iccp = png({
    width: 1,
    height: 1,
    type: 2,
    raw,
    extras: [corrupt(chunk('iCCP', Buffer.from('p\0\0xyz')))],
  });
  await assert.rejects(decodePng(iccp), /iCCP CRC mismatch/);
  assert.deepEqual(await decodePng(iccp, discard), plain);
  // A dropped tRNS keys nothing: the matching color stays opaque.
  const key = Buffer.from([0, 9, 0, 8, 0, 7]);
  const keyed = (tRNS) => png({width: 1, height: 1, type: 2, raw, extras: [tRNS]});
  assert.deepEqual([...(await decodePng(keyed(chunk('tRNS', key)), discard)).pixels], [9, 8, 7, 0]);
  assert.deepEqual(
    [...(await decodePng(keyed(corrupt(chunk('tRNS', key))), discard)).pixels],
    [9, 8, 7, 255],
  );
  // An ancillary chunk after the image data still closes it.
  const after = Buffer.from(png({width: 1, height: 1, type: 2, raw}));
  const tail = after.length - 12;
  const late = Buffer.concat([
    after.subarray(0, tail),
    corrupt(chunk('tEXt', Buffer.from('a\0b'))),
    after.subarray(tail),
  ]);
  assert.deepEqual(await decodePng(late, discard), plain);
  // Critical chunks still fail.
  const idat = Buffer.from(png({width: 1, height: 1, type: 2, raw}));
  idat[idat.length - 13] ^= 1;
  await assert.rejects(decodePng(idat, discard), /IDAT CRC mismatch/);
});
test('PNG rejects CRC errors, wrong scanline length, filters and unknown critical chunks', async () => {
  const good = png({width: 1, height: 1, raw: Buffer.from([0, 1, 2, 3, 4])}),
    bad = Buffer.from(good);
  bad[20] ^= 1;
  await assert.rejects(decodePng(bad), /CRC/);
  await assert.rejects(decodePng(good.subarray(0, -1)), /range|Truncated/);
  for (const raw of [
    Buffer.from([0]),
    Buffer.from([0, 1, 2, 3, 4, 5]),
    Buffer.from([9, 1, 2, 3, 4]),
  ])
    await assert.rejects(decodePng(png({width: 1, height: 1, raw})), /scanlines|filter/);
  await assert.rejects(
    decodePng(
      png({
        width: 1,
        height: 1,
        raw: Buffer.from([0, 1, 2, 3, 4]),
        extras: [chunk('ABCD', Buffer.alloc(0))],
      }),
    ),
    /critical/,
  );
});
test('PNG 8-bit RGB and RGBA rows decode every filter against a reference encoder', async () => {
  let seed = 7;
  const random = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 24;
  const paeth = (a, b, c) => {
    const p = a + b - c,
      pa = Math.abs(p - a),
      pb = Math.abs(p - b),
      pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (const channels of [3, 4])
    for (const width of [1, 2, 4, 5, 33]) {
      const height = 12,
        stride = width * channels,
        // Smooth rows with noise, so Paeth sees all three of its choices.
        samples = Array.from({length: height * stride}, (_, i) => (i * 3 + random()) & 255),
        raw = [];
      for (let y = 0; y < height; y++) {
        const filter = (y + width) % 5;
        raw.push(filter);
        for (let i = 0; i < stride; i++) {
          const at = y * stride + i,
            a = i >= channels ? samples[at - channels] : 0,
            b = y ? samples[at - stride] : 0,
            c = y && i >= channels ? samples[at - stride - channels] : 0;
          const prediction = [0, a, b, (a + b) >>> 1, paeth(a, b, c)][filter];
          raw.push((samples[at] - prediction) & 255);
        }
      }
      const image = await decodePng(
        png({width, height, type: channels === 4 ? 6 : 2, raw: Buffer.from(raw)}),
      );
      const expected = [];
      for (let p = 0; p < width * height; p++)
        expected.push(
          ...samples.slice(p * channels, p * channels + 3),
          channels === 4 ? samples[p * 4 + 3] : 255,
        );
      assert.deepEqual([...image.pixels], expected, `${channels} channels, width ${width}`);
    }
});
test('PNG CRC matches zlib for every length around its 8-byte blocks', () => {
  const bytes = Uint8Array.from({length: 300}, (_, i) => (i * 131 + 7) & 255);
  for (let length = 0; length <= bytes.length; length++)
    assert.equal(pngCrc(bytes.subarray(0, length)), crc32(bytes.subarray(0, length)));
});

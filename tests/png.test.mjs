import {test} from 'node:test';
import assert from 'node:assert/strict';
import {decodePng} from '../dist/formats/png/decode.js';
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

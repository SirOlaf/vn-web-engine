import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
  decodeGpuTexture,
  gpuTextureByteLength,
  gpuTextureDecodeCommands,
  packedGpuTexture,
} from '../dist/graphics/block-texture.js';
import {GpuRenderSurface} from '../dist/graphics/gpu-render-surface.js';

// Seeded random blocks; the expected hashes are Pillow's BCn decode of the same bytes, with
// reserved BC7 blocks set to zero as D3D11 decodes them (Pillow returns opaque black).
function seeded(seed, length) {
  const bytes = new Uint8Array(length);
  let s = seed >>> 0;
  for (let i = 0; i < length; i++) {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    bytes[i] = s & 0xff;
  }
  return bytes;
}
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('BC1, BC2, BC3 and BC7 blocks decode to the reference texels', () => {
  const cases = [
    ['bc1', 0x1234567, 'deb6624d85db0f00a20ff49c308e2051e7b330c06d7a42e1daf58d2c50f0fe39'],
    ['bc2', 0x2345678, '45eecbde575b978105b2eba6ebd0c1e4be0d5aa907c86b093958d8d1f9a31008'],
    ['bc3', 0x3456789, '223056fa7b709582df49cd884d221226e78dbad275ee7390881b42dba52f3afa'],
    ['bc7', 0x456789a, '615d4dcb5e0c7be7cde3196f1b289ad85d473510363722b4a3ff24e39c128c8d'],
  ];
  for (const [format, seed, hash] of cases) {
    const bytes = seeded(seed, gpuTextureByteLength(format, 64, 32));
    // Every BC7 mode, and the reserved mode, appears in turn.
    if (format === 'bc7')
      for (let k = 0; k < 128; k++) {
        const m = k % 9,
          o = k * 16;
        bytes[o] = m === 8 ? 0 : (bytes[o] & ~((1 << (m + 1)) - 1) & 0xff) | (1 << m);
      }
    assert.equal(sha(decodeGpuTexture(format, 64, 32, bytes)), hash, format);
  }
});

test('linear formats decode to the D3D sampled channels', () => {
  assert.deepEqual(
    [...decodeGpuTexture('r8', 2, 1, Uint8Array.of(7, 9))],
    [7, 0, 0, 255, 9, 0, 0, 255],
  );
  assert.deepEqual([...decodeGpuTexture('a8', 1, 1, Uint8Array.of(7))], [0, 0, 0, 7]);
  assert.deepEqual([...decodeGpuTexture('r8g8', 1, 1, Uint8Array.of(7, 9))], [7, 9, 0, 255]);
  assert.deepEqual(
    [...decodeGpuTexture('b8g8r8a8', 1, 1, Uint8Array.of(1, 2, 3, 4))],
    [3, 2, 1, 4],
  );
});

test('partial blocks crop and packed uploads keep whole block rows', () => {
  const bytes = seeded(99, gpuTextureByteLength('bc1', 6, 5));
  assert.equal(bytes.length, 2 * 2 * 8);
  const full = decodeGpuTexture('bc1', 8, 8, bytes),
    cropped = decodeGpuTexture('bc1', 6, 5, bytes);
  for (let y = 0; y < 5; y++)
    assert.deepEqual(cropped.subarray(y * 24, y * 24 + 24), full.subarray(y * 32, y * 32 + 24));
  const packed = packedGpuTexture('bc1', 6, 5, bytes);
  assert.deepEqual([packed.width, packed.height], [4, 2]);
  assert.equal(packed.pixels.buffer, bytes.buffer);
  const r8 = packedGpuTexture('r8', 3, 2, Uint8Array.of(1, 2, 3, 4, 5, 6));
  assert.deepEqual([r8.width, r8.height, ...r8.pixels], [1, 2, 1, 2, 3, 0, 4, 5, 6, 0]);
  assert.throws(() => packedGpuTexture('bc7', 4, 4, new Uint8Array(15)));
});

test('decode commands replace the whole surface with pixel-addressed texels', () => {
  const surface = new GpuRenderSurface(6, 5),
    [target, draw] = gpuTextureDecodeCommands('bc7', 3, surface);
  assert.deepEqual(target, {kind: 'gpu-target', surface, clearColor: [0, 0, 0, 0]});
  assert.equal(draw.texture, 3);
  assert.equal(draw.normalizedUV, true);
  assert.equal(draw.discardTransparent, false);
  assert.deepEqual(draw.blendState.color, {source: 'one', destination: 'zero', operation: 'add'});
  assert.match(draw.fragment, /vec4 shade\(/);
  const corners = [];
  for (let i = 0; i < draw.vertices.length; i += 9)
    corners.push([
      draw.vertices[i],
      draw.vertices[i + 1],
      draw.vertices[i + 7],
      draw.vertices[i + 8],
    ]);
  assert.deepEqual(corners, [
    [0, 0, 0, 0],
    [6, 0, 6, 0],
    [0, 5, 0, 5],
    [6, 5, 6, 5],
  ]);
});

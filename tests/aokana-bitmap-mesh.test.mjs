import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBitmapStorage} from '../dist/engines/buriko/games/aokana/native/bitmap.js';
import {AokanaBitmapCompositor} from '../dist/engines/buriko/games/aokana/native/bitmap-compositor.js';
import {
  blendAokanaBitmapMeshAlphaIntoRgb32,
  blendAokanaBitmapMeshRgb32,
  buildAokanaMeshScanlines,
  buildAokanaMeshVertices,
  copyAokanaBitmapMesh32,
  drawAokanaBitmapMesh,
} from '../dist/engines/buriko/games/aokana/native/bitmap-mesh.js';
import {aokanaBitmapMeshOperationStrips} from '../dist/engines/buriko/games/aokana/native/bitmap-operation-jobs.js';
import {
  AokanaDistributedAllocator,
  AokanaDistributedProcessing,
} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';

function bitmap(width, height, values, format = 2, padding = 0) {
  const stride = width * 4 + padding;
  const bytes = new Uint8Array(stride * height).fill(0xa5);
  const view = new DataView(bytes.buffer);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      view.setUint32(y * stride + x * 4, values[y * width + x] ?? 0, true);
  return {
    storage: new AokanaBitmapStorage(bytes, true),
    offset: 0,
    stride,
    width,
    height,
    format,
    bytesPerPixel: 4,
  };
}

function pixels(value) {
  return Array.from({length: value.height}, (_, y) =>
    Array.from({length: value.width}, (_, x) =>
      value.storage.view.getUint32(value.offset + y * value.stride + x * 4, true),
    ),
  ).flat();
}

function identityGeometry(source) {
  return {
    destinationPivotX: 0,
    destinationPivotY: 0,
    source,
    sourcePivotX: 0,
    sourcePivotY: 0,
    scaleX: 65536,
    scaleY: 65536,
    translationX: 0,
    translationY: 0,
    translationZ: 0,
    pitch: 0,
    heading: 0,
    bank: 0,
    rotationOrder: 0,
    perspective: 0,
  };
}

function scanline(left, right, values = {}) {
  return {
    left,
    right,
    q: 1,
    uq: 0,
    vq: 0,
    dq: 0,
    duq: 1,
    dvq: 0,
    ...values,
  };
}

test('mesh vertices preserve native corner order and asymmetric depth projection', () => {
  const source = bitmap(3, 2, Array(6).fill(0));
  assert.deepEqual(buildAokanaMeshVertices(identityGeometry(source)), [
    {x: 0, y: 0, q: 1, uq: 0, vq: 0},
    {x: 0, y: 1, q: 1, uq: 0, vq: 1},
    {x: 2, y: 1, q: 1, uq: 2, vq: 1},
    {x: 2, y: 0, q: 1, uq: 2, vq: 0},
  ]);

  const translated = {
    ...identityGeometry(source),
    destinationPivotX: 32768,
    destinationPivotY: 16384,
    translationX: 65536,
    translationY: -65536,
    translationZ: 65536,
    rotationOrder: 5,
    perspective: 100,
  };
  const positive = buildAokanaMeshVertices(translated)[0];
  const positiveQ = 100 / 101;
  assert.deepEqual(positive, {
    x: Math.fround(positiveQ + 0.5),
    y: Math.fround(-positiveQ + 0.25),
    q: Math.fround(positiveQ),
    uq: 0,
    vq: 0,
  });
  const negative = buildAokanaMeshVertices({...translated, translationZ: -65536})[0];
  const negativeQ = 101 / 100;
  assert.deepEqual(negative, {
    x: Math.fround(negativeQ + 0.5),
    y: Math.fround(-negativeQ + 0.25),
    q: Math.fround(negativeQ),
    uq: 0,
    vq: 0,
  });
});

test('mesh scanlines retain inclusive rectangle bounds and Q/UQ/VQ increments', () => {
  const source = bitmap(3, 2, Array(6).fill(0));
  assert.deepEqual(
    buildAokanaMeshScanlines(buildAokanaMeshVertices(identityGeometry(source)), 10),
    {
      records: [scanline(0, 2), scanline(0, 2, {vq: 1})],
      firstRow: 0,
      bounds: {left: 0, top: 0, right: 2, bottom: 1},
    },
  );
});

test('mesh scanlines expand a point top from the next edges and keep the bottom sentinel row', () => {
  const vertices = [
    {x: 1, y: 0, q: 1, uq: 1, vq: 0},
    {x: 0, y: 1, q: 1, uq: 0, vq: 1},
    {x: 1, y: 2, q: 1, uq: 1, vq: 2},
    {x: 2, y: 1, q: 1, uq: 2, vq: 1},
  ];
  assert.deepEqual(buildAokanaMeshScanlines(vertices, 10), {
    records: [
      scanline(0, 2),
      scanline(0, 2, {vq: 1}),
      {left: 0x7fffffff, right: -0x80000000, q: 0, uq: 0, vq: 0, dq: 0, duq: 0, dvq: 0},
    ],
    firstRow: 0,
    bounds: {left: 0, top: 0, right: 2, bottom: 2},
  });
});

test('mesh copy bilinearly samples matching formats and clears every uncovered pixel', () => {
  const source = bitmap(2, 1, [0x10203040, 0x50607080]);
  const destination = bitmap(3, 2, Array(6).fill(0xdeadbeef), 2, 4);
  copyAokanaBitmapMesh32(destination, source, [scanline(0, 1)], 1);
  assert.deepEqual(pixels(destination), [0, 0, 0, 0x10203040, 0x50607080, 0]);
  assert.deepEqual(Array.from(destination.storage.bytes.slice(12, 16)), [0xa5, 0xa5, 0xa5, 0xa5]);
  assert.deepEqual(Array.from(destination.storage.bytes.slice(28, 32)), [0xa5, 0xa5, 0xa5, 0xa5]);
});

test('mesh RGB blending applies the native Q8 transparency through signed word products', () => {
  const source = bitmap(2, 1, [0x10203040, 0x50607080], 1);
  const destination = bitmap(2, 1, [0x20202020, 0x20202020], 1);
  blendAokanaBitmapMeshRgb32(destination, source, [scanline(0, 1)], 0, 0, 128);
  assert.deepEqual(pixels(destination), [0x18202830, 0x38404850]);
});

test('mesh alpha blending combines sampled alpha with inverse Q8 transparency', () => {
  const source = bitmap(1, 1, [0x8080a0c0], 2);
  const destination = bitmap(1, 1, [0x20406080], 1);
  blendAokanaBitmapMeshAlphaIntoRgb32(destination, source, [scanline(0, 0)], 0, 0, 0);
  assert.deepEqual(pixels(destination), [0x506080a0]);
});

test('mode-four mesh metadata intersects records with each actual destination strip', () => {
  const jobs = [[bitmap(1, 3, [0, 0, 0])], [bitmap(1, 3, [0, 0, 0])], [bitmap(1, 4, [0, 0, 0, 0])]];
  assert.deepEqual(aokanaBitmapMeshOperationStrips(['a', 'b', 'c', 'd'], 4, jobs), [
    {records: [], firstRow: 4},
    {records: ['a', 'b'], firstRow: 1},
    {records: ['c', 'd'], firstRow: 0},
  ]);
});

test('mesh dispatch uses the compositor attached shared processing owner for mode four', () => {
  const processing = new AokanaDistributedProcessing(new AokanaDistributedAllocator(3), 3);
  const compositor = new AokanaBitmapCompositor();
  compositor.processing = processing;
  const source = bitmap(1, 1, [0x12345678]);
  const destination = bitmap(64, 64, Array(64 * 64).fill(0xffffffff));
  drawAokanaBitmapMesh(compositor, destination, source, [scanline(0, 0)], 20, 0, 0, 0, true);
  const expected = Array(64 * 64).fill(0);
  expected[20 * 64] = 0x12345678;
  assert.equal(compositor.processing, processing);
  assert.deepEqual(pixels(destination), expected);
});

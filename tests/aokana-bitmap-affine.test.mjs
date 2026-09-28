import test from 'node:test';
import assert from 'node:assert/strict';
import {WasmPixelWorkspace} from '../dist/graphics/wasm-pixel-workspace.js';
import {BurikoBitmapStorage} from '../dist/engines/buriko/native/bitmap.js';
import {BurikoBitmapCompositor} from '../dist/engines/buriko/native/bitmap-compositor.js';
import {
  burikoAlignedAffineSource,
  burikoBitmapAffineCoordinates,
  blendTransformedBurikoBitmap,
  transformBurikoBitmap,
} from '../dist/engines/buriko/native/bitmap-affine.js';
import {burikoBitmapOperationPoints} from '../dist/engines/buriko/native/bitmap-operation-jobs.js';
import {
  BurikoDistributedAllocator,
  BurikoDistributedProcessing,
} from '../dist/engines/buriko/native/distributed-processing.js';

const identity = {x: 0, y: 0, pivotX: 0, pivotY: 0, angle: 0, scaleX: 65536, scaleY: 65536};
const gray = (value) => Math.imul(value, 0x1010101) >>> 0;
function bitmap(width, height, values, format = 2, padding = 0) {
  const stride = width * 4 + padding;
  const bytes = new Uint8Array(stride * height).fill(0xa5);
  const view = new DataView(bytes.buffer);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      view.setUint32(y * stride + x * 4, values[y * width + x] ?? 0, true);
  return {
    storage: new BurikoBitmapStorage(bytes, true),
    offset: 0,
    stride,
    width,
    height,
    format,
    bytesPerPixel: 4,
  };
}
function pixels(bitmap) {
  return Array.from({length: bitmap.height}, (_, y) =>
    Array.from({length: bitmap.width}, (_, x) =>
      bitmap.storage.view.getUint32(bitmap.offset + y * bitmap.stride + x * 4, true),
    ),
  ).flat();
}

test('affine integral containment crops the actual source and retains row padding', () => {
  const compositor = new BurikoBitmapCompositor();
  const source = bitmap(
    5,
    4,
    Array.from({length: 20}, (_, i) => gray(i + 1)),
    2,
    4,
  );
  const destination = bitmap(2, 2, [0, 0, 0, 0], 2, 4);
  const transform = {...identity, x: 65536, pivotX: 2 * 65536, pivotY: 65536};
  const aligned = burikoAlignedAffineSource(destination, source, transform);
  assert.equal(aligned.storage, source.storage);
  assert.equal(aligned.offset, source.stride + 4);
  assert.equal(aligned.width, 2);
  assert.equal(aligned.height, 2);
  assert.equal(transformBurikoBitmap(compositor, destination, source, transform, 0, 1), 0);
  assert.deepEqual(pixels(destination), [7, 8, 12, 13].map(gray));
  assert.deepEqual(Array.from(destination.storage.bytes.slice(8, 12)), [165, 165, 165, 165]);
  const coordinates = burikoBitmapAffineCoordinates(identity);
  assert.deepEqual(coordinates, {
    startX: 0,
    startY: 0,
    columnX: 65536,
    columnY: 0,
    rowX: 0,
    rowY: 65536,
  });
});

test('affine nearest rotation follows the independent row and column increments', () => {
  const source = bitmap(2, 3, [1, 2, 3, 4, 5, 6].map(gray));
  const destination = bitmap(3, 2, Array(6).fill(0));
  const transform = {...identity, pivotX: 65536, angle: 90 * 65536};
  transformBurikoBitmap(new BurikoBitmapCompositor(), destination, source, transform, 0, 0);
  assert.deepEqual(pixels(destination), [2, 4, 6, 1, 3, 5].map(gray));
});

test('affine bilinear uses four-bit fractions, horizontal flooring, and zero border samples', () => {
  const compositor = new BurikoBitmapCompositor();
  const source = bitmap(2, 2, [1, 6, 12, 21].map(gray));
  const center = bitmap(1, 1, [0]);
  transformBurikoBitmap(compositor, center, source, {...identity, x: -0x8fff, y: -0x8fff}, 0, 1);
  assert.deepEqual(pixels(center), [gray(9)]);
  const destination = bitmap(3, 3, Array(9).fill(0));
  transformBurikoBitmap(compositor, destination, source, {...identity, x: 0x8000, y: 0x8000}, 0, 1);
  assert.deepEqual(pixels(destination), [0, 1, 1, 3, 9, 6, 3, 8, 5].map(gray));
});

test('affine copy dimming preserves alpha and RGB conversion supplies covered alpha', () => {
  const compositor = new BurikoBitmapCompositor();
  const transform = {...identity, x: -1};
  const input = [0x10101010, 0x20303030, 0x30505050];
  for (const sampling of [0, 1]) {
    const destination = bitmap(3, 1, [0, 0, 0]);
    transformBurikoBitmap(compositor, destination, bitmap(3, 1, input), transform, 128, sampling);
    assert.deepEqual(pixels(destination), [0x10080808, 0x20181818, 0x30282828]);
    transformBurikoBitmap(
      compositor,
      destination,
      bitmap(3, 1, input, 1),
      transform,
      128,
      sampling,
    );
    assert.deepEqual(pixels(destination), [0xff080808, 0xff181818, 0xff282828]);
  }
});

test('affine blending retains Q7 RGB and alpha-table coefficients in pair and tail pixels', () => {
  const compositor = new BurikoBitmapCompositor();
  const transform = {...identity, x: -1};
  for (const sampling of [0, 1]) {
    const destination = bitmap(3, 1, [200, 200, 200].map(gray), 1);
    blendTransformedBurikoBitmap(
      compositor,
      destination,
      bitmap(3, 1, [16, 48, 80].map(gray), 1),
      transform,
      3,
      sampling,
    );
    assert.deepEqual(pixels(destination), [17, 49, 80].map(gray));
    const alphaTarget = bitmap(3, 1, Array(3).fill(0x07282828), 1);
    const alphaSource = bitmap(3, 1, [0x00646464, 0x80c8c8c8, 0xfef0f0f0]);
    blendTransformedBurikoBitmap(compositor, alphaTarget, alphaSource, transform, 64, sampling);
    assert.deepEqual(pixels(alphaTarget), [0x07282828, 0x07646464, 0x07bebebe]);
  }
});

test('affine temporary output initializes pixels while preserving unwritten row padding', () => {
  const source = bitmap(3, 2, [1, 2, 3, 4, 5, 6].map(gray));
  const destination = bitmap(3, 2, Array(6).fill(0), 2, 4);
  destination.storage = new BurikoBitmapStorage(destination.storage.bytes, false);
  transformBurikoBitmap(
    new BurikoBitmapCompositor(),
    destination,
    source,
    {...identity, x: -1},
    0,
    0,
  );
  assert.deepEqual(pixels(destination), [1, 2, 3, 4, 5, 6].map(gray));
  for (const offset of [0, 16]) {
    assert.doesNotThrow(() => destination.storage.range(offset, 12, true));
    assert.throws(() => destination.storage.range(offset + 12, 4, true), /unwritten/);
    assert.deepEqual(
      [...destination.storage.bytes.slice(offset + 12, offset + 16)],
      [165, 165, 165, 165],
    );
  }
});

test('large affine copies and dims agree across independent and shared backing with cropped and padded rows', () => {
  const compositor = new BurikoBitmapCompositor();
  const source = bitmap(
    73,
    39,
    Array.from({length: 73 * 39}, (_, i) => Math.imul(i + 1, 0x7193abcf) >>> 0),
    2,
    12,
  );
  source.offset = source.stride + 4;
  source.width -= 2;
  source.height -= 2;
  // RGB sources force covered alpha into alpha destinations and always dim, with
  // native 16-bit wrapping of 256 - transparency.
  for (const [format, transparency] of [
    [2, 0],
    [2, 96],
    [1, 0],
    [1, 300],
  ])
    for (const sampling of [0, 1])
      for (const transform of [
        {...identity, x: 0x9000, y: -0x3000},
        {...identity, angle: 7 * 65536, scaleX: 70000, scaleY: 55000},
        {...identity, x: -0x7fff8000, y: 0x7fff8000},
        {...identity, scaleX: 1, scaleY: 1},
      ]) {
        const destination = bitmap(65, 19, [], 2, 8);
        destination.storage = new BurikoBitmapStorage(destination.storage.bytes, false);
        const inputLength = source.storage.bytes.length,
          outputStart = inputLength + 8,
          shared = new Uint8Array(outputStart + destination.storage.bytes.length);
        shared.set(source.storage.bytes);
        shared.set(destination.storage.bytes, outputStart);
        const sharedSource = {
          ...source,
          format,
          storage: new BurikoBitmapStorage(shared.subarray(0, inputLength), true),
        };
        const sharedDestination = {
          ...destination,
          storage: new BurikoBitmapStorage(shared.subarray(outputStart), false),
        };
        // Separate views of one buffer retain the checked JavaScript traversal.
        transformBurikoBitmap(
          compositor,
          sharedDestination,
          sharedSource,
          transform,
          transparency,
          sampling,
        );
        transformBurikoBitmap(
          compositor,
          destination,
          {...source, format},
          transform,
          transparency,
          sampling,
        );
        assert.deepEqual(destination.storage.bytes, sharedDestination.storage.bytes);
        assert.deepEqual(
          destination.storage.initializedRange(0, destination.storage.bytes.length),
          sharedDestination.storage.initializedRange(0, sharedDestination.storage.bytes.length),
        );
        assert.deepEqual(shared.subarray(0, inputLength), source.storage.bytes);
      }
});

test('affine pairs retain alias order and completed stores before a later source fault', () => {
  const compositor = new BurikoBitmapCompositor();
  const transform = {...identity, x: -1};
  const shared = bitmap(4, 1, [1, 2, 3, 4].map(gray));
  transformBurikoBitmap(compositor, {...shared, offset: 4, width: 3}, shared, transform, 0, 0);
  assert.deepEqual(pixels(shared), [1, 1, 2, 2].map(gray));

  const source = bitmap(4, 1, [1, 2, 3, 4].map(gray));
  source.storage = new BurikoBitmapStorage(source.storage.bytes, false);
  source.storage.written(0, 8);
  const destination = bitmap(4, 1, [0, 0, 0, 0]);
  destination.storage = new BurikoBitmapStorage(destination.storage.bytes, false);
  assert.throws(
    () => transformBurikoBitmap(compositor, destination, source, transform, 0, 0),
    /unwritten/,
  );
  assert.deepEqual(pixels(destination), [gray(1), gray(2), 0, 0]);
  assert.doesNotThrow(() => destination.storage.range(0, 8, true));
  assert.throws(() => destination.storage.range(8, 8, true), /unwritten/);
});

test('initialized affine alpha agrees with shared-buffer traversal across transforms and borders', () => {
  const compositor = new BurikoBitmapCompositor();
  let seed = 0x58a771;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  function compare(source, destination, transform, transparency, sampling) {
    const inputLength = source.storage.bytes.length,
      outputStart = inputLength + 7,
      shared = new Uint8Array(outputStart + destination.storage.bytes.length);
    shared.set(source.storage.bytes);
    shared.set(destination.storage.bytes, outputStart);
    const sharedSource = {
      ...source,
      storage: new BurikoBitmapStorage(shared.subarray(0, inputLength), true),
    };
    const sharedDestination = {
      ...destination,
      storage: new BurikoBitmapStorage(shared.subarray(outputStart), true),
    };
    // Even disjoint views of the same backing buffer retain the scalar pair traversal.
    blendTransformedBurikoBitmap(
      compositor,
      sharedDestination,
      sharedSource,
      transform,
      transparency,
      sampling,
    );
    blendTransformedBurikoBitmap(
      compositor,
      destination,
      source,
      transform,
      transparency,
      sampling,
    );
    assert.deepEqual(destination.storage.bytes, sharedDestination.storage.bytes);
    assert.deepEqual(shared.subarray(0, inputLength), source.storage.bytes);
  }
  for (let iteration = 0; iteration < 120; iteration++) {
    const large = iteration % 4 < 2,
      width = large ? 97 + (random() % 32) : 5 + (random() % 17),
      height = large ? 80 + (random() % 23) : 5 + (random() % 13);
    const source = bitmap(
      width,
      height,
      Array.from(
        {length: width * height},
        (_, i) => (([0, 1, 2, 127, 128, 253, 254, 255][i % 8] << 24) | (random() & 0xffffff)) >>> 0,
      ),
      2,
      12,
    );
    source.offset = source.stride + 4;
    source.width -= 2;
    source.height -= 2;
    const outputWidth = large ? 33 + (iteration % 31) : 1 + (iteration % 19),
      outputHeight = large ? 37 : 7,
      destination = bitmap(
        outputWidth,
        outputHeight,
        Array.from({length: outputWidth * outputHeight}, random),
        1,
        8,
      );
    // Also exercise byte-unaligned source offsets and DataView byte offsets.
    if (iteration % 3 === 0) source.offset++;
    const transform =
      iteration % 3 === 0
        ? {...identity, x: (random() % 0x60000) - 0x30000, y: (random() % 0x60000) - 0x30000}
        : {
            ...identity,
            x: (random() % 0x100000) - 0x80000,
            y: (random() % 0x100000) - 0x80000,
            pivotX: (random() % 0x80000) - 0x40000,
            pivotY: (random() % 0x80000) - 0x40000,
            angle: (random() % (360 * 65536)) - 180 * 65536,
            scaleX: 1 + (random() % 150000),
            scaleY: 1 + (random() % 150000),
          };
    compare(
      source,
      destination,
      transform,
      [0, 1, 3, 64, 128, 254, 255][iteration % 7],
      iteration % 2,
    );
  }
  for (const sampling of [0, 1]) {
    const source = bitmap(5, 3, Array.from({length: 15}, random));
    for (const transform of [
      {...identity, x: 0x1ffff, y: 0x1ffff},
      {...identity, x: -0x7fff8000, y: 0x7fff8000},
      {...identity, x: -1, scaleX: 1, scaleY: 2},
      {...identity, x: -1, scaleX: 2, scaleY: 1},
      {...identity, x: -1, scaleX: 0xffffffff, scaleY: 0xffffffff},
    ])
      compare(source, bitmap(9, 5, Array.from({length: 45}, random), 1), transform, 0, sampling);
    // Signed source bounds and Q16 additions meet their positive WORD limit here.
    for (const [width, height, pivotX, pivotY] of [
      [32767, 2, 0x7ffe7000, 0],
      [2, 32767, 0, 0x7ffe7000],
    ])
      compare(
        bitmap(width, height, Array.from({length: width * height}, random)),
        bitmap(5, 5, Array.from({length: 25}, random), 1),
        {...identity, pivotX, pivotY},
        3,
        sampling,
      );
    // Large initialized inputs must remain useful for narrow output strips.
    compare(
      bitmap(1920, 1080, Array.from({length: 1920 * 1080}, random)),
      bitmap(1920, 3, Array.from({length: 1920 * 3}, random), 1, 8),
      {...identity, x: 0x9000, y: -0x3000},
      64,
      sampling,
    );
  }
});

test('affine alpha retains skipped pairs, read-before-store faults, and alias order', () => {
  const compositor = new BurikoBitmapCompositor();
  const transform = {...identity, x: -1};
  for (const sampling of [0, 1]) {
    const source = bitmap(3, 1, [0x00ffffff, 0x00010203, 0x00000000]);
    const skipped = bitmap(3, 1, [0x71557799, 0x82446688, 0x93335577], 1);
    skipped.storage = new BurikoBitmapStorage(skipped.storage.bytes, false);
    blendTransformedBurikoBitmap(compositor, skipped, source, transform, 0, sampling);
    assert.deepEqual(pixels(skipped), [0x71557799, 0x82446688, 0x93335577]);
    assert.deepEqual([...skipped.storage.initializedRange(0, 12)], Array(12).fill(0));

    const mixedPair = bitmap(2, 1, [0x07282828, 0x08383838], 1);
    mixedPair.storage = new BurikoBitmapStorage(mixedPair.storage.bytes, false);
    mixedPair.storage.written(0, 4);
    assert.throws(
      () =>
        blendTransformedBurikoBitmap(
          compositor,
          mixedPair,
          bitmap(2, 1, [0xffabcdef, 0x00000000]),
          transform,
          0,
          sampling,
        ),
      /unwritten/,
    );
    assert.deepEqual(pixels(mixedPair), [0x07282828, 0x08383838]);

    const alias = bitmap(4, 1, [0xff010101, 0xff020202, 0xff030303, 0xff040404]);
    blendTransformedBurikoBitmap(
      compositor,
      {...alias, offset: 4, width: 3, format: 1},
      alias,
      transform,
      0,
      sampling,
    );
    assert.deepEqual(pixels(alias), [0xff010101, 0xff010101, 0xff020202, 0xff020202]);
  }
  const source = bitmap(4, 1, [0xff010101, 0xff020202, 0xff030303, 0xff040404]);
  source.storage = new BurikoBitmapStorage(source.storage.bytes, false);
  source.storage.written(0, 8);
  const destination = bitmap(4, 1, Array(4).fill(0x77000000), 1);
  assert.throws(
    () => blendTransformedBurikoBitmap(compositor, destination, source, transform, 0, 0),
    /unwritten/,
  );
  assert.deepEqual(pixels(destination), [0x77010101, 0x77020202, 0x77000000, 0x77000000]);
  source.storage.release();
  assert.throws(
    () => blendTransformedBurikoBitmap(compositor, destination, source, transform, 0, 0),
    /released/,
  );
});

test('affine distributed jobs retain the real shared pool and subtract completed Q16 rows', () => {
  const processing = new BurikoDistributedProcessing(new BurikoDistributedAllocator(3), 3);
  const compositor = new BurikoBitmapCompositor();
  compositor.processing = processing;
  const source = bitmap(
    70,
    105,
    Array.from({length: 70 * 105}, (_, i) => gray((i * 13) & 255)),
  );
  const destination = bitmap(65, 101, Array(65 * 101).fill(0));
  const transform = {...identity, x: -32768, y: -32768};
  const plan = {count: 3, increment: Math.floor((101 * 65536) / 3)};
  assert.deepEqual(burikoBitmapOperationPoints([transform.x, transform.y], plan), [
    [-32768, -32768],
    [-32768, -32768 - 33 * 65536],
    [-32768, -32768 - 67 * 65536],
  ]);
  transformBurikoBitmap(compositor, destination, source, transform, 0, 0, true);
  assert.equal(compositor.processing, processing);
  assert.deepEqual(
    pixels(destination),
    Array.from({length: 65 * 101}, (_, i) =>
      gray((((Math.floor(i / 65) + 1) * 70 + (i % 65) + 1) * 13) & 255),
    ),
  );
});

test(
  'independent WASM planes optionally preserve destination pixels and leave rejected output untouched',
  {skip: typeof WebAssembly === 'undefined'},
  () => {
    const memory = new WebAssembly.Memory({initial: 1, maximum: 1}),
      workspace = new WasmPixelWorkspace({
        memory,
        __heap_base: new WebAssembly.Global({value: 'i32', mutable: false}, 17),
      }),
      sourceBytes = new Uint8Array(24).fill(0xe1),
      destinationBytes = new Uint8Array(32).fill(0xd2),
      source = {
        view: new DataView(sourceBytes.buffer, 3, 16),
        offset: 1,
        pitch: 5,
        rowBytes: 3,
        rows: 2,
      },
      destination = {
        view: new DataView(destinationBytes.buffer, 2, 24),
        offset: 2,
        pitch: 6,
        rowBytes: 4,
        rows: 3,
      };
    sourceBytes.set([1, 2, 3], 4);
    sourceBytes.set([4, 5, 6], 9);
    destinationBytes.set([10, 20, 30, 40], 4);
    destinationBytes.set([50, 60, 70, 80], 10);
    destinationBytes.set([90, 100, 110, 120], 16);
    const expected = destinationBytes.slice(),
      originalSource = sourceBytes.slice();
    expected[4] = 16;
    expected[19] = 121;
    assert.equal(
      workspace.transform(
        source,
        destination,
        (input, output) => {
          const staged = new Uint8Array(memory.buffer);
          assert.deepEqual([...staged.subarray(input, input + 6)], [1, 2, 3, 4, 5, 6]);
          assert.deepEqual(
            [...staged.subarray(output, output + 12)],
            [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120],
          );
          staged[output] += staged[input + 5];
          staged[output + 11] += staged[input];
        },
        true,
      ),
      true,
    );
    assert.deepEqual(
      destinationBytes,
      expected,
      'retained pixels and external row padding survive',
    );
    assert.deepEqual(sourceBytes, originalSource);

    new Uint8Array(memory.buffer).fill(0x8a);
    assert.equal(
      workspace.transform(source, destination, (_input, output) => {
        const staged = new Uint8Array(memory.buffer);
        assert.deepEqual(staged.subarray(output, output + 12), new Uint8Array(12).fill(0x8a));
        staged.fill(0x3c, output, output + 12);
      }),
      true,
    );
    for (const offset of [4, 10, 16]) expected.fill(0x3c, offset, offset + 4);
    assert.deepEqual(destinationBytes, expected, 'default mode does not stage the old destination');
    const rejected = () => assert.fail('Rejected staging must not invoke its kernel');
    assert.equal(
      workspace.transform({...source, view: destination.view}, destination, rejected, true),
      false,
    );
    assert.equal(workspace.transform(source, {...destination, pitch: 3}, rejected, true), false);
    assert.equal(workspace.transform(source, {...destination, offset: 23}, rejected, true), false);
    assert.deepEqual(destinationBytes, expected);
  },
);

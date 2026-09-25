import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {bitmapRead32} from '../dist/engines/buriko/games/aokana/native/bitmap-scalar.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted VM generated displacement maps feed bound vector sampling', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, memory, child, definitions, fragments, invoke} = fixture;
  const call = async (primary, secondary, args, pushed = false) => {
    assert.equal(await invoke(primary, secondary, args, 0), Number(pushed));
    const result = pushed ? pop32(child.state) : undefined;
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
    return result;
  };
  const pixels = (index) => {
    const bitmap = graph.surfaces.snapshot(index);
    assert.ok(bitmap);
    return Array.from({length: bitmap.width * bitmap.height}, (_, position) =>
      bitmapRead32(
        bitmap,
        bitmap.offset +
          Math.floor(position / bitmap.width) * bitmap.stride +
          (position % bitmap.width) * 4,
      ),
    );
  };
  const vectors = (index) => {
    const bitmap = graph.surfaces.snapshot(index);
    assert.ok(bitmap);
    assert.equal(bitmap.format, 4);
    return Array.from({length: bitmap.width * bitmap.height}, (_, position) => {
      const offset =
        bitmap.offset +
        Math.floor(position / bitmap.width) * bitmap.stride +
        (position % bitmap.width) * 4;
      return [
        bitmap.storage.view.getInt16(offset, true),
        bitmap.storage.view.getInt16(offset + 2, true),
      ];
    });
  };
  const importRgb = async (index, width, height, colors, pointer) => {
    const bytes = new Uint8Array(colors.length * 3);
    for (let i = 0; i < colors.length; i++) {
      bytes[i * 3] = colors[i] & 255;
      bytes[i * 3 + 1] = (colors[i] >>> 8) & 255;
      bytes[i * 3 + 2] = (colors[i] >>> 16) & 255;
    }
    memory.globalMemory.set(bytes, pointer);
    await call(0x90, 0x14, [index, width, height, 1, pointer]);
    assert.deepEqual(pixels(index), colors);
  };
  try {
    assert.equal(graph.surfaces.fonts, graph.fonts);
    assert.equal(graph.surfaces.compositor, graph.compositor);
    assert.equal(graph.surfaces.allocator, graph.allocator);
    assert.equal(graph.resource.errors.files.text, graph.text);
    assert.deepEqual(
      definitions
        .filter(
          ({primary, secondary}) => primary === 0x91 && secondary >= 0x12 && secondary <= 0x17,
        )
        .map(({secondary}) => secondary)
        .sort((a, b) => a - b),
      [0x12, 0x13, 0x14, 0x15, 0x16, 0x17],
    );
    assert.equal(fragments.nativeDefinitions().length, definitions.length);

    const mapCases = [
      {slot: 0x12, index: 0, width: 1, height: 1, args: [0, 0, 2, 0, 1024], words: [[32, 32]]},
      {
        slot: 0x13,
        index: 1,
        width: 2,
        height: 2,
        args: [-1, -1, 0, 2],
        words: [
          [10, 45],
          [-6, 71],
          [9, 55],
          [-6, 74],
        ],
      },
      {
        slot: 0x14,
        index: 2,
        width: 2,
        height: 2,
        args: [-1, -1, 60 * 65536, 4],
        words: [
          [-1, -1],
          [-5, -1],
          [-1, -5],
          [-5, -5],
        ],
      },
      {
        slot: 0x15,
        index: 3,
        width: 2,
        height: 2,
        args: [1, 1, 1, 1],
        words: [
          [0, 0],
          [0, 8192],
          [8192, 0],
          [-8192, -8192],
        ],
      },
      {
        slot: 0x16,
        index: 4,
        width: 2,
        height: 2,
        args: [4, 0, 1, 4, 0, 1],
        words: [
          [0, 0],
          [0, 16],
          [16, 0],
          [16, 16],
        ],
      },
      {
        slot: 0x17,
        index: 5,
        width: 2,
        height: 1,
        args: [1, 0, 0, 0, 0],
        words: [
          [16, 0],
          [16, 0],
        ],
      },
    ];
    for (const entry of mapCases) {
      await call(0x90, 0x11, [entry.index, entry.width, entry.height, 4]);
      await call(0x91, entry.slot, [entry.index, ...entry.args]);
      assert.deepEqual(vectors(entry.index), entry.words);
    }

    const colors = [
      0x102030, 0x203040, 0x304050, 0x405060, 0x506070, 0x607080, 0x708090, 0x8090a0, 0x90a0b0,
    ];
    const tallColors = Array.from({length: 12}, (_, i) => 0x102030 + i * 0x010101);
    await importRgb(6, 3, 3, colors, 0x400);
    await importRgb(7, 2, 6, tallColors, 0x500);
    await importRgb(8, 2, 2, colors.slice(0, 4), 0x600);
    for (const [index, width, height] of [
      [9, 1, 1],
      [10, 2, 2],
      [11, 2, 1],
    ]) {
      await call(0x90, 0x11, [index, width, height, 1]);
      await call(0x90, 0x13, [index, 0]);
    }

    const sample = async (destination, source, map, expected) => {
      await call(0x90, 0x1a, [destination, source, map, -1, 256, 0]);
      assert.deepEqual(pixels(destination), expected);
    };
    await sample(9, 6, 0, [colors[8]]);
    await sample(10, 7, 1, [tallColors[4], tallColors[8], tallColors[8], tallColors[10]]);
    await sample(10, 8, 2, [0, 0, 0, colors[0]]);
    await sample(10, 6, 3, [colors[0], 0, 0, 0]);
    await sample(10, 6, 4, [colors[0], colors[4], colors[4], colors[8]]);
    await sample(11, 6, 5, [colors[1], colors[2]]);

    for (const index of [11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0])
      assert.equal(await call(0x90, 0x12, [index], true), 1);
    assert.equal(child.state.stackIndex, 0);
  } finally {
    await fixture.close();
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaFrameMetrics} from '../dist/engines/buriko/games/aokana/native/frame-metrics.js';
import {AokanaNativeClock} from '../dist/engines/buriko/games/aokana/native/clock.js';
import {AokanaNativeDisplayState} from '../dist/engines/buriko/games/aokana/native/display-state.js';
import {aokanaPresentationVertices} from '../dist/engines/buriko/games/aokana/native/display-device.js';

test('frame metrics carry successive simulation intervals into one committed draw', () => {
  let ticks = 0n,
    reads = 0;
  const counter = {
    queryCounter: () => {
      reads++;
      return ticks;
    },
    queryFrequency: () => 1000000n,
  };
  const metrics = new AokanaFrameMetrics(counter, new AokanaNativeClock(() => 0), {
    refreshRate: 60,
    readRasterScanline: () => 0x81000000,
  });
  metrics.enable(1);
  ticks = 100n;
  metrics.begin();
  ticks = 400n;
  metrics.end(0);
  ticks = 500n;
  metrics.begin();
  ticks = 800n;
  metrics.end(0);
  assert.equal(metrics.read(0), 0);
  ticks = 900n;
  metrics.begin();
  ticks = 1000n;
  metrics.end(1);
  assert.deepEqual(
    [0, 1, 2, 3].map((index) => metrics.read(index)),
    [1, 700, 114271, 10000],
  );
  metrics.enable(0);
  metrics.begin();
  metrics.end(1);
  assert.equal(reads, 6);
  assert.equal(metrics.read(0), 1);
  metrics.enable(2);
  assert.deepEqual(
    [0, 1, 2, 3].map((index) => metrics.read(index)),
    [0, 0, 0, 0],
  );
});

test('frame quality distinguishes scanline wrap and exact timing threshold independently', () => {
  let ticks = 0n,
    scanline = 10;
  const counter = {queryCounter: () => ticks, queryFrequency: () => 1000000n};
  const raster = {
    refreshRate: 60,
    readRasterScanline: (output) => {
      output.scanline = scanline;
      return 0;
    },
  };
  const metrics = new AokanaFrameMetrics(counter, new AokanaNativeClock(() => 0), raster);
  metrics.enable(1);
  metrics.begin();
  ticks = 1000n;
  scanline = 20;
  metrics.end(1);
  metrics.begin();
  ticks = 2000n;
  scanline = 2;
  metrics.end(1);
  assert.equal(metrics.read(3), 2500);
  metrics.begin();
  ticks += 15999n;
  scanline = 30;
  metrics.end(1);
  assert.equal(metrics.read(0), 3);
  assert.equal(metrics.read(3), 1111);
});

test('presentation quad retains half-pixel coordinates, actual-size UV range and DWORD diffuse', () => {
  const display = new AokanaNativeDisplayState(1920, 1080);
  display.requestedWidth = 1600;
  display.requestedHeight = 900;
  const bytes = aokanaPresentationVertices(display),
    view = new DataView(bytes.buffer);
  assert.equal(bytes.length, 112);
  const vertex = (index) => {
    const at = index * 28;
    return [
      view.getFloat32(at, true),
      view.getFloat32(at + 4, true),
      view.getFloat32(at + 8, true),
      view.getFloat32(at + 12, true),
      view.getUint32(at + 16, true),
      view.getFloat32(at + 20, true),
      view.getFloat32(at + 24, true),
    ];
  };
  assert.deepEqual(vertex(0), [-0.5, -0.5, 0, 1, 0x00ffffff, 0, 0]);
  assert.deepEqual(vertex(3), [1599.5, 899.5, 0, 1, 0x00ffffff, 800 / 1024, 600 / 1024]);
});

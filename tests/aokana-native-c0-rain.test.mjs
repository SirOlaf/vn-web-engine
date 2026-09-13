import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaRain} from '../dist/engines/buriko/games/aokana/native/rain.js';
import {AokanaSystemTicks} from '../dist/engines/buriko/games/aokana/native/system-ticks.js';
import {AokanaBitmapStorage} from '../dist/engines/buriko/games/aokana/native/bitmap.js';
import {drawAokanaRainLine} from '../dist/engines/buriko/games/aokana/native/rain-line.js';
import {
  blendAokanaMaskedAlphaIntoRgb,
  copyAokanaMaskedAlpha,
} from '../dist/engines/buriko/games/aokana/native/bitmap-mask.js';

function bitmap(width, height = 1, format = 2) {
  const bytesPerPixel = format === 3 ? 1 : 4;
  return {
    storage: new AokanaBitmapStorage(new Uint8Array(width * height * bytesPerPixel), true),
    offset: 0,
    width,
    height,
    stride: width * bytesPerPixel,
    format,
    bytesPerPixel,
  };
}
const words = (image) => Array.from(new Uint32Array(image.storage.bytes.buffer));
const writeWords = (image, values) => new Uint32Array(image.storage.bytes.buffer).set(values);
function rainFixture() {
  let time = 100,
    random = 0;
  const calls = [];
  const ticks = {
    timeGetTime() {
      calls.push('timeGetTime');
      return time;
    },
    getTickCount() {
      calls.push('getTickCount');
      return time;
    },
  };
  const rain = new AokanaRain({next: () => random++}, ticks);
  return {
    rain,
    calls,
    time: (value) => {
      time = value;
    },
    randomCount: () => random,
  };
}

test('raw system ticks truncate and wrap independently of BGI clock suspension', () => {
  let time = 17.9;
  const ticks = new AokanaSystemTicks({now: () => time});
  assert.equal(ticks.timeGetTime(), 17);
  time = 0x100000000 + 9.8;
  assert.equal(ticks.getTickCount(), 9);
});

test('rain parameter exchange, selected raw clock and complete fixed simulation steps', () => {
  const fixture = rainFixture(),
    {rain} = fixture;
  const parameters = Int32Array.of(
    10,
    200,
    30,
    110,
    -1000,
    130,
    0,
    -1,
    0,
    60 << 8,
    350 << 8,
    -1,
    0,
    2,
    20,
    1,
  );
  assert.deepEqual(
    [...rain.exchangeParameters(parameters)],
    [-100, 100, -100, 100, -100, 100, 0, -1, 0, 0x3c00, 0x15e00, -1, 0, 100, 20, 1],
  );
  rain.start(10);
  fixture.time(135);
  assert.equal(rain.update(), 0xffffffff);
  assert.equal(fixture.randomCount(), 12);
  assert.equal(rain.previousTick, 130);
  assert.deepEqual(rain.drops, [
    {second: {x: 10, y: 139, z: 32}, first: {x: 10, y: 489, z: 32}},
    {second: {x: 13, y: 136, z: 35}, first: {x: 13, y: 486, z: 35}},
    {second: {x: 16, y: 193, z: 38}, first: {x: 16, y: 543, z: 38}},
    {second: {x: 19, y: 190, z: 41}, first: {x: 19, y: 540, z: 41}},
  ]);
  fixture.time(650);
  rain.update();
  assert.equal(rain.previousTick, 650);
  assert.equal(fixture.randomCount(), 12);
  assert.deepEqual(fixture.calls, ['timeGetTime', 'timeGetTime', 'timeGetTime', 'timeGetTime']);
  parameters[15] = 0;
  parameters[9] = -1;
  rain.exchangeParameters(parameters);
  assert.deepEqual([...rain.velocity], [0, -0xffffff, 0, 0, -350, 0]);
  rain.start(0);
  assert.equal(fixture.calls.at(-1), 'getTickCount');
  assert.equal(rain.drops.length, 0);
});

test('rain projection draws normal synthetic drops with native depth attenuation and clock-free refresh', () => {
  const fixture = rainFixture(),
    {rain} = fixture;
  rain.start(0);
  rain.drops = [{first: {x: 10, y: 0, z: 20}, second: {x: 10, y: -10, z: 20}}];
  const image = bitmap(20, 20);
  rain.draw(image);
  const expected = new Uint32Array(400);
  for (let y = 10; y <= 15; y++) expected[y * 20 + 15] = 0xffffffff;
  assert.deepEqual(words(image), [...expected]);
  assert.deepEqual(fixture.calls, ['timeGetTime']);
  image.storage.bytes.fill(0);
  rain.drops = [{first: {x: 0, y: 0, z: 1000}, second: {x: 0, y: -100, z: 1000}}];
  rain.draw(image);
  assert.equal(words(image)[210], 0x14ffffff);
  assert.equal(words(image)[230], 0x14ffffff);
  assert.equal(words(image).filter(Boolean).length, 2);
});

test('rain line covers both directions, equal-axis ties and native bottom-edge behavior', () => {
  const clip = {left: 0, top: 0, right: 7, bottom: 7};
  const cases = [
    [
      [1, 2, 6, 4],
      [
        [1, 2],
        [2, 2],
        [3, 3],
        [4, 3],
        [5, 4],
        [6, 4],
      ],
    ],
    [
      [6, 2, 1, 4],
      [
        [6, 2],
        [5, 2],
        [4, 3],
        [3, 3],
        [2, 4],
        [1, 4],
      ],
    ],
    [
      [2, 1, 4, 6],
      [
        [2, 1],
        [2, 2],
        [3, 3],
        [3, 4],
        [4, 5],
        [4, 6],
      ],
    ],
    [
      [4, 1, 2, 6],
      [
        [4, 1],
        [3, 2],
        [3, 3],
        [2, 4],
        [2, 5],
        [1, 6],
      ],
    ],
    [
      [1, 1, 4, 4],
      [
        [1, 1],
        [2, 2],
        [3, 3],
        [4, 4],
      ],
    ],
    [[1, 7, 5, 7], []],
    [[5, 7, 1, 7], []],
    [
      [7, 5, 7, 7],
      [
        [7, 5],
        [7, 6],
        [7, 7],
      ],
    ],
  ];
  for (const [line, pixels] of cases)
    for (const endpoints of [line, [...line.slice(2), ...line.slice(0, 2)]]) {
      const image = bitmap(8, 8),
        expected = new Uint32Array(64);
      drawAokanaRainLine(image, clip, 0x76543210, ...endpoints);
      for (const [x, y] of pixels) expected[y * 8 + x] = 0x76543210;
      assert.deepEqual(words(image), [...expected], String(endpoints));
    }
});

test('rain mask copying handles four/two/one pixel groups and nonzero mask values', () => {
  for (const width of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
    const source = bitmap(width),
      destination = bitmap(width),
      mask = bitmap(width, 1, 3);
    const pixels = Array.from({length: width}, (_, i) => (0x81234567 + i * 0x123456) >>> 0);
    writeWords(source, pixels);
    mask.storage.bytes.set(Array.from({length: width}, (_, i) => [0, 1, 128, 255][i % 4]));
    copyAokanaMaskedAlpha(destination, source, mask);
    assert.deepEqual(
      words(destination),
      pixels.map((value, i) => (i % 4 === 0 ? 0 : value)),
    );
  }
});

test('masked RGB blending matches integer alpha quantization for every alpha and transparency', () => {
  const source = bitmap(256),
    destination = bitmap(256, 1, 1),
    mask = bitmap(256, 1, 3);
  mask.storage.bytes.fill(1);
  writeWords(
    source,
    Array.from({length: 256}, (_, a) => ((a << 24) | 0xf0479e) >>> 0),
  );
  for (let transparency = 0; transparency < 256; transparency++) {
    destination.storage.bytes.fill(0);
    writeWords(destination, Array(256).fill(0xb12dfa07));
    blendAokanaMaskedAlphaIntoRgb(destination, source, mask, transparency);
    const expected = Array.from({length: 256}, (_, alpha) => {
      const coefficient = Math.floor((Math.floor(alpha / 2) * (256 - transparency)) / 256);
      const channel = (before, after) =>
        before + Math.floor(((after - before) * coefficient) / 128);
      return (
        ((0xb1 << 24) | (channel(45, 240) << 16) | (channel(250, 71) << 8) | channel(7, 158)) >>> 0
      );
    });
    assert.deepEqual(words(destination), expected, String(transparency));
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {runtime, literal, assignment} from './sc3-fixtures.mjs';
import {movieStart} from '../dist/engines/mages/games/chaos-head-noah/sc3/opcodes/movie-start.js';
import {NoahMovieDevices} from '../dist/engines/mages/games/chaos-head-noah/sc3/movie-devices.js';

async function fixture(code) {
  const vm = runtime(code);
  await vm.boot();
  const s = vm.state,
    c = vm.context(0),
    pc = c.getBigUint64(0x158, true);
  return {
    vm,
    s,
    c,
    pc,
    h: {
      state: s,
      context: c,
      movies: vm.movies,
      stopAudioDevice: (i) => vm.audio.stopDevice(i),
      yield: () => s.put(0x179cd24, 1),
      expression: () => vm.expression(0),
      skip: (n) => c.setBigUint64(0x158, c.getBigUint64(0x158, true) + BigInt(n), true),
      byte: () => {
        const p = c.getBigUint64(0x158, true);
        c.setBigUint64(0x158, p + 1n, true);
        return vm.dataByte(Number(p));
      },
    },
  };
}
test('movie start busy gate leaves PC and every operand side effect untouched', async () => {
  const {s, c, pc, h} = await fixture([
    1,
    0x22,
    99,
    ...assignment(0x28, 40, 0),
    ...literal(0),
    ...literal(58),
    ...literal(1),
  ]);
  s.put(0x81007c, -1);
  s.setVariable(40, 99);
  movieStart(h);
  assert.equal(c.getBigUint64(0x158, true), pc);
  assert.equal(s.variable(40), 99);
  assert.equal(s.get(0x179cd24), 1);
});
test('movie direct form consumes two bytes, keeps mode, and resets only selected counter byte', async () => {
  const {s, c, pc, h} = await fixture([1, 0x22, 29, 255, ...literal(58), ...literal(0)]);
  s.bytes(0x179ccf0, 4).fill(77);
  s.flags[0x137] = 255;
  movieStart(h);
  assert.equal(c.getBigUint64(0x158, true), pc + 18n);
  assert.equal(s.variable(0x6344 / 4), 58);
  assert.equal(s.variable(0x6348 / 4), 29);
  assert.equal(s.variable(0x634c / 4), 255);
  assert.deepEqual([...s.bytes(0x179ccf0, 4)], [77, 0, 77, 77]);
  assert.equal(s.get(0x5a6e54), 4);
  assert.equal(s.flags[0x137], 223);
});
test('movie invalid channel evaluates all operands and writes mode before native bounds failure', async () => {
  const {s, h} = await fixture([
    1,
    0x22,
    99,
    ...assignment(0x28, 40, 80),
    ...assignment(0x28, 41, 7),
    ...assignment(0x28, 42, 58),
    ...assignment(0x28, 43, 0x1234),
  ]);
  assert.throws(() => movieStart(h), /bounds failure/);
  assert.deepEqual(
    [40, 41, 42, 43].map((i) => s.variable(i)),
    [80, 7, 58, 0x1234],
  );
  assert.equal(s.get(0x179ccf0), 0x1234);
});
test('movie sound-preservation flag keeps first three requests while clearing the next three', async () => {
  for (const preserve of [false, true]) {
    const {s, h} = await fixture([1, 0x22, 0, 0, ...literal(58), ...literal(1)]),
      stops = [];
    h.stopAudioDevice = (i) => stops.push(i);
    s.flags[0x137] = preserve ? 1 : 0;
    for (let i = 0; i < 6; i++) {
      s.put(0x5a7110 + i * 0x98, 20 + i);
      s.put(0x5a711c + i * 0x98, 8);
      s.put(0x5a7118 + i * 0x98, 99);
    }
    movieStart(h);
    assert.deepEqual(stops, preserve ? [] : [0, 1, 2]);
    for (let i = 0; i < 6; i++) {
      assert.equal(s.get(0x5a7110 + i * 0x98), preserve && i < 3 ? 20 + i : -1);
      assert.equal(s.get(0x5a7118 + i * 0x98), 99);
    }
  }
});
test('movie start clears every configured output-surface group twice, with null surface entries retained', async () => {
  const {s, h} = await fixture([1, 0x22, 0, 0, ...literal(58), ...literal(0)]),
    b = 0x1d8be20,
    events = [];
  s.put(b + 8, 1, 1);
  s.put(b + 0xdd8, 1, 8);
  for (let group = 0; group < 4; group++) {
    s.put(b + 0xce6 + group * 2, 2, 2);
    const at = 0x1d1b200 + group * 0x1b0;
    s.put(b + 0xcf0 + group * 32, 0x140000000 + at, 8);
    s.put(at + 0x32, 1, 1);
  }
  h.movies = new NoahMovieDevices(s, {
    status: () => 0,
    stop() {},
    closeFile() {},
    openFile: () => 0,
    start: (handle, id) => events.push([handle, id]),
    volume() {},
    loop() {},
    pause() {},
  });
  movieStart(h);
  for (let group = 0; group < 4; group++) assert.equal(s.bytes(0x1d1b232 + group * 0x1b0, 1)[0], 0);
  assert.deepEqual(events, [[1, 58]]);
  assert.equal(s.bytes(b + 0xb, 1)[0], 1);
});

test('first decoded movie picture releases the native scene-ready wait without clearing it at start', async () => {
  const {vm, s, h} = await fixture([1, 0x22, 1, 0, ...literal(58), ...literal(0)]);
  const {allocateFrame} = await import('../dist/video/frame.js'),
    {movieSceneReady, movieAtPriority} =
      await import('../dist/engines/mages/games/chaos-head-noah/sc3/movie-draw.js');
  let picture;
  const host = {
    initialize: () => 1,
    status: () => (picture ? 5 : 0),
    sample: () =>
      picture
        ? {
            status: 5,
            frame: picture,
            frameCount: 60,
            frameRate: 30,
            positionMs: 0,
            durationMs: 2000,
          }
        : undefined,
    stop() {},
    closeFile() {},
    openFile: () => 0,
    start() {},
    volume() {},
    loop() {},
    pause() {},
  };
  const movies = new NoahMovieDevices(s, host);
  movies.initialize();
  h.movies = movies;
  movieStart(h);
  movieSceneReady(vm);
  assert.ok(s.flags[0x9a] & 16);
  picture = allocateFrame(16, 16);
  picture.index = 0;
  picture.y.fill(235);
  picture.cb.fill(128);
  picture.cr.fill(128);
  movies.advance(vm.textures);
  assert.equal(s.bytes(0x1d8be2d, 1)[0], 1);
  assert.ok(s.flags[0x9a] & 16, 'Device publication alone does not perform scene traversal');
  movieSceneReady(vm);
  assert.equal(s.flags[0x9a] & 16, 0);
  s.setVariable(0x62e8 / 4, 12);
  s.setVariable(0x6308 / 4, 255);
  const draws = movieAtPriority({...vm, movies}, 12);
  assert.equal(draws.length, 1);
  assert.equal(draws[0].texture, 181);
  assert.equal(
    vm.textures.resources.get(181).image.pixels[0],
    235,
    'The uploaded luma remains unconverted until the native YUV shader',
  );
  assert.equal(vm.textures.resources.get(181).movie.planes.length, 3);
  assert.deepEqual(draws[0].destination, {x: 0, y: 0, width: 1920, height: 1080});
  assert.deepEqual(draws[0].source, {x: 0, y: 0, width: 16, height: 16});
  // Replacement goes back through the ready wait; the preceding surface is not
  // mistaken for a picture from the new stream.
  picture = undefined;
  h.skip = () => {};
  h.byte = (() => {
    const values = [1, 0];
    return () => values.shift();
  })();
  h.expression = (() => {
    const values = [32, 0];
    return () => values.shift();
  })();
  movieStart(h);
  movieSceneReady(vm);
  assert.ok(s.flags[0x9a] & 16);
  assert.equal(movies.frame(0), undefined);
});

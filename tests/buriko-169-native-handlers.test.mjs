import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, pop32, push32} from '../dist/engines/buriko/bp/state.js';
import {BurikoBitmapCompositor} from '../dist/engines/buriko/native/bitmap-compositor.js';
import {bitmapRead32, bitmapWrite32} from '../dist/engines/buriko/native/bitmap-scalar.js';
import {BurikoDistributedAllocator} from '../dist/engines/buriko/native/distributed-processing.js';
import {BurikoNativeFonts} from '../dist/engines/buriko/native/fonts.js';
import {BurikoSurfaces} from '../dist/engines/buriko/native/surfaces.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';
import {BurikoNativeNotifications} from '../dist/engines/buriko/native/notification-queue.js';
import {BurikoSystemProfile} from '../dist/engines/buriko/native/system-profile.js';
import {BurikoLegacy169FlashSurfaces} from '../dist/engines/buriko/native/legacy-169-flash.js';
import {
  createLegacy169NativeDefinitions,
  createLegacy169PrimaryOpcodes,
  legacy169SystemIdentity,
} from '../dist/engines/buriko/native/legacy-169-handlers.js';
import {BrowserWindowsFlashHost} from '../dist/platform/windows-flash.js';

const name = {bytes: new TextEncoder().encode('synthetic.swf\0'), offset: 0};
function fixture(host = new BrowserWindowsFlashHost(), profile = null) {
  const text = new BurikoNativeText();
  const surfaces = new BurikoSurfaces(
    new BurikoNativeFonts(text),
    new BurikoBitmapCompositor(),
    new BurikoDistributedAllocator(2),
  );
  const notifications = new BurikoNativeNotifications();
  let now = 0;
  const flash = new BurikoLegacy169FlashSurfaces(
    surfaces,
    {text, paths: {currentDirectory: 'C:\\VN'}},
    text,
    notifications,
    host,
    profile,
    () => now,
  );
  return {
    surfaces,
    flash,
    notifications,
    advance: (elapsed = 100) => {
      now += elapsed;
    },
  };
}

function control(overrides = {}) {
  const calls = [],
    bytes = new Uint8Array(16).fill(0x31);
  const state = {frame: 0, total: 2};
  const result =
    (method, value = 0) =>
    (...args) => {
      calls.push([method, ...args]);
      return value;
    };
  const value = {
    bitmap: () => ({bytes, offset: 0, stride: 8, width: 2, height: 2}),
    putMovie: result('movie'),
    putLoop: result('loop'),
    play: result('play'),
    totalFrames: () => {
      calls.push(['total']);
      return {hresult: 0, value: state.total};
    },
    frameNumber: () => {
      calls.push(['frame']);
      return {hresult: 0, value: state.frame};
    },
    gotoFrame: result('goto'),
    isPlaying: () => ({hresult: 0, value: 1}),
    draw: () => {
      calls.push(['draw']);
      return 0;
    },
    waitForDrawRetry: async () => {
      calls.push(['retry']);
    },
    dispose: result('dispose'),
    ...overrides,
  };
  return {value, calls, bytes, state};
}

test('1.69 primary7f consumes source then destination, truncates once, and retains odd edges', () => {
  const {surfaces} = fixture();
  surfaces.allocate(0, 3, 3, 2);
  const source = surfaces.snapshot(0);
  [0, 0, 20, 1, 3, 21, 40, 43, 99].forEach((v, i) =>
    bitmapWrite32(source, i * 4, Math.imul(v, 0x01010101)),
  );
  const thread = new BurikoBpThread({
    id: 1,
    operandCapacity: 16,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const h = {thread, memory: new BurikoBpMemory(new Uint8Array(0)), diagnostics: {}};
  push32(thread, 1);
  push32(thread, 0);
  assert.equal(createLegacy169PrimaryOpcodes(surfaces)[0x7f](h), 0);
  assert.equal(thread.stackIndex, 0);
  const output = surfaces.snapshot(1);
  assert.deepEqual([output.width, output.height], [2, 2]);
  assert.deepEqual(
    [0, 4, 8, 12].map((i) => bitmapRead32(output, i)),
    [1, 20, 41, 99].map((v) => Math.imul(v, 0x01010101) >>> 0),
  );
  // A format rejected by the lower still replaces the destination allocation.
  surfaces.allocate(0, 3, 3, 3);
  push32(thread, 1);
  push32(thread, 0);
  createLegacy169PrimaryOpcodes(surfaces)[0x7f](h);
  assert.equal(surfaces.snapshot(1).format, 3);
  assert.throws(() => bitmapRead32(surfaces.snapshot(1), 0), /unwritten/);
  surfaces.allocate(0, 1, 2, 2);
  push32(thread, 1);
  push32(thread, 0);
  assert.throws(() => createLegacy169PrimaryOpcodes(surfaces)[0x7f](h), /do-while/);
});

test('Flash NT4+ profile selects the1ms timer and failed version queries retain100ms fallback', async () => {
  for (const [version, interval] of [
    [{platform: 2, major: 4}, 1],
    [{platform: 2, major: 3}, 100],
    [null, 100],
  ]) {
    const c = control(),
      f = fixture({create: () => ({status: 0, control: c.value})}, {readVersion: () => version});
    await f.flash.create(1, 2, 2, name, 0);
    await f.flash.poll();
    f.notifications.take();
    c.state.frame++;
    f.advance(interval - 0.5);
    await f.flash.poll();
    assert.equal(f.notifications.take(), null);
    f.advance(0.5);
    await f.flash.poll();
    assert.equal(f.notifications.take().type, 0x10100);
    await f.flash.closeAndJoin();
  }
});

test('1.69 identity uses fresh OS data, raw ANSI leading bytes, capacities and seed XOR', () => {
  const cpu = {query: () => [0xabcdefab, 0, 0, 0]};
  let version = {major: 5, minor: 0, platform: 2},
    user = Uint8Array.of(0x83, 0x65),
    queries = 0;
  const system = new BurikoSystemProfile({
    readUserName: () => user,
    readComputerName: () => Uint8Array.of(0x50),
    readVersion: () => {
      queries++;
      return version;
    },
  });
  const cases = [
    [0, 0, 0, 0x7000],
    [1, 4, 0, 0x1000],
    [1, 4, 10, 0x2000],
    [1, 4, 11, 0x3000],
    [2, 3, 0, 0x5000],
    [2, 4, 0, 0x6000],
    [2, 5, 0, 0x4000],
    [2, 5, 1, 0x8000],
    [2, 10, 0, 0x8000],
    [8, 1, 0, 0xf000],
  ];
  for (const [platform, major, minor, cls] of cases) {
    version = {platform, major, minor};
    assert.equal(
      legacy169SystemIdentity(cpu, system, 0x12345678),
      ((((cls | 0xfab) << 16) | 0x8350) ^ 0x12345678) >>> 0,
    );
  }
  assert.equal(queries, cases.length);
  user = new Uint8Array(256).fill(65);
  assert.equal(legacy169SystemIdentity(cpu, system, 0) & 0xffff, 0x50);
  version = null;
  assert.throws(() => legacy169SystemIdentity(cpu, system, 0), /unwritten GetVersionExA/);
});

test('unavailable Flash returns1 without replacing a surface; wrappers retain exact stack order', async () => {
  const f = fixture();
  f.surfaces.allocate(9, 2, 2, 2);
  const original = f.surfaces.snapshot(9).storage;
  const definitions = createLegacy169NativeDefinitions({}, {}, f.flash);
  const thread = new BurikoBpThread({
    id: 1,
    operandCapacity: 16,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const memory = new BurikoBpMemory(new Uint8Array(64));
  memory.globalMemory.set(name.bytes, 4);
  const context = {thread, memory, diagnostics: {}};
  for (const arg of [9, 2, 2, 4, 7]) push32(thread, arg);
  assert.equal(await definitions[1].execute(context), 0);
  assert.equal(pop32(thread), 1);
  assert.equal(f.surfaces.snapshot(9).storage, original);
  for (const index of [2, 3]) {
    push32(thread, 9);
    await definitions[index].execute(context);
    assert.equal(pop32(thread), 1);
    push32(thread, 10);
    await definitions[index].execute(context);
    assert.equal(pop32(thread), 4);
  }
  assert.equal(thread.stackIndex, 0);
  assert.deepEqual(
    definitions.map((d) => d.nativeAddress),
    [0x461d30, 0x45d240, 0x45d2f0, 0x45d370, 0x461cd0, 0x461cf0, 0x461d10],
  );
  // Missing legacy owners cannot fall through to the newer DLL operations.
  await assert.rejects(
    () => definitions.find((d) => d.secondary === 0xec).execute(context),
    /registration requires its file\/process owner/,
  );
  await f.flash.closeAndJoin();
});

test('Flash live DIB, ordered property calls, frame notifications, manual repeat and detach copy', async () => {
  const c = control(),
    f = fixture({create: () => ({status: 0, control: c.value})});
  assert.equal(await f.flash.create(1, 2, 2, name, 1), 0);
  const original = f.surfaces.descriptor(1).storage;
  assert.notEqual(f.surfaces.snapshot(1).storage, original);
  assert.equal(f.surfaces.snapshot(1).storage.bytes, c.bytes);
  assert.equal(await f.flash.start(1), 0);
  assert.deepEqual(c.calls, [
    ['movie', 'C:\\VN\\synthetic.swf'],
    ['loop', false],
    ['play'],
    ['total'],
    ['draw'],
  ]);
  await f.flash.poll();
  assert.deepEqual(f.notifications.take(), {type: 0x10100, value1: 1, value2: 0});
  await f.flash.poll();
  assert.equal(f.notifications.take(), null);
  c.state.frame = 1;
  f.advance();
  await f.flash.poll();
  f.notifications.take();
  f.advance();
  await f.flash.poll();
  assert.deepEqual(c.calls.slice(-4), [['frame'], ['goto', 0], ['play'], ['draw']]);
  assert.deepEqual(f.notifications.take(), {type: 0x10100, value1: 1, value2: 0});
  c.bytes.fill(0x72);
  assert.equal(await f.flash.detach(1), 0);
  assert.deepEqual(c.calls.slice(-2), [['goto', 0], ['dispose']]);
  assert.equal(f.surfaces.snapshot(1).storage, original);
  assert.deepEqual(original.bytes, new Uint8Array(16).fill(0x72));
  assert.equal(await f.flash.detach(1), 0x80000001);
  await f.flash.closeAndJoin();
});

test('Flash movie-property failure maps to2 and retires; other start failures map to1', async () => {
  for (const [override, expected] of [
    [{putMovie: () => 1}, 0x80000002],
    [{putLoop: () => 1}, 0x80000001],
    [{play: () => 1}, 0x80000001],
    [{totalFrames: () => ({hresult: 1, value: 99})}, 0x80000001],
  ]) {
    const c = control(override),
      f = fixture({create: () => ({status: 0, control: c.value})});
    await f.flash.create(1, 2, 2, name, 0);
    assert.equal(await f.flash.start(1), expected);
    assert.equal(c.calls.at(-1)[0], 'dispose');
    assert.equal(
      c.calls.some((call) => call[0] === 'goto'),
      false,
    );
    assert.equal(f.surfaces.snapshot(1).storage, f.surfaces.descriptor(1).storage);
    await f.flash.closeAndJoin();
  }
});

test('surface replacement aborts pending Flash drawing and joins disposal before shutdown', async () => {
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const c = control({
    draw: (signal) =>
      new Promise((_resolve, reject) => {
        entered();
        signal.addEventListener('abort', () => reject(new Error('cancelled synthetic draw')), {
          once: true,
        });
      }),
  });
  const f = fixture({create: () => ({status: 0, control: c.value})});
  await f.flash.create(1, 2, 2, name, 0);
  const pending = f.flash.start(1);
  await started;
  f.surfaces.allocate(1, 3, 3, 2);
  assert.equal(await pending, 0x80000001);
  await f.flash.closeAndJoin();
  assert.equal(c.calls.filter((c) => c[0] === 'dispose').length, 1);
  assert.equal(f.surfaces.snapshot(1).width, 3);
});

test('Flash initialization failures consume IDs and first drawing retries until success', async () => {
  const missing = control({bitmap: () => null}),
    valid = control();
  let creations = 0,
    draws = 0;
  valid.value.draw = () => (++draws === 1 ? 1 : 0);
  const f = fixture({
    create: () => ({status: 0, control: creations++ === 0 ? missing.value : valid.value}),
  });
  assert.equal(await f.flash.create(1, 2, 2, name, 0), 0x80000001);
  assert.equal(missing.calls.at(-1)[0], 'dispose');
  assert.equal(f.surfaces.snapshot(1), null);
  assert.equal(await f.flash.create(1, 2, 2, name, 0), 0);
  assert.equal(await f.flash.start(1), 0);
  assert.equal(draws, 2);
  assert.equal(valid.calls.filter((call) => call[0] === 'retry').length, 1);
  await f.flash.poll();
  assert.deepEqual(f.notifications.take(), {type: 0x10100, value1: 1, value2: 1});
  await f.flash.closeAndJoin();
});

test('1.69 Flash wrappers preserve unmapped native status words', async () => {
  const thread = new BurikoBpThread({
    id: 1,
    operandCapacity: 16,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const memory = new BurikoBpMemory(new Uint8Array(64));
  memory.globalMemory.set(name.bytes, 4);
  const h = {thread, memory, diagnostics: {}};
  const definitions = createLegacy169NativeDefinitions(
    {},
    {},
    {create: async () => 0x80000003, start: async () => 0x80000003, detach: async () => 0x80000002},
  );
  for (const value of [1, 2, 2, 4, 0]) push32(thread, value);
  await definitions[1].execute(h);
  assert.equal(pop32(thread), 0x80000003);
  push32(thread, 1);
  await definitions[2].execute(h);
  assert.equal(pop32(thread), 0x80000003);
  push32(thread, 1);
  await definitions[3].execute(h);
  assert.equal(pop32(thread), 0x80000002);
});

test('shutdown joins a control created after close began without allocating its surface', async () => {
  let finish;
  const c = control(),
    f = fixture({
      create: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
  const pending = f.flash.create(1, 2, 2, name, 0);
  const close = f.flash.closeAndJoin();
  finish({status: 0, control: c.value});
  assert.equal(await pending, 0x80000001);
  await close;
  assert.equal(c.calls.at(-1)[0], 'dispose');
  assert.equal(f.surfaces.snapshot(1), null);
});

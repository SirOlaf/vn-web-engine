import test from 'node:test';
import assert from 'node:assert/strict';
import {NoahState} from '../dist/engines/mages/games/chaos-head-noah/sc3/noah-state.js';
import {NoahAudio} from '../dist/engines/mages/games/chaos-head-noah/sc3/audio.js';
import {BrowserAudioTransport} from '../dist/audio/transport.js';
import {runtime, literal, assignment} from './sc3-fixtures.mjs';
const b = (i) => 0x5a7110 + i * 0x98;
function device() {
  const requests = [],
    voices = [];
  return {
    requests,
    voices,
    async prepare(bank, id, loop) {
      requests.push({bank, id, loop});
      const voice = {
        sampleRate: 48000,
        sampleCount: 480000,
        loopStart: 48000,
        paused: true,
        gain: 0,
        done: false,
        samples: 0,
        disposed: false,
        position() {
          return this.samples;
        },
        ended() {
          return this.done;
        },
        pause(p) {
          this.paused = p;
        },
        volume(g) {
          this.gain = g;
        },
        dispose() {
          this.disposed = true;
        },
      };
      voices.push(voice);
      return voice;
    },
  };
}
test('BGM queues real readiness, publishes duration and position, and crossfades both channels', async () => {
  const host = device();
  const s = new NoahState(() => 0);
  s.initialize();
  const audio = new NoahAudio(s, host);
  audio.initialize();
  s.setVariable(0x4368 / 4, 100);
  s.put(b(7), 2);
  s.put(b(7) + 4, 1);
  s.put(b(7) + 8, 1);
  s.put(b(7) + 12, 1);
  audio.advance();
  assert.deepEqual(host.requests, [{bank: 8, id: 2, loop: true}]);
  assert.equal(s.get(b(7) + 0x24), 0);
  await audio.settle();
  audio.publish();
  audio.advance();
  assert.equal(s.get(b(7) + 0x24), 1);
  assert.equal(s.get(b(7) + 0x38), 1);
  assert.equal(s.get(b(7) + 0x60), 600);
  assert.equal(s.get(b(7) + 0x58), 600);
  assert.equal(host.voices[0].paused, false);
  assert.equal(host.voices[0].gain, 0.25);
  host.voices[0].samples = 72000;
  audio.publish();
  audio.advance();
  assert.equal(s.variable(0x3a78 / 4), 90);
  s.put(b(8), 56);
  s.put(b(8) + 4, 1);
  s.put(b(8) + 8, 0);
  s.put(b(8) + 12, 1);
  audio.advance();
  await audio.settle();
  audio.publish();
  audio.advance();
  assert.equal(host.voices[1].paused, true);
  audio.resume(8);
  s.put(b(8) + 0x70, 0);
  s.put(b(8) + 0x48, 1);
  s.put(b(8) + 0x4c, 2 << 16);
  s.put(b(7), -1);
  s.put(b(7) + 12, 0);
  s.put(b(7) + 0x50, 1);
  s.put(b(7) + 0x54, 2 << 16);
  for (let i = 0; i < 17; i++) audio.advance();
  assert.equal(s.get(b(7) + 0x38), 0);
  assert.equal(host.voices[0].disposed, true);
  assert.equal(host.voices[1].gain, 0.25);
  audio.dispose();
});
test('cancelled asynchronous audio cannot publish into a replacement channel', async () => {
  const pending = [];
  const s = new NoahState(() => 0);
  s.initialize();
  const audio = new NoahAudio(s, {prepare: () => new Promise((resolve) => pending.push(resolve))});
  audio.initialize();
  s.put(b(7), 2);
  s.put(b(7) + 12, 1);
  audio.advance();
  s.put(b(7), 56);
  s.put(b(7) + 16, 1);
  audio.advance();
  const old = {
      disposed: false,
      dispose() {
        this.disposed = true;
      },
    },
    next = {
      ...old,
      sampleCount: 48000,
      sampleRate: 48000,
      loopStart: 0,
      pause() {},
      volume() {},
      position: () => 0,
      ended: () => false,
    };
  pending[0](old);
  pending[1](next);
  await audio.settle();
  audio.publish();
  assert.equal(old.disposed, true);
  assert.equal(next.disposed, false);
  audio.advance();
  assert.equal(s.get(b(7) + 0x2c), 56);
  audio.dispose();
});
test('registered music opcode advances through stop, expression mode, and retry without partial writes', async () => {
  const vm = runtime([
    0,
    0x21,
    2,
    ...literal(2),
    ...literal(1),
    0,
    3,
    0,
    0x21,
    1,
    ...literal(10000),
    0,
    3,
  ]);
  await vm.boot();
  assert.equal(vm.runContext(0), 'yield');
  assert.equal(vm.state.variable(0x4358 / 4), 2);
  assert.equal(vm.state.get(b(7) + 4), 1);
  assert.equal(vm.state.bytes(0x17acbd2, 1)[0], 1);
  assert.equal(vm.runContext(0), 'yield');
  assert.equal(vm.state.variable(0x4358 / 4), 65535);
  assert.equal(vm.state.get(b(7)), -1);
});
test('audio request mode 2 resumes without consuming expressions and clears pause/fade state', async () => {
  const vm = runtime([0, 0x23, 1, 2, 0, 0x12, ...literal(99), 0, 3]);
  await vm.boot();
  const base = b(1),
    device = 0x1d90900 + 0x5218;
  vm.state.put(0x5a70dc, 0);
  vm.state.put(device + 8, 1, 1);
  vm.state.put(device + 13, 1, 1);
  vm.state.put(base + 0x40, 0x12345678, 8);
  vm.state.put(base + 0x48, 0x23456789, 8);
  assert.equal(vm.runContext(0), 'yield');
  assert.equal(vm.state.flag(99), 1);
  assert.equal(vm.state.get(0x5a70dc), 1);
  assert.equal(vm.state.bytes(device + 13, 1)[0], 0);
  assert.equal(vm.state.view(base + 0x40, 8).getBigUint64(0, true), 0n);
  assert.equal(vm.state.view(base + 0x48, 8).getBigUint64(0, true), 0n);
});
test('mode 0 audio replacement stops the old request, retries, then publishes the complete new request', async () => {
  const vm = runtime([0, 0x23, 0, 0, ...literal(10), ...literal(1), 0, 3]);
  await vm.boot();
  const base = b(0);
  vm.state.put(base, 9);
  vm.state.put(base + 4, 0x12345678, 8);
  vm.state.put(base + 0x48, 0x23456789, 8);
  vm.state.put(base + 0x50, 0x3456789a, 8);
  vm.state.put(base + 0x6c, 128);
  vm.state.setVariable(0x223c / 4, 16);
  assert.equal(vm.runContext(0), 'yield');
  assert.equal(vm.pc(0), 16);
  assert.equal(vm.state.get(base), -1);
  assert.equal(vm.state.variable(0x223c / 4), 16);
  assert.equal(vm.runContext(0), 'yield');
  assert.equal(vm.state.get(base), 10);
  assert.equal(vm.state.get(base + 4), 1);
  assert.equal(vm.state.get(base + 8), 1);
  assert.equal(vm.state.get(base + 0xc), 1);
  assert.equal(vm.state.get(base + 0x3c), 0);
  assert.equal(vm.state.get(base + 0x44), 0);
  assert.equal(vm.state.get(base + 0x48), 1);
  assert.equal(vm.state.get(base + 0x4c), 0x80000);
  assert.equal(vm.state.view(base + 0x50, 8).getBigUint64(0, true), 0n);
  assert.equal(vm.state.variable(0x223c / 4), 0);
  assert.equal(vm.state.variable(0x435c / 4), 10);
});
test('mode 1 audio requests retry until the native ready fields match', async () => {
  const vm = runtime([0, 0x23, 2, 1, ...literal(56), ...literal(0), 0, 3]);
  await vm.boot();
  const base = b(2);
  vm.state.put(base, -1);
  assert.equal(vm.runContext(0), 'yield');
  assert.equal(vm.pc(0), 16);
  assert.equal(vm.state.get(base + 8), 0);
  assert.equal(vm.state.get(base + 0x44), 1);
  assert.equal(vm.state.variable(0x4364 / 4), 65535);
  vm.state.put(base + 0x14, 56);
  vm.state.put(base + 0x24, 1);
  assert.equal(vm.runContext(0), 'yield');
  assert.ok(vm.pc(0) > 16);
});
test('audio requests above 9999 consume both expressions without touching channel state', async () => {
  const vm = runtime([0, 0x23, 7, 255, ...literal(10000), ...assignment(0x28, 20, 3), 0, 3]);
  await vm.boot();
  const base = b(7);
  vm.state.bytes(base, 0x98).fill(0xa5);
  const before = Uint8Array.from(vm.state.bytes(base, 0x98));
  assert.equal(vm.runContext(0), 'yield');
  assert.deepEqual(vm.state.bytes(base, 0x98), before);
  assert.equal(vm.state.variable(20), 3);
  assert.equal(vm.context(0).getInt32(0x1c, true), 3);
});
test('music stop yields after the fade request and nonzero modes clear both channel modes', async () => {
  const vm = runtime([0, 0x22, 0, 0, 3]);
  await vm.boot();
  const active = 7,
    base = b(active);
  vm.state.put(0x20dde8, active);
  vm.state.setVariable(0x4358 / 4, 2);
  vm.state.setVariable(0x2238 / 4, 16);
  vm.state.put(base + 0x68, 3);
  assert.equal(vm.runContext(0), 'yield');
  assert.equal(vm.state.variable(0x4358 / 4), 65535);
  assert.equal(vm.state.get(base), -1);
  assert.equal(vm.state.get(base + 12), 0);
  assert.equal(vm.state.get(base + 0x50), 1);
  assert.equal(vm.state.get(base + 0x54), 3 << 12);
  assert.equal(vm.state.variable(0x2238 / 4), 0);
  const clear = runtime([0, 0x22, 255, 0, 3]);
  await clear.boot();
  clear.state.put(0x20dde8, 7);
  clear.state.put(0x20ddec, 8);
  clear.state.put(0x1db47b0, 1, 1);
  clear.state.put(0x1db47bb, 0xa5, 1);
  clear.state.flags[0x136] = 0xff;
  for (const channel of [7, 8])
    for (const offset of [4, 0x18, 0x30]) clear.state.put(b(channel) + offset, 0x12345678);
  assert.equal(clear.runContext(0), 'yield');
  assert.equal(clear.state.bytes(0x1db47bb, 1)[0], 0);
  assert.equal(clear.state.flags[0x136], 0xef);
  for (const channel of [7, 8])
    for (const offset of [4, 0x18, 0x30]) assert.equal(clear.state.get(b(channel) + offset), 0);
});
test('sound stop maps selectors zero through two and requests a minimum fade step', async () => {
  for (const [selector, channel] of [
    [0, 3],
    [1, 4],
    [2, 5],
    [7, 7],
    [255, 255],
  ]) {
    const vm = runtime([0, 0x38, selector, ...literal(16), 0, 3]);
    await vm.boot();
    const base = b(channel);
    vm.state.put(base + 0x2c, 9);
    vm.state.put(base + 0x38, 1);
    vm.state.put(base + 0x3c, 0);
    vm.state.put(base + 0x68, 3);
    vm.state.put(base + 8, 0x76543210);
    assert.equal(vm.runContext(0), 'yield');
    assert.equal(vm.state.get(base), -1);
    assert.equal(vm.state.get(base + 4), 0);
    assert.equal(vm.state.get(base + 8), 0);
    assert.equal(vm.state.get(base + 12), 0);
    assert.equal(vm.state.get(base + 0x50), 1);
    assert.equal(vm.state.get(base + 0x54), 3 << 12 < 0x10000 ? 0x10000 : 3 << 12);
  }
});
test('general audio stop implements fades, immediate device clears, and the all-channel reset', async () => {
  for (const [selector, duration, expected] of [
    [0, 16, 0x10000],
    [1, 1, 3 << 16],
    [3, 0, 0],
  ]) {
    const vm = runtime([0, 0x24, selector, 0, 3]);
    await vm.boot();
    const base = b(selector);
    vm.state.setVariable(0x223c / 4, duration);
    vm.state.put(base + 0x2c, 9);
    vm.state.put(base + 0x38, 1);
    vm.state.put(base + 0x3c, 0);
    vm.state.put(base + 0x68, 3);
    vm.state.put(base + 8, 0x76543210);
    assert.equal(vm.runContext(0), 'yield');
    assert.equal(vm.state.get(base), -1);
    assert.equal(vm.state.get(base + 4), 0);
    assert.equal(vm.state.get(base + 8), 0);
    assert.equal(vm.state.get(base + 12), 0);
    assert.equal(vm.state.variable(0x223c / 4), 0);
    assert.equal(vm.state.get(base + 0x50), duration ? 1 : 0);
    assert.equal(vm.state.get(base + 0x54), expected);
    if (selector < 3) assert.equal(vm.state.variable((0x435c + selector * 4) / 4), 65535);
  }
  const device = runtime([0, 0x24, 11, 0, 0x12, ...literal(99), 0, 3]);
  await device.boot();
  const d = 0x1d90900 + 0x5218;
  device.state.put(d + 8, 1, 1);
  device.state.put(d + 0x13, 0xa5, 1);
  for (const offset of [4, 0x18, 0x30]) device.state.put(b(1) + offset, 0x12345678);
  device.state.setVariable(0x223c / 4, 17);
  assert.equal(device.runContext(0), 'yield');
  assert.equal(device.state.bytes(d + 0x13, 1)[0], 0);
  for (const offset of [4, 0x18, 0x30]) assert.equal(device.state.get(b(1) + offset), 0);
  assert.equal(device.state.variable(0x4360 / 4), 65535);
  assert.equal(device.state.variable(0x223c / 4), 17);
  assert.equal(device.state.flag(99), 1);
  const all = runtime([0, 0x24, 255, 0, 3]);
  await all.boot();
  all.state.setVariable(0x223c / 4, 23);
  for (let channel = 0; channel < 3; channel++) {
    all.state.put(b(channel), channel);
    all.state.put(b(channel) + 4, 1);
    all.state.put(b(channel) + 8, 2);
    all.state.put(b(channel) + 12, 3);
  }
  assert.equal(all.runContext(0), 'yield');
  for (let channel = 0; channel < 3; channel++) {
    assert.equal(all.state.get(b(channel)), -1);
    assert.equal(all.state.get(b(channel) + 4), 0);
    assert.equal(all.state.get(b(channel) + 8), 0);
    assert.equal(all.state.get(b(channel) + 12), 0);
    assert.equal(all.state.variable((0x435c + channel * 4) / 4), 65535);
  }
  assert.equal(all.state.variable(0x223c / 4), 23);
});
test('sound stop still consumes and yields when fade preconditions fail', async () => {
  for (const [duration, current, playing, phase] of [
    [0, 9, 1, 0],
    [16, -1, 1, 0],
    [16, 9, 0, 0],
    [16, 9, 1, 1],
  ]) {
    const vm = runtime([0, 0x38, 0, ...literal(duration), 0, 3]);
    await vm.boot();
    const base = b(3);
    vm.state.put(base + 0x2c, current);
    vm.state.put(base + 0x38, playing);
    vm.state.put(base + 0x3c, phase);
    vm.state.put(base + 0x50, 0x12345678);
    assert.equal(vm.runContext(0), 'yield');
    assert.equal(vm.pc(0), 26);
    assert.equal(vm.state.get(base + 0x50), 0x12345678);
  }
});
test('browser transport retains cumulative loop time across pause and disposes pending preparations', async () => {
  const nodes = [];
  const context = {
    currentTime: 0,
    destination: {},
    async resume() {},
    async close() {},
    createBuffer(ch, n, rate) {
      return {copyToChannel() {}};
    },
    createGain() {
      return {
        gain: {
          value: 0,
          setValueAtTime(v) {
            this.value = v;
          },
        },
        connect() {},
        disconnect() {},
      };
    },
    createBufferSource() {
      const node = {
        connect() {},
        disconnect() {},
        stop() {},
        start(...args) {
          this.args = args;
        },
      };
      nodes.push(node);
      return node;
    },
  };
  const clip = {
    sampleRate: 100,
    sampleCount: 1000,
    channels: [new Float32Array(1000)],
    loop: {start: 200, end: 600},
  };
  const transport = new BrowserAudioTransport(async () => clip, context),
    voice = await transport.prepare(8, 2, true);
  voice.pause(false);
  context.currentTime = 7;
  assert.equal(voice.position(), 700);
  voice.pause(true);
  context.currentTime = 10;
  assert.equal(voice.position(), 700);
  voice.pause(false);
  assert.deepEqual(nodes[1].args, [0, 3]);
  context.currentTime = 12;
  assert.equal(voice.position(), 900);
  transport.dispose();
  let resolve;
  const late = new BrowserAudioTransport(() => new Promise((r) => (resolve = r)), context),
    result = late.prepare(8, 2, false);
  late.dispose();
  resolve(clip);
  await assert.rejects(result, /disposed/);
});

test('00/3b immediately pauses and resumes bound scene audio without pausing BGM', async () => {
  const {pauseSceneAudio} =
      await import('../dist/engines/mages/games/chaos-head-noah/sc3/opcodes/music.js'),
    s = new NoahState(() => 0);
  s.initialize();
  const host = device(),
    audio = new NoahAudio(s, host);
  audio.initialize();
  for (const channel of [0, 3, 7]) {
    s.put(b(channel), 2);
    s.put(b(channel) + 8, 1);
    s.put(b(channel) + 12, 1);
  }
  audio.advance();
  await audio.settle();
  audio.publish();
  audio.advance();
  assert.equal(host.voices.length, 3);
  let selector = 255;
  const h = {state: s, skip() {}, byte: () => selector, pauseAudio: (i, p) => audio.pause(i, p)};
  pauseSceneAudio(h);
  assert.deepEqual(
    host.voices.map((v) => v.paused),
    [true, true, false],
  );
  selector = 0;
  pauseSceneAudio(h);
  assert.deepEqual(
    host.voices.map((v) => v.paused),
    [false, false, false],
  );
  audio.dispose();
});

test('paired music blend uses native frame increments and exact endpoint crossing', async () => {
  const {pairedMusic} =
      await import('../dist/engines/mages/games/chaos-head-noah/sc3/opcodes/music.js'),
    s = new NoahState(() => 0);
  s.initialize();
  const audio = new NoahAudio(s);
  audio.initialize();
  let selector = 2,
    duration = 3;
  const h = {state: s, skip() {}, byte: () => selector, expression: () => duration};
  s.setVariable(0x43a8 / 4, 3);
  pairedMusic(h);
  for (const expected of [2, 1, 0]) {
    audio.advance();
    assert.equal(s.variable(0x43a8 / 4), expected);
    assert.equal(s.variable(0x43b0 / 4), -1);
  }
  audio.advance();
  assert.equal(s.variable(0x43b0 / 4), 0);
  selector = 3;
  duration = 1;
  s.setVariable(0x43a8 / 4, 999);
  pairedMusic(h);
  audio.advance();
  assert.equal(s.variable(0x43a8 / 4), 1000);
  assert.equal(s.variable(0x43b0 / 4), 1);
  audio.advance();
  assert.equal(s.variable(0x43b0 / 4), 0);
});

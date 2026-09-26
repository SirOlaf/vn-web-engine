import test from 'node:test';
import assert from 'node:assert/strict';
import {StreamMovieVoice} from '../dist/video/stream-voice.js';
import {BrowserStreamMoviePlayer} from '../dist/video/browser-stream-player.js';
import {allocateFrame} from '../dist/video/frame.js';
import {movieRgba} from '../dist/video/rgba.js';
class WorkerFixture {
  static all = [];
  requests = [];
  terminated = false;
  constructor() {
    WorkerFixture.all.push(this);
  }
  postMessage(m) {
    this.requests.push(m);
  }
  terminate() {
    this.terminated = true;
  }
  batch(start, count, {done = false, duration = 1} = {}) {
    const info = {
      width: 16,
      height: 16,
      frameRate: 30,
      frameCount: 30,
      sampleRate: 48000,
      channels: 1,
      sampleCount: 48000,
      duration,
    };
    this.onmessage({
      data: {
        type: 'batch',
        info,
        done,
        frames: Array.from({length: count}, (_, i) => ({
          ...allocateFrame(16, 16),
          index: start + i,
        })),
        audio: [{start: start * 1600, channels: [new Float32Array(count * 1600)]}],
      },
    });
  }
}
function context() {
  const nodes = [];
  return {
    currentTime: 0,
    destination: {},
    nodes,
    createGain() {
      return {gain: {value: 1}, connect() {}, disconnect() {}};
    },
    createBuffer(channels, count, rate) {
      const data = Array.from({length: channels}, () => new Float32Array(count));
      return {duration: count / rate, getChannelData: (i) => data[i]};
    },
    createBufferSource() {
      const n = {
        connect() {},
        disconnect() {},
        stop() {
          n.stopped = true;
        },
        start(at, offset) {
          n.at = at;
          n.offset = offset;
        },
      };
      nodes.push(n);
      return n;
    },
  };
}
test('movie stream buffers, preserves paused position, reschedules PCM and cancels its worker', () => {
  const old = globalThis.Worker;
  globalThis.Worker = WorkerFixture;
  try {
    const c = context(),
      v = new StreamMovieVoice(c, {kind: 'blob', blob: new Blob()}),
      w = WorkerFixture.all.at(-1);
    v.pause(false);
    assert.equal(v.snapshot().status, 2);
    w.batch(0, 4);
    assert.equal(v.snapshot().status, 5);
    assert.equal(c.nodes.length, 1);
    c.currentTime = 0.07;
    v.pause(true);
    assert.equal(v.snapshot().positionMs, 50);
    assert.equal(c.nodes[0].stopped, true);
    c.currentTime = 4;
    assert.equal(v.snapshot().positionMs, 50);
    w.batch(4, 4);
    v.pause(false);
    assert.ok(c.nodes.length >= 3);
    assert.ok(Math.abs(c.nodes[1].offset - 0.05) < 1e-8);
    v.dispose();
    assert.equal(w.terminated, true);
    assert.ok(c.nodes.every((n) => n.stopped));
  } finally {
    globalThis.Worker = old;
  }
});
test('movie stream reaches the actual end and prefetches looping data on the same clock', () => {
  const old = globalThis.Worker;
  globalThis.Worker = WorkerFixture;
  try {
    for (const loop of [false, true]) {
      const c = context(),
        v = new StreamMovieVoice(c, {kind: 'blob', blob: new Blob()});
      v.loop(loop);
      v.pause(false);
      const w = WorkerFixture.all.at(-1);
      w.batch(0, 4, {done: true, duration: 4 / 30});
      if (loop) {
        const next = WorkerFixture.all.at(-1);
        assert.notEqual(next, w);
        assert.equal(w.terminated, true);
        next.batch(0, 4, {done: true, duration: 4 / 30});
      }
      c.currentTime = 0.16;
      const snap = v.snapshot();
      assert.equal(snap.status, loop ? 5 : 6);
      assert.equal(snap.positionMs, loop ? 6 : 133);
      v.dispose();
    }
  } finally {
    globalThis.Worker = old;
  }
});
test('movie worker errors are surfaced and stale responses after disposal are ignored', () => {
  const old = globalThis.Worker;
  globalThis.Worker = WorkerFixture;
  try {
    const c = context(),
      v = new StreamMovieVoice(c, {kind: 'blob', blob: new Blob()}),
      w = WorkerFixture.all.at(-1);
    w.onmessage({data: {type: 'error', message: 'bad stream'}});
    assert.throws(() => v.snapshot(), /Movie decoding failed/);
    v.dispose();
    assert.doesNotThrow(() => w.batch(0, 4));
  } finally {
    globalThis.Worker = old;
  }
});
test('timestamped movie resumes after a video underrun when its delayed audio has already ended', () => {
  const old = globalThis.Worker;
  globalThis.Worker = WorkerFixture;
  try {
    const c = context(),
      v = new StreamMovieVoice(c, {kind: 'blob', blob: new Blob()});
    const w = WorkerFixture.all.at(-1);
    const info = {
      width: 16,
      height: 16,
      frameRate: 10,
      frameCount: 6,
      duration: 0.6,
      sampleRate: 48000,
      channels: 1,
      sampleCount: 4800,
      videoEndTime: 0.6,
      audioEndTime: 0.18,
    };
    const batch = (start, done = false) =>
      w.onmessage({
        data: {
          type: 'batch',
          info,
          done,
          frames: [start, start + 1].map((index) => ({
            ...allocateFrame(16, 16),
            index,
            timestamp: index / 10,
            duration: 0.1,
          })),
          audio: start ? [] : [{start: 0, timestamp: 0.08, channels: [new Float32Array(4800)]}],
        },
      });
    assert.equal(v.metadata, undefined);
    v.pause(false);
    batch(0);
    assert.equal(v.metadata, info);
    assert.ok(Math.abs(c.nodes[0].at - 0.1) < 1e-9);
    c.currentTime = 0.27;
    assert.equal(v.snapshot().positionMs, 200);
    batch(2);
    c.currentTime = 0.42;
    assert.ok(v.snapshot().positionMs >= 329, 'video resumes beyond the completed audio track');
    batch(4, true);
    c.currentTime = 1;
    assert.equal(v.snapshot().status, 6);
    assert.equal(v.snapshot().positionMs, 600);
    v.dispose();
  } finally {
    globalThis.Worker = old;
  }
});
test('movie color conversion retains limited-range black/white and opaque output', () => {
  const f = allocateFrame(16, 16);
  f.y.fill(16);
  f.cb.fill(128);
  f.cr.fill(128);
  assert.deepEqual([...movieRgba(f).pixels.slice(0, 4)], [0, 0, 0, 255]);
  f.y.fill(235);
  assert.deepEqual([...movieRgba(f).pixels.slice(0, 4)], [255, 255, 255, 255]);
});
test('movie clock crosses indexed silence beyond prefetch and surfaces a failed worker transfer', () => {
  const old = globalThis.Worker;
  globalThis.Worker = WorkerFixture;
  const c = context();
  const v = new StreamMovieVoice(c, {kind: 'blob', blob: new Blob()});
  try {
    const w = WorkerFixture.all.at(-1);
    const info = {
      width: 16,
      height: 16,
      frameRate: 30,
      frameCount: 36,
      duration: 1.2,
      sampleRate: 48000,
      channels: 1,
      sampleCount: 4800,
      videoEndTime: 1.2,
      audioStartTime: 0.8,
      audioEndTime: 0.9,
    };
    const batch = (start, audio = []) =>
      w.onmessage({
        data: {
          type: 'batch',
          info,
          done: false,
          frames: Array.from({length: 4}, (_, offset) => ({
            ...allocateFrame(16, 16),
            index: start + offset,
          })),
          audio,
        },
      });
    v.pause(false);
    batch(0);
    batch(4);
    batch(8);
    assert.equal(c.nodes.length, 0);
    c.currentTime = 0.22;
    assert.equal(v.snapshot().positionMs, 200, 'known silence does not block the video clock');
    batch(12, [{start: 0, timestamp: 0.8, channels: [new Float32Array(4800)]}]);
    assert.ok(Math.abs(c.nodes[0].at - 0.82) < 1e-9, 'PCM retains its delayed PTS');
    w.onmessageerror();
    assert.equal(w.terminated, true);
    assert.equal(c.nodes[0].stopped, true);
    assert.throws(
      () => v.snapshot(),
      (error) => /could not be transferred/.test(error.cause.message),
    );
  } finally {
    v.dispose();
    globalThis.Worker = old;
  }
});
test('browser movie lifecycle reports exact end time and joins a borrowed frame before closing its device', async () => {
  const oldWorker = globalThis.Worker,
    oldContext = globalThis.AudioContext;
  const c = Object.assign(context(), {
    state: 'running',
    addEventListener() {},
    removeEventListener() {},
    async close() {
      c.state = 'closed';
    },
  });
  const document = {defaultView: null, addEventListener() {}, removeEventListener() {}};
  globalThis.Worker = WorkerFixture;
  globalThis.AudioContext = class {
    constructor() {
      return c;
    }
  };
  let player, release;
  try {
    const opening = BrowserStreamMoviePlayer.open(
      {kind: 'blob', blob: new Blob()},
      document,
      new AbortController().signal,
    );
    const worker = WorkerFixture.all.at(-1);
    worker.batch(0, 4, {done: true, duration: 4 / 30});
    player = await opening;
    player.start(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    c.currentTime = 1;
    assert.equal(player.position, 4 / 30, 'native completion poll must reach the exact duration');
    const closing = player.closeAndJoin();
    assert.equal(worker.terminated, true);
    assert.equal(c.state, 'running', 'consumer still owns a frame');
    release();
    await closing;
    assert.equal(c.state, 'closed');
  } finally {
    release?.();
    await player?.closeAndJoin();
    globalThis.Worker = oldWorker;
    globalThis.AudioContext = oldContext;
  }
});

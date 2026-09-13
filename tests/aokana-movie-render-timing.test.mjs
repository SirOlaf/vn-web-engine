import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaMovieRenderTiming} from '../dist/engines/buriko/games/aokana/native/movie-render-timing.js';

test('movie render policy preserves the native bias and schedules early samples', () => {
  const timing = new AokanaMovieRenderTiming(123);
  assert.equal(timing.sampleLateness(1000000n, 0n), -920000);
  assert.equal(timing.sampleLateness(79999n, 0n), -79999);
  assert.deepEqual(timing.quality(-920000n, 0n), {
    type: 0,
    proportion: 1000,
    late: -920000n,
    timestamp: 0n,
  });
  assert.deepEqual(timing.decide(1000000n, 1400000n, 0n, 1, 1), {
    status: 1,
    start: 920000n,
    end: 1320000n,
  });
  // The falling earliness filter starts at zero, so it does not immediately
  // advance the first scheduled sample by a whole frame.
  assert.equal(timing.earliness, 0);
  assert.equal(timing.waitAverage, 230000);
  assert.equal(timing.lastDraw, 920000n);
  assert.equal(timing.performanceInterval, 921000);
  assert.equal(timing.drawn, 0);
  timing.renderStart(130);
  assert.equal(timing.drawn, 1);
  assert.equal(timing.renderEnd(132), 0);
  assert.equal(timing.renderAverage, 0);
  assert.equal(timing.renderLast, 20000);
  timing.renderStart(140);
  timing.renderEnd(142);
  assert.equal(timing.renderAverage, 5000);
});

test('late drop, quality feedback, force-draw and long-wait branches remain distinct', () => {
  const timing = new AokanaMovieRenderTiming(0);
  timing.renderAverage = 200000;
  timing.duration = timing.frameAverage = 400000;
  timing.lastDraw = 0n;
  assert.equal(timing.decide(1000000n, 1400000n, 1200000n, 1, 1).status, 0x80004005);
  assert.equal(timing.normalCount, -1);
  assert.equal(timing.dropped, 0);
  timing.recordSchedulingFailure();
  assert.equal(timing.dropped, 1);
  // A supplier which accepts quality notifications gets four frame durations.
  assert.equal(timing.decide(1400000n, 1800000n, 1200000n, 0, 1).status, 0);
  assert.equal(timing.normalCount, 0);
  assert.equal(timing.earliness, -120000);
  const early = timing.decide(20000000n, 20400000n, 0n, 0, 0);
  assert.equal(early.status, 1); // Discontinuity cannot force a >900 ms early frame.
  assert.equal(early.start, 19520000n);
  assert.equal(timing.normalCount, 1);
  timing.waitAverage = 0;
  timing.lastDraw = 0n;
  assert.equal(timing.decide(1000000n, 1400000n, 11000000n, 1, 1).status, 0);
});

test('quality uses integer ratios and native signed throttling', () => {
  const timing = new AokanaMovieRenderTiming(0);
  timing.frameAverage = 400000;
  timing.renderAverage = 101;
  timing.waitAverage = 100000;
  assert.deepEqual(timing.quality(-50000n, 987654n), {
    type: 0,
    proportion: 1000,
    late: -49950n,
    timestamp: 987654n,
  });
  timing.waitAverage = 300000;
  assert.equal(timing.quality(-50000n, 0n).proportion, 2000);
  assert.equal(timing.quality(5000001n, 0n).proportion, 500);
  assert.equal(timing.notify(500), 0);
  assert.equal(timing.throttle, 253028);
  assert.equal(timing.throttleMilliseconds(), 25);
  timing.notify(-168);
  assert.equal(timing.throttle, -389210000);
  assert.equal(timing.throttleMilliseconds(), 0);
  assert.throws(() => timing.notify(-167), /division faults/);
  timing.notify(1000);
  assert.equal(timing.throttle, 0);
});

test('quality statistics and timer arithmetic keep the native count exclusions and wrap', () => {
  const timing = new AokanaMovieRenderTiming(0xfffffff0);
  timing.recordFrame(20000000, 1230000);
  timing.recordFrame(-20000000, -10000);
  timing.recordFrame(20000000, -10000);
  timing.recordFrame(-20000000, -10000);
  assert.equal(timing.drawn, 4);
  assert.equal(timing.latenessSum, 0n);
  assert.equal(timing.latenessSquares, 2000000n);
  assert.equal(timing.intervalSum, 1000n);
  assert.equal(timing.intervalSquares, 1000000n);
  timing.renderAverage = 100000;
  timing.renderStart(0xfffffffe);
  timing.renderEnd(2);
  assert.equal(timing.renderLast, 40000);
  assert.equal(timing.renderAverage, 85000);
  timing.stopStreaming(0x10);
  assert.equal(timing.streamingMilliseconds, 32);
  timing.supplierHandling = 1;
  timing.reset(20);
  assert.equal(timing.supplierHandling, 1);
  assert.equal(timing.lastDraw, -1000n);
  assert.equal(timing.frameAverage, -1);
  assert.equal(timing.drawn, 0);
  timing.preparePerformance(10000, 400000);
  assert.equal(timing.directRender(), 0);
  assert.equal(timing.renderLast, 5000000);
  assert.equal(timing.drawn, 1);
});

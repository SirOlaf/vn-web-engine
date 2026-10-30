import {EmoteEye} from '../dist/native/emotedriver/runtime/controls/eye.js';
import {EmoteEyebrow} from '../dist/native/emotedriver/runtime/controls/eyebrow.js';
import {EmoteGraph, EmoteGraphFollower} from '../dist/native/emotedriver/runtime/controls/graph.js';
import {EMOTEDRIVER_X64_SHA256} from '../dist/native/emotedriver/build.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EmoteBust,
  EmoteMouth,
  EmoteOrbit,
  EmotePendulum,
  EmoteWind,
  EmoteXorshift128,
  createEmoteControls,
  emoteSoftAngle,
} from '../dist/native/emotedriver/runtime/controls/index.js';
import {EmoteTween} from '../dist/native/emotedriver/runtime/controls/transition.js';
import {EmoteSelector} from '../dist/native/emotedriver/runtime/controls/selector.js';

const f32 = Math.fround;
const vec = (x = 0, y = 0, z = 0) => ({x, y, z});

/** Metadata with only the given control lists (the reader's shape). */
function metadata(controls = {}) {
  return {
    scale: 1,
    bustControl: [],
    hairControl: [],
    partsControl: [],
    eyeControl: [],
    eyebrowControl: [],
    mouthControl: [],
    transitionControl: [],
    selectorControl: null,
    clampControl: [],
    loopControl: [],
    ...controls,
  };
}

/** Host with variables in a Map and an optional base-layer point. */
function host(extra = {}) {
  const cells = new Map();
  return {
    cells,
    variable(label) {
      if (!cells.has(label)) cells.set(label, {label, value: 0});
      return cells.get(label);
    },
    value: (label) => cells.get(label)?.value,
    clips: [],
    currentClip: 0,
    rootAngle: 0,
    hairScale: 1,
    partsScale: 1,
    bustScale: 1,
    random: () => 0,
    wind: null,
    ...extra,
  };
}

const eyeControl = (fields = {}) => ({
  enabled: true,
  label: 'eye',
  beginFrame: 0,
  endFrame: 10,
  blinkIntervalMin: 30,
  blinkIntervalMax: 30,
  blinkFrameCount: 5,
  blinkEnabled: true,
  edge: [[0, 10]],
  node: [],
  unread: {},
  ...fields,
});

test('shared generator follows the native xorshift update', () => {
  const r = new EmoteXorshift128(0);
  assert.deepEqual([r.nextWord(), r.nextWord(), r.nextWord()], [3656013424, 504890837, 2421774896]);
  const s = new EmoteXorshift128(0);
  assert.equal(s.next(), (3656013424 & 0x7fffff) / 0x800000);
});

test('eye blink: interval, close, hold, open', () => {
  const controls = createEmoteControls(metadata({eyeControl: [eyeControl()]}), {
    random: () => 0.5,
  });
  const h = host();
  const out = [];
  for (let i = 0; i < 36; i++) {
    controls.stepEyes(h, 1);
    out.push(h.value('eye'));
  }
  // 30 open frames count the interval down; closing and opening take 2 frames each
  // (10 frames · 2.5 / 5 per frame) with 1 closed frame (5 / 5) between.
  assert.deepEqual(out.slice(28, 36), [0, 0, 5, 10, 10, 5, 0, 0]);
});

test('eyebrow follows the graph route through a node', () => {
  const brow = {
    enabled: true,
    label: 'brow',
    beginFrame: 0,
    edge: [
      [0, 10],
      [20, 30],
    ],
    node: [[10, 20]],
    unread: {},
  };
  const controls = createEmoteControls(metadata({eyebrowControl: [brow]}));
  const bindings = [];
  controls.bindVariables(5, (label, index) => bindings.push([label, index]));
  assert.deepEqual(bindings, [['brow', 0]]);
  controls.setVariable(5, 0, 'brow', 25, 15, 1, false);
  const graph = controls.eyebrows[0].motion.graph;
  assert.deepEqual(graph.search(0, 25), [
    [0, 10],
    [20, 25],
  ]);
  assert.equal(graph.total, 15);
  const h = host();
  const out = [];
  for (let i = 0; i < 18; i++) {
    controls.stepEyebrows(h, 1);
    out.push(h.value('brow'));
  }
  assert.equal(out[1], 0);
  assert.ok(Math.abs(out[2] - 1) < 1e-5);
  assert.equal(out[11], 10);
  assert.equal(out[12], 20);
  assert.equal(out[17], 25);
  assert.equal(controls.isAnimating(new Set()), true);
  // The next update finds the route empty and goes idle.
  controls.stepEyebrows(h, 1);
  assert.equal(controls.isAnimating(new Set()), false);
});

test('graph without a route jumps to the target', () => {
  const brow = {enabled: true, label: 'b', beginFrame: 0, edge: [[0, 5]], node: [], unread: {}};
  const controls = createEmoteControls(metadata({eyebrowControl: [brow]}));
  assert.deepEqual(controls.eyebrows[0].motion.graph.search(0, 9), [[9, 9]]);
  assert.equal(controls.eyebrows[0].motion.graph.total, 0);
});

test('mouth: frame variable and eased talk level', () => {
  const mouth = {enabled: true, label: 'm', talkLabel: 't', beginFrame: 2, unread: {}};
  const controls = createEmoteControls(metadata({mouthControl: [mouth]}));
  const h = host();
  controls.setVariable(6, 0, 'm', 3.7, 0, 1, false);
  controls.setVariable(6, 0, 't', 1, 4, 2, false);
  const levels = [];
  for (let i = 0; i < 5; i++) {
    controls.stepMouths(h, 1);
    levels.push(h.value('t'));
  }
  assert.equal(h.value('m'), 3);
  assert.deepEqual(levels, [0, f32(0.0625), 0.25, f32(0.5625), 1]);
  controls.setVariable(6, 0, 't', 0.5, 10, 1, false);
  assert.equal(controls.isAnimating(new Set()), true);
  assert.equal(controls.isAnimating(new Set(['m'])), false);
  controls.skip();
  controls.stepMouths(h, 1);
  assert.equal(h.value('t'), 0.5);
});

test('x64 mouth uses immediate value-tween progress and copies queued state', () => {
  const settings = {enabled: true, label: 'shape', talkLabel: 'talk', beginFrame: 2.75, unread: {}};
  const mouth = new EmoteMouth(settings, EMOTEDRIVER_X64_SHA256);
  mouth.set(1, 4, 1, false);
  assert.deepEqual(mouth.update(1), [2, 0.25]);
  mouth.set(0, 2, 1, true);
  const copy = new EmoteMouth(settings, EMOTEDRIVER_X64_SHA256);
  copy.assign(mouth);
  assert.deepEqual(copy.update(1), mouth.update(1));
  copy.skip();
  assert.deepEqual(copy.update(0), [2, 0]);
  assert.equal(copy.busy, false);
  assert.throws(() => copy.assign(new EmoteMouth(settings)), /between DLL builds/);
});

test('loop control cycles its transition list', () => {
  const loop = {
    enabled: true,
    transitionList: [
      [0, 10, 4],
      [10, 0, 2],
    ],
    var_loop: 'L',
    unread: {},
  };
  const controls = createEmoteControls(metadata({loopControl: [loop]}));
  const h = host();
  const out = [];
  for (let i = 0; i < 7; i++) {
    controls.stepLoops(h, 1);
    out.push(h.value('L'));
  }
  assert.deepEqual(out, [2.5, 5, 7.5, 10, 5, 0, 2.5]);
});

test('x64 orbit emits variable requests at value boundaries and wraps its interval', () => {
  const settings = {label: 'orbit', interval: 8, tween: true, orbitFrameList: [0, 10, 20, 30]};
  const orbit = new EmoteOrbit(settings, EMOTEDRIVER_X64_SHA256);
  assert.deepEqual(orbit.step(1), {value: 0, frames: 2});
  assert.equal(orbit.step(1), null);
  assert.deepEqual(orbit.step(1), {value: 10, frames: 2});
  assert.deepEqual(orbit.step(2), {value: 20, frames: 2});
  assert.deepEqual(orbit.step(4), {value: 0, frames: 2});
  assert.throws(() => new EmoteOrbit(settings, 'unknown'), /unsupported DLL build/);
});

test('selector drives transition tweens to on and off values', () => {
  const tweens = new Map([
    ['a', new EmoteTween(1)],
    ['b', new EmoteTween(1)],
  ]);
  const selector = {
    label: 'sel',
    optionList: [
      {label: 'a', offValue: 0, onValue: 1},
      {label: 'b', offValue: 0, onValue: 1},
    ],
    unread: {},
  };
  const controls = createEmoteControls(metadata({selectorControl: [selector]}), {
    transition: (label) => tweens.get(label) ?? null,
  });
  // Construction selects option 0 immediately.
  assert.equal(tweens.get('a').current[0], 1);
  assert.equal(tweens.get('b').current[0], 0);
  controls.setVariable(8, 0, 'sel', 1, 10, 1, false);
  const h = host();
  controls.stepSelectors(h, 1);
  assert.equal(h.value('sel'), 1);
  assert.equal(tweens.get('b').busy, true);
  for (let i = 0; i < 12; i++) for (const t of tweens.values()) t.step(1);
  assert.equal(tweens.get('a').current[0], 0);
  assert.equal(tweens.get('b').current[0], 1);
});

test('selector accepts an alternate transition and preserves each build’s distance threshold', () => {
  const control = {
    label: 'select',
    optionList: [{label: 'option', offValue: 0, onValue: 100000000}],
    unread: {},
  };
  const calls = [];
  const transition = {
    busy: false,
    step: () => [99999992],
    set: (...args) => calls.push(args),
  };
  new EmoteSelector(control, () => transition);
  assert.deepEqual(calls, []);
  new EmoteSelector(control, () => transition, EMOTEDRIVER_X64_SHA256);
  assert.deepEqual(calls, [[[100000000], 0, 0, false]]);
  assert.throws(
    () => new EmoteSelector(control, () => transition, 'unknown'),
    /unsupported DLL build/,
  );
});

test('x64 selector advances queued selections in the completing call', () => {
  const control = {label: 'select', optionList: [], unread: {}};
  const selector = new EmoteSelector(control, () => null, EMOTEDRIVER_X64_SHA256);
  selector.set(1, 1, 1, false);
  selector.set(2, 1, 1, true);
  assert.equal(selector.update(1), 2);
  assert.equal(selector.busy, false);
  const upstream = new EmoteSelector(control, () => null);
  upstream.set(1, 1, 1, false);
  upstream.set(2, 1, 1, true);
  assert.equal(upstream.update(1), 1);
  assert.equal(upstream.busy, true);
});

test('wind spawns, moves and retires gusts', () => {
  const draws = [0.01, 0.5, 0.9];
  const wind = new EmoteWind(0, 100);
  wind.set(2, 4, 10);
  wind.update(1, () => draws.shift() ?? 0.99);
  assert.equal(wind.active[0], 1);
  assert.equal(wind.position[0], 10);
  // power = powerMax + (powerMin − powerMax) · r; window ± 2 · power.
  assert.equal(wind.power[0], 3);
  assert.equal(wind.query(15.9), 3);
  assert.equal(wind.query(16), 0);
  for (let i = 0; i < 9; i++) wind.update(1, () => 0.99);
  assert.equal(wind.active[0], 1);
  wind.update(1, () => 0.99);
  assert.equal(wind.active[0], 0);
  const back = new EmoteWind(100, 0);
  back.set(2, 2, 5);
  assert.equal(back.velocity, -5);
});

test('wind preserves each DLL build’s float stores in gust power', () => {
  const values = [];
  for (const build of [undefined, EMOTEDRIVER_X64_SHA256]) {
    const random = new EmoteXorshift128(1700000000);
    const wind = new EmoteWind(0, 100, build);
    wind.set(1.3, 0.1, 0.7);
    for (let i = 0; i < 7; i++) wind.update(f32(1.1), () => random.next());
    values.push(wind.query(0));
  }
  assert.deepEqual(values, [0.9549545645713806, 0.9549546241760254]);
  const bounds = [];
  for (const build of [undefined, EMOTEDRIVER_X64_SHA256]) {
    const wind = new EmoteWind(0, 100, build);
    wind.active[0] = 1;
    wind.position[0] = 100000000;
    wind.power[0] = 0.1;
    bounds.push(wind.query(100000000.1));
  }
  assert.deepEqual(bounds, [f32(0.1), 0]);
  assert.throws(() => new EmoteWind(0, 100, 'unknown'), /unsupported DLL build/);
});

const bustControl = (fields = {}) => ({
  enabled: true,
  param: {op: vec(), p: vec(), pv: vec(), ofs: 0},
  gravity: 0.5,
  spring: 0.1,
  friction: 0.2,
  scale_x: 1,
  scale_y: 1,
  baseLayer: 'base',
  var_lr: 'lr',
  var_ud: 'ud',
  unread: {},
  ...fields,
});

test('bust: first step and 1.1-frame sub-steps', () => {
  const controls = createEmoteControls(metadata({bustControl: [bustControl()]}));
  const h = host();
  controls.stepPhysics(h, 0);
  assert.equal(h.cells.size, 0);
  controls.stepPhysics(h, 1);
  // pv.y = (0 + 0.5) − 0.2 · 0.5 = 0.4; p.y = 0.4; ud = soft(−(0 − 0.4)).
  assert.equal(h.value('ud'), emoteSoftAngle(f32(0.4)));
  assert.equal(Math.abs(h.value('lr')), 0);
  // A 2-frame call runs steps of 1.1 and 0.9.
  const twin = new EmoteBust(bustControl());
  twin.update(0, 0, 1, 1, 0);
  twin.update(0, 0, f32(1.1), 1, 0);
  const [, ud] = twin.update(0, 0, f32(2 - f32(1.1)), 1, 0);
  controls.stepPhysics(h, 2);
  assert.equal(h.value('ud'), ud);
});

test('bust outputs at or below 0.01 are zeroed', () => {
  const controls = createEmoteControls(
    metadata({bustControl: [bustControl({gravity: 0.001, friction: 0})]}),
  );
  const h = host();
  controls.stepPhysics(h, 1);
  assert.equal(h.value('ud'), 0);
});

test('bust follows the base layer and the root rotation', () => {
  const controls = createEmoteControls(metadata({bustControl: [bustControl({gravity: 0})]}));
  let point = {x: 0, y: 0};
  const h = host({shapePoint: () => point, rootX: 0, rootY: 0, inverseScale: 1});
  controls.stepPhysics(h, 1);
  point = {x: 10, y: 0};
  controls.stepPhysics(h, 1);
  // The anchor moved +10 in x; the spring pulled the mass by 0.1 · 10 · (1 − 0.2).
  const lr = h.value('lr');
  assert.ok(lr < 0, `lr ${lr}`);
});

const hair = (fields = {}) => ({
  enabled: true,
  param: {
    op: vec(),
    ofs: 0,
    bendR: 0,
    bendS: 0,
    bp: [vec(0, 10), vec(0, 20)],
    p: [vec(0, 10), vec(0, 20)],
    pv: [vec(), vec()],
  },
  gravity: 0.5,
  friction_x: 0,
  friction_y: 0,
  b_rate: 0,
  v_bound: 0,
  ud_eft: 0,
  bend_spd: 0,
  bend_vol: 0,
  length: [10, 10],
  scale_x: [1, 1],
  scale_y: [1, 1],
  baseLayer: 'base',
  var_lr: 'hlr',
  var_lrm: 'hlrm',
  var_ud: 'hud',
  unread: {},
  ...fields,
});

test('pendulum: gravity step from rest', () => {
  const controls = createEmoteControls(metadata({hairControl: [hair()]}));
  const h = host();
  controls.stepPhysics(h, 1);
  assert.equal(h.value('hud'), emoteSoftAngle(0.5));
  assert.equal(Math.abs(h.value('hlr')), 0);
  assert.equal(Math.abs(h.value('hlrm')), 0);
});

test('pendulum: wind gust pushes both joints', () => {
  const p = new EmotePendulum(hair({gravity: 0}));
  const wind = new EmoteWind(-100, 100);
  wind.set(1, 1, 1);
  wind.active[0] = 1;
  wind.position[0] = 0;
  wind.power[0] = 0.5;
  const out = {lr: 0, lrm: 0, ud: 0};
  p.update(0, 0, 1, 1, 0, wind, out);
  assert.equal(out.lrm, emoteSoftAngle(0.5));
  // Joint 1 is also pulled back onto its rod towards the displaced joint 0.
  assert.ok(out.lr > out.lrm);
  const alternate = new EmotePendulum(hair({gravity: 0}));
  const alternateOut = {lr: 0, lrm: 0, ud: 0};
  alternate.update(0, 0, 1, 1, 0, {query: () => 0.5}, alternateOut);
  assert.deepEqual(alternateOut, out);
});

test('x64 physics samples an alternate wind field through its query interface', () => {
  const pendulum = new EmotePendulum(hair({gravity: 0}), EMOTEDRIVER_X64_SHA256);
  const samples = [],
    out = {lr: 0, lrm: 0, ud: 0};
  const wind = {
    query: (x) => {
      samples.push(x);
      return 0.5;
    },
  };
  // The native entry driver anchors its first sample at zero time.
  pendulum.update(0, 0, 0, 1, 0, wind, out);
  assert.ok(out.lr === 0 && out.lrm === 0 && out.ud === 0);
  assert.equal(samples.length, 2);
  pendulum.update(0, 0, 1, 1, 0, wind, out);
  assert.equal(samples.length, 4);
  assert.ok(out.lr > 0);
  assert.ok(out.lrm > 0);
});

test('pendulum bend sways lr against lrm when |ud| exceeds 28', () => {
  const p = new EmotePendulum(hair({gravity: 200, bend_spd: 1, bend_vol: 2}));
  const out = {lr: 0, lrm: 0, ud: 0};
  p.update(0, 0, 1, 1, 0, null, out);
  assert.ok(Math.abs(out.ud) > 28);
  assert.equal(p.bendS, 0.03125);
  assert.equal(p.bendR, f32(0.03125));
  const sway = f32(f32(Math.sin(p.bendR)) * 0.03125 * 2);
  assert.equal(out.lr, f32(0 + sway));
});

test('pendulum retains each DLL build’s stored bend period', () => {
  const settings = hair({gravity: 0, bend_spd: 0, bend_vol: 2});
  settings.param.bendR = f32(2 * Math.PI);
  settings.param.bendS = 1;
  const upstream = new EmotePendulum(settings);
  const x64 = new EmotePendulum(settings, EMOTEDRIVER_X64_SHA256);
  const oldOut = {lr: 0, lrm: 0, ud: 0},
    newOut = {...oldOut};
  upstream.update(0, 0, 0, 1, 0, null, oldOut);
  x64.update(0, 0, 0, 1, 0, null, newOut);
  assert.equal(upstream.bendR, 0);
  assert.equal(x64.bendR, 4.76837158203125e-7);
  assert.equal(newOut.lr, 9.5367431640625e-7);
  assert.equal(newOut.lrm, -9.5367431640625e-7);
  assert.throws(() => new EmotePendulum(settings, 'unknown'), /unsupported DLL build/);
});

test('skip resets physics to the loaded parameters', () => {
  const controls = createEmoteControls(metadata({bustControl: [bustControl()]}));
  const h = host();
  controls.stepPhysics(h, 1);
  controls.skip();
  assert.equal(controls.busts[0].control.p[1], 0);
  assert.equal(controls.busts[0].first, true);
});

test('x64 control set composes exact-build controls through the host interface', () => {
  const md = metadata({
    bustControl: [bustControl()],
    mouthControl: [{enabled: true, label: 'm', talkLabel: 't', beginFrame: 2.75, unread: {}}],
    selectorControl: [{enabled: false, raw: {}}],
  });
  const controls = createEmoteControls(md, {driverSha256: EMOTEDRIVER_X64_SHA256});
  const h = host({
    shapePoint: () => {
      throw Error('x86 base-point path');
    },
    physicsBasePosition: () => ({x: 0, y: 0}),
    physicsAngle: 0,
    outerForces: {bust: {x: 1, y: 2}, hair: {x: 0, y: 0}, parts: {x: 0, y: 0}},
  });
  assert.equal(controls.selectors.length, 0);
  controls.setVariable(6, 0, 't', 1, 4, 1, false);
  controls.stepMouths(h, 1);
  assert.equal(h.value('m'), 2);
  assert.equal(h.value('t'), 0.25);
  controls.stepPhysics(h, 1);
  assert.equal(h.value('ud'), 0);
  controls.stepPhysics(h, 1);
  assert.ok(h.value('ud') > 0);
  assert.throws(() => controls.skip(), /requires its control host/);
  controls.skip(h);
  assert.equal(h.value('ud'), 0);
  assert.throws(() => controls.assignState(createEmoteControls(metadata())), /between DLL builds/);
  assert.throws(() => createEmoteControls(md, {driverSha256: 'unknown'}), /unsupported DLL build/);
});

test('x86 control set does not query x64 physics host inputs', () => {
  const controls = createEmoteControls(
    metadata({bustControl: [bustControl()], hairControl: [hair()]}),
  );
  const h = host();
  for (const key of ['outerForces', 'physicsAngle', 'physicsBasePosition'])
    Object.defineProperty(h, key, {
      get: () => {
        throw Error(`unexpected x64 input ${key}`);
      },
    });
  controls.stepPhysics(h, 1);
  assert.ok(h.value('ud') > 0);
});

test('assignState copies eye motion by label', () => {
  const md = metadata({eyeControl: [eyeControl({edge: [[0, 20]]})]});
  const a = createEmoteControls(md, {random: () => 0}),
    b = createEmoteControls(md, {random: () => 0});
  a.setVariable(4, 0, 'eye', 15, 0, 1, false);
  b.assignState(a);
  assert.equal(b.eyes[0].motion.value, 15);
});

test('x64 graph preserves fractional frames and advances queued motion immediately', () => {
  const graph = new EmoteGraph([[0.25, 10.75]], [[0.25], [10.75]], EMOTEDRIVER_X64_SHA256);
  assert.deepEqual(graph.search(0.25, 10.75), [[0.25, 10.75]]);
  assert.equal(graph.total, 10.5);
  const follower = new EmoteGraphFollower(graph, 0.25);
  follower.set(10.75, 4, 1, false);
  follower.advance(1);
  assert.equal(follower.value, 2.875);
  follower.set(10.75, 20, 1, false);
  follower.advance(1);
  assert.equal(follower.value, 5.5);
  follower.set(0.25, 1, 1, true);
  follower.advance(2);
  assert.equal(follower.value, 0.25);
  assert.equal(follower.busy, false);
  assert.throws(() => new EmoteGraph([], [], 'unknown'), /unsupported DLL build/);
});

test('x64 blink consumes phase changes immediately and disabling resets its cycle', () => {
  let draws = 0;
  const random = () => {
    draws++;
    return 0;
  };
  const settings = eyeControl({blinkIntervalMin: 0, blinkIntervalMax: 0, blinkFrameCount: 10});
  const eye = new EmoteEye(settings, random, EMOTEDRIVER_X64_SHA256);
  const values = Array.from({length: 12}, () => eye.update(1, random));
  assert.deepEqual(values, [2.5, 5, 7.5, 10, 10, 10, 7.5, 5, 2.5, 2.5, 5, 7.5]);
  const before = draws;
  eye.setBlinkEnabled(false);
  assert.equal(draws, before + 1);
  assert.equal(eye.update(1, random), 0);
  eye.setBlinkEnabled(false);
  assert.equal(draws, before + 1);
  eye.setBlinkEnabled(true);
  assert.equal(eye.update(1, random), 2.5);
  const brow = new EmoteEyebrow(
    {label: 'brow', beginFrame: 0.25, edge: [[0.25, 10.75]], node: []},
    EMOTEDRIVER_X64_SHA256,
  );
  assert.equal(brow.update(0), 0.25);
  brow.set(10.75, 4, 1, false);
  assert.equal(brow.update(1), 2.875);
});

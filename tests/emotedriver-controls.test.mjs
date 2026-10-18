import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EmoteBust,
  EmotePendulum,
  EmoteWind,
  EmoteXorshift128,
  createEmoteControls,
  emoteSoftAngle,
} from '../dist/native/emotedriver/runtime/controls/index.js';
import {EmoteTween} from '../dist/native/emotedriver/runtime/controls/transition.js';

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

test('skip resets physics to the loaded parameters', () => {
  const controls = createEmoteControls(metadata({bustControl: [bustControl()]}));
  const h = host();
  controls.stepPhysics(h, 1);
  controls.skip();
  assert.equal(controls.busts[0].control.p[1], 0);
  assert.equal(controls.busts[0].first, true);
});

test('assignState copies eye motion by label', () => {
  const md = metadata({eyeControl: [eyeControl({edge: [[0, 20]]})]});
  const a = createEmoteControls(md, {random: () => 0}),
    b = createEmoteControls(md, {random: () => 0});
  a.setVariable(4, 0, 'eye', 15, 0, 1, false);
  b.assignState(a);
  assert.equal(b.eyes[0].motion.value, 15);
});

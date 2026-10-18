import test from 'node:test';
import assert from 'node:assert/strict';
import {EmotePlayerCore} from '../dist/native/emotedriver/runtime/player-core.js';
import {PEmotePlayer} from '../dist/native/emotedriver/player.js';
import {EmoteTween, easingPower} from '../dist/native/emotedriver/runtime/controls/transition.js';
import {EmoteRotateTween, wrapAngle} from '../dist/native/emotedriver/runtime/controls/rotate.js';

const f32 = Math.fround;

/** Records what the player core does to its clip. */
class FakeClip {
  constructor(log) {
    this.log = log;
    this.color = 0;
    this.rootVisible = false;
    this.meshDivisionRatio = 1;
    this.root = null;
    this.applied = new Map();
    this.nodes = [];
  }
  nodeIndex() {
    return -1;
  }
  applyVariable(label, value) {
    this.applied.set(label, value);
    this.log.push(`apply:${label}`);
  }
  advance(frames) {
    this.log.push(`advance:${frames}`);
  }
  evaluate() {
    this.log.push('evaluate');
  }
  dispatchEvents() {
    this.log.push('dispatch');
  }
  setRootTransform(t) {
    this.root = t;
    this.log.push('root');
  }
  assignState(source) {
    this.root = source.root;
    this.color = source.color;
  }
  getVariable(label) {
    return label === 'fromClip' ? 0.5 : 0;
  }
  isModified() {
    return false;
  }
}

/** Records the control-set calls; selector variables are bound with type 8. */
class FakeControls {
  constructor(log, metadata) {
    this.log = log;
    this.metadata = metadata;
    this.set = [];
  }
  bindVariables(type, bind) {
    this.log.push(`bind:${type}`);
    if (type === 8)
      for (const [i, s] of (this.metadata.selectorControl ?? []).entries()) bind(s.label, i);
  }
  setVariable(...args) {
    this.set.push(args);
  }
  stepEyes(_h, f) {
    this.log.push(`eyes:${f}`);
  }
  stepEyebrows(_h, f) {
    this.log.push(`eyebrows:${f}`);
  }
  stepMouths(_h, f) {
    this.log.push(`mouths:${f}`);
  }
  stepSelectors(_h, f) {
    this.log.push(`selectors:${f}`);
  }
  stepLoops(_h, f) {
    this.log.push(`loops:${f}`);
  }
  windActive() {
    return false;
  }
  stepWind(_h, f) {
    this.log.push(`wind:${f}`);
  }
  stepPhysics(_h, f) {
    this.log.push(`physics:${f}`);
  }
  createWind(start, goal) {
    this.log.push(`createWind:${start},${goal}`);
  }
  configureWind(min, max, speed) {
    this.log.push(`configureWind:${min},${max},${speed}`);
  }
  destroyWind() {
    this.log.push('destroyWind');
  }
  skip() {
    this.log.push('controls.skip');
  }
  isAnimating() {
    return false;
  }
  assignState() {
    this.log.push('controls.assign');
  }
}

const motion = {
  priority: [],
  tag: [],
  loopTime: 0,
  lastTime: 0,
  bounds: null,
  parameters: [],
  parameterize: null,
  layerIndexMap: null,
  layers: [],
  unread: {},
};

function metadata(fields = {}) {
  return {
    format: 'emote',
    version: null,
    base: {chara: 'chara', motion: 'motion'},
    mirror: false,
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
    mirrorControl: {variableMatchList: []},
    instantVariableList: null,
    timelineControl: [],
    stereovisionControl: null,
    variableList: null,
    unread: {},
    ...fields,
  };
}

function model(fields) {
  return {
    id: null,
    label: null,
    spec: 'win',
    version: f32(3.03),
    screenSize: {width: 0, height: 0, originX: 0, originY: 0},
    sources: new Map(),
    objects: new Map([['chara', {motions: new Map([['motion', motion]]), unread: {}}]]),
    easing: null,
    metadata: metadata(fields),
    diagnostics: [],
    unread: {},
  };
}

function player(fields) {
  const log = [];
  const clips = [];
  const controls = [];
  const core = new EmotePlayerCore({
    model: model(fields),
    createClip: () => {
      const c = new FakeClip(log);
      clips.push(c);
      return c;
    },
    createControls: (md) => {
      const c = new FakeControls(log, md);
      controls.push(c);
      return c;
    },
  });
  const rendered = [];
  const p = new PEmotePlayer(core, {render: (pl) => rendered.push(pl)});
  return {p, core, log, clips, controls, rendered};
}

const transition = (label) => ({enabled: true, label, unread: {}});
const frame = (time, value, easing = 0) => ({time, type: 2, value, easing});
const empty = (time) => ({time, type: 0, value: null, easing: null});
const timeline = (label, variables, extra = {}) => ({
  label,
  diff: false,
  loopBegin: -1,
  loopEnd: -1,
  lastTime: -1,
  variables: variables.map(([l, frames]) => ({label: l, frames})),
  unread: {},
  ...extra,
});
const withLastTime = (t) => {
  let last = 0;
  for (const v of t.variables) for (const fr of v.frames) last = Math.max(last, fr.time);
  return {...t, lastTime: t.lastTime < 0 ? last : t.lastTime};
};

test('easing power and the queued tween follow 0x10012310 / 0x1000c300', () => {
  assert.equal(easingPower(0), 1);
  assert.equal(easingPower(1), 2);
  assert.equal(easingPower(-1), 0.5);
  const t = new EmoteTween(1);
  t.set([10], 4, easingPower(1), false);
  const out = [];
  for (let i = 0; i < 6; i++) out.push(t.step(1)[0]);
  // First step only starts the tween; t then advances by 1/4 per frame; curve t^2.
  assert.deepEqual(out, [0, f32(10 * 0.0625), f32(10 * 0.25), f32(10 * 0.5625), 10, 10]);
  assert.equal(t.busy, false);
  t.set([20], 3, 1, false);
  t.set([30], 3, 1, true);
  assert.equal(t.queued, 2);
  t.skip();
  assert.equal(t.current[0], 30);
  assert.equal(t.queued, 0);
});

test('rotation tween takes the short way and wraps to [0, 2π)', () => {
  const twoPi = f32(2 * Math.PI);
  assert.equal(wrapAngle(-1, twoPi), f32(twoPi - 1));
  const r = new EmoteRotateTween();
  r.set(f32(0.5), 0, 1, false);
  r.set(f32(twoPi - 0.5), 2, 1, false);
  r.step(1);
  assert.equal(r.target, f32(f32(twoPi - 0.5) - twoPi));
  const mid = r.step(1);
  assert.equal(mid, wrapAngle(f32((r.target - r.start) * 0.5 + r.start), twoPi));
  assert.ok(Math.abs(mid) < 1e-6 || Math.abs(mid - twoPi) < 1e-5);
});

test('construction loads metadata in native order and Progress(0) runs one forced sub-step', () => {
  const {p, log} = player({transitionControl: [transition('t')]});
  assert.deepEqual(log, [
    'root',
    'advance:0',
    'evaluate',
    'dispatch',
    'bind:4',
    'bind:5',
    'bind:6',
    'bind:8',
  ]);
  log.length = 0;
  p.progress(0);
  assert.deepEqual(log, [
    'eyes:0',
    'eyebrows:0',
    'mouths:0',
    'selectors:0',
    'loops:0',
    'root',
    'apply:t',
    'advance:0',
    'evaluate',
    'dispatch',
  ]);
});

test('Progress splits frames into sub-steps of at most 1.1 and runs physics after the clips', () => {
  const {p, log} = player({});
  p.progress(0);
  log.length = 0;
  p.progress(2.5);
  const step = f32(1.1);
  const last = f32(f32(f32(2.5) - step) - step);
  assert.deepEqual(
    log.filter((e) => e.startsWith('eyes:')),
    [`eyes:${step}`, `eyes:${step}`, `eyes:${last}`],
  );
  assert.deepEqual(log.slice(-4), ['advance:2.5', 'evaluate', 'dispatch', 'physics:2.5']);
  log.length = 0;
  p.progress(0);
  assert.deepEqual(log, ['advance:0', 'evaluate', 'dispatch']);
});

test('SetVariable: plain variables set at once, transition variables ease', () => {
  const {p, controls} = player({
    transitionControl: [transition('t')],
    selectorControl: [{label: 's', optionList: [], unread: {}}],
  });
  p.setVariable('plain', 3, 10, 0);
  assert.equal(p.getVariable('plain'), 3);
  assert.equal(p.getVariable('fromClip'), 0.5);
  p.setVariable('t', 10, 4, 1);
  const values = [];
  for (let i = 0; i < 5; i++) {
    p.progress(1);
    values.push(p.getVariable('t'));
  }
  assert.deepEqual(values, [0, f32(10 * 0.0625), f32(10 * 0.25), f32(10 * 0.5625), 10]);
  p.setVariable('s', 1, 2, -1);
  assert.deepEqual(controls[0].set, [[8, 0, 's', 1, 2, 0.5, false]]);
});

test('transform tweens: SetCoord, SetScale, SetColor, SetRot and queuing', () => {
  const {p, clips} = player({scale: 2});
  p.setCoord(100, 50, 4, 0);
  p.setScale(3, 0, 0);
  p.setColor(0xff8040ff, 2, 0);
  p.setRot(f32(Math.PI / 2), 0, 0);
  p.progress(1);
  assert.deepEqual(p.getCoord(), {x: 0, y: 0});
  p.progress(1);
  assert.deepEqual(p.getCoord(), {x: 25, y: 12.5});
  assert.equal(p.getScale(), 3);
  assert.equal(p.core.inverseScale, f32(1 / 6));
  // Colour tween from 0x808080ff: halfway after its first running step; bytes round to even.
  // Alpha 0x80 → 0xff is 191.5 halfway, which x87 rounds to the even 192.
  assert.equal(p.getColor(), 0xc08060ff);
  assert.equal(clips[0].root.angle, f32((f32(Math.PI / 2) * 360) / f32(2 * Math.PI)));
  assert.equal(p.getRot(), f32((clips[0].root.angle * f32(2 * Math.PI)) / 360));
  p.setQueuing(true);
  p.setCoord(0, 0, 1, 0);
  p.setCoord(10, 10, 1, 0);
  assert.equal(p.core.coordTween.queued, 2);
  assert.equal(p.isAnimating(), true);
  p.skip();
  assert.deepEqual(p.getCoord(), {x: 25, y: 12.5});
  p.progress(0);
  assert.deepEqual(p.getCoord(), {x: 10, y: 10});
  assert.equal(p.isAnimating(), false);
});

test('timeline keyframes start transitions until one frame before the next keyframe', () => {
  const tl = withLastTime(
    timeline('tl', [['t', [frame(0, 0), frame(10, 10), frame(20, 20), empty(30)]]]),
  );
  const {p} = player({transitionControl: [transition('t')], timelineControl: [tl]});
  assert.equal(p.countMainTimelines(), 1);
  assert.equal(p.isLoopTimeline('tl'), true); // unloaded state reads loopBegin 0
  p.playTimeline('tl', 0);
  assert.equal(p.isLoopTimeline('tl'), false);
  assert.equal(p.getPlayingTimelineFlagsAt(0), 1);
  p.progress(0);
  const seen = [];
  for (let i = 1; i <= 35; i++) {
    p.progress(1);
    seen.push(p.getVariable('t'));
  }
  // Passing frame 10 (time 10) queues 0 → 10 over 9 frames; the tween starts next sub-step.
  assert.equal(seen[9], 0);
  assert.equal(seen[10], f32(10 * f32(1 / 9)));
  assert.equal(seen[19], 10);
  assert.equal(seen[29], 20);
  assert.equal(p.isTimelinePlaying('tl'), false); // removed at lastTime 30
  assert.equal(p.countPlayingTimelines(), 0);
});

test('looping timeline wraps at loopEnd and is not animating', () => {
  const tl = timeline('loop', [['a', [frame(0, 1), frame(5, 2), empty(10)]]], {
    loopBegin: 0,
    loopEnd: 10,
    lastTime: 10,
  });
  const {p, core} = player({timelineControl: [tl]});
  p.playTimeline('loop', 1);
  assert.equal(p.getVariable('a'), 1);
  p.progress(7);
  assert.equal(p.getVariable('a'), 2);
  assert.equal(core.timelines.states.get('loop').time, 7);
  p.progress(4);
  // 7 + 4 passes loopEnd 10: evaluated to 10, seeked to 0, then advanced by 1.
  assert.equal(core.timelines.states.get('loop').time, 1);
  assert.equal(p.getVariable('a'), 1);
  assert.equal(p.isTimelinePlaying('loop'), true);
  assert.equal(p.isAnimating(), false);
  p.stopTimeline('');
  assert.equal(p.isTimelinePlaying(''), false);
});

test('difference timeline: fade in blends its track into the variable', () => {
  const d = timeline('d', [['v', [frame(0, 4), frame(100, 4), empty(200)]]], {
    diff: true,
    loopBegin: 0,
    loopEnd: 200,
    lastTime: 200,
  });
  const {p, clips} = player({timelineControl: [d]});
  assert.equal(p.countDiffTimelines(), 1);
  p.setVariable('v', 1, 0, 0);
  p.fadeInTimeline('d', 4, 0);
  assert.equal(p.getPlayingTimelineFlagsAt(0), 3);
  assert.equal(p.getTimelineBlendRatio('d'), 1); // output updates in the fade step
  const ratios = [];
  const applied = [];
  for (let i = 0; i < 6; i++) {
    p.progress(1);
    ratios.push(p.getTimelineBlendRatio('d'));
    applied.push(clips[0].applied.get('v'));
  }
  // Blend: set to 0 at once, then queued to 1 over 4 frames.
  assert.deepEqual(ratios, [0, 0.25, 0.5, 0.75, 1, 1]);
  // Track tween: 0 → 4 over 99 frames, started on the first fade step.
  const track = (n) => f32(4 * f32(n * f32(1 / 99)));
  assert.equal(applied[0], 1);
  assert.equal(applied[1], f32(track(1) * 0.25 + 1));
  assert.equal(applied[2], f32(track(2) * 0.5 + 1));
  p.fadeOutTimeline('d', 2, 0);
  p.progress(1);
  p.progress(1);
  p.progress(1);
  assert.equal(p.getTimelineBlendRatio('d'), 0);
  p.progress(1);
  assert.equal(p.isTimelinePlaying('d'), false);
});

test('mirror negates matching variables; clamp type 1 limits a pair to the unit disc', () => {
  const {p, clips} = player({
    mirror: true,
    mirrorControl: {variableMatchList: ['_lr']},
    clampControl: [
      {enabled: true, type: 1, var_lr: 'h_lr', var_ud: 'h_ud', min: -10, max: 10, unread: {}},
    ],
  });
  p.setVariable('x_lr', 2, 0, 0);
  p.setVariable('x_ud', 2, 0, 0);
  p.setVariable('h_lr', 10, 0, 0);
  p.setVariable('h_ud', 10, 0, 0);
  p.progress(1);
  assert.equal(clips[0].applied.get('x_lr'), -2);
  assert.equal(clips[0].applied.get('x_ud'), 2);
  assert.equal(clips[0].root.mirror, true);
  const c = f32(Math.cos(f32(Math.atan2(1, 1))));
  const s = f32(Math.sin(f32(Math.atan2(1, 1))));
  assert.equal(clips[0].applied.get('h_lr'), -f32((c + 1) * 0.5 * 20 - 10));
  assert.equal(clips[0].applied.get('h_ud'), f32(20 * ((s + 1) * 0.5) - 10));
});

test('variableList queries, wind, show/hide, clone and assignState', () => {
  const {p, log, rendered} = player({
    variableList: [
      {label: 'face', frames: [{label: 'smile', frame: 3}]},
      {label: 'face', frames: [{label: 'angry', frame: 7}]},
    ],
    transitionControl: [transition('t')],
  });
  assert.equal(p.countVariables(), 1);
  assert.equal(p.getVariableLabelAt(0), 'face');
  assert.equal(p.getVariableLabelAt(1), '');
  assert.equal(p.countVariableFrameAt(0), 2);
  assert.equal(p.getVariableFrameLabelAt(0, 0), 'angry');
  assert.equal(p.getVariableFrameValueAt(0, 1), 3);
  assert.equal(p.getVariableFrameValueAt(0, 5), 0);
  log.length = 0;
  p.startWind(5, 1, -2, 0, 1);
  p.startWind(1, 5, 3, 0, 2);
  p.stopWind();
  assert.deepEqual(log, [
    'createWind:1,5',
    'configureWind:0,1,2',
    'configureWind:0,2,3',
    'destroyWind',
  ]);
  p.show();
  assert.equal(p.isHidden(), false);
  p.hide();
  assert.equal(p.isHidden(), true);
  p.setCoord(7, 8, 0, 0);
  p.setVariable('t', 5, 10, 0);
  p.progress(1);
  p.progress(1);
  p.setBustScale(2);
  const q = p.clone();
  assert.deepEqual(q.getCoord(), {x: 7, y: 8});
  assert.equal(q.getBustScale(), 2);
  assert.equal(q.core.transitions[0].tween.t, p.core.transitions[0].tween.t);
  q.progress(1);
  p.progress(1);
  assert.equal(q.getVariable('t'), p.getVariable('t'));
  q.render();
  assert.equal(rendered[0], q);
  assert.throws(() => p.assignState({}), TypeError);
  assert.equal(p.release(), 0);
});

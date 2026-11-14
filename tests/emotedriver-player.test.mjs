import {EMOTEDRIVER_X86_SHA256, EMOTEDRIVER_X64_SHA256} from '../dist/native/emotedriver/build.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {EmotePlayerCore} from '../dist/native/emotedriver/runtime/player-core.js';
import {PEmotePlayer} from '../dist/native/emotedriver/player.js';
import {EmoteTween, easingPower} from '../dist/native/emotedriver/runtime/controls/transition.js';
import {EmoteRotateTween, wrapAngle} from '../dist/native/emotedriver/runtime/controls/rotate.js';
import {EmoteTimelineSet} from '../dist/native/emotedriver/runtime/player/timelines.js';
import {EmoteVariableClamp} from '../dist/native/emotedriver/runtime/player/clamp.js';
import {createEmoteControls} from '../dist/native/emotedriver/runtime/controls/index.js';

const f32 = Math.fround;

test('variable clamps constrain pairs, retain axis values and expose a borrowed result', () => {
  for (const sha of [EMOTEDRIVER_X86_SHA256, EMOTEDRIVER_X64_SHA256]) {
    const clamp = new EmoteVariableClamp({min: -10, max: 10, type: 1}, sha);
    assert.deepEqual([...clamp.apply(5, 0)], [5, 0]);
    const diagonal = clamp.apply(10, 10);
    assert.ok(Math.abs(Math.hypot(...diagonal) - 10) < 0.000002);
    assert.equal(clamp.apply(0, 0), diagonal);
    assert.deepEqual([...diagonal], [0, 0]);
    const unchanged = new EmoteVariableClamp({min: -10, max: 10, type: 2}, sha);
    assert.deepEqual([...unchanged.apply(20, -20)], [20, -20]);
  }
  assert.throws(
    () => new EmoteVariableClamp({min: 0, max: 1, type: 0}, '3.9.8'),
    /unsupported DLL build/,
  );
});

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
    this.root = {...t};
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

function x64Player(fields = {}, factory = createEmoteControls) {
  const log = [],
    clip = new FakeClip(log);
  Object.assign(clip, {
    rootDirty: false,
    smoothing: true,
    ownRotation: false,
    ownRotationAngle: 0,
    grayscaleMode: 0,
    grayscaleLevel: 0,
    setOwnRotation(value) {
      this.ownRotationAngle = value;
    },
    setGrayscale(mode, level) {
      this.grayscaleMode = mode;
      this.grayscaleLevel = level;
    },
    layerPosition: () => ({x: 20, y: 30}),
  });
  Object.defineProperty(clip, 'nodes', {
    get() {
      throw Error('x86 node layout accessed');
    },
  });
  const core = new EmotePlayerCore({
    model: model({
      suitableClearColor: null,
      immediateControl: [],
      charaProfile: null,
      orbitControl: [],
      ...fields,
    }),
    driverSha256: EMOTEDRIVER_X64_SHA256,
    random: () => 0.5,
    createClip: () => clip,
    createControls: factory,
  });
  return {core, clip, log};
}

test('x64 player uses the shared core for transform flags, variable diffs and physics access', () => {
  const {core, clip} = x64Player({scale: 2});
  core.flags |= 2;
  core.setCoord(4, -2, 0, 0);
  core.setScale(3, 0, 0);
  core.setAsOriginalScale(true);
  core.addUserDefinedVariable('custom');
  core.setVariable('custom', 6, 2, 0);
  core.setVariableDiff('module', 'custom', 2, 0, 0);
  core.progress(1);
  assert.deepEqual(core.getCoord(), {x: 6, y: -3});
  assert.equal(core.getScale(), 1.5);
  assert.equal(clip.applied.get('custom'), 5);
  assert.deepEqual(core.physicsBasePosition('base'), {x: 6.6666669845581055, y: 10});
  assert.equal(clip.rootDirty, true);
});

test('x64 player links replaceable control and clip implementations through interfaces', () => {
  let links,
    enabled = true;
  const {core} = x64Player({}, (md, options) => {
    links = options;
    const controls = new FakeControls([], md);
    controls.setBlinkEnabled = (value) => {
      enabled = value;
    };
    controls.getBlinkEnabled = () => enabled;
    return controls;
  });
  assert.equal(links.driverSha256, EMOTEDRIVER_X64_SHA256);
  assert.equal(links.random(), 0.5);
  core.setBlinkEnabled(false);
  assert.equal(core.getBlinkEnabled(), false);
  core.setGrayscale(0.5, 0, 0);
  core.progress(0);
  assert.equal(core.getGrayscale(), f32(127 / 255));
});

test('player build selection rejects unknown images before constructing dependencies', () => {
  let created = false;
  assert.throws(
    () =>
      new EmotePlayerCore({
        model: model(),
        driverSha256: '3.9.8',
        createClip() {
          created = true;
        },
        createControls() {
          created = true;
        },
      }),
    /unsupported DLL build/,
  );
  assert.equal(created, false);
});
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

test('timeline loop carry is local to each playing timeline on x64', () => {
  for (const [build, expected] of [
    [EMOTEDRIVER_X86_SHA256, 1],
    [EMOTEDRIVER_X64_SHA256, 3],
  ]) {
    const set = new EmoteTimelineSet({queuing: false, setVariable() {}}, new Set(), build);
    set.loadList([
      timeline('a', [], {loopBegin: 0, loopEnd: 2, lastTime: 2}),
      timeline('b', [], {loopBegin: 0, loopEnd: 7, lastTime: 7}),
    ]);
    set.play('a', 1);
    set.play('b', 1);
    set.advance(3);
    assert.equal(set.states.get('a').time, 1);
    assert.equal(set.states.get('b').time, expected);
    if (build === EMOTEDRIVER_X64_SHA256) {
      set.step();
      assert.equal(set.states.get('a').time, 1);
      assert.equal(set.states.get('b').time, 0);
    }
  }
});

test('x64 timeline seeks retain previous content and normalize label lookup', () => {
  const calls = [];
  const set = new EmoteTimelineSet(
    {queuing: false, setVariable: (...args) => calls.push(args)},
    new Set(),
    EMOTEDRIVER_X64_SHA256,
  );
  set.loadList([
    timeline('ＦＵＬＬ', [['v', [frame(0, 1), empty(4), frame(8, 2), empty(10)]]], {lastTime: 10}),
  ]);
  set.play('FULL', 1);
  assert.equal(set.isPlaying('ＦＵＬＬ'), true);
  assert.equal(set.playingLabelAt(0), 'FULL');
  calls.length = 0;
  set.seek(set.states.get('FULL'), 5);
  assert.deepEqual(calls, [['v', 1, 0, 0]]);
  calls.length = 0;
  set.evaluate(set.states.get('FULL'), NaN, true);
  assert.deepEqual(calls, [['v', 2, 0, 0]]);
  assert.equal(set.isPlaying('😀'), false);
  assert.throws(
    () => new EmoteTimelineSet({queuing: false, setVariable() {}}, new Set(), 'unknown'),
    /unsupported DLL build/,
  );
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

test('exact x64 DLL identity selects immediate tween progress and completed queue carry', () => {
  const t = new EmoteTween(1, EMOTEDRIVER_X64_SHA256.toUpperCase());
  t.set([10], 4, 1, false);
  assert.equal(t.step(1)[0], 2.5);
  // A repeated target over a longer duration retains the earlier completion.
  t.set([10], 20, 1, false);
  assert.equal(t.step(1)[0], 5);
  t.set([20], 1, 1, true);
  t.set([30], 1, 1, true);
  assert.equal(t.step(2)[0], 30);
  assert.equal(t.busy, false);
  t.set([40], 10, 1, false);
  t.set([50], 10, 1, true);
  t.skip();
  assert.equal(t.current[0], 50);
  assert.equal(t.busy, false);
  assert.equal(easingPower(-0.001, EMOTEDRIVER_X64_SHA256), 0.9990009665489197);
  assert.equal(easingPower(-0.001, EMOTEDRIVER_X86_SHA256), 0.9990010261535645);
  assert.throws(() => new EmoteTween(1, 'unknown'), /unsupported DLL build/);
  assert.throws(() => easingPower(0, '3.9.8'), /unsupported DLL build/);
});

test('x64 rotation queues advance immediately and retain the shorter wrapped target', () => {
  const tween = new EmoteRotateTween(EMOTEDRIVER_X64_SHA256);
  tween.set(1, 4, 1, false);
  assert.equal(tween.step(1), 0.25);
  tween.set(1, 20, 1, false);
  assert.equal(tween.step(1), 0.5);
  tween.set(2, 1, 1, true);
  tween.set(3, 1, 1, true);
  assert.equal(tween.step(2), 3);
  assert.equal(tween.busy, false);
  tween.set(-1, 0, 1, false);
  assert.equal(tween.current, f32(f32(2 * Math.PI) - 1));
  tween.set(Infinity, 1, 1, false);
  tween.step(0);
  tween.skip();
  assert.equal(tween.current, Infinity);
  assert.throws(() => new EmoteRotateTween('unknown'), /unsupported DLL build/);
});

test('x64 GetState reads applied transforms and retains the native duplicate color labels', () => {
  const {core} = x64Player();
  core.flags &= ~2;
  core.setCoord(12, -20, 4, 0);
  core.setScale(1.5, 0, 0);
  core.setRot(0.25, 0, 0);
  core.setColor(0xdeaf5199, 0, 0);
  core.progress(2);
  assert.equal(core.getState('coordX'), 6);
  assert.equal(core.getState('coordY'), -10);
  assert.equal(core.getState('scale'), 1.5);
  assert.equal(core.getState('rot'), core.getRot());
  assert.equal(core.getState('colorR'), 222);
  assert.equal(core.getState('colorG'), 175);
  assert.equal(core.getState('coordX\0ignored'), 6);
  for (const label of [
    '',
    'colorB',
    'colorA',
    'CoordX',
    'coordx',
    'rotated',
    '__proto__',
    'constructor',
    '座標',
    'x'.repeat(4096),
  ])
    assert.equal(core.getState(label), 0, label);
  core.progress(2);
  assert.equal(core.getState('coordX'), 12);
  assert.equal(core.getState('coordY'), -20);
  assert.throws(() => player().core.getState('coordX'), /API unavailable for DLL build/);
});

test('x64 state assignment copies native value, orbit and tween ownership while retaining destination-only state', () => {
  const orbit = (label, values) => ({
    enabled: true,
    label,
    interval: 20,
    tween: true,
    orbitFrameList: values,
  });
  const source = x64Player({orbitControl: [orbit('orbit', [1, 3, 5])]}).core;
  const target = x64Player({orbitControl: [orbit('obsolete', [7, 9])]}).core;
  source.setVariable('plain', 4, 0, 0);
  target.setVariable('stale', 9, 0, 0);
  source.setCoord(10, 20, 8, 0);
  source.setScale(2, 8, 0);
  source.setRot(0.5, 8, 0);
  source.setColor(0x204060ff, 8, 0);
  source.setGrayscale(0.75, 8, 0);
  source.setOuterRot(0.25, 8, 0);
  for (const label of ['bust', 'hair', 'parts']) source.setOuterForce(label, 2, -3, 8, 0);
  source.setVariableDiff('module', 'keep', 2, 0, 0);
  source.setVariableDiff('module', 'insert', 6, 8, 0);
  source.progress(2);
  target.setCoord(99, 101, 0, 0);
  target.setOuterForce('bust', 7, 8, 0, 0);
  target.setVariableDiff('module', 'keep', 8, 0, 0);
  target.setVariableDiff('other', 'retained', 9, 0, 0);
  target.progress(1);
  target.flags = 0x303;
  target.setAsOriginalScale(true);
  source.stereovision.volume = 0.75;
  source.stereovision.parallaxRatio = f32(0.3);
  source.stereovision.dirty = false;
  const applied = target.getCoord(),
    accumulators = target.forceSums.map((v) => v.slice()),
    differenceSums = [...target.diffSums];
  target.assignState(source);
  assert.deepEqual(target.getCoord(), applied);
  assert.equal(target.flags, 0x303);
  assert.equal(target.isAsOriginalScale(), true);
  assert.deepEqual(target.forceSums, accumulators);
  assert.deepEqual([...target.diffSums], differenceSums);
  assert.equal(target.cells.has('stale'), false);
  assert.equal(target.getVariable('plain'), 4);
  assert.notEqual(target.cells.get('plain'), source.cells.get('plain'));
  assert.deepEqual(target.stereovision, {...source.stereovision, dirty: true});
  assert.notEqual(target.stereovision, source.stereovision);
  assert.equal(target.orbits.length, 1);
  assert.notEqual(target.orbits[0], source.orbits[0]);
  assert.deepEqual(target.orbits[0], source.orbits[0]);
  assert.notEqual(target.orbits[0].values, source.orbits[0].values);
  assert.equal(target.getVariableDiff('module', 'keep'), 8); // Native emplace preserves an existing key.
  assert.equal(target.getVariableDiff('other', 'retained'), 9);
  assert.equal(
    target.getVariableDiff('module', 'insert'),
    source.getVariableDiff('module', 'insert'),
  );
  for (const key of [
    'coordTween',
    'scaleTween',
    'rotateTween',
    'colorTween',
    'grayscaleTween',
    'outerRotateTween',
  ]) {
    assert.deepEqual(target[key], source[key]);
    assert.notEqual(target[key], source[key]);
  }
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(target.forceTweens[i], source.forceTweens[i]);
    assert.notEqual(target.forceTweens[i].current.buffer, source.forceTweens[i].current.buffer);
  }
  target.cell('plain').value = 999;
  assert.equal(source.cell('plain').value, 4);
  target.orbits[0].step(5);
  assert.notEqual(target.orbits[0].time, source.orbits[0].time);
  const before = target.getVariableDiff('module', 'insert');
  source.diffs.find((d) => d.label === 'insert').tween.step(1);
  assert.equal(target.getVariableDiff('module', 'insert'), before);
  target.assignState(target);
  assert.throws(() => target.assignState(player().core), /DLL build mismatch/);
});

test('x64 assignment restarts matching timelines and retains native play caches before the next fade', () => {
  const definitions = [
    timeline('main', [['v', [frame(0, 1), frame(4, 5), empty(20)]]], {lastTime: 20}),
  ];
  const source = x64Player({timelineControl: definitions}).core,
    target = x64Player({timelineControl: definitions}).core;
  source.timelines.play('main', 0);
  source.progress(3);
  source.timelines.setBlendRatio('main', 0, 8, 0, true);
  source.timelines.states.get('main').blend.step(2);
  source.timelines.states.get('main').stepped = true;
  target.assignState(source);
  const from = source.timelines.states.get('main'),
    to = target.timelines.states.get('main');
  assert.deepEqual(target.timelines.playing, ['main']);
  assert.equal(to.time, from.time);
  assert.equal(to.stopWhenBlendDone, from.stopWhenBlendDone);
  assert.deepEqual(to.blend, from.blend);
  assert.notEqual(to.blend.current.buffer, from.blend.current.buffer);
  assert.equal(to.stepped, false); // Play reset; the assign body does not copy this cache.
  assert.equal(to.blendRatio, 1);
});

test('x64 clone composes the actual shared scalar factory with independent clips and control state', async () => {
  const {emoteScalarClipFactory} = await import('../dist/native/emotedriver/runtime/clip.js');
  const file = model({
    scale: 2,
    suitableClearColor: null,
    immediateControl: [],
    charaProfile: null,
    orbitControl: [],
  });
  const source = new EmotePlayerCore({
    model: file,
    driverSha256: EMOTEDRIVER_X64_SHA256,
    random: () => 0.5,
    createClip: emoteScalarClipFactory([file]),
    createControls: createEmoteControls,
  });
  source.show();
  source.setCoord(12, 24, 0, 0);
  source.setScale(1.5, 0, 0);
  source.setColor(0x204060ff, 0, 0);
  source.setVariable('plain', 3, 0, 0);
  source.setVariableDiff('module', 'v', 2, 8, 0);
  source.setOuterForce('hair', 2, 3, 8, 0);
  source.progress(2);
  source.startRecordAPILog();
  const copy = source.clone();
  assert.equal(source.isRecordingAPILog(), true);
  assert.equal(copy.isRecordingAPILog(), false);
  assert.equal(copy.getAPILog(), '');
  assert.notEqual(copy, source);
  assert.notEqual(copy.clips[0], source.clips[0]);
  assert.notEqual(copy.controls, source.controls);
  assert.notEqual(copy.clips[0].root.adjust, source.clips[0].root.adjust);
  assert.equal(copy.clips[0].timeRunning, source.clips[0].timeRunning);
  assert.deepEqual(copy.getCoord(), source.getCoord());
  assert.equal(copy.getScale(), source.getScale());
  assert.equal(copy.inverseScale, 0.5); // Native loading uses the fresh default scale tween.
  assert.notEqual(copy.inverseScale, source.inverseScale);
  assert.equal(copy.getColor(), source.getColor());
  assert.equal(copy.isHidden(), false);
  assert.equal(copy.getVariable('plain'), 3);
  assert.equal(copy.getVariableDiff('module', 'v'), source.getVariableDiff('module', 'v'));
  assert.deepEqual(copy.forceSums, [new Float32Array(2), new Float32Array(2), new Float32Array(2)]);
  copy.cell('plain').value = 9;
  assert.equal(source.getVariable('plain'), 3);
  copy.clips[0].rootX = 100;
  assert.notEqual(source.clips[0].rootX, 100);
  copy.setCoord(50, 60, 0, 0);
  copy.progress(0);
  assert.deepEqual(source.getCoord(), {x: 12, y: 24});
});

test('x64 state assignment preserves native wind reconfiguration and stopped-source restart quirks', () => {
  const source = x64Player().core,
    target = x64Player().core;
  source.startWind(0, 10, 1, 0.2, 0.4);
  target.startWind(100, 200, 3, 1, 2);
  const retained = target.controls.wind;
  retained.active[0] = 1;
  retained.position[0] = 150;
  retained.power[0] = 1;
  retained.clock = -0.25;
  target.assignState(source);
  assert.equal(target.controls.wind, retained);
  // Assign copied the argument fields before StartWind's endpoint comparison.
  // The old field object is reused, including its original bounds and live gusts.
  assert.equal(retained.start, 100);
  assert.equal(retained.goal, 200);
  assert.equal(retained.active[0], 1);
  assert.equal(retained.position[0], 150);
  assert.equal(retained.clock, 0);
  assert.equal(retained.velocity, 1);
  assert.equal(retained.powerMin, f32(0.2));
  assert.equal(retained.powerMax, f32(0.4));
  source.stopWind();
  assert.equal(source.controls.wind, null);
  const fresh = x64Player().core;
  fresh.assignState(source);
  // StopWind does not clear the native saved arguments; assigning them starts it again.
  assert.notEqual(fresh.controls.wind, null);
  assert.equal(fresh.controls.wind.start, 0);
  assert.equal(fresh.controls.wind.goal, 10);
});

test('x64 API recording suppresses nested timeline and progress calls and preserves native mode changes', () => {
  const {core} = x64Player({
    timelineControl: [
      timeline('main', [['v', [frame(0, 1), frame(4, 5), empty(20)]]], {lastTime: 20}),
    ],
  });
  core.startRecordAPILog();
  core.fadeInTimeline('main', 8, 0);
  core.progress(1);
  core.fadeOutTimeline('main', 4, -1);
  assert.equal(
    core.getAPILog(),
    'FadeInTimeline main 8.000000 0.000000\r\nCalcLayerFrameInfo 1.000000\r\nFadeOutTimeline main 4.000000 -1.000000\r\n',
  );
  core.stopRecordAPILog();
  core.setCoord(3, 4, 0, 0);
  core.startRecordAPILog();
  core.pass();
  assert.ok(core.getAPILog().endsWith('Pass \r\n'));
  core.startReplayAPILog();
  assert.equal(core.isRecordingAPILog(), false);
  assert.equal(core.isReplayingAPILog(), true);
  core.stopRecordAPILog(); // Both native stop entry points select mode0.
  assert.equal(core.isReplayingAPILog(), false);
  core.clearAPILog();
  assert.equal(core.getAPILog(), '');
  core.setAPILog('');
  assert.equal(core.getAPILog(), '\r\n'); // Native splitter inserts the empty input substring.
  core.setAPILog('\r\nSetScale 2 0 0\n\nPass \r\n\0ignored');
  assert.equal(core.getAPILog(), '\r\nSetScale 2 0 0\r\nPass \r\n');
  assert.throws(() => player().core.startRecordAPILog(), /API unavailable for DLL build/);
});

test('x64 API recording preserves float32 fixed decimals, signed color, UTF8 buffer limits and unlogged operations', () => {
  const {core} = x64Player();
  core.startRecordAPILog();
  core.setCoord(1.0000000596046448, -0, 0.0078125, 0.0234375);
  core.setColor(0xffffffff, 0, 0);
  core.setVariable('huge', f32(3.4028234663852886e38), 0, 0);
  core.setVariable('infinite', Infinity, -Infinity, NaN);
  core.setVariable('界'.repeat(400), 1, 0, 0);
  assert.equal(
    core.getAPILog(),
    'SetCoord 1.000000 -0.000000 0.007812 0.023438\r\nSetColor -1 0.000000 0.000000\r\nSetVariable huge 340282346638528859811704183484516925440.000000 0.000000 0.000000\r\nSetVariable infinite inf -inf nan\r\nBufferOverflow\r\n',
  );
  const saved = core.getAPILog();
  core.show();
  core.hide();
  core.setSmoothing(false);
  core.setBlinkEnabled(false);
  core.setAsOriginalScale(true);
  core.startWind(0, 10, 1, 0, 1);
  core.stopWind();
  assert.equal(core.getAPILog(), saved);
  core.clearAPILog();
  core.startRecordAPILog();
  core.setVariable('界'.repeat(328), 1, 0, 0);
  core.setVariable('界'.repeat(328) + 'a', 1, 0, 0);
  const entries = core.getAPILog().split('\r\n');
  assert.equal(new TextEncoder().encode(entries[0]).length, 1023);
  assert.equal(entries[1], 'BufferOverflow');
});

test('x64 API replay uses frame markers and applies queued commands before the caller frame fallback', () => {
  const {core, log} = x64Player();
  const input =
    'Unknown command\nSetCoord 4.5 -3 0 0\nCalcLayerFrameInfo 0.25\nSetVariable plain 0.333333 0 0\nSetCoord 10 20 0 0\nCalcLayerFrameInfo 0.5\nSetScale 2 0 0\nCalcLayerFrameInfo broken\n';
  core.setAPILog(input);
  const saved = core.getAPILog();
  core.startReplayAPILog();
  log.length = 0;
  core.progress(99);
  assert.deepEqual(core.getCoord(), {x: 4.5, y: -3});
  assert.ok(log.includes('advance:0.25'));
  assert.equal(core.isReplayingAPILog(), true);
  log.length = 0;
  core.progress(99);
  assert.deepEqual(core.getCoord(), {x: 10, y: 20});
  assert.equal(core.getVariable('plain'), f32(0.333333));
  assert.ok(log.includes('advance:0.5'));
  assert.equal(core.isReplayingAPILog(), true);
  log.length = 0;
  core.progress(0.125);
  assert.equal(core.getScale(), 2);
  assert.ok(log.includes('advance:0.125'));
  assert.equal(core.isReplayingAPILog(), false);
  assert.equal(core.getAPILog(), saved);
  core.setAPILog('CalcLayerFrameInfo 0\n');
  core.startReplayAPILog();
  core.progress(7);
  assert.equal(core.isReplayingAPILog(), true); // A final marker returns before the end check.
  core.progress(0);
  assert.equal(core.isReplayingAPILog(), false);
});

test('x64 API replay scans numeric prefixes and rounds decimal input directly to binary32', () => {
  const {core} = x64Player();
  core.setAPILog(
    'SetVariable up 1.000000059604644775390625000001 0 0\nSetVariable down 1.000000059604644775390624999999 0 0\nSetVariable tie 1.000000059604644775390625 0 0\nSetVariable hex 0x1.ep+2 0 0\nSetVariable prefixes 2-3+4 trailing text\nSetVariable malformed 1e+ 0 0\nCalcLayerFrameInfo 0\n',
  );
  core.startReplayAPILog();
  core.progress(0);
  assert.equal(core.getVariable('up'), f32(1 + 2 ** -23));
  assert.equal(core.getVariable('down'), 1);
  assert.equal(core.getVariable('tie'), 1);
  assert.equal(core.getVariable('hex'), 7.5);
  assert.equal(core.getVariable('prefixes'), 2);
  assert.equal(core.cells.has('malformed'), false);
  core.setAPILog(
    'SetVariable \uFEFFlabel 2 0 0\nSetVariable bomNumber \uFEFF2 0 0\nCalcLayerFrameInfo 0\n',
  );
  core.startReplayAPILog();
  core.progress(0);
  assert.equal(core.getVariable('\uFEFFlabel'), 2);
  assert.equal(core.cells.has('label'), false);
  assert.equal(core.cells.has('bomNumber'), false);
  const edges = [
    ['0x1p-149', 0x00000001],
    ['0x1p-150', 0x00000000],
    ['0x1.0000001p-150', 0x00000001],
    ['-0x1p-150', 0x80000000],
    ['0x0.ffffffp-126', 0x00800000],
    ['0x0.fffffeffffffffffffp-126', 0x007fffff],
    ['0x1.fffffep127', 0x7f7fffff],
    ['0x1.ffffffp127', 0x7f800000],
    ['1.000000059604644775390625' + '0'.repeat(1000) + '1', 0x3f800001],
  ];
  core.setAPILog(
    edges.map(([text], i) => `SetVariable edge${i} ${text} 0 0`).join('\n') +
      '\nCalcLayerFrameInfo 0\n',
  );
  core.startReplayAPILog();
  core.progress(0);
  const bytes = new DataView(new ArrayBuffer(4));
  for (const [i, [, word]] of edges.entries()) {
    bytes.setFloat32(0, core.getVariable(`edge${i}`), true);
    assert.equal(bytes.getUint32(0, true), word);
  }
});

test('x64 API scopes unwind after exceptions and assignment records its native internal calls', () => {
  const {core, clip} = x64Player();
  core.startRecordAPILog();
  const evaluate = clip.evaluate;
  clip.evaluate = () => {
    throw Error('synthetic evaluation failure');
  };
  assert.throws(() => core.progress(0), /synthetic evaluation failure/);
  clip.evaluate = evaluate;
  core.setVariable('plain', 2, 0, 0);
  assert.equal(
    core.getAPILog(),
    'CalcLayerFrameInfo 0.000000\r\nSetVariable plain 2.000000 0.000000 0.000000\r\n',
  );
  core.clearAPILog();
  core.startRecordAPILog();
  const source = x64Player().core;
  source.setAPILog('Pass \r\n');
  core.assignState(source);
  assert.equal(core.isRecordingAPILog(), true);
  assert.equal(core.getAPILog(), 'StopTimeline \r\n');
  assert.equal(source.getAPILog(), 'Pass \r\n');
  const definitions = [
    timeline('main', [['v', [frame(0, 1), frame(4, 5), empty(20)]]], {lastTime: 20}),
  ];
  const playing = x64Player({timelineControl: definitions}).core;
  playing.playTimeline('main');
  playing.progress(5);
  const receiver = x64Player({timelineControl: definitions}).core;
  receiver.startRecordAPILog();
  receiver.assignState(playing);
  const entries = receiver.getAPILog().trimEnd().split('\r\n');
  assert.equal(entries[0], 'StopTimeline ');
  assert.equal(entries[1], 'PlayTimeline main 1');
  assert.equal(entries.length, 3);
  assert.ok(entries[2].startsWith('SetVariable v '));
});

async function stereoCore(fields = {}, wasm = false) {
  const {emoteScalarClipFactory} = await import('../dist/native/emotedriver/runtime/clip.js');
  const {createEmoteMeshKernel} = await import('../dist/native/emotedriver/runtime/mesh/index.js');
  const file = model({
    stereovisionControl: {variableMatchList: ['eye', 'missing', 'constant', 'eye']},
    ...fields,
  });
  const definition = {
    ...motion,
    lastTime: 20,
    loopTime: -1,
    parameters: [
      {id: 'eye', discretization: false, rangeBegin: -1, rangeEnd: 1, division: 10, unread: {}},
      {id: 'constant', discretization: false, rangeBegin: 2, rangeEnd: 2, division: 10, unread: {}},
    ],
  };
  file.objects = new Map([['chara', {motions: new Map([['motion', definition]]), unread: {}}]]);
  const kernel = createEmoteMeshKernel({driverSha256: EMOTEDRIVER_X64_SHA256, wasm});
  assert.equal(kernel.accelerated, wasm);
  let randomDraws = 0;
  const core = new EmotePlayerCore({
    model: file,
    driverSha256: EMOTEDRIVER_X64_SHA256,
    random: () => {
      randomDraws++;
      return 0.5;
    },
    createClip: emoteScalarClipFactory([file], {kernel}),
    createControls: createEmoteControls,
  });
  return {core, randomDraws: () => randomDraws};
}

test('x64 stereo owns a deferred independent clip pair and advances both with shared transforms', async () => {
  for (const wasm of [false, true]) {
    const {core, randomDraws} = await stereoCore({}, wasm);
    assert.equal(core.stereoVariables.size, 1);
    assert.equal(core.cells.has('eye'), true);
    assert.equal(core.cells.has('missing'), false);
    assert.equal(core.cells.has('constant'), false);
    assert.equal(core.getStereovisionEnabled(), false);
    assert.equal(core.getStereovisionVolume(), 1);
    assert.equal(core.getStereovisionParallaxRatio(), f32(0.2));
    core.setVariable('plain', 4, 0, 0);
    core.setCoord(12, -4, 0, 0);
    core.setScale(2, 0, 0);
    core.setColor(0x20406080, 0, 0);
    core.setGrayscale(0.5, 0, 0);
    core.setStereovisionEnabled(true);
    core.queueDivisor = 2;
    core.queueSlot = 0;
    core.queuePhase = 0;
    core.progress(1);
    assert.equal(core.clips.length, 1);
    core.progress(1);
    assert.equal(core.clips.length, 2);
    const [left, right] = core.clips;
    assert.notEqual(left, right);
    assert.notEqual(left.values, right.values);
    assert.notEqual(left.root.adjust, right.root.adjust);
    assert.notEqual(left.parameters[0], right.parameters[0]);
    assert.equal(left.resource, right.resource);
    assert.equal(left.getVariable('eye'), 0.19999998807907104);
    assert.equal(right.getVariable('eye'), -0.19999998807907104);
    for (const clip of core.clips) {
      assert.equal(clip.getVariable('plain'), 4);
      assert.equal(clip.timeRunning, 2);
      assert.equal(clip.rootX, 12);
      assert.equal(clip.rootY, -4);
      assert.equal(clip.rootZoomX, 2);
      assert.equal(clip.color, 0x20406080);
      assert.equal(clip.grayscaleMode, 5);
      assert.equal(clip.grayscaleLevel, 127);
    }
    assert.equal(randomDraws(), 0);
    assert.equal(core.stereovision.dirty, false);
    core.setStereovisionVolume(1 + 2 ** -25);
    core.setStereovisionParallaxRatio(0.2);
    assert.equal(core.stereovision.dirty, false);
    core.setStereovisionRenderScreen(1);
    assert.equal(core.renderClip, right);
    core.setStereovisionRenderScreen(-1);
    assert.equal(core.getStereovisionRenderScreen() >>> 0, 0xffffffff);
    assert.equal(core.renderClip, right);
    core.setStereovisionEnabled(false);
    assert.equal(core.clips.length, 2);
    core.progress(1);
    assert.equal(core.clips.length, 2);
    core.progress(1);
    assert.equal(core.clips.length, 1);
    assert.equal(core.renderClip, left);
    assert.equal(left.getVariable('eye'), 0);
    assert.throws(
      () => player().core.setStereovisionEnabled(true),
      /API unavailable for DLL build/,
    );
  }
});

test('x64 stereo mirrors screen mapping, rebuilds dirty coefficients and retains destination ranges on copy', async () => {
  const {core} = await stereoCore({mirror: true, mirrorControl: {variableMatchList: ['eye']}});
  core.setStereovisionEnabled(true);
  core.progress(0);
  assert.equal(core.clips[0].getVariable('eye'), -0.19999998807907104);
  assert.equal(core.clips[1].getVariable('eye'), 0.19999998807907104);
  core.setStereovisionVolume(-0);
  core.progress(0);
  assert.equal(core.clips[0].getVariable('eye'), 0);
  assert.equal(core.clips[1].getVariable('eye'), 0);
  core.setStereovisionVolume(0);
  assert.equal(Object.is(core.getStereovisionVolume(), -0), true);
  assert.equal(core.stereovision.dirty, false);
  core.setStereovisionVolume(0.75);
  core.setStereovisionParallaxRatio(0.4);
  assert.equal(core.stereovision.dirty, true);
  core.progress(0);
  const copied = core.clone();
  assert.equal(copied.clips.length, 2);
  assert.equal(copied.getStereovisionEnabled(), true);
  assert.equal(copied.stereovision.dirty, true);
  assert.notEqual(copied.stereoVariables.get('eye'), core.stereoVariables.get('eye'));
  assert.notEqual(
    copied.stereoVariables.get('eye').coefficients.buffer,
    core.stereoVariables.get('eye').coefficients.buffer,
  );
  for (let i = 0; i < 2; i++) {
    assert.notEqual(copied.clips[i], core.clips[i]);
    assert.equal(copied.clips[i].getVariable('eye'), core.clips[i].getVariable('eye'));
  }
  copied.progress(0);
  assert.deepEqual(
    copied.stereoVariables.get('eye').coefficients,
    core.stereoVariables.get('eye').coefficients,
  );
  copied.setStereovisionEnabled(false);
  copied.progress(0);
  assert.equal(copied.clips.length, 1);
  assert.equal(core.clips.length, 2);
  core.clearAPILog();
  core.startRecordAPILog();
  core.setStereovisionEnabled(false);
  core.setStereovisionVolume(1);
  core.setStereovisionParallaxRatio(0.2);
  core.setStereovisionRenderScreen(0);
  assert.equal(core.getAPILog(), '');
});

test('x64 stereo keeps a single clip when no requested variable has a nonzero range', async () => {
  const {core} = await stereoCore({
    stereovisionControl: {variableMatchList: ['missing', 'constant']},
  });
  core.setStereovisionEnabled(true);
  core.progress(0);
  assert.equal(core.getStereovisionEnabled(), true);
  assert.equal(core.clips.length, 1);
  assert.equal(core.stereoVariables.size, 0);
});

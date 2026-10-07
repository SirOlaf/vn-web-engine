import test from 'node:test';
import assert from 'node:assert/strict';
import {createEmoteClip} from '../dist/native/emotedriver/runtime/clip.js';
import {
  bernsteinTable,
  createEmoteMeshKernel,
  emoteMeshKernelJs,
} from '../dist/native/emotedriver/runtime/mesh/index.js';
import {EmoteMotionRenderer} from '../dist/native/emotedriver/runtime/render/renderer.js';

const f = Math.fround;

// ---------------------------------------------------------------------------------------
// Synthetic models (the typed reader's shapes, built directly).

function content(fields = {}) {
  return {
    mask: 0,
    src: null,
    icon: null,
    act: null,
    ox: 0,
    oy: 0,
    coord: [0, 0, 0],
    fx: false,
    fy: false,
    angle: 0,
    zx: 1,
    zy: 1,
    sx: 0,
    sy: 0,
    color: [0x808080ff, 0x808080ff, 0x808080ff, 0x808080ff],
    opa: 255,
    bm: 0x10,
    ti: 0,
    ccc: null,
    acc: null,
    zcc: null,
    scc: null,
    occ: null,
    cp: null,
    mesh: null,
    motion: null,
    prt: null,
    camera: null,
    anchor: null,
    model: null,
    feedback: null,
    unread: {},
    ...fields,
  };
}

const frame = (time, type, fields) => ({time, type, content: type === 0 ? null : content(fields)});

function layer(label, frames, extra = {}) {
  return {
    label,
    type: 0,
    parameterize: null,
    inheritMask: 0x20007fc,
    transformOrder: [0, 3, 2, 1],
    stencilType: 0,
    coordinate: 0,
    joinTarget: true,
    groundCorrection: false,
    meshTransform: 0,
    mesh: null,
    objTriPriority: 0,
    shape: null,
    motionIndependentLayerInherit: null,
    particle: null,
    anchor: null,
    screenBounds: null,
    stencilCompositeMaskLayerList: null,
    frames,
    children: [],
    unread: {},
    ...extra,
  };
}

function motion(layers, extra = {}) {
  const index = new Map();
  let n = 0;
  const walk = (ls) => {
    for (const l of ls) {
      index.set(l.label, n++);
      walk(l.children);
    }
  };
  walk(layers);
  return {
    priority: [
      {time: 0, type: 1, content: [...index.values()].reverse()},
      {time: 1000, type: 1, content: null},
    ],
    tag: [],
    loopTime: -1,
    lastTime: 100,
    bounds: {left: 0, top: 0, right: 0, bottom: 0},
    parameters: [],
    parameterize: null,
    layerIndexMap: index,
    layers,
    unread: {type: 0},
    ...extra,
  };
}

function model(motions, extra = {}) {
  const icons = new Map([
    [
      'i',
      {
        attr: 1,
        originX: 5,
        originY: 5,
        left: 16,
        top: 8,
        width: 10,
        height: 10,
        pixel: null,
        unread: {},
      },
    ],
  ]);
  return {
    id: 'motion',
    label: null,
    spec: 'win',
    version: f(3.03),
    screenSize: {width: 1, height: 1, originX: 0, originY: 0},
    sources: new Map([['tex', {texture: null, icons, unread: {}}]]),
    objects: new Map(
      Object.entries(motions).map(([name, ms]) => [
        name,
        {motions: new Map(Object.entries(ms)), unread: {}},
      ]),
    ),
    easing: [],
    metadata: {},
    diagnostics: [],
    unread: {},
    ...extra,
  };
}

/** Plays `frames` frames of a clip. */
function run(clip, frames) {
  for (let i = 0; i < frames; i++) {
    clip.advance(1);
    clip.evaluate();
  }
}

// ---------------------------------------------------------------------------------------

test('mesh kernel: Wasm and TypeScript agree bit for bit on synthetic patches', () => {
  const wasm = createEmoteMeshKernel();
  assert.notEqual(wasm, emoteMeshKernelJs, 'the Wasm kernel instantiates under node');
  let seed = 12345;
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32) * 400 - 200;
  for (let round = 0; round < 40; round++) {
    const cp = Float32Array.from({length: 32}, rnd);
    const columns = 1 + (round % 9),
      rows = 1 + ((round * 7) % 13);
    const a = new Float32Array((columns + 1) * (rows + 1) * 2),
      b = new Float32Array(a.length);
    wasm.evaluatePatch(cp, columns, rows, a);
    emoteMeshKernelJs.evaluatePatch(cp, columns, rows, b);
    assert.deepEqual(new Uint32Array(a.buffer), new Uint32Array(b.buffer));
    const corners = Float32Array.from({length: 8}, rnd);
    wasm.subdivideQuad(corners, columns, rows, a);
    emoteMeshKernelJs.subdivideQuad(corners, columns, rows, b);
    assert.deepEqual(new Uint32Array(a.buffer), new Uint32Array(b.buffer));
    const inverse = Float32Array.of(f(1 / 200), f(rnd() / 1e5), f(rnd() / 1e5), f(1 / 150));
    const points = Float32Array.from({length: 50}, rnd),
      copy = points.slice();
    wasm.deformPoints(cp, inverse, 3.5, -7.25, points, 25);
    emoteMeshKernelJs.deformPoints(cp, inverse, 3.5, -7.25, copy, 25);
    assert.deepEqual(new Uint32Array(points.buffer), new Uint32Array(copy.buffer));
  }
});

test('mesh kernel: a linear patch reproduces its frame; Bernstein weights sum to one', () => {
  for (const segments of [1, 3, 7]) {
    const w = bernsteinTable(segments);
    for (let i = 0; i <= segments; i++) {
      const sum = w[i * 4] + w[i * 4 + 1] + w[i * 4 + 2] + w[i * 4 + 3];
      assert.ok(Math.abs(sum - 1) < 1e-6);
    }
  }
  // Control points on a 30×60 box (unit patch × (30, 60), offset (10, 20)).
  const cp = new Float32Array(32);
  for (let i = 0; i < 16; i++) {
    cp[i * 2] = f(10 + ((i & 3) / 3) * 30);
    cp[i * 2 + 1] = f(20 + ((i >> 2) / 3) * 60);
  }
  const out = new Float32Array(4 * 3 * 2);
  emoteMeshKernelJs.evaluatePatch(cp, 3, 2, out);
  for (let j = 0; j <= 2; j++)
    for (let i = 0; i <= 3; i++) {
      const k = (j * 4 + i) * 2;
      assert.ok(Math.abs(out[k] - (10 + i * 10)) < 1e-4, `x ${i},${j}`);
      assert.ok(Math.abs(out[k + 1] - (20 + j * 30)) < 1e-4, `y ${i},${j}`);
    }
  const quad = Float32Array.of(0, 0, 8, 0, 0, 4, 8, 4),
    grid = new Float32Array(3 * 3 * 2);
  emoteMeshKernelJs.subdivideQuad(quad, 2, 2, grid);
  assert.deepEqual([...grid], [0, 0, 4, 0, 8, 0, 0, 2, 4, 2, 8, 2, 0, 4, 4, 4, 8, 4]);
});

test('keyframes: tweened coordinate, shortest-arc angle, rounded opacity, colour lerp', () => {
  const m = motion([
    layer('a', [
      frame(0, 3, {
        mask: 0x612,
        coord: [0, 10, 0],
        angle: 350,
        opa: 0,
        color: [0x000000ff, 0x000000ff, 0x000000ff, 0x000000ff],
      }),
      frame(10, 3, {
        mask: 0x612,
        coord: [100, 30, 0],
        angle: 10,
        opa: 255,
        color: [0xff0000ff, 0xff0000ff, 0xff0000ff, 0xff0000ff],
      }),
      frame(20, 2, {mask: 0x2, coord: [7, 7, 0]}),
    ]),
  ]);
  const clip = createEmoteClip(model({o: {m}}), m);
  clip.rootVisible = true;
  run(clip, 6); // time 0, 1, ..., 5
  assert.equal(clip.time, 5);
  const n = clip.nodes[1];
  assert.equal(n.x, 50);
  assert.equal(n.y, 20);
  // 350 → 10 crosses 360: halfway is 360, kept (only > 360 wraps).
  assert.equal(n.angle, 360);
  assert.equal(n.opacity, 128); // 127.5 rounds half away from zero
  // Colour weight trunc(0.5 · 256) = 128 on each channel (0x00 → 0xff gives 0x7f).
  assert.equal(n.colors[0] >>> 24, 0x7f);
  assert.equal(n.visible, true);
  run(clip, 15);
  assert.equal(clip.time, 20);
  assert.deepEqual([n.x, n.y], [7, 7]); // type 2 frame: no tween
});

test('easing: a root easing curve shapes the tween (natural cubic spline, 0x10029230)', () => {
  // y = x² sampled at 0, 0.5, 1 with second derivatives 0 at the ends and 2 in the middle.
  const easing = [
    [
      {
        points: [
          {x: 0, y: 0, p: 0},
          {x: 0.5, y: 0.25, p: 3},
          {x: 1, y: 1, p: 0},
        ],
      },
    ],
  ];
  const m = motion([
    layer('a', [
      frame(0, 3, {mask: 0x802, coord: [0, 0, 0], ccc: 0}),
      frame(10, 3, {mask: 0x2, coord: [100, 0, 0]}),
    ]),
  ]);
  const clip = createEmoteClip(model({o: {m}}, {easing}), m);
  run(clip, 4); // time 3
  const t = 0.3,
    u = f(t / 0.5),
    v = f(1 - u);
  const k = f(
    (((u * u * u - u) * 3 + (v * v * v - v) * 0) * f(0.5) * f(0.5)) / 6 + 0.25 * u + 0 * v,
  );
  assert.equal(clip.nodes[1].x, f(100 * k));
});

test('inherit: full mask composes the parent frame; partial bits add angle only', () => {
  const child = (label, mask) =>
    layer(label, [frame(0, 2, {mask: 0x2, coord: [10, 0, 0]})], {inheritMask: mask});
  const m = motion([
    layer(
      'p',
      [frame(0, 2, {mask: 0x472, coord: [100, 50, 0], angle: 90, zx: 2, zy: 2, opa: 128})],
      {
        children: [child('full', 0x20007fc), child('angle', 0x10)],
      },
    ),
  ]);
  const clip = createEmoteClip(model({o: {m}}), m);
  clip.rootVisible = true;
  run(clip, 1);
  const [, p, full, partial] = clip.nodes;
  assert.ok(Math.abs(p.matrix[0]) < 1e-6 && Math.abs(p.matrix[1] + 2) < 1e-6);
  // (10, 0) through rotate(90°)·zoom(2) = (0, 20), plus the parent's coordinate.
  assert.ok(Math.abs(full.x - 100) < 1e-4 && Math.abs(full.y - 70) < 1e-4);
  assert.equal(full.angle, 90);
  assert.equal(full.zoomX, 2);
  assert.equal(full.opacity, 128); // 0x400: opacity from the parent
  assert.equal(partial.angle, 90);
  assert.equal(partial.zoomX, 1);
  assert.equal(partial.opacity, 255); // no 0x400: root opacity
  // Partial frames: root · node frame (the root is the identity here).
  assert.ok(Math.abs(partial.matrix[1] + 1) < 1e-6);
});

test('mesh: a bezier layer deforms its child image; grid sizes follow division and ratio', () => {
  // A blank 100×50 mesh layer whose patch bends the right edge down by 10 units.
  const bp = new Float32Array(32);
  for (let i = 0; i < 16; i++) {
    bp[i * 2] = f((i & 3) / 3);
    bp[i * 2 + 1] = f((i >> 2) / 3 + ((i & 3) === 3 ? 0.2 : 0));
  }
  const mesh = layer(
    'mesh',
    [frame(0, 2, {mask: 0x2000000, src: 'blank', icon: '100:50:0:0', mesh: {bp, cc: null}})],
    {
      meshTransform: 1,
      mesh: {syncChildMask: 8, division: 6, combine: false},
      children: [
        layer('img', [frame(0, 2, {mask: 0x3, src: 'tex', icon: 'i', coord: [90, 0, 0]})], {
          meshTransform: 0,
        }),
      ],
    },
  );
  const m = motion([mesh]);
  const clip = createEmoteClip(model({o: {m}}), m, {meshDivisionRatio: 1});
  clip.rootVisible = true;
  run(clip, 1);
  const [, meshNode, img] = clip.nodes;
  assert.equal(meshNode.meshActive, true);
  assert.equal(meshNode.grid, null, 'blank layers have no grid');
  assert.equal(img.meshParent, meshNode);
  // Division 6 scaled by the image size relative to the mesh: 6·20/150 = 0 → 0 + 1 columns.
  assert.deepEqual([img.grid.columns, img.grid.rows], [1, 1]);
  // The image's top-left (-5, -5) maps through the patch; its right edge moves down.
  const p = img.grid.positions;
  assert.equal(p.length, 8);
  assert.ok(p[3] > p[1], 'right edge is lower than the left edge');
  // Ratio 4 doubles... the image grid becomes 6·4·20/150 = 3 divisions.
  clip.meshDivisionRatio = 4;
  clip.nodes[2].state.changed = true;
  run(clip, 1);
  assert.equal(img.grid.columns + img.grid.rows - 2, 3);
  assert.equal(clip.isModified(), true);
});

test('nested motion: the child starts at its frame time plus timeOffset and follows the parent', () => {
  const sub = motion([
    layer('s', [
      frame(0, 3, {mask: 0x2, coord: [0, 0, 0]}),
      frame(100, 3, {mask: 0x2, coord: [100, 0, 0]}),
    ]),
  ]);
  const main = motion([
    layer(
      'ref',
      [
        frame(0, 0),
        frame(3, 2, {
          mask: 0x80002,
          src: 'o',
          icon: 'sub',
          coord: [5, 0, 0],
          motion: {
            mask: 0,
            flags: null,
            dt: null,
            docmpl: null,
            dofst: null,
            dtgt: null,
            timeOffset: 10,
          },
        }),
        frame(50, 2, {mask: 0x2, src: 'o', icon: 'sub'}),
      ],
      {type: 3, motionIndependentLayerInherit: false},
    ),
  ]);
  const clip = createEmoteClip(model({o: {main, sub}}), main);
  clip.rootVisible = true;
  run(clip, 4); // times 0..3: the reference frame starts at 3
  const ref = clip.nodes[1],
    child = ref.child;
  assert.equal(child.motion, sub);
  assert.equal(child.time, 10); // (3 - 3) + 10
  assert.equal(child.nodes[1].x, 10 + 5); // child x 10, offset by the layer coordinate
  run(clip, 5);
  assert.equal(child.time, 15);
  assert.equal(child.nodes[1].x, 20);
});

test('events: keyframe act labels are queued while stepping and dispatched in order', () => {
  const m = motion([
    layer('a', [
      frame(0, 2, {mask: 0x2}),
      frame(2, 2, {mask: 0x40000, act: 'blink'}),
      frame(4, 2, {mask: 0x40000, act: 'wave'}),
      frame(6, 2, {mask: 0x2}),
    ]),
  ]);
  const clip = createEmoteClip(model({o: {m}}), m);
  const got = [];
  const listener = {action: (c, label) => got.push([clip.time, label])};
  for (let i = 0; i < 8; i++) {
    clip.advance(1);
    clip.evaluate();
    clip.dispatchEvents(listener);
  }
  assert.deepEqual(got, [
    [2, 'blink'],
    [4, 'wave'],
  ]);
});

test('parameters: a variable drives a parameterized layer through its range', () => {
  const m = motion(
    [
      layer(
        'a',
        [frame(0, 3, {mask: 0x2, coord: [0, 0, 0]}), frame(10, 3, {mask: 0x2, coord: [100, 0, 0]})],
        {
          parameterize: 0,
        },
      ),
    ],
    {
      parameters: [
        {id: 'face', discretization: false, rangeBegin: -1, rangeEnd: 1, division: 10, unread: {}},
      ],
    },
  );
  const clip = createEmoteClip(model({o: {m}}), m);
  clip.applyVariable('face', 0.5);
  assert.equal(clip.getVariable('face'), 0.5);
  run(clip, 1);
  assert.equal(clip.nodes[1].x, 75); // (0.5 + 1)·10/2 = 7.5 → 75
  clip.applyVariable('face', -2); // clamped to the range
  run(clip, 1);
  assert.equal(clip.nodes[1].x, 0);
});

test('assignState copies time and node state (clone keeps the clip time)', () => {
  const m = motion([
    layer('a', [
      frame(0, 3, {mask: 0x2, coord: [0, 0, 0]}),
      frame(10, 3, {mask: 0x2, coord: [100, 0, 0]}),
    ]),
  ]);
  const mod = model({o: {m}});
  const a = createEmoteClip(mod, m);
  run(a, 5);
  const b = createEmoteClip(mod, m);
  b.assignState(a);
  assert.equal(b.time, a.time);
  run(a, 1);
  run(b, 1);
  assert.equal(b.nodes[1].x, a.nodes[1].x);
});

test('clip → renderer: evaluated nodes become draw items with grid, rect and colours', () => {
  const m = motion([
    layer('img', [
      frame(0, 2, {
        mask: 0x202,
        src: 'tex',
        icon: 'i',
        coord: [20, 30, 0],
        color: [0xff0000ff, 0xff0000ff, 0xff0000ff, 0xff0000ff],
      }),
    ]),
  ]);
  const clip = createEmoteClip(model({o: {m}}), m, {textureIndexOf: (s) => (s === 'tex' ? 1 : -1)});
  clip.rootVisible = true;
  run(clip, 1);
  const renderer = new EmoteMotionRenderer({});
  renderer.build(clip, clip.color, null);
  const list = renderer['list'];
  assert.equal(list.length, 1);
  const item = list[0];
  assert.equal(item.texture, 1);
  assert.equal(item.flags, 1); // icon attr
  assert.deepEqual(item.rect, [16, 8, 10, 10]);
  assert.deepEqual([...item.colors], [0xff0000ff, 0xff0000ff, 0xff0000ff, 0xff0000ff]);
  // Icon origin (5, 5): the 10×10 quad spans (15, 25)..(25, 35).
  assert.deepEqual([...item.grid.positions], [15, 25, 25, 25, 15, 35, 25, 35]);
});

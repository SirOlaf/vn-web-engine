import test from 'node:test';
import assert from 'node:assert/strict';
import {createEmoteClip, EmoteClip} from '../dist/native/emotedriver/runtime/clip.js';
import {
  bernsteinTable,
  createEmoteMeshKernel,
  emoteMeshKernelJs,
} from '../dist/native/emotedriver/runtime/mesh/index.js';
import {EmoteMotionRenderer} from '../dist/native/emotedriver/runtime/render/renderer.js';
import {EMOTEDRIVER_X64_SHA256} from '../dist/native/emotedriver/build.js';
import {
  lerpAngle,
  lerpCoord,
  lerpPatch,
} from '../dist/native/emotedriver/runtime/clip/interpolate.js';

import {FrameSlot, loadHeader, loadContent} from '../dist/native/emotedriver/runtime/clip/frame.js';
import {ClipParameter, NodeState} from '../dist/native/emotedriver/runtime/clip/node.js';
import {EmoteClipTime} from '../dist/native/emotedriver/runtime/clip/time.js';
import {EmoteMotionClip, EmoteResource} from '../dist/native/emotedriver/runtime/clip.js';

test('x64 variable ranges include loaded nested degenerate parameters and mesh-combinator ranges', async () => {
  const {emoteScalarClipFactory} = await import('../dist/native/emotedriver/runtime/clip.js');
  const parameter = (id, rangeBegin, rangeEnd) => ({
    id,
    rangeBegin,
    rangeEnd,
    division: 10,
    discretization: false,
    unread: {},
  });
  const patch = Float32Array.from({length: 32}, (_, i) => (i & 1 ? i >> 3 : (i >> 1) & 3) / 3);
  const child = motion([], {parameters: [parameter('mixed', 5, 5)]});
  const main = motion(
    [
      layer('nested', [frame(0, 2, {mask: 1, src: 'child', icon: 'm'})], {type: 3}),
      layer(
        'mesh',
        [frame(0, 2, {mask: 0x2000001, src: 'tex', icon: 'i', mesh: {bp: patch, cc: null}})],
        {
          meshTransform: 1,
          mesh: {
            syncChildMask: 0,
            division: 4,
            combine: false,
            combinators: [
              {
                key: 'shape',
                rangeBegin: 7,
                rangeEnd: -3,
                meshCount: 2,
                neutralIndex: 0,
                raw: new Float32Array(64),
              },
            ],
          },
        },
      ),
    ],
    {parameters: [parameter('mixed', 1, 0), parameter('constant', 2, 2)]},
  );
  const file = model({object: {main}, child: {m: child}});
  file.sources.get('tex').icons.get('i').resolution = 1;
  for (const wasm of [false, true]) {
    const kernel = createEmoteMeshKernel({driverSha256: EMOTEDRIVER_X64_SHA256, wasm});
    const clip = emoteScalarClipFactory([file], {kernel})(main);
    clip.progress(0);
    assert.deepEqual(clip.getVariableRange('mixed'), [0, 5]);
    assert.deepEqual(clip.getVariableRange('shape'), [-3, 7]);
    assert.equal(clip.getVariableRange('constant'), null);
    assert.equal(clip.getVariableRange('unknown'), null);
  }
});
import {
  composeEmoteMatrix,
  multiplyEmoteMatrices,
} from '../dist/native/emotedriver/runtime/clip/matrix.js';

const f = Math.fround;

test('clip interpolation preserves each image’s angle wrap and near-zero mesh weight', () => {
  assert.equal(lerpAngle(null, 350, 10, 0.5), 360);
  assert.equal(lerpAngle(null, 350, 10, 0.5, EMOTEDRIVER_X64_SHA256), 0);
  assert.equal(lerpAngle(null, 360, 360, 0.5, EMOTEDRIVER_X64_SHA256), 360);
  const a = new Float32Array(32).fill(1),
    b = new Float32Array(32).fill(3);
  const x86 = new Float32Array(32),
    x64 = new Float32Array(32);
  lerpPatch(null, a, b, 2 ** -25, x86);
  lerpPatch(null, a, b, 2 ** -25, x64, EMOTEDRIVER_X64_SHA256);
  assert.equal(x86[0], 1.0000001192092896);
  assert.equal(x64[0], 1);
  const coordinates = new Float32Array(5).fill(9);
  lerpCoord(null, [1, 2, 3], [5, 6, 7], 0.25, coordinates, 1, EMOTEDRIVER_X64_SHA256);
  assert.deepEqual([...coordinates], [9, 2, 3, 4, 9]);
  assert.throws(() => lerpAngle(null, 0, 0, 0, '3.9.8'), /unsupported DLL build/);
});

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

test('frame slots retain each image’s mesh lifetime, color presence and end sentinel', () => {
  const patch = new Float32Array(32).fill(0.25);
  const frames = [
    frame(1.1, 3, {
      mask: 0x2000000 | 0x200,
      bm: 0,
      bmParam: 0.3,
      color: [0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff],
      colorList: true,
      colorKey: true,
      mesh: {cc: null, bp: patch},
    }),
    frame(2, 2, {bmParam: 0, colorList: false, colorKey: false}),
  ];
  const x86 = new FrameSlot(),
    x64 = new FrameSlot(EMOTEDRIVER_X64_SHA256);
  const read = (slot, index) => {
    loadHeader(slot, frames, index);
    loadContent(slot, frames, 0, {easing: null});
  };
  read(x86, 0);
  read(x64, 0);
  assert.equal(x86.singleColor, true);
  assert.equal(x64.singleColor, false);
  assert.equal(x86.colors[0], 0xffffffff);
  assert.equal(x64.colors[0], 0x7f7f7fff);
  assert.equal(x64.bm, 0x10);
  assert.equal(x64.time, f(1.1));
  read(x86, 1);
  read(x64, 1);
  assert.equal(x86.meshPatch, patch);
  assert.equal(x64.meshPatch.length, 0);
  read(x86, 2);
  read(x64, 2);
  assert.equal(x86.time, 2);
  assert.equal(x64.time, Infinity);
  assert.equal(x64.empty, true);
  assert.equal(x64.zx, 1);
  assert.equal(x64.motion.dt, 1);
  assert.throws(() => x86.copyFrom(x64), /between DLL builds/);
  assert.throws(() => new FrameSlot('3.9.8'), /unsupported DLL build/);
});

test('x64 frame loading retains deferred curves and rejects unsupported native payloads', () => {
  const slot = new FrameSlot(EMOTEDRIVER_X64_SHA256);
  const frames = [frame(0, 3, {ccc: 0, bmParam: 0})];
  loadHeader(slot, frames, 0);
  loadContent(slot, frames, 0, {easing: null});
  assert.equal(slot.eased, true);
  const bad = [frame(0, 2, {unread: {stc: 0}, bmParam: 0})];
  loadHeader(slot, bad, 0);
  assert.throws(() => loadContent(slot, bad, 0, {easing: null}), /stencil alpha test/);
});

test('clip parameters preserve each image’s input float store and reversed ranges', () => {
  const x86 = new ClipParameter('p', false, 0, 1, 3);
  const x64 = new ClipParameter('p', false, 0, 1, 3, EMOTEDRIVER_X64_SHA256);
  const value = 1 / 3 + 2 ** -27;
  x86.apply(value);
  x64.apply(value);
  assert.equal(x86.position, f(f(value) * 3));
  assert.equal(x64.position, f(value * 3));
  const reverse = new ClipParameter('p', true, 2, -2, 10, EMOTEDRIVER_X64_SHA256);
  reverse.flags = 7;
  reverse.apply(-0.75);
  assert.equal(reverse.position, 5);
  assert.equal(reverse.flags, 0);
  reverse.apply(99);
  assert.equal(reverse.position, -0);
  const empty = new ClipParameter('p', false, 1, 1, 0);
  empty.apply(Infinity);
  assert.equal(empty.position, 0);
  assert.throws(() => new ClipParameter('p', false, 0, 1, 1, '3.9.8'), /unsupported DLL build/);
});

test('matrix composition accepts transform views and caller-owned, aliasable output', () => {
  const state = {
    flipX: true,
    flipY: false,
    angle: 0,
    zoomX: 2,
    zoomY: 3,
    slantX: 0.25,
    slantY: -0.5,
  };
  for (const sha of [undefined, EMOTEDRIVER_X64_SHA256]) {
    const output = new Float32Array(4);
    composeEmoteMatrix(state, [0, 3, 2, 1], output, sha);
    assert.deepEqual([...output], [-2, 0.5, 1.5, 3]);
    let scalar;
    const target = {
      setMatrix: (m00, m01, m10, m11) => {
        scalar = [m00, m01, m10, m11];
      },
    };
    composeEmoteMatrix(state, [0, 3, 2, 1], target, sha);
    assert.deepEqual(scalar, [...output]);
    multiplyEmoteMatrices(
      {m00: 2, m01: 1, m10: 0, m11: 3},
      {m00: 1, m01: 2, m10: 3, m11: 4},
      target,
      sha,
    );
    assert.deepEqual(scalar, [5, 8, 9, 12]);
    const left = new Float32Array([2, 1, 0, 3]),
      right = new Float32Array([1, 2, 3, 4]);
    multiplyEmoteMatrices(left, right, right, sha);
    assert.deepEqual([...right], [5, 8, 9, 12]);
  }
  const output = new Float32Array(4).fill(42);
  assert.throws(() => composeEmoteMatrix(state, [], output, '3.9.8'), /unsupported DLL build/);
  assert.deepEqual([...output], [42, 42, 42, 42]);
});

test('x64 mesh backends agree on transformed grids, offset points and double matrix inputs', () => {
  const js = createEmoteMeshKernel({driverSha256: EMOTEDRIVER_X64_SHA256, wasm: false});
  const wasm = createEmoteMeshKernel({driverSha256: EMOTEDRIVER_X64_SHA256});
  assert.equal(js.accelerated, false);
  const patch = Float32Array.from({length: 32}, (_, i) => f(Math.sin(i * 0.31)));
  const matrix = new Float64Array([1 + 2 ** -30, -0.25, 0.5, 0.75]);
  const grids = [];
  for (const kernel of [js, wasm]) {
    const out = new Float32Array(6 * 5 * 2);
    kernel.evaluateTransformedPatch(patch, 5, 4, matrix, 0.1, -0.3, out);
    const points = new Float32Array([17, 18, 0.25, 0.75, 19, 20]);
    kernel.mapPatchPoints(points, 1, patch, 2);
    assert.deepEqual([...points.slice(0, 2)], [17, 18]);
    assert.deepEqual([...points.slice(4)], [19, 20]);
    const affine = new Float32Array([0.123, -0.34, 0.81, 0.22]);
    kernel.affinePoints(affine, 2, matrix, 0.1, -0.2);
    grids.push([out, points, affine]);
  }
  for (let i = 0; i < grids[0].length; i++)
    assert.deepEqual(new Uint32Array(grids[1][i].buffer), new Uint32Array(grids[0][i].buffer));
  assert.throws(() => createEmoteMeshKernel({driverSha256: '3.9.8'}), /unsupported DLL build/);
});

test('clip clock keeps zero-delta replay and scan stop order per DLL image', () => {
  class FrameHost extends EmoteClipTime {
    constructor(sha, stopOnSeek = false) {
      super(sha);
      this.calls = [];
      this.motionParameter = null;
      this.parameters = [];
      this.stopOnSeek = stopOnSeek;
      this.playing = this.starting = this.replay = true;
      this.timeRunning = this.time = 5;
      this.lastTime = 10;
      this.loopTime = -1;
    }
    resetFrames() {
      this.calls.push(['seek', this.time]);
      if (this.stopOnSeek) this.alignStop = true;
    }
    scanForward() {
      this.calls.push(['forward', this.time]);
    }
    scanBackward() {
      this.calls.push(['backward', this.time]);
    }
    scanParameterNodes() {
      this.calls.push(['parameters', this.time]);
    }
  }
  const x86 = new FrameHost(),
    x64 = new FrameHost(EMOTEDRIVER_X64_SHA256);
  x86.advance(0);
  x64.advance(0);
  assert.deepEqual(x86.calls, [
    ['seek', 10],
    ['backward', 5],
  ]);
  assert.deepEqual(x64.calls, [
    ['seek', 0],
    ['forward', 5],
  ]);
  const held = new FrameHost(undefined, true);
  held.advance(0);
  assert.deepEqual(held.calls, [['seek', 10]]);
  assert.equal(held.time, 10, 'a held scan retains the tag position');
  assert.throws(() => new FrameHost('ff'), /unsupported DLL build/);
});

test('x64 clip phases preserve a queued whole-call hold and resume on the next pass', () => {
  const m = motion([]),
    n = motion([]),
    file = model({o: {m, n}});
  const clip = new EmoteMotionClip(new EmoteResource([file]));
  clip.selectObject('o');
  clip.setMotion('m');
  clip.progress(1);
  clip.rootX = 42;
  clip.rootDirty = true;
  clip.setMotion('n', 0x40);
  clip.advance(10);
  clip.evaluate();
  clip.dispatchEvents({
    action() {
      assert.fail('x64 action retired through x86 listener');
    },
  });
  assert.equal(clip.motionName, 'n');
  assert.equal(clip.timeRunning, 0);
  assert.equal(clip.rootDirty, true, 'the held pass must not evaluate the root');
  clip.advance(1);
  clip.evaluate();
  clip.dispatchEvents();
  assert.equal(clip.rootDirty, false);
  assert.equal(clip.rootX, 42);
  clip.advance(1);
  clip.evaluate();
  assert.equal(clip.timeRunning, 1);
  assert.equal(clip.isModified(), false);
  assert.deepEqual(clip.events, []);
  assert.throws(() => clip.nodes, /x86 node view/);
  assert.throws(() => clip.nodeIndex('root'), /x86 node lookup/);
});

test('clip interfaces copy borrowed root transforms before the caller reuses the record', () => {
  const m = motion([layer('point', [frame(0, 2, {mask: 2})], {type: 1, shape: 0})]);
  const file = model({o: {m}}),
    x86 = createEmoteClip(file, m);
  const x64 = new EmoteMotionClip(new EmoteResource([file]));
  x64.selectObject('o');
  x64.setMotion('m');
  for (const [clip, point] of [
    [x86, () => x86.shapePoint('point')],
    [x64, () => x64.layerPosition('point')],
  ]) {
    clip.rootVisible = true;
    const input = {x: 7.5, y: -4.25, angle: 0, scaleX: 1, scaleY: 1, mirror: false};
    clip.setRootTransform(input);
    input.x = 900;
    input.scaleX = 99;
    input.mirror = true;
    clip.advance(0);
    clip.evaluate();
    assert.deepEqual(point(), {x: 7.5, y: -4.25});
  }
});

test('x64 cached keyframes retain source identity across seeks and independent players', () => {
  const m = motion([
    layer('image', [
      frame(0, 2, {src: null, icon: '', bmParam: 0}),
      frame(5, 2, {src: '', icon: '', bmParam: 0}),
      frame(10, 2, {src: 'tex', icon: 'i', bmParam: 0}),
      frame(15, 2, {src: null, icon: '', bmParam: 0}),
      frame(20, 0),
    ]),
  ]);
  const file = model({o: {m}});
  const source = file.sources.get('tex');
  source.icons.get('i').resolution = 1;
  file.sources.set('', {...source, icons: new Map([['', source.icons.get('i')]])});
  const resource = new EmoteResource([file]);
  const players = [new EmoteMotionClip(resource), new EmoteMotionClip(resource)];
  for (const clip of players) {
    clip.selectObject('o');
    clip.setMotion('m');
    clip.rootVisible = true;
  }
  const at = (clip, time) => {
    clip.seekTo(time);
    clip.progress(0);
    return clip.drawList.map((item) => ({
      source: item.source,
      width: item.width,
      height: item.height,
      colors: [...item.colors],
    }));
  };
  assert.deepEqual(at(players[0], 0), [], 'a missing source must not resolve the empty key');
  const emptyKey = at(players[0], 5);
  assert.equal(emptyKey.length, 1);
  assert.equal(emptyKey[0].source, '');
  assert.equal(at(players[1], 10)[0].source, 'tex');
  assert.deepEqual(at(players[0], 5), emptyKey, 'another player must not alter cached frames');
  assert.equal(at(players[0], 10)[0].source, 'tex');
  assert.deepEqual(at(players[0], 5), emptyKey, 'backward seeks must retain earlier content');
  assert.deepEqual(at(players[0], 15), []);
});

test('source transitions preserve blank sizes, stale rectangles and current-file lookup', () => {
  const m = motion([
    layer('image', [
      frame(0, 2, {src: 'tex', icon: 'i', bmParam: 0}),
      frame(5, 2, {src: 'blank', icon: '4294967303:17:-0:-0', bmParam: 0}),
      frame(10, 2, {src: 'missing', icon: 'i', bmParam: 0}),
      frame(15, 2, {src: 'tex', icon: 'i', bmParam: 0}),
      frame(20, 0),
      frame(25, 2, {src: 'tex', icon: 'i', bmParam: 0}),
      frame(30, 0),
    ]),
  ]);
  const file = model({o: {m}});
  file.sources.get('tex').icons.get('i').resolution = 1;
  const x86 = createEmoteClip(file, m, {textureIndexOf: () => 7});
  x86.rootVisible = true;
  const at86 = (time) => {
    x86.seek(time);
    x86.advance(0);
    x86.evaluate();
    return x86.nodes[1];
  };
  assert.deepEqual(at86(0).sourceRect, [16, 8, 10, 10]);
  assert.equal(at86(0).textureIndex, 7);
  const blank = at86(5);
  assert.equal(blank.drawable, true);
  assert.equal(blank.hidden, true);
  assert.deepEqual(blank.sourceRect, [16, 8, 7, 17], 'x86 blank size uses signed integer stores');
  assert.equal(Object.is(blank.resolved.originX, -0), true);
  assert.equal(at86(10).drawable, false);
  assert.deepEqual(at86(10).sourceRect, [16, 8, 7, 17], 'a miss retains the old rectangle');
  assert.deepEqual(at86(15).sourceRect, [16, 8, 10, 10]);
  assert.equal(at86(20).visible, false, 'an empty frame hides the x86 layer');
  assert.deepEqual(at86(0).sourceRect, [16, 8, 10, 10]);
  assert.equal(at86(30).visible, true, 'the terminal sentinel retains the last content');

  const other = model({});
  other.sources.get('tex').icons.get('i').width = 99;
  file.sources = new Map([['unused', {icons: new Map()}], ...file.sources]);
  const x64 = new EmoteMotionClip(new EmoteResource([other, file]));
  x64.selectObject('o');
  x64.setMotion('m');
  x64.rootVisible = true;
  const at64 = (time) => {
    x64.seekTo(time);
    x64.progress(0);
    return x64.drawList;
  };
  const selected = at64(0)[0];
  assert.equal(selected.file, file, 'the current motion file wins a duplicate source');
  assert.equal(selected.texIndex, 1, 'the texture index belongs to the selected file');
  assert.equal(selected.width, 10);
  const blank64 = at64(5)[0];
  assert.equal(blank64.blank, true);
  assert.equal(blank64.width, f(4294967303), 'x64 blank size is not truncated to signed32');
  assert.equal(blank64.left, 16);
  assert.deepEqual(at64(10), []);
  assert.equal(at64(15)[0].file, file);
  assert.equal(at64(15)[0].width, 10);
  assert.deepEqual(at64(20), [], 'an empty frame hides the x64 layer');
  assert.equal(at64(0)[0].width, 10);
  assert.equal(at64(30)[0].width, 10, 'the terminal sentinel retains the last content');
});

test('layer projection retains the native intermediate float store for each image', () => {
  const point = layer('point', [frame(0, 2, {mask: 2, coord: [1, 1, 0]})], {
    type: 1,
    shape: 0,
  });
  const m = motion([
    layer('parent', [frame(0, 2, {mask: 2, coord: [-1, 0, 0], sx: 2 ** -24})], {
      type: 2,
      children: [point],
    }),
  ]);
  const file = model({o: {m}});
  const x86 = createEmoteClip(file, m);
  x86.rootVisible = true;
  x86.advance(0);
  x86.evaluate();
  assert.equal(x86.findNode('point').x, 0);
  const x64 = new EmoteMotionClip(new EmoteResource([file]));
  x64.selectObject('o');
  x64.setMotion('m');
  x64.rootVisible = true;
  x64.progress(0);
  assert.equal(x64.layerPosition('point').x, 2 ** -24);
});

test('mesh subdivision retains the native minimum axes for each image', () => {
  const bp = new Float32Array(32);
  for (let i = 0; i < 16; i++) {
    bp[i * 2] = f((i & 3) / 3);
    bp[i * 2 + 1] = f((i >> 2) / 3);
  }
  const m = motion([
    layer(
      'mesh',
      [frame(0, 2, {mask: 0x2000000, src: 'blank', icon: '100:50:0:0', mesh: {bp, cc: null}})],
      {
        meshTransform: 1,
        mesh: {syncChildMask: 8, division: 6, combine: false},
        children: [
          layer('img', [frame(0, 2, {mask: 3, src: 'tex', icon: 'i'})], {meshTransform: 0}),
        ],
      },
    ),
  ]);
  const file = model({o: {m}});
  const x86 = createEmoteClip(file, m);
  x86.rootVisible = true;
  run(x86, 1);
  const grid86 = x86.findNode('img').grid;
  assert.deepEqual([grid86.columns, grid86.rows, grid86.positions.length], [1, 1, 8]);
  const x64 = new EmoteMotionClip(new EmoteResource([file]));
  x64.selectObject('o');
  x64.setMotion('m');
  x64.rootVisible = true;
  x64.progress(0);
  const grid64 = x64.drawList.find((item) => !item.blank).grid;
  assert.deepEqual([grid64.cols, grid64.rows, grid64.points.length], [2, 2, 18]);
  assert.equal(x64.progress(0), undefined);
  assert.equal(x64.drawList.find((item) => !item.blank).grid, grid64, 'the clip retains its grid');
});

test('mesh synchronization keeps child versus parent projection axes and native errors', async () => {
  const {syncToParentMeshX86, syncToParentMeshX64} =
    await import('../dist/native/emotedriver/runtime/clip/vertices.js');
  const bp = new Float32Array(32);
  for (let i = 0; i < 16; i++) {
    bp[i * 2] = f(((i & 3) / 3) * 2);
    bp[i * 2 + 1] = f(i >> 2);
  }
  const cur = {ox: 0, oy: 0};
  const x86 = {coordinate: 0, inheritMask: 0, state: {x: 16, y: 32, z: 16}};
  const parent86 = {
    mesh: {local: bp},
    state: {visible: true},
    resolved: {drawable: true, rect: Int32Array.of(0, 0, 64, 64), originX: 0, originY: 0},
    meshSync: 1,
    meshKind: 1,
    cur,
  };
  syncToParentMeshX86(parent86, x86);
  assert.ok(Math.abs(x86.state.x - 32) < 1e-5);
  assert.ok(Math.abs(x86.state.y - 96) < 1e-5);
  assert.equal(x86.state.z, 16);
  parent86.meshSync = 3;
  x86.inheritMask = 0x10;
  assert.throws(() => syncToParentMeshX86(parent86, x86), /meshSyncChildMask angle\/zoom/);
  const parent64 = {
    mstate: {bp},
    visible: true,
    drawable: true,
    syncChildMask: 7,
    meshKind: 1,
    coordinate: 1,
    cur,
    originX: 0,
    originY: 0,
    w: 64,
    h: 64,
  };
  for (const wasm of [false, true]) {
    const kernel = createEmoteMeshKernel({driverSha256: EMOTEDRIVER_X64_SHA256, wasm});
    const x64 = {inheritMask: 0x70, x: 16, y: 32, z: 16, angle: 0, zoomX: 1, zoomY: 1};
    syncToParentMeshX64.call({resource: {kernel}}, parent64, x64);
    assert.ok(Math.abs(x64.x - 32) < 1e-5);
    assert.equal(x64.y, 32);
    assert.ok(Math.abs(x64.z - 48) < 1e-5);
    assert.ok(Math.abs(x64.angle) < 1e-3);
    assert.ok(x64.zoomX > 2 && x64.zoomY > 2, 'the x64 finite-difference zoom path runs');
  }
});

test('root velocity retains each image’s product store before translation', () => {
  const m = motion([]),
    file = model({o: {m}}),
    step = 1 - 2 ** -23,
    velocity = 1 + 2 ** -23;
  const x86 = createEmoteClip(file, m);
  x86.root.adjust.x = -1;
  x86.rootVelocity[0] = velocity;
  x86.advance(step);
  x86.evaluate();
  assert.equal(x86.root.state.x, -(2 ** -46));
  const x64 = new EmoteMotionClip(new EmoteResource([file]));
  x64.selectObject('o');
  x64.setMotion('m');
  x64.rootX = -1;
  x64.velocity[0] = velocity;
  x64.progress(step);
  assert.equal(x64.rootX, 0);
});

test('frame evaluation retains each image’s epsilon boundary', () => {
  const m = motion([
    layer(
      'point',
      [frame(0, 3, {mask: 2, coord: [0, 0, 0]}), frame(1, 2, {mask: 2, coord: [8, 0, 0]})],
      {
        type: 1,
        shape: 0,
      },
    ),
  ]);
  const file = model({o: {m}}),
    epsilon = 2 ** -23;
  const x86 = createEmoteClip(file, m);
  x86.advance(0);
  x86.evaluate();
  x86.advance(epsilon);
  x86.evaluate();
  assert.equal(x86.shapePoint('point').x, 0);
  const x64 = new EmoteMotionClip(new EmoteResource([file]));
  x64.selectObject('o');
  x64.setMotion('m');
  x64.progress(0);
  x64.progress(epsilon);
  assert.equal(x64.layerPosition('point').x, f(8 * epsilon));
});

test('nested child interfaces retain native flags, reverse loop endpoints and event retirement', () => {
  for (const scalar of [false, true]) {
    const calls = [];
    const current = new FrameSlot(scalar ? EMOTEDRIVER_X64_SHA256 : undefined);
    Object.assign(current, {empty: false, src: 'object', icon: 'motion'});
    current.motion.flags = 1;
    const state = new NodeState();
    const meshParent = {id: 7},
      maskParent = {id: 8};
    const node = {
      ...state,
      state,
      matrix: new Float32Array([1, 0, 0, 1]),
      m00: 1,
      m01: 0,
      m10: 0,
      m11: 1,
      cur: current,
      next: new FrameSlot(),
      param: null,
      parameter: null,
      framesDirty: true,
      coordinate: 0,
      colors: new Uint32Array([0x808080ff, 0x808080ff, 0x808080ff, 0x808080ff]),
      meshParent,
      maskNode: maskParent,
      stencilParent: maskParent,
      clipRect: new Float32Array([0, 0, 100, 100]),
    };
    const childRoot = {
      adjust: new NodeState(),
      matrix: new Float32Array(4),
      m00: 0,
      m01: 0,
      m10: 0,
      m11: 0,
      meshParent: null,
      maskNode: null,
      stencilParent: null,
      clipRect: null,
      copyMatrix(source) {
        for (const key of ['m00', 'm01', 'm10', 'm11']) this[key] = source[key];
      },
    };
    const event = {type: 0, layer: 'nested', label: 'action'};
    const child = {
      root: childRoot,
      playing: true,
      jumped: true,
      replay: false,
      loopTime: 0,
      lastTime: 6,
      motionName: '',
      objectName: '',
      playingName: '',
      color: 0,
      events: [],
      layerEvents: [],
      selectObject(name) {
        calls.push(['object', name]);
      },
      selectMotion(name, flags) {
        calls.push(['motion', name, flags]);
      },
      setMotion(name, flags) {
        calls.push(['motion', name, flags]);
      },
      seek(time) {
        calls.push(['seek', time]);
      },
      seekTo(time) {
        calls.push(['seek', time]);
      },
      advance(step) {
        calls.push(['advance', step]);
        this.events.push(event);
      },
      evaluate() {
        calls.push(['evaluate']);
      },
      progressSub(step) {
        calls.push(['progress', step]);
        this.layerEvents.push(event);
      },
      unload() {
        assert.fail('valid child must not unload');
      },
      reset() {
        assert.fail('valid child must not reset');
      },
    };
    node.child = child;
    node.sub = child;
    const parent = {
      time: 6,
      timeRunning: 6,
      step: -1,
      jumped: false,
      motionParameter: {flags: 2},
      motionNodes: [node],
      subNodes: [node],
      events: [],
      layerEvents: [],
    };
    const queue = scalar ? child.layerEvents : child.events;
    if (scalar) EmoteMotionClip.prototype.evaluateSubclips.call(parent);
    else EmoteClip.prototype.evaluateMotions.call(parent);
    assert.deepEqual(calls, [
      ['object', 'object'],
      ['motion', 'motion', scalar ? 3 : 1],
      ['seek', scalar ? 0 : 6],
      ...(scalar ? [['progress', -1]] : [['advance', -1], ['evaluate']]),
    ]);
    assert.equal(child.replay, true);
    assert.equal(childRoot.meshParent, meshParent);
    assert.equal(scalar ? childRoot.stencilParent : childRoot.maskNode, maskParent);
    if (!scalar) assert.equal(childRoot.clipRect, node.clipRect);
    assert.deepEqual(scalar ? parent.layerEvents : parent.events, [event]);
    assert.deepEqual(scalar ? child.layerEvents : child.events, []);
    assert.notEqual(scalar ? child.layerEvents : child.events, queue);
  }
});

test('scalar clip factories create independent clips with shared native file resources and exact motion ownership', async () => {
  const {emoteScalarClipFactory} = await import('../dist/native/emotedriver/runtime/clip.js');
  for (const wasm of [false, true]) {
    const firstMotion = motion([layer('image', [frame(0, 2, {src: 'tex', icon: 'i'})])]);
    const lastMotion = motion([layer('image', [frame(0, 2, {src: 'tex', icon: 'i'})])]);
    const first = model({object: {main: firstMotion}}),
      last = model({object: {main: lastMotion}});
    first.sources.get('tex').icons.get('i').width = 99;
    first.sources.get('tex').icons.get('i').resolution = 1;
    last.sources.get('tex').icons.get('i').resolution = 1;
    const files = [first, last],
      kernel = createEmoteMeshKernel({driverSha256: EMOTEDRIVER_X64_SHA256, wasm});
    const create = emoteScalarClipFactory(files, {kernel});
    files.pop(); // The native player snapshots its file-pointer array.
    const a = create(lastMotion),
      b = create(firstMotion),
      c = create(lastMotion);
    assert.ok(a instanceof EmoteMotionClip);
    assert.notEqual(a, c);
    assert.equal(a.resource, b.resource);
    assert.equal(a.resource, c.resource);
    assert.equal(a.resource.kernel, kernel);
    assert.deepEqual(a.resource.files, [first, last]);
    assert.equal(a.file, last);
    assert.equal(b.file, first);
    assert.equal(a.motion, lastMotion);
    assert.equal(b.motion, firstMotion);
    assert.notEqual(a.root.id, c.root.id);
    a.rootVisible = b.rootVisible = true;
    a.progress(0);
    b.progress(0);
    assert.equal(a.drawList[0].file, last);
    assert.equal(a.drawList[0].width, 10);
    assert.equal(b.drawList[0].file, first);
    assert.equal(b.drawList[0].width, 99);
    a.rootX = 42;
    assert.equal(c.rootX, 0);
    assert.throws(() => create(motion([])), /outside the player file group/);
  }
  assert.throws(() => emoteScalarClipFactory([]), /requires a motion file/);
});

test('scalar clip copies retain clocks, parameters, nested ownership and independent mesh bytes on both kernels', async () => {
  const {emoteScalarClipFactory} = await import('../dist/native/emotedriver/runtime/clip.js');
  const patch = Float32Array.from({length: 32}, (_, i) => (i & 1 ? i >> 3 : (i >> 1) & 3) / 3);
  const parameter = {
    id: 'face',
    discretization: false,
    rangeBegin: -1,
    rangeEnd: 1,
    division: 10,
    unread: {},
  };
  const child = motion(
    [
      layer('image', [frame(0, 2, {mask: 1, src: 'tex', icon: 'i'})]),
      layer(
        'point',
        [frame(0, 3, {mask: 2, coord: [0, 0, 0]}), frame(10, 2, {mask: 2, coord: [20, 0, 0]})],
        {type: 1, shape: 0, parameterize: 0},
      ),
    ],
    {parameters: [parameter]},
  );
  const main = motion(
    [
      layer('nested', [frame(0, 2, {mask: 1, src: 'child', icon: 'm'})], {type: 3}),
      layer(
        'mesh',
        [frame(0, 2, {mask: 0x2000001, src: 'tex', icon: 'i', mesh: {bp: patch, cc: null}})],
        {
          meshTransform: 1,
          mesh: {
            syncChildMask: 0,
            division: 4,
            combine: false,
            combinators: [
              {
                key: 'shape',
                rangeBegin: 0,
                rangeEnd: 1,
                meshCount: 2,
                neutralIndex: 0,
                raw: Float32Array.from({length: 64}, (_, i) => patch[i % 32] + (i >= 32 ? 0.1 : 0)),
              },
            ],
          },
        },
      ),
      layer('composite', [frame(0, 2, {mask: 1, src: 'blank', icon: '10:10:0:0'})], {
        type: 12,
        stencilType: 5,
        stencilCompositeMaskLayerList: ['mesh', 'nested'],
      }),
    ],
    {parameters: [parameter]},
  );
  const alternate = motion([
    layer('alternate', [frame(0, 2, {mask: 3, src: 'tex', icon: 'i', coord: [5, 7, 0]})]),
  ]);
  const file = model({object: {main, alternate}, child: {m: child}});
  file.sources.get('tex').icons.get('i').resolution = 1;
  const draw = (clip) =>
    clip.drawList.map((item) => ({
      file: item.file,
      source: item.source,
      colors: [...item.colors],
      z: item.z,
      grid: item.grid && {
        cols: item.grid.cols,
        rows: item.grid.rows,
        points: [...new Uint32Array(item.grid.points.buffer)],
      },
    }));
  for (const wasm of [false, true]) {
    const create = emoteScalarClipFactory([file], {
      kernel: createEmoteMeshKernel({driverSha256: EMOTEDRIVER_X64_SHA256, wasm}),
    });
    const source = create(main),
      copy = create(alternate);
    source.rootVisible = true;
    source.rootX = 12;
    source.setVariable('face', 0.5);
    source.setVariable('shape', 0.5);
    source.progress(0);
    source.progress(4.25);
    source.layerEvents.push({type: 0, layer: 'nested', label: 'copied'});
    copy.setVariable('stale', 5);
    copy.assignState(source);
    assert.equal(copy.motion, main);
    assert.equal(copy.timeRunning, source.timeRunning);
    assert.equal(copy.rootDirty, true);
    assert.deepEqual(draw(copy), draw(source));
    assert.notEqual(copy.layerEvents, source.layerEvents);
    assert.notEqual(copy.layerEvents[0], source.layerEvents[0]);
    assert.deepEqual(copy.layerEvents, source.layerEvents);
    assert.equal(copy.values.has('stale'), false);
    const a = source.layerNodes[1].sub,
      b = copy.layerNodes[1].sub;
    assert.notEqual(a, b);
    assert.equal(b.parentClip, copy);
    assert.equal(b.top, copy);
    assert.notEqual(source.parameters[0], copy.parameters[0]);
    assert.notEqual(a.parameters[0], b.parameters[0]);
    assert.equal(a.parameters[0].position, b.parameters[0].position);
    const originalMesh = source.layerNodes[2],
      copiedMesh = copy.layerNodes[2];
    assert.notEqual(originalMesh.grid.points.buffer, copiedMesh.grid.points.buffer);
    assert.notEqual(originalMesh.mstate.world.buffer, copiedMesh.mstate.world.buffer);
    assert.notEqual(originalMesh.mstate.bp.buffer, copiedMesh.mstate.bp.buffer);
    assert.deepEqual(copy.layerNodes[3].masks, [copiedMesh, copy.layerNodes[1]]);
    assert.notEqual(copy.layerNodes[3].masks, source.layerNodes[3].masks);
    for (const frames of [0, 1, 2.5, -0.5]) {
      source.progress(frames);
      copy.progress(frames);
      assert.deepEqual(draw(copy), draw(source));
    }
    copy.setVariable('face', -1);
    assert.equal(a.parameters[0].position, 7.5);
    assert.equal(b.parameters[0].position, 0);
    const oldPatch = originalMesh.mstate.bp.slice();
    copy.setVariable('shape', 1);
    copy.progress(0);
    assert.deepEqual(originalMesh.mstate.bp, oldPatch);
    assert.notDeepEqual(copiedMesh.mstate.bp, oldPatch);
    copiedMesh.grid.points[0] = 999;
    assert.notEqual(originalMesh.grid.points[0], 999);
    // A motion queued with the native hold bit survives a copy without ticking.
    source.setMotion('alternate', 0x60);
    copy.assignState(source);
    assert.equal(copy.motion, main);
    copy.progress(1);
    source.progress(1);
    assert.equal(copy.motion, alternate);
    assert.equal(copy.timeRunning, source.timeRunning);
    copy.assignState(copy);
    assert.throws(() => copy.assignState(createEmoteClip(file, main)), /not a scalar/);
    const foreign = new EmoteMotionClip(new EmoteResource([model({object: {main}})]));
    assert.throws(() => copy.assignState(foreign), /different E-mote file group/);
  }
});

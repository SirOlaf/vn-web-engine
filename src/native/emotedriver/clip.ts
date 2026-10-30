/**
 * The E-mote 3.9.8 motion clip (`MMotionPlayer`, 0x4e0 bytes; `emotedriver.dll` x64, SHA-256
 * `80d28bd088dda8e97c7c47a9c664e55159f70505b0f9fde3158d8ce2a3e1e051`) and the motion
 * resource it reads from (`EmoteResource`). Addresses are functions of that build.
 *
 * A clip plays one motion of one object. Its layer tree becomes a flat node list in pre-order
 * (node 0 is the root, whose overrides carry the player transform). Each node holds the two
 * keyframes around the current time. Progress (0x18003f720) runs, in order: the mesh
 * combinators, the time advance and keyframe stepping (0x18003f7f0), the per-node transform
 * evaluation (0x180043010, which also drives nested clips) and the draw list (0x180048c70).
 *
 * The draw list (`drawList`) is the renderer's input: one `EmoteDrawItem` per visible image
 * layer with its icon, colours, blend state, vertex grid and stencil links.
 *
 * Features absent from the supported data throw `EmoteUnsupportedError`: easing curves and
 * `cp` paths, motion tags, variable lists, streams, own-rotation motions (type 1), particle,
 * anchor, camera and clip-rect layers (types 4–11 except 10), ground correction, stencil alpha
 * tests and the directional nested-motion modes (`dt` 2–4).
 */

import type {
  EmoteFrame,
  EmoteFrameMotion,
  EmoteIcon,
  EmoteLayer,
  EmoteModel,
  EmoteMotion,
  EmoteParameter,
} from '../../formats/emote/model.js';
import type {PsbValue} from '../../formats/psb/psb.js';
import {
  DEFAULT_MESH,
  FLT_EPSILON,
  affineMap,
  bezierMap,
  lerpAngle,
  lerpColor,
  lerpMesh,
  lerpScalar,
  modulateColor,
  tessellate,
} from './mesh.js';
import {EmoteUnsupportedError, type EmoteClip} from './player.js';

const f32 = Math.fround;
const NEUTRAL = 0x808080ff;
const DEG = f32((Math.PI * 2) / 360);
const RAD_TO_DEG = f32(360 / f32(Math.PI * 2));
const SUPPORTED_TYPES: ReadonlySet<number> = new Set([0, 1, 2, 3, 12]);

// ---------------------------------------------------------------------------------------
// Resource

/** Icon lookup result (0x180031810). */
export interface EmoteIconRef {
  readonly file: EmoteModel;
  readonly source: string;
  /** Index of the source in its file: the device texture index. */
  readonly sourceIndex: number;
  readonly icon: EmoteIcon;
}

/**
 * The motion files of one player (`MEmoteResource`). Motions and icons are searched in the
 * clip's current file first, then in every file in load order.
 */
export class EmoteResource {
  /** +0x48: the coordinate-system depth factor applied to y; 0 for the D3D device. */
  readonly zFactor: number = 0;
  private nextNodeId = 1;

  constructor(readonly files: readonly EmoteModel[]) {}

  /** 0x180031530. */
  findMotion(
    object: string,
    motion: string,
    current: EmoteModel | null,
  ): {readonly file: EmoteModel; readonly motion: EmoteMotion} | null {
    const order = current ? [current, ...this.files.filter((f) => f !== current)] : this.files;
    for (const file of order) {
      const m = file.objects.get(object)?.motions.get(motion);
      if (m) return {file, motion: m};
    }
    return null;
  }

  /** 0x180031810. The data has no rename map (root keys besides `stereovisionProfile`). */
  findIcon(
    src: string | null,
    icon: string | null,
    current: EmoteModel | null,
  ): EmoteIconRef | null {
    if (src === null || icon === null) return null;
    const order = current ? [current, ...this.files.filter((f) => f !== current)] : this.files;
    for (const file of order) {
      const source = file.sources.get(src);
      const found = source?.icons.get(icon);
      if (found) {
        let sourceIndex = 0;
        for (const name of file.sources.keys()) {
          if (name === src) break;
          sourceIndex++;
        }
        return {file, source: src, sourceIndex, icon: found};
      }
    }
    return null;
  }

  /** The device node-id allocator (node +0x20). */
  allocateNodeId(): number {
    return this.nextNodeId++;
  }
}

// ---------------------------------------------------------------------------------------
// Keyframe states

interface FrameMotion {
  readonly flags: number;
  readonly dt: number;
  readonly dofst: number;
  readonly docmpl: boolean;
  readonly timeOffset: number;
}

const DEFAULT_MOTION: FrameMotion = Object.freeze({
  flags: 0,
  dt: 1,
  dofst: 0,
  docmpl: false,
  timeOffset: 0,
});

/** The keyframe state (0x118 bytes at node +0xe0 / +0x1f8), derived once per keyframe. */
interface FrameState {
  readonly index: number;
  readonly time: number;
  readonly ti: number;
  readonly mask: number;
  /** +0x10: frame type 0. */
  readonly noContent: boolean;
  /** +0x11: frame type 3 interpolates towards the next keyframe. */
  readonly interp: boolean;
  /** +0x12: the colour was a scalar. */
  readonly scalarColor: boolean;
  /** +0x13: no colour key. */
  readonly defaultColor: boolean;
  readonly src: string | null;
  readonly icon: string | null;
  readonly act: string | null;
  readonly bm: number;
  readonly bmParam: number;
  readonly ox: number;
  readonly oy: number;
  readonly color: readonly [number, number, number, number];
  readonly opa: number;
  readonly coord: readonly [number, number, number];
  readonly fx: boolean;
  readonly fy: boolean;
  readonly angle: number;
  readonly zx: number;
  readonly zy: number;
  readonly sx: number;
  readonly sy: number;
  /** Any easing index or `cp` path; interpolating such a frame is unsupported. */
  readonly eased: boolean;
  readonly bp: Float32Array | null;
  readonly motion: FrameMotion;
}

const EMPTY_STATE: Omit<FrameState, 'index' | 'time'> = Object.freeze({
  ti: 0,
  mask: 0,
  noContent: true,
  interp: false,
  scalarColor: true,
  defaultColor: true,
  src: null,
  icon: null,
  act: null,
  bm: 0x10,
  bmParam: 0,
  ox: 0,
  oy: 0,
  color: Object.freeze([NEUTRAL, NEUTRAL, NEUTRAL, NEUTRAL] as const),
  opa: 255,
  coord: Object.freeze([0, 0, 0] as const),
  fx: false,
  fy: false,
  angle: 0,
  zx: 1,
  zy: 1,
  sx: 0,
  sy: 0,
  eased: false,
  bp: null,
  motion: DEFAULT_MOTION,
});

/** A keyframe past the end of the list: never reached, never interpolated towards. */
function missingState(index: number): FrameState {
  return {...EMPTY_STATE, index, time: Infinity};
}

function frameMotion(m: EmoteFrameMotion | null): FrameMotion {
  if (!m) return DEFAULT_MOTION;
  if (m.dtgt !== null) throw new EmoteUnsupportedError('nested-motion direction target');
  return Object.freeze({
    flags: m.flags ?? 0,
    dt: m.dt ?? 1,
    dofst: m.dofst ?? 0,
    docmpl: m.docmpl ?? false,
    timeOffset: f32(m.timeOffset),
  });
}

const halve = (c: number) => (((c >>> 1) & 0x7f7f7f00) | (c & 0xff)) >>> 0;

/**
 * Frame content reader 0x18003b9f0 on top of the model's defaults. The top clip flag +0x18f
 * (always set by the player) rescales full-range colours: when `bm & 0xf0` is zero the
 * colour channels are halved and `bm` gains 0x10.
 */
function buildState(frame: EmoteFrame, index: number): FrameState {
  const time = f32(frame.time);
  if (frame.type === 0 || !frame.content) return {...EMPTY_STATE, index, time};
  if (frame.type !== 2 && frame.type !== 3)
    throw new EmoteUnsupportedError(`keyframe type ${frame.type}`);
  const c = frame.content;
  if (c.prt || c.camera || c.anchor || c.model || c.feedback)
    throw new EmoteUnsupportedError('particle, camera, anchor, model or feedback keyframes');
  if ('stc' in c.unread) throw new EmoteUnsupportedError('stencil alpha test');
  let bm = c.bm >>> 0;
  let color = c.color.map((v) => v >>> 0) as unknown as readonly [number, number, number, number];
  if ((bm & 0xf0) === 0) {
    bm = (bm & ~0xe0) | 0x10;
    color = color.map(halve) as unknown as typeof color;
  }
  const interp = frame.type === 3;
  return Object.freeze({
    index,
    time,
    ti: interp ? c.ti >>> 0 : 0,
    mask: c.mask,
    noContent: false,
    interp,
    scalarColor: !c.colorList,
    defaultColor: !c.colorKey,
    src: c.src,
    icon: c.icon,
    act: c.mask & 0x40000 ? c.act : null,
    bm,
    bmParam: f32(c.bmParam),
    ox: f32(c.ox),
    oy: f32(c.oy),
    color,
    opa: c.opa & 0xff,
    coord: [f32(c.coord[0]), f32(c.coord[1]), f32(c.coord[2])] as const,
    fx: c.fx,
    fy: c.fy,
    angle: f32(c.angle),
    zx: f32(c.zx),
    zy: f32(c.zy),
    sx: f32(c.sx),
    sy: f32(c.sy),
    eased:
      c.ccc !== null ||
      c.acc !== null ||
      c.zcc !== null ||
      c.scc !== null ||
      c.occ !== null ||
      c.cp !== null ||
      (c.mesh?.cc ?? null) !== null,
    bp: c.mesh?.bp ?? null,
    motion: frameMotion(c.motion),
  });
}

const stateCache = new WeakMap<EmoteLayer, readonly FrameState[]>();
function layerStates(layer: EmoteLayer): readonly FrameState[] {
  let s = stateCache.get(layer);
  if (!s) {
    s = Object.freeze(layer.frames.map(buildState));
    stateCache.set(layer, s);
  }
  return s;
}

// ---------------------------------------------------------------------------------------
// Nodes

/** Mesh state of a `meshTransform` 1 layer (0x88 bytes at payload +0x10). */
export interface EmoteMeshState {
  /** +0x20/+0x24: tessellation segments. */
  cols: number;
  rows: number;
  /** +0x30: the current patch (16 points), or null when the layer does not deform. */
  bp: Float32Array | null;
  /** +0x48: [w·m00, h·m01, w·m10, h·m11]. */
  readonly ms: Float32Array;
  /** +0x58: the patch in world coordinates (deformers only). */
  readonly world: Float32Array;
  /** +0x70: inverse of `ms`. */
  readonly inv: Float32Array;
  /** +0x80/+0x84: the negated translation. */
  negTx: number;
  negTy: number;
}

/** Vertex grid (node +0x3c0): (rows + 1)·(cols + 1) world points, rows outer. */
export interface EmoteVertexGrid {
  cols: number;
  rows: number;
  points: Float32Array;
}

/** Draw item (0xa8 bytes at node +0x3b8), the renderer's input. */
export interface EmoteDrawItem {
  /** +4: blank icons are skipped by the renderer. */
  blank: boolean;
  /** +8. */
  nodeId: number;
  /** +0xc: clip +0x250. */
  clipFlags: number;
  /** +0x10/+0x14: blend mode and parameter. */
  bm: number;
  bmParam: number;
  /** +0x18/+0x1c: clip grayscale mode (5 or 0) and level. */
  grayscaleMode: number;
  grayscaleLevel: number;
  /** +0x20/+0x24: clip +0x1d8/+0x1dc. */
  effectMode: number;
  effectLevel: number;
  /** +0x28. */
  z: number;
  /** +0x2c: texture (source) index in `file`. */
  texIndex: number;
  file: EmoteModel | null;
  source: string | null;
  /** +0x30: icon attributes; bit 1 opaque, bit 2 uniform per-vertex colour. */
  attr: number;
  /** +0x34..+0x40: icon rectangle in texels. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** +0x44. */
  opa: number;
  /** +0x48..+0x54: corner colours (alpha in the low byte, 0x80 = 1.0 for colour bytes). */
  readonly colors: Uint32Array;
  /** +0x58. */
  objTriPriority: number;
  /** +0x5c. */
  coordinate: number;
  /** +0x68: the mesh state when the layer deforms itself. */
  mesh: EmoteMeshState | null;
  /** +0x70. */
  grid: EmoteVertexGrid | null;
  /** +0x78. */
  stencilType: number;
  /** +0x7c..+0x84. */
  alphaTest: boolean;
  alphaScale: number;
  alphaOffset: number;
  /** +0x88: the stencil parent's item. */
  stencilParent: EmoteDrawItem | null;
  /** +0x90: composite list (stencil masks and nested-clip items). */
  readonly composite: EmoteDrawItem[];
}

function newDrawItem(): EmoteDrawItem {
  return {
    blank: false,
    nodeId: 0,
    clipFlags: 0,
    bm: 0,
    bmParam: 0,
    grayscaleMode: 0,
    grayscaleLevel: 0,
    effectMode: 0,
    effectLevel: 1,
    z: 0,
    texIndex: 0,
    file: null,
    source: null,
    attr: 0,
    left: 0,
    top: 0,
    width: 0,
    height: 0,
    opa: 255,
    colors: new Uint32Array(4),
    objTriPriority: 0,
    coordinate: 0,
    mesh: null,
    grid: null,
    stencilType: 0,
    alphaTest: false,
    alphaScale: 1,
    alphaOffset: 0,
    stencilParent: null,
    composite: [],
  };
}

/** Parameter (0x38 bytes at clip +0x418). */
class Param {
  /** +0x30: the parameter-driven time. */
  value = 0;
  /** +0x34. */
  flags = 0;
  constructor(readonly def: EmoteParameter) {}

  /** 0x180036a90. */
  apply(v: number): void {
    const {rangeBegin: b, rangeEnd: e, division: d} = this.def;
    this.flags = 0;
    if (b !== e && d > 0) {
      if (this.def.discretization) v = Math.trunc(v);
      const lo = Math.min(b, e),
        hi = Math.max(b, e);
      const c = v <= lo ? lo : v;
      this.value = f32((((hi <= c ? hi : c) - b) * d) / (e - b));
    } else this.value = 0;
  }
}

/** Layer node (0x3d0 bytes). */
class Node {
  readonly layer: EmoteLayer | null;
  readonly index: number;
  readonly parent: number;
  readonly id: number;
  readonly type: number;
  readonly inherit: number;
  coordinate: number;
  transformOrder: readonly number[];
  readonly stencilType: number;
  readonly meshTransform: number;
  readonly meshCombine: boolean;
  readonly syncChildMask: number;
  readonly division: number;
  readonly hasCombinator: boolean;
  /** Payload +8: a combinator owns the patch. */
  combinatorOwned = false;
  readonly mstate: EmoteMeshState | null;
  readonly param: Param | null;
  readonly states: readonly FrameState[];
  a: FrameState;
  b: FrameState;
  /** +0x34, +0x35, +0x40. */
  dirty = false;
  modified = false;
  prevE = 0;
  /** +0x38/+0x39 colour flags, +0x68 colours. */
  scalarColor = true;
  defaultColor = true;
  readonly colors = new Uint32Array([NEUTRAL, NEUTRAL, NEUTRAL, NEUTRAL]);
  /** +0x78..+0x84. */
  m00 = 1;
  m01 = 0;
  m10 = 0;
  m11 = 1;
  /** +0x88 previous position / velocity, +0x94 anchor. */
  readonly vel = new Float32Array(3);
  readonly anchor = new Float32Array(3);
  /** Source block +0xa0..+0xd8 and the resolved keys. */
  found = false;
  blank = false;
  texIndex = 0;
  attr = 0;
  left = 0;
  top = 0;
  w = 0;
  h = 0;
  originX = 0;
  originY = 0;
  resolution = 1;
  file: EmoteModel | null = null;
  source: string | null = null;
  private srcKey: string | null | undefined = undefined;
  private iconKey: string | null | undefined = undefined;
  /** Info block +0x314..+0x33c. */
  changed = true;
  drawVisible = true;
  visible = true;
  fx = false;
  fy = false;
  x = 0;
  y = 0;
  z = 0;
  angle = 0;
  zx = 1;
  zy = 1;
  sx = 0;
  sy = 0;
  opa = 255;
  /** Overrides +0x340..+0x368. */
  ovDirty = true;
  ovDrawVisible = true;
  ovVisible = true;
  ovFx = false;
  ovFy = false;
  ovX = 0;
  ovY = 0;
  ovZ = 0;
  ovAngle = 0;
  ovZx = 1;
  ovZy = 1;
  ovSx = 0;
  ovSy = 0;
  ovOpa = 255;
  /** +0x388..+0x398. */
  isDeformer = false;
  breaksChain = false;
  meshParent: Node | null = null;
  meshParentId = 0;
  /** +0x39c..+0x3c0. */
  maskLayer = false;
  stencilVisible = false;
  stencilParent: Node | null = null;
  drawn = false;
  readonly item: EmoteDrawItem | null;
  grid: EmoteVertexGrid | null = null;
  /** Type 3 payload. */
  sub: EmoteMotionClip | null = null;
  /** Type 12 payload: the composite mask nodes. */
  masks: Node[] = [];
  /** Type 1 payload (shape info). */
  readonly shapeInfo: number[] | null;

  constructor(
    clip: EmoteMotionClip,
    layer: EmoteLayer | null,
    index: number,
    parent: number,
    param: Param | null,
  ) {
    this.layer = layer;
    this.index = index;
    this.parent = parent;
    this.id = clip.resource.allocateNodeId();
    this.param = param;
    if (!layer) {
      this.type = 0;
      this.inherit = 0;
      this.coordinate = 0;
      this.transformOrder = [0, 3, 2, 1];
      this.stencilType = 0;
      this.meshTransform = 0;
      this.meshCombine = false;
      this.syncChildMask = 0;
      this.division = 0;
      this.hasCombinator = false;
      this.mstate = null;
      this.states = [];
      this.ovVisible = true;
      this.item = null;
      this.shapeInfo = null;
    } else {
      if (!SUPPORTED_TYPES.has(layer.type))
        throw new EmoteUnsupportedError(`layer type ${layer.type}`);
      if (layer.groundCorrection) throw new EmoteUnsupportedError('ground correction');
      this.type = layer.type;
      this.inherit = layer.inheritMask >>> 0;
      this.coordinate = layer.coordinate;
      this.transformOrder = layer.transformOrder;
      this.stencilType = layer.stencilType;
      this.meshTransform = layer.meshTransform;
      const mesh = layer.meshTransform !== 0 ? layer.mesh : null;
      this.meshCombine = mesh?.combine ?? false;
      this.syncChildMask = mesh?.syncChildMask ?? 0;
      this.division = mesh?.division ?? 0;
      this.hasCombinator = mesh?.combinators != null;
      this.mstate =
        layer.meshTransform === 1
          ? {
              cols: 1,
              rows: 1,
              bp: null,
              ms: new Float32Array(4),
              world: new Float32Array(32),
              inv: new Float32Array(4),
              negTx: 0,
              negTy: 0,
            }
          : null;
      this.states = layerStates(layer);
      this.item = (0x1409 >> layer.type) & 1 ? newDrawItem() : null;
      this.shapeInfo = layer.type === 1 ? [0, 0, 0, 0, 0, 0, 0, 0, 0] : null;
    }
    this.a = this.stateAt(0);
    this.b = this.stateAt(1);
  }

  stateAt(i: number): FrameState {
    return i < this.states.length ? this.states[i]! : missingState(i);
  }

  get count(): number {
    return this.states.length;
  }

  /** 0x18003dc40. */
  resolveSource(clip: EmoteMotionClip, s: FrameState): void {
    if (s.noContent) return;
    if (this.srcKey === s.src && this.iconKey === s.icon) return;
    this.srcKey = s.src;
    this.iconKey = s.icon;
    if (s.src === 'blank') {
      this.found = true;
      this.blank = true;
      this.attr = 0;
      const p = (s.icon ?? '').split(':');
      this.w = Number.parseInt(p[0] ?? '', 10) || 0;
      this.h = Number.parseInt(p[1] ?? '', 10) || 0;
      this.originX = f32(Number.parseFloat(p[2] ?? '') || 0);
      this.originY = f32(Number.parseFloat(p[3] ?? '') || 0);
      this.resolution = 1;
    } else {
      const r = clip.resource.findIcon(s.src, s.icon, clip.file);
      this.found = r !== null;
      this.blank = false;
      if (r) {
        const ic = r.icon;
        this.file = r.file;
        this.source = r.source;
        this.texIndex = r.sourceIndex;
        this.attr = ic.attr;
        this.left = ic.left ?? 0;
        this.top = ic.top ?? 0;
        this.w = ic.width | 0;
        this.h = ic.height | 0;
        this.originX = f32(ic.originX);
        this.originY = f32(ic.originY);
        this.resolution = f32(ic.resolution);
      }
    }
    if (this.meshTransform === 1 && this.mstate) {
      const n = Math.trunc(f32(this.division * clip.top.meshDivisionRatio));
      const sum = (this.w + this.h) >>> 0;
      let c0 = sum ? Math.floor(((this.w * n) >>> 0) / sum) : 0;
      let r0 = (n - c0) >>> 0;
      if (c0 === 0) c0 = 1;
      if (r0 === 0) r0 = 1;
      this.mstate.cols = c0 + 1;
      this.mstate.rows = r0 + 1;
    }
  }

  /** Overrides into the info block (root, 0x180043010 step 3). */
  copyOverridesToInfo(): void {
    this.changed = this.ovDirty;
    this.drawVisible = this.ovDrawVisible;
    this.visible = this.ovVisible;
    this.fx = this.ovFx;
    this.fy = this.ovFy;
    this.x = this.ovX;
    this.y = this.ovY;
    this.z = this.ovZ;
    this.angle = this.ovAngle;
    this.zx = this.ovZx;
    this.zy = this.ovZy;
    this.sx = this.ovSx;
    this.sy = this.ovSy;
    this.opa = this.ovOpa;
  }

  /** 0x180041de0: the local matrix from the info block in `transformOrder`. */
  computeMatrix(): void {
    let m00 = 1,
      m01 = 0,
      m10 = 0,
      m11 = 1;
    for (const step of this.transformOrder) {
      switch (step) {
        case 0:
          if (this.fx) {
            m00 = -m00;
            m01 = -m01;
          }
          if (this.fy) {
            m10 = -m10;
            m11 = -m11;
          }
          break;
        case 1: {
          if (this.angle !== 0) {
            const r = f32(this.angle * DEG);
            const s = f32(Math.sin(r)),
              c = f32(Math.cos(r));
            const a00 = f32(m00 * c - m10 * s),
              a10 = f32(m00 * s + m10 * c),
              a01 = f32(m01 * c - m11 * s),
              a11 = f32(m01 * s + m11 * c);
            m00 = a00;
            m10 = a10;
            m01 = a01;
            m11 = a11;
          }
          break;
        }
        case 2:
          if (this.zx !== 1 || this.zy !== 1) {
            m00 = f32(m00 * this.zx);
            m01 = f32(m01 * this.zx);
            m10 = f32(m10 * this.zy);
            m11 = f32(m11 * this.zy);
          }
          break;
        case 3:
          if (this.sx !== 0 || this.sy !== 0) {
            const a00 = f32(m00 + this.sx * m10),
              a01 = f32(m01 + this.sx * m11),
              a10 = f32(m10 + this.sy * m00),
              a11 = f32(m11 + this.sy * m01);
            m00 = a00;
            m01 = a01;
            m10 = a10;
            m11 = a11;
          }
          break;
      }
    }
    this.m00 = m00;
    this.m01 = m01;
    this.m10 = m10;
    this.m11 = m11;
  }

  /** this.M = L·this.M. */
  leftMultiply(l: Node): void {
    const a = this.m00,
      b = this.m01,
      c = this.m10,
      d = this.m11;
    this.m00 = f32(a * l.m00 + c * l.m01);
    this.m01 = f32(l.m00 * b + l.m01 * d);
    this.m10 = f32(a * l.m10 + c * l.m11);
    this.m11 = f32(l.m10 * b + l.m11 * d);
  }

  copyMatrix(src: Node): void {
    this.m00 = src.m00;
    this.m01 = src.m01;
    this.m10 = src.m10;
    this.m11 = src.m11;
  }
}

// ---------------------------------------------------------------------------------------
// Mesh combinators (registry at top +0x4d8, 0x180058c50 / 0x180059e80)

interface Combinator {
  readonly def: {readonly raw: Float32Array; readonly neutralIndex: number};
  cur: Float32Array;
  prev: Float32Array;
  changed: boolean;
  neutral: boolean;
}

interface CombinatorVariable {
  readonly key: string;
  readonly meshType: number;
  readonly rangeBegin: number;
  readonly rangeEnd: number;
  readonly meshCount: number;
  f: number;
  readonly members: Combinator[];
}

interface CombinatorLayer {
  readonly node: Node;
  readonly meshType: number;
  readonly combinators: Combinator[];
  readonly sum: Float32Array;
}

function combinatorF(v: CombinatorVariable, value: number): number {
  let x = f32((value - v.rangeBegin) / (v.rangeEnd - v.rangeBegin));
  if (x >= 1) x = 1;
  if (x <= 0) x = 0;
  return f32(x * (v.meshCount - 1));
}

function evalCombinator(c: Combinator, f: number): void {
  const i = Math.trunc(f);
  const frac = f32(f - i);
  const raw = c.def.raw;
  const o0 = i * 32,
    o1 = i * 32 + 32;
  if (Math.abs(frac) >= FLT_EPSILON) {
    const ie = f32(1 - frac);
    for (let k = 0; k < 32; k++) c.cur[k] = raw[o0 + k]! * ie + raw[o1 + k]! * frac;
  } else c.cur.set(raw.subarray(o0, o0 + 32));
  c.neutral = c.def.neutralIndex === i && Math.abs(frac) < FLT_EPSILON;
}

class CombinatorRegistry {
  private readonly variables = new Map<string, CombinatorVariable[]>();
  private readonly layers: CombinatorLayer[] = [];

  constructor(private readonly top: EmoteMotionClip) {}

  /** 0x180058c50. */
  register(node: Node): void {
    const defs = node.layer?.mesh?.combinators;
    if (!defs || defs.length === 0) return;
    const layer: CombinatorLayer = {
      node,
      meshType: node.meshTransform,
      combinators: [],
      sum: new Float32Array(32),
    };
    for (const d of defs) {
      const c: Combinator = {
        def: d,
        cur: new Float32Array(32),
        prev: new Float32Array(32),
        changed: false,
        neutral: false,
      };
      layer.combinators.push(c);
      // 0x180059870: share an identical variable entry or create one.
      let list = this.variables.get(d.key);
      if (!list) this.variables.set(d.key, (list = []));
      let v = list.find(
        (e) =>
          e.meshType === node.meshTransform &&
          e.rangeBegin === d.rangeBegin &&
          e.rangeEnd === d.rangeEnd &&
          e.meshCount === d.meshCount,
      );
      if (!v) {
        v = {
          key: d.key,
          meshType: node.meshTransform,
          rangeBegin: f32(d.rangeBegin),
          rangeEnd: f32(d.rangeEnd),
          meshCount: d.meshCount,
          f: 0,
          members: [],
        };
        v.f = combinatorF(v, this.top.values.get(d.key) ?? 0);
        list.push(v);
      }
      v.members.push(c);
      evalCombinator(c, v.f);
    }
    this.fullSum(layer);
    this.applyLayer(layer);
    this.layers.push(layer);
  }

  clear(): void {
    this.variables.clear();
    this.layers.length = 0;
  }

  unregisterClip(clip: EmoteMotionClip): void {
    const gone = new Set<Combinator>();
    for (let i = this.layers.length - 1; i >= 0; i--) {
      const l = this.layers[i]!;
      if (clip.nodes.includes(l.node)) {
        for (const c of l.combinators) gone.add(c);
        this.layers.splice(i, 1);
      }
    }
    for (const [key, list] of this.variables) {
      for (let i = list.length - 1; i >= 0; i--) {
        const v = list[i]!;
        for (let j = v.members.length - 1; j >= 0; j--)
          if (gone.has(v.members[j]!)) v.members.splice(j, 1);
        if (v.members.length === 0) list.splice(i, 1);
      }
      if (list.length === 0) this.variables.delete(key);
    }
  }

  get empty(): boolean {
    return this.layers.length === 0;
  }

  /** 0x180059e80. */
  update(): void {
    for (const list of this.variables.values()) {
      for (const v of list) {
        const f = combinatorF(v, this.top.values.get(v.key) ?? 0);
        if (v.f === f) continue;
        v.f = f;
        for (const c of v.members) {
          const t = c.prev;
          c.prev = c.cur;
          c.cur = t;
          evalCombinator(c, f);
          c.changed = true;
        }
      }
    }
    for (const l of this.layers) {
      let n = 0;
      for (const c of l.combinators) if (c.changed) n++;
      if (n === 0) continue;
      if (n < l.combinators.length >>> 1) {
        for (const c of l.combinators) {
          if (!c.changed) continue;
          for (let k = 0; k < 32; k++) l.sum[k] = l.sum[k]! + c.cur[k]! - c.prev[k]!;
          c.changed = false;
        }
      } else this.fullSum(l);
      this.applyLayer(l);
    }
  }

  private fullSum(l: CombinatorLayer): void {
    l.sum.set(l.combinators[0]!.cur);
    l.combinators[0]!.changed = false;
    for (let j = 1; j < l.combinators.length; j++) {
      const c = l.combinators[j]!;
      for (let k = 0; k < 32; k++) l.sum[k]! += c.cur[k]!;
      c.changed = false;
    }
  }

  private applyLayer(l: CombinatorLayer): void {
    const allNeutral = l.combinators.every((c) => c.neutral);
    if (l.node.meshTransform === l.meshType && l.meshType === 1 && l.node.mstate) {
      l.node.dirty = true;
      l.node.combinatorOwned = true;
      l.node.mstate.bp = allNeutral ? null : Float32Array.from(l.sum);
    }
  }
}

// ---------------------------------------------------------------------------------------
// Clip

interface PriorityFrame {
  readonly time: number;
  readonly order: readonly number[];
}

function readPriority(list: readonly PsbValue[]): PriorityFrame[] {
  return list.map((v) => {
    const o = v as {time?: PsbValue; content?: PsbValue};
    if (typeof o !== 'object' || o === null || typeof o.time !== 'number')
      throw new EmoteUnsupportedError('priority frame without time');
    const content = Array.isArray(o.content) ? o.content : [];
    return {time: f32(o.time), order: content.map((n) => Number(n) | 0)};
  });
}

/** Nested-motion event (+0x2e0): an `act` label reached by a keyframe. */
export interface EmoteClipEvent {
  readonly layer: string;
  readonly action: string;
}

export class EmoteMotionClip implements EmoteClip {
  readonly resource: EmoteResource;
  /** +0x18 top clip, +0x20 parent clip. */
  readonly top: EmoteMotionClip;
  readonly parentClip: EmoteMotionClip | null;
  /** +0x28 object (motion lookup), +0x48 playing object, +0x88/+0xa8 motion names. */
  objectName = '';
  private playingObject = '';
  motionName = '';
  playingName = '';
  /** +0x68 pending object, +0xc8 pending motion, +0xe8 queued motion with flags +0x108. */
  private pendingObject = '';
  private pendingMotion = '';
  private queued = '';
  private queuedFlags = 0;
  /** +0x148/+0x150: the file of the current motion. */
  file: EmoteModel | null = null;
  motion: EmoteMotion | null = null;
  /** +0x188 playing, +0x189 jumped, +0x18a, +0x18b seek pending, +0x18c seek wrap, +0x18d. */
  playing = false;
  private jumped = true;
  private f18a = true;
  private seekPending = false;
  private seekWrap = false;
  private forceCalc = false;
  /** +0x158/+0x15c. */
  readonly ownRotation = false;
  ownRotationAngle = 0;
  /** +0x190 time, +0x194 clamped time, +0x198 speed, +0x19c frame delta. */
  time = 0;
  clamped = 0;
  speed = 1;
  delta = 0;
  /** +0x1a0 root velocity, +0x1ac decay. */
  readonly velocity = new Float32Array(3);
  decay = 1;
  /** +0x1c0/+0x1c4 grayscale, +0x1c8 colour, +0x1d8/+0x1dc. */
  grayscaleMode = 0;
  grayscaleLevel = 0;
  color = NEUTRAL;
  effectMode = 0;
  effectLevel = 1;
  /** +0x200/+0x204. */
  loopTime = 0;
  lastTime = 0;
  /** +0x208.. priority state; +0x218 order list. */
  private priority: PriorityFrame[] = [];
  private prIndex = 0;
  private order: readonly number[] = [];
  /** +0x250. */
  clipFlags = 0;
  /** +0x274 sync, +0x275 align (tags only). */
  private readonly sync = false;
  private readonly align = false;
  /** +0x2e0. */
  events: EmoteClipEvent[] = [];
  /** +0x410 motion-independent inheritance, +0x411 the parent writes the root matrix. */
  independentInherit = false;
  private readonly rootMatrixFromParent: boolean;
  /** +0x418 parameters, +0x430 the registered parameters by id, +0x440 values. */
  private params: Param[] = [];
  private readonly paramIndex = new Map<string, Param[]>();
  readonly values = new Map<string, number>();
  private parameterized: Param | null = null;
  /** +0x488 (top). */
  meshDivisionRatio = 1;
  /** Device +0x88. */
  smoothing = false;
  /** +0x4b0 (top): the draw list of the last progress. */
  readonly drawList: EmoteDrawItem[] = [];
  /** +0x4d8 (top). */
  private combinators: CombinatorRegistry | null = null;
  /** +0x1e8 nodes; +0x3c4 type bit set; type lists. */
  nodes: Node[] = [];
  private typeMask = 0;
  private subNodes: Node[] = [];
  private shapeNodes: Node[] = [];
  private stencilNodes: Node[] = [];
  private layerIndexMap: ReadonlyMap<string, number> | null = null;

  constructor(resource: EmoteResource, parent: EmoteMotionClip | null = null) {
    this.resource = resource;
    this.parentClip = parent;
    this.top = parent ? parent.top : this;
    this.rootMatrixFromParent = parent !== null;
    this.nodes = [new Node(this, null, 0, 0, null)];
  }

  private get root(): Node {
    return this.nodes[0]!;
  }

  // EmoteClip --------------------------------------------------------------------------

  get rootX(): number {
    return this.root.ovX;
  }
  set rootX(v: number) {
    this.root.ovX = f32(v);
  }
  get rootY(): number {
    return this.root.ovY;
  }
  set rootY(v: number) {
    this.root.ovY = f32(v);
  }
  get rootZoomX(): number {
    return this.root.ovZx;
  }
  set rootZoomX(v: number) {
    this.root.ovZx = f32(v);
  }
  get rootZoomY(): number {
    return this.root.ovZy;
  }
  set rootZoomY(v: number) {
    this.root.ovZy = f32(v);
  }
  get rootAngle(): number {
    return this.root.ovAngle;
  }
  set rootAngle(v: number) {
    this.root.ovAngle = f32(v);
  }
  get rootDirty(): boolean {
    return this.root.ovDirty;
  }
  set rootDirty(v: boolean) {
    this.root.ovDirty = v;
  }
  get visible(): boolean {
    return this.root.ovVisible;
  }
  set visible(v: boolean) {
    this.root.ovVisible = v;
  }

  setOwnRotation(_degrees: number): void {
    throw new EmoteUnsupportedError('own-rotation motions');
  }

  /** 0x180038a10: applied to this clip and every nested clip. */
  setGrayscale(mode: number, level: number): void {
    this.grayscaleMode = mode;
    this.grayscaleLevel = level;
    for (const n of this.subNodes) n.sub?.setGrayscale(mode, level);
  }

  get modified(): boolean {
    return this.nodes.some((n) => n.modified);
  }

  /** 0x18000e6d0 clip part. */
  layerPosition(name: string): readonly [number, number] | null {
    const i = this.layerIndexMap?.get(name);
    if (i === undefined) return null;
    const n = this.nodes[i + 1];
    if (!n || n.type !== 1 || !n.shapeInfo || n.layer?.shape !== 0) return null;
    return [n.shapeInfo[1]!, n.shapeInfo[2]!];
  }

  /** 0x180037330. Labels with a layer path (`a::b`, `a/b`) address nested clips. */
  setVariable(label: string, value: number): void {
    if (label.includes('::') || label.includes('/'))
      throw new EmoteUnsupportedError('layer-scoped variable labels');
    value = f32(value);
    this.values.set(label, value);
    for (const p of this.paramIndex.get(label) ?? []) p.apply(value);
  }

  /** 0x180037cf0. */
  getVariable(label: string): number {
    return this.values.get(label) ?? 0;
  }

  // Object and motion ------------------------------------------------------------------

  /**
   * 0x180038bc0: selects the object; a change clears the motion names and stops playback.
   * Flag 0x10 compares and sets the lookup object only.
   */
  setObject(name: string, flags = 0): void {
    if ((flags & 0x10 ? this.objectName : this.playingObject) === name) return;
    this.objectName = name;
    if (!(flags & 0x10)) this.playingObject = name;
    this.motionName = '';
    this.playingName = '';
    this.playing = false;
  }

  /** The inlined object selection of the player (0x1800090b0) and nested clips (0x180045c50). */
  selectObject(name: string): void {
    this.setObject(name);
    if (this.pendingObject) {
      const o = this.pendingObject;
      this.pendingObject = '';
      this.setObject(o, 0x10);
    }
  }

  /** 0x180038cb0. */
  setMotion(name: string, flags = 0): void {
    if (flags & 0x60) {
      this.queued = name;
      this.queuedFlags = flags;
      return;
    }
    if (flags & 0x10 && this.objectName === '') {
      this.pendingMotion = name;
      return;
    }
    this.selectMotion(name, flags);
    if (this.pendingMotion) {
      const m = this.pendingMotion;
      this.pendingMotion = '';
      this.selectMotion(m, 0x10);
    }
  }

  /** 0x180038d90. */
  private selectMotion(name: string, flags: number): void {
    if (!(flags & 5) && name === (flags & 0x10 ? this.motionName : this.playingName)) return;
    if (!(flags & 1) && this.playing && flags & 4) return;
    if (flags & 8) throw new EmoteUnsupportedError('motion blending (setMotion flag 8)');
    const found = this.resource.findMotion(this.objectName, name, this.file);
    if (!found) {
      this.file = null;
      this.playing = false;
      return;
    }
    this.motionName = name;
    if (!(flags & 0x10)) this.playingName = name;
    this.file = found.file;
    const type = found.motion.unread['type'];
    if (type !== undefined && type !== 0)
      throw new EmoteUnsupportedError(`motion type ${String(type)}`);
    this.load(found.motion, flags);
  }

  /** 0x180039360. */
  private load(motion: EmoteMotion, flags: number): void {
    if (motion.tag.length) throw new EmoteUnsupportedError('motion tags');
    const vars = motion.unread['variable'];
    if (Array.isArray(vars) && vars.length)
      throw new EmoteUnsupportedError('motion variable lists');
    this.motion = motion;
    this.priority = readPriority(motion.priority);
    this.prIndex = 0;
    this.order = this.priority[0]?.order ?? [];
    this.loopTime = f32(motion.loopTime);
    this.lastTime = f32(motion.lastTime);
    this.unregisterParams();
    this.params = motion.parameters.map((d) => {
      const p = new Param(d);
      p.apply(this.inheritedValue(d.id));
      return p;
    });
    this.registerParams();
    this.parameterized =
      motion.parameterize !== null ? (this.params[motion.parameterize] ?? null) : null;
    this.playing = true;
    this.setup(motion);
    if (!(flags & 2)) this.seekTo(0);
  }

  /** 0x180038110: the value of `id` in this clip or the nearest ancestor. */
  private inheritedValue(id: string): number {
    for (let c: EmoteMotionClip | null = this; c; c = c.parentClip) {
      const v = c.values.get(id);
      if (v !== undefined) return v;
    }
    return 0;
  }

  /** 0x180036840: registers the parameters here and in every ancestor. */
  private registerParams(): void {
    for (const p of this.params) {
      for (let c: EmoteMotionClip | null = this; c; c = c.parentClip) {
        let list = c.paramIndex.get(p.def.id);
        if (!list) c.paramIndex.set(p.def.id, (list = []));
        list.push(p);
      }
    }
  }

  /** 0x180036230. */
  private unregisterParams(): void {
    for (const p of this.params) {
      for (let c: EmoteMotionClip | null = this; c; c = c.parentClip) {
        const list = c.paramIndex.get(p.def.id);
        if (!list) continue;
        const i = list.indexOf(p);
        if (i >= 0) list.splice(i, 1);
        if (list.length === 0) c.paramIndex.delete(p.def.id);
      }
    }
    this.params = [];
  }

  /** 0x180039880. */
  seekTo(t: number): void {
    if (!this.file) return;
    this.time = f32(Math.max(t, 0));
    this.clamped = Math.min(this.time, this.lastTime);
    this.jumped = true;
    this.seekPending = true;
  }

  /** 0x18003e530: drops every node but the root and the nested clips. */
  private reset(): void {
    this.top.combinators?.unregisterClip(this);
    for (const n of this.subNodes) n.sub?.destroy();
    this.nodes.length = 1;
    this.subNodes = [];
    this.shapeNodes = [];
    this.stencilNodes = [];
    this.typeMask = 0;
  }

  private destroy(): void {
    this.reset();
    this.unregisterParams();
  }

  /** 0x18003ebd0. */
  private setup(motion: EmoteMotion): void {
    this.reset();
    this.layerIndexMap = motion.layerIndexMap;
    const walk = (layers: readonly EmoteLayer[], parent: number) => {
      for (const layer of layers) {
        const param =
          layer.parameterize !== null ? (this.params[layer.parameterize] ?? null) : null;
        const node = new Node(this, layer, this.nodes.length, parent, param);
        this.nodes.push(node);
        this.typeMask |= 1 << node.type;
        if (node.type === 3) {
          this.subNodes.push(node);
          node.sub = this.createSub(node);
        } else if (node.type === 1) this.shapeNodes.push(node);
        else if (node.type === 12) this.stencilNodes.push(node);
        walk(layer.children, node.index);
      }
    };
    walk(motion.layers, 0);
    for (const node of this.nodes) {
      if (node.meshTransform !== 0 && node.hasCombinator) {
        this.top.combinators ??= new CombinatorRegistry(this.top);
        this.top.combinators.register(node);
      }
    }
    for (const node of this.stencilNodes) {
      if (!(node.stencilType & 4)) continue;
      // 0x18003eef0.
      for (const label of node.layer?.stencilCompositeMaskLayerList ?? []) {
        const i = this.layerIndexMap?.get(label);
        const mask = i !== undefined ? this.nodes[i + 1] : undefined;
        if (mask && (mask.type === 0 || mask.type === 3)) {
          node.masks.push(mask);
          mask.maskLayer = true;
        }
      }
    }
  }

  /** Nested clip of a type 3 layer (0x18003a160). */
  private createSub(node: Node): EmoteMotionClip {
    const sub = new EmoteMotionClip(this.resource, this);
    sub.independentInherit = node.layer?.motionIndependentLayerInherit ?? false;
    if (sub.independentInherit) sub.root.ovDirty = true;
    sub.root.coordinate = node.coordinate;
    sub.root.transformOrder = node.transformOrder;
    sub.file = this.file;
    sub.clipFlags = this.clipFlags;
    sub.setGrayscale(this.grayscaleMode, this.grayscaleLevel);
    sub.effectMode = this.effectMode;
    sub.effectLevel = this.effectLevel;
    return sub;
  }

  // Progress ---------------------------------------------------------------------------

  /** 0x18003f720. */
  progress(frames: number): void {
    if (this.queued) {
      const name = this.queued,
        flags = this.queuedFlags;
      this.queued = '';
      this.setMotion(name, flags & ~0x60);
      if (flags & 0x40) return;
    }
    if (this.combinators) this.combinators.update();
    this.advance(f32(frames));
    this.calc();
    this.drawList.length = 0;
    this.buildDrawList(this.color, null);
    this.events = [];
  }

  /** 0x18003f600: the nested-clip progress. */
  private progressSub(frames: number): void {
    this.advance(frames);
    this.calc();
  }

  /** 0x18003f7f0. */
  private advance(frames: number): void {
    this.delta = f32(frames * this.speed);
    const pz = this.parameterized;
    if (pz) {
      const v = pz.value;
      if (this.seekPending) {
        this.time = this.clamped = v;
        this.seekPending = false;
        this.seek();
      } else if (this.clamped < v) {
        this.time = this.clamped = v;
        this.stepForward();
      } else if (v < this.clamped) {
        this.time = this.clamped = v;
        this.stepBackward();
      } else this.stepParams();
      return;
    }
    if (!this.seekPending && !this.playing) {
      if (this.params.length) this.stepParams();
      return;
    }
    if (this.sync || this.align) return;
    if (this.seekPending) {
      this.seekPending = false;
      if (this.delta < 0 && this.time === 0) this.time = this.clamped = this.lastTime;
      if (!this.seekWrap) this.seek();
      else {
        this.seekWrap = false;
        const saved = this.clamped;
        if (this.delta < 0) {
          if (this.lastTime <= this.time) this.seek();
          else {
            this.clamped = this.lastTime;
            this.seek();
            this.clamped = saved;
            this.stepBackward();
          }
        } else {
          this.clamped = 0;
          this.seek();
          this.clamped = saved;
          this.stepForward();
        }
      }
    }
    const jumped = this.jumped;
    let t: number;
    if (!jumped) {
      t = this.time = f32(this.delta + this.time);
      this.clamped = t < this.lastTime ? t : this.lastTime;
    } else t = this.time;
    if (this.delta >= 0) {
      if (this.lastTime <= t) {
        this.clamped = this.lastTime;
        if (this.loopTime >= 0) {
          this.stepForward();
          this.clamped = this.loopTime;
          this.seek();
          let u = this.time;
          const span = this.lastTime - this.loopTime;
          if (this.lastTime <= u)
            u = span > 0 ? wrapUp(u, this.loopTime, this.lastTime) : this.loopTime;
          this.time = this.clamped = u;
          this.stepForward();
          return;
        }
        this.playing = false;
      }
      if (!jumped) this.stepForward();
      return;
    }
    if (t < 0 || t < this.loopTime) {
      if (this.loopTime >= 0) {
        this.clamped = this.loopTime;
        this.stepBackward();
        this.clamped = this.lastTime;
        this.seek();
        let u = this.time;
        const span = this.lastTime - this.loopTime;
        if (u < this.loopTime)
          u = span > 0 ? wrapDown(u, this.loopTime, this.lastTime) : this.lastTime;
        this.time = this.clamped = u;
        this.stepBackward();
        return;
      }
      this.time = this.clamped = 0;
      this.playing = false;
    }
    if (!jumped) this.stepBackward();
  }

  private timeOf(node: Node): number {
    return node.param ? node.param.value : this.clamped;
  }

  private pushAct(node: Node): void {
    if (node.a.mask & 0x40000 && node.a.act)
      this.events.push({layer: node.layer?.label ?? '', action: node.a.act});
  }

  /** 0x18003fc30. */
  private seek(): void {
    const pr = this.priority;
    if (pr.length) {
      let idx = this.prIndex;
      for (let i = 0; i < pr.length; i++) {
        if (pr[i]!.time === this.clamped) {
          idx = i;
          break;
        }
        if (this.clamped < pr[i]!.time) {
          idx = Math.max(i - 1, 0);
          break;
        }
      }
      this.prIndex = Math.min(idx, Math.max(pr.length - 2, 0));
      this.order = pr[this.prIndex]!.order;
    }
    for (let k = 1; k < this.nodes.length; k++) {
      const n = this.nodes[k]!;
      const t = this.timeOf(n);
      let idx = 0;
      for (let i = 0; i < n.count; i++) {
        const ft = n.states[i]!.time;
        if (ft === t) {
          idx = i;
          break;
        }
        if (t < ft) {
          idx = Math.max(i - 1, 0);
          break;
        }
      }
      idx = Math.min(idx, Math.max(n.count - 2, 0));
      n.a = n.stateAt(idx);
      n.b = n.stateAt(idx + 1);
      n.dirty = true;
      if ((0x1801 >> n.type) & 1) n.resolveSource(this, n.a);
      if (n.a.time === t) this.pushAct(n);
    }
  }

  /** 0x180040cb0. */
  private stepForward(): void {
    const pr = this.priority;
    while (
      pr.length >= 2 &&
      this.prIndex < pr.length - 2 &&
      this.clamped >= pr[this.prIndex + 1]!.time
    ) {
      this.prIndex++;
      this.order = pr[this.prIndex]!.order;
    }
    for (let k = 1; k < this.nodes.length; k++) {
      const n = this.nodes[k]!;
      if (n.param) {
        this.stepParamNode(n);
        continue;
      }
      let stepped = false;
      while (n.a.index < n.count - 2) {
        if (this.clamped < n.b.time) break;
        const next = n.stateAt(n.b.index + 1);
        n.a = n.b;
        n.b = next;
        stepped = true;
        this.pushAct(n);
      }
      if (!stepped) continue;
      n.dirty = true;
      if ((0x1801 >> n.type) & 1) n.resolveSource(this, n.a);
    }
  }

  /** 0x1800415e0. */
  private stepBackward(): void {
    const pr = this.priority;
    while (pr.length && this.prIndex > 0 && this.clamped < pr[this.prIndex]!.time) {
      this.prIndex--;
      this.order = pr[this.prIndex]!.order;
    }
    for (let k = 1; k < this.nodes.length; k++) {
      const n = this.nodes[k]!;
      if (n.param) {
        this.stepParamNode(n);
        continue;
      }
      if (!(this.clamped < n.a.time) || n.a.index === 0) continue;
      while (this.clamped < n.a.time && n.a.index > 0) {
        const prev = n.stateAt(n.a.index - 1);
        n.b = n.a;
        n.a = prev;
        this.pushAct(n);
      }
      n.dirty = true;
      if ((0x1801 >> n.type) & 1) n.resolveSource(this, n.a);
    }
  }

  /** 0x180040a60. */
  private stepParams(): void {
    for (let k = 1; k < this.nodes.length; k++) {
      const n = this.nodes[k]!;
      if (n.param) this.stepParamNode(n);
    }
  }

  /** 0x180040860. */
  private stepParamNode(n: Node): void {
    const v = n.param!.value;
    let stepped = false;
    while (n.a.index < n.count - 2 && n.b.time <= v) {
      const next = n.stateAt(n.b.index + 1);
      n.a = n.b;
      n.b = next;
      stepped = true;
    }
    if (n.a.time <= v) {
      if (!stepped) return;
    } else {
      while (v < n.a.time && n.a.index > 0) {
        const prev = n.stateAt(n.a.index - 1);
        n.b = n.a;
        n.a = prev;
      }
    }
    n.dirty = true;
    if ((0x1801 >> n.type) & 1) n.resolveSource(this, n.a);
  }

  // Evaluation -------------------------------------------------------------------------

  /** 0x1800422f0: the info block from the two keyframes; true when it changed. */
  private interpolate(n: Node, force: boolean): boolean {
    force ||= n.dirty;
    const A = n.a,
      B = n.b;
    if (A.noContent) return force;
    if (A.interp && !B.noContent) {
      let e = f32(this.timeOf(n) - A.time);
      if (A.ti) e = f32(Math.trunc(f32(e / A.ti)) * A.ti);
      e = f32(e / f32(B.time - A.time));
      if (Math.abs(e) >= FLT_EPSILON) {
        if (!force && Math.abs(f32(n.prevE - e)) < FLT_EPSILON) return false;
        if (A.eased) throw new EmoteUnsupportedError('easing curves');
        n.prevE = e;
        n.fx = A.fx;
        n.fy = A.fy;
        n.angle = lerpAngle(A.angle, B.angle, e);
        n.zx = lerpScalar(A.zx, B.zx, e);
        n.zy = lerpScalar(A.zy, B.zy, e);
        n.sx = lerpScalar(A.sx, B.sx, e);
        n.sy = lerpScalar(A.sy, B.sy, e);
        const ie = f32(1 - e);
        if (A.coord[0] === B.coord[0] && A.coord[1] === B.coord[1] && A.coord[2] === B.coord[2]) {
          n.x = A.coord[0];
          n.y = A.coord[1];
          n.z = A.coord[2];
        } else {
          n.x = f32(ie * A.coord[0] + e * B.coord[0]);
          n.y = f32(ie * A.coord[1] + e * B.coord[1]);
          n.z = f32(ie * A.coord[2] + e * B.coord[2]);
        }
        const o = f32(f32(A.opa * ie) + f32(B.opa * e));
        n.opa = Math.trunc(o < 0 ? Math.ceil(o - 0.5) : Math.floor(o + 0.5)) >>> 0;
        n.scalarColor = A.scalarColor && B.scalarColor;
        n.defaultColor = A.defaultColor && B.defaultColor;
        if (!n.scalarColor)
          for (let i = 0; i < 4; i++) n.colors[i] = lerpColor(A.color[i]!, B.color[i]!, e);
        else n.colors.fill(lerpColor(A.color[0], B.color[0], e));
        if (n.meshTransform === 1 && !n.combinatorOwned && n.mstate) {
          if (!A.bp && !B.bp) n.mstate.bp = null;
          else n.mstate.bp = lerpMesh(A.bp ?? DEFAULT_MESH, B.bp ?? DEFAULT_MESH, e);
        }
        return true;
      }
      const old = n.prevE;
      n.prevE = e;
      if (Math.abs(f32(old - e)) >= FLT_EPSILON) force = true;
    }
    if (!force) return false;
    n.fx = A.fx;
    n.fy = A.fy;
    n.angle = A.angle;
    n.zx = A.zx;
    n.zy = A.zy;
    n.sx = A.sx;
    n.sy = A.sy;
    n.x = A.coord[0];
    n.y = A.coord[1];
    n.z = A.coord[2];
    for (let i = 0; i < 4; i++) n.colors[i] = A.color[i]!;
    n.opa = A.opa;
    n.scalarColor = A.scalarColor;
    n.defaultColor = A.defaultColor;
    if (n.meshTransform === 1 && !n.combinatorOwned && n.mstate) n.mstate.bp = A.bp;
    return true;
  }

  /** 0x180042bb0: a child of a mesh layer follows the patch. */
  private syncToMesh(P: Node, n: Node): void {
    const ms = P.mstate;
    if (!ms?.bp || !P.drawVisible || !P.found || !(P.syncChildMask & 1) || P.meshTransform !== 1)
      return;
    const f13 = f32(P.a.ox + P.originX),
      f14 = f32(P.a.oy + P.originY);
    const yz = P.coordinate === 0 ? n.y : n.z;
    const u = f32(f32(n.x + f13) / P.w),
      v = f32(f32(yz + f14) / P.h);
    const pt = new Float32Array([u, v]);
    bezierMap(pt, 1, ms.bp);
    const ny = f32(P.h * pt[1]! - f14);
    if (P.coordinate === 0) n.y = ny;
    else n.z = ny;
    n.x = f32(P.w * pt[0]! - f13);
    const bAng = (P.syncChildMask & 2) !== 0 && (n.inherit & 0x10) !== 0;
    const bZoom = (P.syncChildMask & 4) !== 0 && (n.inherit & 0x60) !== 0;
    if (!bAng && !bZoom) return;
    const d = f32(0.0001);
    const q = new Float32Array([u - d, v, u + d, v, u, v - d, u, v + d]);
    bezierMap(q, 4, ms.bp);
    const [xu0, yu0, xu1, yu1, xv0, yv0, xv1, yv1] = q as unknown as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    if (bAng) {
      const a1 = Math.atan2(-(xv1 - xv0), yv1 - yv0);
      const a2 = Math.atan2(yu1 - yu0, xu1 - xu0);
      n.angle = f32(f32(((a1 + a2) * 0.5 * 360) / f32(Math.PI * 2)) + n.angle);
    }
    if (bZoom) {
      const dx = xu1 - xu0,
        dy = yu1 - yu0;
      const t1 = Math.abs((yv0 - yu0) * dx - (xv0 - xu0) * dy) * 0.5;
      const t2 = Math.abs((yv1 - yu0) * dx - (xv1 - xu0) * dy) * 0.5;
      const s = f32(Math.sqrt(2 * (t1 + t2)) / f32(0.0002));
      if (n.inherit & 0x20) n.zx = f32(s * n.zx);
      if (n.inherit & 0x40) n.zy = f32(s * n.zy);
    }
  }

  /** 0x180043010 (CalcLayerFrameInfo). */
  private calc(): void {
    const nodes = this.nodes,
      root = nodes[0]!;
    for (let i = 0; i < 3; i++) {
      if (this.velocity[i] !== 0) {
        const v = f32(this.velocity[i]! * this.delta);
        if (i === 0) root.ovX = f32(v + root.ovX);
        else if (i === 1) root.ovY = f32(v + root.ovY);
        else root.ovZ = f32(v + root.ovZ);
        root.ovDirty = true;
      }
    }
    if (this.decay !== 1) {
      const k = f32(Math.pow(this.decay, this.delta / 60));
      for (let i = 0; i < 3; i++) this.velocity[i] = f32(k * this.velocity[i]!);
    }
    for (const n of nodes) {
      n.vel[0] = n.x;
      n.vel[1] = n.y;
      n.vel[2] = n.z;
    }
    root.copyOverridesToInfo();
    root.ovDirty = false;
    if (!this.rootMatrixFromParent) root.computeMatrix();
    for (let k = 1; k < nodes.length; k++) {
      const n = nodes[k]!;
      const D = nodes[n.parent]!;
      let P = D;
      while (P.inherit & 0x400000) P = nodes[P.parent]!;
      const force = this.forceCalc || P.changed || D.changed || n.ovDirty;
      if (!this.interpolate(n, force)) continue;
      n.ovDirty = false;
      if (n.a.noContent) {
        n.changed = P.changed || n.dirty;
        n.drawVisible = false;
        n.fx = P.fx;
        n.fy = P.fy;
        n.x = P.x;
        n.y = P.y;
        n.z = P.z;
        n.angle = P.angle;
        n.zx = P.zx;
        n.zy = P.zy;
        n.sx = P.sx;
        n.sy = P.sy;
        n.opa = P.opa;
        n.visible = P.visible && n.ovVisible;
        n.copyMatrix(P);
        continue;
      }
      n.changed = true;
      n.visible = n.ovVisible && P.visible;
      n.drawVisible = n.ovDrawVisible && n.visible;
      n.fx = n.fx !== n.ovFx;
      n.fy = n.fy !== n.ovFy;
      n.angle = f32(n.ovAngle + n.angle);
      n.zx = f32(n.ovZx * n.zx);
      n.zy = f32(n.ovZy * n.zy);
      n.sx = f32(n.ovSx + n.sx);
      n.sy = f32(n.ovSy + n.sy);
      n.opa = Math.floor(((n.ovOpa * n.opa) >>> 0) / 255);
      n.x = f32(n.ovX + n.x);
      n.y = f32(n.ovY + n.y);
      n.z = f32(n.ovZ + n.z);
      if (P.meshTransform !== 0) this.syncToMesh(P, n);
      const x = n.x,
        y = n.y,
        z = n.z;
      if (P.coordinate === 0) {
        n.x = f32(y * P.m01 + x * P.m00 + P.x);
        n.y = f32(f32(x * P.m10 + y * P.m11) + P.y);
        n.z = f32(z + P.z);
      } else {
        n.x = f32(z * P.m01 + x * P.m00 + P.x);
        n.y = f32(y + P.y);
        n.z = f32(f32(z * P.m11 + x * P.m10) + P.z);
      }
      if (n.inherit & 0x400) n.opa = Math.floor(((P.opa * n.opa) >>> 0) / 255);
      else if (!this.independentInherit) n.opa = Math.floor(((root.opa * n.opa) >>> 0) / 255);
      if ((n.inherit & 0x1fc) === 0x1fc) {
        n.computeMatrix();
        n.leftMultiply(P);
        n.fx = n.fx !== P.fx;
        n.fy = n.fy !== P.fy;
        n.angle = f32(P.angle + n.angle);
        n.zx = f32(P.zx * n.zx);
        n.zy = f32(P.zy * n.zy);
        n.sx = f32(P.sx + n.sx);
        n.sy = f32(P.sy + n.sy);
      } else {
        const m = n.inherit;
        if (m & 4) n.fx = n.fx !== P.fx;
        if (m & 8) n.fy = n.fy !== P.fy;
        if (m & 0x10) n.angle = f32(P.angle + n.angle);
        if (m & 0x20) n.zx = f32(P.zx * n.zx);
        if (m & 0x40) n.zy = f32(P.zy * n.zy);
        if (m & 0x80) n.sx = f32(P.sx + n.sx);
        if (m & 0x100) n.sy = f32(P.sy + n.sy);
        if (!this.independentInherit) {
          if (m & 4) n.fx = n.fx !== root.fx;
          if (m & 8) n.fy = n.fy !== root.fy;
          if (m & 0x10) n.angle = f32(n.angle - root.angle);
          if (m & 0x20) n.zx = f32(n.zx / root.zx);
          if (m & 0x40) n.zy = f32(n.zy / root.zy);
          if (m & 0x80) n.sx = f32(n.sx - root.sx);
          if (m & 0x100) n.sy = f32(n.sy - root.sy);
          n.computeMatrix();
          if (m & 4) n.fx = n.fx !== root.fx;
          if (m & 8) n.fy = n.fy !== root.fy;
          if (m & 0x10) n.angle = f32(root.angle + n.angle);
          if (m & 0x20) n.zx = f32(root.zx * n.zx);
          if (m & 0x40) n.zy = f32(root.zy * n.zy);
          if (m & 0x80) n.sx = f32(root.sx + n.sx);
          if (m & 0x100) n.sy = f32(root.sy + n.sy);
          n.leftMultiply(root);
        } else n.computeMatrix();
      }
    }
    for (const n of nodes) {
      if (this.jumped) n.vel.fill(0);
      else {
        n.vel[0] = f32(n.x - n.vel[0]!);
        n.vel[1] = f32(n.y - n.vel[1]!);
        n.vel[2] = f32(n.z - n.vel[2]!);
      }
    }
    this.forceCalc = false;
    this.vertices();
    for (let k = 1; k < nodes.length; k++) {
      const n = nodes[k]!;
      const D = nodes[n.parent]!;
      n.stencilParent = D.stencilVisible ? D : D.stencilParent;
      n.stencilVisible = !(
        n.a.noContent ||
        n.stencilType === 0 ||
        !n.drawVisible ||
        (((0x1801 >> n.type) & 1) !== 0 && !n.found)
      );
    }
    if (this.typeMask & 2) this.shapes();
    if (this.typeMask & 8) this.subclips();
    for (const n of nodes) {
      n.dirty = false;
      n.changed = false;
    }
    for (const p of this.params) p.flags = 0;
    this.jumped = false;
    this.f18a = false;
  }

  /** 0x180043e00: anchors, mesh deformers and vertex grids. */
  private vertices(): void {
    const nodes = this.nodes;
    for (let k = 1; k < nodes.length; k++) {
      const n = nodes[k]!;
      let D = nodes[n.parent]!;
      const ms = n.mstate;
      const oldId = n.meshParentId;
      const mp = D.isDeformer || D.breaksChain ? D : D.meshParent;
      n.meshParent = mp;
      n.meshParentId = mp ? mp.id : 0;
      if (n.meshParentId === oldId && !n.changed && (!mp || !mp.modified)) {
        n.modified = false;
        if (n.meshCombine && n.isDeformer) {
          for (;;) {
            if (D.isDeformer && D === n.meshParent) n.meshParent = D.meshParent;
            if (!D.meshCombine) break;
            D = nodes[D.parent]!;
          }
        }
        continue;
      }
      n.modified = true;
      n.breaksChain = mp !== null && (n.inherit & 0x2000000) === 0;
      n.isDeformer =
        !n.a.noContent &&
        n.meshTransform !== 0 &&
        ms !== null &&
        ms.bp !== null &&
        n.found &&
        (n.syncChildMask & 8) !== 0;
      if ((0x22 >> n.type) & 1) {
        if (!n.meshParent) {
          n.anchor[0] = n.x;
          n.anchor[1] = n.y;
        } else {
          const p = this.mapAnchor(n.meshParent, n.x, n.y, false);
          n.anchor[0] = p[0];
          n.anchor[1] = p[1];
        }
        n.anchor[2] = n.z;
      }
      if (n.a.noContent || !((0x1c01 >> n.type) & 1) || !n.found) continue;
      let bpSrc: Float32Array | null;
      if (!n.meshCombine) bpSrc = ms?.bp ?? null;
      else if (!n.isDeformer) bpSrc = null;
      else {
        const temp = Float32Array.from(ms!.bp!);
        for (;;) {
          if (D.isDeformer) {
            if (D === n.meshParent) n.meshParent = D.meshParent;
            const dbp = D.mstate!.bp!;
            for (let i = 0; i < 32; i++) temp[i] = temp[i]! + dbp[i]! - DEFAULT_MESH[i]!;
          }
          if (!D.meshCombine) break;
          D = nodes[D.parent]!;
        }
        bpSrc = temp;
      }
      const yy = f32(this.resource.zFactor * n.z + n.y);
      const xx = n.x;
      const oy = f32(n.a.oy + n.originY),
        ox = f32(n.a.ox + n.originX);
      const ty = f32(-f32(ox * n.m10 + oy * n.m11) + yy);
      const tx = f32(xx - f32(oy * n.m01 + n.m00 * ox));
      if (n.meshTransform === 1 && ms) {
        const a = f32(n.w * n.m00),
          b = f32(n.h * n.m01),
          c = f32(n.w * n.m10),
          d = f32(n.h * n.m11);
        ms.ms[0] = a;
        ms.ms[1] = b;
        ms.ms[2] = c;
        ms.ms[3] = d;
        if (n.isDeformer) {
          const det = f32(d * a - c * b);
          ms.inv[0] = d / det;
          ms.inv[1] = -b / det;
          ms.inv[2] = -c / det;
          ms.inv[3] = a / det;
          ms.negTx = -tx;
          ms.negTy = -ty;
          const src = bpSrc!;
          for (let i = 0; i < 16; i++) {
            const px = src[i * 2]!,
              py = src[i * 2 + 1]!;
            ms.world[i * 2] = px * a + py * b + tx;
            ms.world[i * 2 + 1] = c * px + d * py + ty;
          }
        }
      }
      if (!((0x1401 >> n.type) & 1) || n.blank) continue;
      const grid = (n.grid ??= {cols: 1, rows: 1, points: new Float32Array(8)});
      if (!ms || !bpSrc) {
        const w = n.w,
          h = n.h;
        const p00x = f32(n.m00 * 0 + n.m01 * 0 + tx),
          p00y = f32(n.m10 * 0 + n.m11 * 0 + ty);
        const p10x = f32(w * n.m00 + n.m01 * 0 + tx),
          p10y = f32(w * n.m10 + n.m11 * 0 + ty);
        const p01x = f32(n.m01 * h + n.m00 * 0 + tx),
          p01y = f32(n.m11 * h + n.m10 * 0 + ty);
        const p11x = f32(w * n.m00 + n.m01 * h + tx),
          p11y = f32(w * n.m10 + n.m11 * h + ty);
        if (!n.meshParent) {
          grid.cols = 1;
          grid.rows = 1;
          grid.points = new Float32Array([p00x, p00y, p10x, p10y, p01x, p01y, p11x, p11y]);
        } else {
          let N: number;
          const ratio = this.top.meshDivisionRatio;
          if (n.meshTransform === 0) {
            let anc: Node = n.meshParent;
            while (!anc.isDeformer && anc.meshParent) anc = anc.meshParent;
            const div = Math.trunc(f32(anc.division * ratio));
            N = Math.floor(((div * (w + h)) >>> 0) / ((anc.w + anc.h) >>> 0 || 1));
          } else N = Math.trunc(f32(n.division * ratio)) >>> 0;
          let c0 = Math.floor(((w * N) >>> 0) / ((w + h) >>> 0 || 1));
          let r0 = (N - c0) >>> 0;
          if (c0 === 0) c0 = 1;
          if (r0 === 0) r0 = 1;
          const cols = c0 + 1,
            rows = r0 + 1;
          grid.cols = cols;
          grid.rows = rows;
          const pts = new Float32Array((rows + 1) * (cols + 1) * 2);
          let o = 0;
          const dv = f32(1 / rows),
            du = f32(1 / cols);
          for (let j = 0; j <= rows; j++) {
            const v = f32(j * dv),
              iv = f32(1 - v);
            for (let i = 0; i <= cols; i++) {
              const u = f32(i * du),
                iu = f32(1 - u);
              pts[o++] = iu * (v * p01x + p00x * iv) + u * (p10x * iv + p11x * v);
              pts[o++] = (p00y * iv + v * p01y) * iu + (p10y * iv + v * p11y) * u;
            }
          }
          grid.points = pts;
        }
      } else {
        grid.cols = ms.cols;
        grid.rows = ms.rows;
        grid.points = tessellate(ms.bp!, ms.cols, ms.rows, ms.ms, tx, ty);
      }
      // Deformation by the mesh-parent chain; the anchor follows the same chain.
      const count = grid.points.length >> 1;
      let ax = xx,
        ay = yy;
      let X = n.meshParent;
      let stopX = ax,
        stopY = ay;
      if (!n.breaksChain && X) {
        let broke = false;
        while (X) {
          if (X.isDeformer) {
            const xm = X.mstate!;
            affineMap(grid.points, count, xm.inv, xm.negTx, xm.negTy);
            bezierMap(grid.points, count, xm.world);
            [ax, ay] = this.mapThrough(X, ax, ay);
          }
          stopX = ax;
          stopY = ay;
          const next: Node | null = X.meshParent;
          if (X.breaksChain) {
            X = next;
            broke = true;
            break;
          }
          X = next;
        }
        if (broke)
          for (; X; X = X.meshParent) if (X.isDeformer) [ax, ay] = this.mapThrough(X, ax, ay);
      } else {
        for (; X; X = X.meshParent) if (X.isDeformer) [ax, ay] = this.mapThrough(X, ax, ay);
      }
      if (ax !== stopX || ay !== stopY) {
        const dx = f32(ax - stopX),
          dy = f32(ay - stopY);
        for (let i = 0; i < count; i++) {
          grid.points[i * 2]! += dx;
          grid.points[i * 2 + 1]! += dy;
        }
      }
    }
  }

  private mapThrough(X: Node, x: number, y: number): [number, number] {
    const xm = X.mstate!;
    const px = f32(x + xm.negTx),
      py = f32(y + xm.negTy);
    const p = new Float32Array([
      f32(py * xm.inv[1]! + px * xm.inv[0]!),
      f32(py * xm.inv[3]! + px * xm.inv[2]!),
    ]);
    bezierMap(p, 1, xm.world);
    return [p[0]!, p[1]!];
  }

  /** The anchor walk of types 1 and 5. */
  private mapAnchor(start: Node, x: number, y: number, _unused: boolean): [number, number] {
    for (let X: Node | null = start; X; X = X.meshParent)
      if (X.isDeformer) [x, y] = this.mapThrough(X, x, y);
    return [x, y];
  }

  /** 0x180045900: shape layers. */
  private shapes(): void {
    for (const n of this.shapeNodes) {
      if (!n.modified || !n.shapeInfo) continue;
      const info = n.shapeInfo;
      const shape = n.layer?.shape ?? 0;
      info[0] = shape;
      if (shape === 0 || shape === 1) {
        info[1] = n.anchor[0]!;
        info[2] = n.anchor[1]!;
        if (shape === 1) info[3] = Math.trunc(f32(n.zx * 16 * 0.5));
      } else throw new EmoteUnsupportedError(`shape ${shape}`);
    }
  }

  /** 0x180045c50: drives the nested clips of type 3 layers. */
  private subclips(): void {
    const clipFlags = this.parameterized ? this.parameterized.flags : 0;
    for (const n of this.subNodes) {
      const sub = n.sub;
      if (!sub) continue;
      const tClamped = n.param ? n.param.value : this.clamped;
      const tTime = n.param ? n.param.value : this.time;
      const flags = n.param ? n.param.flags : clipFlags;
      const A = n.a,
        B = n.b;
      if (n.changed || flags) {
        if (A.noContent || !A.src) {
          sub.playing = false;
          sub.reset();
          sub.motionName = '';
          sub.playingName = '';
          continue;
        }
        if (n.dirty || flags & 5) {
          sub.selectObject(A.src);
          sub.setMotion(A.icon ?? '', flags | A.motion.flags);
          if (sub.playing && sub.jumped) {
            let t = f32(f32(tTime - A.time) + A.motion.timeOffset);
            if (this.delta < 0 && sub.loopTime >= 0 && sub.lastTime > sub.loopTime)
              while (sub.lastTime <= t) t = f32(f32(t - sub.lastTime) + sub.loopTime);
            sub.seekTo(t);
            if (!this.jumped) sub.seekWrap = true;
          }
        }
        let bAng = false;
        let angle = 0;
        const dt = A.motion.dt;
        if (dt !== 0) {
          let dofst = A.motion.dofst;
          if (A.motion.docmpl && A.interp && !B.noContent && B.motion.dt !== 0) {
            const e = f32(f32(tClamped - A.time) / f32(B.time - A.time));
            dofst = lerpAngle(dofst, B.motion.dofst, e);
          }
          if (dt === 1) {
            angle = f32(dofst + n.angle);
            bAng = true;
          } else throw new EmoteUnsupportedError(`nested-motion direction mode ${dt}`);
        }
        let cx = n.x,
          cy = n.y,
          cz = n.z;
        if (A.ox !== 0 || A.oy !== 0) {
          const ox = -A.ox,
            oy = -A.oy;
          const rx = f32(oy * n.m01 + ox * n.m00),
            ry = f32(oy * n.m11 + ox * n.m10);
          if (n.coordinate === 0) {
            cx = f32(cx + rx);
            cy = f32(cy + ry);
          } else if (n.coordinate === 1) {
            cx = f32(rx + cx);
            cz = f32(ry + cz);
          }
        }
        const r = sub.root;
        if (r.ovX !== cx || r.ovY !== cy || r.ovZ !== cz) {
          r.ovDirty = true;
          r.ovX = cx;
          r.ovY = cy;
          r.ovZ = cz;
        }
        if (r.ovFx !== n.fx || r.ovFy !== n.fy) {
          r.ovDirty = true;
          r.ovFx = n.fx;
          r.ovFy = n.fy;
        }
        if (r.ovZx !== n.zx || r.ovZy !== n.zy) {
          r.ovDirty = true;
          r.ovZx = n.zx;
          r.ovZy = n.zy;
        }
        if (bAng && r.ovAngle !== angle) {
          r.ovDirty = true;
          r.ovAngle = angle;
        }
        if (r.ovSx !== n.sx || r.ovSy !== n.sy) {
          r.ovDirty = true;
          r.ovSx = n.sx;
          r.ovSy = n.sy;
        }
        if (r.ovOpa !== n.opa) {
          r.ovDirty = true;
          r.ovOpa = n.opa;
        }
        if (r.ovVisible !== n.drawVisible) {
          r.ovDirty = true;
          r.ovVisible = n.drawVisible;
        }
        sub.color = n.colors[0]!;
        if (bAng && angle !== n.angle) {
          const d = f32(f32(f32(f32(angle - n.angle) * f32(Math.PI)) * 2) / 360);
          const s = f32(Math.sin(d)),
            c = f32(Math.cos(d));
          r.m00 = f32(-s * n.m10 + c * n.m00);
          r.m01 = f32(c * n.m01 + -s * n.m11);
          r.m10 = f32(c * n.m10 + s * n.m00);
          r.m11 = f32(s * n.m01 + c * n.m11);
        } else r.copyMatrix(n);
        r.ovDirty = true;
      }
      const r = sub.root;
      r.meshParent = n.meshParent;
      r.stencilParent = n.stencilParent;
      sub.progressSub(this.delta);
      if (sub.events.length) {
        this.events.push(...sub.events);
        sub.events = [];
      }
    }
  }

  // Draw list --------------------------------------------------------------------------

  /** 0x180048c70. */
  private buildDrawList(color: number, collector: EmoteDrawItem[] | null): void {
    if (this.jumped) return;
    const mod = modulateColor(color, this.color);
    const neutral = mod === NEUTRAL;
    const nodes = this.nodes;
    const count = nodes.length - 1;
    for (let k = 0; k < count; k++) {
      const idx = this.order[count - 1 - k];
      const n = idx !== undefined ? nodes[idx + 1] : undefined;
      if (!n) continue;
      n.drawn = false;
      if (!n.drawVisible) continue;
      if (n.type === 3) {
        if (!n.sub) continue;
        const c = n.inherit & 0x200 ? mod : NEUTRAL;
        if (!n.stencilVisible && !n.maskLayer) n.sub.buildDrawList(c, collector);
        else {
          const item = n.item!;
          n.drawn = true;
          item.stencilType = n.stencilType;
          item.stencilParent = n.stencilParent?.item ?? null;
          item.alphaTest = false;
          item.alphaScale = 1;
          item.alphaOffset = 0;
          item.composite.length = 0;
          n.sub.buildDrawList(c, item.composite);
          if (collector) collector.push(...item.composite);
        }
        continue;
      }
      if (!((0x1401 >> n.type) & 1) || !n.found) continue;
      const item = n.item!;
      n.drawn = true;
      item.blank = n.blank;
      item.nodeId = n.id;
      item.coordinate = n.coordinate;
      item.objTriPriority = n.layer?.objTriPriority ?? 0;
      item.clipFlags = this.clipFlags;
      const A = n.a;
      item.bm = A.bm;
      const b = A.bm & 0xff0f;
      item.bmParam = A.bmParam;
      item.grayscaleMode = this.grayscaleMode;
      item.grayscaleLevel = this.grayscaleLevel;
      item.effectMode = this.effectMode;
      item.effectLevel = this.effectLevel;
      item.z = n.z;
      item.texIndex = n.texIndex;
      item.file = n.file;
      item.source = n.source;
      let attr = n.attr >>> 0;
      item.left = n.left;
      item.top = n.top;
      item.width = f32(n.w * n.resolution);
      item.height = f32(n.h * n.resolution);
      item.opa = n.opa;
      let c = mod;
      let forced = neutral;
      if (b === 2 || b === 3 || b === 5) {
        c = NEUTRAL;
        forced = true;
      }
      if (b !== 0) attr &= ~2;
      const withOpa = (v: number) =>
        n.opa !== 255 ? (Math.floor(((v & 0xff) * n.opa) / 255) | (v & 0xffffff00)) >>> 0 : v >>> 0;
      if (!n.scalarColor) {
        let all = 0xff;
        for (let i = 0; i < 4; i++) {
          const v = modulateColor(withOpa(n.colors[i]!), c);
          item.colors[i] = v;
          all &= v;
        }
        if ((all & 0xff) !== 0xff) attr &= ~2;
      } else if (!forced || n.opa !== 255) {
        const v = modulateColor(withOpa(n.colors[0]!), c);
        item.colors.fill(v);
        if ((v & 0xff) !== 0xff) attr &= ~2;
      } else {
        item.colors.set(n.colors);
        if (n.defaultColor) attr |= 4;
      }
      item.mesh = n.meshTransform === 1 && n.mstate?.bp ? n.mstate : null;
      item.grid = n.grid;
      item.stencilType = n.stencilType;
      item.stencilParent = n.stencilParent?.item ?? null;
      if (n.stencilParent) attr &= ~2;
      item.attr = attr;
      if ((0x401 >> n.type) & 1) this.top.drawList.push(item);
      if (collector) collector.push(item);
      item.alphaTest = false;
    }
    for (const n of this.stencilNodes) {
      if (!(n.stencilType & 4) || !n.drawn) continue;
      const item = n.item!;
      item.composite.length = 0;
      item.composite.push(item);
      for (const m of n.masks) {
        if (!m.drawn || !m.item) continue;
        if (m.type === 0) item.composite.push(m.item);
        else if (m.type === 3) item.composite.push(...m.item.composite);
      }
    }
  }
}

function wrapUp(t: number, loop: number, last: number): number {
  while (last <= t) t = f32(f32(t - last) + loop);
  return t;
}

function wrapDown(t: number, loop: number, last: number): number {
  while (t < loop) t = f32(f32(t - loop) + last);
  return t;
}

/** Degrees per radian as the clip computes it. */
export const EMOTE_RAD_TO_DEG = RAD_TO_DEG;

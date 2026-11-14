import type {EmoteBlockNestedClip} from './nested.js';
import {EmoteUnsupportedError} from '../errors.js';
import {composeEmoteMatrix, type EmoteMatrixValues} from './matrix.js';
import type {
  EmoteEasingCurve,
  EmoteLayer,
  EmoteX64Layer,
  EmoteX64Model,
} from '../../../../formats/kirikiri/emote-model.js';
import type {
  EmoteNodeView,
  EmoteVertexGrid,
  EmoteScalarMeshState,
  EmoteScalarVertexGrid,
  EmoteScalarDrawItem,
  EmoteCombinatorTarget,
} from '../interfaces.js';
import {
  FrameSlot,
  scalarLayerStates,
  missingScalarState,
  type EmoteScalarFrameState,
} from './frame.js';
import type {EmoteSourceTarget, EmoteSourceFrame} from './source.js';
import type {
  EmoteBlockLayerTransform,
  EmoteLayerState,
  EmoteTransformState,
  EmoteScalarLayerTransform,
} from './layer.js';
import {emoteBuild, EMOTEDRIVER_X86_SHA256, EMOTEDRIVER_X64_SHA256} from '../../build.js';

/**
 * Evaluated node state blocks (`emotedriver.dll` SHA-256 `a3b693b6…5e70b3a86`). A node holds
 * two of them: +0x254 is the result of the layer pass, +0x280 the adjustment block (on the root
 * the player's transform tweens, on a nested clip's root the referencing layer's state).
 */
export class NodeState implements EmoteLayerState {
  /** +0x254 changed this pass / +0x280 dirty. */
  changed = true;
  /** +0x255 visible / +0x281. */
  visible = true;
  /** +0x256 shown along the parent chain / +0x282 shown. */
  shown = true;
  /** +0x257/+0x258, +0x283/+0x284. */
  flipX = false;
  flipY = false;
  x = 0;
  y = 0;
  z = 0;
  angle = 0;
  zoomX = 1;
  zoomY = 1;
  slantX = 0;
  slantY = 0;
  /** 0..255. */
  opacity = 255;

  copyFrom(o: EmoteTransformState): void {
    this.changed = o.changed;
    this.visible = o.visible;
    this.shown = o.shown;
    this.flipX = o.flipX;
    this.flipY = o.flipY;
    this.x = o.x;
    this.y = o.y;
    this.z = o.z;
    this.angle = o.angle;
    this.zoomX = o.zoomX;
    this.zoomY = o.zoomY;
    this.slantX = o.slantX;
    this.slantY = o.slantY;
    this.opacity = o.opacity;
  }
  /** Compose only the transform components selected by the native inherit mask. */
  inheritTransform(p: EmoteTransformState, mask: number): void {
    if (mask & 0x4) this.flipX = this.flipX !== p.flipX;
    if (mask & 0x8) this.flipY = this.flipY !== p.flipY;
    if (mask & 0x10) this.angle = Math.fround(p.angle + this.angle);
    if (mask & 0x20) this.zoomX = Math.fround(p.zoomX * this.zoomX);
    if (mask & 0x40) this.zoomY = Math.fround(p.zoomY * this.zoomY);
    if (mask & 0x80) this.slantX = Math.fround(p.slantX + this.slantX);
    if (mask & 0x100) this.slantY = Math.fround(p.slantY + this.slantY);
  }

  /** Remove selected parent components before evaluating in the root frame. */
  removeTransform(p: EmoteTransformState, mask: number): void {
    if (mask & 0x4) this.flipX = this.flipX !== p.flipX;
    if (mask & 0x8) this.flipY = this.flipY !== p.flipY;
    if (mask & 0x10) this.angle = Math.fround(this.angle - p.angle);
    if (mask & 0x20) this.zoomX = Math.fround(this.zoomX / p.zoomX);
    if (mask & 0x40) this.zoomY = Math.fround(this.zoomY / p.zoomY);
    if (mask & 0x80) this.slantX = Math.fround(this.slantX - p.slantX);
    if (mask & 0x100) this.slantY = Math.fround(this.slantY - p.slantY);
  }
}

/**
 * Bezier mesh of a `meshTransform: 1` layer (node +0x2b4 → +8, 0x64 bytes): Bernstein tables
 * (+0, +8), grid segments (+0x10, +0x14), local patch (+0x1c), world patch (+0x2c), the layer
 * frame (+0x3c), its inverse (+0x4c) and translation (+0x5c).
 */
export class BezierMesh {
  columns = 0;
  rows = 0;
  /** Unit-square control points interpolated from the keyframes; empty when none. */
  local = new Float32Array(0);
  readonly world = new Float32Array(32);
  readonly matrix = new Float32Array(4);
  readonly inverse = new Float32Array(4);
  translateX = 0;
  translateY = 0;

  copyFrom(o: BezierMesh): void {
    this.columns = o.columns;
    this.rows = o.rows;
    this.local = o.local.slice();
    this.world.set(o.world);
    this.matrix.set(o.matrix);
    this.inverse.set(o.inverse);
    this.translateX = o.translateX;
    this.translateY = o.translateY;
  }
}

export class VertexGrid implements EmoteVertexGrid {
  columns = 0;
  rows = 0;
  positions = new Float32Array(0);
  resize(columns: number, rows: number): void {
    this.columns = columns;
    this.rows = rows;
    const n = (columns + 1) * (rows + 1) * 2;
    if (this.positions.length !== n) this.positions = new Float32Array(n);
  }
}

/** Source of the current frame (node +0x84..+0xac, 0x10038a30). */
export class NodeSource implements EmoteSourceTarget {
  drawable = false;
  hidden = false;
  srcKey = '';
  iconKey = '';
  attr = 0;
  texture = -1;
  readonly rect = new Int32Array(4);
  originX = 0;
  originY = 0;
  setSourceSize(width: number, height: number): void {
    this.rect[2] = width;
    this.rect[3] = height;
  }
  setSourceRect(left: number, top: number, width: number, height: number): void {
    this.rect[0] = left;
    this.rect[1] = top;
    this.rect[2] = width;
    this.rect[3] = height;
  }
  copyFrom(o: NodeSource): void {
    this.drawable = o.drawable;
    this.hidden = o.hidden;
    this.srcKey = o.srcKey;
    this.iconKey = o.iconKey;
    this.attr = o.attr;
    this.texture = o.texture;
    this.rect.set(o.rect);
    this.originX = o.originX;
    this.originY = o.originY;
  }
}

/** A clip parameter (motion `parameter`, 0x34 bytes at clip +0x300). */
export class ClipParameter {
  private readonly x64: boolean;
  /** +0x2c normalized position; +0x30 change flags (never set by the lifted code paths). */
  position = 0;
  flags = 0;
  constructor(
    readonly id: string,
    readonly discretization: boolean,
    readonly rangeBegin: number,
    readonly rangeEnd: number,
    readonly division: number,
    driverSha256 = EMOTEDRIVER_X86_SHA256,
  ) {
    this.x64 = emoteBuild(driverSha256) === EMOTEDRIVER_X64_SHA256;
  }

  /** 0x10031400 / 0x180036a90: clamp a variable to its parameter's frame range. */
  apply(value: number): void {
    this.flags = 0;
    const b = this.rangeBegin,
      e = this.rangeEnd,
      d = this.division;
    if (b === e || !(0 < d)) {
      this.position = 0;
      return;
    }
    let v = this.x64 ? value : Math.fround(value);
    if (this.discretization) v = this.x64 ? Math.trunc(v) : Math.fround(Math.trunc(v));
    const lo = this.x64 ? Math.min(b, e) : e <= b ? e : b,
      hi = this.x64 ? Math.max(b, e) : b <= e ? e : b;
    const c = v <= lo ? lo : v;
    this.position = Math.fround((((hi <= c ? hi : c) - b) * d) / (e - b));
  }
}

/** A layer node (stride 0x2e0). */
export class EmoteNode implements EmoteNodeView, EmoteBlockLayerTransform {
  readonly label: string;
  readonly type: number;
  readonly parent: number;
  readonly inheritMask: number;
  transformOrder: readonly number[];
  /** +0x14 `coordinate`: 0 x/y plane, otherwise x/z. */
  coordinate: number;
  readonly joinTarget: boolean;
  readonly groundCorrection: boolean;
  readonly stencilType: number;
  readonly layer: EmoteLayer | null;
  /** +0x0c parameter driving this node's frame time, or null for clip time. */
  readonly parameter: ClipParameter | null;
  /** +0x10 identity used by the mesh pass (0x1002b950 counter). */
  readonly id: number;
  readonly index: number;

  readonly slots: [FrameSlot, FrameSlot] = [new FrameSlot(), new FrameSlot()];
  /** +0x250 current slot. */
  current = 0;
  /** +0x30 last tween position. */
  lastT = 0;
  /** +0x24 frames reloaded, +0x25 vertices recomputed this pass. */
  framesDirty = false;
  meshDirty = false;
  /** +0x28/+0x29 from the slots' +0x12/+0x13. */
  singleColor = false;
  colorUnset = false;
  readonly colors = new Uint32Array(4);
  readonly matrix = new Float32Array([1, 0, 0, 1]);
  /** +0x6c..+0x74 previous coordinate, then velocity. */
  readonly velocity = new Float32Array(3);
  /** +0x78..+0x80 mesh-deformed coordinate (shape layers). */
  readonly meshPosition = new Float32Array(3);
  readonly resolved = new NodeSource();
  readonly state = new NodeState();
  readonly adjust = new NodeState();
  /** +0x2ac clip rectangle (left, top, right, bottom). */
  clipRect: Float32Array | null = null;
  /** +0x2b0 meshTransform kind, +0x2b4 syncChildMask/division, +0x2ba meshCombine. */
  readonly meshKind: number;
  readonly meshSync: number;
  readonly meshDivision: number;
  readonly meshCombine: boolean;
  readonly mesh: BezierMesh | null;
  /** +0x2b8 deforms descendants, +0x2b9 not deformed by ancestors, +0x2bc/+0x2c0 mesh parent. */
  meshActive = false;
  meshIndependent = false;
  meshParent: EmoteNode | null = null;
  meshParentId = 0;
  /** +0x2c5 masking layer, +0x2cc nearest masking ancestor. */
  isMask = false;
  maskNode: EmoteNode | null = null;
  /** +0x2d8 vertex grid. */
  gridData: VertexGrid | null = null;
  /** +0x2dc: nested clip (type 3); shape points (type 1). */
  child: EmoteBlockNestedClip<EmoteNode> | null = null;
  readonly shape: Float32Array | null;
  readonly stencilCompositeMaskLayers: readonly string[] | null;
  /** +0x2dc of type 12: nodes named by `stencilCompositeMaskLayerList` (0x1003a1d0). */
  compositeMaskNodes: readonly EmoteNode[] = [];

  constructor(
    index: number,
    layer: EmoteLayer | null,
    parent: number,
    parameter: ClipParameter | null,
    id: number,
    readonly easing: readonly EmoteEasingCurve[] | null,
  ) {
    this.index = index;
    this.layer = layer;
    this.label = layer?.label ?? '';
    this.type = layer?.type ?? 2;
    this.parent = parent;
    this.inheritMask = layer?.inheritMask ?? 0;
    this.transformOrder = layer?.transformOrder ?? DEFAULT_ORDER;
    this.coordinate = layer?.coordinate ?? 0;
    this.joinTarget = layer?.joinTarget ?? false;
    this.groundCorrection = layer?.groundCorrection ?? false;
    this.stencilType = layer?.stencilType ?? 0;
    this.parameter = parameter;
    this.id = id;
    this.meshKind = layer?.meshTransform ?? 0;
    this.meshSync = layer?.mesh?.syncChildMask ?? 0;
    this.meshDivision = layer?.mesh?.division ?? 0;
    this.meshCombine = layer?.mesh?.combine ?? false;
    this.mesh = this.meshKind === 1 ? new BezierMesh() : null;
    this.shape = this.type === 1 ? new Float32Array(9) : null;
    if (this.shape) this.shape[0] = layer?.shape ?? 0;
    this.stencilCompositeMaskLayers = layer?.stencilCompositeMaskLayerList ?? null;
    this.colors.fill(0);
    this.slots[0].empty = this.slots[1].empty = true;
  }
  /** Nested clip root: frame axes and order of the referencing layer (0x100344a0). */
  overrideFrame(coordinate: number, order: readonly number[]): void {
    this.coordinate = coordinate;
    this.transformOrder = order;
  }

  get cur(): FrameSlot {
    return this.slots[this.current]!;
  }
  get next(): FrameSlot {
    return this.slots[this.current ^ 1]!;
  }

  // EmoteNodeView
  get visible(): boolean {
    return this.state.visible;
  }
  get drawable(): boolean {
    return this.resolved.drawable;
  }
  /** +0x255 (the renderer's `shown`). */
  get shown(): boolean {
    return this.state.visible;
  }
  get hidden(): boolean {
    return this.resolved.hidden;
  }
  /** +0x90: texture index of the current source. */
  get textureIndex(): number {
    return this.resolved.texture;
  }
  /** +0x94: the icon's `attr`. */
  get drawFlags(): number {
    return this.resolved.attr;
  }
  get sourceRect(): readonly [number, number, number, number] {
    const r = this.resolved.rect;
    return [r[0]!, r[1]!, r[2]!, r[3]!];
  }
  /** +0x29: both frames left `color` unset. */
  get protectColor(): boolean {
    return this.colorUnset;
  }
  /** +0x2c5 masking layer. */
  get stencilChild(): boolean {
    return this.isMask;
  }
  get x(): number {
    return this.state.x;
  }
  get y(): number {
    return this.state.y;
  }
  get z(): number {
    return this.state.z;
  }
  get angle(): number {
    return this.state.angle;
  }
  get zoomX(): number {
    return this.state.zoomX;
  }
  get zoomY(): number {
    return this.state.zoomY;
  }
  get slantX(): number {
    return this.state.slantX;
  }
  get slantY(): number {
    return this.state.slantY;
  }
  get flipX(): boolean {
    return this.state.flipX;
  }
  get flipY(): boolean {
    return this.state.flipY;
  }
  get velocityX(): number {
    return this.velocity[0]!;
  }
  get velocityY(): number {
    return this.velocity[1]!;
  }
  get opacity(): number {
    return this.state.opacity;
  }
  get blendMode(): number {
    return this.cur.bm;
  }
  get source(): string | null {
    return this.resolved.srcKey === '' ? null : this.resolved.srcKey;
  }
  get icon(): string | null {
    return this.resolved.iconKey === '' ? null : this.resolved.iconKey;
  }
  get grid(): EmoteVertexGrid | null {
    return this.gridData;
  }
}

/** Default `transformOrder` of a root node (DAT_100867e8..f4): flip, slant, zoom, rotate. */
const DEFAULT_ORDER = Object.freeze([0, 3, 2, 1]);

/** Only the parameter fields read while scanning or driving nested clips. */
export interface EmoteScalarNodeParameter {
  readonly value: number;
  readonly flags: number;
}
/** Services borrowed by a scalar node, independent of its owning clip implementation. */
export interface EmoteScalarNodeHost {
  readonly resource: {
    allocateNodeId(): number;
    readonly sources: {
      resolve(
        target: EmoteSourceTarget<EmoteX64Model>,
        frame: EmoteSourceFrame,
        current: EmoteX64Model | null,
      ): boolean;
    };
  };
  readonly file: EmoteX64Model | null;
  readonly top: {readonly meshDivisionRatio: number};
}
const NEUTRAL = 0x808080ff;
const f32 = Math.fround;
const SUPPORTED_TYPES: ReadonlySet<number> = new Set([0, 1, 2, 3, 12]);

function newDrawItem(): EmoteScalarDrawItem {
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

/**
 * Scalar layer node (0x3d0 bytes), x64 DLL SHA-256
 * `80d28bd088dda8e97c7c47a9c664e55159f70505b0f9fde3158d8ce2a3e1e051`.
 */
export class EmoteScalarNode<Subclip>
  extends NodeState
  implements EmoteCombinatorTarget, EmoteSourceTarget<EmoteX64Model>, EmoteScalarLayerTransform
{
  readonly layer: EmoteX64Layer | null;
  readonly index: number;
  readonly parent: number;
  readonly id: number;
  readonly type: number;
  readonly inheritMask: number;
  coordinate: number;
  transformOrder: readonly number[];
  readonly stencilType: number;
  readonly meshKind: number;
  readonly meshCombine: boolean;
  readonly syncChildMask: number;
  readonly division: number;
  readonly hasCombinator: boolean;
  /** Payload +8: a combinator owns the patch. */
  combinatorOwned = false;
  readonly mstate: EmoteScalarMeshState | null;
  readonly param: EmoteScalarNodeParameter | null;
  readonly states: readonly EmoteScalarFrameState[];
  cur: EmoteScalarFrameState;
  next: EmoteScalarFrameState;
  /** +0x34, +0x35, +0x40. */
  framesDirty = false;
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
  setMatrix(m00: number, m01: number, m10: number, m11: number): void {
    this.m00 = m00;
    this.m01 = m01;
    this.m10 = m10;
    this.m11 = m11;
  }
  /** +0x88 previous position / velocity, +0x94 anchor. */
  readonly vel = new Float32Array(3);
  readonly anchor = new Float32Array(3);
  /** Source block +0xa0..+0xd8 and the resolved keys. */
  drawable = false;
  hidden = false;
  texture = 0;
  attr = 0;
  left = 0;
  top = 0;
  w = 0;
  h = 0;
  originX = 0;
  originY = 0;
  resolution = 1;
  file: EmoteX64Model | null = null;
  source: string | null = null;
  srcKey: string | null | undefined = undefined;
  iconKey: string | null | undefined = undefined;
  /** Overrides +0x340..+0x368; evaluated fields use the shared state above. */
  readonly adjust = new NodeState();
  /** +0x388..+0x398. */
  isDeformer = false;
  breaksChain = false;
  meshParent: EmoteScalarNode<Subclip> | null = null;
  meshParentId = 0;
  /** +0x39c..+0x3c0. */
  maskLayer = false;
  stencilVisible = false;
  stencilParent: EmoteScalarNode<Subclip> | null = null;
  drawn = false;
  readonly item: EmoteScalarDrawItem | null;
  grid: EmoteScalarVertexGrid | null = null;
  /** Type 3 payload. */
  sub: Subclip | null = null;
  /** Type 12 payload: the composite mask nodes. */
  masks: EmoteScalarNode<Subclip>[] = [];
  /** Type 1 payload (shape info). */
  readonly shapeInfo: number[] | null;

  constructor(
    clip: EmoteScalarNodeHost,
    layer: EmoteX64Layer | null,
    index: number,
    parent: number,
    param: EmoteScalarNodeParameter | null,
  ) {
    super();
    this.layer = layer;
    this.index = index;
    this.parent = parent;
    this.id = clip.resource.allocateNodeId();
    this.param = param;
    if (!layer) {
      this.type = 0;
      this.inheritMask = 0;
      this.coordinate = 0;
      this.transformOrder = [0, 3, 2, 1];
      this.stencilType = 0;
      this.meshKind = 0;
      this.meshCombine = false;
      this.syncChildMask = 0;
      this.division = 0;
      this.hasCombinator = false;
      this.mstate = null;
      this.states = [];
      this.adjust.shown = true;
      this.item = null;
      this.shapeInfo = null;
    } else {
      if (!SUPPORTED_TYPES.has(layer.type))
        throw new EmoteUnsupportedError(`layer type ${layer.type}`);
      if (layer.groundCorrection) throw new EmoteUnsupportedError('ground correction');
      this.type = layer.type;
      this.inheritMask = layer.inheritMask >>> 0;
      this.coordinate = layer.coordinate;
      this.transformOrder = layer.transformOrder;
      this.stencilType = layer.stencilType;
      this.meshKind = layer.meshTransform;
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
      this.states = scalarLayerStates(layer);
      this.item = (0x1409 >> layer.type) & 1 ? newDrawItem() : null;
      this.shapeInfo = layer.type === 1 ? [0, 0, 0, 0, 0, 0, 0, 0, 0] : null;
    }
    this.cur = this.stateAt(0);
    this.next = this.stateAt(1);
  }

  get meshType(): number {
    return this.meshKind;
  }

  applyCombinatorPatch(patch: Float32Array | null): void {
    if (!this.mstate) return;
    this.framesDirty = true;
    this.combinatorOwned = true;
    this.mstate.bp = patch === null ? null : Float32Array.from(patch);
  }

  stateAt(i: number): EmoteScalarFrameState {
    return i < this.states.length ? this.states[i]! : missingScalarState(i);
  }

  get count(): number {
    return this.states.length;
  }

  /**
   * Scalar copy constructor 0x1800343e0, after copying the node vector. Immutable
   * frame sequences stay shared; evaluated values, overrides, patches and semantic
   * vertex grids belong to the new node. Native renderer cache pointers and pass
   * links are discarded. The owning clip rebinds child/mask references separately.
   */
  copyScalarState(source: EmoteScalarNode<Subclip>): void {
    this.copyFrom(source);
    this.adjust.copyFrom(source.adjust);
    for (const key of [
      'coordinate',
      'transformOrder',
      'framesDirty',
      'modified',
      'prevE',
      'scalarColor',
      'defaultColor',
      'm00',
      'm01',
      'm10',
      'm11',
      'drawable',
      'hidden',
      'texture',
      'attr',
      'left',
      'top',
      'w',
      'h',
      'originX',
      'originY',
      'resolution',
      'file',
      'source',
      'srcKey',
      'iconKey',
      'isDeformer',
      'breaksChain',
      'maskLayer',
      'stencilVisible',
      'drawn',
      'combinatorOwned',
    ] as const)
      (this as unknown as Record<string, unknown>)[key] = source[key];
    this.cur = source.cur;
    this.next = source.next;
    this.colors.set(source.colors);
    this.vel.set(source.vel);
    this.anchor.set(source.anchor);
    if (this.shapeInfo && source.shapeInfo)
      this.shapeInfo.splice(0, this.shapeInfo.length, ...source.shapeInfo);
    const mesh = this.mstate,
      from = source.mstate;
    if (mesh && from) {
      mesh.cols = from.cols;
      mesh.rows = from.rows;
      mesh.bp = from.bp?.slice() ?? null;
      mesh.ms.set(from.ms);
      mesh.world.set(from.world);
      mesh.inv.set(from.inv);
      mesh.negTx = from.negTx;
      mesh.negTy = from.negTy;
    }
    // This runtime stores evaluated logical positions rather than native GPU
    // cache handles. Copy their bytes so a clone can draw before its first tick.
    this.grid = source.grid
      ? {cols: source.grid.cols, rows: source.grid.rows, points: source.grid.points.slice()}
      : null;
    this.meshParent = null;
    this.meshParentId = 0;
    this.stencilParent = null;
  }

  /** 0x18003dc40. */
  resolveSource(clip: EmoteScalarNodeHost, s: EmoteScalarFrameState): void {
    if (s.empty) return;
    if (this.srcKey === s.src && this.iconKey === s.icon) return;
    if (!clip.resource.sources.resolve(this, s, clip.file)) return;
    if (this.meshKind === 1 && this.mstate) {
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

  setSourceSize(width: number, height: number): void {
    this.w = width;
    this.h = height;
  }

  setSourceRect(left: number, top: number, width: number, height: number): void {
    this.left = left;
    this.top = top;
    this.w = width | 0;
    this.h = height | 0;
  }

  /** Overrides into the info block (root, 0x180043010 step 3). */
  copyOverridesToInfo(): void {
    this.copyFrom(this.adjust);
  }

  /** 0x180041de0: local matrix in the layer's transform order. */
  computeMatrix(): void {
    composeEmoteMatrix(this, this.transformOrder, this, EMOTEDRIVER_X64_SHA256);
  }

  copyMatrix(src: EmoteMatrixValues): void {
    this.m00 = src.m00;
    this.m01 = src.m01;
    this.m10 = src.m10;
    this.m11 = src.m11;
  }
}

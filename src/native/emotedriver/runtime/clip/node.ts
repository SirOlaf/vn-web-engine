import type {EmoteEasingCurve, EmoteLayer} from '../../../../formats/kirikiri/emote-model.js';
import type {EmoteClipNodes, EmoteNodeView, EmoteVertexGrid} from '../interfaces.js';
import {FrameSlot} from './frame.js';

/**
 * Evaluated node state blocks (`emotedriver.dll` SHA-256 `a3b693b6…5e70b3a86`). A node holds
 * two of them: +0x254 is the result of the layer pass, +0x280 the adjustment block (on the root
 * the player's transform tweens, on a nested clip's root the referencing layer's state).
 */
export class NodeState {
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

  copyFrom(o: NodeState): void {
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
export class NodeSource {
  drawable = false;
  hidden = false;
  src = '';
  icon = '';
  attr = 0;
  texture = -1;
  readonly rect = new Int32Array(4);
  originX = 0;
  originY = 0;
  copyFrom(o: NodeSource): void {
    this.drawable = o.drawable;
    this.hidden = o.hidden;
    this.src = o.src;
    this.icon = o.icon;
    this.attr = o.attr;
    this.texture = o.texture;
    this.rect.set(o.rect);
    this.originX = o.originX;
    this.originY = o.originY;
  }
}

/** A clip parameter (motion `parameter`, 0x34 bytes at clip +0x300). */
export class ClipParameter {
  /** +0x2c normalized position; +0x30 change flags (never set by the lifted code paths). */
  position = 0;
  flags = 0;
  constructor(
    readonly id: string,
    readonly discretization: boolean,
    readonly rangeBegin: number,
    readonly rangeEnd: number,
    readonly division: number,
  ) {}
}

/** A layer node (stride 0x2e0). */
export class EmoteNode implements EmoteNodeView {
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
  child: EmoteClipNodes | null = null;
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
    return this.resolved.src === '' ? null : this.resolved.src;
  }
  get icon(): string | null {
    return this.resolved.icon === '' ? null : this.resolved.icon;
  }
  get grid(): EmoteVertexGrid | null {
    return this.gridData;
  }
}

/** Default `transformOrder` of a root node (DAT_100867e8..f4): flip, slant, zoom, rotate. */
const DEFAULT_ORDER = Object.freeze([0, 3, 2, 1]);

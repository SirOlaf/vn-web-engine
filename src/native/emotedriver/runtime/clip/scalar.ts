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
  EmoteX64Layer as EmoteLayer,
  EmoteX64Model as EmoteModel,
  EmoteX64Motion as EmoteMotion,
  EmoteParameter,
} from '../../../../formats/kirikiri/emote-model.js';
import type {PsbValue} from '../../../../formats/kirikiri/psb.js';
import {buildScalarDrawList} from '../render/draw-list.js';
import {EmoteUnsupportedError} from '../errors.js';
import {EMOTEDRIVER_X64_SHA256} from '../../build.js';
import {evaluateScalarFrame} from './interpolate.js';
import {EmoteMeshCombinators} from './combinators.js';
import type {
  EmoteScalarDrawItem,
  EmoteX64MeshKernel,
  EmoteClipDriver,
  EmoteClipFactory,
  EmoteX64ClipPlayerAccess,
  EmoteClipListener,
  EmoteRootTransform,
  EmoteClipEvent as DriverClipEvent,
} from '../interfaces.js';
import {createEmoteMeshKernel} from '../mesh/index.js';
import {ClipParameter, EmoteScalarNode} from './node.js';
import {EmoteClipTime} from './time.js';
import {evaluateScalarMotions} from './nested.js';
import {EmoteLayerPass} from './layer.js';
import {EmoteSourceResolver, type EmoteSourceIcon} from './source.js';
import {syncToParentMeshX64, type EmoteScalarVertexHost} from './vertices.js';
import {expandEmoteVariableBounds} from '../player/stereovision.js';

const f32 = Math.fround;
const NEUTRAL = 0x808080ff;
const DEG = f32((Math.PI * 2) / 360);
const RAD_TO_DEG = f32(360 / f32(Math.PI * 2));

// ---------------------------------------------------------------------------------------
// Resource

/** Icon lookup result (0x180031810). */
export type EmoteIconRef = EmoteSourceIcon<EmoteModel>;

/**
 * The motion files of one player (`MEmoteResource`). Motions and icons are searched in the
 * clip's current file first, then in every file in load order.
 */
export class EmoteResource {
  /** +0x48: the coordinate-system depth factor applied to y; 0 for the D3D device. */
  readonly zFactor: number = 0;
  private nextNodeId = 1;
  readonly sources: EmoteSourceResolver<EmoteModel>;

  constructor(
    readonly files: readonly EmoteModel[],
    readonly kernel: EmoteX64MeshKernel = createEmoteMeshKernel({
      driverSha256: EMOTEDRIVER_X64_SHA256,
    }),
  ) {
    this.sources = new EmoteSourceResolver(files, EMOTEDRIVER_X64_SHA256);
  }

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
    return this.sources.findIcon(src, icon, current);
  }

  /** The device node-id allocator (node +0x20). */
  allocateNodeId(): number {
    return this.nextNodeId++;
  }
}

// ---------------------------------------------------------------------------------------
// Scalar draw records

type EmoteDrawItem = EmoteScalarDrawItem;

/** Parameter (0x38 bytes at clip +0x418). */
class Param extends ClipParameter {
  constructor(readonly def: EmoteParameter) {
    super(
      def.id,
      def.discretization,
      def.rangeBegin,
      def.rangeEnd,
      def.division,
      EMOTEDRIVER_X64_SHA256,
    );
  }
  get value(): number {
    return this.position;
  }
}

/** Native scalar nodes keep their nested clip type without an implementation import. */
const Node = EmoteScalarNode<EmoteMotionClip>;
type Node = InstanceType<typeof Node>;

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

export class EmoteMotionClip
  extends EmoteClipTime
  implements EmoteClipDriver, EmoteX64ClipPlayerAccess
{
  private readonly layerPass = new EmoteLayerPass(EMOTEDRIVER_X64_SHA256);
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
  f18a = true;
  forceCalc = false;
  /** +0x158/+0x15c. */
  readonly ownRotation = false;
  ownRotationAngle = 0;
  /** +0x1a0 root velocity, +0x1ac decay. */
  readonly velocity = new Float32Array(3);
  decay = 1;
  /** +0x1c0/+0x1c4 grayscale, +0x1c8 colour, +0x1d8/+0x1dc. */
  grayscaleMode = 0;
  grayscaleLevel = 0;
  color = NEUTRAL;
  effectMode = 0;
  effectLevel = 1;
  /** +0x208.. priority state; +0x218 order list. */
  private priority: PriorityFrame[] = [];
  private prIndex = 0;
  order: readonly number[] = [];
  /** +0x250. */
  clipFlags = 0;
  /** +0x2e0. */
  layerEvents: DriverClipEvent[] = [];
  get events(): readonly DriverClipEvent[] {
    return this.layerEvents;
  }
  /** +0x410 motion-independent inheritance, +0x411 the parent writes the root matrix. */
  independentInherit = false;
  readonly rootMatrixFromParent: boolean;
  /** +0x418 parameters, +0x430 the registered parameters by id, +0x440 values. */
  parameters: Param[] = [];
  private readonly paramIndex = new Map<string, Param[]>();
  readonly values = new Map<string, number>();
  protected motionParameter: Param | null = null;
  /** +0x488 (top). */
  meshDivisionRatio = 1;
  /** Device +0x88. */
  smoothing = false;
  /** +0x4b0 (top): the draw list of the last progress. */
  readonly drawList: EmoteDrawItem[] = [];
  /** +0x4d8 (top). */
  private combinators: EmoteMeshCombinators | null = null;
  readonly vertexHost: EmoteScalarVertexHost;
  /** +0x1e8 nodes; +0x3c4 type bit set; type lists. */
  layerNodes: Node[] = [];
  private advanceHeld = false;
  typeMask = 0;
  private subNodes: Node[] = [];
  shapeNodes: Node[] = [];
  stencilNodes: Node[] = [];
  private layerIndexMap: ReadonlyMap<string, number> | null = null;

  constructor(resource: EmoteResource, parent: EmoteMotionClip | null = null) {
    super(EMOTEDRIVER_X64_SHA256);
    this.resource = resource;
    this.parentClip = parent;
    this.top = parent ? parent.top : this;
    this.rootMatrixFromParent = parent !== null;
    this.layerNodes = [new Node(this, null, 0, 0, null)];
    this.vertexHost = {
      nodes: this.layerNodes,
      resource,
      top: this.top,
      quadCorners: new Float32Array(8),
      mappedPoint: new Float32Array(2),
      mappedResult: [0, 0],
    };
  }

  get root(): Node {
    return this.layerNodes[0]!;
  }

  // Scalar player access --------------------------------------------------------------------------

  get rootX(): number {
    return this.root.adjust.x;
  }
  set rootX(v: number) {
    this.root.adjust.x = f32(v);
  }
  get rootY(): number {
    return this.root.adjust.y;
  }
  set rootY(v: number) {
    this.root.adjust.y = f32(v);
  }
  get rootZoomX(): number {
    return this.root.adjust.zoomX;
  }
  set rootZoomX(v: number) {
    this.root.adjust.zoomX = f32(v);
  }
  get rootZoomY(): number {
    return this.root.adjust.zoomY;
  }
  set rootZoomY(v: number) {
    this.root.adjust.zoomY = f32(v);
  }
  get rootAngle(): number {
    return this.root.adjust.angle;
  }
  set rootAngle(v: number) {
    this.root.adjust.angle = f32(v);
  }
  get rootDirty(): boolean {
    return this.root.adjust.changed;
  }
  set rootDirty(v: boolean) {
    this.root.adjust.changed = v;
  }
  get visible(): boolean {
    return this.root.adjust.shown;
  }
  set visible(v: boolean) {
    this.root.adjust.shown = v;
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
    return this.layerNodes.some((n) => n.modified);
  }

  isModified(): boolean {
    return this.modified;
  }

  get nodes(): never {
    throw new EmoteUnsupportedError('x86 node view of x64 clip');
  }
  nodeIndex(_label: string): never {
    throw new EmoteUnsupportedError('x86 node lookup of x64 clip');
  }
  /**
   * Private clip-copy operation used by the shared player's copy constructor.
   * Native 0x1800343e0 copies fields (0x1800335c0), then reconstructs parameter,
   * node, nested-clip, combinator and draw ownership without advancing playback.
   */
  assignState(source: EmoteClipDriver): void {
    if (!(source instanceof EmoteMotionClip))
      throw new TypeError('assignState: not a scalar E-mote clip');
    if (source === this) return;
    if (source.resource.files.some((file) => !this.resource.files.includes(file)))
      throw new TypeError('assignState: different E-mote file group');
    this.reset();
    this.unregisterParams();
    this.values.clear();
    for (const [key, value] of source.values) this.values.set(key, value);
    for (const key of [
      'objectName',
      'playingObject',
      'motionName',
      'playingName',
      'pendingObject',
      'pendingMotion',
      'queued',
      'queuedFlags',
      'file',
      'motion',
      'playing',
      'jumped',
      'starting',
      'replay',
      'syncStop',
      'alignStop',
      'timeRunning',
      'time',
      'speed',
      'step',
      'loopTime',
      'lastTime',
      'f18a',
      'forceCalc',
      'ownRotationAngle',
      'decay',
      'grayscaleMode',
      'grayscaleLevel',
      'color',
      'effectMode',
      'effectLevel',
      'prIndex',
      'clipFlags',
      'independentInherit',
      'meshDivisionRatio',
      'smoothing',
      'advanceHeld',
      'typeMask',
      'layerIndexMap',
    ] as const)
      (this as unknown as Record<string, unknown>)[key] = source[key];
    this.velocity.set(source.velocity);
    this.priority = source.priority.map((frame) => ({time: frame.time, order: [...frame.order]}));
    this.order = [...source.order];
    this.layerEvents = source.layerEvents.map((event) => ({...event}));
    this.parameters = source.parameters.map((parameter) => {
      const copy = new Param(parameter.def);
      copy.position = parameter.position;
      copy.flags = parameter.flags;
      return copy;
    });
    this.registerParams();
    this.motionParameter = source.motionParameter
      ? this.parameters[source.parameters.indexOf(source.motionParameter)]!
      : null;
    if (this.top === this)
      this.combinators = source.combinators
        ? new EmoteMeshCombinators(this, EMOTEDRIVER_X64_SHA256)
        : null;
    this.root.copyScalarState(source.root);
    for (let i = 1; i < source.layerNodes.length; i++) {
      const from = source.layerNodes[i]!,
        parameter = from.layer?.parameterize,
        node = new Node(
          this,
          from.layer,
          i,
          from.parent,
          parameter !== null && parameter !== undefined ? this.parameters[parameter]! : null,
        );
      this.layerNodes.push(node);
      node.copyScalarState(from);
      if (node.hasCombinator) {
        this.top.combinators ??= new EmoteMeshCombinators(this.top, EMOTEDRIVER_X64_SHA256);
        this.top.combinators.register(node, node.layer!.mesh!.combinators!, this);
      }
      if (node.type === 3) {
        this.subNodes.push(node);
        if (from.sub) {
          node.sub = new EmoteMotionClip(this.resource, this);
          node.sub.assignState(from.sub);
        }
      } else if (node.type === 1) this.shapeNodes.push(node);
      else if (node.type === 12) this.stencilNodes.push(node);
    }
    for (let i = 1; i < source.layerNodes.length; i++)
      this.layerNodes[i]!.masks = source.layerNodes[i]!.masks.map(
        (node) => this.layerNodes[node.index]!,
      );
    this.drawList.length = 0;
    this.buildDrawList(this.color, null);
    if (this.parentClip === null) this.root.adjust.changed = true;
  }

  get rootVisible(): boolean {
    return this.visible;
  }
  set rootVisible(value: boolean) {
    this.visible = value;
  }

  setRootTransform(value: EmoteRootTransform): void {
    const root = this.root.adjust;
    root.x = f32(value.x);
    root.y = f32(value.y);
    root.zoomX = f32(value.scaleX);
    root.zoomY = f32(value.scaleY);
    root.angle = f32(value.angle);
    // X64 mirrors matching variables, not the clip root.
  }

  applyVariable(label: string, value: number): void {
    this.setVariable(label, value);
  }

  /** 0x18000e6d0 clip part. */
  layerPosition(name: string): {readonly x: number; readonly y: number} | null {
    const i = this.layerIndexMap?.get(name);
    if (i === undefined) return null;
    const n = this.layerNodes[i + 1];
    if (!n || n.type !== 1 || !n.shapeInfo || n.layer?.shape !== 0) return null;
    return {x: n.shapeInfo[1]!, y: n.shapeInfo[2]!};
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

  /** 0x180038480: union of loaded parameter ranges and this clip's combinator registry. */
  getVariableRange(label: string): readonly [number, number] | null {
    const bounds = Float32Array.of(3.4028234663852886e38, -3.4028234663852886e38);
    this.expandParameterBounds(label, bounds);
    this.combinators?.expandVariableBounds(label, bounds);
    return bounds[0]! < bounds[1]! ? [bounds[0]!, bounds[1]!] : null;
  }

  private expandParameterBounds(label: string, bounds: Float32Array): void {
    for (const parameter of this.parameters)
      if (parameter.id === label)
        expandEmoteVariableBounds(bounds, parameter.rangeBegin, parameter.rangeEnd);
    for (const node of this.subNodes) node.sub?.expandParameterBounds(label, bounds);
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
    this.parameters = motion.parameters.map((d) => {
      const p = new Param(d);
      p.apply(this.inheritedValue(d.id));
      return p;
    });
    this.registerParams();
    this.motionParameter =
      motion.parameterize !== null ? (this.parameters[motion.parameterize] ?? null) : null;
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
    for (const p of this.parameters) {
      for (let c: EmoteMotionClip | null = this; c; c = c.parentClip) {
        let list = c.paramIndex.get(p.def.id);
        if (!list) c.paramIndex.set(p.def.id, (list = []));
        list.push(p);
      }
    }
  }

  /** 0x180036230. */
  private unregisterParams(): void {
    for (const p of this.parameters) {
      for (let c: EmoteMotionClip | null = this; c; c = c.parentClip) {
        const list = c.paramIndex.get(p.def.id);
        if (!list) continue;
        const i = list.indexOf(p);
        if (i >= 0) list.splice(i, 1);
        if (list.length === 0) c.paramIndex.delete(p.def.id);
      }
    }
    this.parameters = [];
  }

  /** 0x180039880. */
  seekTo(t: number): void {
    if (!this.file) return;
    this.timeRunning = f32(Math.max(t, 0));
    this.time = Math.min(this.timeRunning, this.lastTime);
    this.jumped = true;
    this.starting = true;
  }

  /** 0x18003e530: drops every node but the root and the nested clips. */
  reset(): void {
    this.top.combinators?.unregister(this);
    for (const n of this.subNodes) n.sub?.destroy();
    this.layerNodes.length = 1;
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
          layer.parameterize !== null ? (this.parameters[layer.parameterize] ?? null) : null;
        const node = new Node(this, layer, this.layerNodes.length, parent, param);
        this.layerNodes.push(node);
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
    for (const node of this.layerNodes) {
      if (node.meshKind !== 0 && node.hasCombinator) {
        this.top.combinators ??= new EmoteMeshCombinators(this.top, EMOTEDRIVER_X64_SHA256);
        this.top.combinators.register(node, node.layer!.mesh!.combinators!, this);
      }
    }
    for (const node of this.stencilNodes) {
      if (!(node.stencilType & 4)) continue;
      // 0x18003eef0.
      for (const label of node.layer?.stencilCompositeMaskLayerList ?? []) {
        const i = this.layerIndexMap?.get(label);
        const mask = i !== undefined ? this.layerNodes[i + 1] : undefined;
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
    if (sub.independentInherit) sub.root.adjust.changed = true;
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

  /** 0x18003f720: compatibility entry point for the combined native pass. */
  progress(frames: number): void {
    this.advance(frames);
    this.evaluate();
    this.dispatchEvents();
  }

  /** Queue/combinator phase followed by the shared clip clock. */
  override advance(frames: number): void {
    this.advanceHeld = false;
    if (this.queued) {
      const name = this.queued,
        flags = this.queuedFlags;
      this.queued = '';
      this.setMotion(name, flags & ~0x60);
      if (flags & 0x40) {
        this.advanceHeld = true;
        return;
      }
    }
    this.combinators?.update();
    super.advance(f32(frames));
  }

  evaluate(): void {
    if (this.advanceHeld) return;
    this.calc();
    this.drawList.length = 0;
    this.buildDrawList(this.color, null);
  }

  /** The x64 player retires actions without the x86 listener callback. */
  dispatchEvents(_listener?: EmoteClipListener): void {
    if (!this.advanceHeld) this.layerEvents = [];
  }

  /** 0x18003f600: nested clips skip the top-level queue/combinator phase. */
  progressSub(frames: number): void {
    super.advance(frames);
    this.calc();
  }

  private timeOf(node: Node): number {
    return node.param ? node.param.value : this.time;
  }

  private pushAct(node: Node): void {
    if (node.cur.mask & 0x40000 && node.cur.act)
      this.layerEvents.push({type: 0, layer: node.layer?.label ?? '', label: node.cur.act});
  }

  /** 0x18003fc30. */
  protected resetFrames(): void {
    const pr = this.priority;
    if (pr.length) {
      let idx = this.prIndex;
      for (let i = 0; i < pr.length; i++) {
        if (pr[i]!.time === this.time) {
          idx = i;
          break;
        }
        if (this.time < pr[i]!.time) {
          idx = Math.max(i - 1, 0);
          break;
        }
      }
      this.prIndex = Math.min(idx, Math.max(pr.length - 2, 0));
      this.order = pr[this.prIndex]!.order;
    }
    for (let k = 1; k < this.layerNodes.length; k++) {
      const n = this.layerNodes[k]!;
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
      n.cur = n.stateAt(idx);
      n.next = n.stateAt(idx + 1);
      n.framesDirty = true;
      if ((0x1801 >> n.type) & 1) n.resolveSource(this, n.cur);
      if (n.cur.time === t) this.pushAct(n);
    }
  }

  /** 0x180040cb0. */
  protected scanForward(): void {
    const pr = this.priority;
    while (
      pr.length >= 2 &&
      this.prIndex < pr.length - 2 &&
      this.time >= pr[this.prIndex + 1]!.time
    ) {
      this.prIndex++;
      this.order = pr[this.prIndex]!.order;
    }
    for (let k = 1; k < this.layerNodes.length; k++) {
      const n = this.layerNodes[k]!;
      if (n.param) {
        this.stepParamNode(n);
        continue;
      }
      let stepped = false;
      while (n.cur.index < n.count - 2) {
        if (this.time < n.next.time) break;
        const next = n.stateAt(n.next.index + 1);
        n.cur = n.next;
        n.next = next;
        stepped = true;
        this.pushAct(n);
      }
      if (!stepped) continue;
      n.framesDirty = true;
      if ((0x1801 >> n.type) & 1) n.resolveSource(this, n.cur);
    }
  }

  /** 0x1800415e0. */
  protected scanBackward(): void {
    const pr = this.priority;
    while (pr.length && this.prIndex > 0 && this.time < pr[this.prIndex]!.time) {
      this.prIndex--;
      this.order = pr[this.prIndex]!.order;
    }
    for (let k = 1; k < this.layerNodes.length; k++) {
      const n = this.layerNodes[k]!;
      if (n.param) {
        this.stepParamNode(n);
        continue;
      }
      if (!(this.time < n.cur.time) || n.cur.index === 0) continue;
      while (this.time < n.cur.time && n.cur.index > 0) {
        const prev = n.stateAt(n.cur.index - 1);
        n.next = n.cur;
        n.cur = prev;
        this.pushAct(n);
      }
      n.framesDirty = true;
      if ((0x1801 >> n.type) & 1) n.resolveSource(this, n.cur);
    }
  }

  /** 0x180040a60. */
  protected scanParameterNodes(): void {
    for (let k = 1; k < this.layerNodes.length; k++) {
      const n = this.layerNodes[k]!;
      if (n.param) this.stepParamNode(n);
    }
  }

  /** 0x180040860. */
  private stepParamNode(n: Node): void {
    const v = n.param!.value;
    let stepped = false;
    while (n.cur.index < n.count - 2 && n.next.time <= v) {
      const next = n.stateAt(n.next.index + 1);
      n.cur = n.next;
      n.next = next;
      stepped = true;
    }
    if (n.cur.time <= v) {
      if (!stepped) return;
    } else {
      while (v < n.cur.time && n.cur.index > 0) {
        const prev = n.stateAt(n.cur.index - 1);
        n.next = n.cur;
        n.cur = prev;
      }
    }
    n.framesDirty = true;
    if ((0x1801 >> n.type) & 1) n.resolveSource(this, n.cur);
  }

  // Evaluation -------------------------------------------------------------------------

  /** 0x1800422f0: native scalar slot evaluation through the shared frame interface. */
  evaluateFrame(n: Node, force: boolean): boolean {
    return evaluateScalarFrame(this, n, force);
  }

  /** Native x64 mesh synchronization, supplied through the layer-pass interface. */
  readonly syncToParentMesh = syncToParentMeshX64;

  /** Complete native scalar evaluation through its typed receiver. */
  private calc(): void {
    this.layerPass.evaluateScalarClip<Node>(this);
  }

  /** 0x180045c50: nested motion through its shared runtime interface. */
  evaluateSubclips(): void {
    const flags = this.motionParameter ? this.motionParameter.flags : 0;
    evaluateScalarMotions<Node>(this, this.subNodes, flags);
  }

  // Draw list --------------------------------------------------------------------------

  /** 0x180048c70: native draw construction through its runtime interface. */
  buildDrawList(color: number, collector: EmoteDrawItem[] | null): void {
    buildScalarDrawList(this, color, collector);
  }
}

/** Degrees per radian as the clip computes it. */
export const EMOTE_RAD_TO_DEG = RAD_TO_DEG;

/** Options of the private x64 clip factory used by the native player core. */
export interface EmoteScalarClipFactoryOptions {
  readonly kernel?: EmoteX64MeshKernel;
}

/**
 * Bind a player's immutable motion-file group without a concrete player/renderer.
 * Every call creates a fresh scalar clip; clips share the group's resource and
 * mesh kernel. The requested motion retains its own file as the first lookup
 * owner, including when another file defines the same object/motion or icon.
 */
export function emoteScalarClipFactory(
  files: readonly EmoteModel[],
  options: EmoteScalarClipFactoryOptions = {},
): EmoteClipFactory {
  if (files.length === 0) throw new RangeError('E-mote player requires a motion file');
  const group = [...files],
    resource = new EmoteResource(group, options.kernel),
    motions = new WeakMap<object, {file: EmoteModel; object: string; label: string}>();
  for (const file of group)
    for (const [object, value] of file.objects)
      for (const [label, motion] of value.motions) motions.set(motion, {file, object, label});
  return (motion) => {
    const selected = motions.get(motion);
    if (!selected) throw new TypeError('E-mote motion is outside the player file group');
    const clip = new EmoteMotionClip(resource);
    clip.file = selected.file;
    clip.selectObject(selected.object);
    clip.setMotion(selected.label);
    return clip;
  };
}

import type {
  EmoteLayer,
  EmoteModel,
  EmoteMotion,
} from '../../../../formats/kirikiri/emote-model.js';
import type {PsbObject, PsbValue} from '../../../../formats/kirikiri/psb.js';
import type {
  EmoteClipDriver,
  EmoteClipEvent,
  EmoteClipListener,
  EmoteClipPlayerAccess,
  EmoteMeshKernel,
  EmoteRootTransform,
} from '../interfaces.js';
import {createEmoteMeshKernel} from '../mesh/index.js';
import {EmoteClipUnsupportedError, loadContent, loadHeader, type FrameSlot} from './frame.js';
import {evaluateBlockFrame, roundHalfEven} from './interpolate.js';
import {evaluateBlockMotions} from './nested.js';
import {ClipParameter, EmoteNode} from './node.js';
import {EmoteClipTime} from './time.js';
import {EmoteSourceResolver} from './source.js';
import {EmoteLayerPass} from './layer.js';
import {syncToParentMeshX86} from './vertices.js';
import {composeEmoteMatrix, multiplyEmoteMatrices as multiply} from './matrix.js';

/**
 * `MMotionPlayer` of `emotedriver.dll` (SHA-256 `a3b693b6…5e70b3a86`): one motion clip with
 * its layer nodes, clip time and the layer pass. The typed model replaces the PSB views the
 * native clip reads lazily; frame headers and contents are still loaded at the points the
 * native scans load them, because stale slot data is observable (a frame without `mesh`
 * keeps the slot's previous patch).
 *
 * Offsets in comments are `MMotionPlayer` fields. x87 arithmetic runs in double and rounds
 * with `Math.fround` where the native code stores a float.
 */

const f = Math.fround;
let nodeIds = 0;

export interface EmoteClipOptions {
  /** Mesh kernel; default the Wasm kernel with its TypeScript twin as fallback. */
  readonly kernel?: EmoteMeshKernel;
  /** `meshDivisionRatio` (+0x358); default 1. */
  readonly meshDivisionRatio?: number;
  /** Load flags of 0x10033810; bit 2 starts the clip without the initial seek. */
  readonly loadFlags?: number;
  /**
   * `MMotionManager` +0x54: factor applied to z when the mesh pass places a layer
   * (`y + z·k`, 0x1003f9c0). Zeroed by the manager constructor 0x1002b6f0; no writer was found.
   */
  readonly zProjection?: number;
  /** Texture index of a source (node +0x90); the renderer's `textureIndexOf`. Default -1. */
  readonly textureIndexOf?: (source: string) => number;
}

/** Layer types the runtime does not evaluate (census: none in NEKOPARA `emotewin`). */
const UNSUPPORTED_TYPES = new Map([
  [4, 'particle (0x100424a0)'],
  [5, 'type 5 (0x100442c0)'],
  [6, 'type 6 (0x10042120)'],
  [9, 'anchor (0x10040900)'],
  [10, 'screenBounds (0x100444b0)'],
]);

export class EmoteClip extends EmoteClipTime implements EmoteClipDriver, EmoteClipPlayerAccess {
  readonly kernel: EmoteMeshKernel;
  /** +0x0c referencing clip, +0x08 top clip. */
  readonly parentClip: EmoteClip | null;
  readonly top: EmoteClip;
  readonly zProjection: number;
  readonly textureIndexOf: (source: string) => number;
  private ratio: number;
  private readonly sources: EmoteSourceResolver;
  private readonly layerPass = new EmoteLayerPass();
  /** +0x1b4: secondary draw sort key, inherited by nested clips (0x10033c60). */
  drawPriority = 0;

  /** +0x10/+0x2c object and motion names (nested clips). */
  objectName = '';
  motionName = '';
  motion: EmoteMotion | null = null;
  nodes: EmoteNode[] = [];
  private layerIndex: ReadonlyMap<string, number> | null = null;
  parameters: ClipParameter[] = [];
  /** +0x310: parameters of this clip and its nested clips by id. */
  readonly parameterMap = new Map<string, ClipParameter[]>();
  /** +0x354 parameter driving clip time. */
  motionParameter: ClipParameter | null = null;
  /** +0x320 applied variable values, +0x330 path variables. */
  readonly variables = new Map<string, number>();
  readonly pathVariables = new Map<string, number>();

  /** +0x110 playing, +0x111 time set (no step this frame), +0x112, +0x113 start, +0x114 replay events, +0x115 force. */
  flag112 = true;
  force = false;
  /** +0x128..+0x130 root velocity, +0x134 decay. */
  readonly rootVelocity = new Float32Array(3);
  decay = 1;
  /** +0x150 colour. */
  color = 0x808080ff;
  /** +0x2fc independent layer inherit, +0x2fd nested (root frame set by the parent). */
  independent = false;
  nested = false;
  /** +0x2c8 OR of 1 << layer type. */
  features = 0;
  /** +0x184.. priority cursor and +0x194 draw order (node indices). */
  private priority: readonly PsbValue[] = [];
  private priorityIndex = 0;
  private priorityTime = 0;
  private priorityNext = 0;
  drawOrder: number[] = [];
  /** +0x1c4.. tag cursor. */
  private tags: readonly PsbValue[] = [];
  private tagIndex = 0;
  private tagTime = 0;
  private tagNext = 0;
  /** +0x22c queued events. */
  events: EmoteClipEvent[] = [];
  /** +0x23c shape nodes, +0x24c motion-reference nodes. */
  shapeNodes: EmoteNode[] = [];
  motionNodes: EmoteNode[] = [];

  constructor(
    readonly model: EmoteModel,
    parent: EmoteClip | null,
    options: EmoteClipOptions = {},
  ) {
    super();
    this.parentClip = parent;
    this.top = parent?.top ?? this;
    this.kernel = options.kernel ?? parent?.kernel ?? createEmoteMeshKernel();
    this.zProjection = options.zProjection ?? parent?.zProjection ?? 0;
    this.textureIndexOf = options.textureIndexOf ?? parent?.textureIndexOf ?? (() => -1);
    this.sources = new EmoteSourceResolver([model], undefined, this);
    this.drawPriority = parent?.drawPriority ?? 0;
    this.ratio = f(options.meshDivisionRatio ?? 1);
    // 0x1002eab0: the root node; its adjustment block is hidden (+0x282 = 0) until `Show`.
    const root = new EmoteNode(0, null, -1, null, ++nodeIds, model.easing);
    root.adjust.shown = false;
    this.nodes = [root];
  }

  /** Node by label here or in nested clips (0x10033e10 / 0x10033f40 over +0x2ec). */
  findNode(label: string): EmoteNode | null {
    const i = this.nodeIndex(label);
    if (i >= 0) return this.nodes[i] ?? null;
    for (const n of this.motionNodes) {
      const found = (n.child as EmoteClip | null)?.findNode(label);
      if (found) return found;
    }
    return null;
  }

  /** Physics base point: shape record point of a type-1 layer with shape kind 0. */
  shapePoint(label: string): {readonly x: number; readonly y: number} | null {
    const node = this.findNode(label);
    if (!node || node.type !== 1 || !node.shape || node.shape[0] !== 0) return null;
    return {x: node.shape[1]!, y: node.shape[2]!};
  }

  /** +0x2ac: nodes with `stencilType & 4`. */
  get stencilCompositeNodes(): number[] {
    return this.nodes.filter((n) => n.stencilType & 4).map((n) => n.index);
  }

  /** +0x111: the clip time was just set; the draw list skips the clip. */
  get drawSuppressed(): boolean {
    return this.jumped;
  }

  get root(): EmoteNode {
    return this.nodes[0]!;
  }

  // ---------------------------------------------------------------------------------------
  // Loading

  /** 0x10033810 with 0x10039df0 and 0x1003a4c0: builds the nodes of `motion`. */
  load(motion: EmoteMotion, flags = 0): void {
    if (motion.unread.type !== undefined && Number(motion.unread.type) !== 0)
      throw new EmoteClipUnsupportedError('multi-angle motions (type 1, 0x10033320)');
    const variable = motion.unread.variable;
    if (Array.isArray(variable) && variable.length)
      throw new EmoteClipUnsupportedError('motion variable tracks (0x10038dc0)');
    this.unregisterParameters();
    this.motion = motion;
    this.priority = motion.priority;
    this.tags = motion.tag;
    this.loopTime = f(motion.loopTime);
    this.lastTime = f(motion.lastTime);
    this.parameters = motion.parameters.map(
      (p) =>
        new ClipParameter(p.id, p.discretization, f(p.rangeBegin), f(p.rangeEnd), f(p.division)),
    );
    for (const p of this.parameters) {
      // 0x10030bc0: the initial position follows a value already applied up the clip chain.
      let value = 0;
      for (let c: EmoteClip | null = this; c; c = c.parentClip) {
        const v = c.variables.get(p.id);
        if (v !== undefined) {
          value = v;
          break;
        }
      }
      p.apply(value);
    }
    for (let c: EmoteClip | null = this; c; c = c.parentClip)
      for (const p of this.parameters) {
        const list = c.parameterMap.get(p.id);
        if (list) list.push(p);
        else c.parameterMap.set(p.id, [p]);
      }
    this.motionParameter =
      motion.parameterize === null ? null : this.parameters[motion.parameterize]!;
    this.playing = true;
    this.syncStop = false;
    this.layerIndex = motion.layerIndexMap;
    const root = this.root;
    this.nodes = [root];
    this.features = 0;
    this.shapeNodes = [];
    this.motionNodes = [];
    const walk = (layers: readonly EmoteLayer[], parent: number) => {
      for (const layer of layers) {
        const index = this.nodes.length;
        const unsupported = UNSUPPORTED_TYPES.get(layer.type);
        if (unsupported) throw new EmoteClipUnsupportedError(`layer ${unsupported}`);
        if (layer.groundCorrection)
          throw new EmoteClipUnsupportedError('groundCorrection (0x1003ec30)');
        const param = layer.parameterize === null ? null : this.parameters[layer.parameterize]!;
        const node = new EmoteNode(index, layer, parent, param, ++nodeIds, this.model.easing);
        this.nodes.push(node);
        this.features |= 1 << layer.type;
        if (layer.type === 1) this.shapeNodes.push(node);
        if (layer.type === 3) {
          this.motionNodes.push(node);
          const child = new EmoteClip(this.model, this);
          child.nested = true;
          child.independent = layer.motionIndependentLayerInherit ?? false;
          child.root.overrideFrame(layer.coordinate, layer.transformOrder);
          node.child = child;
        }
        walk(layer.children, index);
      }
    };
    walk(motion.layers, 0);
    for (const node of this.nodes)
      if (node.stencilType & 4 && node.stencilCompositeMaskLayers)
        node.compositeMaskNodes = node.stencilCompositeMaskLayers
          .map((label) => this.nodes[this.nodeIndex(label)])
          .filter((n): n is EmoteNode => n !== undefined);
    if (flags & 2) this.starting = true;
    else this.seek(0);
  }

  /** 0x10039620: drops the layer nodes (the root stays). */
  unload(): void {
    this.unregisterParameters();
    this.nodes = [this.root];
    this.shapeNodes = [];
    this.motionNodes = [];
    this.features = 0;
    this.layerIndex = null;
    this.drawOrder = [];
  }

  private unregisterParameters(): void {
    for (const p of this.parameters)
      for (let c: EmoteClip | null = this; c; c = c.parentClip) {
        const list = c.parameterMap.get(p.id);
        const i = list?.indexOf(p) ?? -1;
        if (i >= 0) list!.splice(i, 1);
      }
    this.parameters = [];
    this.motionParameter = null;
  }

  /** 0x10033c00: sets the clip time, clamped to [0, lastTime]. */
  seek(time: number): void {
    this.timeRunning = f(Math.max(time, 0));
    this.time = this.lastTime <= this.timeRunning ? this.lastTime : this.timeRunning;
    this.jumped = true;
    this.starting = true;
  }

  // ---------------------------------------------------------------------------------------
  // EmoteClipNodes / player access

  nodeIndex(label: string): number {
    const i = this.layerIndex?.get(label);
    return i === undefined ? -1 : i + 1;
  }

  get rootVisible(): boolean {
    return this.root.adjust.shown;
  }
  set rootVisible(visible: boolean) {
    // 0x10010850 / 0x100108a0.
    const a = this.root.adjust;
    if (a.shown !== visible) {
      a.changed = true;
      a.shown = visible;
    }
  }

  get meshDivisionRatio(): number {
    return this.top.ratio;
  }
  set meshDivisionRatio(ratio: number) {
    this.top.ratio = f(ratio);
  }

  /** 0x100320b0: last value applied to the variable, 0 when none. */
  getVariable(label: string): number {
    const split = splitVariable(label);
    if (split) return this.pathVariables.get(label) ?? 0;
    return this.variables.get(label) ?? 0;
  }

  /** 0x10032950: any node of this clip or its nested clips recomputed its vertices. */
  isModified(): boolean {
    for (const n of this.nodes) {
      if (n.meshDirty) return true;
      if (n.child && (n.child as EmoteClip).isModified()) return true;
    }
    return false;
  }

  /**
   * 0x100319f0. A plain label sets the value in the clip's map (+0x320) and the position of
   * every parameter with that id here and in nested clips (0x10031940). `path::name` or
   * `path/name` targets the nested clips under the layer path (map +0x330, 0x10031670).
   */
  applyVariable(label: string, value: number): void {
    value = f(value);
    const split = splitVariable(label);
    if (!split) {
      this.variables.set(label, value);
      this.applyParameters(label, value);
      return;
    }
    this.pathVariables.set(label, value);
    const [path, name] = split;
    const parts = path.split('/');
    for (const node of this.nodes) {
      if (node.type !== 3 || !node.child) continue;
      const chain: string[] = [];
      for (let n: EmoteNode | undefined = node; n && n.index !== 0; n = this.nodes[n.parent])
        chain.unshift(n.label);
      if (chain.length === parts.length && chain.every((c, i) => c === parts[i]))
        (node.child as EmoteClip).applyParameters(name, value);
    }
  }

  private applyParameters(id: string, value: number): void {
    for (const p of this.parameterMap.get(id) ?? []) p.apply(value);
  }

  setRootTransform(t: EmoteRootTransform): void {
    // 0x1001b5f0: each value is written, and the root marked dirty, only when it changes.
    const a = this.root.adjust,
      x = f(t.x),
      y = f(t.y),
      sx = f(t.scaleX),
      sy = f(t.scaleY),
      angle = f(t.angle);
    if (x !== a.x || y !== a.y) {
      a.changed = true;
      a.x = x;
      a.y = y;
    }
    if (sx !== a.zoomX || sy !== a.zoomY) {
      a.changed = true;
      a.zoomX = sx;
      a.zoomY = sy;
    }
    if (angle !== a.angle) {
      a.changed = true;
      a.angle = angle;
    }
    if (t.mirror !== a.flipX) {
      a.changed = true;
      a.flipX = t.mirror;
    }
  }

  // ---------------------------------------------------------------------------------------
  // Time

  /** Frame index search of the seek (0x1003afd0), including its out-of-range results. */
  private static findFrame(
    times: (i: number) => number,
    count: number,
    t: number,
    prev: number,
  ): number {
    let index = prev;
    for (let i = 0; i < count; i++) {
      const time = times(i);
      if (t === time) {
        index = i;
        break;
      }
      if (t < time) {
        index = (i - 1) >>> 0;
        break;
      }
    }
    // min(index, count - 2) as unsigned.
    const limit = (count - 2) >>> 0;
    return index >>> 0 <= limit ? index >>> 0 : limit;
  }

  /** 0x1003afd0: reloads tags, priority and every node's two frames at the clip time. */
  resetFrames(): void {
    const t = this.time;
    if (this.tags.length >= 2) {
      this.tagIndex = EmoteClip.findFrame(
        (i) => psbTime(this.tags[i]),
        this.tags.length,
        t,
        this.tagIndex,
      );
      this.tagTime = psbTime(this.tags[this.tagIndex]);
      this.tagNext = psbTime(this.tags[this.tagIndex + 1]);
      const tag = psbObject(this.tags[this.tagIndex]);
      if (tag && Number(tag.type) === 1) {
        const content = psbObject(tag.content)!;
        if (this.tagTime === this.time && content.align) {
          this.alignStop = true;
          this.time = this.timeRunning = this.tagTime;
        }
        this.tagContent(content, false);
      }
    }
    if (this.priority.length >= 2) {
      this.priorityIndex = EmoteClip.findFrame(
        (i) => psbTime(this.priority[i]),
        this.priority.length,
        t,
        this.priorityIndex,
      );
      this.priorityTime = psbTime(this.priority[this.priorityIndex]);
      this.priorityNext = psbTime(this.priority[this.priorityIndex + 1]);
      this.applyPriority();
    }
    for (let i = 1; i < this.nodes.length; i++) {
      const node = this.nodes[i]!,
        frames = node.layer!.frames;
      const nt = node.parameter ? node.parameter.position : this.time;
      const index = EmoteClip.findFrame((k) => frames[k]!.time, frames.length, nt, 0);
      this.loadFrame(node, 0, index);
      this.loadFrame(node, 1, index + 1);
      loadContent(node.slots[0], frames, node.type, this.model);
      loadContent(node.slots[1], frames, node.type, this.model);
      node.current = 0;
      node.framesDirty = true;
      if ((1 << node.type) & 0x1801) this.resolveSource(node, node.slots[0]);
      const cur = node.slots[0];
      if (nt === cur.time && cur.mask & 0x40000)
        this.events.push({type: 0, layer: node.label, label: cur.act ?? ''});
    }
  }

  private loadFrame(node: EmoteNode, slot: number, index: number): void {
    loadHeader(node.slots[slot]!, node.layer!.frames, index);
  }

  /** Tag content: `sync` stops the clip at the tag and queues a sync; `action` queues an action. */
  private tagContent(content: PsbObject, checkAlign: boolean): void {
    if (checkAlign && content.align) {
      this.alignStop = true;
      this.time = this.timeRunning = this.tagTime;
    }
    if (content.sync) {
      this.syncStop = true;
      this.time = this.timeRunning = this.tagTime;
      this.events.push({type: 1, layer: '', label: ''});
    }
    const action = typeof content.action === 'string' ? content.action : '';
    if (action !== '') this.events.push({type: 0, layer: '', label: action});
  }

  /** 0x1003a780: draw order from the current priority frame (layer index + 1 = node index). */
  private applyPriority(): void {
    const frame = psbObject(this.priority[this.priorityIndex]);
    const content = frame?.content;
    this.drawOrder = Array.isArray(content) ? content.map((v) => Number(v) + 1) : [];
  }

  /** 0x1003c680: steps tags, priority and nodes forward to the clip time. */
  scanForward(): void {
    const t = this.time;
    if (this.tags.length >= 2)
      while (this.tagIndex < this.tags.length - 2) {
        if (t < this.tagNext) break;
        this.tagIndex++;
        this.tagTime = this.tagNext;
        this.tagNext = psbTime(this.tags[this.tagIndex + 1]);
        const tag = psbObject(this.tags[this.tagIndex]);
        if (tag && Number(tag.type) === 1) this.tagContent(psbObject(tag.content)!, true);
      }
    if (this.priority.length >= 2)
      while (this.priorityIndex < this.priority.length - 2) {
        if (t < this.priorityNext) break;
        this.priorityIndex++;
        this.priorityTime = this.priorityNext;
        this.priorityNext = psbTime(this.priority[this.priorityIndex + 1]);
        this.applyPriority();
      }
    for (let i = 1; i < this.nodes.length; i++) {
      const node = this.nodes[i]!;
      if (node.parameter) {
        this.scanParameterNode(node);
        continue;
      }
      const frames = node.layer!.frames,
        last = frames.length - 2;
      if (!(node.cur.index < last)) continue;
      let moved = false;
      while (node.cur.index < last) {
        if (this.time < node.next.time) break;
        const old = node.cur;
        node.current ^= 1;
        moved = true;
        loadHeader(old, frames, node.cur.index + 1);
        this.queueAct(node, node.cur);
      }
      if (!moved) continue;
      this.reloadContents(node);
    }
  }

  /** 0x1003d270: steps tags, priority and nodes backward to the clip time. */
  scanBackward(): void {
    const t = this.time;
    if (this.tags.length >= 2)
      while (t < this.tagTime && this.tagIndex > 0) {
        this.tagIndex--;
        this.tagNext = this.tagTime;
        this.tagTime = psbTime(this.tags[this.tagIndex]);
        const tag = psbObject(this.tags[this.tagIndex]);
        if (tag && Number(tag.type) === 1) this.tagContent(psbObject(tag.content)!, true);
      }
    if (this.priority.length >= 2)
      while (t < this.priorityTime && this.priorityIndex > 0) {
        this.priorityIndex--;
        this.priorityNext = this.priorityTime;
        this.priorityTime = psbTime(this.priority[this.priorityIndex]);
        this.applyPriority();
      }
    for (let i = 1; i < this.nodes.length; i++) {
      const node = this.nodes[i]!;
      if (node.parameter) {
        this.scanParameterNode(node);
        continue;
      }
      if (!(this.time < node.cur.time)) continue;
      const frames = node.layer!.frames;
      // Native has no lower bound; a time before frame 0 stops at frame 0 here.
      do {
        const old = node.next,
          index = node.cur.index - 1;
        node.current ^= 1;
        loadHeader(old, frames, index);
        this.queueAct(node, node.cur);
      } while (this.time < node.cur.time && node.cur.index > 0);
      this.reloadContents(node);
    }
  }

  /** 0x1003c470: parameter-driven nodes only. */
  scanParameterNodes(): void {
    for (let i = 1; i < this.nodes.length; i++) {
      const node = this.nodes[i]!;
      if (node.parameter) this.scanParameterNode(node);
    }
  }

  /** 0x1003c310: moves a parameter-driven node to its parameter position (no events). */
  private scanParameterNode(node: EmoteNode): void {
    const t = node.parameter!.position,
      frames = node.layer!.frames,
      last = frames.length - 2;
    let moved = false;
    while (node.cur.index < last && node.next.time <= t) {
      const old = node.cur;
      node.current ^= 1;
      moved = true;
      loadHeader(old, frames, node.cur.index + 1);
    }
    if (node.cur.time <= t) {
      if (!moved) return;
    } else {
      do {
        const old = node.next,
          index = node.cur.index - 1;
        node.current ^= 1;
        loadHeader(old, frames, index);
      } while (t < node.cur.time && node.cur.index > 0);
    }
    this.reloadContents(node);
  }

  private reloadContents(node: EmoteNode): void {
    node.framesDirty = true;
    for (const slot of node.slots)
      if (!slot.loaded) loadContent(slot, node.layer!.frames, node.type, this.model);
    if ((1 << node.type) & 0x1801) this.resolveSource(node, node.cur);
  }

  private queueAct(node: EmoteNode, slot: FrameSlot): void {
    if (slot.mask & 0x40000) this.events.push({type: 0, layer: node.label, label: slot.act ?? ''});
  }

  /**
   * 0x10038a30: resolves `src`/`icon` of the current frame into the icon rectangle when they
   * change. `src: "blank"` takes "width:height:originX:originY" from `icon` and marks the
   * layer hidden (size only). For mesh layers the grid divisions are derived here.
   */
  private resolveSource(node: EmoteNode, slot: FrameSlot): void {
    if (slot.empty) return;
    const r = node.resolved;
    if (r.srcKey === slot.src && r.iconKey === slot.icon) return;
    if (!this.sources.resolve(r, slot, this.model)) return;
    if (node.mesh) {
      const w = r.rect[2]!,
        h = r.rect[3]!;
      const division = roundHalfEven(f(node.meshDivision >>> 0) * this.meshDivisionRatio) >>> 0;
      const columns = Math.trunc(Math.imul(w, division) >>> 0) / ((h + w) >>> 0);
      node.mesh.columns = (Math.trunc(columns) >>> 0) + 1;
      node.mesh.rows = ((division - Math.trunc(columns)) >>> 0) + 1;
    }
  }

  // ---------------------------------------------------------------------------------------
  // Layer pass

  /** Complete native array/block evaluation through its typed receiver. */
  evaluate(): void {
    this.layerPass.evaluateBlockClip<EmoteNode>(this);
  }

  evaluateFrame(node: EmoteNode, force: boolean): boolean {
    return evaluateBlockFrame(this, node, force);
  }

  readonly syncToParentMesh = syncToParentMeshX86;

  /** 0x10041510: nested motion through its shared runtime interface. */
  evaluateMotions(): void {
    const flags = this.motionParameter?.flags ?? 0;
    evaluateBlockMotions<EmoteNode>(this, this.motionNodes, flags);
  }

  /** 0x10032c70 / 0x10032d70: a different object name stops the clip and clears its motion. */
  selectObject(name: string): void {
    if (name === this.objectName) return;
    this.objectName = name;
    this.motionName = '';
    this.playing = false;
  }

  /** 0x10032fa0 / 0x10033020: (re)loads the named motion of the object. */
  selectMotion(name: string, flags: number): void {
    if (flags & 0x10 && this.motionName === '') {
      this.motionName = name;
      return;
    }
    if (!(flags & 5) && name === this.motionName) return;
    if (!(flags & 1) && this.playing && flags & 4) return;
    if (flags & 8) throw new EmoteClipUnsupportedError('motion flag 8 (0x100456b0)');
    const motion = this.model.objects.get(this.objectName)?.motions.get(name);
    this.motionName = name;
    if (!motion) {
      this.motion = null;
      this.playing = false;
      return;
    }
    this.load(motion, flags);
  }

  // ---------------------------------------------------------------------------------------
  // Events and state

  dispatchEvents(listener: EmoteClipListener): void {
    // 0x10033fe0.
    const events = this.events;
    this.events = [];
    for (const e of events)
      if (e.type === 0) listener.action(this, e.label);
      else if (e.type === 1) listener.sync?.(this);
  }

  /**
   * Copy constructor 0x1002f370 (field copy 0x100301e0): time, flags, slots, node state and
   * nested clips. Per-pass links (mesh parent, mask source, clip rectangle, grids) are
   * recomputed by the next layer pass, and the root is marked dirty. Clip time is kept.
   */
  assignState(source: EmoteClipDriver): void {
    if (!(source instanceof EmoteClip)) throw new TypeError('assignState: not an EmoteClip');
    const s = source;
    if (s.motion !== this.motion || s.nodes.length !== this.nodes.length) {
      this.objectName = s.objectName;
      this.motionName = s.motionName;
      if (s.motion) this.load(s.motion, 2);
      else this.unload();
    }
    for (const key of SCALAR_FIELDS) (this as Record<string, unknown>)[key] = s[key];
    this.rootVelocity.set(s.rootVelocity);
    this.drawOrder = s.drawOrder.slice();
    this.events = s.events.slice();
    for (const [k, v] of s.variables) this.variables.set(k, v);
    for (const [k, v] of s.pathVariables) this.pathVariables.set(k, v);
    this.parameters.forEach((p, i) => {
      p.position = s.parameters[i]!.position;
      p.flags = s.parameters[i]!.flags;
    });
    this.nodes.forEach((n, i) => {
      const o = s.nodes[i]!;
      n.slots[0].copyFrom(o.slots[0]);
      n.slots[1].copyFrom(o.slots[1]);
      n.current = o.current;
      n.lastT = o.lastT;
      n.framesDirty = o.framesDirty;
      n.meshDirty = o.meshDirty;
      n.singleColor = o.singleColor;
      n.colorUnset = o.colorUnset;
      n.colors.set(o.colors);
      n.matrix.set(o.matrix);
      n.velocity.set(o.velocity);
      n.meshPosition.set(o.meshPosition);
      n.resolved.copyFrom(o.resolved);
      n.state.copyFrom(o.state);
      n.adjust.copyFrom(o.adjust);
      if (n.mesh && o.mesh) n.mesh.copyFrom(o.mesh);
      n.meshActive = o.meshActive;
      n.meshIndependent = o.meshIndependent;
      n.isMask = o.isMask;
      n.meshParent = null;
      n.maskNode = null;
      n.clipRect = null;
      n.gridData = null;
      if (n.child && o.child) {
        const c = n.child as EmoteClip,
          oc = o.child as EmoteClip;
        c.objectName = oc.objectName;
        c.motionName = oc.motionName;
        c.assignState(oc);
      }
    });
    this.root.adjust.changed = true;
  }
}

const SCALAR_FIELDS = [
  'playing',
  'jumped',
  'flag112',
  'starting',
  'replay',
  'force',
  'syncStop',
  'alignStop',
  'timeRunning',
  'time',
  'speed',
  'step',
  'loopTime',
  'lastTime',
  'decay',
  'color',
  'independent',
  'nested',
  'priorityIndex',
  'priorityTime',
  'priorityNext',
  'tagIndex',
  'tagTime',
  'tagNext',
] as const;

// -----------------------------------------------------------------------------------------

/** 0x1003dd30: compose the evaluated node's local frame. */
export function computeMatrix(node: EmoteNode): void {
  composeEmoteMatrix(node.state, node.transformOrder, node.matrix);
}

/**
 * The partial-inherit bits of the layer pass: 0x4 flipX, 0x8 flipY (xor), 0x10 angle
 * (add), 0x20/0x40 zoom (multiply), 0x80/0x100 slant (add). `sign` -1 removes `p` again.
 */

/**
 * 0x1003e890: a parent mesh with `meshSyncChildMask` bit 1 moves the child's coordinate
 * through its patch. Bits 2 (angle) and 4 (zoom) are not used by NEKOPARA (census: masks 0
 * and 8 only) and are rejected.
 */
/** 0x100314c0: "path::name" or "path/name" (the first `::`, else the first `/`). */
function splitVariable(label: string): [string, string] | null {
  let i = label.indexOf('::');
  if (i >= 0) return [label.slice(0, i), label.slice(i + 2)];
  i = label.indexOf('/');
  if (i >= 0) return [label.slice(0, i), label.slice(i + 1)];
  return null;
}

function psbObject(v: PsbValue | undefined): PsbObject | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Uint8Array)
    ? (v as PsbObject)
    : null;
}

function psbTime(v: PsbValue | undefined): number {
  return f(Number(psbObject(v)?.time ?? 0));
}

/** Creates the clip for `motion` and loads it (0x1002eab0, 0x10033810). */
export function createEmoteClip(
  model: EmoteModel,
  motion: EmoteMotion,
  options: EmoteClipOptions = {},
): EmoteClip {
  const clip = new EmoteClip(model, null, options);
  clip.load(motion, options.loadFlags ?? 0);
  return clip;
}

/** `EmoteClipFactory` for the player core, bound to a model. */
export function emoteClipFactory(
  model: EmoteModel,
  options: EmoteClipOptions = {},
): (motion: EmoteMotion) => EmoteClip {
  return (motion) => createEmoteClip(model, motion, options);
}

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
import {
  IDENTITY_PATCH,
  lerp,
  lerpAngle,
  lerpColor,
  lerpCoord,
  lerpPatch,
  patchPoint,
  roundHalfAway,
  roundHalfEven,
  truncate,
} from './interpolate.js';
import {ClipParameter, EmoteNode} from './node.js';
import {clipRectPass, maskPass, meshPass, shapePass} from './vertices.js';

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
const EPSILON = 1.1920929e-7;
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

export class EmoteClip implements EmoteClipDriver, EmoteClipPlayerAccess {
  readonly kernel: EmoteMeshKernel;
  /** +0x0c referencing clip, +0x08 top clip. */
  readonly parentClip: EmoteClip | null;
  readonly top: EmoteClip;
  readonly zProjection: number;
  readonly textureIndexOf: (source: string) => number;
  private ratio: number;
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
  playing = false;
  jumped = true;
  flag112 = true;
  starting = false;
  replay = false;
  force = false;
  /** +0x1d0 stopped by a `sync` tag, +0x1d1 stopped by an `align` tag. */
  syncStop = false;
  alignStop = false;
  /** +0x118 running time, +0x11c clamped time, +0x120 speed, +0x124 step. */
  timeRunning = 0;
  time = 0;
  speed = 1;
  step = 0;
  loopTime = 0;
  lastTime = 0;
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
    this.parentClip = parent;
    this.top = parent?.top ?? this;
    this.kernel = options.kernel ?? parent?.kernel ?? createEmoteMeshKernel();
    this.zProjection = options.zProjection ?? parent?.zProjection ?? 0;
    this.textureIndexOf = options.textureIndexOf ?? parent?.textureIndexOf ?? (() => -1);
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
      setParameterValue(p, value);
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
  private unload(): void {
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
    for (const p of this.parameterMap.get(id) ?? []) setParameterValue(p, value);
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

  /** 0x1003aaf0. */
  advance(frames: number): void {
    this.alignStop = false;
    this.step = f(this.speed * frames);
    if (this.motionParameter) {
      const t = this.motionParameter.position;
      if (this.starting) {
        this.timeRunning = this.time = t;
        this.starting = false;
        this.resetFrames();
      } else if (this.time < t) {
        this.timeRunning = this.time = t;
        this.scanForward();
      } else if (t < this.time) {
        this.timeRunning = this.time = t;
        this.scanBackward();
      } else this.scanParameterNodes();
      return;
    }
    if (!this.starting && !this.playing) {
      if (this.parameters.length) this.scanParameterNodes();
      return;
    }
    if (this.syncStop || this.alignStop) return;
    const stopped = () => this.syncStop || this.alignStop;
    let stepped = false;
    if (this.starting) {
      this.starting = false;
      if (this.step < 0 && this.timeRunning === 0) this.time = this.timeRunning = this.lastTime;
      if (this.replay) {
        this.replay = false;
        if (this.step > 0) {
          const saved = this.time;
          this.time = 0;
          this.resetFrames();
          if (stopped()) return;
          this.time = saved;
          this.scanForward();
          if (stopped()) return;
          stepped = true;
        } else if (this.timeRunning < this.lastTime) {
          const saved = this.time;
          this.time = this.lastTime;
          this.resetFrames();
          if (stopped()) return;
          this.time = saved;
          this.scanBackward();
          if (stopped()) return;
          stepped = true;
        }
      }
      if (!stepped) {
        this.resetFrames();
        if (stopped()) return;
      }
    }
    const jumped = this.jumped;
    if (!jumped) {
      this.timeRunning = f(this.step + this.timeRunning);
      this.time = this.lastTime <= this.timeRunning ? this.lastTime : this.timeRunning;
    }
    if (this.step >= 0) {
      if (this.lastTime <= this.timeRunning) {
        this.time = this.lastTime;
        if (this.loopTime >= 0) {
          this.scanForward();
          if (stopped()) return;
          this.time = this.loopTime;
          this.resetFrames();
          if (stopped()) return;
          while (this.lastTime <= this.timeRunning)
            this.timeRunning = f(this.timeRunning - this.lastTime + this.loopTime);
          this.time = this.timeRunning;
          this.scanForward();
          return;
        }
        this.playing = false;
      }
      if (!jumped) this.scanForward();
    } else {
      if (this.timeRunning < 0 || this.timeRunning < this.loopTime) {
        if (this.loopTime >= 0) {
          this.time = this.loopTime;
          this.scanBackward();
          if (stopped()) return;
          this.time = this.lastTime;
          this.resetFrames();
          if (stopped()) return;
          while (this.timeRunning < this.loopTime)
            this.timeRunning = f(this.timeRunning - this.loopTime + this.lastTime);
          this.time = this.timeRunning;
          this.scanBackward();
          return;
        }
        this.time = 0;
        this.playing = false;
        this.timeRunning = 0;
      }
      if (!jumped) this.scanBackward();
    }
  }

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
    if (r.src === slot.src && r.icon === slot.icon) return;
    r.src = slot.src;
    r.icon = slot.icon;
    if (slot.src === 'blank') {
      const parts = slot.icon.split(':');
      r.drawable = true;
      r.hidden = true;
      r.attr = 0;
      r.texture = -1;
      r.rect[2] = atoi(parts[0]);
      r.rect[3] = atoi(parts[1]);
      r.originX = f(atof(parts[2]));
      r.originY = f(atof(parts[3]));
    } else {
      const icon = this.model.sources.get(slot.src)?.icons.get(slot.icon);
      r.hidden = false;
      r.drawable = icon !== undefined;
      r.texture = this.textureIndexOf(slot.src);
      if (icon) {
        r.attr = icon.attr;
        r.originX = f(icon.originX);
        r.originY = f(icon.originY);
        r.rect[0] = icon.left ?? 0;
        r.rect[1] = icon.top ?? 0;
        r.rect[2] = icon.width;
        r.rect[3] = icon.height;
      }
    }
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

  /** 0x1003ece0. */
  evaluate(): void {
    const nodes = this.nodes,
      root = nodes[0]!;
    const v = this.rootVelocity,
      a = root.adjust;
    if (v[0] !== 0) {
      a.x = f(this.step * v[0]! + a.x);
      a.changed = true;
    }
    if (v[1] !== 0) {
      a.y = f(this.step * v[1]! + a.y);
      a.changed = true;
    }
    if (v[2] !== 0) {
      a.z = f(this.step * v[2]! + a.z);
      a.changed = true;
    }
    if (this.decay !== 1) {
      const k = f(Math.pow(this.decay, f(this.step / 60)));
      v[0] = f(k * v[0]!);
      v[1] = f(k * v[1]!);
      v[2] = f(k * v[2]!);
    }
    for (const n of nodes) {
      n.velocity[0] = n.state.x;
      n.velocity[1] = n.state.y;
      n.velocity[2] = n.state.z;
    }
    root.state.copyFrom(a);
    a.changed = false;
    if (!this.nested) computeMatrix(root);
    for (let i = 1; i < nodes.length; i++) this.evaluateNode(nodes[i]!, root);
    for (const n of nodes) {
      const s = n.state;
      if (this.jumped) n.velocity.fill(0);
      else {
        n.velocity[0] = f(s.x - n.velocity[0]!);
        n.velocity[1] = f(s.y - n.velocity[1]!);
        n.velocity[2] = f(s.z - n.velocity[2]!);
      }
    }
    this.force = false;
    meshPass(this);
    maskPass(this);
    clipRectPass(this);
    if (this.features & 0x2) shapePass(this);
    if (this.features & 0x8) this.motionPass();
    for (const n of nodes) {
      n.framesDirty = false;
      n.state.changed = false;
    }
    for (const p of this.parameters) p.flags = 0;
    this.jumped = false;
    this.flag112 = false;
  }

  private evaluateNode(node: EmoteNode, root: EmoteNode): void {
    let parent = this.nodes[node.parent]!;
    while (parent.inheritMask & 0x400000) parent = this.nodes[parent.parent]!;
    const curIndex = node.current;
    const force = this.force || parent.state.changed || node.adjust.changed;
    if (!evaluateFrame(this, node, force)) return;
    node.adjust.changed = false;
    const s = node.state,
      p = parent.state;
    if (node.slots[curIndex]!.empty) {
      const changed = p.changed || node.framesDirty;
      s.copyFrom(p);
      s.changed = changed;
      s.visible = false;
      s.shown = p.shown && node.adjust.shown;
      node.matrix.set(parent.matrix);
      return;
    }
    const a = node.adjust;
    s.changed = true;
    s.shown = a.shown && p.shown;
    s.visible = a.visible && s.shown;
    s.flipX = s.flipX !== a.flipX;
    s.flipY = s.flipY !== a.flipY;
    s.angle = f(a.angle + s.angle);
    s.zoomX = f(a.zoomX * s.zoomX);
    s.zoomY = f(a.zoomY * s.zoomY);
    s.slantX = f(a.slantX + s.slantX);
    s.slantY = f(a.slantY + s.slantY);
    s.opacity = Math.trunc(Math.imul(a.opacity, s.opacity) / 255) >>> 0;
    s.x = f(a.x + s.x);
    s.y = f(a.y + s.y);
    s.z = f(a.z + s.z);
    if (parent.meshKind !== 0) syncToParentMesh(parent, node);
    const m = parent.matrix;
    let lx: number, ly: number, lz: number;
    if (node.coordinate === 0) {
      lx = f(m[1]! * s.y + m[0]! * s.x);
      ly = f(m[2]! * s.x + m[3]! * s.y);
      lz = s.z;
    } else {
      lx = f(m[0]! * s.x + s.z * m[1]!);
      lz = f(m[2]! * s.x + m[3]! * s.z);
      ly = s.y;
    }
    s.x = f(p.x + lx);
    s.y = f(p.y + ly);
    s.z = f(p.z + lz);
    const mask = node.inheritMask;
    if (mask & 0x400) s.opacity = Math.trunc(Math.imul(p.opacity, s.opacity) / 255) >>> 0;
    else if (!this.independent)
      s.opacity = Math.trunc(Math.imul(root.state.opacity, s.opacity) / 255) >>> 0;
    if ((mask & 0x1fc) === 0x1fc) {
      computeMatrix(node);
      multiply(m, node.matrix, node.matrix);
      s.flipX = s.flipX !== p.flipX;
      s.flipY = s.flipY !== p.flipY;
      s.angle = f(p.angle + s.angle);
      s.zoomX = f(p.zoomX * s.zoomX);
      s.zoomY = f(p.zoomY * s.zoomY);
      s.slantX = f(p.slantX + s.slantX);
      s.slantY = f(p.slantY + s.slantY);
      return;
    }
    inheritPartial(s, p, mask, 1);
    if (this.independent) {
      computeMatrix(node);
      return;
    }
    const r = root.state;
    inheritPartial(s, r, mask, -1);
    computeMatrix(node);
    inheritPartial(s, r, mask, 1);
    multiply(root.matrix, node.matrix, node.matrix);
  }

  /** 0x10041510: nested motion layers (type 3). */
  private motionPass(): void {
    const clipFlags = this.motionParameter?.flags ?? 0;
    for (const node of this.motionNodes) {
      const child = node.child as EmoteClip;
      const cur = node.cur,
        other = node.next;
      const time = node.parameter ? node.parameter.position : this.timeRunning;
      const stepRef = node.parameter ? node.parameter.position : this.step;
      const flags = node.parameter ? node.parameter.flags : clipFlags;
      if (node.state.changed || flags !== 0) {
        if (cur.empty || cur.src === '') {
          child.playing = false;
          child.unload();
          child.objectName = child.motionName = '';
          continue;
        }
        if (node.framesDirty || flags & 5) {
          child.selectObject(cur.src);
          child.selectMotion(cur.icon, cur.motion.flags);
          if (child.playing && child.jumped) {
            let t = f(f(time - cur.time) + cur.motion.timeOffset);
            if (this.step < 0 && child.loopTime > 0 && t > child.lastTime)
              do t = f(t - child.lastTime + child.loopTime);
              while (t > child.lastTime);
            child.seek(t);
            if (!this.jumped) child.replay = true;
          }
        }
        let dofst = cur.motion.dofst,
          angle = 0,
          apply = false;
        if (cur.motion.dt !== 0) {
          if (cur.motion.docmpl && cur.tween && !other.empty && other.motion.dt !== 0)
            dofst = lerpAngle(
              cur.angleCurve,
              dofst,
              other.motion.dofst,
              f((stepRef - cur.time) / (other.time - cur.time)),
            );
          if (cur.motion.dt !== 1)
            throw new EmoteClipUnsupportedError(`nested motion direction type ${cur.motion.dt}`);
          angle = f(node.state.angle + dofst);
          apply = true;
        }
        const s = node.state,
          m = node.matrix;
        let x = s.x,
          y = s.y,
          z = s.z;
        if (cur.ox !== 0 || cur.oy !== 0) {
          const ox = -cur.ox,
            oy = -cur.oy;
          const dx = f(ox * m[0]! + oy * m[1]!),
            dy = f(oy * m[3]! + m[2]! * ox);
          if (node.coordinate === 0) {
            x = f(x + dx);
            y = f(y + dy);
          } else if (node.coordinate === 1) {
            x = f(x + dx);
            z = f(z + dy);
          }
        }
        const ra = child.root.adjust;
        const set = <K extends keyof typeof ra>(key: K, value: (typeof ra)[K]) => {
          if (ra[key] !== value) {
            ra.changed = true;
            ra[key] = value;
          }
        };
        if (ra.x !== x || ra.y !== y || ra.z !== z) {
          ra.changed = true;
          ra.x = x;
          ra.y = y;
          ra.z = z;
        }
        if (ra.flipX !== s.flipX || ra.flipY !== s.flipY) {
          ra.changed = true;
          ra.flipX = s.flipX;
          ra.flipY = s.flipY;
        }
        if (ra.zoomX !== s.zoomX || ra.zoomY !== s.zoomY) {
          ra.changed = true;
          ra.zoomX = s.zoomX;
          ra.zoomY = s.zoomY;
        }
        if (apply) set('angle', angle);
        if (ra.slantX !== s.slantX || ra.slantY !== s.slantY) {
          ra.changed = true;
          ra.slantX = s.slantX;
          ra.slantY = s.slantY;
        }
        set('opacity', s.opacity);
        set('shown', s.visible);
        child.color = node.colors[0]!;
        const cm = child.root.matrix;
        if (!apply || s.angle === angle) cm.set(m);
        else {
          let rad = f(f((angle - s.angle) * 3.1415927410125732 * 2) / 360);
          if (s.flipY !== s.flipX) rad = -rad;
          const sn = f(Math.sin(rad)),
            cs = f(Math.cos(rad)),
            ns = -sn;
          const m0 = m[0]!,
            m1 = m[1]!,
            m2 = m[2]!,
            m3 = m[3]!;
          cm[0] = m1 * sn + cs * m0;
          cm[1] = m1 * cs + ns * m0;
          cm[2] = m2 * cs + m3 * sn;
          cm[3] = cs * m3 + m2 * ns;
        }
        ra.changed = true;
      }
      // LAB_10041f72: links, then the child steps with this clip and evaluates.
      const cr = child.root;
      cr.meshParent = node.meshParent;
      cr.maskNode = node.maskNode;
      cr.clipRect = node.clipRect;
      child.advance(this.step);
      child.evaluate();
      if (child.events.length) {
        this.events.push(...child.events);
        child.events = [];
      }
    }
  }

  /** 0x10032c70 / 0x10032d70: a different object name stops the clip and clears its motion. */
  private selectObject(name: string): void {
    if (name === this.objectName) return;
    this.objectName = name;
    this.motionName = '';
    this.playing = false;
  }

  /** 0x10032fa0 / 0x10033020: (re)loads the named motion of the object. */
  private selectMotion(name: string, flags: number): void {
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

/**
 * 0x1003e1a0: evaluates the node's current frame into its state. Returns whether the node
 * changed (always when `force` or the frames were reloaded).
 */
function evaluateFrame(clip: EmoteClip, node: EmoteNode, force: boolean): boolean {
  const cur = node.cur,
    next = node.next,
    s = node.state;
  let changed = force || node.framesDirty;
  if (cur.empty) return changed;
  if (cur.tween && !next.empty) {
    const now = node.parameter ? node.parameter.position : clip.time;
    let d = f(now - cur.time);
    if (cur.ti !== 0) {
      const ti = cur.ti >>> 0;
      d = f((Math.imul(roundHalfEven(d / f(ti)), ti) >>> 0) as number);
    }
    const t = f(d / f(next.time - cur.time));
    if (Math.abs(t) >= EPSILON) {
      if (!changed && Math.abs(f(node.lastT - t)) < EPSILON) return false;
      node.lastT = t;
      s.flipX = cur.fx;
      s.flipY = cur.fy;
      s.angle = lerpAngle(cur.angleCurve, cur.angle, next.angle, t);
      s.zoomX = lerp(cur.zoomCurve, cur.zx, next.zx, t);
      s.zoomY = lerp(cur.zoomCurve, cur.zy, next.zy, t);
      s.slantX = lerp(cur.slantCurve, cur.sx, next.sx, t);
      s.slantY = lerp(cur.slantCurve, cur.sy, next.sy, t);
      const xyz = [0, 0, 0];
      lerpCoord(cur.coordCurve, cur.coord, next.coord, t, xyz, 0);
      s.x = xyz[0]!;
      s.y = xyz[1]!;
      s.z = xyz[2]!;
      const u = f(1 - t);
      s.opacity = roundHalfAway(f((cur.opa >>> 0) * u + (next.opa >>> 0) * t));
      node.singleColor = cur.singleColor && next.singleColor;
      node.colorUnset = cur.colorUnset && next.colorUnset;
      if (!node.singleColor)
        for (let k = 0; k < 4; k++)
          node.colors[k] = lerpColor(cur.colorCurve, cur.colors[k]!, next.colors[k]!, t);
      else node.colors.fill(lerpColor(cur.colorCurve, cur.colors[0]!, next.colors[0]!, t));
      if (node.mesh) {
        const a = cur.meshPatch,
          b = next.meshPatch;
        if (a.length === 0 && b.length === 0) node.mesh.local = new Float32Array(0);
        else {
          const from = a.length ? a : IDENTITY_PATCH,
            to = b.length ? b : IDENTITY_PATCH;
          if (node.mesh.local.length !== from.length)
            node.mesh.local = new Float32Array(from.length);
          lerpPatch(cur.meshCurve, from, to, t, node.mesh.local);
        }
      }
      return true;
    }
    if (Math.abs(f(node.lastT - t)) >= EPSILON) changed = true;
    node.lastT = t;
  }
  if (!changed) return false;
  s.flipX = cur.fx;
  s.flipY = cur.fy;
  s.angle = f(cur.angle);
  s.zoomX = f(cur.zx);
  s.zoomY = f(cur.zy);
  s.slantX = f(cur.sx);
  s.slantY = f(cur.sy);
  s.x = f(cur.coord[0]!);
  s.y = f(cur.coord[1]!);
  s.z = f(cur.coord[2]!);
  node.colors.set(cur.colors);
  s.opacity = cur.opa >>> 0;
  node.singleColor = cur.singleColor;
  node.colorUnset = cur.colorUnset;
  if (node.mesh) node.mesh.local = cur.meshPatch.slice();
  return true;
}

/** 0x1003dd30: 2×2 frame from flips, rotation, zoom and slant in `transformOrder`. */
export function computeMatrix(node: EmoteNode): void {
  const m: Float32Array = node.matrix,
    s = node.state;
  m[0] = 1;
  m[1] = 0;
  m[2] = 0;
  m[3] = 1;
  for (const op of node.transformOrder) {
    switch (op) {
      case 0:
        if (s.flipX) {
          m[0] = -m[0]!;
          m[1] = -m[1]!;
        }
        if (s.flipY) {
          m[2] = -m[2]!;
          m[3] = -m[3]!;
        }
        break;
      case 1:
        if (s.angle !== 0) {
          const rad = f((s.angle * 3.1415927410125732 * 2) / 360);
          const sn = f(Math.sin(rad)),
            cs = f(Math.cos(rad));
          const m0: number = m[0]!,
            m1: number = m[1]!,
            m2: number = m[2]!,
            m3: number = m[3]!;
          m[0] = m0 * cs - m2 * sn;
          m[1] = m1 * cs - m3 * sn;
          m[2] = m0 * sn + m2 * cs;
          m[3] = m1 * sn + m3 * cs;
        }
        break;
      case 2:
        if (s.zoomX !== 1 || s.zoomY !== 1) {
          m[0] = m[0]! * s.zoomX;
          m[1] = m[1]! * s.zoomX;
          m[2] = m[2]! * s.zoomY;
          m[3] = m[3]! * s.zoomY;
        }
        break;
      case 3:
        if (s.slantX !== 0 || s.slantY !== 0) {
          const m0: number = m[0]!,
            m1: number = m[1]!;
          m[0] = m[2]! * s.slantX + m0;
          m[1] = m[3]! * s.slantX + m1;
          m[2] = m0 * s.slantY + m[2]!;
          m[3] = m1 * s.slantY + m[3]!;
        }
        break;
    }
  }
}

/** out = a · b (row-major 2×2), as the layer pass composes parent and node frames. */
function multiply(a: Float32Array, b: Float32Array, out: Float32Array): void {
  const r0 = a[1]! * b[2]! + a[0]! * b[0]!,
    r1 = a[0]! * b[1]! + b[3]! * a[1]!,
    r2 = a[2]! * b[0]! + a[3]! * b[2]!,
    r3 = b[1]! * a[2]! + a[3]! * b[3]!;
  out[0] = r0;
  out[1] = r1;
  out[2] = r2;
  out[3] = r3;
}

/**
 * The partial-inherit bits of the layer pass: 0x4 flipX, 0x8 flipY (xor), 0x10 angle
 * (add), 0x20/0x40 zoom (multiply), 0x80/0x100 slant (add). `sign` -1 removes `p` again.
 */
function inheritPartial(
  s: EmoteNode['state'],
  p: EmoteNode['state'],
  mask: number,
  sign: number,
): void {
  if (mask & 0x4) s.flipX = s.flipX !== p.flipX;
  if (mask & 0x8) s.flipY = s.flipY !== p.flipY;
  if (sign > 0) {
    if (mask & 0x10) s.angle = f(p.angle + s.angle);
    if (mask & 0x20) s.zoomX = f(p.zoomX * s.zoomX);
    if (mask & 0x40) s.zoomY = f(p.zoomY * s.zoomY);
    if (mask & 0x80) s.slantX = f(p.slantX + s.slantX);
    if (mask & 0x100) s.slantY = f(p.slantY + s.slantY);
  } else {
    if (mask & 0x10) s.angle = f(s.angle - p.angle);
    if (mask & 0x20) s.zoomX = f(s.zoomX / p.zoomX);
    if (mask & 0x40) s.zoomY = f(s.zoomY / p.zoomY);
    if (mask & 0x80) s.slantX = f(s.slantX - p.slantX);
    if (mask & 0x100) s.slantY = f(s.slantY - p.slantY);
  }
}

/**
 * 0x1003e890: a parent mesh with `meshSyncChildMask` bit 1 moves the child's coordinate
 * through its patch. Bits 2 (angle) and 4 (zoom) are not used by NEKOPARA (census: masks 0
 * and 8 only) and are rejected.
 */
function syncToParentMesh(parent: EmoteNode, node: EmoteNode): void {
  const mesh = parent.mesh;
  if (!mesh || mesh.local.length === 0 || !parent.state.visible || !parent.resolved.drawable)
    return;
  if (!(parent.meshSync & 1) || parent.meshKind !== 1) return;
  if (
    (parent.meshSync & 2 && node.inheritMask & 0x10) ||
    (parent.meshSync & 4 && node.inheritMask & 0x60)
  )
    throw new EmoteClipUnsupportedError('meshSyncChildMask angle/zoom (0x1003e890)');
  const cur = parent.cur,
    w = parent.resolved.rect[2]!,
    h = parent.resolved.rect[3]!;
  const ox = f(cur.ox + parent.resolved.originX),
    oy = f(cur.oy + parent.resolved.originY);
  const s = node.state,
    b = node.coordinate === 0 ? s.y : s.z;
  const p = [0, 0];
  patchPoint(mesh.local, f(f(ox + s.x) / w), f(f(oy + b) / h), p);
  s.x = f(w * p[0]! - ox);
  if (node.coordinate === 0) s.y = f(h * p[1]! - oy);
  else s.z = f(h * p[1]! - oy);
}

function setParameterValue(p: ClipParameter, value: number): void {
  // 0x10031400 (via 0x10031940): flags cleared, position = clamp(v)·division / range.
  p.flags = 0;
  if (p.rangeEnd === p.rangeBegin) {
    p.position = 0;
    return;
  }
  if (!(0 < p.division)) {
    p.position = 0;
    return;
  }
  let v = f(value);
  if (p.discretization) v = f(truncate(v));
  const lo = p.rangeEnd <= p.rangeBegin ? p.rangeEnd : p.rangeBegin,
    hi = p.rangeBegin <= p.rangeEnd ? p.rangeEnd : p.rangeBegin;
  let c = v <= lo ? lo : v;
  c = hi <= c ? hi : c;
  p.position = f(((c - p.rangeBegin) * p.division) / (p.rangeEnd - p.rangeBegin));
}

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

function atoi(s: string | undefined): number {
  const m = /^\s*[+-]?\d+/.exec(s ?? '');
  return m ? parseInt(m[0], 10) | 0 : 0;
}

function atof(s: string | undefined): number {
  const v = parseFloat(s ?? '');
  return Number.isNaN(v) ? 0 : v;
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

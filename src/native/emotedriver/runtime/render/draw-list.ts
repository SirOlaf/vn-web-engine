import type {
  EmoteClipNodes,
  EmoteNodeView,
  EmoteVertexGrid,
  EmoteScalarDrawItem,
} from '../interfaces.js';
import {EMOTE_NEUTRAL_COLOR, modulateColor} from './color.js';

const f = Math.fround;
type Rect = [number, number, number, number];

/** Draw item (0x74 bytes, node +0x2d4). */
export interface EmoteDrawItem {
  /** +0x00. */
  skip: boolean;
  /** +0x08: clip `+0x1b4`, secondary sort key. */
  priority: number;
  /** +0x0c. */
  blend: number;
  /** +0x20. */
  z: number;
  /** +0x24 / +0x28. */
  texture: number;
  flags: number;
  /** +0x2c..+0x38 (u, v, w, h). */
  rect: Rect;
  /** +0x3c. */
  opacity: number;
  /** +0x40..+0x4c, RGBA, in node corner order. */
  colors: Uint32Array;
  /** +0x58. */
  clip: Float32Array | null;
  /** +0x60. */
  grid: EmoteVertexGrid | null;
  /** +0x64 / +0x68 / +0x6c. */
  stencilType: number;
  mask: EmoteDrawItem | null;
  children: EmoteDrawItem[];
}

/** State and item ownership of the block renderer; implementations may supply their own pool. */
export interface EmoteBlockDrawHost {
  readonly list: EmoteDrawItem[];
  readonly filled: WeakSet<EmoteNodeView>;
  itemOf(node: EmoteNodeView): EmoteDrawItem;
  build(clip: EmoteClipNodes, parentColor: number, collect: EmoteDrawItem[] | null): void;
  fillItem(item: EmoteDrawItem, node: EmoteNodeView, clip: EmoteClipNodes, color: number): void;
}

/** Scalar node data consumed by draw construction, independent of a clip/node class. */
export interface EmoteScalarDrawNode {
  readonly type: number;
  drawn: boolean;
  readonly visible: boolean;
  readonly sub: EmoteScalarDrawClip | null;
  readonly inheritMask: number;
  readonly stencilVisible: boolean;
  readonly maskLayer: boolean;
  readonly item: EmoteScalarDrawItem | null;
  readonly stencilType: number;
  readonly stencilParent: EmoteScalarDrawNode | null;
  readonly drawable: boolean;
  readonly hidden: boolean;
  readonly id: number;
  readonly coordinate: number;
  readonly layer: {readonly objTriPriority: number | null} | null;
  readonly cur: {readonly bm: number; readonly bmParam: number};
  readonly z: number;
  readonly texture: number;
  readonly file: EmoteScalarDrawItem['file'];
  readonly source: string | null;
  readonly attr: number;
  readonly left: number;
  readonly top: number;
  readonly w: number;
  readonly h: number;
  readonly resolution: number;
  readonly opacity: number;
  readonly scalarColor: boolean;
  readonly defaultColor: boolean;
  readonly colors: Uint32Array;
  readonly meshKind: number;
  readonly mstate: EmoteScalarDrawItem['mesh'];
  readonly grid: EmoteScalarDrawItem['grid'];
  readonly masks: readonly EmoteScalarDrawNode[];
}

/** Scalar clip state and recursive child draw operation; no per-node adapters. */
export interface EmoteScalarDrawClip {
  readonly jumped: boolean;
  readonly color: number;
  readonly layerNodes: readonly EmoteScalarDrawNode[];
  readonly order: readonly number[];
  readonly stencilNodes: readonly EmoteScalarDrawNode[];
  readonly clipFlags: number;
  readonly grayscaleMode: number;
  readonly grayscaleLevel: number;
  readonly effectMode: number;
  readonly effectLevel: number;
  readonly top: {readonly drawList: EmoteScalarDrawItem[]};
  buildDrawList(color: number, collector: EmoteScalarDrawItem[] | null): void;
}

/** Opacity applied to the alpha byte of an RGBA colour (0x1002aca0). */
function applyOpacity(color: number, opacity: number): number {
  if (opacity === 0xff) return color >>> 0;
  return ((Math.floor(((color & 0xff) * opacity) / 0xff) | (color & 0xffffff00)) >>> 0) >>> 0;
}

/** 0x10044d70: block draw order, pooled items and stencil children. */
export function buildBlockDrawList(
  host: EmoteBlockDrawHost,
  clip: EmoteClipNodes,
  parentColor: number,
  collect: EmoteDrawItem[] | null,
): void {
  if (clip.drawSuppressed === true) return;
  const color = modulateColor(parentColor, clip.color ?? EMOTE_NEUTRAL_COLOR),
    nodes = clip.nodes,
    order = clip.drawOrder ?? nodes.slice(1).map((_, i) => i + 1);
  for (let k = order.length - 1; k >= 0; k--) {
    const node = nodes[order[k]!];
    if (node === undefined) continue;
    host.filled.delete(node);
    const inherited = (node.inheritMask & 0x200) !== 0 ? color : EMOTE_NEUTRAL_COLOR;
    if (node.type === 4) {
      const players = node.childPlayers ?? (node.child === null ? [] : [node.child]);
      for (const child of players) host.build(child, inherited, collect);
      continue;
    }
    if (!(node.shown ?? node.visible)) continue;
    if (node.type === 3) {
      if (node.stencilChild !== true) {
        if (node.child !== null) host.build(node.child, inherited, collect);
        continue;
      }
      const item = host.itemOf(node);
      host.filled.add(node);
      item.stencilType = node.stencilType;
      item.mask = node.maskNode == null ? null : host.itemOf(node.maskNode);
      item.children = [];
      if (node.child !== null) host.build(node.child, inherited, item.children);
      if (collect !== null) collect.push(...item.children);
      continue;
    }
    if (((1 << (node.type & 0x1f)) & 0x1401) === 0 || !node.drawable) continue;
    const item = host.itemOf(node);
    host.filled.add(node);
    host.fillItem(item, node, clip, color);
    if (((1 << (node.type & 0x1f)) & 0x401) !== 0) host.list.push(item);
    if (collect !== null) collect.push(item);
  }
  for (const index of clip.stencilCompositeNodes ?? []) {
    const node = nodes[index];
    if (node === undefined || (node.stencilType & 4) === 0 || !host.filled.has(node)) continue;
    const item = host.itemOf(node);
    item.children = [item];
    for (const member of node.compositeMaskNodes ?? []) {
      if (!host.filled.has(member)) continue;
      if (member.type === 0) item.children.push(host.itemOf(member));
      else if (member.type === 3) item.children.push(...host.itemOf(member).children);
    }
  }
}

/** Native block item fields, color flags and rectangle float stores. */
export function fillBlockDrawItem(
  host: Pick<EmoteBlockDrawHost, 'itemOf'>,
  item: EmoteDrawItem,
  node: EmoteNodeView,
  clip: EmoteClipNodes,
  color: number,
): void {
  item.skip = node.hidden === true;
  item.priority = f(clip.drawPriority ?? 0);
  item.blend = node.blendMode;
  item.z = f(node.z);
  item.texture = node.textureIndex ?? -1;
  item.flags = node.drawFlags ?? 0;
  const rect = node.sourceRect ?? [0, 0, 0, 0];
  item.rect = [f(rect[0]), f(rect[1]), f(rect[2]), f(rect[3])];
  item.opacity = node.opacity;
  const corners = node.colors;
  if (node.singleColor !== true) {
    let alphas = 0;
    for (let i = 0; i < 4; i++) {
      const c = modulateColor(applyOpacity(corners[i]!, node.opacity), color);
      alphas |= c & 0xff;
      item.colors[i] = c;
    }
    if (alphas !== 0xff) item.flags &= ~2;
  } else if (color !== EMOTE_NEUTRAL_COLOR || node.opacity !== 0xff) {
    const c = modulateColor(applyOpacity(corners[0]!, node.opacity), color);
    item.colors.fill(c);
    if ((c & 0xff) !== 0xff) item.flags &= ~2;
  } else {
    item.colors.set(corners.subarray(0, 4));
    if (node.protectColor === true) item.flags |= 4;
  }
  item.clip = node.clipRect ?? null;
  item.grid = node.grid;
  item.stencilType = node.stencilType;
  item.mask = node.maskNode == null ? null : host.itemOf(node.maskNode);
}

/** 0x180048c70: scalar item identities, blend colors and stencil composites. */
export function buildScalarDrawList(
  host: EmoteScalarDrawClip,
  color: number,
  collector: EmoteScalarDrawItem[] | null,
): void {
  if (host.jumped) return;
  const mod = modulateColor(color, host.color);
  const neutral = mod === EMOTE_NEUTRAL_COLOR;
  const nodes = host.layerNodes;
  const count = nodes.length - 1;
  for (let k = 0; k < count; k++) {
    const idx = host.order[count - 1 - k];
    const n = idx !== undefined ? nodes[idx + 1] : undefined;
    if (!n) continue;
    n.drawn = false;
    if (!n.visible) continue;
    if (n.type === 3) {
      if (!n.sub) continue;
      const c = n.inheritMask & 0x200 ? mod : EMOTE_NEUTRAL_COLOR;
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
    if (!((0x1401 >> n.type) & 1) || !n.drawable) continue;
    const item = n.item!;
    n.drawn = true;
    item.blank = n.hidden;
    item.nodeId = n.id;
    item.coordinate = n.coordinate;
    item.objTriPriority = n.layer?.objTriPriority ?? 0;
    item.clipFlags = host.clipFlags;
    const A = n.cur;
    item.bm = A.bm;
    const b = A.bm & 0xff0f;
    item.bmParam = A.bmParam;
    item.grayscaleMode = host.grayscaleMode;
    item.grayscaleLevel = host.grayscaleLevel;
    item.effectMode = host.effectMode;
    item.effectLevel = host.effectLevel;
    item.z = n.z;
    item.texIndex = n.texture;
    item.file = n.file;
    item.source = n.source;
    let attr = n.attr >>> 0;
    item.left = n.left;
    item.top = n.top;
    item.width = f(n.w * n.resolution);
    item.height = f(n.h * n.resolution);
    item.opa = n.opacity;
    let c = mod;
    let forced = neutral;
    if (b === 2 || b === 3 || b === 5) {
      c = EMOTE_NEUTRAL_COLOR;
      forced = true;
    }
    if (b !== 0) attr &= ~2;
    const withOpa = (v: number) =>
      n.opacity !== 255
        ? (Math.floor(((v & 0xff) * n.opacity) / 255) | (v & 0xffffff00)) >>> 0
        : v >>> 0;
    if (!n.scalarColor) {
      let all = 0xff;
      for (let i = 0; i < 4; i++) {
        const v = modulateColor(withOpa(n.colors[i]!), c);
        item.colors[i] = v;
        all &= v;
      }
      if ((all & 0xff) !== 0xff) attr &= ~2;
    } else if (!forced || n.opacity !== 255) {
      const v = modulateColor(withOpa(n.colors[0]!), c);
      item.colors.fill(v);
      if ((v & 0xff) !== 0xff) attr &= ~2;
    } else {
      item.colors.set(n.colors);
      if (n.defaultColor) attr |= 4;
    }
    item.mesh = n.meshKind === 1 && n.mstate?.bp ? n.mstate : null;
    item.grid = n.grid;
    item.stencilType = n.stencilType;
    item.stencilParent = n.stencilParent?.item ?? null;
    if (n.stencilParent) attr &= ~2;
    item.attr = attr;
    if ((0x401 >> n.type) & 1) host.top.drawList.push(item);
    if (collector) collector.push(item);
    item.alphaTest = false;
  }
  for (const n of host.stencilNodes) {
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

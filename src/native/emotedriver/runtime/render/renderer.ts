import type {EmoteModel} from '../../../../formats/kirikiri/emote-model.js';
import type {EmoteClipNodes, EmoteNodeView, EmoteVertexGrid} from '../interfaces.js';
import type {EmotePlayerRenderer, EmotePlayerRendererState, PEmotePlayer} from '../../player.js';
import {EMOTE_FLT_MAX, type EmoteDeviceCore, type EmoteTextureRecord} from './device-core.js';
import {loadEmoteTexture} from './texture.js';

/**
 * `MMotionRenderer` (vtable 0x1007272c): the draw list of one player and its texture table.
 * `render` is `IEmotePlayer::Render` (0x10002b30) after the player picked its current clip:
 * draw-list build 0x10044d70, then frame 0x10003f10 (frame begin, draw 0x10003f70, restore).
 */

const f = Math.fround;
/** Neutral RGBA colour: grey 0x80 is 1.0 in the ×2 colour product, alpha 0xff. */
export const EMOTE_NEUTRAL_COLOR = 0x808080ff;
const WHITE = new Uint32Array([0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff]);
/** Pass table 0x100718b4: include masks, then exclude masks. */
const MASK_PASS_ROLES = [1, 2] as const;

type Rect = [number, number, number, number];
const emptyRect = (): Rect => [EMOTE_FLT_MAX, EMOTE_FLT_MAX, -EMOTE_FLT_MAX, -EMOTE_FLT_MAX];
/** 0x10004e40. */
const union = (a: Rect, b: Rect): Rect => [
  a[0] < b[0] ? a[0] : b[0],
  a[1] < b[1] ? a[1] : b[1],
  b[2] < a[2] ? a[2] : b[2],
  b[3] < a[3] ? a[3] : b[3],
];
/** 0x10004d10. */
const intersect = (a: Rect, b: Rect): Rect => [
  b[0] < a[0] ? a[0] : b[0],
  b[1] < a[1] ? a[1] : b[1],
  a[2] < b[2] ? a[2] : b[2],
  a[3] < b[3] ? a[3] : b[3],
];

/**
 * RGBA colour product (0x1002b1c0): RGB × 2 / 256 clamped to 255, alpha × / 255. The neutral
 * colour on either side returns the other.
 */
export function emoteMultiplyColor(a: number, b: number): number {
  a >>>= 0;
  b >>>= 0;
  if (b === EMOTE_NEUTRAL_COLOR) return a;
  if (a === EMOTE_NEUTRAL_COLOR) return b;
  const alpha = Math.floor(((a & 0xff) * (b & 0xff)) / 0xff),
    channel = (shift: number): number =>
      Math.min(0xff, (((a >>> shift) & 0xff) * ((b >>> shift) & 0xff)) >>> 7);
  return ((channel(24) << 24) | (channel(16) << 16) | (channel(8) << 8) | alpha) >>> 0;
}

/** Opacity applied to the alpha byte of an RGBA colour (0x1002aca0). */
function applyOpacity(color: number, opacity: number): number {
  if (opacity === 0xff) return color >>> 0;
  return ((Math.floor(((color & 0xff) * opacity) / 0xff) | (color & 0xffffff00)) >>> 0) >>> 0;
}

const ror8 = (c: number): number => ((c >>> 8) | (c << 24)) >>> 0;

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

function newItem(): EmoteDrawItem {
  return {
    skip: true,
    priority: 0,
    blend: 0,
    z: 0,
    texture: -1,
    flags: 0,
    rect: [0, 0, 0, 0],
    opacity: 0,
    colors: new Uint32Array(4),
    clip: null,
    grid: null,
    stencilType: 0,
    mask: null,
    children: [],
  };
}

/** Grid bounds (0x10003c60). */
function gridBounds(grid: EmoteVertexGrid | null): Rect {
  let r = emptyRect();
  if (grid === null) return r;
  const p = grid.positions;
  for (let i = 0; i + 1 < p.length; i += 2) r = union(r, [p[i]!, p[i + 1]!, p[i]!, p[i + 1]!]);
  return r;
}

/**
 * Serves as both the `renderer` and the `rendererState` of `PEmotePlayer`: one renderer per
 * created player, shared with its clones (`PEmotePlayer+0xc`).
 */
export class EmoteMotionRenderer implements EmotePlayerRenderer, EmotePlayerRendererState {
  /** +0x78: texture table; slot 0 starts empty. */
  readonly textures: (EmoteTextureRecord | null)[] = [null];
  /** +0x98: `IEmotePlayer::SetSmoothing`. */
  smoothing = true;
  /** +0x14: draw list of the current frame. */
  private list: EmoteDrawItem[] = [];
  private readonly items = new WeakMap<EmoteNodeView, EmoteDrawItem>();
  /** Node +0x2d0: filled during the current build. */
  private filled = new WeakSet<EmoteNodeView>();
  private readonly sourceTextures = new Map<string, number>();

  constructor(readonly core: EmoteDeviceCore) {}

  /** Slot 1, 0x10058700: uploads a texture into the first free table slot. */
  loadTexture(texture: Parameters<typeof loadEmoteTexture>[1], spec: string): number {
    const record = loadEmoteTexture(this.core, texture, spec);
    let index = this.textures.indexOf(null);
    if (index < 0) {
      index = this.textures.length;
      this.textures.length = index * 2;
      this.textures.fill(null, index);
    }
    this.textures[index] = record;
    return index;
  }

  /** Slot 2, 0x100587c0. */
  releaseTexture(index: number): void {
    this.textures[index]?.texture.release();
    this.textures[index] = null;
  }

  /** Source textures of a motion file in `source` order (0x1002b7d0 → slot 1). */
  loadModelSources(model: EmoteModel): void {
    for (const [name, source] of model.sources)
      if (source.texture !== null)
        this.sourceTextures.set(name, this.loadTexture(source.texture, model.spec));
  }

  /** Texture index of a source, for `EmoteNodeView.textureIndex`; -1 when unknown. */
  textureIndexOf(source: string): number {
    return this.sourceTextures.get(source) ?? -1;
  }

  private itemOf(node: EmoteNodeView): EmoteDrawItem {
    let item = this.items.get(node);
    if (item === undefined) this.items.set(node, (item = newItem()));
    return item;
  }

  /** 0x10044d70: fills node draw items and the draw list, walking the draw order backwards. */
  build(clip: EmoteClipNodes, parentColor: number, collect: EmoteDrawItem[] | null): void {
    if (clip.drawSuppressed === true) return;
    const color = emoteMultiplyColor(parentColor, clip.color ?? EMOTE_NEUTRAL_COLOR),
      nodes = clip.nodes,
      order = clip.drawOrder ?? nodes.slice(1).map((_, i) => i + 1);
    for (let k = order.length - 1; k >= 0; k--) {
      const node = nodes[order[k]!];
      if (node === undefined) continue;
      this.filled.delete(node);
      const inherited = (node.inheritMask & 0x200) !== 0 ? color : EMOTE_NEUTRAL_COLOR;
      if (node.type === 4) {
        const players = node.childPlayers ?? (node.child === null ? [] : [node.child]);
        for (const child of players) this.build(child, inherited, collect);
        continue;
      }
      if (!(node.shown ?? node.visible)) continue;
      if (node.type === 3) {
        if (node.stencilChild !== true) {
          if (node.child !== null) this.build(node.child, inherited, collect);
          continue;
        }
        const item = this.itemOf(node);
        this.filled.add(node);
        item.stencilType = node.stencilType;
        item.mask = node.maskNode == null ? null : this.itemOf(node.maskNode);
        item.children = [];
        if (node.child !== null) this.build(node.child, inherited, item.children);
        if (collect !== null) collect.push(...item.children);
        continue;
      }
      if (((1 << (node.type & 0x1f)) & 0x1401) === 0 || !node.drawable) continue;
      const item = this.itemOf(node);
      this.filled.add(node);
      this.fillItem(item, node, clip, color);
      if (((1 << (node.type & 0x1f)) & 0x401) !== 0) this.list.push(item);
      if (collect !== null) collect.push(item);
    }
    for (const index of clip.stencilCompositeNodes ?? []) {
      const node = nodes[index];
      if (node === undefined || (node.stencilType & 4) === 0 || !this.filled.has(node)) continue;
      const item = this.itemOf(node);
      item.children = [item];
      for (const member of node.compositeMaskNodes ?? []) {
        if (!this.filled.has(member)) continue;
        if (member.type === 0) item.children.push(this.itemOf(member));
        else if (member.type === 3) item.children.push(...this.itemOf(member).children);
      }
    }
  }

  private fillItem(
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
        const c = emoteMultiplyColor(applyOpacity(corners[i]!, node.opacity), color);
        alphas |= c & 0xff;
        item.colors[i] = c;
      }
      if (alphas !== 0xff) item.flags &= ~2;
    } else if (color !== EMOTE_NEUTRAL_COLOR || node.opacity !== 0xff) {
      const c = emoteMultiplyColor(applyOpacity(corners[0]!, node.opacity), color);
      item.colors.fill(c);
      if ((c & 0xff) !== 0xff) item.flags &= ~2;
    } else {
      item.colors.set(corners.subarray(0, 4));
      if (node.protectColor === true) item.flags |= 4;
    }
    item.clip = node.clipRect ?? null;
    item.grid = node.grid;
    item.stencilType = node.stencilType;
    item.mask = node.maskNode == null ? null : this.itemOf(node.maskNode);
  }

  /**
   * `IEmotePlayer::Render` (0x10002b30): device-lost check, draw-list build of the current
   * clip (`p+0x1cc`, clamped to the last clip) with that clip's colour, then the frame.
   */
  render(player: PEmotePlayer): void {
    const {clips, currentClip} = player.core;
    this.renderClip(clips.length === 0 ? null : clips[Math.min(currentClip, clips.length - 1)]!);
  }

  /** `render` for a given clip. */
  renderClip(clip: EmoteClipNodes | null): void {
    const core = this.core;
    if (core.lost) {
      if (core.device.testCooperativeLevel() === 0) core.lost = false;
    }
    if (!core.lost && clip !== null) this.build(clip, clip.color ?? EMOTE_NEUTRAL_COLOR, null);
    this.frame();
  }

  /** 0x10003f10 with 0x1002cc30: frame begin, sorted draw, restore. */
  frame(): void {
    const core = this.core;
    if (core.lost) {
      if (core.device.testCooperativeLevel() === 0) core.lost = false;
      if (core.lost) return;
    }
    core.beginFrame(this.smoothing);
    if (this.list.length !== 0) {
      // std::stable_sort with 0x1002cd30: z, then the clip key.
      this.list.sort((a, b) =>
        a.z < b.z
          ? -1
          : b.z < a.z
            ? 1
            : a.priority < b.priority
              ? -1
              : b.priority < a.priority
                ? 1
                : 0,
      );
      this.draw();
      this.list = [];
    }
    core.restoreState();
    core.pixelateSource = null;
  }

  private bind(index: number): boolean {
    const record = this.textures[index] ?? null;
    if (record === null) return false;
    this.core.bindTexture(record);
    return true;
  }

  private drawItem(item: EmoteDrawItem, colors: Uint32Array, flags: number): void {
    const grid = item.grid;
    if (grid === null || this.core.currentTexture === null) return;
    const r = item.rect;
    this.core.drawGrid(
      grid.positions,
      r[0],
      r[1],
      r[2],
      r[3],
      grid.columns,
      grid.rows,
      flags & 0xff,
      colors,
    );
  }

  /** `AMotionRenderer` slot 3, 0x10003f70. */
  private draw(): void {
    const core = this.core,
      list = this.list;
    const view: Rect = [...core.clipRect];
    let clip: Rect = [...view],
      maskBounds = emptyRect(),
      lastTexture = -1,
      lastClip: Float32Array | null = null,
      lastBlend = 0,
      mask: EmoteDrawItem | null = null,
      clipOk = true,
      drawOk = true,
      pixelate = false;
    const regionClipping = core.maskRegionClipping;
    const bindTexture = (index: number): void => {
      if (index !== lastTexture) {
        lastTexture = index;
        this.bind(index);
      }
    };
    /** 0x10003d20. */
    const updateScissor = (): void => {
      const clipValid = !(clip[2] < clip[0] || clip[3] < clip[1]),
        maskValid = !(maskBounds[2] < maskBounds[0] || maskBounds[3] <= maskBounds[1]);
      clipOk = clipValid;
      let rect: Rect;
      if (!clipValid) {
        if (!maskValid) {
          drawOk = false;
          return;
        }
        rect = maskBounds;
        drawOk = true;
      } else if (!maskValid) {
        rect = clip;
        drawOk = true;
      } else {
        rect = intersect(clip, maskBounds);
        drawOk = !(rect[2] < rect[0] || rect[3] < rect[1]);
      }
      if (drawOk) core.setClipRect(rect[0], rect[1], rect[2], rect[3]);
    };
    core.setBlend(0);
    for (let i = 0; i < list.length; i++) {
      const item = list[i]!;
      if (item.skip || item.opacity === 0) continue;
      if ((item.blend & 0xf) === 6) {
        pixelate = true;
        continue;
      }
      if (item.mask !== mask) {
        maskBounds = emptyRect();
        mask = item.mask;
        if (mask === null) {
          updateScissor();
          core.unbindMask();
        } else {
          let found = false;
          if (regionClipping) {
            let itemBounds = emptyRect();
            for (let j = i; j < list.length; j++) {
              const next = list[j]!;
              if (next.skip || next.opacity === 0 || (next.blend & 0xf) === 6) continue;
              if (next.mask !== mask) break;
              itemBounds = union(itemBounds, gridBounds(next.grid));
            }
            for (let m: EmoteDrawItem | null = mask; m !== null; m = m.mask) {
              if ((m.stencilType & 3) === 2) continue;
              let bounds: Rect | null = null;
              if ((m.stencilType & 4) === 0) {
                if (!m.skip) bounds = gridBounds(m.grid);
              } else {
                let children = emptyRect();
                for (const c of m.children)
                  if (!c.skip) children = union(children, gridBounds(c.grid));
                if (children[0] <= children[2] && children[1] <= children[3]) bounds = children;
              }
              if (bounds === null) continue;
              if (!found) {
                found = true;
                maskBounds = bounds;
              } else maskBounds = intersect(maskBounds, bounds);
            }
            const both = intersect(maskBounds, itemBounds);
            if (found && !(both[2] < both[0]) && !(both[3] < both[1])) {
              const p = core.projectRect(both[0], both[1], both[2], both[3]);
              maskBounds = [
                f(f(Math.floor(p[0])) - 2),
                f(f(Math.floor(p[1])) - 2),
                f(f(Math.ceil(p[2])) + 2),
                f(f(Math.ceil(p[3])) + 2),
              ];
            } else maskBounds = emptyRect();
          }
          const b =
            !(maskBounds[2] < maskBounds[0]) && !(maskBounds[3] < maskBounds[1])
              ? maskBounds
              : view;
          core.setClipRect(b[0], b[1], b[2], b[3]);
          lastBlend = 0;
          core.setBlend(0);
          let hasExclude = false;
          for (let m: EmoteDrawItem | null = mask; m !== null; m = m.mask)
            if ((m.stencilType & 3) === 2) {
              hasExclude = true;
              break;
            }
          let reference = hasExclude ? 1 : 0;
          core.beginMask(reference);
          for (let pass = 0; pass < 2; pass++) {
            const role = MASK_PASS_ROLES[pass]!;
            if (pass === 1 && hasExclude) core.excludeMasks(reference);
            for (let m: EmoteDrawItem | null = mask; m !== null; m = m.mask) {
              if ((m.stencilType & 3) !== role) continue;
              if (pass === 0) core.includeMask(reference++);
              const parts = (m.stencilType & 4) === 0 ? [m] : m.children;
              for (const part of parts) {
                if (part.skip) continue;
                bindTexture(part.texture);
                this.drawItem(part, WHITE, 4);
              }
            }
          }
          core.endMask(reference);
          updateScissor();
          lastTexture = -1;
        }
      }
      if (item.clip !== lastClip) {
        lastClip = item.clip;
        if (item.clip === null) clip = [...view];
        else {
          const c = item.clip;
          clip = intersect(core.projectRect(c[0]!, c[1]!, c[2]!, c[3]!), view);
        }
        updateScissor();
      }
      if (clipOk && drawOk) {
        bindTexture(item.texture);
        if (item.blend !== lastBlend) {
          lastBlend = item.blend;
          core.setBlend(item.blend);
        }
        const c = item.colors;
        this.drawItem(
          item,
          Uint32Array.of(ror8(c[0]!), ror8(c[1]!), ror8(c[3]!), ror8(c[2]!)),
          item.flags,
        );
      }
    }
    if (mask !== null) core.unbindMask();
    core.setClipRect(view[0], view[1], view[2], view[3]);
    if (!pixelate) return;
    core.pixelateCopy();
    let lastMode = 0;
    lastTexture = -1;
    for (const item of list) {
      if (item.skip || item.opacity === 0 || (item.blend & 0xf) !== 6) continue;
      if (lastMode !== 6) {
        lastMode = 6;
        core.bindPixelate(6);
      }
      bindTexture(item.texture);
      this.drawItem(item, WHITE, item.flags);
    }
    if (core.pixelateBound) core.device.setTexture(1, null);
  }

  /** Releases every texture (renderer dtor). */
  destroy(): void {
    for (let i = 0; i < this.textures.length; i++) this.releaseTexture(i);
  }
}

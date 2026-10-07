import type {
  EmoteFrame,
  EmoteFrameContent,
  EmoteModel,
} from '../../../../formats/kirikiri/emote-model.js';
import {CurveCursor} from './interpolate.js';

/**
 * Keyframe slot of a layer node (0xd0 bytes at node +0xb0 and +0x180; `emotedriver.dll`
 * SHA-256 `a3b693b6…5e70b3a86`). A node holds the current frame and the next one; node
 * +0x250 selects which slot is current. The header (0x10035f50) and the content (0x100362b0)
 * load separately: scans load headers while stepping and contents once at the end.
 */
export class FrameSlot {
  /** +0x00 frame index, +0x04 time, +0x08 `ti`, +0x0c `content.mask`. */
  index = 0;
  time = 0;
  ti = 0;
  mask = 0;
  /** +0x10 type 0 (no content), +0x11 type 3 (tweened), +0x14 content loaded. */
  empty = true;
  tween = false;
  loaded = false;
  /** +0x12 one colour value (not a list), +0x13 no `color` key. */
  singleColor = true;
  colorUnset = true;
  /** +0x18/+0x1c `src`, `icon`. */
  src = '';
  icon = '';
  /** +0x20 `bm`, +0x24/+0x28 `ox`/`oy`, +0x2c..+0x38 corner colours, +0x3c `opa`. */
  bm = 0x10;
  ox = 0;
  oy = 0;
  readonly colors = new Uint32Array(4);
  opa = 255;
  /** +0x40..+0x48 `coord`, +0x4c/+0x4d `fx`/`fy`, +0x50 `angle`, +0x54.. `zx`,`zy`,`sx`,`sy`. */
  readonly coord = [0, 0, 0];
  fx = false;
  fy = false;
  angle = 0;
  zx = 1;
  zy = 1;
  sx = 0;
  sy = 0;
  /** Curves: +0x64 `ccc` (coordinate), +0x74 `occ` (colour), +0x84 `acc`, +0x94 `zcc`, +0xa4 `scc`. */
  coordCurve: CurveCursor | null = null;
  colorCurve: CurveCursor | null = null;
  angleCurve: CurveCursor | null = null;
  zoomCurve: CurveCursor | null = null;
  slantCurve: CurveCursor | null = null;
  /** +0xc4 `act`. */
  act: string | null = null;
  /**
   * +0xc8 mesh: curve and patch. The struct outlives header loads; its patch is replaced only
   * by content with mask 0x2000000, so a frame without `mesh` keeps the slot's last patch.
   */
  meshCurve: CurveCursor | null = null;
  meshPatch: Float32Array = EMPTY_PATCH;
  /** +0xcc nested-motion control (type 3); also kept across header loads. */
  readonly motion: SlotMotion = {flags: 0, dt: 0, dofst: 0, docmpl: false, dtgt: '', timeOffset: 0};

  copyFrom(o: FrameSlot): void {
    Object.assign(this, {...o, colors: this.colors, coord: this.coord, motion: this.motion});
    this.colors.set(o.colors);
    this.coord[0] = o.coord[0]!;
    this.coord[1] = o.coord[1]!;
    this.coord[2] = o.coord[2]!;
    Object.assign(this.motion, o.motion);
    for (const k of CURVES) {
      const c = o[k];
      this[k] = c ? Object.assign(new CurveCursor(c.curve), c) : null;
    }
  }
}

const CURVES = [
  'coordCurve',
  'colorCurve',
  'angleCurve',
  'zoomCurve',
  'slantCurve',
  'meshCurve',
] as const;

export interface SlotMotion {
  flags: number;
  dt: number;
  dofst: number;
  docmpl: boolean;
  dtgt: string;
  timeOffset: number;
}

export const EMPTY_PATCH = new Float32Array(0);

/** Raised for model features NEKOPARA does not use and the runtime does not reproduce. */
export class EmoteClipUnsupportedError extends Error {
  override name = 'EmoteClipUnsupportedError';
}

/**
 * 0x10035f50: frame header. Clears the slot (keeping the mesh and motion structs), then reads
 * `time`, `type`, `content.mask` and `act`. Indices past the list repeat the native
 * out-of-range read as the last frame.
 */
export function loadHeader(slot: FrameSlot, frames: readonly EmoteFrame[], index: number): void {
  const frame = frames[Math.min(Math.max(index, 0), frames.length - 1)]!;
  slot.coordCurve = slot.colorCurve = slot.angleCurve = slot.zoomCurve = slot.slantCurve = null;
  slot.meshCurve = null;
  slot.index = index;
  slot.time = frame.time;
  slot.ti = 0;
  slot.mask = 0;
  slot.empty = false;
  slot.tween = false;
  slot.loaded = false;
  slot.singleColor = false;
  slot.colorUnset = false;
  slot.src = slot.icon = '';
  slot.bm = slot.ox = slot.oy = slot.opa = 0;
  slot.colors.fill(0);
  slot.coord[0] = slot.coord[1] = slot.coord[2] = 0;
  slot.fx = slot.fy = false;
  slot.angle = slot.zx = slot.zy = slot.sx = slot.sy = 0;
  slot.act = null;
  if (frame.type === 0) {
    slot.empty = true;
    return;
  }
  if (frame.type === 3) slot.tween = true;
  const content = frame.content;
  if (!content) return;
  slot.mask = content.mask;
  if (content.mask & 0x40000) slot.act = content.act;
}

/** Layer types whose frames carry `src`/`icon` (bit set 0x1849). */
const SOURCE_TYPES = 0x1849;

/** 0x100362b0: frame content; defaults are written before the mask-gated keys. */
export function loadContent(
  slot: FrameSlot,
  frames: readonly EmoteFrame[],
  layerType: number,
  model: EmoteModel,
): void {
  slot.loaded = true;
  if (slot.empty) return;
  const content = frames[Math.min(Math.max(slot.index, 0), frames.length - 1)]!.content;
  slot.colors.fill(0x808080ff);
  slot.zx = slot.zy = 1;
  slot.singleColor = slot.colorUnset = true;
  slot.opa = 255;
  slot.bm = 0x10;
  if (!content) return;
  const mask = content.mask;
  if ((1 << layerType) & SOURCE_TYPES) {
    slot.src = content.src ?? '';
    slot.icon = content.icon ?? '';
  }
  slot.ox = content.ox;
  slot.oy = content.oy;
  slot.coord[0] = content.coord[0];
  slot.coord[1] = content.coord[1];
  slot.coord[2] = content.coord[2];
  if (mask & 0x20600) {
    slot.opa = content.opa;
    slot.bm = content.bm;
    slot.colors.set(content.color);
    if (mask & 0x200) {
      slot.colorUnset = false;
      // The reader keeps no list/scalar distinction; four equal corners read as one value.
      slot.singleColor = content.color.every((c) => c === content.color[0]);
    }
  }
  slot.fx = content.fx;
  slot.fy = content.fy;
  slot.angle = content.angle;
  slot.zx = content.zx;
  slot.zy = content.zy;
  slot.sx = content.sx;
  slot.sy = content.sy;
  if (slot.tween) {
    slot.ti = content.ti;
    const curve = (index: number | null) => {
      if (index === null) return null;
      const c = model.easing?.[index];
      if (!c) throw new EmoteClipUnsupportedError(`easing ${index} is not in the root table`);
      return new CurveCursor(c);
    };
    slot.coordCurve = curve(content.ccc);
    slot.colorCurve = curve(content.occ);
    slot.angleCurve = curve(content.acc);
    slot.zoomCurve = curve(content.zcc);
    slot.slantCurve = curve(content.scc);
  }
  rejectUnused(content);
  if (mask & 0x2000000 && content.mesh) {
    const cc = content.mesh.cc,
      c = cc === null ? null : model.easing?.[cc];
    if (cc !== null && !c) throw new EmoteClipUnsupportedError(`mesh easing ${cc} is missing`);
    slot.meshCurve = c ? new CurveCursor(c) : null;
    slot.meshPatch = content.mesh.bp ?? EMPTY_PATCH;
  }
  if (mask & 0x80000 && content.motion) {
    const m = content.motion,
      sm = slot.motion;
    sm.flags = m.flags ?? 0;
    sm.dt = m.dt ?? 1;
    sm.dofst = m.dofst ?? 0;
    sm.docmpl = m.docmpl ?? false;
    sm.dtgt = m.dtgt ?? '';
    sm.timeOffset = m.timeOffset;
  }
}

/**
 * Content keys NEKOPARA never uses (census in `tools/probe-emotedriver-clip.mjs`: 0 of
 * 47,354 `emotewin` frames): `cp` paths (0x1002a870), particles, camera, anchor, model and
 * feedback payloads. They are rejected instead of evaluated.
 */
function rejectUnused(c: EmoteFrameContent): void {
  for (const key of ['cp', 'prt', 'camera', 'anchor', 'model', 'feedback'] as const)
    if (c[key] !== null)
      throw new EmoteClipUnsupportedError(`frame content '${key}' is not supported`);
}

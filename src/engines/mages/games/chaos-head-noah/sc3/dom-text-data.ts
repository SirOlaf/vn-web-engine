import type {DrawCommand, SpriteDraw} from '../../../../../graphics/draw-list.js';
import type {Rect} from '../../../../../graphics/surface.js';
import type {NoahState} from './noah-state.js';
import type {
  GlyphSlot,
  TextGlyph,
  GlyphRaster,
  TextShadow,
} from '../../../../../text/glyph-slots.js';
import {decodeNoahGlyph} from './glyph-unicode.js';

export interface TextRun {
  slot: string;
  line?: number;
  index?: number;
  shadow?: boolean;
}
export interface GlyphLayout {
  role: string;
  line: number;
}
interface TextState {
  extra: TaggedGlyph[];
  scope: string;
  calls: Map<string, number>;
  packed: Map<number, GlyphLayout[]>;
  tips: GlyphLayout[];
  history: Map<number, GlyphLayout>;
}
const states = new WeakMap<NoahState, TextState>();
function state(s: NoahState): TextState {
  let t = states.get(s);
  if (!t) {
    t = {extra: [], scope: '', calls: new Map(), packed: new Map(), tips: [], history: new Map()};
    states.set(s, t);
  }
  return t;
}
export function beginTextFrame(s: NoahState): void {
  const t = state(s);
  t.scope = '';
  t.calls.clear();
  t.extra.length = 0;
}
export function textContext(s: NoahState, id: number): void {
  state(s).scope = String(id);
}
export function textLocation(s: NoahState, kind: string): string {
  const t = state(s),
    key = `${t.scope}/${kind}`,
    n = t.calls.get(key) ?? 0;
  t.calls.set(key, n + 1);
  return `${key}/${n}`;
}
export function fixedTextLocation(s: NoahState, kind: string): string {
  return `${state(s).scope}/${kind}`;
}
/** Read the native classified tokens; never re-parse a message or run expressions. */
export function tokenLayouts(s: NoahState, font: number): GlyphLayout[] {
  const result: GlyphLayout[] = [];
  let name = false,
    ruby = false,
    line = 0,
    rubyIndex = 0;
  const separateName = s.view(font + 8, 2).getUint16(0, true) !== 1;
  for (let i = 0, n = s.get(0x737988) >>> 0; i < n; i++) {
    const id = s.view(0x80d860 + i * 2, 2).getUint16(0, true);
    if (id === 0x8001) name = separateName;
    if (id === 0x800a) {
      ruby = true;
      rubyIndex++;
    }
    result.push({
      role: ruby ? `ruby-${rubyIndex}` : name ? 'name' : 'body',
      line: ruby || name ? 0 : line,
    });
    if (id === 0x8002) name = false;
    if (id === 0x800b) ruby = false;
    if (s.bytes(0x80c520 + i, 1)[0] === 7 && !(id === 0x8002 && separateName)) line++;
  }
  return result;
}
export function packedLayouts(s: NoahState, slot: number): GlyphLayout[] {
  const t = state(s);
  let a = t.packed.get(slot);
  if (!a) {
    a = [];
    t.packed.set(slot, a);
  }
  return a;
}
export function tipsLayouts(s: NoahState): GlyphLayout[] {
  return state(s).tips;
}
export function historyLayouts(s: NoahState): Map<number, GlyphLayout> {
  return state(s).history;
}
interface TaggedGlyph {
  slot: string;
  index: number;
  glyph: TextGlyph;
  shadow: boolean;
}
const glyphs = new WeakMap<DrawCommand, TaggedGlyph>(),
  rectangles = new WeakMap<DrawCommand, SpriteDraw>();
const interactionBoundaries = new WeakSet<DrawCommand>();
/** A modal surface owns interaction even when all of its labels are raster art. */
export function textInteractionBoundary(commands: readonly DrawCommand[]): void {
  if (commands.length) interactionBoundaries.add(commands[0]!);
}
export function tagGlyph(
  draw: DrawCommand,
  slot: string,
  index: number,
  id: number,
  layout: GlyphLayout,
  destination: Rect,
  color: number,
  alpha: number,
  shadow = false,
  clip?: Rect,
  raster?: GlyphRaster,
): void {
  if (!raster && !('kind' in draw))
    raster = {texture: draw.texture, source: {...draw.source}, alphaOnly: draw.mask?.alphaOnly};
  glyphs.set(draw, {
    slot: `${slot}/${layout.role}`,
    index,
    shadow,
    glyph: {
      id,
      text: decodeNoahGlyph(id),
      line: layout.line,
      ...destination,
      color,
      alpha,
      clip,
      raster,
    },
  });
}
export function extraGlyph(
  s: NoahState,
  slot: string,
  index: number,
  id: number,
  layout: GlyphLayout,
  destination: Rect,
  color: number,
  alpha: number,
  clip: Rect,
  raster?: GlyphRaster,
): void {
  state(s).extra.push({
    slot: `${slot}/${layout.role}`,
    index,
    shadow: false,
    glyph: {
      id,
      text: decodeNoahGlyph(id),
      line: layout.line,
      ...destination,
      color,
      alpha,
      clip,
      raster,
    },
  });
}
/** Submission may replace rectangles with triangles. Metadata is strictly a sidecar. */
export function transferTextDraw(from: DrawCommand, to: DrawCommand): void {
  if (interactionBoundaries.has(from)) interactionBoundaries.add(to);
  const tag = glyphs.get(from);
  if (tag) glyphs.set(to, tag);
  const rectangle = rectangles.get(from) ?? (!('kind' in from) ? from : undefined);
  if (rectangle) rectangles.set(to, rectangle);
}
function intersect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x),
    y = Math.max(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y),
  };
}
/** NOAH's phone draws text into surface 206 and then copies a rectangular window.
 * Historical framebuffer captures/thumbnails stay native images. */
export function collectTextFrame(
  commands: readonly DrawCommand[],
  s?: NoahState,
  images: ReadonlyMap<number, NonNullable<GlyphRaster['image']>> = new Map(),
): {
  slots: GlyphSlot[];
  omit: Set<DrawCommand>;
  after: Map<DrawCommand, GlyphSlot[]>;
  omitSlots: Map<DrawCommand, string>;
} {
  const currentImages = new Map(images);
  const screen: TaggedGlyph[] = [],
    phone: TaggedGlyph[] = [];
  let target: number | null = null;
  const owners = new Map<string, DrawCommand[]>(),
    anchors = new Map<string, DrawCommand>();
  // A DOM layer cannot participate in a later destination-dependent GPU blend.
  // Keep earlier text native in that case, rather than changing the blend.
  let lastDependent = -1,
    lastBoundary = -1,
    currentTarget: number | null = null;
  commands.forEach((c, i) => {
    if (interactionBoundaries.has(c)) lastBoundary = i;
    if ('kind' in c && c.kind === 'target') currentTarget = c.texture;
    else if (currentTarget === null && 'blendState' in c) {
      const b = c.blendState?.color;
      if (
        b &&
        (b.source !== 'source-alpha' ||
          b.destination !== 'inverse-source-alpha' ||
          b.operation !== 'add')
      )
        lastDependent = i;
    }
  });
  let commandIndex = -1;
  const dependent = new Set<string>();
  for (const command of commands) {
    commandIndex++;
    if ('kind' in command && command.kind === 'target') {
      target = command.texture;
      if (target === 206) phone.length = 0;
      continue;
    }
    if ('kind' in command && command.kind === 'texture')
      currentImages.set(command.texture, command.image);
    const original = glyphs.get(command),
      raster = original?.glyph.raster;
    const tag =
      original && raster
        ? {
            ...original,
            glyph: {
              ...original.glyph,
              raster: {...raster, image: currentImages.get(raster.texture)},
            },
          }
        : original;
    if (tag) {
      if (target !== null && target !== 206) continue;
      const list = owners.get(tag.slot) ?? [];
      list.push(command);
      owners.set(tag.slot, list);
      if (target === 206) phone.push(tag);
      else {
        screen.push(tag);
        if (!tag.shadow) {
          anchors.set(tag.slot, command);
          if (commandIndex <= lastDependent) dependent.add(tag.slot);
        }
      }
      continue;
    }
    const r = rectangles.get(command) ?? (!('kind' in command) ? command : undefined);
    if (target === null && r?.texture === 206 && r.source.width && r.source.height) {
      const sx = r.destination.width / r.source.width,
        sy = r.destination.height / r.source.height;
      for (const t of phone) {
        anchors.set(t.slot, command);
        if (commandIndex <= lastDependent) dependent.add(t.slot);
        const g = t.glyph,
          clip = intersect(r.destination, {
            x: r.destination.x + (g.x - r.source.x) * sx,
            y: r.destination.y + (g.y - r.source.y) * sy,
            width: g.width * sx,
            height: g.height * sy,
          });
        screen.push({
          ...t,
          glyph: {
            ...g,
            x: r.destination.x + (g.x - r.source.x) * sx,
            y: r.destination.y + (g.y - r.source.y) * sy,
            width: g.width * sx,
            height: g.height * sy,
            alpha:
              (Math.max(0, Math.min(255, g.alpha)) * Math.max(0, Math.min(255, r.alpha))) / 255,
            clip,
          },
        });
      }
    }
  }
  if (s)
    for (const extra of state(s).extra)
      if (anchors.has(extra.slot))
        screen.push(
          extra.glyph.raster
            ? {
                ...extra,
                glyph: {
                  ...extra.glyph,
                  raster: {
                    ...extra.glyph.raster,
                    image: currentImages.get(extra.glyph.raster.texture),
                  },
                },
              }
            : extra,
        );
  const groups = new Map<string, Map<number, TextGlyph>>(),
    shadows = new Map<string, Map<number, TextGlyph[]>>();
  for (const {slot, index, glyph, shadow} of screen) {
    if (!shadow) continue;
    let group = shadows.get(slot);
    if (!group) {
      group = new Map();
      shadows.set(slot, group);
    }
    const passes = group.get(index) ?? [];
    passes.push(glyph);
    group.set(index, passes);
  }
  for (const {slot, index, glyph} of screen.filter((t) => !t.shadow)) {
    let group = groups.get(slot);
    if (!group) {
      group = new Map();
      groups.set(slot, group);
    }
    group.set(index, glyph);
  }
  const slots: GlyphSlot[] = [],
    omit = new Set<DrawCommand>(),
    after = new Map<DrawCommand, GlyphSlot[]>(),
    omitSlots = new Map<DrawCommand, string>();
  for (const [id, group] of groups) {
    const buffer = [...group]
      .sort((a, b) => a[0] - b[0])
      .map(([index, g]) => {
        const passes = shadows.get(id)?.get(index);
        if (!passes?.length) return g;
        const effects: TextShadow[] = passes.map((p) => ({
          x: p.x - g.x,
          y: p.y - g.y,
          color: p.color,
          alpha: p.alpha,
        }));
        return {...g, shadows: effects};
      });
    // Unknown/custom artwork is never silently changed into invented Unicode.
    const slot: GlyphSlot = {
      id,
      glyphs: buffer,
      interactive: commands.indexOf(anchors.get(id)!) >= lastBoundary,
    };
    slots.push(slot);
    if (dependent.has(id) || buffer.some((g) => g.text === undefined)) continue;
    const anchor = anchors.get(id)!;
    after.set(anchor, [...(after.get(anchor) ?? []), slot]);
    for (const d of owners.get(id) ?? []) {
      omit.add(d);
      omitSlots.set(d, id);
    }
  }
  return {slots, omit, after, omitSlots};
}

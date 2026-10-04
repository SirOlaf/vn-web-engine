import {intersectRect, type Rect} from '../graphics/surface.js';
import type {TextOutline, TextShadow} from './glyph-slots.js';
import {recordRuntimeMetric} from '../platform/runtime-performance.js';

/** Optional presentation provenance. These objects never replace engine-owned pixels. */
export interface RasterTextStorage {
  readonly bytes: Uint8Array;
  cloneRange(offset: number, length: number): RasterTextStorage;
}
export interface RasterTextBitmap {
  storage: RasterTextStorage | null;
  offset: number;
  stride: number;
  bytesPerPixel: number;
  width: number;
  height: number;
  /** A presentation owner can isolate control text from neighboring body text. */
  rasterTextFlow?: string;
}
export interface RasterTextGlyph extends Rect {
  id: number;
  flow?: string;
  text: string;
  clip: Rect;
  size: number;
  family: string;
  bold: boolean;
  /** CSS font weight; `bold` is true from 600. */
  weight: number;
  /** Native glyph width relative to `size`; advances beyond the glyph are spacing. */
  stretch: number;
  vertical: boolean;
  color: number;
  alpha: number;
  outline?: TextOutline;
  shadows?: readonly TextShadow[];
}
export interface RasterTextStyle {
  size?: number;
  family?: string;
  bold?: boolean;
  weight?: number;
  stretch?: number;
  vertical?: boolean;
  decorative?: boolean;
  color?: number;
  alpha?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}
interface Plane {
  bitmap: RasterTextBitmap;
  blank: RasterTextStorage;
  glyphs: RasterTextGlyph[];
  clearedBytes: number;
  receivedText: boolean;
  differenceByte: number;
}
const planes = new WeakMap<RasterTextStorage, Plane>();
let nextGlyph = 0;
let depth = 0;
let presentationReplay = false;

/** Clips may differ while one semantic glyph retains the same identity/geometry. */
export function rasterTextGlyphKey(g: RasterTextGlyph): string {
  return JSON.stringify([g.flow ?? null, g.id, g.x, g.y, g.width, g.height]);
}

/** A textless presentation may contain transparent pixels where native ink was
 * nonzero. Kernels can handle that presentation-only degeneracy without changing
 * the original invocation's arithmetic or faults. */
export function isRasterTextPresentation(): boolean {
  return presentationReplay;
}

function bounds(bitmap: RasterTextBitmap): Rect {
  return {x: 0, y: 0, width: bitmap.width, height: bitmap.height};
}
/** A descriptor crop changes only its origin; shared allocations retain one text plane. */
function origin(bitmap: RasterTextBitmap, plane: Plane): [number, number] {
  const delta = bitmap.offset - plane.bitmap.offset;
  const y = Math.floor(delta / plane.bitmap.stride);
  return [(delta - y * plane.bitmap.stride) / plane.bitmap.bytesPerPixel, y];
}
function shifted(rect: Rect, x: number, y: number): Rect {
  return {...rect, x: rect.x + x, y: rect.y + y};
}
function removeRegion(plane: Plane, region: Rect): void {
  let kept: RasterTextGlyph[] | undefined;
  for (let i = 0; i < plane.glyphs.length; i++) {
    const glyph = plane.glyphs[i]!,
      c = glyph.clip;
    const x = Math.max(c.x, region.x),
      y = Math.max(c.y, region.y),
      width = Math.min(c.x + c.width, region.x + region.width) - x,
      height = Math.min(c.y + c.height, region.y + region.height) - y;
    if (!(width > 0 && height > 0)) {
      kept?.push(glyph);
      continue;
    }
    // Damage usually misses most glyphs or covers them completely. Allocate
    // only surviving fragments, retaining their top/bottom/left/right order.
    kept ??= plane.glyphs.slice(0, i);
    const top = y - c.y,
      bottom = c.y + c.height - y - height,
      left = x - c.x,
      right = c.x + c.width - x - width;
    if (c.width > 0 && top > 0)
      kept.push({...glyph, clip: {x: c.x, y: c.y, width: c.width, height: top}});
    if (c.width > 0 && bottom > 0)
      kept.push({...glyph, clip: {x: c.x, y: y + height, width: c.width, height: bottom}});
    if (left > 0) kept.push({...glyph, clip: {x: c.x, y, width: left, height}});
    if (right > 0) kept.push({...glyph, clip: {x: x + width, y, width: right, height}});
  }
  if (kept) plane.glyphs = kept;
}
function ensure(bitmap: RasterTextBitmap): Plane | undefined {
  if (!bitmap.storage || !bitmap.stride || !bitmap.bytesPerPixel) return;
  let plane = planes.get(bitmap.storage);
  if (!plane) {
    // cloneRange preserves the engine's initialization/liveness semantics.
    depth++;
    try {
      plane = {
        bitmap: {...bitmap, offset: 0},
        blank: bitmap.storage.cloneRange(0, bitmap.storage.bytes.length),
        glyphs: [],
        clearedBytes: 0,
        receivedText: false,
        differenceByte: -1,
      };
      planes.set(bitmap.storage, plane);
    } finally {
      depth--;
    }
  }
  return plane;
}

/** Cropped clears can erase the last text without ever clearing a whole allocation at once. */
function retireClearedPlane(bitmap: RasterTextBitmap, plane: Plane): void {
  const storage = bitmap.storage;
  if (!storage) return;
  const length = storage.bytes.length;
  plane.clearedBytes += Math.min(length, bitmap.width * bitmap.height * bitmap.bytesPerPixel);
  if (!(plane.clearedBytes >= length)) return;
  plane.clearedBytes = 0;
  const receivedText = plane.receivedText;
  plane.receivedText = false;
  // An entire redraw can clear old text and immediately draw it again. Avoid
  // repeated full scans or retiring/recloning that still-active presentation.
  if (receivedText || plane.glyphs.length !== 0) return;
  const original = storage.bytes,
    blank = plane.blank.bytes;
  if (
    original.length !== blank.length ||
    !(original.buffer instanceof ArrayBuffer) ||
    !(blank.buffer instanceof ArrayBuffer)
  )
    return;
  // Unchanged decorative ink can have no glyphs or incoming text. Remember a
  // failed comparison so later clears elsewhere do not rescan the allocation.
  if (plane.differenceByte >= 0 && original[plane.differenceByte] !== blank[plane.differenceByte])
    return;
  recordRuntimeMetric('text.raster.retirement-checks', 1);
  let byte = 0;
  if (((original.byteOffset | blank.byteOffset) & 3) === 0) {
    const words = Math.floor(length / 4),
      first = new Uint32Array(original.buffer, original.byteOffset, words),
      second = new Uint32Array(blank.buffer, blank.byteOffset, words);
    for (let index = 0; index < words; index++)
      if (first[index] !== second[index]) {
        byte = index * 4;
        while (original[byte] === blank[byte]) byte++;
        plane.differenceByte = byte;
        return;
      }
    byte = words * 4;
  }
  for (; byte < length; byte++)
    if (original[byte] !== blank[byte]) {
      plane.differenceByte = byte;
      return;
    }
  // Empty glyph metadata alone is insufficient: decorative ink has no glyphs.
  // Only byte equality proves this alternate plane no longer contributes.
  planes.delete(storage);
  recordRuntimeMetric('text.raster.retired-stale-planes', 1);
}

export function readRasterText(bitmap: RasterTextBitmap): RasterTextGlyph[] {
  const plane = bitmap.storage && planes.get(bitmap.storage);
  if (!plane) return [];
  const [x, y] = origin(bitmap, plane);
  const output: RasterTextGlyph[] = [];
  for (const glyph of plane.glyphs) {
    const left = glyph.clip.x - x,
      top = glyph.clip.y - y,
      cx = Math.max(left, 0),
      cy = Math.max(top, 0),
      width = Math.min(left + glyph.clip.width, bitmap.width) - cx,
      height = Math.min(top + glyph.clip.height, bitmap.height) - cy;
    if (width > 0 && height > 0)
      output.push({
        ...glyph,
        flow: bitmap.rasterTextFlow ?? glyph.flow,
        x: glyph.x - x,
        y: glyph.y - y,
        clip: {x: cx, y: cy, width, height},
      });
  }
  return output;
}
export function rasterTextBitmap<T extends RasterTextBitmap>(bitmap: T): T {
  const plane = bitmap.storage && planes.get(bitmap.storage);
  return plane ? ({...bitmap, storage: plane.blank} as T) : bitmap;
}
export function hasRasterText(bitmap: RasterTextBitmap): boolean {
  return !!bitmap.storage && planes.has(bitmap.storage);
}
/** Opaque later artwork can cover text without going through a text-specific
 * API. Compare the two presentation planes to exclude fully covered glyphs. */
export function visibleRasterText(bitmap: RasterTextBitmap): RasterTextGlyph[] {
  const original = bitmap.storage,
    alternate = rasterTextBitmap(bitmap).storage;
  if (!original || !alternate || original === alternate) return [];
  const glyphs = readRasterText(bitmap),
    visible = new Set<string>();
  for (const g of glyphs) {
    const identity = rasterTextGlyphKey(g);
    if (visible.has(identity)) continue;
    if (!g.text.trim()) {
      visible.add(identity);
      continue;
    }
    const c = intersectRect(g.clip, bounds(bitmap));
    if (!c) continue;
    let ink = false;
    for (
      let y = Math.max(0, Math.floor(c.y));
      y < Math.min(bitmap.height, Math.ceil(c.y + c.height));
      y++
    ) {
      const begin =
        bitmap.offset + y * bitmap.stride + Math.max(0, Math.floor(c.x)) * bitmap.bytesPerPixel;
      const end =
        bitmap.offset +
        y * bitmap.stride +
        Math.min(bitmap.width, Math.ceil(c.x + c.width)) * bitmap.bytesPerPixel;
      for (let byte = begin; byte < end; byte++)
        if (original.bytes[byte] !== alternate.bytes[byte]) {
          ink = true;
          break;
        }
      if (ink) break;
    }
    if (ink) visible.add(identity);
  }
  // Damage splits one glyph into multiple clips, including strips containing
  // only its transparent margins. Visibility belongs to the whole glyph: keep
  // all retained coverage if any fragment still has ink. Filtering each strip
  // separately makes unchanged text bounds depend on damage partitioning.
  return glyphs.filter((g) => visible.has(rasterTextGlyphKey(g)));
}
export function releaseRasterText(storage: RasterTextStorage): void {
  planes.delete(storage);
}
/** Synchronize a native write that contains no text, without replaying that write. */
export function clearRasterTextPresentation(bitmap: RasterTextBitmap): void {
  const storage = bitmap.storage,
    plane = storage && planes.get(storage);
  if (!plane || !storage) return;
  const [x, y] = origin(bitmap, plane);
  removeRegion(plane, shifted(bounds(bitmap), x, y));
  for (let row = 0; row < bitmap.height; row++) {
    const offset = bitmap.offset + row * bitmap.stride;
    plane.blank.bytes.set(
      storage.bytes.subarray(offset, offset + bitmap.width * bitmap.bytesPerPixel),
      offset,
    );
  }
  if (
    bitmap.offset === 0 &&
    bitmap.width * bitmap.bytesPerPixel === bitmap.stride &&
    bitmap.height * bitmap.stride === storage.bytes.length
  )
    planes.delete(storage);
  else retireClearedPlane(bitmap, plane);
}
/** Texture uploads may compare/skip native bytes, but still need the latest text
 * provenance (two different strings can have identical native raster pixels). */
export function copyRasterTextPresentation(
  destination: RasterTextBitmap,
  source: RasterTextBitmap,
): void {
  if (!hasRasterText(source) && !hasRasterText(destination)) return;
  const glyphs = readRasterText(source),
    plane = ensure(destination);
  if (!plane) return;
  const input = rasterTextBitmap(source).storage;
  if (!input) return;
  const width = Math.min(destination.width, source.width),
    height = Math.min(destination.height, source.height);
  for (let row = 0; row < height; row++) {
    const start = source.offset + row * source.stride;
    plane.blank.bytes.set(
      input.bytes.subarray(start, start + width * source.bytesPerPixel),
      destination.offset + row * destination.stride,
    );
  }
  const [x, y] = origin(destination, plane);
  removeRegion(plane, shifted({x: 0, y: 0, width, height}, x, y));
  plane.glyphs.push(
    ...glyphs.map((g) => ({...g, x: g.x + x, y: g.y + y, clip: shifted(g.clip, x, y)})),
  );
  plane.receivedText ||= hasRasterText(source);
}
/** Called by native storage cloning, not by the presentation clone above. */
export function cloneRasterText(
  source: RasterTextStorage,
  target: RasterTextStorage,
  offset: number,
  length: number,
): void {
  if (depth) return;
  const plane = planes.get(source);
  if (!plane) return;
  depth++;
  try {
    planes.set(target, {
      bitmap: {...plane.bitmap, storage: target, offset: plane.bitmap.offset - offset},
      blank: plane.blank.cloneRange(offset, length),
      glyphs: plane.glyphs.map((g) => ({...g, clip: {...g.clip}})),
      clearedBytes: 0,
      receivedText: true,
      differenceByte: -1,
    });
  } finally {
    depth--;
  }
}

/** Capture after rasterization, including decorative passes with no selectable string. */
export function recordRasterText(
  bitmap: RasterTextBitmap,
  text: string,
  style: RasterTextStyle = {},
): void {
  if (depth) return;
  const plane = ensure(bitmap);
  if (!plane) return;
  plane.receivedText = true;
  const [ox, oy] = origin(bitmap, plane);
  removeRegion(plane, shifted(bounds(bitmap), ox, oy));
  // Glyph buffers are transparent/black before composition. Preserve the native
  // allocation's validity map while removing ink only from this descriptor.
  for (let y = 0; y < bitmap.height; y++) {
    const start = bitmap.offset + y * bitmap.stride;
    plane.blank.bytes.fill(0, start, start + bitmap.width * bitmap.bytesPerPixel);
  }
  if (style.decorative || !text) return;
  const size = style.size ?? bitmap.height;
  const width =
    style.width ??
    Math.min(
      bitmap.width,
      Array.from(text).reduce((n, c) => n + (c.charCodeAt(0) < 0x100 ? 0.5 : 1), 0) * size,
    );
  const glyph = {x: style.x ?? 0, y: style.y ?? 0, width, height: style.height ?? size};
  const clip = intersectRect(glyph, bounds(bitmap));
  if (!clip) return;
  const weight = style.weight ?? (style.bold ? 700 : 400);
  plane.glyphs.push({
    ...shifted(glyph, ox, oy),
    clip: shifted(clip, ox, oy),
    id: ++nextGlyph,
    text,
    size,
    family: style.family ?? 'serif',
    bold: style.bold ?? weight >= 600,
    weight,
    stretch: style.stretch ?? 1,
    vertical: style.vertical ?? false,
    color: style.color ?? 0xffffff,
    alpha: style.alpha ?? 255,
  });
}

/** Edge effects the engine composites around glyph ink, in bitmap pixels. */
export interface RasterTextEffect {
  outline?: TextOutline;
  shadows?: readonly TextShadow[];
}
/**
 * Attach an edge effect to the glyphs already recorded in `bitmap`. Engines call this on
 * the source glyph before compositing its effect passes, which are recorded as decorative
 * ink; copies of the glyph carry the effect so DOM text can redraw the edge.
 */
export function decorateRasterText(bitmap: RasterTextBitmap, effect: RasterTextEffect): void {
  if (depth) return;
  const plane = bitmap.storage && planes.get(bitmap.storage);
  if (!plane) return;
  const [x, y] = origin(bitmap, plane),
    region = shifted(bounds(bitmap), x, y);
  plane.glyphs = plane.glyphs.map((g) =>
    intersectRect(g.clip, region)
      ? {
          ...g,
          ...(effect.outline ? {outline: effect.outline} : {}),
          ...(effect.shadows ? {shadows: effect.shadows} : {}),
        }
      : g,
  );
}

// Pixel kernels are synchronous and pure with respect to engine state. Nesting
// suppresses duplicate presentation work when one kernel calls another.
type Kernel = (...args: any[]) => any;
export interface RasterTextOperationOptions<T extends Kernel> {
  source?: number | number[];
  destination?: number;
  map?: (x: number, y: number, args: Parameters<T>) => [number, number];
  replace?: boolean | ((args: Parameters<T>) => boolean);
  alternateArgs?: (args: Parameters<T>) => Parameters<T>;
  opacity?: (args: Parameters<T>) => number;
  region?: (args: Parameters<T>) => Rect;
  color?: (color: number, args: Parameters<T>) => number;
  sourceOpacity?: (sourceIndex: number, args: Parameters<T>) => number;
  clear?: boolean;
  applied?: (result: ReturnType<T>, args: Parameters<T>) => boolean;
}
function isBitmap(value: unknown): value is RasterTextBitmap {
  return (
    !!value &&
    typeof value === 'object' &&
    'storage' in value &&
    'stride' in value &&
    'bytesPerPixel' in value
  );
}
function transformBounds<T extends Kernel>(
  r: Rect,
  map: RasterTextOperationOptions<T>['map'],
  args: Parameters<T>,
): Rect {
  if (!map) {
    const right = r.x + r.width,
      bottom = r.y + r.height,
      x = Math.min(r.x, right),
      y = Math.min(r.y, bottom);
    return {x, y, width: Math.max(r.x, right) - x, height: Math.max(r.y, bottom) - y};
  }
  const a = map(r.x, r.y, args),
    b = map(r.x + r.width, r.y, args),
    c = map(r.x, r.y + r.height, args),
    d = map(r.x + r.width, r.y + r.height, args),
    x = Math.min(a[0], b[0], c[0], d[0]),
    y = Math.min(a[1], b[1], c[1], d[1]);
  return {
    x,
    y,
    width: Math.max(a[0], b[0], c[0], d[0]) - x,
    height: Math.max(a[1], b[1], c[1], d[1]) - y,
  };
}
export function withRasterText<T extends Kernel>(
  kernel: T,
  options: RasterTextOperationOptions<T> = {},
): T {
  return function (this: unknown, ...args: Parameters<T>): ReturnType<T> {
    if (depth) return kernel.apply(this, args);
    const destination = args[options.destination ?? 0];
    if (!isBitmap(destination) || !args.some((a) => isBitmap(a) && hasRasterText(a)))
      return kernel.apply(this, args);
    const sourceIndices = options.clear ? [] : [options.source ?? 1].flat();
    const sources = sourceIndices.map((i) => args[i]).filter(isBitmap);
    const captured = sourceIndices.flatMap((i) =>
      isBitmap(args[i])
        ? readRasterText(args[i]).map((g) => ({
            ...g,
            alpha: g.alpha * (options.sourceOpacity?.(i, args) ?? 1),
          }))
        : [],
    );
    const plane = ensure(destination);
    if (!plane) return kernel.apply(this, args);
    const alternate = args.map((a) => (isBitmap(a) ? rasterTextBitmap(a) : a));
    depth++;
    let result: ReturnType<T>;
    try {
      result = kernel.apply(this, args);
      if (options.applied && !options.applied(result, args)) return result;
      presentationReplay = true;
      recordRuntimeMetric('text.raster.replay.destination-glyphs', plane.glyphs.length);
      recordRuntimeMetric('text.raster.replay.source-glyphs', captured.length);
      kernel.apply(
        this,
        options.alternateArgs ? options.alternateArgs(alternate as Parameters<T>) : alternate,
      );
    } finally {
      presentationReplay = false;
      depth--;
    }
    const [ox, oy] = origin(destination, plane);
    if (!options.clear)
      plane.receivedText ||=
        sources.some(hasRasterText) ||
        args.some((a, i) => i !== (options.destination ?? 0) && isBitmap(a) && hasRasterText(a));
    if (
      (typeof options.replace === 'function' ? options.replace(args) : options.replace) ||
      options.clear
    ) {
      const region = options.region?.(args) ?? bounds(destination);
      if (!options.region && !options.clear && !options.map && sources.length) {
        region.width = Math.min(region.width, ...sources.map((s) => s.width));
        region.height = Math.min(region.height, ...sources.map((s) => s.height));
      }
      removeRegion(plane, shifted(region, ox, oy));
    }
    const alpha = options.opacity?.(args) ?? 1;
    if (alpha > 0)
      for (const glyph of captured) {
        if (!(glyph.alpha * alpha > 0)) continue;
        const map = options.map,
          rect = transformBounds(glyph, map, args),
          clip = intersectRect(transformBounds(glyph.clip, map, args), bounds(destination));
        if (!clip || !Number.isFinite(rect.x + rect.y + rect.width + rect.height)) continue;
        const item = {
          ...glyph,
          ...shifted(rect, ox, oy),
          clip: shifted(clip, ox, oy),
          size: glyph.size * (glyph.height ? rect.height / glyph.height : 1),
          alpha: glyph.alpha * alpha,
          color: options.color?.(glyph.color, args) ?? glyph.color,
        };
        // Damage strips and repeated overlay draws may carry the same glyph.
        let count = 0;
        for (const g of plane.glyphs)
          if (
            g.id !== item.id ||
            g.flow !== item.flow ||
            g.x !== item.x ||
            g.y !== item.y ||
            g.clip.x !== item.clip.x ||
            g.clip.y !== item.clip.y ||
            g.clip.width !== item.clip.width ||
            g.clip.height !== item.clip.height
          )
            plane.glyphs[count++] = g;
        plane.glyphs[count++] = item;
        plane.glyphs.length = count;
      }
    if (
      options.clear &&
      destination.storage &&
      destination.offset === 0 &&
      destination.width * destination.bytesPerPixel === destination.stride &&
      destination.height * destination.stride === destination.storage.bytes.length
    )
      planes.delete(destination.storage);
    else if (options.clear) retireClearedPlane(destination, plane);
    return result;
  } as T;
}

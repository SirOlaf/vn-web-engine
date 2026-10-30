/** Character maps: FreeType 2.4.8's `tt_face_build_cmaps` subtable list, its default Unicode
 * charmap choice (`find_unicode_charmap`) and the format 4 and 12 lookups of `ttcmap.c`.
 */
import {Bytes, FontError, FontErrorCode, type TableEntry} from './sfnt.js';

const UNSORTED = 1,
  OVERLAPPING = 2;
/** Highest charmap index `find_unicode_charmap` considers (`FT_MAX_CHARMAP_CACHEABLE`). */
const MAX_CHARMAP_CACHEABLE = 15;

/** Formats with a FreeType cmap class; only these subtables become charmaps. */
const FORMATS = new Set([0, 2, 4, 6, 8, 10, 12, 13, 14]);

class Invalid extends Error {}

export type CharIndex = (codePoint: number) => number;

interface Charmap {
  platform: number;
  encoding: number;
  offset: number;
  format: number;
  flags: number;
}

/** The default charmap of a face, or null when FreeType selects none (glyph index = code). */
export function defaultCharmap(b: Bytes, table: TableEntry | null): CharIndex | null {
  if (!table) return null;
  const charmaps = buildCharmaps(b, table);
  const unicode = (c: Charmap) =>
    c.platform === 0 ||
    c.platform === 2 ||
    (c.platform === 3 && (c.encoding === 1 || c.encoding === 10));
  let chosen: Charmap | undefined;
  for (let i = charmaps.length - 1; i >= 0 && !chosen; i--) {
    const c = charmaps[i]!;
    if (
      unicode(c) &&
      ((c.platform === 3 && c.encoding === 10) || (c.platform === 0 && c.encoding === 4))
    )
      if (i <= MAX_CHARMAP_CACHEABLE) chosen = c;
  }
  for (let i = charmaps.length - 1; i >= 0 && !chosen; i--)
    if (unicode(charmaps[i]!) && i <= MAX_CHARMAP_CACHEABLE) chosen = charmaps[i];
  if (!chosen) return null;
  const limit = table.offset + table.length;
  if (chosen.format === 4) return format4(b, chosen.offset, chosen.flags, limit);
  if (chosen.format === 12) return format12(b, chosen.offset);
  if (chosen.format === 14) return () => 0;
  throw new FontError(FontErrorCode.UnimplementedFeature);
}

function buildCharmaps(b: Bytes, table: TableEntry): Charmap[] {
  const start = table.offset,
    limit = start + table.length,
    out: Charmap[] = [];
  if (start + 4 > limit || b.u16(start) !== 0) return out;
  let count = b.u16(start + 2),
    p = start + 4;
  for (; count > 0 && p + 8 <= limit; count--, p += 8) {
    const platform = b.u16(p),
      encoding = b.u16(p + 2),
      offset = b.u32(p + 4);
    if (!offset || offset > table.length - 2) continue;
    const at = start + offset,
      format = b.u16(at);
    if (!FORMATS.has(format)) continue;
    let flags = 0;
    try {
      if (format === 4) flags = validate4(b, at, limit);
      else if (format === 12) validate12(b, at, limit);
      else if (format === 14) validate14(b, at, limit);
    } catch (error) {
      if (error instanceof Invalid) continue;
      throw error;
    }
    out.push({platform, encoding, offset: at, format, flags});
  }
  return out;
}

/** `tt_cmap4_validate` at FT_VALIDATE_DEFAULT; returns the UNSORTED/OVERLAPPING flags. */
function validate4(b: Bytes, table: number, limit: number): number {
  let length = b.u16(table + 2);
  if (length < 16) throw new Invalid();
  if (table + length > limit) length = limit - table;
  const numSegs = b.u16(table + 6) >>> 1;
  if (length < 16 + numSegs * 2 * 4) throw new Invalid();
  const ends = table + 14,
    starts = table + 16 + numSegs * 2,
    deltas = starts + numSegs * 2,
    offsets = deltas + numSegs * 2,
    glyphIds = offsets + numSegs * 2;
  let flags = 0,
    lastStart = 0,
    lastEnd = 0;
  for (let n = 0; n < numSegs; n++) {
    const start = b.u16(starts + n * 2),
      end = b.u16(ends + n * 2),
      offset = b.u16(offsets + n * 2);
    if (start > end) throw new Invalid();
    if (start <= lastEnd && n > 0)
      flags |= lastStart > start || lastEnd > end ? UNSORTED : OVERLAPPING;
    if (offset && offset !== 0xffff) {
      const p = offsets + n * 2 + offset;
      if (n !== numSegs - 1 || !(start === 0xffff && end === 0xffff))
        if (p < glyphIds || p + (end - start + 1) * 2 > limit) throw new Invalid();
    } else if (offset === 0xffff) {
      if (n !== numSegs - 1 || !(start === 0xffff && end === 0xffff)) throw new Invalid();
    }
    lastStart = start;
    lastEnd = end;
  }
  return flags;
}

function validate12(b: Bytes, table: number, limit: number): void {
  if (table + 16 > limit) throw new Invalid();
  const length = b.u32(table + 4),
    groups = b.u32(table + 12);
  if (length > limit - table || length < 16 + 12 * groups) throw new Invalid();
  let last = 0;
  for (let n = 0, p = table + 16; n < groups; n++, p += 12) {
    const start = b.u32(p),
      end = b.u32(p + 4);
    if (start > end) throw new Invalid();
    if (n > 0 && start <= last) throw new Invalid();
    last = end;
  }
}

function validate14(b: Bytes, table: number, limit: number): void {
  const u24 = (o: number) => (b.u16(o) << 8) | b.u8(o + 2);
  const length = b.u32(table + 2),
    selectors = b.u32(table + 6);
  if (length > limit - table || length < 10 + 11 * selectors) throw new Invalid();
  let lastVarSel = 1;
  for (let n = 0, p = table + 10; n < selectors; n++, p += 11) {
    const varSel = u24(p),
      defOff = b.u32(p + 3),
      nondefOff = b.u32(p + 7);
    if (defOff >= length || nondefOff >= length) throw new Invalid();
    if (varSel < lastVarSel) throw new Invalid();
    lastVarSel = varSel + 1;
    if (defOff !== 0) {
      let q = table + defOff;
      const ranges = b.u32(q);
      q += 4;
      if (q + ranges * 4 > limit) throw new Invalid();
      let lastBase = 0;
      for (let i = 0; i < ranges; i++, q += 4) {
        const base = u24(q),
          cnt = b.u8(q + 3);
        if (base + cnt >= 0x110000) throw new Invalid();
        if (base < lastBase) throw new Invalid();
        lastBase = base + cnt + 1;
      }
    }
    if (nondefOff !== 0) {
      let q = table + nondefOff;
      const mappings = b.u32(q);
      q += 4;
      if (mappings * 4 > limit - q) throw new Invalid();
      let lastUni = 0;
      for (let i = 0; i < mappings; i++, q += 5) {
        const uni = u24(q);
        if (uni >= 0x110000) throw new Invalid();
        if (uni < lastUni) throw new Invalid();
        lastUni = uni + 1;
      }
    }
  }
}

/** `tt_cmap4_char_index` with its linear (unsorted) and binary searches. */
function format4(b: Bytes, data: number, flags: number, cmapEnd: number): CharIndex {
  const segs2 = b.u16(data + 6) & ~1,
    numSegs = segs2 >>> 1;
  const end = (i: number) => b.u16(data + 14 + i * 2),
    start = (i: number) => b.u16(data + 16 + segs2 + i * 2),
    delta = (i: number) => b.i16(data + 16 + segs2 * 2 + i * 2),
    offsetAt = (i: number) => data + 16 + segs2 * 3 + i * 2;
  /** The last 0xFFFF segment of some fonts has a bogus offset; FreeType maps it as delta 1. */
  const segment = (i: number): [number, number, number, number, number] => {
    const s = start(i),
      e = end(i),
      at = offsetAt(i);
    let d = delta(i),
      o = b.u16(at);
    if (i >= numSegs - 1 && s === 0xffff && e === 0xffff && o && at + o + 2 > cmapEnd) {
      d = 1;
      o = 0;
    }
    return [s, e, d, o, at];
  };
  const glyph = (code: number, s: number, d: number, o: number, at: number): number => {
    if (o) {
      const g = b.u16(at + o + (code - s) * 2);
      return g !== 0 ? (g + d) & 0xffff : 0;
    }
    return (code + d) & 0xffff;
  };
  if (flags & UNSORTED)
    return (code) => {
      if (code >= 0x10000 || !numSegs) return 0;
      for (let i = 0; i < numSegs; i++) {
        const e = end(i),
          s = start(i);
        if (code >= s && code <= e) {
          const [, , d, o, at] = segment(i);
          if (o === 0xffff) continue;
          return glyph(code, s, d, o, at);
        }
      }
      return 0;
    };
  return (code) => {
    if (code >= 0x10000 || !segs2) return 0;
    let min = 0,
      max = numSegs;
    while (min < max) {
      let mid = (min + max) >>> 1;
      const e0 = end(mid),
        s0 = start(mid);
      if (code < s0) max = mid;
      else if (code > e0) min = mid + 1;
      else {
        let [s, , d, o, at] = segment(mid);
        if (flags & OVERLAPPING) {
          // tt_cmap4_char_map_binary: the first segment containing `code`.
          max = mid;
          if (o === 0xffff) mid = max + 1;
          let i: number;
          for (i = max; i > 0; i--) {
            const prevEnd = end(i - 1);
            if (code > prevEnd) break;
            s = start(i - 1);
            d = delta(i - 1);
            at = offsetAt(i - 1);
            o = b.u16(at);
            if (o !== 0xffff) mid = i - 1;
          }
          if (mid === max + 1) {
            if (i !== max) {
              s = start(max);
              d = delta(max);
              at = offsetAt(max);
              o = b.u16(at);
            }
            mid = max;
            for (i = max + 1; i < numSegs; i++) {
              const nextStart = start(i);
              if (code < nextStart) break;
              s = nextStart;
              d = delta(i);
              at = offsetAt(i);
              o = b.u16(at);
              if (o !== 0xffff) mid = i;
            }
            i--;
            if (mid === max) {
              mid = i;
              return 0;
            }
          }
          if (mid !== i) {
            s = start(mid);
            d = delta(mid);
            at = offsetAt(mid);
            o = b.u16(at);
          }
        } else if (o === 0xffff) return 0;
        return glyph(code, s, d, o, at);
      }
    }
    return 0;
  };
}

/** `tt_cmap12_char_index`. */
function format12(b: Bytes, data: number): CharIndex {
  const groups = b.u32(data + 12);
  return (code) => {
    let min = 0,
      max = groups;
    while (min < max) {
      const mid = (min + max) >>> 1,
        p = data + 16 + 12 * mid,
        start = b.u32(p),
        end = b.u32(p + 4);
      if (code < start) max = mid;
      else if (code > end) min = mid + 1;
      else return (b.u32(p + 8) + code - start) >>> 0;
    }
    return 0;
  };
}

/** Runtime-only OpenType COLR v0 subsets. Each nontransparent atlas sample is
 * represented by a rectangle with its original RGBA palette entry. No tracing,
 * thresholding, Unicode remapping, or game data is embedded in this module. */
export interface AtlasFontGlyph {
  codePoint: number;
  width: number;
  height: number;
  advance: number;
  /** Cropped samples, including the pixels straddling fractional source edges. */
  pixels: Uint8Array;
  pixelWidth: number;
  pixelHeight: number;
  sourceX: number;
  sourceY: number;
  sourceWidth: number;
  sourceHeight: number;
}
const EM = 4096;
class Bytes {
  data: number[] = [];
  u8(n: number) {
    this.data.push(n & 255);
    return this;
  }
  u16(n: number) {
    return this.u8(n >>> 8).u8(n);
  }
  u32(n: number) {
    return this.u16(n >>> 16).u16(n);
  }
  zeros(n: number) {
    while (n-- > 0) this.u8(0);
    return this;
  }
  append(a: ArrayLike<number>) {
    for (let i = 0; i < a.length; i++) this.u8(a[i]!);
    return this;
  }
  finish() {
    return Uint8Array.from(this.data);
  }
}
function sum(bytes: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < bytes.length; i += 4)
    n =
      (n +
        (((bytes[i]! << 24) |
          ((bytes[i + 1] ?? 0) << 16) |
          ((bytes[i + 2] ?? 0) << 8) |
          (bytes[i + 3] ?? 0)) >>>
          0)) >>>
      0;
  return n;
}
/** Values are em fractions; y=0 is the native top of the glyph rectangle. */
export function buildAtlasFont(input: readonly AtlasFontGlyph[]): ArrayBuffer {
  const glyphs = [...input].sort((a, b) => a.codePoint - b.codePoint);
  if (!glyphs.length || glyphs.length > 32)
    throw new Error('Atlas font subsets need 1–32 characters');
  const palette: number[] = [],
    paletteIds = new Map<number, number>(),
    outlines: Uint8Array[] = [new Uint8Array()],
    advances: number[] = [EM],
    bearings: number[] = [0];
  const bases: {id: number; first: number; count: number}[] = [],
    layers: {id: number; color: number}[] = [];
  let maxPoints = 0,
    maxContours = 0,
    xMax = 0;
  for (let gi = 0; gi < glyphs.length; gi++) {
    const g = glyphs[gi]!;
    if (
      !Number.isInteger(g.codePoint) ||
      g.codePoint < 0 ||
      g.codePoint > 0x10ffff ||
      (gi > 0 && glyphs[gi - 1]!.codePoint === g.codePoint) ||
      ![g.width, g.height, g.advance, g.sourceWidth, g.sourceHeight].every(
        (n) => Number.isFinite(n) && n > 0,
      ) ||
      g.width > 7 ||
      g.height > 1 ||
      g.advance > 7 ||
      !Number.isInteger(g.pixelWidth) ||
      !Number.isInteger(g.pixelHeight) ||
      g.pixelWidth <= 0 ||
      g.pixelHeight <= 0 ||
      !Number.isFinite(g.sourceX) ||
      !Number.isFinite(g.sourceY) ||
      g.sourceX < 0 ||
      g.sourceY < 0 ||
      g.sourceX + g.sourceWidth > g.pixelWidth ||
      g.sourceY + g.sourceHeight > g.pixelHeight ||
      g.pixels.length !== g.pixelWidth * g.pixelHeight * 4
    )
      throw new Error('Invalid atlas font glyph');
    const advance = Math.round(g.advance * EM),
      base = outlines.length;
    outlines.push(new Uint8Array());
    advances.push(advance);
    bearings.push(0);
    const colors = new Map<number, number[][]>();
    for (let y = 0; y < g.pixelHeight; y++)
      for (let x = 0; x < g.pixelWidth;) {
        const at = (y * g.pixelWidth + x) * 4,
          rgba =
            ((g.pixels[at]! << 24) |
              (g.pixels[at + 1]! << 16) |
              (g.pixels[at + 2]! << 8) |
              g.pixels[at + 3]!) >>>
            0;
        let end = x + 1;
        while (end < g.pixelWidth) {
          const p = (y * g.pixelWidth + end) * 4;
          if (
            ((g.pixels[p]! << 24) |
              (g.pixels[p + 1]! << 16) |
              (g.pixels[p + 2]! << 8) |
              g.pixels[p + 3]!) >>>
              0 !==
            rgba
          )
            break;
          end++;
        }
        if (rgba & 255) {
          const left = Math.max(x, g.sourceX),
            right = Math.min(end, g.sourceX + g.sourceWidth),
            top = Math.max(y, g.sourceY),
            bottom = Math.min(y + 1, g.sourceY + g.sourceHeight);
          const x0 = Math.round(((left - g.sourceX) / g.sourceWidth) * g.width * EM),
            x1 = Math.round(((right - g.sourceX) / g.sourceWidth) * g.width * EM),
            y0 = Math.round(EM - ((bottom - g.sourceY) / g.sourceHeight) * g.height * EM),
            y1 = Math.round(EM - ((top - g.sourceY) / g.sourceHeight) * g.height * EM);
          if (x1 > x0 && y1 > y0) {
            let rects = colors.get(rgba);
            if (!rects) {
              rects = [];
              colors.set(rgba, rects);
            }
            rects.push([x0, y0, x0, y1, x1, y1, x1, y0]);
          }
        }
        x = end;
      }
    const first = layers.length;
    for (const [rgba, rects] of colors) {
      let color = paletteIds.get(rgba);
      if (color === undefined) {
        color = palette.length;
        paletteIds.set(rgba, color);
        palette.push(rgba);
      }
      const points = rects.flat(),
        xs = points.filter((_, i) => i % 2 === 0),
        ys = points.filter((_, i) => i % 2 === 1),
        xmin = Math.min(...xs),
        xmax = Math.max(...xs),
        ymin = Math.min(...ys),
        ymax = Math.max(...ys),
        n = rects.length;
      if (n * 4 > 65535) throw new Error('Atlas glyph outline exceeds OpenType limits');
      const b = new Bytes().u16(n).u16(xmin).u16(ymin).u16(xmax).u16(ymax);
      for (let i = 0; i < n; i++) b.u16(i * 4 + 3);
      b.u16(0);
      for (let i = 0; i < n * 4; i++) b.u8(1);
      for (const axis of [xs, ys]) {
        let previous = 0;
        for (const v of axis) {
          b.u16(v - previous);
          previous = v;
        }
      }
      layers.push({id: outlines.length, color});
      outlines.push(b.finish());
      advances.push(advance);
      bearings.push(xmin);
      maxPoints = Math.max(maxPoints, n * 4);
      maxContours = Math.max(maxContours, n);
      xMax = Math.max(xMax, xmax);
    }
    bases.push({id: base, first, count: layers.length - first});
  }
  if (outlines.length > 65535 || layers.length > 65535 || palette.length > 65535)
    throw new Error('Atlas font exceeds OpenType limits');
  const tables = new Map<string, Uint8Array>(),
    table = (name: string, b: Bytes) => tables.set(name, b.finish());
  const glyf = new Bytes(),
    loca = new Bytes();
  for (const outline of outlines) {
    loca.u32(glyf.data.length);
    glyf.append(outline);
    while (glyf.data.length % 4) glyf.u8(0);
  }
  loca.u32(glyf.data.length);
  table('glyf', glyf);
  table('loca', loca);
  table(
    'head',
    new Bytes()
      .u32(0x10000)
      .u32(0x10000)
      .u32(0)
      .u32(0x5f0f3cf5)
      .u16(3)
      .u16(EM)
      .zeros(16)
      .u16(0)
      .u16(0)
      .u16(xMax)
      .u16(EM)
      .u16(0)
      .u16(8)
      .u16(2)
      .u16(1)
      .u16(0),
  );
  table(
    'hhea',
    new Bytes()
      .u32(0x10000)
      .u16(EM)
      .u16(0)
      .u16(0)
      .u16(Math.max(...advances))
      .u16(0)
      .u16(-xMax)
      .u16(xMax)
      .u16(1)
      .u16(0)
      .u16(0)
      .zeros(8)
      .u16(0)
      .u16(outlines.length),
  );
  const hmtx = new Bytes();
  advances.forEach((a, i) => hmtx.u16(a).u16(bearings[i]!));
  table('hmtx', hmtx);
  table(
    'maxp',
    new Bytes()
      .u32(0x10000)
      .u16(outlines.length)
      .u16(maxPoints)
      .u16(maxContours)
      .u16(0)
      .u16(0)
      .u16(1)
      .zeros(16),
  );
  const cmap = new Bytes()
    .u16(0)
    .u16(1)
    .u16(3)
    .u16(10)
    .u32(12)
    .u16(12)
    .u16(0)
    .u32(16 + glyphs.length * 12)
    .u32(0)
    .u32(glyphs.length);
  glyphs.forEach((g, i) => cmap.u32(g.codePoint).u32(g.codePoint).u32(bases[i]!.id));
  table('cmap', cmap);
  const names = [
      [1, 'Runtime Atlas'],
      [2, 'Regular'],
      [4, 'Runtime Atlas Regular'],
      [6, 'RuntimeAtlas-Regular'],
    ] as const,
    strings = new Bytes(),
    name = new Bytes()
      .u16(0)
      .u16(names.length)
      .u16(6 + names.length * 12);
  for (const [id, value] of names) {
    name
      .u16(3)
      .u16(1)
      .u16(0x409)
      .u16(id)
      .u16(value.length * 2)
      .u16(strings.data.length);
    for (const ch of value) strings.u16(ch.charCodeAt(0));
  }
  table('name', name.append(strings.data));
  table('post', new Bytes().u32(0x30000).zeros(28));
  const os = new Bytes()
    .u16(0)
    .u16(EM)
    .u16(400)
    .u16(5)
    .u16(0)
    .zeros(20)
    .u16(0)
    .zeros(10)
    .zeros(16)
    .append([0x57, 0x45, 0x42, 0x20])
    .u16(0x40)
    .u16(Math.min(0xffff, glyphs[0]!.codePoint))
    .u16(Math.min(0xffff, glyphs.at(-1)!.codePoint))
    .u16(EM)
    .u16(0)
    .u16(0)
    .u16(EM)
    .u16(0);
  table('OS/2', os);
  const colr = new Bytes()
    .u16(0)
    .u16(bases.filter((b) => b.count).length)
    .u32(14)
    .u32(14 + bases.filter((b) => b.count).length * 6)
    .u16(layers.length);
  for (const b of bases) if (b.count) colr.u16(b.id).u16(b.first).u16(b.count);
  for (const l of layers) colr.u16(l.id).u16(l.color);
  table('COLR', colr);
  // Even an all-space subset needs a valid palette.
  if (!palette.length) palette.push(0);
  const cpal = new Bytes().u16(0).u16(palette.length).u16(1).u16(palette.length).u32(14).u16(0);
  for (const c of palette)
    cpal
      .u8(c >>> 8)
      .u8(c >>> 16)
      .u8(c >>> 24)
      .u8(c);
  table('CPAL', cpal);
  const entries = [...tables].sort(([a], [b]) => (a < b ? -1 : 1)),
    n = entries.length,
    power = 2 ** Math.floor(Math.log2(n)),
    header = new Bytes()
      .u32(0x10000)
      .u16(n)
      .u16(power * 16)
      .u16(Math.log2(power))
      .u16(n * 16 - power * 16),
    body = new Bytes();
  let headOffset = 0;
  for (const [tag, bytes] of entries) {
    const offset = 12 + n * 16 + body.data.length;
    for (const c of tag) header.u8(c.charCodeAt(0));
    header.u32(sum(bytes)).u32(offset).u32(bytes.length);
    if (tag === 'head') headOffset = offset;
    body.append(bytes);
    while (body.data.length % 4) body.u8(0);
  }
  const result = header.append(body.data).finish();
  new DataView(result.buffer).setUint32(headOffset + 8, (0xb1b0afba - sum(result)) >>> 0);
  return result.buffer;
}

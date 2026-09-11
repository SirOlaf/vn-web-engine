import type {TriangleImage} from '../graphics/triangle-draw.js';
import type {GlyphSlot, TextGlyph} from './glyph-slots.js';
import type {AtlasFontGlyph} from './atlas-font.js';
interface Design {
  key: string;
  glyph: TextGlyph;
  image: TriangleImage;
  width: number;
  height: number;
  advance: number;
}
interface Entry {
  family: string;
  faces: FontFace[];
  state: 'pending' | 'ready' | 'failed';
  used: number;
  bytes: number;
}
let nextFamily = 0;
/** Derived font bytes live only in worker messages and browser font memory. */
export class BrowserAtlasFonts {
  private worker: Worker | undefined;
  private nextJob = 0;
  private inFlight: number | undefined;
  private readonly jobs = new Map<
    number,
    {entry: Entry; range: string; glyphs?: AtlasFontGlyph[]}
  >();
  private readonly entries = new Map<string, Entry>();
  private readonly images = new WeakMap<TriangleImage, number>();
  private nextImage = 0;
  private epoch = 0;
  private readonly touched = new Set<string>();
  private failed = false;
  constructor(private readonly ready: () => void) {}
  private imageId(image: TriangleImage) {
    let id = this.images.get(image);
    if (id === undefined) {
      id = ++this.nextImage;
      this.images.set(image, id);
    }
    return id;
  }
  /** All occurrences of a Unicode character in one node must share a cmap glyph. */
  request(slot: GlyphSlot, images: ReadonlyMap<number, TriangleImage>): string | undefined {
    if (this.failed || !slot.glyphs.length) return;
    const size = Math.max(...slot.glyphs.map((g) => g.height));
    if (!(size > 0)) return;
    const designs = new Map<number, Design>();
    for (const g of slot.glyphs) {
      const r = g.raster,
        image = r?.image ?? (r && images.get(r.texture));
      if (
        !r ||
        !image ||
        !g.text ||
        Array.from(g.text).length !== 1 ||
        !(g.width > 0 && g.height > 0)
      )
        return;
      const code = g.text.codePointAt(0)!,
        width = g.width / size,
        height = g.height / size,
        advance = width;
      const key = JSON.stringify([
        this.imageId(image),
        r.source,
        r.alphaOnly ?? false,
        width,
        height,
        advance,
      ]);
      if (designs.has(code) && designs.get(code)!.key !== key) return;
      designs.set(code, {key, glyph: g, image, width, height, advance});
    }
    const ordered = [...designs].sort(([a], [b]) => a - b),
      key = ordered.map(([cp, d]) => `${cp}:${d.key}`).join('|');
    this.touched.add(key);
    let entry = this.entries.get(key);
    if (entry) {
      entry.used = ++this.epoch;
      return entry.state === 'ready' ? entry.family : undefined;
    }
    entry = {
      family: `GameAtlas${++nextFamily}`,
      faces: [],
      state: 'pending',
      used: ++this.epoch,
      bytes: 0,
    };
    this.entries.set(key, entry);
    try {
      if (!this.worker) {
        this.worker = new Worker(new URL('./atlas-font-worker.js', import.meta.url), {
          type: 'module',
        });
        this.worker.onmessage = (event) => {
          this.inFlight = undefined;
          void this.receive(event.data);
          this.pump();
        };
        this.worker.onerror = () => {
          this.failed = true;
          this.worker?.terminate();
          this.worker = undefined;
          this.inFlight = undefined;
          this.jobs.clear();
          for (const e of this.entries.values())
            if (e.state === 'pending') {
              e.state = 'failed';
              for (const f of e.faces) document.fonts.delete(f);
              e.faces = [];
            }
          console.warn('Atlas font worker failed; retaining native text.');
        };
      }
      const subsets: {range: string; glyphs: AtlasFontGlyph[]}[] = [];
      for (let at = 0; at < ordered.length; at += 31) {
        const part = ordered.slice(at, at + 31);
        subsets.push({
          range: part.map(([cp]) => `U+${cp.toString(16)}`).join(','),
          glyphs: part.map(([codePoint, d]) => {
            const r = d.glyph.raster!,
              s = r.source,
              left = Math.floor(s.x),
              top = Math.floor(s.y),
              pixelWidth = Math.ceil(s.x + s.width) - left,
              pixelHeight = Math.ceil(s.y + s.height) - top;
            if (
              ![s.x, s.y, s.width, s.height].every(Number.isFinite) ||
              s.width <= 0 ||
              s.height <= 0 ||
              left < 0 ||
              top < 0 ||
              left + pixelWidth > d.image.width ||
              top + pixelHeight > d.image.height ||
              pixelWidth * pixelHeight > 65536
            )
              throw new Error('Invalid atlas sample rectangle');
            const pixels = new Uint8Array(pixelWidth * pixelHeight * 4);
            for (let y = 0; y < pixelHeight; y++)
              pixels.set(
                d.image.pixels.subarray(
                  ((top + y) * d.image.width + left) * 4,
                  ((top + y) * d.image.width + left + pixelWidth) * 4,
                ),
                y * pixelWidth * 4,
              );
            if (r.alphaOnly)
              for (let p = 0; p < pixels.length; p += 4)
                pixels[p] = pixels[p + 1] = pixels[p + 2] = 255;
            return {
              codePoint,
              width: d.width,
              height: d.height,
              advance: d.advance,
              pixels,
              pixelWidth,
              pixelHeight,
              sourceX: s.x - left,
              sourceY: s.y - top,
              sourceWidth: s.width,
              sourceHeight: s.height,
            };
          }),
        });
      }
      // Reveal holes use literal spaces in the same Text node; supply that cmap
      // entry too so no system font enters the generated passage.
      if (!designs.has(32)) {
        const first = subsets[0]!;
        first.range += ',U+20';
        first.glyphs.push({
          codePoint: 32,
          width: 1,
          height: 1,
          advance: 1,
          pixels: new Uint8Array(4),
          pixelWidth: 1,
          pixelHeight: 1,
          sourceX: 0,
          sourceY: 0,
          sourceWidth: 1,
          sourceHeight: 1,
        });
      }
      for (const subset of subsets) {
        const id = ++this.nextJob;
        this.jobs.set(id, {entry, range: subset.range, glyphs: subset.glyphs});
      }
      this.pump();
    } catch (error) {
      entry.state = 'failed';
      console.warn('Could not generate atlas font; retaining native text.', error);
    }
    return;
  }
  private pump(): void {
    if (!this.worker || this.inFlight !== undefined) return;
    for (const [id, job] of this.jobs) {
      if (!job.glyphs) continue;
      if (job.entry.state !== 'pending') {
        this.jobs.delete(id);
        continue;
      }
      const glyphs = job.glyphs;
      job.glyphs = undefined;
      this.inFlight = id;
      this.worker.postMessage(
        {id, glyphs},
        glyphs.map((g) => g.pixels.buffer as ArrayBuffer),
      );
      return;
    }
  }
  private async receive(data: {id: number; buffer?: ArrayBuffer; error?: string}): Promise<void> {
    const job = this.jobs.get(data.id);
    if (!job) return;
    const {entry, range} = job;
    try {
      if (entry.state !== 'pending') return;
      if (data.error || !data.buffer) throw new Error(data.error ?? 'Missing atlas font');
      const face = new FontFace(entry.family, data.buffer, {unicodeRange: range});
      await face.load();
      if (!this.jobs.has(data.id) || entry.state !== 'pending') return;
      document.fonts.add(face);
      entry.faces.push(face);
      entry.bytes += data.buffer.byteLength;
    } catch (error) {
      entry.state = 'failed';
      for (const face of entry.faces) document.fonts.delete(face);
      entry.faces = [];
      console.warn('Browser rejected atlas font; retaining native text.', error);
    } finally {
      this.jobs.delete(data.id);
      if (entry.state === 'pending' && ![...this.jobs.values()].some((j) => j.entry === entry)) {
        entry.state = 'ready';
        this.ready();
      }
    }
  }
  /** Keep active entries; evict least recently used subsets beyond the cache budget. */
  retain(families: ReadonlySet<string>): void {
    let bytes = [...this.entries.values()].reduce((n, e) => n + e.bytes, 0);
    for (const [key, e] of [...this.entries].sort(([, a], [, b]) => a.used - b.used)) {
      if (this.entries.size <= 64 && bytes <= 32 * 1024 * 1024) break;
      if (families.has(e.family) || this.touched.has(key)) continue;
      for (const [id, j] of this.jobs) if (j.entry === e) this.jobs.delete(id);
      for (const f of e.faces) document.fonts.delete(f);
      bytes -= e.bytes;
      this.entries.delete(key);
    }
    this.touched.clear();
  }
  clear(): void {
    this.worker?.terminate();
    this.worker = undefined;
    this.inFlight = undefined;
    this.jobs.clear();
    for (const e of this.entries.values()) for (const f of e.faces) document.fonts.delete(f);
    this.entries.clear();
    this.touched.clear();
    this.failed = false;
  }
}

/** Reusable CPU reference compositor. Surfaces store premultiplied RGBA8, top-left origin. */
export type Rgba = readonly [number, number, number, number];
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface BlitOptions {
  source?: Rect;
  destination?: Rect;
  clip?: Rect;
  opacity?: number;
  blend?: 'copy' | 'source-over';
  filter?: 'nearest' | 'linear';
}
const byte = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
const product = (a: number, b: number) => Math.floor((a * b + 127) / 255);
function rect(r: Rect): void {
  if (![r.x, r.y, r.width, r.height].every(Number.isFinite) || r.width < 0 || r.height < 0)
    throw new Error('Invalid surface rectangle');
}
function color(c: Rgba): void {
  if (c.length !== 4 || !c.every((v) => Number.isInteger(v) && v >= 0 && v <= 255))
    throw new Error('Expected RGBA8 color');
}
export class Surface {
  private data: Uint8ClampedArray | undefined;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width < 1 ||
      height < 1 ||
      width * height > 16777216
    )
      throw new Error('Invalid surface dimensions');
    this.data = new Uint8ClampedArray(width * height * 4);
  }
  get pixels(): Uint8ClampedArray {
    if (!this.data) throw new Error('Surface has been disposed');
    return this.data;
  }
  dispose(): void {
    this.data = undefined;
  }
  clear(
    rgba: Rgba = [0, 0, 0, 0],
    area: Rect = {x: 0, y: 0, width: this.width, height: this.height},
  ): void {
    color(rgba);
    rect(area);
    const p = this.pixels,
      a = rgba[3],
      c = [product(rgba[0], a), product(rgba[1], a), product(rgba[2], a), a];
    const x0 = Math.max(0, Math.ceil(area.x - 0.5)),
      y0 = Math.max(0, Math.ceil(area.y - 0.5));
    const x1 = Math.min(this.width, Math.ceil(area.x + area.width - 0.5)),
      y1 = Math.min(this.height, Math.ceil(area.y + area.height - 0.5));
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) p.set(c, (y * this.width + x) * 4);
  }
  uploadStraight(rgba: Uint8Array | Uint8ClampedArray): void {
    if (rgba.length !== this.width * this.height * 4)
      throw new Error('Surface upload size mismatch');
    const p = this.pixels;
    // Copy first: even an aliased input has straight-alpha semantics.
    const input = rgba.buffer === p.buffer ? rgba.slice() : rgba;
    for (let i = 0; i < p.length; i += 4) {
      const a = input[i + 3]!;
      p[i] = product(input[i]!, a);
      p[i + 1] = product(input[i + 1]!, a);
      p[i + 2] = product(input[i + 2]!, a);
      p[i + 3] = a;
    }
  }
  straightPixels(): Uint8ClampedArray {
    const p = this.pixels,
      out = new Uint8ClampedArray(p.length);
    for (let i = 0; i < p.length; i += 4) {
      const a = p[i + 3]!;
      out[i + 3] = a;
      if (a) {
        out[i] = byte((p[i]! * 255) / a);
        out[i + 1] = byte((p[i + 1]! * 255) / a);
        out[i + 2] = byte((p[i + 2]! * 255) / a);
      }
    }
    return out;
  }
  blit(source: Surface, options: BlitOptions = {}): void {
    const src = options.source ?? {x: 0, y: 0, width: source.width, height: source.height};
    const dst = options.destination ?? {x: 0, y: 0, width: src.width, height: src.height};
    const clip = options.clip ?? {x: 0, y: 0, width: this.width, height: this.height};
    rect(src);
    rect(dst);
    rect(clip);
    if (
      src.x < 0 ||
      src.y < 0 ||
      src.x + src.width > source.width ||
      src.y + src.height > source.height
    )
      throw new Error('Source rectangle outside surface');
    const opacity = options.opacity ?? 1;
    if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1)
      throw new Error('Invalid blit opacity');
    const blend = options.blend ?? 'source-over',
      filter = options.filter ?? 'nearest';
    if (blend !== 'copy' && blend !== 'source-over') throw new Error('Unsupported surface blend');
    if (filter !== 'nearest' && filter !== 'linear') throw new Error('Unsupported surface filter');
    const output = this.pixels,
      original = source.pixels;
    if (!src.width || !src.height || !dst.width || !dst.height) return;
    // Read-before-write semantics make overlapping copies and off-screen feedback deterministic.
    const input = output.buffer === original.buffer ? original.slice() : original;
    const x0 = Math.max(0, Math.ceil(Math.max(dst.x, clip.x) - 0.5)),
      y0 = Math.max(0, Math.ceil(Math.max(dst.y, clip.y) - 0.5));
    const x1 = Math.min(
        this.width,
        Math.ceil(Math.min(dst.x + dst.width, clip.x + clip.width) - 0.5),
      ),
      y1 = Math.min(
        this.height,
        Math.ceil(Math.min(dst.y + dst.height, clip.y + clip.height) - 0.5),
      );
    const sample = (x: number, y: number, c: number) =>
      input[
        (Math.max(0, Math.min(source.height - 1, y)) * source.width +
          Math.max(0, Math.min(source.width - 1, x))) *
          4 +
          c
      ]!;
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const sx = src.x + ((x + 0.5 - dst.x) * src.width) / dst.width - 0.5,
          sy = src.y + ((y + 0.5 - dst.y) * src.height) / dst.height - 0.5;
        const pixel = [0, 0, 0, 0];
        for (let c = 0; c < 4; c++) {
          let value: number;
          if (filter === 'nearest') value = sample(Math.floor(sx + 0.5), Math.floor(sy + 0.5), c);
          else {
            const ix = Math.floor(sx),
              iy = Math.floor(sy),
              fx = sx - ix,
              fy = sy - iy;
            value =
              (sample(ix, iy, c) * (1 - fx) + sample(ix + 1, iy, c) * fx) * (1 - fy) +
              (sample(ix, iy + 1, c) * (1 - fx) + sample(ix + 1, iy + 1, c) * fx) * fy;
          }
          pixel[c] = byte(value * opacity);
        }
        const offset = (y * this.width + x) * 4,
          inverse = 255 - pixel[3]!;
        for (let c = 0; c < 4; c++)
          output[offset + c] =
            blend === 'copy'
              ? pixel[c]!
              : Math.min(255, pixel[c]! + product(output[offset + c]!, inverse));
      }
  }
}

/** Stable engine-owned target IDs; allocation and disposal never touch browser files. */
export class SurfaceTargets {
  private readonly targets = new Map<number, Surface>();
  create(id: number, width: number, height: number): Surface {
    if (!Number.isSafeInteger(id) || id < 0 || this.targets.has(id))
      throw new Error('Invalid or duplicate render target ID');
    const surface = new Surface(width, height);
    this.targets.set(id, surface);
    return surface;
  }
  get(id: number): Surface {
    const surface = this.targets.get(id);
    if (!surface) throw new Error(`Unknown render target ${id}`);
    return surface;
  }
  release(id: number): void {
    this.get(id).dispose();
    this.targets.delete(id);
  }
  dispose(): void {
    for (const s of this.targets.values()) s.dispose();
    this.targets.clear();
  }
}

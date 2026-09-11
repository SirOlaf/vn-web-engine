import {decodeBrowserImage} from '../../../../../graphics/browser-image.js';
import {checkRange} from '../../../../../core/binary.js';
import {decodePng} from '../../../../../formats/png/decode.js';
import type {DecodedPng} from '../../../../../formats/png/decode.js';
import {NoahState} from './noah-state.js';
import {nativeVideoProfiles} from './native-video-shaders.js';

export const SURFACE_BASE = 0x1d1b200,
  SURFACE_STRIDE = 0x1b0;
export interface TextureImage {
  width: number;
  height: number;
  pixels: Uint8Array;
}
export interface TextureResource {
  readonly id: number;
  /** Physical Y/U/V/A bindings of a native movie surface. */
  movie?: {planes: readonly number[]; shader: number; parameters: Float32Array};
  image: TextureImage;
  readonly format: 0 | 0xa0 | 0xa1;
  /** Native staging upload; texture visibility is committed by the graphics host. */
  pending: TextureImage | undefined;
}
/** Image preparation does not publish VM state. PNG is decoded locally; opaque WebP uses the pixel-verified browser codec. */
export async function prepareTexture(bytes: Uint8Array): Promise<DecodedPng> {
  if (
    bytes.length >= 12 &&
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true) ===
      0x46464952 &&
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8, true) === 0x50424557
  ) {
    return {...(await decodeBrowserImage(bytes, 'image/webp')), colorType: 6, bitDepth: 8};
  }
  return decodePng(bytes);
}

/** Noah texture ownership and metadata. GPU objects are replaced with real CPU resources.
 * Driver row pitch is represented by packed RGBA rows; it is not assumed to match a Windows GPU. */
export class NoahTextures {
  readonly resources = new Map<number, TextureResource>();
  readonly diagnostics: string[] = [];
  private nextObject = 0x600000000;
  private thumbnailReadback: {image: TextureImage | undefined} | undefined;
  constructor(readonly state: NoahState) {
    for (let id = 0; id < 512; id++) {
      const a = this.address(id);
      state.put(a, 0x1401ea5e8, 8);
      state.put(a + 0x28, 15, 8);
      this.reset(a);
      state.put(a + 0x1aa, 65535, 2);
    }
  }
  private address(id: number): number {
    checkRange(512, id, 1);
    return SURFACE_BASE + id * SURFACE_STRIDE;
  }
  private reset(a: number): void {
    const s = this.state;
    for (const [o, n] of [
      [0x30, 7],
      [0x38, 1],
      [0x68, 18],
      [0x40, 2],
      [0x56, 1],
      [0x58, 16],
      [0x98, 8],
      [0x20, 8],
      [0x120, 2],
      [0x128, 128],
    ] as const)
      s.zero(a + o, n);
    // Native basic_string keeps its heap pointer/capacity, but clears the
    // pointed allocation. Only the inline representation stores that byte here.
    if (s.view(a + 0x28, 8).getBigUint64(0, true) <= 15n) s.zero(a + 0x10, 1);
    s.put(a + 0x3c, -1);
    s.bytes(a + 0x44, 16).fill(255);
    s.put(a + 0x54, 0xff00, 2);
  }
  /** 1400224d0: reset only a live surface, retaining engine extension fields. */
  release(id: number): void {
    id |= 0;
    if (id > 0x200) {
      this.diagnostics.push(`GSLreleaseSurface: target ${id} out of range`);
      return;
    }
    if (id < 0)
      throw new Error(`Native surface release target ${id} precedes the mapped surface table`);
    // The native signed comparison admits index 512. That one-past surface
    // aliases the following mapped graphics record, so retain the exact edge.
    const a = SURFACE_BASE + id * SURFACE_STRIDE;
    if (this.state.bytes(a + 0x30, 1)[0]) {
      for (const plane of this.resources.get(id)?.movie?.planes ?? []) this.resources.delete(plane);
      this.resources.delete(id);
      if (id === 208) this.thumbnailReadback = undefined;
      this.reset(a);
    }
  }
  /** 1400225b0 hides a surface without releasing its allocation. */
  unload(id: number): void {
    id |= 0;
    if (id > 0x200) {
      this.diagnostics.push(`GSLunloadSurface: target ${id} out of range`);
      return;
    }
    if (id < 0)
      throw new Error(`Native surface unload target ${id} precedes the mapped surface table`);
    this.state.put(SURFACE_BASE + id * SURFACE_STRIDE + 0x32, 0, 1);
  }
  /** 140022190, RGBA format used by the complete background command. */
  createRgba(id: number, width: number, height: number): void {
    this.createSurface(id, width, height, 0);
  }
  /** 140022190 with native format selectors 0/1, as called by 01/00. */
  createSurface(id: number, width: number, height: number, format: 0 | 0xa0): void {
    id |= 0;
    if (id >= 512) {
      this.diagnostics.push(`GSLcreateSurfaceEx: target ${id} out of range`);
      return;
    }
    const a = this.address(id),
      s = this.state;
    if (s.bytes(a + 0x30, 1)[0] && s.bytes(a + 0x1a8, 1)[0]) return;
    this.release(id);
    this.reset(a);
    width &= 65535;
    height &= 65535;
    const bytesPerPixel = format === 0 ? 4 : 1,
      pitch = (width * bytesPerPixel + 3) & 0xfffc;
    s.put(a + 0x34, 1, 2);
    s.put(a + 0x3c, 0);
    s.put(a + 0x41, 1, 1);
    s.put(a + 0x54, 1, 1);
    s.put(a + 0x55, 0, 1);
    s.put(a + 0x56, bytesPerPixel * 8, 1);
    for (const off of [0x44, 0x48, 0x4c, 0x50]) s.put(a + off, 0);
    s.put(a + 0x44, format);
    for (const off of [0x68, 0x6c, 0x72, 0x76]) s.put(a + off, width, 2);
    for (const off of [0x6a, 0x6e, 0x74, 0x78]) s.put(a + off, height, 2);
    s.put(a + 0x6c, pitch / bytesPerPixel, 2);
    s.put(a + 0x70, pitch, 2);
    s.put(a + 0x58, pitch * height);
    s.put(a + 0x122, 0, 1);
    // D3D11 rejects zero or over-limit 2D textures at the allocation boundary.
    if (width < 1 || width > 16384 || height < 1 || height > 16384)
      throw new Error('Invalid native surface size');
    s.put(a + 0x128, this.nextObject++, 8);
    s.put(a + 0x188, this.nextObject++, 8);
    s.put(a + 0x30, 1, 1);
    const pixels = new Uint8Array(width * height * 4);
    if (format === 0xa0) for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
    this.resources.set(id, {id, format, image: {width, height, pixels}, pending: undefined});
  }
  /** 140022390 -> 140068930, with the native RGBA presentation format. */
  createRenderTarget(index: number, id: number, width: number, height: number): void {
    this.createRgba(id, width, height);
    const a = this.address(id);
    this.state.put(a + 0x32, 1, 1);
    this.state.put(a + 0x34, 0, 1);
    this.state.put(a + 0x38, 1, 1);
    this.state.put(a + 0x98, 0x1d7d290 + index * 0xeb0, 8);
    this.nextObject++; // Render-target view, separate from the texture and shader-resource view.
  }
  /** Fixed 1920x1080 YUVA420 allocations from 140021cb0 -> 14006f460.
   * 14006dc00 lays out four planes with each following offset aligned to 256.
   * These surfaces exist before CRI activation, including when movies are disabled. */
  initializeMovieSurface(id: 180 | 181): void {
    const a = this.address(id),
      s = this.state;
    if (s.bytes(a + 0x30, 1)[0] && s.bytes(a + 0x1a8, 1)[0]) return;
    this.release(id);
    this.reset(a);
    s.put(a + 0x34, 1, 2);
    s.put(a + 0x3c, 0);
    s.put(a + 0x41, 4, 1);
    s.put(a + 0x44, 0x112);
    s.put(a + 0x48, 1);
    s.put(a + 0x4c, 0);
    s.put(a + 0x50, 0);
    s.put(a + 0x54, 1, 1);
    s.put(a + 0x55, 0, 1);
    s.put(a + 0x56, 8, 1);
    s.put(a + 0x70, 1920, 2);
    s.put(a + 0x122, 0, 1);
    for (const o of [0x68, 0x6c, 0x72, 0x76]) s.put(a + o, 1920, 2);
    for (const o of [0x6a, 0x6e, 0x74, 0x78]) s.put(a + o, 1080, 2);
    let offset = 0;
    const ids = [id, -1000 - id * 4 - 1, -1000 - id * 4 - 2, -1000 - id * 4 - 3];
    for (let i = 0; i < 4; i++) {
      const width = i === 1 || i === 2 ? 960 : 1920,
        height = i === 1 || i === 2 ? 540 : 1080,
        p = a + 0xa0 + i * 32,
        size = width * height;
      s.zero(p, 26);
      s.put(p, offset, 8);
      s.put(p + 8, offset);
      s.put(p + 12, size);
      s.put(p + 16, width, 2);
      s.put(p + 18, height, 2);
      s.put(p + 20, width, 2);
      s.put(p + 22, height, 2);
      s.put(p + 24, width, 2);
      offset = (offset + size + 255) & ~255;
      s.put(a + 0x128 + i * 8, this.nextObject++, 8);
      s.put(a + 0x188 + i * 8, this.nextObject++, 8);
      const pixels = new Uint8Array(width * height * 4);
      for (let j = 3; j < pixels.length; j += 4) pixels[j] = 255;
      this.resources.set(ids[i]!, {
        id: ids[i]!,
        format: 0,
        image: {width, height, pixels},
        pending: undefined,
        ...(i === 0
          ? {movie: {planes: ids, shader: 4, parameters: new Float32Array(nativeVideoProfiles[0]!)}}
          : {}),
      });
    }
    s.put(a + 0x58, offset);
    s.put(a + 0x30, 1, 1);
  }
  /** Resource allocations from 140021cb0. */
  initializeRenderTargets(): void {
    this.state.put(0x586a54, 0x10000);
    this.initializeMovieSurface(180);
    this.initializeMovieSurface(181);
    for (let id = 209; id < 305; id++) {
      this.createRgba(id, 240, 135);
      this.state.put(this.address(id) + 0x34, 0, 1);
    }
    for (const [index, id] of [
      [0, 203],
      [1, 204],
      [2, 200],
      [3, 201],
      [4, 202],
      [6, 205],
      [7, 206],
      [5, 207],
    ])
      this.createRenderTarget(index!, id!, 1920, 1080);
    this.createRenderTarget(8, 208, 256, 135);
  }
  /** An executed framebuffer copy replaces immutable pixels without a staging upload. */
  publishRenderTarget(id: number, image: TextureImage): void {
    const resource = this.resources.get(id);
    if (!resource) throw new Error(`Missing render target ${id}`);
    if (image.width !== resource.image.width || image.height !== resource.image.height)
      throw new Error('Render target dimensions changed during submission');
    if (id === 208 && this.thumbnailReadback && !this.thumbnailReadback.image)
      this.thumbnailReadback.image = {...image, pixels: image.pixels.slice()};
    resource.image = image;
    resource.pending = undefined;
    this.state.put(this.address(id) + 0x32, 1, 1);
  }
  /** 140011260: queue the just-submitted target-8 capture for CPU readback.
   * 140070190 copies to staging now; 140077920 maps it on the next host pump. */
  requestThumbnailReadback(): void {
    const a = this.address(208),
      s = this.state;
    s.put(a + 0x80, 240);
    s.put(a + 0x84, 135);
    s.put(a + 0x88, 60);
    s.put(a + 0x8c, 0x1fa4);
    s.put(a + 0x90, 0x140587350, 8);
    s.put(a + 0x168, this.nextObject++, 8);
    s.put(a + 0x121, 2, 1);
    this.thumbnailReadback = {image: undefined};
  }
  /** 140070230 -> 14006deb0 -> 14007ed80, RGBA/no-swap thumbnail path.
   * The 256-wide capture is cropped to 240, with packed destination rows. */
  advanceReadbacks(): void {
    const request = this.thumbnailReadback;
    if (!request?.image) return;
    const a = this.address(208),
      s = this.state,
      {width, height, pixels} = request.image;
    const destinationWidth = s.get(a + 0x80) >>> 0 || width,
      destinationHeight = s.get(a + 0x84) >>> 0 || height;
    const destination = Number(s.view(a + 0x90, 8).getBigUint64(0, true)) - 0x140000000;
    const out = s.bytes(destination, destinationWidth * destinationHeight * 4),
      copyWidth = Math.min(width, destinationWidth),
      copyHeight = Math.min(height, destinationHeight);
    for (let y = 0; y < copyHeight; y++)
      out.set(
        pixels.subarray(y * width * 4, (y * width + copyWidth) * 4),
        y * destinationWidth * 4,
      );
    s.put(a + 0x58, width * height * 4);
    s.put(a + 0x70, width * 4, 2);
    s.put(a + 0x6c, width, 2);
    s.put(a + 0x60, 0, 8);
    s.put(a + 0x168, 0, 8);
    s.put(a + 0x121, 255, 1);
    this.thumbnailReadback = undefined;
  }
  fillRgba(id: number, color: readonly [number, number, number, number]): void {
    const r = this.resources.get(id);
    if (!r) return;
    const bytes = new Uint8Array(r.image.width * r.image.height * 4);
    for (let i = 0; i < bytes.length; i += 4) bytes.set(color, i);
    this.uploadRgba(id, bytes, r.image.width, r.image.height);
  }
  /** 140022660 -> create/load and upload. Keeps allocation when +1a8 requests reuse. */
  load(id: number, image: DecodedPng): void {
    if (id >= 512) {
      this.diagnostics.push(`GSLcreateLoadSurfaceEx: target ${id} out of range`);
      return;
    }
    const a = this.address(id),
      s = this.state;
    if (image.bitDepth === 16)
      throw new Error('Native PNG loader has no bounded 16-bit upload layout');
    const format = image.colorType === 0 ? 0xa0 : image.colorType === 4 ? 0xa1 : 0;
    const sourceBpp = format === 0 ? 4 : 1;
    if (
      !image.width ||
      !image.height ||
      image.width > 16383 ||
      image.height > 65535 ||
      image.pixels.length !== image.width * image.height * 4
    )
      throw new Error('Texture dimensions exceed native RGBA layout');
    let resource = this.resources.get(id);
    if (!s.bytes(a + 0x30, 1)[0] || !s.bytes(a + 0x1a8, 1)[0]) {
      this.release(id);
      this.reset(a);
      const width = image.width,
        height = image.height,
        pitch = (width * sourceBpp + 3) & ~3;
      s.put(a + 0x34, 1, 2);
      s.put(a + 0x3c, 0);
      s.put(a + 0x41, 1, 1);
      s.put(a + 0x54, 1, 1);
      s.put(a + 0x55, 0, 1);
      s.put(a + 0x56, sourceBpp * 8, 1);
      for (const off of [0x48, 0x4c, 0x50]) s.put(a + off, 0);
      s.put(a + 0x44, format);
      for (const off of [0x68, 0x6c, 0x72, 0x76]) s.put(a + off, width, 2);
      for (const off of [0x6a, 0x6e, 0x74, 0x78]) s.put(a + off, height, 2);
      s.put(a + 0x6c, pitch / sourceBpp, 2);
      s.put(a + 0x70, pitch, 2);
      s.put(a + 0x58, pitch * height);
      s.put(a + 0x122, 0, 1);
      s.put(a + 0x128, this.nextObject++, 8);
      s.put(a + 0x188, this.nextObject++, 8);
      s.put(a + 0x30, 1, 1);
      resource = {
        id,
        format,
        image: {width, height, pixels: new Uint8Array(width * height * 4)},
        pending: undefined,
      };
      this.resources.set(id, resource);
    }
    if (!resource) throw new Error(`Surface ${id} has native metadata but no texture resource`);
    const {width, height} = resource.image;
    // 14006fdc0 creates fresh staging; Web memory is zero initialized where the
    // native driver leaves contents unspecified. Upload clips, never scales.
    const allocatedBpp = resource.format === 0 ? 4 : 1,
      pitch = (width * allocatedBpp + 3) & ~3;
    const stride = pitch / allocatedBpp,
      staging = new Uint8Array(pitch * height);
    let source = image.pixels;
    if (format !== 0) {
      // 14007cab0 pads grayscale rows to 4 bytes; gray+alpha extracts only alpha,
      // with half the padded two-channel pitch. The uploader then uses width as
      // source stride, retaining the native behavior for odd widths.
      const decodedPitch =
        format === 0xa0 ? (image.width + 3) & ~3 : ((image.width * 2 + 3) & ~3) / 2;
      source = new Uint8Array(Math.max(image.width * image.height, decodedPitch * image.height));
      for (let y = 0; y < image.height; y++)
        for (let x = 0; x < image.width; x++)
          source[y * decodedPitch + x] =
            image.pixels[(y * image.width + x) * 4 + (format === 0xa1 ? 3 : 0)]!;
    }
    const copyWidth = Math.min(stride, image.width),
      copyHeight = Math.min(height, image.height);
    for (let y = 0; y < copyHeight; y++) {
      const start = y * stride * sourceBpp,
        length = copyWidth * sourceBpp;
      checkRange(staging.length, start, length);
      staging.set(
        source.subarray(y * image.width * sourceBpp, y * image.width * sourceBpp + length),
        start,
      );
    }
    const pixels = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const d = (y * width + x) * 4,
          src = y * pitch + x * allocatedBpp;
        if (resource.format === 0) {
          pixels[d] = staging[src]!;
          pixels[d + 1] = staging[src + 1]!;
          pixels[d + 2] = staging[src + 2]!;
          pixels[d + 3] = staging[src + 3]!;
        } else if (resource.format === 0xa0) {
          pixels[d] = staging[src]!;
          pixels[d + 3] = 255;
        } else pixels[d + 3] = staging[src]!;
      }
    resource.pending = {width, height, pixels};
    s.put(a + 0x148, this.nextObject++, 8);
    s.put(a + 0x58, pitch * height);
    s.put(a + 0x6c, stride, 2);
    s.put(a + 0x70, pitch, 2);
    s.put(a + 0x44, format);
    s.put(a + 0x4c, 0);
    s.put(a + 0x120, 1, 1);
    s.put(a + 0x60, 0, 8);
    s.put(a + 0x32, 0, 1);
    if (s.bytes(0x1dd97e9, 1)[0]) this.commit(id);
    s.put(a + 0x76, s.view(a + 0x68, 2).getUint16(0, true), 2);
    s.put(a + 0x78, s.view(a + 0x6a, 2).getUint16(0, true), 2);
  }
  /** 14006f5d0: raw RGBA upload into a live allocation, without resizing it. */
  uploadRgba(id: number, bytes: Uint8Array, width: number, height: number): void {
    const a = this.address(id),
      s = this.state;
    if (!s.bytes(a + 0x30, 1)[0]) return;
    const resource = this.resources.get(id);
    if (!resource) throw new Error('Live native texture has no host resource');
    if (resource.format !== 0)
      throw new Error('Native RGBA upload would overrun a non-RGBA allocation');
    if (bytes.length !== width * height * 4) throw new Error('RGBA upload size mismatch');
    const pixels = new Uint8Array(resource.image.width * resource.image.height * 4),
      w = Math.min(width, resource.image.width),
      h = Math.min(height, resource.image.height);
    for (let y = 0; y < h; y++)
      pixels.set(bytes.subarray(y * width * 4, (y * width + w) * 4), y * resource.image.width * 4);
    resource.pending = {...resource.image, pixels};
    s.put(a + 0x148, this.nextObject++, 8);
    s.put(a + 0x44, 0);
    s.put(a + 0x4c, 0);
    s.put(a + 0x120, 1, 1);
    s.put(a + 0x60, 0, 8);
    s.put(a + 0x32, 0, 1);
    if (s.bytes(0x1dd97e9, 1)[0]) this.commit(id);
  }
  /** 140060440 -> 140077920, at entry to the application draw callback. */
  beginFrame(): void {
    const s = this.state;
    s.put(0x1dd97e9, 1, 1);
    for (const [id] of this.resources) {
      if (id < 0) continue;
      const a = this.address(id);
      if (s.bytes(a + 0x120, 1)[0] !== 1) continue;
      if (s.bytes(a + 0x30, 1)[0] && s.view(a + 0x148, 8).getBigUint64(0, true) !== 0n)
        this.commit(id);
      s.put(a + 0x120, 0, 1);
    }
    this.advanceReadbacks();
  }
  /** 140060510, after the application draw callback. */
  endFrame(): void {
    this.state.put(0x1dd97e9, 0, 1);
  }
  /** Native immediate-copy path; deferred drawing uses its audited flush point. */
  commit(id: number): void {
    const resource = this.resources.get(id);
    if (!resource?.pending) return;
    resource.image = resource.pending;
    resource.pending = undefined;
    const a = this.address(id);
    this.state.put(a + 0x148, 0, 8);
    this.state.put(a + 0x120, 0, 1);
    this.state.put(a + 0x32, 1, 1);
  }
}

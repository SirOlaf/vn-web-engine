/**
 * The E-mote 3.9.8 renderer of the x64 D3D11 `emotedriver.dll` (SHA-256
 * `80d28bd088dda8e97c7c47a9c664e55159f70505b0f9fde3158d8ce2a3e1e051`) as WebGL draw commands.
 * Addresses are functions of that build.
 *
 * `EmoteRenderer.render` replays the render handler (0x180006430 → 0x1800069a0) over a clip's
 * draw list into one render-target surface: the list is ordered by (z, clip flags, list
 * index), each item becomes a textured triangle mesh (0x18005b5a0) and the device selects the
 * pixel program and blend state from the item and the pass state. The device runs in alpha
 * mask mode (device +0x1fc = 1, set by the host): items sharing a stencil parent are drawn
 * through an A8 mask that the parent chain builds first. Destination-reading blend modes
 * (`bm & 0xf00` = 0x100) copy the destination region into a copy texture before each draw
 * (0x180060dd0); 0x10c is a mosaic and 0x10d a separable blur drawn in several passes.
 *
 * The pixel programs are generated here from the variant parameters of the native shader
 * tables (`fs_basic`, `fs_bufferedBlend`, `fs_buildAlphamask`); the native HLSL is not used.
 * Positions are raw E-mote coordinates under the host's projection (Artemis: origin at the
 * target centre, y down). Screen-space reads use D3D pixel positions: x right, y down from the
 * top row of the target.
 *
 * Atlas textures upload their block data unchanged and decode once on the GPU into an RGBA8
 * surface (`block-texture.ts`). Formats the device would convert on the CPU (`RGBA5650`,
 * `RGBA5551`, `RGBA4444`, `RGBA8`, `RGBX8`, `ETC1`, `PVRTC`, `CI4`, `CI8`) throw
 * `EmoteUnsupportedError`, as do item clip rectangles, the stencil-buffer mode (device mode 0)
 * and blend indices outside the device table.
 */

import type {EmoteModel, EmoteTexture} from '../../formats/emote/model.js';
import type {BlendState} from '../../graphics/blend.js';
import {
  gpuTextureByteLength,
  gpuTextureDecodeCommands,
  packedGpuTexture,
  type GpuTextureFormat,
} from '../../graphics/block-texture.js';
import type {DrawCommand} from '../../graphics/draw-list.js';
import {GpuRenderSurface} from '../../graphics/gpu-render-surface.js';
import type {AdditionalTexture, TriangleDraw, TriangleImage} from '../../graphics/triangle-draw.js';
import type {EmoteDrawItem, EmoteVertexGrid} from './clip.js';
import {EmoteUnsupportedError} from './player.js';

const f32 = Math.fround;
const FLT_MAX = f32(3.4028234663852886e38);

/** Texture ownership of the draw target: ids for images and prepared GPU surfaces. */
export interface EmoteRenderHost {
  /** Registers `image` as a draw texture; a `GpuRenderSurface` is prepared as a target. */
  addTexture(image: TriangleImage): number;
  /** Releases a texture registered by `addTexture` and its target allocation. */
  removeTexture(id: number): void;
}

/** PSB texture `type` → uploaded format and the device format (texture +0x44, 0x18005d4f0). */
const TEXTURE_FORMATS: ReadonlyMap<string, {format: GpuTextureFormat; dxgi: number}> = new Map(
  [
    ['L8', 'r8', 0x3d],
    ['L8_SW', 'r8', 0x3d],
    ['A8', 'a8', 0x41],
    ['A8_SW', 'a8', 0x41],
    ['A8L8', 'r8g8', 0x31],
    ['A8L8_SW', 'r8g8', 0x31],
    ['DXT1', 'bc1', 0x47],
    ['DXT3', 'bc2', 0x4a],
    ['DXT5', 'bc3', 0x4d],
    ['DXT5_SW', 'bc3', 0x4d],
    ['BC7', 'bc7', 0x62],
    ['BC7_SW', 'bc7', 0x62],
  ].map(([type, format, dxgi]) => [
    type as string,
    {format: format as GpuTextureFormat, dxgi: dxgi as number},
  ]),
);

/** Pixel-program texture kind (0x180063030): 0 none, 2 A8, 3 R8, 4 R8G8, 1 any other. */
function textureKind(dxgi: number | null): number {
  if (dxgi === null) return 0;
  return dxgi === 0x41 ? 2 : dxgi === 0x3d ? 3 : dxgi === 0x31 ? 4 : 1;
}

interface AtlasTexture {
  readonly id: number;
  readonly surface: GpuRenderSurface;
  readonly kind: number;
  references: number;
}

/**
 * Decoded atlas textures shared by renderers. A texture decodes on first use; its packed
 * upload is released at the next `beginFrame`, which the owner calls once per draw list
 * after the previous list has executed.
 */
export class EmoteTextureCache {
  private readonly textures = new Map<EmoteTexture, AtlasTexture>();
  private readonly uploads: number[] = [];
  constructor(private readonly host: EmoteRenderHost) {}

  beginFrame(): void {
    for (const id of this.uploads.splice(0)) this.host.removeTexture(id);
  }

  /** The decoded surface of `texture`; a first use appends its decode to `commands`. */
  acquire(texture: EmoteTexture, commands: DrawCommand[]): AtlasTexture {
    let entry = this.textures.get(texture);
    if (!entry) {
      const spec = TEXTURE_FORMATS.get(texture.type);
      if (!spec) throw new EmoteUnsupportedError(`texture type ${texture.type}`);
      const {width, height} = texture;
      const bytes = texture.pixel.bytes;
      if (bytes.length < gpuTextureByteLength(spec.format, width, height))
        throw new Error(`E-mote texture data is shorter than ${texture.type} ${width}×${height}`);
      const packed = this.host.addTexture(
        packedGpuTexture(
          spec.format,
          width,
          height,
          bytes.subarray(0, gpuTextureByteLength(spec.format, width, height)),
        ),
      );
      this.uploads.push(packed);
      const surface = new GpuRenderSurface(width, height);
      entry = {
        id: this.host.addTexture(surface),
        surface,
        kind: textureKind(spec.dxgi),
        references: 0,
      };
      this.textures.set(texture, entry);
      commands.push(...gpuTextureDecodeCommands(spec.format, packed, surface));
    }
    return entry;
  }

  retain(texture: EmoteTexture): void {
    this.textures.get(texture)!.references++;
  }

  release(texture: EmoteTexture): void {
    const entry = this.textures.get(texture);
    if (!entry || --entry.references > 0) return;
    this.textures.delete(texture);
    this.host.removeTexture(entry.id);
  }

  close(): void {
    this.beginFrame();
    for (const entry of this.textures.values()) this.host.removeTexture(entry.id);
    this.textures.clear();
  }
}

// ---------------------------------------------------------------------------------------
// Device tables

const channel = (
  operation: 'add' | 'reverse-subtract',
  source: BlendState['color']['source'],
  destination: BlendState['color']['destination'],
): BlendState['color'] => ({operation, source, destination});
const KEEP_ALPHA = channel('add', 'zero', 'one');
const NORMAL: BlendState = {
  color: channel('add', 'source-alpha', 'inverse-source-alpha'),
  alpha: channel('add', 'one', 'inverse-source-alpha'),
};
/** Blend table of 0x180061d60 by blend index. */
const BLENDS: readonly BlendState[] = [
  NORMAL,
  {color: channel('add', 'source-alpha', 'one'), alpha: KEEP_ALPHA},
  {color: channel('reverse-subtract', 'source-alpha', 'one'), alpha: KEEP_ALPHA},
  {color: channel('add', 'destination-color', 'inverse-source-alpha'), alpha: KEEP_ALPHA},
  {color: channel('add', 'inverse-destination-color', 'one'), alpha: KEEP_ALPHA},
  {color: channel('reverse-subtract', 'source-alpha', 'one'), alpha: KEEP_ALPHA},
  NORMAL,
  {color: channel('add', 'inverse-destination-alpha', 'destination-alpha'), alpha: KEEP_ALPHA},
  {color: channel('add', 'one', 'zero'), alpha: KEEP_ALPHA},
  NORMAL,
  {
    color: channel('add', 'zero', 'inverse-source-alpha'),
    alpha: channel('add', 'zero', 'inverse-source-alpha'),
  },
  {color: channel('add', 'one', 'zero'), alpha: KEEP_ALPHA},
  {color: channel('add', 'one', 'zero'), alpha: channel('add', 'one', 'zero')},
];
const REPLACE: BlendState = {
  color: channel('add', 'one', 'zero'),
  alpha: channel('add', 'one', 'zero'),
};

/** Pass state (state +0x444): 0 plain, 1 mask targets ready, 3/4 first/next mask
 * intersection, 5 mask subtraction, 6 masked group. */
type PassState = 0 | 1 | 3 | 4 | 5 | 6;

/** Blend index of 0x180061d60 for the pass state and blend mode. */
function blendIndex(state: PassState, bm: number): number {
  if (state === 3 || state === 4) return 9;
  if (state === 5) return 10;
  return (bm & 0xf00) === 0x100 ? 0xb : bm & 0xff0f;
}

/** 0x10d blur pass radii (0x181fcbf90) and the copy expansion per pass (0x181fcd690). */
const BLUR_STEPS = [1, 2, 3, 6, 9] as const;
const BLUR_EXPAND = [1, 2, 2, 4, 6] as const;

/** `(uint)(int)x`: x64 truncation, 0x80000000 when out of range. */
function uintOf(x: number): number {
  const t = Math.trunc(x);
  return (Number.isFinite(t) && t >= -0x80000000 && t <= 0x7fffffff ? t : -0x80000000) >>> 0;
}

/** The comparator float of item +0xc (the clip flags word). */
const flagView = new DataView(new ArrayBuffer(4));
function flagFloat(flags: number): number {
  flagView.setUint32(0, flags >>> 0, true);
  return flagView.getFloat32(0, true);
}

/** 0xRRGGBBAA → the vertex colour 0xAARRGGBB of the draw loop. */
const vertexColor = (c: number): number => ((c << 24) | (c >>> 8)) >>> 0;

/** FUN_180030320's channel-pair lerp: weight `f`/256 on `r`. */
function lerpPacked(l: number, r: number, f: number): number {
  const g = 256 - f;
  const lo = (f * (r & 0xff00ff) + g * (l & 0xff00ff)) >>> 8;
  const hi = f * ((r >>> 8) & 0xff00ff) + g * ((l >>> 8) & 0xff00ff);
  return ((lo & 0xff00ff) | (hi & 0xff00ff00)) >>> 0;
}

/** Corner colours [top-left, top-right, bottom-left, bottom-right] spread over the vertex
 * grid (0x180032250): edge columns first, then each row. */
export function emoteColorGrid(corners: Uint32Array, cols: number, rows: number): Uint32Array {
  const w = cols + 1,
    h = rows + 1,
    out = new Uint32Array(w * h);
  if (corners[0] === corners[1] && corners[0] === corners[2] && corners[0] === corners[3]) {
    out.fill(corners[0]!);
    return out;
  }
  out[0] = corners[0]!;
  out[cols] = corners[1]!;
  out[rows * w] = corners[2]!;
  out[w * h - 1] = corners[3]!;
  for (const x of [0, cols]) {
    if (h <= 2) continue;
    const a = out[x]!,
      b = out[(h - 1) * w + x]!;
    for (let k = 1; k < h - 1; k++)
      out[k * w + x] = a === b ? a : lerpPacked(a, b, Math.trunc((k * 256) / (h - 1)));
  }
  for (let j = 0; j < h; j++) {
    if (w <= 2) continue;
    const a = out[j * w]!,
      b = out[j * w + cols]!;
    for (let k = 1; k < cols; k++)
      out[j * w + k] = a === b ? a : lerpPacked(a, b, Math.trunc((k * 256) / cols));
  }
  return out;
}

/** Cached grid bounds (0x180006000): min x, min y, max x, max y. */
function gridBounds(grid: EmoteVertexGrid): [number, number, number, number] {
  let x0 = FLT_MAX,
    y0 = FLT_MAX,
    x1 = -FLT_MAX,
    y1 = -FLT_MAX;
  const p = grid.points,
    n = (grid.cols + 1) * (grid.rows + 1) * 2;
  for (let i = 0; i < n; i += 2) {
    const x = p[i]!,
      y = p[i + 1]!;
    if (x <= x0) x0 = x;
    if (y <= y0) y0 = y;
    if (x1 <= x) x1 = x;
    if (y1 <= y) y1 = y;
  }
  return [x0, y0, x1, y1];
}

// ---------------------------------------------------------------------------------------
// Pixel programs

interface Program {
  /** basic: fs_basic; buffered: fs_bufferedBlend; mask: fs_buildAlphamask. */
  readonly family: 'basic' | 'buffered' | 'mask';
  readonly k: number;
  /** Diffuse modulation: 0 none, 4 multiply, 8 multiply and double the colour. */
  readonly a: number;
  /** The group mask multiplies the alpha (basic/buffered), or the previous mask (mask). */
  readonly masked: boolean;
  /** Colour filter (basic): 0 none, 3 mix, 6 add, 9 subtract, 12 invert. */
  readonly f: number;
  /** Blend-mode fix-up (basic): 0 none, 1 invert, 2 premultiply. */
  readonly b: number;
  /** Destination formula (buffered), 0–18. */
  readonly n: number;
  /** Alpha scale and offset (mask). */
  readonly alphaTest: boolean;
}

const BUFFERED_FORMULAS: readonly string[] = [
  'col.rgb',
  'min(vec3(1.),dest.rgb+col.rgb)',
  'max(vec3(0.),dest.rgb+col.rgb-1.)',
  'mix(1.-(1.-dest.rgb)*(1.-col.rgb)*2.,dest.rgb*col.rgb*2.,vec3(lessThan(dest.rgb,vec3(.5))))',
  'mix(1.-(1.-dest.rgb)*(1.-col.rgb)*2.,dest.rgb*col.rgb*2.,vec3(lessThan(col.rgb,vec3(.5))))',
  'pow(dest.rgb,mix((1.-col.rgb)*2.,.5/col.rgb,vec3(greaterThan(col.rgb,vec3(.5)))))',
  'min(vec3(1.),dest.rgb/(1.-col.rgb))',
  'max(vec3(0.),1.-(1.-dest.rgb)/col.rgb)',
  'max(dest.rgb,col.rgb)',
  'min(dest.rgb,col.rgb)',
  'abs(dest.rgb-col.rgb)',
  'dest.rgb+col.rgb-2.*col.rgb*dest.rgb',
  '(.298912*dest.r+.586611*dest.g+.114478*dest.b)*col.rgb',
];
/** Blur taps of formulas 14–18: centre weight, then (offset, weight) pairs. */
const BLUR_TAPS: readonly (readonly number[])[] = [
  [0, 0.5, 0.5],
  [0.375, 1.2, 0.3125],
  [0.32258064516129, 1.28571428571429, 0.338709677419355],
  [0.227027027027027, 1.38461538461538, 0.316216216216216, 3.23076923076923, 0.0702702702702703],
  [
    0.185714285714286, 1.42105263157895, 0.288701298701299, 3.31578947368421, 0.103636363636364,
    5.21052631578947, 0.0148051948051948,
  ],
];

const glsl = (x: number): string => (Number.isInteger(x) ? `${x}.` : `${x}`);

/** GLSL `shade` of a program. Textures: `atlas` the item texture, `additionalAtlas0` the
 * mask when masked, then the destination copy (buffered). `parameters[0]` holds the filter
 * colour, alpha multiply-add or blend parameter, `parameters[1]` the copy's screenMulOffset,
 * `parameters[2].x` the target height. */
function fragment(p: Program): string {
  const lines: string[] = [];
  const copy = p.masked ? 'additionalAtlas1' : 'additionalAtlas0';
  lines.push('vec4 shade(vec4 sampled,vec4 tint){');
  lines.push('vec2 pos=vec2(gl_FragCoord.x,parameters[2].x-gl_FragCoord.y);');
  lines.push(
    [
      'vec4 col=tint;',
      'vec4 col=sampled;',
      'vec4 col=vec4(1.,1.,1.,sampled.a);',
      'vec4 col=vec4(sampled.rrr,1.);',
      'vec4 col=vec4(sampled.rrr,sampled.g);',
    ][p.k]!,
  );
  if (p.family === 'mask') {
    if (p.alphaTest) lines.push('col.a=clamp(col.a*parameters[0].x+parameters[0].y,0.,1.);');
    if (p.masked) lines.push('col.a*=texelFetch(additionalAtlas0,ivec2(gl_FragCoord.xy),0).a;');
    lines.push('return col;}');
    return lines.join('');
  }
  if (p.a >= 4) lines.push('col*=tint;');
  if (p.a === 8) lines.push('col.rgb*=2.;');
  if (p.masked) lines.push('col.a*=texelFetch(additionalAtlas0,ivec2(gl_FragCoord.xy),0).a;');
  if (p.family === 'basic') {
    if (p.f === 3) lines.push('col.rgb=mix(col.rgb,parameters[0].rgb,parameters[0].a);');
    else if (p.f === 6) lines.push('col.rgb+=parameters[0].rgb*parameters[0].a;');
    else if (p.f === 9) lines.push('col.rgb-=parameters[0].rgb*parameters[0].a;');
    else if (p.f === 12) lines.push('col.rgb=mix(col.rgb,1.-col.rgb,parameters[0].a);');
    if (p.b === 2) lines.push('col.rgb*=col.a;');
    else if (p.b === 1) lines.push('col.rgb=1.-col.rgb;');
    lines.push('return col;}');
    return lines.join('');
  }
  // Point-sampled, clamped reads of the copy; copy texel rows are stored bottom-up.
  lines.unshift(
    `vec4 emoteDest(vec2 uv){ivec2 cs=textureSize(${copy},0);`,
    'ivec2 t=clamp(ivec2(floor(uv*vec2(cs))),ivec2(0),cs-1);',
    `return texelFetch(${copy},ivec2(t.x,cs.y-1-t.y),0);}`,
  );
  lines.push('vec2 vpos2=pos*parameters[1].xy+parameters[1].zw;', 'vec4 dest=emoteDest(vpos2);');
  if (p.n === 0) {
    // Formula 0 returns the source unchanged.
  } else if (p.n <= 12) lines.push(`col.rgb=mix(dest.rgb,${BUFFERED_FORMULAS[p.n]},col.a);`);
  else if (p.n === 13)
    lines.push(
      'vec2 mv=floor(vpos2*parameters[0].xy)/parameters[0].xy+parameters[0].zw;',
      'col.rgb=mix(dest.rgb,emoteDest(mv).rgb,col.a);',
    );
  else {
    const taps = BLUR_TAPS[p.n - 14]!;
    lines.push(`vec3 blur=dest.rgb*${glsl(taps[0]!)};`);
    for (let i = 1; i < taps.length; i += 2) {
      const o = `parameters[0].xy*${glsl(taps[i]!)}`,
        w = glsl(taps[i + 1]!);
      lines.push(`blur+=emoteDest(vpos2+${o}).rgb*${w};blur+=emoteDest(vpos2-${o}).rgb*${w};`);
    }
    lines.push('col.rgb=mix(dest.rgb,blur,col.a);');
  }
  lines.push('return col;}');
  return lines.join('');
}

const COPY_FRAGMENT = 'vec4 shade(vec4 sampled,vec4 tint){return sampled;}';

// ---------------------------------------------------------------------------------------
// Renderer

interface Mesh {
  readonly texture: AtlasTexture | null;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly grid: EmoteVertexGrid;
}

const WHITE = Uint32Array.of(0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff);
const DUMMY: TriangleImage = {width: 1, height: 1, pixels: Uint8Array.of(255, 255, 255, 255)};

/** One E-mote render target: a `width`×`height` surface the renderer draws the draw list
 * into, cleared to transparent black each frame. */
export class EmoteRenderer {
  readonly surface: GpuRenderSurface;
  /** Texture id of `surface`. */
  readonly texture: number;
  private readonly transform: Float32Array;
  private readonly dummy: number;
  private readonly used = new Set<EmoteTexture>();
  private readonly sources = new WeakMap<EmoteModel, (EmoteTexture | null)[]>();
  private readonly zeros = new Map<number, Float32Array>();
  private readonly programs = new Map<string, string>();
  private released: number[] = [];
  /** Mask targets (device +0x208/+0x210). */
  private masks:
    [{id: number; surface: GpuRenderSurface}, {id: number; surface: GpuRenderSurface}] | null =
    null;
  /** Destination copy (device +0x238/+0x240) and its screenMulOffset (+0x258). */
  private copy: {id: number; surface: GpuRenderSurface} | null = null;
  private readonly screenMulOffset = new Float32Array(4);
  /** Destination bounds (+0x248..+0x254) in E-mote coordinates. */
  private readonly bounds = new Float32Array([FLT_MAX, FLT_MAX, -FLT_MAX, -FLT_MAX]);

  // Per-frame draw state.
  private commands: DrawCommand[] = [];
  private filter: 'nearest' | 'linear' = 'nearest';
  private target: GpuRenderSurface;
  private state: PassState = 0;
  private maskTexture: {id: number; surface: GpuRenderSurface} | null = null;
  private alphaTest = false;
  private alphaMul = 1;
  private alphaAdd = 0;
  private grayscaleMode = 0;
  private grayscaleLevel = 0;

  constructor(
    private readonly host: EmoteRenderHost,
    private readonly cache: EmoteTextureCache,
    readonly width: number,
    readonly height: number,
  ) {
    this.surface = this.target = new GpuRenderSurface(width, height);
    this.texture = host.addTexture(this.surface);
    this.dummy = host.addTexture(DUMMY);
    this.transform = new Float32Array([
      f32(2 / width),
      0,
      0,
      0,
      0,
      f32(-2 / height),
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      1,
    ]);
  }

  /**
   * Commands that draw `items` (a clip draw list) into `surface` and return to the
   * presentation target. `smoothing` selects linear atlas filtering. Surfaces the previous
   * call replaced are released first, so each call follows the execution of the last.
   */
  render(items: readonly EmoteDrawItem[], smoothing: boolean): DrawCommand[] {
    for (const id of this.released.splice(0)) this.host.removeTexture(id);
    const commands: DrawCommand[] = (this.commands = []);
    this.filter = smoothing ? 'linear' : 'nearest';
    // Decodes run before the frame's target is bound.
    const order = items.map((item, index) => ({item, index}));
    for (const {item} of order) this.prepare(item);
    order.sort(
      (a, b) =>
        a.item.z - b.item.z ||
        flagFloat(a.item.clipFlags) - flagFloat(b.item.clipFlags) ||
        a.index - b.index,
    );
    this.bind(this.surface, [0, 0, 0, 0]);
    this.state = 0;
    this.maskTexture = null;
    let group: EmoteDrawItem | null = null;
    for (const {item} of order) {
      if (item.blank || item.opa === 0 || (item.bm & 0xff0f) === 6) continue;
      if (item.stencilParent !== group) {
        group = item.stencilParent;
        if (group) this.buildMask(group);
        else {
          this.maskTexture = null;
          this.state = 0;
        }
      }
      this.drawItem(item);
    }
    this.state = 0;
    this.maskTexture = null;
    commands.push({kind: 'gpu-target', surface: null});
    this.commands = [];
    return commands;
  }

  close(): void {
    for (const id of this.released.splice(0)) this.host.removeTexture(id);
    for (const t of this.used) this.cache.release(t);
    this.used.clear();
    for (const m of this.masks ?? []) this.host.removeTexture(m.id);
    if (this.copy) this.host.removeTexture(this.copy.id);
    this.masks = this.copy = null;
    this.host.removeTexture(this.dummy);
    this.host.removeTexture(this.texture);
  }

  private textureOf(item: EmoteDrawItem): EmoteTexture | null {
    const file = item.file;
    if (!file) return null;
    let list = this.sources.get(file);
    if (!list) this.sources.set(file, (list = [...file.sources.values()].map((s) => s.texture)));
    return list[item.texIndex] ?? null;
  }

  private prepare(item: EmoteDrawItem, seen = new Set<EmoteDrawItem>()): void {
    if (seen.has(item)) return;
    seen.add(item);
    const texture = this.textureOf(item);
    if (texture) {
      this.cache.acquire(texture, this.commands);
      if (!this.used.has(texture)) {
        this.used.add(texture);
        this.cache.retain(texture);
      }
    }
    for (const c of item.composite) this.prepare(c, seen);
    if (item.stencilParent) this.prepare(item.stencilParent, seen);
  }

  private mesh(item: EmoteDrawItem): Mesh {
    if (!item.grid) throw new Error('E-mote draw item without a vertex grid');
    const texture = this.textureOf(item);
    return {
      texture: texture && this.cache.acquire(texture, this.commands),
      left: item.left,
      top: item.top,
      width: item.width,
      height: item.height,
      grid: item.grid,
    };
  }

  private bind(surface: GpuRenderSurface, clearColor?: readonly [number, number, number, number]) {
    this.target = surface;
    this.commands.push(
      clearColor ? {kind: 'gpu-target', surface, clearColor} : {kind: 'gpu-target', surface},
    );
  }

  /** The two A8 mask targets of 0x180060b40: viewport-sized, reused while it is unchanged. */
  private maskTargets() {
    if (!this.masks) {
      const make = () => {
        const surface = new GpuRenderSurface(this.width, this.height);
        return {id: this.host.addTexture(surface), surface};
      };
      this.masks = [make(), make()];
    }
    return this.masks;
  }

  /** The mask passes of the draw loop for a new stencil parent (device mode 1). */
  private buildMask(parent: EmoteDrawItem): void {
    const masks = this.maskTargets();
    this.state = 1;
    this.maskTexture = null;
    for (const pass of [1, 2] as const) {
      for (let p: EmoteDrawItem | null = parent; p; p = p.stencilParent) {
        if ((p.stencilType & 3) !== pass) continue;
        this.alphaTest = p.alphaTest;
        this.alphaMul = p.alphaScale;
        if (pass === 1) {
          this.alphaAdd = p.alphaOffset;
          if (this.state === 1) this.state = 3;
          else {
            this.state = 4;
            masks.reverse();
            this.maskTexture = masks[1];
          }
          this.bind(masks[0].surface, [0, 0, 0, 0]);
        } else {
          this.alphaAdd = f32(f32(1 - p.alphaScale) - p.alphaOffset);
          this.maskTexture = null;
          if (this.state === 1) this.bind(masks[0].surface, [1, 1, 1, 1]);
          this.state = 5;
        }
        if (p.stencilType & 4) {
          for (const c of p.composite) if (!c.blank) this.draw(this.mesh(c), WHITE, 4, 0, 0);
        } else if (!p.blank) this.draw(this.mesh(p), WHITE, 4, 0, 0);
      }
    }
    this.bind(this.surface);
    this.maskTexture = masks[0];
    this.state = 6;
  }

  private drawItem(item: EmoteDrawItem): void {
    this.grayscaleMode = item.grayscaleMode;
    this.grayscaleLevel = item.grayscaleLevel;
    const bm = item.bm >>> 0,
      op = bm & 0xff0f;
    if ((bm & 0xf00) === 0x100 && op !== 0x10d) this.bounds.set(gridBounds(item.grid!));
    const c = item.colors;
    const colors = Uint32Array.of(
      vertexColor(c[0]!),
      vertexColor(c[1]!),
      vertexColor(c[3]!),
      vertexColor(c[2]!),
    );
    const mesh = this.mesh(item);
    if (op !== 0x10d) {
      this.draw(mesh, colors, item.attr, bm, item.bmParam);
      return;
    }
    // 0x180007f40: horizontal then vertical passes of decreasing radius.
    let r = Math.trunc(
      f32(f32(Math.max(this.target.width, this.target.height) * item.bmParam) + 0.5),
    );
    while (r >= 1) {
      let i = 4;
      while (r < BLUR_STEPS[i]!) i--;
      r -= BLUR_STEPS[i]!;
      for (const param of [i, i + 5]) {
        this.bounds.set(gridBounds(mesh.grid));
        this.draw(mesh, colors, item.attr, bm, param);
      }
    }
  }

  /** The mesh draw 0x18005b5a0 and the device draw it submits. */
  private draw(mesh: Mesh, colors: Uint32Array, attr: number, bm: number, bmParam: number): void {
    const {cols, rows, points} = mesh.grid;
    const tex = mesh.texture;
    const texW = f32(tex ? tex.surface.width : 1),
      texH = f32(tex ? tex.surface.height : 1);
    let vertices: Float32Array, topology: TriangleDraw['topology'];
    const put = (out: Float32Array, i: number, p: number, color: number, u: number, v: number) => {
      const o = i * 9;
      out[o] = points[p * 2]!;
      out[o + 1] = points[p * 2 + 1]!;
      out[o + 2] = 0;
      out[o + 3] = ((color >>> 16) & 255) / 255;
      out[o + 4] = ((color >>> 8) & 255) / 255;
      out[o + 5] = (color & 255) / 255;
      out[o + 6] = (color >>> 24) / 255;
      out[o + 7] = u;
      out[o + 8] = v;
    };
    if (cols === 1 && rows === 1) {
      const u0 = f32(mesh.left / texW),
        u1 = f32(f32(mesh.left + mesh.width) / texW),
        v0 = f32(mesh.top / texH),
        v1 = f32(f32(mesh.top + mesh.height) / texH);
      vertices = new Float32Array(36);
      put(vertices, 0, 0, colors[0]!, u0, v0);
      put(vertices, 1, 2, colors[2]!, u0, v1);
      put(vertices, 2, 1, colors[1]!, u1, v0);
      put(vertices, 3, 3, colors[3]!, u1, v1);
      topology = 'triangle-strip';
    } else {
      const w = cols + 1,
        grid = emoteColorGrid(colors, cols, rows),
        su = f32(1 / texW),
        sv = f32(1 / texH);
      const uv = (p: number): [number, number] => {
        const i = p % w,
          j = (p - i) / w;
        return [
          f32(f32(f32(f32(f32(i) * mesh.width) / f32(cols)) + mesh.left) * su),
          f32(f32(f32(f32(f32(j) * mesh.height) / f32(rows)) + mesh.top) * sv),
        ];
      };
      vertices = new Float32Array(cols * rows * 6 * 9);
      let n = 0;
      for (let j = 0; j < rows; j++)
        for (let i = 0; i < cols; i++) {
          const a = j * w + i;
          for (const p of [a, a + w, a + 1, a + 1, a + w, a + w + 1]) {
            const [u, v] = uv(p);
            put(vertices, n++, p, grid[p]!, u, v);
          }
        }
      topology = 'triangles';
    }
    this.submit(tex, vertices, topology, attr, bm, bmParam);
  }

  private submit(
    tex: AtlasTexture | null,
    vertices: Float32Array,
    topology: TriangleDraw['topology'],
    attr: number,
    bm: number,
    bmParam: number,
  ): void {
    const state = this.state;
    if (state === 1) throw new Error('E-mote draw before the mask passes');
    const k = tex ? tex.kind : 0;
    const a = (attr >>> 2) & 1 ? 0 : (bm >>> 4) & 1 ? 8 : 4;
    const masked = this.maskTexture !== null;
    const parameters = new Float32Array(12);
    parameters[8] = this.target.height;
    const extras: number[] = [];
    if (masked) extras.push(this.maskTexture!.id);
    let program: Program;
    if (state === 3 || state === 4 || state === 5) {
      program = {family: 'mask', k, a, masked, f: 0, b: 0, n: 0, alphaTest: this.alphaTest};
      parameters[0] = this.alphaMul;
      parameters[1] = this.alphaAdd;
    } else if ((bm & 0xf00) === 0x100) {
      this.destinationCopy(bm, bmParam);
      const op = bm & 0xff0f;
      let n = 1;
      if (op >= 0x101 && op <= 0x10c) n = op - 0x101 + 2;
      else if (op === 0x10d) n = 14 + (uintOf(bmParam) % 5);
      program = {family: 'buffered', k, a, masked, f: 0, b: 0, n, alphaTest: false};
      parameters.set(this.blendParam(op, bmParam), 0);
      parameters.set(this.screenMulOffset, 4);
      extras.push(this.copy ? this.copy.id : this.dummy);
    } else {
      const op = bm & 0xff0f;
      const f = [0, 3, 6, 9, 12][this.grayscaleMode] ?? 0;
      const lvl = this.grayscaleLevel >>> 0;
      parameters.set(
        [lvl >>> 24, (lvl >>> 16) & 255, (lvl >>> 8) & 255, lvl & 255].map((x) => x / 255),
        0,
      );
      const b = op === 3 || op === 4 ? 2 : op === 5 ? 1 : 0;
      program = {family: 'basic', k, a, masked, f, b, n: 0, alphaTest: false};
    }
    const blend = BLENDS[blendIndex(state, bm)];
    if (!blend) throw new EmoteUnsupportedError(`blend mode 0x${bm.toString(16)}`);
    const key = `${program.family}/${k}/${a}/${+masked}/${program.f}/${program.b}/${program.n}/${+program.alphaTest}`;
    let source = this.programs.get(key);
    if (source === undefined) this.programs.set(key, (source = fragment(program)));
    const count = vertices.length / 9;
    let zero = this.zeros.get(count);
    if (!zero) this.zeros.set(count, (zero = new Float32Array(count * 2)));
    const additionalTextures: AdditionalTexture[] = extras.map((texture) => ({
      texture,
      uv: zero,
      filter: 'nearest',
      wrapS: 'clamp',
      wrapT: 'clamp',
    }));
    this.commands.push({
      kind: 'triangles',
      texture: tex ? tex.id : this.dummy,
      vertices,
      topology,
      normalizedUV: true,
      transform: this.transform,
      depthClip: false,
      filter: this.filter,
      wrapS: 'clamp',
      wrapT: 'clamp',
      fragment: source,
      parameters,
      ...(additionalTextures.length ? {additionalTextures} : {}),
      blendState: blend,
      discardTransparent: false,
    });
  }

  /** Projection of an E-mote point to target pixels (0x180060040, Artemis projection). */
  private project(x: number, y: number): [number, number] {
    const w = this.target.width,
      h = this.target.height;
    const cx = f32(x * f32(2 / w)),
      cy = f32(y * f32(-2 / h));
    return [f32(f32(cx * f32(w / 2)) + f32(w / 2)), f32(f32(cy * f32(-h / 2)) + f32(h / 2))];
  }

  /** Mosaic cell size of 0x180060dd0/0x180063cc0. */
  private mosaicSize(bmParam: number): number {
    if (!(bmParam >= 0)) return -bmParam;
    const big = f32(Math.max(this.target.width, this.target.height));
    return Math.ceil(f32(big / (bmParam <= 1 ? 1 : bmParam)));
  }

  /** The destination copy 0x180060dd0 of a destination-reading draw. */
  private destinationCopy(bm: number, bmParam: number): void {
    const w = this.target.width,
      h = this.target.height,
      op = bm & 0xff0f,
      b = this.bounds;
    let x0 = 0,
      y0 = 0,
      x1 = w,
      y1 = h;
    if (!(b[2]! < b[0]! || b[3]! < b[1]!)) {
      [x0, y0] = this.project(b[0]!, b[1]!);
      [x1, y1] = this.project(b[2]!, b[3]!);
    }
    if (op === 0x10c) {
      const s = this.mosaicSize(bmParam);
      x0 = f32(Math.floor(f32(x0 / s)) * s);
      y0 = f32(Math.floor(f32(y0 / s)) * s);
      x1 = f32(Math.ceil(f32(x1 / s)) * s);
      y1 = f32(Math.ceil(f32(y1 / s)) * s);
    } else if (op === 0x10d) {
      const i = uintOf(bmParam),
        r = BLUR_EXPAND[i % 5]!;
      if (i < 5) {
        x0 = f32(x0 - r);
        x1 = f32(x1 + r);
      } else {
        y0 = f32(y0 - r);
        y1 = f32(y1 + r);
      }
    }
    y1 = Math.min(Math.ceil(y1), h);
    x1 = Math.min(Math.ceil(x1), w);
    y0 = Math.max(Math.floor(y0), 0);
    x0 = Math.max(Math.floor(x0), 0);
    const rw = x1 - x0,
      rh = y1 - y0;
    if (rw <= 0 || rh <= 0) return;
    const cw = this.copy?.surface.width ?? 0,
      ch = this.copy?.surface.height ?? 0;
    let fresh = false;
    if (rw < cw * 0.5 || rh < ch * 0.5 || rw > cw || rh > ch) {
      if (this.copy) this.released.push(this.copy.id);
      const surface = new GpuRenderSurface(rw, rh);
      this.copy = {id: this.host.addTexture(surface), surface};
      fresh = true;
    }
    const copy = this.copy!;
    const layer = this.target;
    this.bind(copy.surface, fresh ? [0, 0, 0, 0] : undefined);
    const quad = new Float32Array(36);
    [
      [0, 0],
      [rw, 0],
      [0, rh],
      [rw, rh],
    ].forEach(([x, y], i) => quad.set([x!, y!, 0, 1, 1, 1, 1, x0 + x!, y0 + y!], i * 9));
    this.commands.push({
      kind: 'triangles',
      texture: this.texture,
      vertices: quad,
      topology: 'triangle-strip',
      filter: 'nearest',
      fragment: COPY_FRAGMENT,
      blendState: REPLACE,
      discardTransparent: false,
    });
    this.bind(layer);
    const sw = copy.surface.width,
      sh = copy.surface.height;
    this.screenMulOffset.set([f32(1 / sw), f32(1 / sh), f32(-x0 / sw), f32(-y0 / sh)]);
    b.set([FLT_MAX, FLT_MAX, -FLT_MAX, -FLT_MAX]);
  }

  /** `blendParam` of 0x180063cc0 for the mosaic and blur formulas. */
  private blendParam(op: number, bmParam: number): number[] {
    const cw = this.copy?.surface.width ?? 1,
      ch = this.copy?.surface.height ?? 1;
    if (op === 0x10c) {
      const s = f32(this.mosaicSize(bmParam)),
        c = f32(f32(s * 0.5) + 0.5);
      return [f32(cw / s), f32(ch / s), f32(c / cw), f32(c / ch)];
    }
    if (op === 0x10d) return uintOf(bmParam) < 5 ? [f32(1 / cw), 0, 0, 0] : [0, f32(1 / ch), 0, 0];
    return [0, 0, 0, 0];
  }
}

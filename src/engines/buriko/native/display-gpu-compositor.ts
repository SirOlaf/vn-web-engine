import {
  burikoBitmapInitialized,
  type BurikoBitmap,
  type BurikoBitmapRectangle,
  type BurikoBitmapStorage,
  type BurikoPendingWrite,
} from './bitmap.js';
import {burikoMixAlphaCoefficient} from './bitmap-mix.js';
import {
  BURIKO_TRANSITION_COPY,
  BURIKO_TRANSITION_SKIP,
  burikoTransitionActions,
  burikoTransitionOperands,
} from './bitmap-transition.js';
import {hasRasterText, type RasterTextBitmap} from '../../../text/raster-text.js';
import type {BurikoBitmapCompositor} from './bitmap-compositor.js';
import {
  burikoAlignedAffineSource,
  burikoBitmapAffineCoordinates,
  type BurikoBitmapAffineTransform,
} from './bitmap-affine.js';
import {
  BurikoGpuTargetStorage,
  type BurikoGpuDeferrer,
  type BurikoGpuKernel,
  type BurikoGpuKernelTarget,
} from './bitmap-gpu-target.js';
import type {BurikoDisplayContext} from './display-object.js';
import type {BurikoDisplayTexture} from './display-texture.js';
import {
  BURIKO_GPU_VERTEX,
  burikoGpuProgram,
  burikoGpuTexture,
  type BurikoGpuPresenter,
} from './display-gpu-presenter.js';
import {beginRuntimeSpan, recordRuntimeMetric} from '../../../platform/runtime-performance.js';

// Pixels travel as the stored bytes: B, G, R, A in the R, G, B, A channels of RGBA8 textures.
// `pixel` rebuilds the little-endian DWORD the software kernels read, so each shader below
// repeats its TypeScript reference's integer arithmetic on the same values.
const PRELUDE = `#version 300 es
precision highp float;precision highp int;precision highp sampler2D;
uniform sampler2D destination;uniform sampler2D source;
uniform ivec2 origin;uniform ivec2 size;uniform ivec2 sourceOrigin;
out vec4 color;
uint pixel(sampler2D image,ivec2 p){
  uvec4 b=uvec4(texelFetch(image,p,0)*255.+.5);
  return b.r|(b.g<<8)|(b.b<<16)|(b.a<<24);
}
void store(uint v){color=vec4(uvec4(v,v>>8,v>>16,v>>24)&255u)/255.;}
// bitmap-alpha.ts rgbDifference for weights 0..128: destination alpha, Q7 RGB lanes.
uint difference(uint s,uint d,uint w){
  uint inverse=128u-w;
  uint redBlue=(((s&0xff00ffu)*w+(d&0xff00ffu)*inverse)>>7)&0xff00ffu;
  uint green=((((s>>8)&255u)*w+((d>>8)&255u)*inverse)>>7)<<8;
  return (d&0xff000000u)|redBlue|green;
}
`;

const KERNELS = {
  /** bitmap-copy.ts copyBurikoBitmapRows, four-byte pixels. */
  copy: `void main(){store(pixel(source,ivec2(gl_FragCoord.xy)-origin+sourceOrigin));}`,
  /** bitmap-copy.ts clearBurikoBitmapPixels. */
  clear: `void main(){store(0u);}`,
  /** bitmap-effects.ts dimBurikoRgb: zero alpha, (byte*(256-t))>>8 per RGB byte. */
  dim: `uniform uint transparency;
void main(){
  uint v=pixel(source,ivec2(gl_FragCoord.xy)-origin+sourceOrigin),r=0u;
  for(uint shift=0u;shift<24u;shift+=8u)r|=((((v>>shift)&255u)*(256u-transparency))>>8)<<shift;
  store(r);
}`,
  /** bitmap-alpha.ts mixBurikoAllChannels for coefficients 0..128, all four bytes. */
  mix: `uniform uint coefficient;
void main(){
  ivec2 p=ivec2(gl_FragCoord.xy)-origin;
  uint s=pixel(source,p+sourceOrigin),d=pixel(destination,p),inverse=128u-coefficient;
  uint redBlue=(((s&0xff00ffu)*inverse+(d&0xff00ffu)*coefficient)>>7)&0xff00ffu;
  uint greenAlpha=((((s>>8)&0xff00ffu)*inverse+((d>>8)&0xff00ffu)*coefficient)>>7)&0xff00ffu;
  store(redBlue|(greenAlpha<<8));
}`,
  /** bitmap-alpha.ts blendBurikoAlphaIntoRgb: MOVQ pairs from the left edge, then a MOVD tail. */
  alpha: `void main(){
  ivec2 p=ivec2(gl_FragCoord.xy)-origin;
  uint s=pixel(source,p+sourceOrigin),d=pixel(destination,p),a=s>>24;
  if((size.x&1)==1&&p.x==size.x-1){
    store(a<2u?d:a>=254u?s&0xffffffu:difference(s,d,a>>1));
    return;
  }
  uint mate=pixel(source,ivec2(p.x^1,p.y)+sourceOrigin)>>24;
  if(a==0u&&mate==0u)store(d);
  else if(a>=254u&&mate>=254u)store(s);
  else store(difference(s,d,a>=254u?128u:a>>1));
}`,
  /** bitmap-alpha.ts blendBurikoAlphaIntoRgbWithTransparency. Zero coefficients keep old. */
  alphaTransparency: `uniform uint transparency;
void main(){
  ivec2 p=ivec2(gl_FragCoord.xy)-origin;
  uint s=pixel(source,p+sourceOrigin);
  store(difference(s,pixel(destination,p),((s>>25)*(256u-transparency))>>8));
}`,
  /**
   * bitmap-affine.ts blendInitializedAffine: wrapping Q16 coordinates, Q4 bilinear lanes with a
   * zero border, and Q7 opacity entries whose entry 127 uses numerator 128. A pair's zero-alpha
   * skip equals a zero coefficient, so each pixel is independent.
   */
  affine: `uniform ivec2 start;uniform ivec2 column;uniform ivec2 row;
uniform ivec2 sourceSize;uniform uint transparency;uniform bool bilinear;
uint texel(int x,int y){
  if(x<0||y<0||x>=sourceSize.x||y>=sourceSize.y)return 0u;
  return pixel(source,ivec2(x,y)+sourceOrigin);
}
uint lerp(uint first,uint second,uint fraction){
  uint inverse=16u-fraction;
  uint redBlue=(((first&0xff00ffu)*inverse+(second&0xff00ffu)*fraction)>>4)&0xff00ffu;
  uint alphaGreen=((((first>>8)&0xff00ffu)*inverse+((second>>8)&0xff00ffu)*fraction)>>4)&0xff00ffu;
  return redBlue|(alphaGreen<<8);
}
void main(){
  ivec2 p=ivec2(gl_FragCoord.xy)-origin;
  uvec2 fixedPoint=uvec2(start)+uvec2(p.y)*uvec2(row)+uvec2(p.x)*uvec2(column);
  uint s;
  if(!bilinear){
    ivec2 q=ivec2(fixedPoint+0x8000u)>>16;
    s=texel(q.x,q.y);
  }else{
    ivec2 q=ivec2(fixedPoint)>>16;
    if(q.x< -1||q.y< -1||q.x>=sourceSize.x||q.y>=sourceSize.y)s=0u;
    else{
      uint fx=(fixedPoint.x>>12)&15u;
      s=lerp(lerp(texel(q.x,q.y),texel(q.x+1,q.y),fx),lerp(texel(q.x,q.y+1),texel(q.x+1,q.y+1),fx),(fixedPoint.y>>12)&15u);
    }
  }
  uint d=pixel(destination,p),index=s>>25;
  uint coefficient=((index==127u?128u:index)*(256u-transparency))>>8,inverse=128u-coefficient;
  uint redBlue=(((s&0xff00ffu)*coefficient+(d&0xff00ffu)*inverse)>>7)&0xff00ffu;
  uint green=(((((s>>8)&255u)*coefficient+((d>>8)&255u)*inverse)>>7)&255u)<<8;
  store((d&0xff000000u)|redBlue|green);
}`,
  /**
   * bitmap-transition.ts transition32 through its per-mask-byte action table: skip, copy the
   * whole source pixel, or a signed Q16 step per RGB byte, saturated, keeping old alpha.
   */
  transition: `uniform sampler2D mask;uniform highp isampler2D actions;uniform ivec2 maskOrigin;
void main(){
  ivec2 p=ivec2(gl_FragCoord.xy)-origin;
  uint d=pixel(destination,p);
  int level=int(texelFetch(mask,p+maskOrigin,0).r*255.+.5);
  int k=texelFetch(actions,ivec2(level,0),0).r;
  if(k==${BURIKO_TRANSITION_SKIP}){store(d);return;}
  uint s=pixel(source,p+sourceOrigin);
  if(k==${BURIKO_TRANSITION_COPY}){store(s);return;}
  uint r=d&0xff000000u;
  for(uint shift=0u;shift<24u;shift+=8u){
    int previous=int((d>>shift)&255u);
    int delta=(((int((s>>shift)&255u)-previous)<<4)*k)>>16;
    r|=uint(clamp(previous+delta,0,255))<<shift;
  }
  store(r);
}`,
  /**
   * bitmap-mix.ts blendInitializedMixedIntoRgb: opacity-scaled alphas, premultiplied channels,
   * their Q8 crossfade and the retained destination, each floored. A pair is skipped only when
   * both mixed alphas are zero; processed pixels clear alpha.
   */
  fused: `uniform sampler2D second;uniform ivec2 secondOrigin;uniform uint factor;
uniform uint transparency;
uint scaled(uint p){return ((p>>24)*(256u-transparency))>>8;}
uint mixed(uint a,uint b){return (scaled(a)*(256u-factor)+scaled(b)*factor)>>8;}
void main(){
  ivec2 p=ivec2(gl_FragCoord.xy)-origin;
  uint a=pixel(source,p+sourceOrigin),b=pixel(second,p+secondOrigin),d=pixel(destination,p);
  uint alpha=mixed(a,b);
  if((size.x&1)==1&&p.x==size.x-1){
    if(alpha==0u){store(d);return;}
  }else{
    ivec2 q=ivec2(p.x^1,p.y);
    if(alpha==0u&&mixed(pixel(source,q+sourceOrigin),pixel(second,q+secondOrigin))==0u){store(d);return;}
  }
  uint fa=scaled(a),sa=scaled(b),inverse=256u-factor,retained=256u-alpha;
  uint firstRedBlue=(((a&0xff00ffu)*fa)>>8)&0xff00ffu,secondRedBlue=(((b&0xff00ffu)*sa)>>8)&0xff00ffu;
  uint redBlue=((firstRedBlue*inverse+secondRedBlue*factor)>>8)&0xff00ffu;
  uint oldRedBlue=(((d&0xff00ffu)*retained)>>8)&0xff00ffu;
  uint firstGreen=(((a>>8)&255u)*fa)>>8,secondGreen=(((b>>8)&255u)*sa)>>8;
  uint green=(firstGreen*inverse+secondGreen*factor)>>8,oldGreen=(((d>>8)&255u)*retained)>>8;
  store(redBlue+oldRedBlue+((green+oldGreen)<<8));
}`,
  /** bitmap-mix.ts mixRgbBounded: all four bytes, Q8 factor. */
  mixRgb: `uniform sampler2D second;uniform ivec2 secondOrigin;uniform uint factor;
void main(){
  ivec2 p=ivec2(gl_FragCoord.xy)-origin;
  uint a=pixel(source,p+sourceOrigin),b=pixel(second,p+secondOrigin),inverse=256u-factor;
  uint redBlue=(((a&0xff00ffu)*inverse+(b&0xff00ffu)*factor)>>8)&0xff00ffu;
  uint greenAlpha=((((a>>8)&0xff00ffu)*inverse+((b>>8)&0xff00ffu)*factor)>>8)&0xff00ffu;
  store(redBlue|(greenAlpha<<8));
}`,
  /**
   * bitmap-mix.ts mixAlphaBounded. Its RCPSS coefficient comes from a table the CPU fills with
   * burikoMixAlphaCoefficient, indexed by the two alphas.
   */
  mixAlpha: `uniform sampler2D second;uniform sampler2D coefficients;uniform ivec2 secondOrigin;
uniform uint factor;
void main(){
  ivec2 p=ivec2(gl_FragCoord.xy)-origin;
  uint a=pixel(source,p+sourceOrigin),b=pixel(second,p+secondOrigin),fa=a>>24,sa=b>>24;
  uint c=uint(texelFetch(coefficients,ivec2(sa,fa),0).r*255.+.5),retained=128u-c;
  uint redBlue=(((a&0xff00ffu)*c+(b&0xff00ffu)*retained)>>7)&0xff00ffu;
  uint green=((((a>>8)&255u)*c+((b>>8)&255u)*retained)>>7)<<8;
  store(redBlue|green|(((fa*(256u-factor)+sa*factor)>>8)<<24));
}`,
} as const;
type Program = keyof typeof KERNELS;

const contains = (outer: Area, inner: Area): boolean =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height;
const union = (a: Area, b: Area): Area => {
  const x = Math.min(a.x, b.x),
    y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
};
const sameArea = (a: Area, b: Area): boolean =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/**
 * A sprite mix recorded instead of computed. The GPU draws it into its destination's cached
 * texture; any software access to the destination or a later write to a source runs the
 * software kernel on the unchanged inputs first.
 */
class PendingMix implements BurikoPendingWrite {
  /** The destination's pixels on its storage row grid. */
  readonly area: Area;
  constructor(
    readonly owner: BurikoGpuCompositor,
    readonly destination: BurikoBitmap,
    readonly first: BurikoBitmap,
    readonly second: BurikoBitmap,
    readonly factor: number,
    private readonly run: () => unknown,
  ) {
    const stride = destination.stride;
    this.area = {
      x: (destination.offset % stride) >>> 2,
      y: Math.floor(destination.offset / stride),
      width: destination.width,
      height: destination.height,
    };
  }
  settle(): void {
    this.discard();
    this.run();
    recordRuntimeMetric('buriko.display.gpu-compose.settled-mixes', 1);
  }
  discard(): void {
    this.destination.storage!.detach(this, [this.first.storage!, this.second.storage!]);
  }
}

interface Compiled {
  program: WebGLProgram;
  uniforms: Map<string, WebGLUniformLocation | null>;
}

interface Scratch {
  texture: WebGLTexture | null;
  width: number;
  height: number;
}

/** Operation extent in display coordinates. */
interface Area {
  x: number;
  y: number;
  width: number;
  height: number;
}

const COEFFICIENT_TABLES = 64,
  FIRST_COOLDOWN = 30,
  MAXIMUM_COOLDOWN = 1800,
  SOURCE_IDLE_FRAMES = 120,
  SOURCE_BUDGET_BYTES = 384 * 1024 * 1024;

interface SourceTexture {
  texture: WebGLTexture;
  stride: number;
  /** Bytes per pixel: RGBA8 texels, or R8 for masks. */
  size: 1 | 4;
  /** The storage generation the valid area was uploaded at. */
  generation: number;
  /** Uploaded texels, in storage row-grid coordinates. */
  valid: Area | null;
  used: number;
  bytes: number;
}

/** 'verify' also draws every GPU frame in software and compares the two. */
export type BurikoGpuCompositingMode = 'on' | 'off' | 'verify';
let gpuCompositingMode: BurikoGpuCompositingMode = 'on';

/** `?gpu-compose=0` keeps software compositing while the GPU presents; `=verify` checks it. */
export function setBurikoGpuCompositingMode(value: BurikoGpuCompositingMode): void {
  gpuCompositingMode = value;
}
export function burikoGpuCompositingMode(): BurikoGpuCompositingMode {
  return gpuCompositingMode;
}

/**
 * Browser-optimized display compositing on the presenter's WebGL context. A frame's render jobs
 * draw into a stand-in display descriptor; kernels tagged with a GPU id run here on the display
 * image, any other access to display pixels fails the frame, and the owner then reruns the same
 * jobs in software. The software texture is stale while the presenter owns the display image;
 * `syncSoftware` reads it back before any software reader.
 */
export class BurikoGpuCompositor implements BurikoGpuKernelTarget, BurikoGpuDeferrer {
  private readonly gl: WebGL2RenderingContext;
  private readonly framebuffer: WebGLFramebuffer;
  private readonly backupFramebuffer: WebGLFramebuffer;
  private readonly mixFramebuffer: WebGLFramebuffer;
  /** Mix coefficient tables by factor, least recently used first. */
  private readonly coefficients = new Map<number, WebGLTexture>();
  private readonly vertexArray: WebGLVertexArrayObject;
  private readonly programs = new Map<Program, Compiled>();
  private readonly destination: Scratch = {texture: null, width: 0, height: 0};
  private readonly source: Scratch = {texture: null, width: 0, height: 0};
  private readonly sources = new Map<BurikoBitmapStorage, SourceTexture>();
  private sourceBytes = 0;
  /** The texture bindSource selected for the next run; other runs sample a placeholder. */
  private boundSource: WebGLTexture | null = null;
  /** Transition action table, one signed entry per mask byte. */
  private actions: WebGLTexture | null = null;
  private frames = 0;
  private readonly maximumTextureSize: number;
  private readonly backup: Scratch = {texture: null, width: 0, height: 0};
  private readonly stand = new WeakMap<BurikoDisplayTexture, BurikoGpuTargetStorage>();
  private attachedImage: WebGLTexture | null = null;
  private frame: {texture: BurikoDisplayTexture; bounds: BurikoBitmapRectangle} | null = null;
  private failure: string | null = null;
  private failureStack: string | null = null;
  private cooldown = 0;
  private penalty = FIRST_COOLDOWN;

  constructor(readonly presenter: BurikoGpuPresenter) {
    const gl = (this.gl = presenter.gl);
    this.framebuffer = gl.createFramebuffer()!;
    this.backupFramebuffer = gl.createFramebuffer()!;
    this.mixFramebuffer = gl.createFramebuffer()!;
    this.vertexArray = gl.createVertexArray()!;
    this.maximumTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  }

  /**
   * Start a GPU frame over `bounds`, the union of its render jobs, or return false to draw in
   * software. The context's descriptor carries the stand-in storage until `end`.
   */
  begin(
    context: BurikoDisplayContext,
    texture: BurikoDisplayTexture,
    logicalWidth: number,
    logicalHeight: number,
    bounds: BurikoBitmapRectangle,
  ): boolean {
    if (this.frame !== null) throw new Error('Buriko GPU frames cannot nest');
    if (this.cooldown > 0) {
      this.cooldown--;
      return false;
    }
    const presenter = this.presenter;
    if (!presenter.available || context.bitmap.storage !== texture.storage) return false;
    if (
      !presenter.holds(texture) &&
      !presenter.upload('display', texture, logicalWidth, logicalHeight, undefined)
    )
      return false;
    const gl = this.gl;
    this.attach(presenter.image('display', texture));
    // Keep the jobs' area so a failed frame can restore it before software redraws.
    const area = this.clip(bounds, texture);
    if (area !== null) {
      this.scratch(this.backup, texture.width, texture.height, gl.TEXTURE0);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.framebuffer);
      gl.copyTexSubImage2D(
        gl.TEXTURE_2D,
        0,
        area.x,
        area.y,
        area.x,
        area.y,
        area.width,
        area.height,
      );
    }
    let stand = this.stand.get(texture);
    if (stand === undefined || stand.software !== texture.storage) {
      stand = new BurikoGpuTargetStorage(this, texture.storage);
      this.stand.set(texture, stand);
    }
    context.bitmap.storage = stand;
    this.frames++;
    this.trimSources();
    this.frame = {texture, bounds: {...bounds}};
    this.failure = null;
    return true;
  }

  /** Finish a GPU frame. False means it failed and must be drawn again in software. */
  end(context: BurikoDisplayContext): boolean {
    const frame = this.frame;
    if (frame === null) throw new Error('Buriko GPU frame was not started');
    this.frame = null;
    context.bitmap.storage = frame.texture.storage;
    const presenter = this.presenter;
    if (this.failure === null && presenter.available) {
      presenter.own(frame.texture);
      this.penalty = FIRST_COOLDOWN;
      recordRuntimeMetric('buriko.display.gpu-compose.frames', 1);
      return true;
    }
    const reason = this.failure ?? 'context lost';
    recordRuntimeMetric('buriko.display.gpu-compose.fallbacks', 1);
    recordRuntimeMetric(`buriko.display.gpu-compose.fallback.${reason}`, 1);
    console.info(
      'Buriko GPU compositing fell back to software:',
      reason,
      ...(this.failureStack === null ? [] : [this.failureStack]),
    );
    this.cooldown = this.penalty;
    this.penalty = Math.min(MAXIMUM_COOLDOWN, this.penalty * 2);
    if (!presenter.available) {
      presenter.invalidate();
      return false;
    }
    const area = this.clip(frame.bounds, frame.texture);
    const gl = this.gl;
    if (area !== null && this.backup.texture !== null) {
      this.attach(presenter.image('display', frame.texture));
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.backupFramebuffer);
      gl.framebufferTexture2D(
        gl.READ_FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        this.backup.texture,
        0,
      );
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.framebuffer);
      gl.disable(gl.SCISSOR_TEST);
      const right = area.x + area.width,
        bottom = area.y + area.height;
      gl.blitFramebuffer(
        area.x,
        area.y,
        right,
        bottom,
        area.x,
        area.y,
        right,
        bottom,
        gl.COLOR_BUFFER_BIT,
        gl.NEAREST,
      );
    }
    // Failed kernels wrote into the software bytes; owned frames are stale everywhere else.
    const logical = {
      left: 0,
      top: 0,
      right: frame.texture.width - 1,
      bottom: frame.texture.height - 1,
    };
    this.readBack(frame.texture, presenter.owns(frame.texture) ? logical : frame.bounds);
    presenter.release(frame.texture);
    return false;
  }

  /** Make the software texture current before a software reader or software presentation. */
  syncSoftware(texture: BurikoDisplayTexture): void {
    if (!this.presenter.owns(texture)) return;
    if (this.presenter.available)
      this.readBack(texture, {
        left: 0,
        top: 0,
        right: texture.width - 1,
        bottom: texture.height - 1,
      });
    this.presenter.release(texture);
  }

  /**
   * After a successful GPU frame whose software pixels were current beforehand, and the same
   * jobs then drawn in software: compare both results over `bounds` and hand the frame to the
   * software pixels. Returns the number of differing pixels.
   */
  verify(texture: BurikoDisplayTexture, bounds: BurikoBitmapRectangle): number {
    const area = this.clip(bounds, texture);
    this.presenter.release(texture);
    if (area === null || !this.presenter.available) return 0;
    const gl = this.gl,
      pixels = new Uint8Array(area.width * area.height * 4);
    this.attach(this.presenter.image('display', texture));
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.framebuffer);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 4);
    gl.readPixels(area.x, area.y, area.width, area.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const hardware = new Uint32Array(pixels.buffer),
      software = texture.storage.view;
    let differing = 0,
      first: string | null = null;
    for (let y = 0; y < area.height; y++)
      for (let x = 0; x < area.width; x++) {
        const expected = software.getUint32((area.y + y) * texture.pitch + (area.x + x) * 4, true),
          actual = hardware[y * area.width + x]!;
        if (expected === actual) continue;
        differing++;
        first ??= `(${area.x + x}, ${area.y + y}) software ${expected.toString(16)} GPU ${actual.toString(16)}`;
      }
    recordRuntimeMetric('buriko.display.gpu-compose.verified-pixels', area.width * area.height);
    recordRuntimeMetric('buriko.display.gpu-compose.differing-pixels', differing);
    if (differing !== 0)
      console.warn(
        `Buriko GPU compositing differs from software in ${differing} pixels; first ${first}`,
      );
    // The next presentation uploads the software pixels over the GPU result.
    this.presenter.invalidate();
    return differing;
  }

  fail(reason: string): void {
    if (this.frame === null || this.failure !== null) return;
    this.failure = reason;
    // A direct pixel access names no kernel; its caller identifies the missing GPU path.
    if (!reason.startsWith('kernel ') && !reason.includes(' '))
      this.failureStack = new Error().stack?.split('\n').slice(3, 9).join(' < ') ?? null;
    else this.failureStack = null;
  }

  dispatch(kernel: BurikoGpuKernel | undefined, args: readonly unknown[], name = ''): unknown {
    if (this.frame === null || this.failure !== null) {
      this.fail('inactive');
      return 0;
    }
    switch (kernel) {
      case 'copy-rows':
        return this.simple('copy', args[0], args[1], false);
      case 'clear':
        return this.clear(args[0] as BurikoBitmap);
      case 'dim-rgb':
        return this.simple('dim', args[0], args[1], false, {transparency: args[2]});
      case 'mix-all-channels':
        return this.simple('mix', args[0], args[1], true, {coefficient: (args[2] as number) >>> 1});
      case 'alpha-into-rgb':
        return this.simple('alpha', args[0], args[1], true);
      case 'alpha-into-rgb-transparency':
        return this.simple('alphaTransparency', args[0], args[1], true, {
          transparency: args[2],
        });
      case 'affine-blend':
        return this.affine(
          args[0] as BurikoBitmapCompositor,
          args[1] as BurikoBitmap,
          args[2] as BurikoBitmap,
          args[3] as BurikoBitmapAffineTransform,
          args[4] as number,
          args[5] as number,
          args[6] as boolean,
        );
      case 'transition':
        return this.transition(args);
      case 'mixed-into-rgb':
        return this.mixedIntoRgb(
          args[0] as BurikoBitmap,
          args[1] as BurikoBitmap,
          args[2] as BurikoBitmap,
          args[3] as number,
          args[4] as number,
        );
      default:
        this.fail(`kernel ${kernel ?? name ?? 'without GPU support'}`);
        return 0;
    }
  }

  private clip(rectangle: BurikoBitmapRectangle, texture: BurikoDisplayTexture): Area | null {
    const x = Math.max(0, rectangle.left),
      y = Math.max(0, rectangle.top),
      right = Math.min(texture.width - 1, rectangle.right),
      bottom = Math.min(texture.height - 1, rectangle.bottom);
    return x > right || y > bottom ? null : {x, y, width: right - x + 1, height: bottom - y + 1};
  }

  private attach(image: WebGLTexture): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    if (this.attachedImage !== image) {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, image, 0);
      this.attachedImage = image;
    }
  }

  /** Grow a scratch texture to at least the given size and bind it to `unit`. */
  private scratch(scratch: Scratch, width: number, height: number, unit: number): void {
    const gl = this.gl;
    gl.activeTexture(unit);
    if (scratch.texture !== null && scratch.width >= width && scratch.height >= height) {
      gl.bindTexture(gl.TEXTURE_2D, scratch.texture);
      return;
    }
    if (scratch.texture !== null) gl.deleteTexture(scratch.texture);
    const grow = (value: number, minimum: number) => {
      let size = Math.max(64, value);
      while (size < minimum) size *= 2;
      return size;
    };
    scratch.width = grow(scratch.width, width);
    scratch.height = grow(scratch.height, height);
    scratch.texture = burikoGpuTexture(gl);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, scratch.width, scratch.height);
  }

  /** The display area a destination descriptor covers, or null after failing the frame. */
  private target(bitmap: BurikoBitmap, width: number, height: number): Area | null {
    const frame = this.frame!,
      texture = frame.texture;
    if (
      bitmap.format !== 1 ||
      bitmap.bytesPerPixel !== 4 ||
      bitmap.stride !== texture.pitch ||
      (bitmap.offset & 3) !== 0 ||
      bitmap.offset < 0
    ) {
      this.fail('destination descriptor');
      return null;
    }
    const x = (bitmap.offset % texture.pitch) >>> 2,
      y = Math.floor(bitmap.offset / texture.pitch);
    if (x + width > texture.width || y + height > texture.height) {
      this.fail('destination bounds');
      return null;
    }
    return {x, y, width, height};
  }

  /**
   * Bind a texture holding the source bitmap's pixels in `x, y, width, height` to unit one and
   * return where the bitmap's origin lies in it, or null after failing the frame.
   */
  private bindSource(
    bitmap: BurikoBitmap,
    x: number,
    y: number,
    width: number,
    height: number,
  ): readonly [number, number] | null {
    const source = this.sourceTexture(bitmap, x, y, width, height);
    if (source === null) return null;
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, source.texture);
    this.boundSource = source.texture;
    return source.origin;
  }

  /**
   * A texture holding the source bitmap's pixels in `x, y, width, height`, and where the
   * bitmap's origin lies in it. Textures are cached per storage on its own row grid and reused
   * while its generation is unchanged. A pending GPU mix is drawn into the texture instead.
   */
  private sourceTexture(
    bitmap: BurikoBitmap,
    x: number,
    y: number,
    width: number,
    height: number,
  ): {texture: WebGLTexture; origin: readonly [number, number]} | null {
    const storage = bitmap.storage,
      size = bitmap.bytesPerPixel;
    // Four-byte pixels, or the one-byte masks of format three.
    if (
      storage === null ||
      storage instanceof BurikoGpuTargetStorage ||
      (size !== 4 && size !== 1) ||
      bitmap.stride % size !== 0 ||
      bitmap.stride < bitmap.width * size ||
      bitmap.offset % size !== 0 ||
      bitmap.offset < 0
    ) {
      this.fail('source descriptor');
      return null;
    }
    const stride = bitmap.stride,
      columns = stride / size,
      origin = [(bitmap.offset % stride) / size, Math.floor(bitmap.offset / stride)] as const;
    const needed = {x: origin[0] + x, y: origin[1] + y, width, height};
    if (needed.x + width > columns) {
      this.fail('source wraps rows');
      return null;
    }
    const pending = storage.pending;
    if (pending instanceof PendingMix && pending.owner === this && contains(pending.area, needed)) {
      const texture = this.renderMix(pending);
      if (texture !== null) return {texture, origin};
    }
    const entry = this.sourceEntry(storage, stride, size);
    if (entry === null) return null;
    const gl = this.gl,
      valid = entry.valid;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, entry.texture);
    if (valid === null || !contains(valid, needed)) {
      const region = valid === null ? needed : union(valid, needed);
      const offset = region.y * stride + region.x * size,
        length = (region.height - 1) * stride + region.width * size;
      // Reading settles a pending write first, whose software run advances the generation.
      const bytes = storage.readOnlyBytes();
      if (!storage.isInitialized(offset, length)) {
        this.fail('source storage');
        return null;
      }
      if (entry.generation !== storage.generation)
        return this.sourceTexture(bitmap, x, y, width, height);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, size);
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, columns);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        region.x,
        region.y,
        region.width,
        region.height,
        size === 4 ? gl.RGBA : gl.RED,
        gl.UNSIGNED_BYTE,
        bytes,
        offset,
      );
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      entry.valid = region;
      recordRuntimeMetric('buriko.display.gpu-compose.upload-pixels', region.width * region.height);
    } else recordRuntimeMetric('buriko.display.gpu-compose.cached-pixels', width * height);
    return {texture: entry.texture, origin};
  }

  /** The cache entry for a storage's row grid, emptied when its generation has moved on. */
  private sourceEntry(
    storage: BurikoBitmapStorage,
    stride: number,
    size: 1 | 4 = 4,
  ): SourceTexture | null {
    const gl = this.gl,
      columns = stride / size,
      rows = Math.ceil(storage.byteLength / stride),
      maximum = this.maximumTextureSize;
    let entry = this.sources.get(storage);
    if (entry !== undefined && (entry.stride !== stride || entry.size !== size)) {
      this.evict(storage, entry);
      entry = undefined;
    }
    if (entry === undefined) {
      if (columns > maximum || rows > maximum) {
        this.fail('source larger than a texture');
        return null;
      }
      gl.activeTexture(gl.TEXTURE1);
      entry = {
        texture: burikoGpuTexture(gl),
        stride,
        size,
        generation: storage.generation,
        valid: null,
        used: this.frames,
        bytes: columns * rows * size,
      };
      gl.texStorage2D(gl.TEXTURE_2D, 1, size === 4 ? gl.RGBA8 : gl.R8, columns, rows);
      this.sources.set(storage, entry);
      this.sourceBytes += entry.bytes;
    } else if (entry.generation !== storage.generation) {
      entry.generation = storage.generation;
      entry.valid = null;
    }
    entry.used = this.frames;
    return entry;
  }

  /** BurikoGpuDeferrer: record a sprite mix for the GPU to draw when a frame reads it. */
  defer(
    kernel: BurikoGpuKernel,
    args: readonly unknown[],
    run: (args: readonly unknown[]) => unknown,
  ): boolean {
    if (kernel !== 'mix' || !this.presenter.available) return false;
    const [destinationValue, firstValue, secondValue, factor, processing, distributed] = args as [
      BurikoBitmap,
      BurikoBitmap,
      BurikoBitmap,
      number,
      {capacity: number} | null | undefined,
      number | undefined,
    ];
    const bitmaps = [destinationValue, firstValue, secondValue];
    if (
      !Number.isInteger(factor) ||
      factor < 0 ||
      factor > 256 ||
      (processing != null && processing.capacity > 1 && (distributed ?? 1) !== 0) ||
      !bitmaps.every(
        (bitmap) =>
          bitmap !== null &&
          typeof bitmap === 'object' &&
          bitmap.storage != null &&
          !(bitmap.storage instanceof BurikoGpuTargetStorage) &&
          (bitmap.format === 1 || bitmap.format === 2) &&
          bitmap.format === destinationValue.format &&
          bitmap.bytesPerPixel === 4 &&
          bitmap.width === destinationValue.width &&
          bitmap.height === destinationValue.height &&
          bitmap.width > 0 &&
          bitmap.height > 0 &&
          Number.isSafeInteger(bitmap.stride) &&
          (bitmap.stride & 3) === 0 &&
          bitmap.stride >= bitmap.width * 4 &&
          Number.isSafeInteger(bitmap.offset) &&
          (bitmap.offset & 3) === 0 &&
          bitmap.offset >= 0 &&
          bitmap.stride <= this.maximumTextureSize * 4 &&
          Math.ceil(bitmap.storage.byteLength / bitmap.stride) <= this.maximumTextureSize &&
          !hasRasterText(bitmap as RasterTextBitmap),
      )
    )
      return false;
    const destination = {...destinationValue},
      first = {...firstValue},
      second = {...secondValue};
    const storage = destination.storage!;
    if (storage === first.storage || storage === second.storage) return false;
    const end =
      destination.offset + (destination.height - 1) * destination.stride + destination.width * 4;
    if (
      end > storage.byteLength ||
      !burikoBitmapInitialized(first, first.width, first.height) ||
      !burikoBitmapInitialized(second, second.width, second.height) ||
      [first, second].some((source) => {
        const a = source.storage!.backing(),
          b = storage.backing();
        return (
          a.buffer === b.buffer &&
          a.byteOffset < b.byteOffset + b.length &&
          b.byteOffset < a.byteOffset + a.length
        );
      })
    )
      return false;
    const copied = [destination, first, second, factor, null, 0];
    const mix = new PendingMix(this, destination, first, second, factor, () => run(copied));
    const rows = Array.from(
      {length: destination.height},
      (_, row) => [destination.offset + row * destination.stride, destination.width * 4] as const,
    );
    storage.defer(
      mix,
      [first.storage!, second.storage!],
      (previous) => previous instanceof PendingMix && sameArea(previous.area, mix.area),
      rows,
    );
    recordRuntimeMetric('buriko.display.gpu-compose.deferred-mixes', 1);
    return true;
  }

  /** Draw a pending mix into its destination's cached texture; null leaves it to software. */
  private renderMix(mix: PendingMix): WebGLTexture | null {
    const storage = mix.destination.storage!;
    const entry = this.sourceEntry(storage, mix.destination.stride);
    if (entry === null) return null;
    if (entry.valid !== null && contains(entry.valid, mix.area)) return entry.texture;
    const {width, height} = mix.destination;
    const first = this.sourceTexture(mix.first, 0, 0, width, height),
      second = first === null ? null : this.sourceTexture(mix.second, 0, 0, width, height);
    // A source's own software settlement advances this storage only if it read it.
    if (first === null || second === null || storage.pending !== mix) return null;
    const gl = this.gl,
      alpha = mix.destination.format === 2;
    const {program, uniforms} = this.compiled(alpha ? 'mixAlpha' : 'mixRgb');
    const location = (name: string) => {
      if (!uniforms.has(name)) uniforms.set(name, gl.getUniformLocation(program, name));
      return uniforms.get(name)!;
    };
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.mixFramebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, entry.texture, 0);
    // The destination scratch keeps the display image off every sampler unit.
    if (this.destination.texture === null) this.scratch(this.destination, 1, 1, gl.TEXTURE0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.destination.texture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, first.texture);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, second.texture);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(
      gl.TEXTURE_2D,
      alpha ? this.coefficientTable(mix.factor) : this.destination.texture,
    );
    gl.useProgram(program);
    gl.bindVertexArray(this.vertexArray);
    gl.uniform1i(location('destination'), 0);
    gl.uniform1i(location('source'), 1);
    gl.uniform1i(location('second'), 2);
    gl.uniform1i(location('coefficients'), 3);
    gl.uniform2i(location('origin'), mix.area.x, mix.area.y);
    gl.uniform2i(location('sourceOrigin'), first.origin[0], first.origin[1]);
    gl.uniform2i(location('secondOrigin'), second.origin[0], second.origin[1]);
    gl.uniform1ui(location('factor'), mix.factor);
    gl.viewport(mix.area.x, mix.area.y, mix.area.width, mix.area.height);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(mix.area.x, mix.area.y, mix.area.width, mix.area.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    entry.valid = {...mix.area};
    recordRuntimeMetric('buriko.display.gpu-compose.gpu-mixes', 1);
    return entry.texture;
  }

  /** bitmap-mix.ts coefficients for one factor, indexed by (second alpha, first alpha). */
  private coefficientTable(factor: number): WebGLTexture {
    let texture = this.coefficients.get(factor);
    if (texture !== undefined) {
      this.coefficients.delete(factor);
      this.coefficients.set(factor, texture);
      return texture;
    }
    const table = new Uint8Array(256 * 256);
    for (let first = 0; first < 256; first++)
      for (let second = 0; second < 256; second++)
        table[first * 256 + second] = burikoMixAlphaCoefficient(first, second, factor);
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE3);
    texture = burikoGpuTexture(gl);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8, 256, 256);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 256, gl.RED, gl.UNSIGNED_BYTE, table);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    this.coefficients.set(factor, texture);
    if (this.coefficients.size > COEFFICIENT_TABLES) {
      const [oldest, stale] = this.coefficients.entries().next().value!;
      gl.deleteTexture(stale);
      this.coefficients.delete(oldest);
    }
    return texture;
  }

  private evict(storage: BurikoBitmapStorage, entry: SourceTexture): void {
    this.gl.deleteTexture(entry.texture);
    this.sourceBytes -= entry.bytes;
    this.sources.delete(storage);
  }

  /** Drop textures unused for a while, and the least recently used ones over the budget. */
  private trimSources(): void {
    const entries = [...this.sources].sort((a, b) => a[1].used - b[1].used);
    for (const [storage, entry] of entries)
      if (
        this.frames - entry.used > SOURCE_IDLE_FRAMES ||
        (this.sourceBytes > SOURCE_BUDGET_BYTES && entry.used !== this.frames)
      )
        this.evict(storage, entry);
  }

  /** Copy the operation's current display pixels to the destination scratch origin. */
  private snapshot(area: Area): void {
    const gl = this.gl;
    this.scratch(this.destination, area.width, area.height, gl.TEXTURE0);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.framebuffer);
    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, area.x, area.y, area.width, area.height);
  }

  private compiled(name: Program): Compiled {
    let compiled = this.programs.get(name);
    if (compiled === undefined) {
      const gl = this.gl,
        program = burikoGpuProgram(gl, BURIKO_GPU_VERTEX, PRELUDE + KERNELS[name]);
      compiled = {program, uniforms: new Map()};
      this.programs.set(name, compiled);
    }
    return compiled;
  }

  private run(
    name: Program,
    area: Area,
    integers: Record<string, number | readonly number[]> = {},
    unsigned: Record<string, number> = {},
    textures: readonly (readonly [unit: number, texture: WebGLTexture])[] = [],
  ): void {
    const gl = this.gl,
      {program, uniforms} = this.compiled(name);
    const location = (uniform: string) => {
      if (!uniforms.has(uniform)) uniforms.set(uniform, gl.getUniformLocation(program, uniform));
      return uniforms.get(uniform)!;
    };
    const finish = beginRuntimeSpan('buriko.display.gpu-compose.draw');
    // Never leave the display image on a sampler unit while it is the draw target.
    if (this.destination.texture === null) this.scratch(this.destination, 1, 1, gl.TEXTURE0);
    if (this.source.texture === null) this.scratch(this.source, 1, 1, gl.TEXTURE1);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.destination.texture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.boundSource ?? this.source.texture);
    this.boundSource = null;
    for (const [unit, texture] of textures) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, texture);
    }
    gl.useProgram(program);
    gl.bindVertexArray(this.vertexArray);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.framebuffer);
    gl.uniform1i(location('destination'), 0);
    gl.uniform1i(location('source'), 1);
    gl.uniform2i(location('origin'), area.x, area.y);
    gl.uniform2i(location('size'), area.width, area.height);
    for (const [uniform, value] of Object.entries(integers))
      if (typeof value === 'number') gl.uniform1i(location(uniform), value);
      else gl.uniform2i(location(uniform), value[0]!, value[1]!);
    for (const [uniform, value] of Object.entries(unsigned))
      gl.uniform1ui(location(uniform), value >>> 0);
    gl.viewport(area.x, area.y, area.width, area.height);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(area.x, area.y, area.width, area.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    finish?.({width: area.width, height: area.height, kernel: name});
    recordRuntimeMetric('buriko.display.gpu-compose.pixels', area.width * area.height);
  }

  /** Kernels over the source's extent, with an optional snapshot of the old destination. */
  private simple(
    name: Program,
    destinationValue: unknown,
    sourceValue: unknown,
    readsDestination: boolean,
    unsigned: Record<string, unknown> = {},
  ): number {
    const destination = destinationValue as BurikoBitmap,
      source = sourceValue as BurikoBitmap;
    const width = source.width >>> 0,
      height = source.height >>> 0;
    for (const value of Object.values(unsigned))
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 256) {
        this.fail(`${name} parameter`);
        return 0;
      }
    if (width === 0 || height === 0) return 0;
    const area = this.target(destination, width, height);
    if (area === null) return 0;
    const origin = this.bindSource(source, 0, 0, width, height);
    if (origin === null) return 0;
    if (readsDestination) this.snapshot(area);
    this.run(name, area, {sourceOrigin: origin}, unsigned as Record<string, number>);
    return 0;
  }

  private clear(destination: BurikoBitmap): number {
    const width = destination.width >>> 0,
      height = destination.height >>> 0;
    if (width === 0 || height === 0) return 0;
    const area = this.target(destination, width, height);
    if (area !== null) this.run('clear', area);
    return 0;
  }

  /** bitmap-transition.ts transitionBurikoBitmap for RGB32 surfaces, with its own clipping. */
  private transition(args: readonly unknown[]): number {
    const [destination, x, y, source, mask, parameter, blend, extra, maskAtDestination] = args as [
      BurikoBitmap,
      number,
      number,
      BurikoBitmap,
      BurikoBitmap,
      number,
      number,
      number,
      boolean,
    ];
    const operands = burikoTransitionOperands(
      destination,
      x,
      y,
      source,
      mask,
      blend,
      maskAtDestination,
    );
    if (operands.status !== 0) return operands.status;
    const {output, input, matte} = operands;
    if (input.format !== 1) return 0;
    if ((args[9] ?? '1.72') !== '1.72') {
      this.fail('legacy transition');
      return 0;
    }
    const width = input.width >>> 0,
      height = input.height >>> 0;
    if (width === 0 || height === 0) return 0;
    if (
      output.width >>> 0 !== width ||
      output.height >>> 0 !== height ||
      matte.width >>> 0 !== width ||
      matte.height >>> 0 !== height
    ) {
      this.fail('transition extents');
      return 0;
    }
    const area = this.target(output, width, height);
    if (area === null) return 0;
    const levels = this.sourceTexture(matte, 0, 0, width, height);
    if (levels === null) return 0;
    const origin = this.bindSource(input, 0, 0, width, height);
    if (origin === null) return 0;
    const gl = this.gl;
    if (this.actions === null) {
      gl.activeTexture(gl.TEXTURE3);
      this.actions = burikoGpuTexture(gl);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32I, 256, 1);
    }
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.actions);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      256,
      1,
      gl.RED_INTEGER,
      gl.INT,
      burikoTransitionActions(parameter >>> 0, blend >>> 0, extra >>> 0),
    );
    this.snapshot(area);
    this.run(
      'transition',
      area,
      {sourceOrigin: origin, maskOrigin: levels.origin, mask: 2, actions: 3},
      {},
      [
        [2, levels.texture],
        [3, this.actions],
      ],
    );
    return 0;
  }

  /** bitmap-mix.ts blendMixedBurikoBitmapsIntoRgb on its bounded, initialized path. */
  private mixedIntoRgb(
    destination: BurikoBitmap,
    first: BurikoBitmap,
    second: BurikoBitmap,
    factorValue: number,
    transparencyValue: number,
  ): 0 | 9 | 10 {
    if (destination.format !== 1) return 10;
    if (first.format !== 2 || second.format !== 2) return 9;
    if (transparencyValue >>> 0 >= 256) return 0;
    const width = Math.min(destination.width >>> 0, first.width >>> 0, second.width >>> 0),
      height = Math.min(destination.height >>> 0, first.height >>> 0, second.height >>> 0),
      factor = (factorValue << 16) >> 16,
      transparency = transparencyValue | 0;
    if (factor < 0 || factor > 256) {
      this.fail('mixed factor');
      return 0;
    }
    if (width === 0 || height === 0) return 0;
    const area = this.target(destination, width, height);
    if (area === null) return 0;
    const other = this.sourceTexture(second, 0, 0, width, height);
    if (other === null) return 0;
    const origin = this.bindSource(first, 0, 0, width, height);
    if (origin === null) return 0;
    this.snapshot(area);
    this.run(
      'fused',
      area,
      {sourceOrigin: origin, secondOrigin: other.origin, second: 2},
      {factor, transparency},
      [[2, other.texture]],
    );
    return 0;
  }

  /** bitmap-affine.ts affineBitmap with blending, for RGBA sources on the initialized path. */
  private affine(
    compositor: BurikoBitmapCompositor,
    destination: BurikoBitmap,
    source: BurikoBitmap,
    transform: BurikoBitmapAffineTransform,
    transparencyValue: number,
    sampling: number,
    parallel: boolean,
  ): 0 | 0x13 {
    if (transform.scaleX >>> 0 === 0 || transform.scaleY >>> 0 === 0) return 0x13;
    const transparency = transparencyValue >>> 0;
    const aligned = burikoAlignedAffineSource(destination, source, transform);
    if (aligned !== null) {
      compositor.composite(destination, aligned, 0x20, transparency);
      return 0;
    }
    if (parallel && compositor.processing !== null && compositor.processing.capacity > 1) {
      this.fail('distributed affine strips');
      return 0;
    }
    if (destination.format !== 1 || transparency >= 256) return 0;
    if (source.format !== 2) {
      if (source.format === 1) this.fail('affine RGB source');
      return 0;
    }
    const width = destination.width >>> 0,
      height = destination.height >>> 0,
      sourceWidth = source.width >>> 0,
      sourceHeight = source.height >>> 0;
    // affineView's signed-WORD source envelope; outside it the software path samples per pixel.
    if (
      !Number.isSafeInteger(source.stride) ||
      (source.stride & 3) !== 0 ||
      source.stride < sourceWidth * 4 ||
      source.stride > 0x7fff * 4 ||
      sourceWidth > 0x7fff ||
      sourceHeight > 0x7fff
    ) {
      this.fail('affine source envelope');
      return 0;
    }
    if (width === 0 || height === 0) return 0;
    const area = this.target(destination, width, height);
    if (area === null) return 0;
    const coordinates = burikoBitmapAffineCoordinates(transform, compositor.revision);
    const bilinear = (sampling | 0) !== 0;
    // Q16 coordinates are affine in the pixel position, so a wrap-free rectangle's extremes lie
    // at its corners. A wrapping one needs the whole source.
    let window: Area = {x: 0, y: 0, width: sourceWidth, height: sourceHeight};
    const corner = (column: number, row: number, axis: 'X' | 'Y') =>
      coordinates[`start${axis}`] +
      row * coordinates[`row${axis}`] +
      column * coordinates[`column${axis}`];
    const extremes = (axis: 'X' | 'Y') => {
      const values = [
        corner(0, 0, axis),
        corner(width - 1, 0, axis),
        corner(0, height - 1, axis),
        corner(width - 1, height - 1, axis),
      ];
      return [Math.min(...values), Math.max(...values)] as const;
    };
    const [minimumX, maximumX] = extremes('X'),
      [minimumY, maximumY] = extremes('Y');
    if (
      minimumX >= -0x80000000 + 0x8000 &&
      maximumX < 0x7fffffff - 0x8000 &&
      minimumY >= -0x80000000 + 0x8000 &&
      maximumY < 0x7fffffff - 0x8000
    ) {
      const left = Math.max(0, Math.floor(minimumX / 65536) - 1),
        top = Math.max(0, Math.floor(minimumY / 65536) - 1),
        right = Math.min(sourceWidth, Math.floor(maximumX / 65536) + 2),
        bottom = Math.min(sourceHeight, Math.floor(maximumY / 65536) + 2);
      window = {
        x: left,
        y: top,
        width: Math.max(0, right - left),
        height: Math.max(0, bottom - top),
      };
    }
    if (window.width === 0 || window.height === 0) window = {x: 0, y: 0, width: 1, height: 1};
    const origin = this.bindSource(source, window.x, window.y, window.width, window.height);
    if (origin === null) return 0;
    this.snapshot(area);
    this.run(
      'affine',
      area,
      {
        start: [coordinates.startX, coordinates.startY],
        column: [coordinates.columnX, coordinates.columnY],
        row: [coordinates.rowX, coordinates.rowY],
        sourceSize: [sourceWidth, sourceHeight],
        sourceOrigin: origin,
        bilinear: bilinear ? 1 : 0,
      },
      {transparency},
    );
    return 0;
  }

  /** Read display image texels back into the software texture's bytes. */
  private readBack(texture: BurikoDisplayTexture, rectangle: BurikoBitmapRectangle): void {
    const area = this.clip(rectangle, texture);
    if (area === null) return;
    const gl = this.gl,
      finish = beginRuntimeSpan('buriko.display.gpu-compose.read-back');
    this.attach(this.presenter.image('display', texture));
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.framebuffer);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 4);
    gl.pixelStorei(gl.PACK_ROW_LENGTH, texture.pitch >>> 2);
    gl.readPixels(
      area.x,
      area.y,
      area.width,
      area.height,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      texture.storage.bytes,
      area.y * texture.pitch + area.x * 4,
    );
    gl.pixelStorei(gl.PACK_ROW_LENGTH, 0);
    finish?.({width: area.width, height: area.height});
  }

  dispose(): void {
    const gl = this.gl;
    for (const scratch of [this.destination, this.source, this.backup])
      if (scratch.texture !== null) gl.deleteTexture(scratch.texture);
    for (const {program} of this.programs.values()) gl.deleteProgram(program);
    for (const [storage, entry] of this.sources) this.evict(storage, entry);
    gl.deleteFramebuffer(this.framebuffer);
    gl.deleteFramebuffer(this.backupFramebuffer);
    gl.deleteFramebuffer(this.mixFramebuffer);
    for (const texture of this.coefficients.values()) gl.deleteTexture(texture);
    if (this.actions !== null) gl.deleteTexture(this.actions);
    this.coefficients.clear();
    this.programs.clear();
  }
}

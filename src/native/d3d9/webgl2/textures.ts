import {
  D3D_OK,
  D3DERR_INVALIDCALL,
  D3DFMT_DXT1,
  D3DFMT_DXT3,
  D3DLOCK_NO_DIRTY_UPDATE,
  D3DLOCK_READONLY,
  D3DPOOL_DEFAULT,
  D3DPOOL_MANAGED,
  D3DUSAGE_DYNAMIC,
  D3DUSAGE_RENDERTARGET,
  type D3dLockedRect,
  type D3dRect,
  type D3dResult,
  type D3dSurfaceDesc,
  type IDirect3DSurface9,
  type IDirect3DTexture9,
} from '../contract.js';
import {Dxt5Decoder} from '../../../graphics/s3tc.js';
import {decodeDxt1, decodeDxt3} from '../../../graphics/s3tc-dxt1-dxt3.js';
import {GL} from './gl.js';
import {convertRect, levelLayout, type TextureFormat} from './formats.js';

/** What a texture needs from its device. */
export interface TextureHost {
  readonly gl: WebGL2RenderingContext;
  /** True when DXT levels upload compressed. */
  readonly s3tc: boolean;
  /** Binds `texture` on the upload unit. */
  bindForUpload(texture: WebGLTexture | null): void;
  /** The texture bound a framebuffer directly (creating or re-attaching one). */
  framebufferBound(): void;
  /** Called once when the texture's reference count reaches zero. */
  textureDestroyed(texture: Texture): void;
  addRef(): number;
  release(): number;
}

interface Level {
  readonly width: number;
  readonly height: number;
  readonly pitch: number;
  readonly rows: number;
  /** D3D-layout system-memory copy: lock target and source for restores. */
  shadow: Uint8Array | null;
  locked: {rect: D3dRect; flags: number} | null;
  surface: Surface | null;
  framebuffer: WebGLFramebuffer | null;
  framebufferDepth: WebGLRenderbuffer | null;
}

let sharedDxt5: Dxt5Decoder | undefined;

/** A level of a texture, or the back buffer. Reference counts go to the container. */
export class Surface implements IDirect3DSurface9 {
  constructor(
    private readonly container: {addRef(): number; release(): number},
    private readonly desc: () => D3dSurfaceDesc,
    /** null for the back buffer (default framebuffer). */
    readonly texture: Texture | null,
    readonly level: number,
  ) {}
  addRef(): number {
    return this.container.addRef();
  }
  release(): number {
    return this.container.release();
  }
  getDesc(): D3dSurfaceDesc {
    return this.desc();
  }
}

export class Texture implements IDirect3DTexture9 {
  private references = 1;
  private destroyed = false;
  glTexture: WebGLTexture | null = null;
  private readonly levels: Level[] = [];
  /** Device-side id for caches. */
  readonly id: number;
  private static nextId = 1;

  constructor(
    private readonly host: TextureHost,
    readonly width: number,
    readonly height: number,
    levelCount: number,
    readonly usage: number,
    readonly format: TextureFormat,
    readonly pool: number,
  ) {
    this.id = Texture.nextId++;
    for (let level = 0; level < levelCount; level++) {
      const w = Math.max(1, width >> level),
        h = Math.max(1, height >> level),
        {pitch, rows} = levelLayout(format, w, h);
      this.levels.push({
        width: w,
        height: h,
        pitch,
        rows,
        shadow: null,
        locked: null,
        surface: null,
        framebuffer: null,
        framebufferDepth: null,
      });
    }
    this.allocate();
  }

  get levelCount(): number {
    return this.levels.length;
  }

  get renderTarget(): boolean {
    return (this.usage & D3DUSAGE_RENDERTARGET) !== 0;
  }

  /** Whether the GL storage has an alpha channel D3D would show (X8 targets do not). */
  get renderTargetHasAlpha(): boolean {
    return this.format.renderTarget?.hasAlpha ?? true;
  }

  levelSize(level: number): {width: number; height: number} {
    const l = this.levels[level]!;
    return {width: l.width, height: l.height};
  }

  /** Creates GL storage for every level and re-uploads the system-memory copies. */
  allocate(): void {
    const gl = this.host.gl;
    this.glTexture = gl.createTexture();
    this.host.bindForUpload(this.glTexture);
    gl.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_MAX_LEVEL, this.levels.length - 1);
    const target = this.renderTarget ? this.format.renderTarget : null;
    this.levels.forEach((level, index) => {
      level.framebuffer = null;
      level.framebufferDepth = null;
      if (target) {
        gl.texImage2D(
          GL.TEXTURE_2D,
          index,
          target.internalFormat,
          level.width,
          level.height,
          0,
          target.glFormat,
          target.glType,
          null,
        );
        return;
      }
      if (this.format.compressed) {
        this.uploadCompressed(index, level.shadow ?? new Uint8Array(level.pitch * level.rows));
        return;
      }
      gl.texImage2D(
        GL.TEXTURE_2D,
        index,
        this.format.internalFormat,
        level.width,
        level.height,
        0,
        this.format.glFormat,
        this.format.glType,
        null,
      );
      if (level.shadow)
        this.upload(index, {left: 0, top: 0, right: level.width, bottom: level.height});
    });
  }

  /** Drops GL objects without uploading (context lost); `allocate` recreates them. */
  forgetGl(): void {
    this.glTexture = null;
    for (const level of this.levels) {
      level.framebuffer = null;
      level.framebufferDepth = null;
    }
  }

  /** The level's framebuffer, created on first use. `depth` is attached when it changes. */
  framebuffer(level: number, depth: WebGLRenderbuffer | null): WebGLFramebuffer | null {
    const l = this.levels[level];
    if (!l || !this.glTexture) return null;
    const gl = this.host.gl;
    if (!l.framebuffer) {
      l.framebuffer = gl.createFramebuffer();
      gl.bindFramebuffer(GL.FRAMEBUFFER, l.framebuffer);
      gl.framebufferTexture2D(
        GL.FRAMEBUFFER,
        GL.COLOR_ATTACHMENT0,
        GL.TEXTURE_2D,
        this.glTexture,
        level,
      );
      l.framebufferDepth = null;
      if (depth)
        gl.framebufferRenderbuffer(
          GL.FRAMEBUFFER,
          GL.DEPTH_STENCIL_ATTACHMENT,
          GL.RENDERBUFFER,
          depth,
        );
      l.framebufferDepth = depth;
      this.host.framebufferBound();
      return l.framebuffer;
    }
    if (l.framebufferDepth !== depth) {
      gl.bindFramebuffer(GL.FRAMEBUFFER, l.framebuffer);
      gl.framebufferRenderbuffer(
        GL.FRAMEBUFFER,
        GL.DEPTH_STENCIL_ATTACHMENT,
        GL.RENDERBUFFER,
        depth,
      );
      l.framebufferDepth = depth;
      this.host.framebufferBound();
    }
    return l.framebuffer;
  }

  addRef(): number {
    return ++this.references;
  }

  release(): number {
    if (this.references === 0) return 0;
    const count = --this.references;
    if (count === 0) this.destroy();
    return count;
  }

  get alive(): boolean {
    return !this.destroyed;
  }

  private destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    const gl = this.host.gl;
    for (const level of this.levels) {
      if (level.framebuffer) gl.deleteFramebuffer(level.framebuffer);
      level.framebuffer = null;
      level.shadow = null;
    }
    if (this.glTexture) gl.deleteTexture(this.glTexture);
    this.glTexture = null;
    this.host.textureDestroyed(this);
  }

  private levelDesc(level: number): D3dSurfaceDesc {
    const l = this.levels[level]!;
    return {
      format: this.format.format,
      usage: this.usage,
      pool: this.pool,
      width: l.width,
      height: l.height,
    };
  }

  getLevelDesc(level: number): D3dResult<D3dSurfaceDesc> {
    if (!this.levels[level]) return {hr: D3DERR_INVALIDCALL, value: null};
    return {hr: D3D_OK, value: this.levelDesc(level)};
  }

  getSurfaceLevel(level: number): D3dResult<IDirect3DSurface9> {
    const l = this.levels[level];
    if (!l) return {hr: D3DERR_INVALIDCALL, value: null};
    l.surface ??= new Surface(this, () => this.levelDesc(level), this, level);
    this.addRef();
    return {hr: D3D_OK, value: l.surface};
  }

  lockRect(level: number, rect: D3dRect | null, flags: number): D3dResult<D3dLockedRect> {
    const l = this.levels[level];
    if (!l || l.locked || this.renderTarget) return {hr: D3DERR_INVALIDCALL, value: null};
    if (this.pool === D3DPOOL_DEFAULT && !(this.usage & D3DUSAGE_DYNAMIC))
      return {hr: D3DERR_INVALIDCALL, value: null};
    const area = rect ?? {left: 0, top: 0, right: l.width, bottom: l.height};
    if (
      area.left < 0 ||
      area.top < 0 ||
      area.right > l.width ||
      area.bottom > l.height ||
      area.left >= area.right ||
      area.top >= area.bottom
    )
      return {hr: D3DERR_INVALIDCALL, value: null};
    if (this.format.compressed) {
      const aligned = (v: number, edge: number) => v % 4 === 0 || v === edge;
      if (
        area.left % 4 !== 0 ||
        area.top % 4 !== 0 ||
        !aligned(area.right, l.width) ||
        !aligned(area.bottom, l.height)
      )
        return {hr: D3DERR_INVALIDCALL, value: null};
    }
    l.shadow ??= new Uint8Array(l.pitch * l.rows);
    const offset = this.format.compressed
      ? (area.top / 4) * l.pitch + (area.left / 4) * this.format.bytes
      : area.top * l.pitch + area.left * this.format.bytes;
    const rows = this.format.compressed
      ? Math.ceil((area.bottom - area.top) / 4)
      : area.bottom - area.top;
    l.locked = {rect: {...area}, flags};
    return {
      hr: D3D_OK,
      value: {pitch: l.pitch, bits: l.shadow.subarray(offset, offset + l.pitch * rows)},
    };
  }

  unlockRect(level: number): number {
    const l = this.levels[level];
    if (!l || !l.locked) return D3DERR_INVALIDCALL;
    const {rect, flags} = l.locked;
    l.locked = null;
    if (!(flags & (D3DLOCK_READONLY | D3DLOCK_NO_DIRTY_UPDATE)) && this.glTexture)
      this.upload(level, rect);
    return D3D_OK;
  }

  private upload(level: number, rect: D3dRect): void {
    const l = this.levels[level]!;
    if (!l.shadow) return;
    if (this.format.compressed) {
      this.uploadCompressed(level, l.shadow);
      return;
    }
    const gl = this.host.gl;
    this.host.bindForUpload(this.glTexture);
    gl.texSubImage2D(
      GL.TEXTURE_2D,
      level,
      rect.left,
      rect.top,
      rect.right - rect.left,
      rect.bottom - rect.top,
      this.format.glFormat,
      this.format.glType,
      convertRect(this.format, l.shadow, l.pitch, rect),
    );
  }

  /** Whole-level upload of DXT data: compressed with S3TC, otherwise decoded to RGBA8. */
  private uploadCompressed(level: number, blocks: Uint8Array): void {
    const gl = this.host.gl,
      l = this.levels[level]!;
    this.host.bindForUpload(this.glTexture);
    if (this.host.s3tc) {
      gl.compressedTexImage2D(
        GL.TEXTURE_2D,
        level,
        this.format.compressedFormat,
        l.width,
        l.height,
        0,
        blocks,
      );
      return;
    }
    const rgba =
      this.format.format === D3DFMT_DXT1
        ? decodeDxt1(blocks, l.width, l.height)
        : this.format.format === D3DFMT_DXT3
          ? decodeDxt3(blocks, l.width, l.height)
          : (sharedDxt5 ??= new Dxt5Decoder()).decode(blocks, l.width, l.height);
    gl.texImage2D(
      GL.TEXTURE_2D,
      level,
      GL.RGBA8,
      l.width,
      l.height,
      0,
      GL.RGBA,
      GL.UNSIGNED_BYTE,
      rgba,
    );
  }
}

/** Mip levels `CreateTexture` creates for `levels` (0 = the full chain down to 1×1). */
export function mipLevelCount(width: number, height: number, levels: number): number {
  const full = Math.floor(Math.log2(Math.max(width, height))) + 1;
  return levels === 0 ? full : Math.min(levels, full);
}

export function isValidPool(pool: number, usage: number): boolean {
  if (pool === D3DPOOL_MANAGED) return (usage & (D3DUSAGE_RENDERTARGET | D3DUSAGE_DYNAMIC)) === 0;
  return pool === D3DPOOL_DEFAULT;
}

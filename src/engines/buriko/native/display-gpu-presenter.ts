import type {BurikoBitmapRectangle, BurikoBitmapStorage} from './bitmap.js';
import type {BurikoDisplayTexture} from './display-texture.js';
import type {BurikoPresentationSampler} from './presentation-sampling.js';
import {beginRuntimeSpan, recordRuntimeMetric} from '../../../platform/runtime-performance.js';

const VERTEX = `#version 300 es
void main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));gl_Position=vec4(p*2.-1.,0.,1.);}`;

// Texels are uploaded as stored (BGRA bytes in RGBA channels) and swizzled here. Coordinates come
// from the CPU reference's binary32 column/row split, so only the per-pixel filter runs on the GPU.
const FRAGMENT = `#version 300 es
precision highp float;precision highp int;precision highp sampler2D;
uniform sampler2D image;uniform sampler2D columns;uniform sampler2D rows;
uniform ivec2 first;uniform int outputHeight;uniform ivec2 size;uniform bool linear;
uniform uint opaque;
out vec4 color;
// The software device rounds every product before adding. An opaque bit round trip keeps the
// compiler from contracting the multiply-add into a fused operation.
float product(float a,float b){return uintBitsToFloat(floatBitsToUint(a*b)^opaque);}
vec3 product(vec3 a,float b){return vec3(product(a.x,b),product(a.y,b),product(a.z,b));}
vec3 mad(vec3 a,float b,vec3 c){return product(a,b)+c;}
// Uint8ClampedArray stores the binary32 product with 255 rounded half to even. Whole levels
// divided by 255 convert back to the same UNORM byte on every conforming implementation.
vec4 unorm(vec3 c){return vec4(roundEven(clamp(product(c,255.),0.,255.))/255.,1.);}
vec3 texel(int x,int y){
  if(x<0||y<0||x>=size.x||y>=size.y)return vec3(0.);
  return texelFetch(image,ivec2(x,y),0).bgr;
}
void main(){
  int column=int(gl_FragCoord.x)-first.x,row=outputHeight-1-int(gl_FragCoord.y)-first.y;
  vec2 cx=texelFetch(columns,ivec2(column,0),0).xy,cy=texelFetch(rows,ivec2(row,0),0).xy;
  int x=int(cx.x),y=int(cy.x);
  if(!linear){color=vec4(texel(x,y),1.);return;}
  float fx=cx.y,fy=cy.y;
  vec3 top=mad(texel(x+1,y),fx,product(texel(x,y),1.-fx));
  vec3 bottom=mad(texel(x+1,y+1),fx,product(texel(x,y+1),1.-fx));
  color=unorm(mad(bottom,fy,product(top,1.-fy)));
}`;

let gpuPresentationEnabled = true;

/** `?gpu=0` keeps software presentation in the browser-optimized profile, for A/B captures. */
export function setBurikoGpuPresentationEnabled(value: boolean): void {
  gpuPresentationEnabled = value;
}
export function burikoGpuPresentationEnabled(): boolean {
  return gpuPresentationEnabled;
}

/** Output raster span and per-column/row source coordinates of one presentation quad. */
export interface BurikoGpuQuadCoordinates {
  firstX: number;
  firstY: number;
  /** Interleaved integer source position and binary32 fraction, one pair per output column. */
  columns: Float32Array;
  rows: Float32Array;
}

/** The display texture, its textless plane for DOM text, or a movie drawn over either. */
export type BurikoGpuImageSlot = 'display' | 'textless' | 'movie';

interface Image {
  texture: WebGLTexture | null;
  width: number;
  height: number;
  /** The display texture whose logical area this image currently holds. */
  holds: BurikoDisplayTexture | null;
  /** The pixel plane of `holds` that was uploaded: its own storage or its textless plane. */
  plane: BurikoBitmapStorage | null;
}

/**
 * Browser-optimized WebGL 2 presentation of the display texture. It replaces the software
 * rasterizer and putImageData with a texture upload of changed texels, one draw, and a GPU copy
 * into the shared 2D canvas. Coordinates are those of the software path and the shader repeats
 * its binary32 arithmetic, so the WebGL output matches the software frame. The owner falls back
 * to software whenever this returns false. The GPU compositor shares this context and draws
 * directly into the display image.
 */
export class BurikoGpuPresenter {
  private readonly surface: HTMLCanvasElement;
  readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly vertexArray: WebGLVertexArrayObject;
  private readonly uniforms: Record<string, WebGLUniformLocation | null>;
  private readonly images: Record<BurikoGpuImageSlot, Image> = {
    display: {texture: null, width: 0, height: 0, holds: null, plane: null},
    textless: {texture: null, width: 0, height: 0, holds: null, plane: null},
    movie: {texture: null, width: 0, height: 0, holds: null, plane: null},
  };
  private readonly columns: WebGLTexture;
  private readonly rows: WebGLTexture;
  /** A display texture whose current pixels exist only in the display image. */
  private owned: BurikoDisplayTexture | null = null;
  private lost = false;

  private constructor(document: Document) {
    this.surface = document.createElement('canvas');
    const gl = this.surface.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    if (gl === null) throw new Error('WebGL 2 is unavailable');
    this.gl = gl;
    this.surface.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      this.lost = true;
    });
    this.program = burikoGpuProgram(gl, VERTEX, FRAGMENT);
    this.uniforms = Object.fromEntries(
      ['image', 'columns', 'rows', 'first', 'outputHeight', 'size', 'linear', 'opaque'].map(
        (name) => [name, gl.getUniformLocation(this.program, name)],
      ),
    );
    this.columns = burikoGpuTexture(gl);
    this.rows = burikoGpuTexture(gl);
    this.vertexArray = gl.createVertexArray()!;
    gl.disable(gl.DITHER);
    gl.disable(gl.BLEND);
  }

  /** Null when WebGL 2 or a DOM canvas is unavailable; callers keep the software device. */
  static create(document: Document | null | undefined): BurikoGpuPresenter | null {
    if (document === null || document === undefined) return null;
    try {
      return new BurikoGpuPresenter(document);
    } catch {
      return null;
    }
  }

  get available(): boolean {
    return !this.lost && !this.gl.isContextLost();
  }

  /** The next upload of each slot sends the whole logical image. Owned pixels are lost. */
  invalidate(): void {
    this.images.display.holds = this.images.textless.holds = this.images.movie.holds = null;
    this.owned = null;
  }

  /** The display image sized for `texture`, allocated on first use. */
  image(slot: BurikoGpuImageSlot, texture: BurikoDisplayTexture): WebGLTexture {
    const gl = this.gl,
      image = this.images[slot];
    if (
      image.texture === null ||
      image.width !== texture.width ||
      image.height !== texture.height
    ) {
      // Immutable storage cannot be respecified; replace the texture object.
      if (image.texture !== null) gl.deleteTexture(image.texture);
      image.texture = burikoGpuTexture(gl);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, texture.width, texture.height);
      image.width = texture.width;
      image.height = texture.height;
      image.holds = null;
      if (this.owned === texture) this.owned = null;
    }
    return image.texture;
  }

  /** Whether the image already holds `texture`'s logical area. */
  holds(texture: BurikoDisplayTexture, slot: BurikoGpuImageSlot = 'display'): boolean {
    return this.images[slot].holds === texture;
  }

  /**
   * The GPU compositor wrote `texture`'s current pixels into the display image only, and with
   * `textless` its textless plane into that image. Uploads of that texture are skipped until
   * `release` reports its software bytes current again.
   */
  own(texture: BurikoDisplayTexture, textless: BurikoBitmapStorage | null = null): void {
    this.images.display.holds = texture;
    this.images.display.plane = texture.storage;
    if (textless !== null) {
      this.images.textless.holds = texture;
      this.images.textless.plane = textless;
    } else if (this.images.textless.holds === texture) this.images.textless.holds = null;
    this.owned = texture;
  }
  owns(texture: BurikoDisplayTexture): boolean {
    return this.owned === texture;
  }
  release(texture: BurikoDisplayTexture): void {
    if (this.owned === texture) this.owned = null;
  }

  /**
   * Upload changed texels. `changed` null means none; undefined means the whole logical area.
   * `plane` is the storage read, the texture's own or its textless plane of the same layout.
   */
  upload(
    slot: BurikoGpuImageSlot,
    texture: BurikoDisplayTexture,
    logicalWidth: number,
    logicalHeight: number,
    changed: BurikoBitmapRectangle | null | undefined,
    plane: BurikoBitmapStorage = texture.storage,
  ): boolean {
    if (!this.available) return false;
    const gl = this.gl,
      image = this.images[slot];
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.image(slot, texture));
    if (this.owned === texture && image.holds === texture) return true;
    let region = changed;
    if (image.holds !== texture || image.plane !== plane || region === undefined)
      region = {left: 0, top: 0, right: logicalWidth - 1, bottom: logicalHeight - 1};
    if (region === null) return true;
    const left = Math.max(0, region.left),
      top = Math.max(0, region.top),
      right = Math.min(texture.width - 1, region.right),
      bottom = Math.min(texture.height - 1, region.bottom);
    if (left > right || top > bottom) {
      image.holds = texture;
      image.plane = plane;
      return true;
    }
    const width = right - left + 1,
      height = bottom - top + 1,
      offset = top * texture.pitch + left * 4,
      length = (height - 1) * texture.pitch + width * 4;
    const finishUpload = beginRuntimeSpan('buriko.display.gpu-upload');
    try {
      plane.range(offset, length, true);
      const bytes = plane.bytes;
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, texture.pitch >>> 2);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        left,
        top,
        width,
        height,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        bytes,
        offset,
      );
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    } finally {
      finishUpload?.({width, height});
    }
    recordRuntimeMetric('buriko.display.gpu-upload.pixels', width * height);
    image.holds = texture;
    image.plane = plane;
    return true;
  }

  /** The WebGL canvas holding the last drawn frame, for copying into the 2D presentation canvas. */
  get output(): HTMLCanvasElement {
    return this.surface;
  }

  /** Draw the quad, over opaque black when `clear` is set, into an output of the given size. */
  draw(
    slot: BurikoGpuImageSlot,
    texture: BurikoDisplayTexture,
    coordinates: BurikoGpuQuadCoordinates,
    sampler: BurikoPresentationSampler,
    width: number,
    height: number,
    clear: boolean,
  ): boolean {
    const image = this.images[slot];
    if (!this.available || image.holds !== texture) return false;
    const gl = this.gl;
    if (this.surface.width !== width || this.surface.height !== height) {
      if (!clear) return false;
      this.surface.width = width;
      this.surface.height = height;
    }
    const finishDraw = beginRuntimeSpan('buriko.display.gpu-draw');
    try {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.useProgram(this.program);
      gl.bindVertexArray(this.vertexArray);
      gl.viewport(0, 0, width, height);
      gl.disable(gl.SCISSOR_TEST);
      if (clear) {
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      const columns = coordinates.columns.length >>> 1,
        rows = coordinates.rows.length >>> 1;
      if (columns > 0 && rows > 0) {
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, image.texture);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.columns);
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RG32F,
          columns,
          1,
          0,
          gl.RG,
          gl.FLOAT,
          coordinates.columns,
        );
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, this.rows);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, rows, 1, 0, gl.RG, gl.FLOAT, coordinates.rows);
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(coordinates.firstX, height - coordinates.firstY - rows, columns, rows);
        gl.uniform1i(this.uniforms.image!, 0);
        gl.uniform1i(this.uniforms.columns!, 1);
        gl.uniform1i(this.uniforms.rows!, 2);
        gl.uniform1ui(this.uniforms.opaque!, 0);
        gl.uniform2i(this.uniforms.first!, coordinates.firstX, coordinates.firstY);
        gl.uniform1i(this.uniforms.outputHeight!, height);
        gl.uniform2i(this.uniforms.size!, texture.width, texture.height);
        gl.uniform1i(this.uniforms.linear!, sampler === 'linear' ? 1 : 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
    } finally {
      finishDraw?.({width, height, columns: coordinates.columns.length >>> 1});
    }
    return this.available;
  }

  dispose(): void {
    const gl = this.gl;
    for (const image of Object.values(this.images)) {
      if (image.texture !== null) gl.deleteTexture(image.texture);
      image.texture = null;
      image.holds = null;
    }
    gl.deleteTexture(this.columns);
    gl.deleteTexture(this.rows);
    gl.deleteProgram(this.program);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    this.owned = null;
  }
}

/** Compile and link one program; errors throw so construction can fall back to software. */
export function burikoGpuProgram(
  gl: WebGL2RenderingContext,
  vertex: string,
  fragment: string,
): WebGLProgram {
  const compile = (type: number, source: string): WebGLShader => {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
      throw new Error(gl.getShaderInfoLog(shader) ?? 'Shader compilation failed');
    return shader;
  };
  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vertex));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS))
    throw new Error(gl.getProgramInfoLog(program) ?? 'Program link failed');
  return program;
}

/** A nearest-sampled, edge-clamped texture, left bound to the active unit. */
export function burikoGpuTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const texture = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

/** Full-viewport triangle; fragment shaders address texels through gl_FragCoord. */
export const BURIKO_GPU_VERTEX = VERTEX;

/**
 * The software rasterizer's column and row split for one quad (see display-device.ts
 * rasterizeQuad): binary32 UV, texel position, and for linear sampling the half-texel offset.
 * Null when a coordinate is not finite or not exactly representable, which the software path
 * handles by per-pixel sampling.
 */
export function burikoGpuQuadCoordinates(
  vertices: Uint8Array,
  textureWidth: number,
  textureHeight: number,
  outputWidth: number,
  outputHeight: number,
  sampler: BurikoPresentationSampler,
): BurikoGpuQuadCoordinates | null {
  const f32 = Math.fround;
  const quad = new DataView(vertices.buffer, vertices.byteOffset, vertices.byteLength);
  const left = quad.getFloat32(0, true),
    top = quad.getFloat32(4, true),
    right = quad.getFloat32(28, true),
    bottom = quad.getFloat32(60, true);
  const uMax = quad.getFloat32(48, true),
    vMax = quad.getFloat32(80, true);
  const axis = (
    start: number,
    end: number,
    maximum: number,
    size: number,
    limit: number,
  ): [number, Float32Array] | null => {
    const extent = f32(end - start),
      first = Math.max(0, Math.ceil(start)),
      last = Math.min(limit, Math.ceil(end));
    if (!Number.isFinite(first) || !Number.isFinite(last)) return null;
    const count = Math.max(0, last - first),
      output = new Float32Array(count * 2),
      scale = f32(size);
    for (let index = 0; index < count; index++) {
      const position = f32(f32(f32(f32(first + index - start) / extent) * maximum) * scale);
      let texel: number, fraction: number;
      if (sampler === 'linear') {
        const shifted = f32(position - 0.5);
        texel = Math.floor(shifted);
        fraction = f32(shifted - texel);
      } else {
        texel = Math.floor(position);
        fraction = 0;
      }
      if (!Number.isFinite(texel) || Math.abs(texel) > 0x7fffff || !Number.isFinite(fraction))
        return null;
      output[index * 2] = texel;
      output[index * 2 + 1] = fraction;
    }
    return [first, output];
  };
  const x = axis(left, right, uMax, textureWidth, outputWidth),
    y = axis(top, bottom, vMax, textureHeight, outputHeight);
  if (x === null || y === null) return null;
  return {firstX: x[0], firstY: y[0], columns: x[1], rows: y[1]};
}

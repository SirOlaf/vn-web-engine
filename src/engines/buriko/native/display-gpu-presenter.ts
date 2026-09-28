import type {BurikoBitmapRectangle} from './bitmap.js';
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

/**
 * Browser-optimized WebGL 2 presentation of the display texture. It replaces the software
 * rasterizer and putImageData with a texture upload of changed texels, one draw, and a GPU copy
 * into the shared 2D canvas. Coordinates stay those of the software path; filtering runs in the
 * GPU's binary32 arithmetic, which may contract multiply-adds, and its UNORM rounding, so pixels
 * may differ from the software device by one step. The owner falls back to software whenever
 * this returns false.
 */
export class BurikoGpuPresenter {
  private readonly surface: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly uniforms: Record<string, WebGLUniformLocation | null>;
  private image: WebGLTexture;
  private readonly columns: WebGLTexture;
  private readonly rows: WebGLTexture;
  private readonly texture: () => WebGLTexture;
  private imageWidth = 0;
  private imageHeight = 0;
  private uploaded: BurikoDisplayTexture | null = null;
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
    const compile = (type: number, source: string): WebGLShader => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw new Error(gl.getShaderInfoLog(shader) ?? 'Shader compilation failed');
      return shader;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(program) ?? 'Program link failed');
    this.program = program;
    this.uniforms = Object.fromEntries(
      ['image', 'columns', 'rows', 'first', 'outputHeight', 'size', 'linear', 'opaque'].map(
        (name) => [name, gl.getUniformLocation(program, name)],
      ),
    );
    const texture = (this.texture = (): WebGLTexture => {
      const result = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, result);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return result;
    });
    this.image = texture();
    this.columns = texture();
    this.rows = texture();
    gl.disable(gl.DITHER);
    gl.disable(gl.BLEND);
    gl.useProgram(program);
    gl.uniform1i(this.uniforms.image!, 0);
    gl.uniform1i(this.uniforms.columns!, 1);
    gl.uniform1i(this.uniforms.rows!, 2);
    gl.uniform1ui(this.uniforms.opaque!, 0);
    gl.bindVertexArray(gl.createVertexArray());
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

  /** The next upload must send the whole logical image, e.g. after software presentation. */
  invalidate(): void {
    this.uploaded = null;
  }

  /** Upload changed texels. `changed` null means none; undefined means the whole logical area. */
  upload(
    texture: BurikoDisplayTexture,
    logicalWidth: number,
    logicalHeight: number,
    changed: BurikoBitmapRectangle | null | undefined,
  ): boolean {
    if (!this.available) return false;
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.image);
    if (this.imageWidth !== texture.width || this.imageHeight !== texture.height) {
      // Immutable storage cannot be respecified; replace the texture object.
      if (this.imageWidth !== 0) {
        gl.deleteTexture(this.image);
        this.image = this.texture();
      }
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, texture.width, texture.height);
      this.imageWidth = texture.width;
      this.imageHeight = texture.height;
      this.uploaded = null;
    }
    let region = changed;
    if (this.uploaded !== texture || region === undefined)
      region = {left: 0, top: 0, right: logicalWidth - 1, bottom: logicalHeight - 1};
    if (region === null) return true;
    const left = Math.max(0, region.left),
      top = Math.max(0, region.top),
      right = Math.min(texture.width - 1, region.right),
      bottom = Math.min(texture.height - 1, region.bottom);
    if (left > right || top > bottom) {
      this.uploaded = texture;
      return true;
    }
    const width = right - left + 1,
      height = bottom - top + 1,
      offset = top * texture.pitch + left * 4,
      length = (height - 1) * texture.pitch + width * 4;
    const finishUpload = beginRuntimeSpan('buriko.display.gpu-upload');
    try {
      texture.storage.range(offset, length, true);
      const bytes = texture.storage.bytes;
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
    this.uploaded = texture;
    return true;
  }

  /** The WebGL canvas holding the last drawn frame, for copying into the 2D presentation canvas. */
  get output(): HTMLCanvasElement {
    return this.surface;
  }

  /** Draw the quad, over opaque black when `clear` is set, into an output of the given size. */
  draw(
    texture: BurikoDisplayTexture,
    coordinates: BurikoGpuQuadCoordinates,
    sampler: BurikoPresentationSampler,
    width: number,
    height: number,
    clear: boolean,
  ): boolean {
    if (!this.available || this.uploaded !== texture) return false;
    const gl = this.gl;
    if (this.surface.width !== width || this.surface.height !== height) {
      if (!clear) return false;
      this.surface.width = width;
      this.surface.height = height;
    }
    const finishDraw = beginRuntimeSpan('buriko.display.gpu-draw');
    try {
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
    gl.deleteTexture(this.image);
    gl.deleteTexture(this.columns);
    gl.deleteTexture(this.rows);
    gl.deleteProgram(this.program);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    this.uploaded = null;
  }
}

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

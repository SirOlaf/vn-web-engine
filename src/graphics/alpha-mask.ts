import {packMaskTiles} from './mask-atlas.js';
import type {Rect} from './surface.js';
export interface AlphaMask {
  filter?: 'nearest' | 'linear';
  wrapS?: 'clamp' | 'repeat' | 'mirror';
  wrapT?: 'clamp' | 'repeat' | 'mirror';
  texture: number;
  source: Rect;
  scale: number;
  bias: number;
  channel?: 'alpha' | 'red';
  invert?: boolean;
  alphaOnly?: boolean;
}
export interface PixelImage {
  width: number;
  height: number;
  pixels: Uint8Array;
}
export interface MaskRequest {
  image: PixelImage;
  source: Rect;
  maskImage: PixelImage;
  mask: AlphaMask;
  width: number;
  height: number;
  color: number;
}
export interface MaskResult {
  canvas: HTMLCanvasElement;
  source: Rect;
}
/** Shared two-texture alpha threshold operation. Color and mask UVs are independent. */
export class AlphaMaskTarget {
  readonly canvas = document.createElement('canvas');
  private readonly gl: WebGLRenderingContext;
  private readonly program: WebGLProgram;
  private readonly cache = new Map<object, WebGLTexture>();
  private readonly buffer: WebGLBuffer;
  private readonly maxTextureSize: number;
  private readonly atlasLimit: number;
  private readonly pages: HTMLCanvasElement[] = [];
  private readonly position: number;
  private readonly uniforms: Record<string, WebGLUniformLocation | null>;
  constructor() {
    const gl = this.canvas.getContext('webgl', {
      alpha: true,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
      antialias: false,
    });
    if (!gl) throw new Error('WebGL is required for alpha-mask transitions');
    this.gl = gl;
    const compile = (kind: number, text: string) => {
      const shader = gl.createShader(kind);
      if (!shader) throw new Error('Cannot allocate mask shader');
      gl.shaderSource(shader, text);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw new Error(gl.getShaderInfoLog(shader) ?? 'Mask shader compilation failed');
      return shader;
    };
    const vs = compile(
      gl.VERTEX_SHADER,
      'attribute vec2 p;varying highp vec2 uv;void main(){uv=p;gl_Position=vec4(p.x*2.-1.,1.-p.y*2.,0.,1.);}',
    );
    const fs = compile(
      gl.FRAGMENT_SHADER,
      'precision highp float;varying highp vec2 uv;uniform sampler2D colorTexture;uniform sampler2D maskTexture;uniform vec4 colorRect;uniform vec4 maskRect;uniform vec2 threshold;uniform vec2 maskMode;uniform vec3 tint;uniform float alphaOnly;void main(){vec4 color=texture2D(colorTexture,colorRect.xy+uv*colorRect.zw);vec4 m=texture2D(maskTexture,maskRect.xy+uv*maskRect.zw);float mask=mix(m.a,m.r,maskMode.x);mask=mix(mask,1.-mask,maskMode.y);float alpha=color.a*clamp(mask*threshold.x-threshold.y,0.,1.);if(alpha<=0.)discard;gl_FragColor=vec4(mix(color.rgb,vec3(1.),alphaOnly)*tint,alpha);}',
    );
    const program = gl.createProgram(),
      buffer = gl.createBuffer();
    if (!program || !buffer) throw new Error('Cannot allocate mask pipeline');
    this.program = program;
    this.buffer = buffer;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(program) ?? 'Mask program link failed');
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]),
      gl.STATIC_DRAW,
    );
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    const viewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array;
    this.atlasLimit = Math.min(2048, this.maxTextureSize, viewport[0]!, viewport[1]!);
    this.position = gl.getAttribLocation(program, 'p');
    this.uniforms = Object.fromEntries(
      [
        'colorTexture',
        'maskTexture',
        'colorRect',
        'maskRect',
        'maskMode',
        'threshold',
        'alphaOnly',
        'tint',
      ].map((name) => [name, gl.getUniformLocation(program, name)]),
    );
  }
  render(
    image: PixelImage,
    source: Rect,
    maskImage: PixelImage,
    mask: AlphaMask,
    width: number,
    height: number,
    color: number,
  ): HTMLCanvasElement {
    const gl = this.gl;
    if (width < 1 || height < 1 || !Number.isFinite(width + height))
      throw new Error('Invalid alpha-mask output dimensions');
    if (this.canvas.width !== Math.ceil(width) || this.canvas.height !== Math.ceil(height)) {
      this.canvas.width = Math.ceil(width);
      this.canvas.height = Math.ceil(height);
    }
    this.begin();
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    this.paint(image, source, maskImage, mask, color);
    return this.canvas;
  }
  /** Render all tiles before the first Canvas 2D composition. Each atlas page
   * crosses the WebGL/Canvas boundary once, regardless of its glyph count. */
  renderBatch(requests: readonly MaskRequest[]): MaskResult[] {
    const tiles = packMaskTiles(requests, this.atlasLimit),
      results: MaskResult[] = [];
    const count = tiles.length ? tiles[tiles.length - 1]!.page + 1 : 0;
    for (let page = 0; page < count; page++) {
      const indices = tiles.flatMap((t, i) => (t.page === page ? [i] : []));
      const width = Math.max(...indices.map((i) => tiles[i]!.x + tiles[i]!.width + 1)),
        height = Math.max(...indices.map((i) => tiles[i]!.y + tiles[i]!.height + 1));
      if (this.canvas.width !== width) this.canvas.width = width;
      if (this.canvas.height !== height) this.canvas.height = height;
      this.begin();
      for (const i of indices) {
        const t = tiles[i]!,
          r = requests[i]!;
        this.gl.viewport(t.x, height - t.y - t.height, t.width, t.height);
        this.paint(r.image, r.source, r.maskImage, r.mask, r.color);
      }
      const canvas = this.pages[page] ?? (this.pages[page] = document.createElement('canvas'));
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      const c = canvas.getContext('2d');
      if (!c) throw new Error('Mask atlas canvas unavailable');
      c.globalCompositeOperation = 'copy';
      c.drawImage(this.canvas, 0, 0);
      for (const i of indices) {
        const t = tiles[i]!;
        results[i] = {canvas, source: {x: t.x, y: t.y, width: t.width, height: t.height}};
      }
    }
    while (this.pages.length > count) {
      const p = this.pages.pop()!;
      p.width = 0;
      p.height = 0;
    }
    return results;
  }
  canBatch(requests: readonly MaskRequest[]): boolean {
    return (
      requests.length > 1 &&
      requests.every(
        (r) =>
          Math.ceil(r.width) + 2 <= this.atlasLimit && Math.ceil(r.height) + 2 <= this.atlasLimit,
      )
    );
  }
  private begin(): void {
    const gl = this.gl;
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
  }
  private paint(
    image: PixelImage,
    source: Rect,
    maskImage: PixelImage,
    mask: AlphaMask,
    color: number,
  ): void {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    const attr = this.position;
    gl.enableVertexAttribArray(attr);
    gl.vertexAttribPointer(attr, 2, gl.FLOAT, false, 0, 0);
    const bind = (value: PixelImage, unit: number, name: string, rectName: string, rect: Rect) => {
      const max = this.maxTextureSize;
      if (value.width > max || value.height > max)
        throw new Error(`Mask atlas exceeds this device's ${max}-pixel texture limit`);
      if (
        rect.x < 0 ||
        rect.y < 0 ||
        rect.width < 0 ||
        rect.height < 0 ||
        rect.x + rect.width > value.width ||
        rect.y + rect.height > value.height
      )
        throw new Error('Alpha-mask source rectangle exceeds its atlas');
      gl.activeTexture(gl.TEXTURE0 + unit);
      let texture = this.cache.get(value);
      if (!texture) {
        const next = gl.createTexture();
        if (!next) throw new Error('Cannot allocate mask texture');
        texture = next;
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA,
          value.width,
          value.height,
          0,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          value.pixels as Uint8Array<ArrayBuffer>,
        );
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        const error = gl.getError();
        if (error !== gl.NO_ERROR) {
          gl.deleteTexture(texture);
          throw new Error(`Alpha-mask texture upload failed (WebGL 0x${error.toString(16)})`);
        }
        this.cache.set(value, texture);
      } else gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.uniform1i(this.uniforms[name]!, unit);
      gl.uniform4f(
        this.uniforms[rectName]!,
        rect.x / value.width,
        rect.y / value.height,
        rect.width / value.width,
        rect.height / value.height,
      );
    };
    bind(image, 0, 'colorTexture', 'colorRect', source);
    bind(maskImage, 1, 'maskTexture', 'maskRect', mask.source);
    // No synchronous GL queries here: this path also runs once per masked glyph.
    gl.uniform2f(this.uniforms.maskMode!, mask.channel === 'red' ? 1 : 0, mask.invert ? 1 : 0);
    gl.uniform2f(this.uniforms.threshold!, mask.scale, mask.bias);
    gl.uniform1f(this.uniforms.alphaOnly!, mask.alphaOnly ? 1 : 0);
    gl.uniform3f(
      this.uniforms.tint!,
      ((color >>> 16) & 255) / 255,
      ((color >>> 8) & 255) / 255,
      (color & 255) / 255,
    );
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
  invalidate(image: object): void {
    const texture = this.cache.get(image);
    if (texture) {
      this.gl.deleteTexture(texture);
      this.cache.delete(image);
    }
  }
  dispose(): void {
    for (const p of this.pages) {
      p.width = 0;
      p.height = 0;
    }
    this.pages.length = 0;
    for (const t of this.cache.values()) this.gl.deleteTexture(t);
    this.cache.clear();
    this.gl.deleteBuffer(this.buffer);
    this.gl.deleteProgram(this.program);
    this.canvas.width = 0;
    this.canvas.height = 0;
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

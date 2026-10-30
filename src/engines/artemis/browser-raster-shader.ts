import {
  artemisCompositeFragmentSource,
  type ArtemisCompositeKind,
  type ArtemisCompositeUniforms,
} from './composite-shader.js';
import {ARTEMIS_MOSAIC_FRAGMENT_SOURCE, type ArtemisMosaicUniforms} from './mosaic-shader.js';
import {ARTEMIS_NOISE_FRAGMENT_SOURCE, type ArtemisNoiseUniforms} from './noise-shader.js';
import {
  artemisDimensionFragmentSource,
  type ArtemisDimensionKind,
  type ArtemisDimensionUniforms,
} from './dimension-shader.js';
import {
  artemisPerspectiveFragmentSource,
  type ArtemisPerspectiveKind,
  type ArtemisPerspectiveUniforms,
} from './perspective-shader.js';
import {ARTEMIS_RADIAL_FRAGMENT_SOURCE, type ArtemisRadialUniforms} from './radial-shader.js';
import {
  artemisBlurFragmentSource,
  artemisOffsetBlurFragmentSource,
  isArtemisOffsetBlurKind,
  type ArtemisOffsetBlurKind,
  type ArtemisDiagonalBlurUniforms,
  type ArtemisBlurKind,
  type ArtemisBlurUniforms,
} from './blur-shader.js';
import {
  artemisColorFragmentSource,
  type ArtemisColorKind,
  type ArtemisColorUniforms,
} from './color-shader.js';
import {artemisRevision} from './revision.js';
import {ARTEMIS_RASTER_FRAGMENT_SOURCE, type ArtemisRasterUniforms} from './raster-shader.js';
import {ARTEMIS_SCREEN_FRAGMENT_SOURCE, type ArtemisScreenUniforms} from './screen-shader.js';
import type {TriangleImage} from '../../graphics/triangle-draw.js';

const vertexSource = `#version 300 es
precision highp float;
out vec2 vUv;
out vec2 vBackUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = vec2(p.x, 1.0 - p.y);
  vBackUv=vUv;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/** Actual WebGL executable for the recognized raster program. The caller owns
 * context/target and sampler policy; shader output is straight RGBA before blending.
 * This helper uses a dedicated context and does not save another renderer's state.
 */
export class ArtemisBrowserRasterShader {
  private readonly program: WebGLProgram;
  private readonly texture: WebGLTexture;
  private readonly vao: WebGLVertexArrayObject;
  private readonly userTexture: WebGLTexture;
  private disposed = false;
  constructor(
    hash: string,
    private readonly gl: WebGL2RenderingContext,
    private readonly kind:
      | 'raster'
      | 'screen'
      | ArtemisColorKind
      | ArtemisBlurKind
      | 'radial'
      | 'mosaic'
      | ArtemisPerspectiveKind
      | ArtemisOffsetBlurKind
      | 'noise'
      | ArtemisDimensionKind
      | ArtemisCompositeKind = 'raster',
  ) {
    artemisRevision(hash);
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) throw Error('Cannot allocate raster shader');
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const error = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw Error(error ?? 'Raster shader compilation failed');
      }
      return shader;
    };
    const vertex = compile(gl.VERTEX_SHADER, vertexSource);
    let fragment: WebGLShader | undefined,
      program: WebGLProgram | null = null;
    try {
      fragment = compile(
        gl.FRAGMENT_SHADER,
        kind === 'dimhole' || kind === 'dimring'
          ? artemisDimensionFragmentSource(kind)
          : kind === 'noise'
            ? ARTEMIS_NOISE_FRAGMENT_SOURCE
            : kind === 'raster'
              ? ARTEMIS_RASTER_FRAGMENT_SOURCE
              : kind === 'screen'
                ? ARTEMIS_SCREEN_FRAGMENT_SOURCE
                : kind === 'blur_h' || kind === 'blur_v'
                  ? artemisBlurFragmentSource(kind)
                  : isArtemisOffsetBlurKind(kind)
                    ? artemisOffsetBlurFragmentSource(kind)
                    : kind === 'radial'
                      ? ARTEMIS_RADIAL_FRAGMENT_SOURCE
                      : kind === 'mosaic'
                        ? ARTEMIS_MOSAIC_FRAGMENT_SOURCE
                        : kind.startsWith('perspective')
                          ? artemisPerspectiveFragmentSource(kind as ArtemisPerspectiveKind)
                          : ['add', 'mul', 'compbr', 'compbrc', 'compdk', 'compdkc'].includes(kind)
                            ? artemisCompositeFragmentSource(kind as ArtemisCompositeKind)
                            : artemisColorFragmentSource(kind as ArtemisColorKind),
      );
      program = gl.createProgram();
      if (!program) throw Error('Cannot allocate raster program');
      gl.attachShader(program, vertex);
      gl.attachShader(program, fragment);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS))
        throw Error(gl.getProgramInfoLog(program) ?? 'Raster program link failed');
    } catch (error) {
      if (program) gl.deleteProgram(program);
      throw error;
    } finally {
      gl.deleteShader(vertex);
      if (fragment) gl.deleteShader(fragment);
    }
    this.program = program;
    const texture = gl.createTexture(),
      userTexture = gl.createTexture(),
      vao = gl.createVertexArray();
    if (!texture || !vao || !userTexture) {
      if (texture) gl.deleteTexture(texture);
      if (userTexture) gl.deleteTexture(userTexture);
      if (vao) gl.deleteVertexArray(vao);
      gl.deleteProgram(program);
      throw Error('Cannot allocate raster GPU resources');
    }
    this.texture = texture;
    this.userTexture = userTexture;
    this.vao = vao;
  }
  draw(
    image: TriangleImage,
    width: number,
    height: number,
    p:
      | ArtemisRasterUniforms
      | ArtemisScreenUniforms
      | ArtemisColorUniforms
      | ArtemisBlurUniforms
      | ArtemisDiagonalBlurUniforms
      | ArtemisNoiseUniforms
      | ArtemisRadialUniforms
      | ArtemisMosaicUniforms
      | ArtemisDimensionUniforms
      | ArtemisPerspectiveUniforms
      | ArtemisCompositeUniforms,
    sampler: {readonly filter: 'nearest' | 'linear'; readonly address: 'clamp' | 'repeat'},
    userImage?: TriangleImage,
  ): void {
    if (this.disposed) throw Error('Raster GPU program disposed');
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 1 ||
      height < 1 ||
      !Number.isInteger(image.width) ||
      !Number.isInteger(image.height) ||
      image.width < 1 ||
      image.height < 1 ||
      image.pixels.length !== image.width * image.height * 4 ||
      ![p.alpha, ...('angle' in p ? [p.angle, p.inter, p.size] : [])].every(Number.isFinite)
    )
      throw Error('Invalid raster GPU input');
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const filter =
        sampler.filter === 'nearest' ? gl.NEAREST : sampler.filter === 'linear' ? gl.LINEAR : null,
      address =
        sampler.address === 'clamp'
          ? gl.CLAMP_TO_EDGE
          : sampler.address === 'repeat'
            ? gl.REPEAT
            : null;
    if (filter === null || address === null) throw Error('Unsupported raster sampler policy');
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, address);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, address);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      image.width,
      image.height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      image.pixels as Uint8Array<ArrayBuffer>,
    );
    gl.uniform1i(gl.getUniformLocation(this.program, 'uFore'), 0);
    gl.uniform1f(gl.getUniformLocation(this.program, 'uAlpha'), p.alpha);
    if (this.kind === 'raster') {
      if (!('angle' in p)) throw Error('Missing raster uniforms');
      for (const [name, value] of [
        ['uAngle', p.angle],
        ['uInter', p.inter],
        ['uSize', p.size],
      ] as const)
        gl.uniform1f(gl.getUniformLocation(this.program, name), value);
    } else if (
      this.kind === 'screen' ||
      this.kind === 'noise' ||
      ['add', 'mul', 'compbr', 'compbrc', 'compdk', 'compdkc'].includes(this.kind)
    ) {
      const auxiliary =
        userImage ??
        (this.kind === 'noise' ? {width: 1, height: 1, pixels: new Uint8Array(4)} : undefined);
      if (
        !auxiliary ||
        auxiliary.width < 1 ||
        auxiliary.height < 1 ||
        auxiliary.pixels.length !== auxiliary.width * auxiliary.height * 4
      )
        throw Error('Missing screen user texture');
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.userTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, address);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, address);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA8,
        auxiliary.width,
        auxiliary.height,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        auxiliary.pixels as Uint8Array<ArrayBuffer>,
      );
      gl.uniform1i(
        gl.getUniformLocation(this.program, this.kind === 'noise' ? 'uBack' : 'uUser'),
        1,
      );
    }
    if (this.kind === 'noise') {
      const noise = p as ArtemisNoiseUniforms;
      if (!Number.isFinite(noise.size)) throw Error('Missing noise uniforms');
      gl.uniform1f(gl.getUniformLocation(this.program, 'uSize'), noise.size);
    }
    if (
      this.kind === 'sepia' ||
      this.kind === 'sepia2' ||
      this.kind === 'rgb' ||
      this.kind === 'cadd' ||
      this.kind === 'cmul'
    ) {
      const color = p as ArtemisColorUniforms;
      if (
        ![color.red, color.green, color.blue].every(
          (x) => typeof x === 'number' && Number.isFinite(x),
        )
      )
        throw Error('Missing color uniforms');
      for (const [name, value] of [
        ['uRed', color.red!],
        ['uGreen', color.green!],
        ['uBlue', color.blue!],
      ] as const)
        gl.uniform1f(gl.getUniformLocation(this.program, name), value);
    }
    if (this.kind === 'blur_h' || this.kind === 'blur_v') {
      const blur = p as ArtemisBlurUniforms;
      if (
        !blur.weights ||
        blur.weights.length !== 8 ||
        ![blur.step, ...blur.weights].every(Number.isFinite)
      )
        throw Error('Missing blur uniforms');
      gl.uniform1fv(
        gl.getUniformLocation(this.program, 'uWeights[0]'),
        Float32Array.from(blur.weights),
      );
      gl.uniform1f(gl.getUniformLocation(this.program, 'uStep'), blur.step);
    }
    if (this.kind === 'radial') {
      const r = p as ArtemisRadialUniforms;
      if (![r.ax, r.ay, r.size, r.fade].every(Number.isFinite))
        throw Error('Missing radial uniforms');
      for (const [name, value] of [
        ['uAx', r.ax],
        ['uAy', r.ay],
        ['uSize', r.size],
        ['uFade', r.fade],
      ] as const)
        gl.uniform1f(gl.getUniformLocation(this.program, name), value);
    }
    if (['add', 'mul', 'compbr', 'compbrc', 'compdk', 'compdkc'].includes(this.kind)) {
      const c = p as ArtemisCompositeUniforms;
      if (!Number.isFinite(c.param)) throw Error('Missing composite uniforms');
      gl.uniform1f(gl.getUniformLocation(this.program, 'uParam'), c.param);
    }
    if (this.kind === 'dimhole' || this.kind === 'dimring') {
      const d = p as ArtemisDimensionUniforms;
      if (![d.centerX, d.centerY, d.radius, d.ratio].every(Number.isFinite))
        throw Error('Missing dimension uniforms');
      for (const [name, value] of [
        ['uCenterX', d.centerX],
        ['uCenterY', d.centerY],
        ['uRadius', d.radius],
        ['uRatio', d.ratio],
      ] as const)
        gl.uniform1f(gl.getUniformLocation(this.program, name), value);
      if (this.kind === 'dimring') {
        if (!Number.isFinite(d.thick)) throw Error('Missing dimension ring thickness');
        gl.uniform1f(gl.getUniformLocation(this.program, 'uThick'), d.thick!);
      }
    }
    if (this.kind === 'mosaic') {
      const m = p as ArtemisMosaicUniforms;
      if (![m.size, m.ratio].every(Number.isFinite)) throw Error('Missing mosaic uniforms');
      gl.uniform1f(gl.getUniformLocation(this.program, 'uSize'), m.size);
      gl.uniform1f(gl.getUniformLocation(this.program, 'uRatio'), m.ratio);
    }
    if (isArtemisOffsetBlurKind(this.kind)) {
      const diagonal = p as ArtemisDiagonalBlurUniforms;
      if (![diagonal.offset, diagonal.size].every(Number.isFinite))
        throw Error('Missing diagonal blur uniforms');
      gl.uniform1f(gl.getUniformLocation(this.program, 'uOffset'), diagonal.offset);
      gl.uniform1f(gl.getUniformLocation(this.program, 'uSize'), diagonal.size);
    }
    if (this.kind.startsWith('perspective')) {
      const perspective = p as ArtemisPerspectiveUniforms;
      if (
        ![perspective.centerX, perspective.centerY, perspective.scale, perspective.fade].every(
          Number.isFinite,
        )
      )
        throw Error('Missing perspective uniforms');
      for (const [name, value] of [
        ['uCenterX', perspective.centerX],
        ['uCenterY', perspective.centerY],
        ['uScale', perspective.scale],
        ['uFade', perspective.fade],
      ] as const)
        gl.uniform1f(gl.getUniformLocation(this.program, name), value);
    }
    gl.viewport(0, 0, width, height);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.SCISSOR_TEST);
    gl.colorMask(true, true, true, true);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.gl.deleteTexture(this.texture);
    this.gl.deleteTexture(this.userTexture);
    this.gl.deleteVertexArray(this.vao);
    this.gl.deleteProgram(this.program);
  }
}

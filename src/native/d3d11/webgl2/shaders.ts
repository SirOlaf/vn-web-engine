import {linkSm4GlslPrograms, type Sm4GlslPipeline} from '../../../graphics/d3d11-shader/program.js';
import type {D3d11DeviceOwner} from '../runtime/com.js';
import {D3d11Buffer} from '../runtime/resources.js';
import {D3d11Shader} from '../runtime/shaders.js';

export interface D3d11ProgramSample {
  readonly resource: number;
  readonly sampler: number;
  readonly unit: number;
}
export interface D3d11LinkedProgram {
  readonly program: WebGLProgram;
  readonly attributes: Sm4GlslPipeline['attributes'];
  /** Input registers in attribute order. */
  readonly registers: readonly number[];
  readonly samples: readonly D3d11ProgramSample[];
  readonly targetHeight: WebGLUniformLocation | null;
}
interface ConstantUpload {
  readonly stage: 'vertex' | 'pixel';
  readonly slot: number;
  readonly location: WebGLUniformLocation;
  /** Words the program holds once `buffer` is set; `staged` is scratch of the same size. */
  words: Uint32Array;
  staged: Uint32Array;
  buffer: D3d11Buffer | null | undefined;
  revision: number;
}
interface Entry extends D3d11LinkedProgram {
  readonly vertex: D3d11Shader;
  readonly pixel: D3d11Shader;
  readonly variant: number;
  readonly constants: readonly ConstantUpload[];
  readonly outputRanges: readonly {
    readonly register: number;
    readonly location: WebGLUniformLocation | null;
  }[];
  outputMask: number;
}

/** Device-owned bounded program cache. Cached programs retain their native shader children. */
export class D3d11ProgramCache {
  private readonly entries = new Map<D3d11LinkedProgram, Entry>();
  private pairs = new WeakMap<D3d11Shader, WeakMap<D3d11Shader, Map<number, Entry>>>();
  private disposed = false;

  constructor(
    private readonly owner: D3d11DeviceOwner,
    private readonly gl: WebGL2RenderingContext,
    private readonly capacity = 128,
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 4096)
      throw new RangeError('Invalid D3D11 program cache capacity');
  }

  /**
   * Select an owned VS/PS pair and make its GPU program current. Alpha-only target
   * registers and pixel sample indices select a red-storage program variant;
   * reflected sample indices select row-reflected point views; unclipped depth
   * selects a constant position depth; unorm registers below 8 read raw B8G8R8A8
   * attributes.
   */
  use(
    vertex: D3d11Shader,
    pixel: D3d11Shader,
    alphaTargets = 0,
    alphaSamples = 0,
    reflectedSamples = 0,
    unclippedDepth = false,
    unormRegisters = 0,
  ): D3d11LinkedProgram {
    this.checkLive();
    for (const [shader, stage] of [
      [vertex, 'vertex'],
      [pixel, 'pixel'],
    ] as const)
      if (
        !shader.live ||
        shader.lifetime !== this.owner.lifetime ||
        shader.shader.code.stage !== stage
      )
        throw new Error('Invalid D3D11 shader pair');
    const outputs = pixel.shader.code.outputs.reduce((m, p) => m | (1 << p.register), 0),
      samples = (1 << Math.min(16, pixel.shader.code.samples.length)) - 1,
      variant =
        (alphaTargets & outputs) +
        (alphaSamples & samples) * 2 ** 8 +
        (reflectedSamples & samples) * 2 ** 24 +
        (unclippedDepth ? 2 ** 40 : 0) +
        (unormRegisters & 0xff) * 2 ** 41;
    const found = this.pairs.get(vertex)?.get(pixel)?.get(variant);
    if (found) {
      this.entries.delete(found);
      this.entries.set(found, found);
      this.gl.useProgram(found.program);
      return found;
    }
    const entry = this.compile(vertex, pixel, variant);
    vertex.retainBinding();
    pixel.retainBinding();
    this.entries.set(entry, entry);
    let pixels = this.pairs.get(vertex);
    if (!pixels) this.pairs.set(vertex, (pixels = new WeakMap()));
    let variants = pixels.get(pixel);
    if (!variants) pixels.set(pixel, (variants = new Map()));
    variants.set(variant, entry);
    if (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value!;
      this.entries.delete(oldest);
      this.retire(oldest as Entry);
    }
    this.gl.useProgram(entry.program);
    return entry;
  }

  /** Upload active raw DWORD arrays, zero-filling short and unbound native buffers. */
  uploadConstants(
    program: D3d11LinkedProgram,
    vertex: readonly (D3d11Buffer | null)[],
    pixel: readonly (D3d11Buffer | null)[],
  ): void {
    this.checkLive();
    const entry = this.entries.get(program);
    if (!entry) throw new Error('Using a retired or foreign D3D11 program');
    // Validate the entire set before changing GPU uniforms.
    for (const c of entry.constants) {
      const buffer = (c.stage === 'vertex' ? vertex : pixel)[c.slot] ?? null;
      if (
        buffer &&
        (!buffer.live ||
          buffer.lifetime !== this.owner.lifetime ||
          !(buffer.bindFlags & 4) ||
          buffer.levels[0]!.mapped)
      )
        throw new Error('Invalid D3D11 constant buffer');
    }
    this.gl.useProgram(entry.program);
    for (const c of entry.constants) {
      const buffer = (c.stage === 'vertex' ? vertex : pixel)[c.slot] ?? null;
      if (c.buffer === buffer && c.revision === (buffer?.revision ?? 0)) continue;
      const words = c.staged;
      words.fill(0);
      if (buffer) {
        const bytes = buffer.levels[0]!.bytes,
          count = Math.min(words.length, Math.floor(bytes.length / 4));
        // Aligned storage: the same little-endian words through a typed view.
        if ((bytes.byteOffset & 3) === 0)
          words.set(new Uint32Array(bytes.buffer, bytes.byteOffset, count));
        else {
          const view = new DataView(bytes.buffer, bytes.byteOffset, count * 4);
          for (let i = 0; i < count; i++) words[i] = view.getUint32(i * 4, true);
        }
      }
      // A rewritten buffer often holds the words the program already has.
      let same = c.buffer !== undefined;
      for (let i = 0; same && i < words.length; i++) same = words[i] === c.words[i];
      if (!same) {
        this.gl.uniform4uiv(c.location, words);
        c.staged = c.words;
        c.words = words;
      }
      c.buffer = buffer;
      c.revision = buffer?.revision ?? 0;
    }
  }

  /** Apply native format-dependent clamping without specializing the shader pair. */
  uploadOutputRanges(program: D3d11LinkedProgram, normalizedMask: number): void {
    this.checkLive();
    const entry = this.entries.get(program);
    if (!entry) throw new Error('Using a retired or foreign D3D11 program');
    if (entry.outputMask === normalizedMask) return;
    this.gl.useProgram(entry.program);
    for (const output of entry.outputRanges)
      this.gl.uniform1i(output.location, (normalizedMask >>> output.register) & 1);
    entry.outputMask = normalizedMask;
  }

  /** Release every program and retained child, including after a context loss. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const entries = [...this.entries.values()];
    this.entries.clear();
    this.pairs = new WeakMap();
    const errors: unknown[] = [];
    try {
      // GL defers deletion of the current program until it is no longer in use.
      const current = this.gl.getParameter(this.gl.CURRENT_PROGRAM);
      if (entries.some((entry) => entry.program === current)) this.gl.useProgram(null);
    } catch (error) {
      errors.push(error);
    }
    for (const entry of entries) {
      try {
        this.retire(entry);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, 'D3D11 GPU program disposal failed');
  }

  private checkLive(): void {
    if (this.disposed || this.owner.lifetime.closed)
      throw new Error('Using a released D3D11 program cache');
  }
  private retire(entry: Entry): void {
    const variants = this.pairs.get(entry.vertex)?.get(entry.pixel);
    variants?.delete(entry.variant);
    if (variants?.size === 0) this.pairs.get(entry.vertex)?.delete(entry.pixel);
    const errors: unknown[] = [];
    for (const dispose of [
      () => this.gl.deleteProgram(entry.program),
      () => entry.vertex.releaseBinding(),
      () => entry.pixel.releaseBinding(),
    ]) {
      try {
        dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, 'D3D11 GPU program release failed');
  }
  private compile(vertex: D3d11Shader, pixel: D3d11Shader, variant: number): Entry {
    const gl = this.gl,
      sources = linkSm4GlslPrograms(
        vertex.shader,
        pixel.shader,
        variant % 2 ** 8,
        Math.floor(variant / 2 ** 8) % 2 ** 16,
        Math.floor(variant / 2 ** 24) % 2 ** 16,
        Math.floor(variant / 2 ** 40) % 2 === 1,
        Math.floor(variant / 2 ** 41),
      );
    const samples = pixel.shader.code.samples;
    if (
      samples.length > gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS) ||
      samples.length > gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS)
    )
      throw new Error('D3D11 shader exceeds available texture units');
    const shaders: WebGLShader[] = [];
    let program: WebGLProgram | null = null;
    try {
      for (const [type, source] of [
        [gl.VERTEX_SHADER, sources.vertex],
        [gl.FRAGMENT_SHADER, sources.fragment],
      ] as const) {
        const shader = gl.createShader(type);
        if (!shader) throw new Error('D3D11 GPU shader allocation failed');
        shaders.push(shader);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
          throw new Error(`D3D11 GPU shader compilation failed: ${gl.getShaderInfoLog(shader)}`);
      }
      program = gl.createProgram();
      if (!program) throw new Error('D3D11 GPU program allocation failed');
      for (const shader of shaders) gl.attachShader(program, shader);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS))
        throw new Error(`D3D11 GPU program linkage failed: ${gl.getProgramInfoLog(program)}`);
      const active = new Map<string, number>();
      for (let i = 0; i < gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS); i++) {
        const info = gl.getActiveUniform(program, i)!;
        active.set(info.name.replace(/\[0\]$/, ''), info.size);
      }
      const constants: ConstantUpload[] = [];
      for (const shader of [vertex, pixel])
        for (const c of shader.shader.code.constantBuffers) {
          const vectors = active.get(c.uniform) ?? 0;
          if (!vectors) continue;
          const location = gl.getUniformLocation(program, c.uniform + '[0]');
          if (location === null || vectors > c.vectors)
            throw new Error('Invalid D3D11 GPU constant reflection');
          constants.push({
            stage: shader.shader.code.stage,
            slot: c.slot,
            location,
            words: new Uint32Array(vectors * 4),
            staged: new Uint32Array(vectors * 4),
            buffer: undefined,
            revision: -1,
          });
        }
      gl.useProgram(program);
      const bindings = samples.map((s, unit) => {
        const location = gl.getUniformLocation(program!, s.uniform);
        if (location !== null) gl.uniform1i(location, unit);
        return {
          resource: s.resource,
          sampler: s.sampler,
          unit,
        };
      });
      return {
        program,
        attributes: sources.attributes,
        registers: Object.freeze(sources.attributes.map((a) => a.register)),
        samples: bindings,
        targetHeight: gl.getUniformLocation(program, 'sm4_targetHeight'),
        vertex,
        pixel,
        variant,
        constants,
        outputRanges: [...new Set(pixel.shader.code.outputs.map((p) => p.register))].map(
          (register) => ({
            register,
            location: gl.getUniformLocation(program!, `sm4_target${register}_isUnorm`),
          }),
        ),
        outputMask: -1,
      };
    } catch (error) {
      if (program) gl.deleteProgram(program);
      throw error;
    } finally {
      for (const shader of shaders) gl.deleteShader(shader);
    }
  }
}

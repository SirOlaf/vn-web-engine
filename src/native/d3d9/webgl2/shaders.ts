import type {D3D9Shader} from '../../../graphics/d3d9-shader/bytecode.js';
import {
  POSITION_FIXUP_UNIFORM,
  SCREEN_FIXUP_UNIFORM,
  translateD3D9ProgramToGlsl,
  translateD3D9ShaderToGlsl,
  type D3D9GlslShader,
} from '../../../graphics/d3d9-shader/glsl.js';
import {
  ALPHA_REF_UNIFORM,
  FF_AMBIENT,
  FF_DEPTH,
  FF_SCREEN,
  FF_STAGE_CONSTANT,
  FF_TEXTURE_FACTOR,
  FF_WORLD_VIEW_PROJECTION,
  STANDARD_VARYINGS,
  ffSamplerName,
  fixedFragmentShader,
  fixedVertexShader,
  injectAlphaTest,
  type FixedFragmentKey,
  type FixedVertexKey,
} from './fixed-function.js';
import {GL} from './gl.js';
import {Usage} from './fvf.js';
import {VERTEX_SAMPLER_UNIT_BASE} from './state.js';

/** A created vertex or pixel shader: parsed bytecode plus a device-wide id for caching. */
export class ShaderObject {
  private references = 1;
  private static nextId = 1;
  readonly id = ShaderObject.nextId++;

  constructor(
    readonly shader: D3D9Shader,
    private readonly destroyed: (shader: ShaderObject) => void,
  ) {}

  get stage(): 'vertex' | 'pixel' {
    return this.shader.version.stage;
  }

  addRef(): number {
    return ++this.references;
  }

  release(): number {
    if (this.references === 0) return 0;
    const count = --this.references;
    if (count === 0) this.destroyed(this);
    return count;
  }
}

export interface ProgramAttribute {
  readonly name: string;
  readonly usage: number;
  readonly usageIndex: number;
  readonly location: number;
}

/** A linked program with its interface. */
export interface LinkedProgram {
  readonly key: string;
  readonly program: WebGLProgram;
  readonly attributes: readonly ProgramAttribute[];
  readonly uniforms: ReadonlyMap<string, WebGLUniformLocation>;
  /** Float registers to upload per stage (0 when the stage is fixed function). */
  readonly vertexFloatCount: number;
  readonly pixelFloatCount: number;
  readonly vertexShaderId: number;
  readonly pixelShaderId: number;
  /** Last uploaded constant versions (uploads are skipped when unchanged). */
  vertexConstantVersion: number;
  pixelConstantVersion: number;
}

export interface ProgramRequest {
  readonly vertexShader: ShaderObject | null;
  readonly pixelShader: ShaderObject | null;
  /** Fixed-function vertex state (used when `vertexShader` is null). */
  readonly fixedVertex: Omit<FixedVertexKey, 'extraOutputs' | 'centroid'> | null;
  /** Fixed-function pixel state (used when `pixelShader` is null). */
  readonly fixedFragment: Omit<FixedFragmentKey, 'available'> | null;
  /** D3DCMP alpha function, or 8 (ALWAYS) when the test is disabled. */
  readonly alphaFunc: number;
}

export interface ProgramSources {
  readonly vertex: string;
  readonly fragment: string;
  readonly attributes: readonly {name: string; usage: number; usageIndex: number}[];
  readonly vertexFloatCount: number;
  readonly pixelFloatCount: number;
  /** Sampler uniform → texture unit. */
  readonly samplers: readonly {name: string; unit: number}[];
}

function translatedAttributes(shader: D3D9GlslShader) {
  return shader.attributes.map((a) => ({name: a.name, usage: a.usage, usageIndex: a.usageIndex}));
}

function samplerUnits(shader: D3D9GlslShader): {name: string; unit: number}[] {
  return shader.samplers.map((s) => ({
    name: s.name,
    unit: shader.stage === 'vertex' ? VERTEX_SAMPLER_UNIT_BASE + s.register : s.register,
  }));
}

function fixedAttributes(key: Omit<FixedVertexKey, 'extraOutputs' | 'centroid'>) {
  const list: {name: string; usage: number; usageIndex: number}[] = [
    key.pretransformed
      ? {name: 'a_positiont0', usage: Usage.POSITIONT, usageIndex: 0}
      : {name: 'a_position0', usage: Usage.POSITION, usageIndex: 0},
  ];
  if (key.diffuse) list.push({name: 'a_color0', usage: Usage.COLOR, usageIndex: 0});
  if (key.specular) list.push({name: 'a_color1', usage: Usage.COLOR, usageIndex: 1});
  for (let i = 0; i < key.textureSets; i++)
    list.push({name: `a_texcoord${i}`, usage: Usage.TEXCOORD, usageIndex: i});
  return list;
}

/**
 * GLSL for a vertex/pixel combination. Either half may be fixed function; translated halves
 * follow the translator's naming, so the fixed-function half matches their varyings.
 */
export function programSources(request: ProgramRequest): ProgramSources {
  const {vertexShader: vs, pixelShader: ps} = request;
  let vertex: string, fragment: string;
  let attributes: {name: string; usage: number; usageIndex: number}[];
  let vertexFloatCount = 0,
    pixelFloatCount = 0;
  const samplers: {name: string; unit: number}[] = [];
  if (vs && ps) {
    const pair = translateD3D9ProgramToGlsl(vs.shader, ps.shader);
    vertex = pair.vertex.source;
    fragment = injectAlphaTest(pair.fragment.source, request.alphaFunc);
    attributes = translatedAttributes(pair.vertex);
    vertexFloatCount = pair.vertex.floatConstants?.count ?? 0;
    pixelFloatCount = pair.fragment.floatConstants?.count ?? 0;
    samplers.push(...samplerUnits(pair.vertex), ...samplerUnits(pair.fragment));
  } else if (vs) {
    const translated = translateD3D9ShaderToGlsl(vs.shader);
    vertex = translated.source;
    attributes = translatedAttributes(translated);
    vertexFloatCount = translated.floatConstants?.count ?? 0;
    samplers.push(...samplerUnits(translated));
    const fixed = request.fixedFragment!;
    fragment = fixedFragmentShader(
      {...fixed, available: translated.outputs.map((o) => o.name)},
      request.alphaFunc,
    );
  } else if (ps) {
    const translated = translateD3D9ShaderToGlsl(ps.shader);
    fragment = injectAlphaTest(translated.source, request.alphaFunc);
    pixelFloatCount = translated.floatConstants?.count ?? 0;
    samplers.push(...samplerUnits(translated));
    const fixed = request.fixedVertex!;
    const linked = translated.inputs.filter((i) => i.linked);
    vertex = fixedVertexShader({
      ...fixed,
      extraOutputs: linked.map((i) => i.name).filter((n) => !STANDARD_VARYINGS.includes(n)),
      centroid: linked.filter((i) => i.centroid).map((i) => i.name),
    });
    attributes = fixedAttributes(fixed);
  } else {
    const fixedV = request.fixedVertex!;
    vertex = fixedVertexShader({...fixedV, extraOutputs: [], centroid: []});
    fragment = fixedFragmentShader(
      {...request.fixedFragment!, available: STANDARD_VARYINGS},
      request.alphaFunc,
    );
    attributes = fixedAttributes(fixedV);
  }
  if (!ps)
    request.fixedFragment!.stages.forEach((stage, index) => {
      if (stage.texture) samplers.push({name: ffSamplerName(index), unit: index});
    });
  return {vertex, fragment, attributes, vertexFloatCount, pixelFloatCount, samplers};
}

/** Cache key for a program request. Shaders are keyed by id, fixed function by state. */
export function programKey(request: ProgramRequest): string {
  return JSON.stringify([
    request.vertexShader?.id ?? 0,
    request.pixelShader?.id ?? 0,
    request.vertexShader ? null : request.fixedVertex,
    request.pixelShader ? null : request.fixedFragment,
    request.alphaFunc,
  ]);
}

const uniformNames = [
  POSITION_FIXUP_UNIFORM,
  SCREEN_FIXUP_UNIFORM,
  'vs_c',
  'ps_c',
  FF_WORLD_VIEW_PROJECTION,
  FF_SCREEN,
  FF_DEPTH,
  FF_AMBIENT,
  FF_TEXTURE_FACTOR,
  FF_STAGE_CONSTANT,
  ALPHA_REF_UNIFORM,
];

export class ShaderCompileError extends Error {}

/** Compiles and links `sources`; attributes get consecutive locations by declaration order. */
export function linkProgram(
  gl: WebGL2RenderingContext,
  key: string,
  sources: ProgramSources,
  ids: {vertex: number; pixel: number},
): LinkedProgram {
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type);
    if (!shader) throw new ShaderCompileError('createShader failed');
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, GL.COMPILE_STATUS) && !gl.isContextLost()) {
      const log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new ShaderCompileError(
        `D3D9 ${type === GL.VERTEX_SHADER ? 'vertex' : 'fragment'} shader: ${log}`,
      );
    }
    return shader;
  };
  const vertex = compile(GL.VERTEX_SHADER, sources.vertex);
  const fragment = compile(GL.FRAGMENT_SHADER, sources.fragment);
  const program = gl.createProgram();
  if (!program) throw new ShaderCompileError('createProgram failed');
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  const attributes = sources.attributes.map((a, location) => {
    gl.bindAttribLocation(program, location, a.name);
    return {...a, location};
  });
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, GL.LINK_STATUS) && !gl.isContextLost()) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new ShaderCompileError(`D3D9 program link: ${log}`);
  }
  const uniforms = new Map<string, WebGLUniformLocation>();
  for (const name of [...uniformNames, ...sources.samplers.map((s) => s.name)]) {
    const location = gl.getUniformLocation(program, name);
    if (location !== null) uniforms.set(name, location);
  }
  gl.useProgram(program);
  for (const sampler of sources.samplers) {
    const location = uniforms.get(sampler.name);
    if (location) gl.uniform1i(location, sampler.unit);
  }
  return {
    key,
    program,
    attributes,
    uniforms,
    vertexFloatCount: sources.vertexFloatCount,
    pixelFloatCount: sources.pixelFloatCount,
    vertexShaderId: ids.vertex,
    pixelShaderId: ids.pixel,
    vertexConstantVersion: -1,
    pixelConstantVersion: -1,
  };
}

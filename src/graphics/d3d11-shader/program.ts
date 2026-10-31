import {parseSm4Program} from './bytecode.js';
import {parseDxbcContainer} from './container.js';
import {translateSm4ToGlsl, type Sm4GlslIo, type Sm4GlslProgram} from './glsl.js';
import {parseSm4Signature, type Sm4SignatureParameter} from './signature.js';

/** Immutable executable plan and the container's native stage interfaces. */
export interface Sm4GlslShader {
  readonly code: Sm4GlslProgram;
  readonly inputs: readonly Sm4SignatureParameter[];
  readonly outputs: readonly Sm4SignatureParameter[];
}

export class Sm4ShaderError extends Error {
  constructor(
    message: string,
    readonly unsupported = false,
  ) {
    super(message);
  }
}
function invalid(message: string): never {
  throw new Sm4ShaderError(`Invalid SM4 shader interface: ${message}`);
}
function unsupported(message: string): never {
  throw new Sm4ShaderError(`Unsupported SM4 shader interface: ${message}`, true);
}
const channels = 'xyzw';
const components = (mask: number): string =>
  [...channels].filter((_, i) => mask & (1 << i)).join('');
const upper = (s: string): string => s.replace(/[a-z]/g, (c) => c.toUpperCase());
const union = (io: readonly Sm4GlslIo[], register: number): number =>
  io.filter((p) => p.register === register).reduce((mask, p) => mask | p.mask, 0);

/** Parse, validate and own the float-register SM4 subset before native shader creation. */
export function parseSm4GlslShader(bytes: Uint8Array, stage: 'vertex' | 'pixel'): Sm4GlslShader {
  const parts = parseDxbcContainer(bytes).parts;
  const part = (kind: string): Uint8Array => {
    const found = parts.filter((p) => p.kind === kind);
    if (found.length !== 1) invalid(`expected one ${kind} part`);
    return found[0]!.data;
  };
  const program = parseSm4Program(part('SHDR'));
  if (program.stage !== stage) invalid('stage mismatch');
  const code = translateSm4ToGlsl(program),
    inputs = parseSm4Signature(part('ISGN')),
    outputs = parseSm4Signature(part('OSGN'));
  for (const [signature, declarations, output] of [
    [inputs, code.inputs, false],
    [outputs, code.outputs, true],
  ] as const) {
    const occupied = new Map<number, number>(),
      names = new Set<string>();
    for (const p of signature) {
      if (p.register >= 32 || p.componentType !== 3) unsupported('non-float or special register');
      const name = `${upper(p.semanticName)}:${p.semanticIndex}`;
      if (!p.semanticName || names.has(name) || !p.mask || (occupied.get(p.register) ?? 0) & p.mask)
        invalid('duplicate or empty signature element');
      names.add(name);
      occupied.set(p.register, (occupied.get(p.register) ?? 0) | p.mask);
      const used = output ? p.mask & ~p.readWriteMask : p.mask & p.readWriteMask;
      if (used & ~union(declarations, p.register))
        invalid('used signature components lack declarations');
      Object.freeze(p);
    }
    for (const d of declarations) {
      const coverage = signature
        .filter((p) => p.register === d.register && p.systemValue === d.systemValue)
        .reduce((mask, p) => mask | p.mask, 0);
      if (d.mask & ~coverage) invalid('declaration disagrees with signature');
    }
    Object.freeze(signature);
  }
  for (const list of [code.inputs, code.outputs, code.constantBuffers, code.samples]) {
    for (const value of list) Object.freeze(value);
    Object.freeze(list);
  }
  return Object.freeze({code: Object.freeze(code), inputs, outputs});
}

export interface Sm4GlslPipeline {
  readonly vertex: string;
  readonly fragment: string;
  readonly attributes: readonly {
    readonly name: string;
    readonly register: number;
    readonly location: number;
  }[];
}

/**
 * Link native register locations, never relocate by semantic. Render targets keep
 * native top at the GL top, preserving clip-space raster orientation. Texture
 * storage and presentation account for their own logical row origins. Alpha-only
 * targets and pixel samples (bit masks by register and sample index) use red
 * storage. Reflected samples read point/clamp views of GL-row-ordered storage at
 * the center of the native texel row instead of a row-reflected copy. Unclipped
 * depth replaces the position depth with 0, inside every clip volume, for draws
 * whose depth is never tested or written: X/Y/W clipping and interpolation keep
 * their native values, which matches disabled depth clipping without
 * `EXT_depth_clamp`. Other programs preprocess to the unchanged token stream.
 */
export function linkSm4GlslPrograms(
  vertex: Sm4GlslShader,
  pixel: Sm4GlslShader,
  alphaTargets = 0,
  alphaSamples = 0,
  reflectedSamples = 0,
  unclippedDepth = false,
): Sm4GlslPipeline {
  if (vertex.code.stage !== 'vertex' || pixel.code.stage !== 'pixel') invalid('pipeline stages');
  const positions = vertex.code.outputs.filter((p) => p.systemValue === 1);
  if (positions.length !== 1 || positions[0]!.mask !== 15) unsupported('vertex position output');
  if (
    vertex.code.inputs.some((p) => p.systemValue) ||
    vertex.code.outputs.some((p) => p.systemValue > 1)
  )
    unsupported('vertex system values');
  if (pixel.code.outputs.some((p) => p.systemValue || p.register >= 8)) unsupported('pixel output');
  for (const p of pixel.outputs)
    if (upper(p.semanticName) !== 'SV_TARGET' || p.semanticIndex !== p.register)
      unsupported('non-target pixel output');

  // The runtime's linkage is positional; semantic matching validates it, rather
  // than providing a way to silently repair mismatched compiled shaders.
  for (const p of pixel.inputs) {
    if ((p.mask & p.readWriteMask) === 0) continue;
    const found = vertex.outputs.find(
      (v) =>
        v.register === p.register &&
        upper(v.semanticName) === upper(p.semanticName) &&
        v.semanticIndex === p.semanticIndex &&
        v.componentType === p.componentType &&
        v.systemValue === p.systemValue &&
        (p.mask & ~v.mask) === 0,
    );
    if (!found) invalid('incompatible vertex/pixel signatures');
  }
  const version = '#version 300 es\nprecision highp float;\nprecision highp int;';
  const vs: string[] = [version, vertex.code.source],
    ps: string[] = [
      version,
      ...pixel.code.samples
        .filter((_, i) => (alphaSamples >>> i) & 1)
        .map((s) => `#define ${s.uniform}_view(t) vec4(0.0, 0.0, 0.0, (t).x)`),
      ...pixel.code.samples
        .filter((_, i) => (reflectedSamples >>> i) & 1)
        .map((s) => {
          // Native row floor(v*h), clamped, read at its storage row center.
          const h = `float(textureSize(${s.uniform}, 0).y)`;
          return `#define ${s.uniform}_coord(c) vec2((c).x, (${h} - 0.5 - clamp(floor((c).y * ${h}), 0.0, ${h} - 1.0)) / ${h})`;
        }),
      pixel.code.source,
    ];
  const body = (code: Sm4GlslProgram): string[] => [
    `uvec4 inputs[${code.inputRegisters}], outputs[${code.outputRegisters}];`,
    `for(int i=0;i<${code.inputRegisters};i++) inputs[i]=uvec4(0u);`,
  ];
  const vertexBody = body(vertex.code),
    pixelBody = body(pixel.code);
  const registers = [...new Set(vertex.code.inputs.map((p) => p.register))];
  if (registers.length > 16) unsupported('more than16vertex attributes');
  const attributes = registers.map((register, location) => ({
    name: `sm4_a${register}`,
    register,
    location,
  }));
  for (const a of attributes) {
    vs.push(`layout(location=${a.location}) in highp vec4 ${a.name};`);
    vertexBody.push(`inputs[${a.register}]=floatBitsToUint(${a.name});`);
  }
  vertexBody.push(`${vertex.code.entry}(inputs,outputs);`);
  vertexBody.push(`vec4 position=uintBitsToFloat(outputs[${positions[0]!.register}]);`);
  vertexBody.push(
    unclippedDepth
      ? 'gl_Position=vec4(position.xy,0.0,position.w);'
      : 'gl_Position=vec4(position.xy,2.0*position.z-position.w,position.w);',
  );
  vertexBody.push('gl_PointSize=1.0;');
  if (pixel.code.inputs.some((p) => p.systemValue === 1))
    ps.push('uniform highp float sm4_targetHeight;');
  for (const p of pixel.code.inputs) {
    const swizzle = components(p.mask);
    if (p.systemValue === 1) {
      if (![4, 5].includes(p.interpolation)) unsupported('position interpolation');
      if (unclippedDepth && p.mask & 4) unsupported('pixel depth with unclipped depth');
      pixelBody.push(
        `inputs[${p.register}].${swizzle}=floatBitsToUint(vec4(gl_FragCoord.x,sm4_targetHeight-gl_FragCoord.y,gl_FragCoord.zw).${swizzle});`,
      );
      continue;
    }
    if (p.systemValue || ![2, 3].includes(p.interpolation))
      unsupported('pixel interpolation or system value');
    if (
      p.mask &
      ~union(
        vertex.code.outputs.filter((v) => v.systemValue === 0),
        p.register,
      )
    )
      invalid('pixel input components lack vertex outputs');
    const name = `sm4_link_${p.register}_${p.mask}`,
      type = swizzle.length === 1 ? 'float' : `vec${swizzle.length}`,
      qualifier = p.interpolation === 3 ? 'centroid ' : '';
    vs.push(`${qualifier}out highp ${type} ${name};`);
    ps.push(`${qualifier}in highp ${type} ${name};`);
    vertexBody.push(`${name}=uintBitsToFloat(outputs[${p.register}].${swizzle});`);
    pixelBody.push(`inputs[${p.register}].${swizzle}=floatBitsToUint(${name});`);
  }
  pixelBody.push(`${pixel.code.entry}(inputs,outputs);`);
  for (const r of [...new Set(pixel.code.outputs.map((p) => p.register))]) {
    ps.push(`layout(location=${r}) out highp vec4 sm4_target${r};`);
    ps.push(`uniform bool sm4_target${r}_isUnorm;`);
    pixelBody.push(`sm4_target${r}=uintBitsToFloat(outputs[${r}]);`);
    // D3D11 output-merger inputs are clamped to the current target's range.
    // The target format is draw state, independent of the VS/PS program pair.
    pixelBody.push(`if(sm4_target${r}_isUnorm)sm4_target${r}=clamp(sm4_target${r},0.0,1.0);`);
    if ((alphaTargets >>> r) & 1) pixelBody.push(`sm4_target${r}.x=sm4_target${r}.w;`);
  }
  vs.push('void main(){', ...vertexBody, '}');
  ps.push('void main(){', ...pixelBody, '}');
  return {vertex: vs.join('\n'), fragment: ps.join('\n'), attributes};
}

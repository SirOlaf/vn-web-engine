import {POSITION_FIXUP_UNIFORM} from '../../../graphics/d3d9-shader/glsl.js';
import {TA, TOP} from './state.js';

/**
 * GLSL ES 3.00 generation for the Direct3D 9 fixed-function pipeline: vertex transform
 * (WORLD·VIEW·PROJECTION, or pretransformed XYZRHW screen positions), material colour sources
 * with no lights, and the texture-stage combiner. Inputs and outputs follow the shader
 * translator's binding contract (`a_<usage><n>`, `v_color<n>`, `v_texcoord<n>`, `dx_oC0`,
 * `dx_posFixup`), so either half can pair with a translated shader.
 *
 * Varyings are named by what they carry: `v_color0` diffuse, `v_color1` specular,
 * `v_texcoord<n>` the coordinates of texture stage n.
 */

export const FF_WORLD_VIEW_PROJECTION = 'ff_worldViewProj';
/** (viewport x, viewport y, 2 / width, 2 / height) for pretransformed vertices. */
export const FF_SCREEN = 'ff_screen';
/** (minZ, 1 / (maxZ - minZ)) for pretransformed vertices. */
export const FF_DEPTH = 'ff_depth';
export const FF_AMBIENT = 'ff_ambient';
export const FF_TEXTURE_FACTOR = 'ff_tfactor';
export const FF_STAGE_CONSTANT = 'ff_stageConstant';
export const ALPHA_REF_UNIFORM = 'dx_alphaRef';
export const ffSamplerName = (stage: number): string => `ff_s${stage}`;

export const STANDARD_VARYINGS: readonly string[] = [
  'v_color0',
  'v_color1',
  ...Array.from({length: 8}, (_, i) => `v_texcoord${i}`),
];

export interface FixedVertexKey {
  readonly pretransformed: boolean;
  /** Floats in the position element (3 for XYZ, 4 for XYZW/XYZRHW). */
  readonly positionComponents: number;
  readonly diffuse: boolean;
  readonly specular: boolean;
  /** Number of texture-coordinate sets in the vertex. */
  readonly textureSets: number;
  /** Texture-coordinate set used by each of the 8 stages (`TEXCOORDINDEX & 0xffff`). */
  readonly texCoordIndex: readonly number[];
  /** Lighting (only for untransformed vertices) with no lights: emissive + ambient terms. */
  readonly lighting: boolean;
  /** D3DMCS_* for diffuse, ambient, emissive (0 when COLORVERTEX is FALSE). */
  readonly diffuseSource: number;
  readonly ambientSource: number;
  readonly emissiveSource: number;
  /** Varyings beyond the standard set that the pixel shader reads (written as zero). */
  readonly extraOutputs: readonly string[];
  /** Varyings the pixel shader declares `centroid`. */
  readonly centroid: readonly string[];
}

export interface FixedStage {
  readonly colorOp: number;
  readonly colorArgs: readonly [number, number, number];
  readonly alphaOp: number;
  readonly alphaArgs: readonly [number, number, number];
  readonly resultArg: number;
  readonly texture: boolean;
}

export interface FixedFragmentKey {
  /** Active stages, up to the first COLOROP DISABLE. */
  readonly stages: readonly FixedStage[];
  readonly specular: boolean;
  /** Varyings the vertex half writes; others read vec4(0). */
  readonly available: readonly string[];
}

const header = '#version 300 es\nprecision highp float;\nprecision highp int;\n';

export function fixedVertexShader(key: FixedVertexKey): string {
  const lines = [header.trimEnd()];
  const position = key.pretransformed ? 'a_positiont0' : 'a_position0';
  lines.push(`in vec4 ${position};`);
  if (key.diffuse) lines.push('in vec4 a_color0;');
  if (key.specular) lines.push('in vec4 a_color1;');
  for (let i = 0; i < key.textureSets; i++) lines.push(`in vec4 a_texcoord${i};`);
  lines.push(
    `uniform mat4 ${FF_WORLD_VIEW_PROJECTION};`,
    `uniform vec4 ${FF_SCREEN};`,
    `uniform vec2 ${FF_DEPTH};`,
    `uniform vec4 ${FF_AMBIENT};`,
    `uniform vec4 ${POSITION_FIXUP_UNIFORM};`,
  );
  const centroid = new Set(key.centroid);
  const outputs = [...new Set([...STANDARD_VARYINGS, ...key.extraOutputs])];
  for (const name of outputs)
    lines.push(`${centroid.has(name) ? 'centroid ' : ''}out vec4 ${name};`);
  const body: string[] = [];
  if (key.pretransformed) {
    // Screen-space x, y (render-target pixels), z in [0, 1] and RHW: undo the viewport
    // transform and keep 1/RHW as w so interpolation stays perspective-correct.
    body.push(
      `float w = ${position}.w == 0.0 ? 1.0 : 1.0 / ${position}.w;`,
      `vec4 p = vec4(((${position}.x - ${FF_SCREEN}.x) * ${FF_SCREEN}.z - 1.0) * w, ` +
        `(1.0 - (${position}.y - ${FF_SCREEN}.y) * ${FF_SCREEN}.w) * w, ` +
        `(${position}.z - ${FF_DEPTH}.x) * ${FF_DEPTH}.y * w, w);`,
    );
  } else {
    const source = key.positionComponents === 4 ? position : `vec4(${position}.xyz, 1.0)`;
    body.push(`vec4 p = ${FF_WORLD_VIEW_PROJECTION} * ${source};`);
  }
  const f = POSITION_FIXUP_UNIFORM;
  body.push(
    `gl_Position = vec4(p.x * ${f}.x + ${f}.z * p.w, p.y * ${f}.y + ${f}.w * p.w, p.z * 2.0 - p.w, p.w);`,
    `vec4 diffuse = ${key.diffuse ? 'a_color0' : 'vec4(1.0)'};`,
    `vec4 specular = ${key.specular ? 'a_color1' : 'vec4(0.0)'};`,
  );
  if (key.lighting && !key.pretransformed) {
    // No lights can be set through this device, and the material is all zero, so a lit
    // vertex is emissive + ambient·ambient-material with the diffuse source's alpha.
    const source = (mcs: number) => (mcs === 1 ? 'diffuse' : mcs === 2 ? 'specular' : 'vec4(0.0)');
    body.push(
      `v_color0 = vec4(clamp(${FF_AMBIENT}.rgb * ${source(key.ambientSource)}.rgb + ${source(key.emissiveSource)}.rgb, 0.0, 1.0), ${source(key.diffuseSource)}.a);`,
      'v_color1 = vec4(0.0);',
    );
  } else body.push('v_color0 = diffuse;', 'v_color1 = specular;');
  for (let stage = 0; stage < 8; stage++) {
    const set = key.texCoordIndex[stage] ?? stage;
    body.push(
      `v_texcoord${stage} = ${set < key.textureSets ? `a_texcoord${set}` : 'vec4(0.0, 0.0, 0.0, 1.0)'};`,
    );
  }
  for (const name of outputs)
    if (!STANDARD_VARYINGS.includes(name)) body.push(`${name} = vec4(0.0);`);
  lines.push('void main() {', ...body.map((l) => `  ${l}`), '}');
  return lines.join('\n') + '\n';
}

function argument(selector: number, stage: number): string {
  let value: string;
  switch (selector & TA.SELECTMASK) {
    case TA.DIFFUSE:
      value = 'diffuse';
      break;
    case TA.CURRENT:
      value = 'current';
      break;
    case TA.TEXTURE:
      value = 'tex';
      break;
    case TA.TFACTOR:
      value = FF_TEXTURE_FACTOR;
      break;
    case TA.SPECULAR:
      value = 'specular';
      break;
    case TA.TEMP:
      value = 'temp';
      break;
    case TA.CONSTANT:
      value = `${FF_STAGE_CONSTANT}[${stage}]`;
      break;
    default:
      value = 'vec4(0.0)';
  }
  if (selector & TA.COMPLEMENT) value = `(vec4(1.0) - ${value})`;
  if (selector & TA.ALPHAREPLICATE) value = `vec4(${value}.a)`;
  return value;
}

/** One combiner operation on component `c` ('.rgb' or '.a'); args are vec4 expressions. */
function operation(op: number, a: readonly [string, string, string], c: string): string | null {
  const [a0, a1, a2] = a.map((x) => `${x}${c}`) as [string, string, string];
  const one = c === '.a' ? '1.0' : 'vec3(1.0)';
  switch (op) {
    case TOP.SELECTARG1:
      return a1;
    case TOP.SELECTARG2:
      return a2;
    case TOP.MODULATE:
      return `${a1} * ${a2}`;
    case TOP.MODULATE2X:
      return `${a1} * ${a2} * 2.0`;
    case TOP.MODULATE4X:
      return `${a1} * ${a2} * 4.0`;
    case TOP.ADD:
      return `${a1} + ${a2}`;
    case TOP.ADDSIGNED:
      return `${a1} + ${a2} - 0.5`;
    case TOP.ADDSIGNED2X:
      return `(${a1} + ${a2} - 0.5) * 2.0`;
    case TOP.SUBTRACT:
      return `${a1} - ${a2}`;
    case TOP.ADDSMOOTH:
      return `${a1} + ${a2} - ${a1} * ${a2}`;
    case TOP.BLENDDIFFUSEALPHA:
      return `mix(${a2}, ${a1}, diffuse.a)`;
    case TOP.BLENDTEXTUREALPHA:
      return `mix(${a2}, ${a1}, tex.a)`;
    case TOP.BLENDFACTORALPHA:
      return `mix(${a2}, ${a1}, ${FF_TEXTURE_FACTOR}.a)`;
    case TOP.BLENDTEXTUREALPHAPM:
      return `${a1} + ${a2} * (1.0 - tex.a)`;
    case TOP.BLENDCURRENTALPHA:
      return `mix(${a2}, ${a1}, current.a)`;
    case TOP.MODULATEALPHA_ADDCOLOR:
      return c === '.a' ? null : `${a1} + ${a.at(1)}.a * ${a2}`;
    case TOP.MODULATECOLOR_ADDALPHA:
      return c === '.a' ? null : `${a1} * ${a2} + ${a.at(1)}.a`;
    case TOP.MODULATEINVALPHA_ADDCOLOR:
      return c === '.a' ? null : `(1.0 - ${a.at(1)}.a) * ${a2} + ${a1}`;
    case TOP.MODULATEINVCOLOR_ADDALPHA:
      return c === '.a' ? null : `(${one} - ${a1}) * ${a2} + ${a.at(1)}.a`;
    case TOP.DOTPRODUCT3:
      return `${c === '.a' ? '' : 'vec3'}(dot((${a.at(1)}.rgb - 0.5) * 2.0, (${a.at(2)}.rgb - 0.5) * 2.0))`;
    case TOP.MULTIPLYADD:
      return `${a0} + ${a1} * ${a2}`;
    case TOP.LERP:
      return `mix(${a2}, ${a1}, ${a0})`;
    default:
      // PREMODULATE and the bump-mapping operations have no WebGL counterpart here.
      return null;
  }
}

export function fixedFragmentShader(key: FixedFragmentKey, alphaFunc: number): string {
  const available = new Set(key.available);
  const lines = [header.trimEnd()];
  const input = (name: string): string => {
    if (available.has(name)) {
      lines.push(`in vec4 ${name};`);
      return name;
    }
    return 'vec4(0.0)';
  };
  const color0 = input('v_color0');
  const color1 = input('v_color1');
  const body = [
    `vec4 diffuse = ${color0};`,
    `vec4 specular = ${color1};`,
    'vec4 current = diffuse;',
    'vec4 temp = vec4(0.0);',
    'vec4 tex = vec4(1.0);',
  ];
  lines.push(`uniform vec4 ${FF_TEXTURE_FACTOR};`, `uniform vec4 ${FF_STAGE_CONSTANT}[8];`);
  key.stages.forEach((stage, index) => {
    if (stage.texture) {
      const coord = input(`v_texcoord${index}`);
      lines.push(`uniform sampler2D ${ffSamplerName(index)};`);
      body.push(`tex = texture(${ffSamplerName(index)}, ${coord}.xy);`);
    } else body.push('tex = vec4(1.0);');
    const colorArgs = stage.colorArgs.map((s) => argument(s, index)) as [string, string, string];
    const alphaArgs = stage.alphaArgs.map((s) => argument(s, index)) as [string, string, string];
    const rgb = operation(stage.colorOp, colorArgs, '.rgb') ?? 'current.rgb';
    let alpha =
      stage.alphaOp === TOP.DISABLE
        ? 'current.a'
        : (operation(stage.alphaOp, alphaArgs, '.a') ?? 'current.a');
    if (stage.colorOp === TOP.DOTPRODUCT3) alpha = `(${rgb}).r`;
    const target = (stage.resultArg & TA.SELECTMASK) === TA.TEMP ? 'temp' : 'current';
    body.push(`${target} = clamp(vec4(${rgb}, ${alpha}), 0.0, 1.0);`);
  });
  body.push('vec4 color = current;');
  if (key.specular) body.push('color.rgb = clamp(color.rgb + specular.rgb, 0.0, 1.0);');
  const test = alphaTestStatements('color.a', alphaFunc);
  if (test.length > 0) lines.push(`uniform float ${ALPHA_REF_UNIFORM};`);
  body.push(...test, 'dx_oC0 = color;');
  lines.push('layout(location = 0) out vec4 dx_oC0;');
  lines.push('void main() {', ...body.map((l) => `  ${l}`), '}');
  return lines.join('\n') + '\n';
}

const alphaComparisons = ['', 'false', '<', '==', '<=', '>', '!=', '>=', ''];

/**
 * The alpha test as GLSL statements. Alpha is quantized to 8 bits and compared with
 * ALPHAREF (0-255), as Direct3D 9 compares the fixed-point fragment alpha. ALWAYS (and
 * invalid functions) produce no code.
 */
export function alphaTestStatements(alpha: string, func: number): string[] {
  const comparison = alphaComparisons[func] ?? '';
  if (comparison === '') return [];
  if (comparison === 'false') return ['discard;'];
  return [
    `if (!(floor(clamp(${alpha}, 0.0, 1.0) * 255.0 + 0.5) ${comparison} ${ALPHA_REF_UNIFORM})) discard;`,
  ];
}

/**
 * Adds the alpha test to a translated pixel shader: the test runs at the end of `main`, after
 * `dx_oC0` is written. Returns the source unchanged for ALWAYS or a shader without `oC0`.
 */
export function injectAlphaTest(source: string, func: number): string {
  const statements = alphaTestStatements('dx_oC0.a', func);
  if (statements.length === 0 || !source.includes('out vec4 dx_oC0;')) return source;
  const end = source.lastIndexOf('}');
  if (end < 0) return source;
  const declaration = `uniform float ${ALPHA_REF_UNIFORM};\n`;
  const main = source.lastIndexOf('void main() {');
  return (
    source.slice(0, main) +
    declaration +
    source.slice(main, end) +
    statements.map((s) => `  ${s}\n`).join('') +
    source.slice(end)
  );
}

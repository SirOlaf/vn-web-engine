import {ArtemisShaderConstantStorage, type ArtemisShaderConstant} from './shader-properties.js';
import {artemisRevision} from './revision.js';
import {
  ArtemisDx9EffectConstants,
  artemisDx9BlurMode,
  artemisDx9ShaderFragmentSource,
  type ArtemisDx9ShaderKind,
} from './dx9-shader.js';
import type {ArtemisShaderTextureLease} from './shader-properties.js';
import {
  compileArtemisShaderPreset,
  artemisShaderFragmentSource,
  type ArtemisShaderPresetKind,
} from './raster-shader.js';

interface UniformField {
  readonly name: string;
  readonly glsl: string;
  readonly size: number;
}
export interface ArtemisDrawShaderPreset {
  readonly kind: ArtemisShaderPresetKind;
  /** Shared DrawList shade ABI; actual target compiles/links this executable. */
  readonly fragment: string;
  readonly fields: readonly {readonly name: string; readonly size: number}[];
  readonly needsUserTexture: boolean;
  /** Exact-source AA programs sample the captured target and disable device blending. */
  readonly requiresBackground: boolean;
  readonly replacesDestination: boolean;
  /** Explicit required values, no inferred defaults or native reflection claim. */
  parameters(values: ReadonlyMap<string, readonly number[]>): Float32Array;
  /** Native render15d120 concatenates vectors in order, ignoring their names. */
  nativeParameters(values: readonly ArtemisShaderConstant[], alpha?: number): Float32Array;
  /** Buffer includes native zero initialization/reused padding. Null is slot1 unbound. */
  bufferParameters(buffer: Float32Array | null): Float32Array;
}
/** Adapt reconstructed executables to shared DrawList's atlas/tex/tint/parameters
 * ABI. Per-actor native uniform preparation is a separate caller-owned effect.
 */
export function createArtemisDrawShaderPreset(
  hash: string,
  kind: ArtemisShaderPresetKind,
  userTextureIndex = 0,
  userTextureBound = true,
  maskTextureIndex?: number,
): ArtemisDrawShaderPreset {
  const named = artemisRevision(hash).shaderConstantBinding === 'named-effect';
  if (named) userTextureBound = false;
  if (!Number.isInteger(userTextureIndex) || userTextureIndex < 0 || userTextureIndex > 29)
    throw Error('Invalid Artemis user texture binding');
  const fields: UniformField[] = [];
  const scalar = (name: string, glsl: string) => fields.push({name, glsl, size: 1});
  switch (kind) {
    case 'raster':
      scalar('angle', 'uAngle');
      scalar('inter', 'uInter');
      scalar('size', 'uSize');
      break;
    case 'sepia':
    case 'sepia2':
    case 'rgb':
    case 'cadd':
    case 'cmul':
      scalar('red', 'uRed');
      scalar('green', 'uGreen');
      scalar('blue', 'uBlue');
      break;
    case 'blur_h':
    case 'blur_v':
    case 'blur_h_plain':
    case 'blur_h_aa':
    case 'blur_h_mask':
    case 'blur_h_mask_aa':
    case 'blur_v_plain':
    case 'blur_v_aa':
    case 'blur_v_mask':
    case 'blur_v_mask_aa':
      fields.push({name: 'weights', glsl: 'uWeights', size: 8});
      scalar(kind.startsWith('blur_h') ? 'width' : 'height', 'uStep');
      break;
    case 'radial':
      scalar('ax', 'uAx');
      scalar('ay', 'uAy');
      scalar('size', 'uSize');
      scalar('fade', 'uFade');
      break;
    case 'blur_diag':
    case 'blur_pair_h':
    case 'blur_pair_v':
    case 'blur_k':
    case 'blur_kx':
    case 'blur_ky':
    case 'blur_k_premultiplied':
    case 'blur_kx_premultiplied':
    case 'blur_ky_premultiplied':
      scalar('offset', 'uOffset');
      scalar('size', 'uSize');
      break;
    case 'noise':
      scalar('size', 'uSize');
      break;
    case 'mosaic':
      scalar('size', 'uSize');
      scalar('ratio', 'uRatio');
      break;
    case 'dimhole':
    case 'dimring':
      scalar('centerX', 'uCenterX');
      scalar('centerY', 'uCenterY');
      scalar('radius', 'uRadius');
      scalar('ratio', 'uRatio');
      if (kind === 'dimring') scalar('thick', 'uThick');
      break;
    case 'perspective':
    case 'perspective_anchored':
    case 'perspective_vertical':
    case 'perspective_vertical_anchored':
      scalar('centerX', 'uCenterX');
      scalar('centerY', 'uCenterY');
      scalar('scale', 'uScale');
      scalar('fade', 'uFade');
      break;
    case 'add':
    case 'mul':
    case 'mul_lerp':
    case 'compbr':
    case 'compbrc':
    case 'compdk':
    case 'compdkc':
      scalar('param', 'uParam');
      break;
    case 'gray':
    case 'nega':
    case 'reset':
    case 'screen':
      break;
    default:
      throw Error('Unsupported Artemis draw shader kind');
  }
  const needsUserTexture =
    userTextureBound &&
    ['screen', 'add', 'mul', 'mul_lerp', 'compbr', 'compbrc', 'compdk', 'compdkc'].includes(kind);
  let index = 0;
  const value = (offset: number) => `parameters[${Math.floor(offset / 4)}].${'xyzw'[offset % 4]}`;
  const declarations = fields
    .map((field) => {
      const values = Array.from({length: field.size}, () => value(index++));
      return field.size === 1
        ? `float ${field.glsl}=${values[0]};`
        : `float ${field.glsl}[${field.size}]=float[${field.size}](${values.join(',')});`;
    })
    .join('\n');
  let source = (
    named
      ? artemisDx9ShaderFragmentSource(kind as ArtemisDx9ShaderKind)
      : artemisShaderFragmentSource(kind)
  )
    .replace(/^#version.*\n/, '')
    .replace(/precision highp float;/g, '')
    .replace(/in vec2 vUv;/g, '')
    .replace(/in vec2 vBackUv;/g, '')
    .replace(/uniform [^;]+;/g, '')
    .replace(/out vec4 outColor;/g, '')
    .replace(
      /texture\(uMask,\s*vUv\)\.a/g,
      maskTextureIndex === undefined
        ? '1.0'
        : `texture(additionalAtlas${maskTextureIndex},additionalUV${maskTextureIndex}).a`,
    )
    .replace(
      /texture\(uUser,\s*vUv\)/g,
      userTextureBound
        ? `texture(additionalAtlas${userTextureIndex},additionalUV${userTextureIndex})`
        : named
          ? 'vec4(0.0,0.0,0.0,1.0)'
          : 'vec4(0.0)',
    )
    .replace(/\buFore\b/g, 'atlas')
    .replace(/texture\(uBack,\s*(uv|vBackUv)\)/g, (_match, coordinate) =>
      userTextureIndex > 0
        ? `texture(additionalAtlas0,${coordinate === 'vBackUv' ? 'additionalUV0' : 'uv'})`
        : 'vec4(0.0)',
    )
    .replace(/\bvBackUv\b/g, userTextureIndex > 0 ? 'additionalUV0' : 'vec2(0.0)')
    .replace(/\bvUv\b/g, 'tex')
    .replace(/\buAlpha\b/g, named ? 'parameters[7].w' : 'tint.a');
  source = source.replace(
    /void main\(\)\s*\{/,
    `vec4 shade(vec4 sampleColor,vec4 tint){\nvec4 outColor;\n${declarations}`,
  );
  const end = source.lastIndexOf('}');
  source = source.slice(0, end) + 'return outColor;\n' + source.slice(end);
  return {
    kind,
    fragment: source,
    fields: fields.map(({name, size}) => ({name, size})),
    needsUserTexture,
    requiresBackground: artemisDx9BlurMode(kind)?.background ?? false,
    replacesDestination: artemisDx9BlurMode(kind)?.background ?? false,
    bufferParameters(buffer) {
      if (
        (buffer?.length ?? 0) > 32 ||
        (buffer && (buffer.length % 4 !== 0 || !buffer.every(Number.isFinite)))
      )
        throw Error('Unsupported Artemis native shader buffer binding');
      const result = new Float32Array(32);
      if (buffer) result.set(buffer);
      return result;
    },
    nativeParameters(values, alpha) {
      if (named) {
        if (alpha === undefined) throw Error('Missing Artemis effect alpha');
        return new ArtemisDx9EffectConstants(fields).update(values, alpha);
      }
      return this.bufferParameters(new ArtemisShaderConstantStorage(hash).update(values));
    },
    parameters(values) {
      const result = new Float32Array(32);
      if (named) {
        const alpha = values.get('alpha');
        if (!alpha || alpha.length !== 1 || !Number.isFinite(Math.fround(alpha[0]!)))
          throw Error('Missing/invalid Artemis shader constant alpha');
        result[31] = alpha[0]!;
      }
      let offset = 0;
      for (const field of fields) {
        const input = values.get(field.name);
        if (
          !input ||
          input.length !== field.size ||
          !input.every((x) => Number.isFinite(Math.fround(x)))
        )
          throw Error(`Missing/invalid Artemis shader constant ${field.name}`);
        result.set(input, offset);
        offset += field.size;
      }
      return result;
    },
  };
}

/** Owned executable metadata. GPU programs are prepared and cached by the shared
 * target; shader-library loans keep this resource valid through command submission.
 */
export class ArtemisDrawShaderResource {
  private closed = false;
  private readonly ordinary: ArtemisDrawShaderPreset;
  private readonly captured: ArtemisDrawShaderPreset;
  private readonly nullOrdinary: ArtemisDrawShaderPreset;
  private readonly nullCaptured: ArtemisDrawShaderPreset;
  private readonly maskedOrdinary?: ArtemisDrawShaderPreset;
  private readonly maskedCaptured?: ArtemisDrawShaderPreset;
  private readonly effect?: ArtemisDx9EffectConstants;
  private mask?: ArtemisShaderTextureLease<{readonly texture: number}>;
  constructor(
    hash: string,
    kind: ArtemisShaderPresetKind,
    prepare: (fragment: string, additionalTextureCount: number) => void,
  ) {
    this.ordinary = createArtemisDrawShaderPreset(hash, kind, 0);
    this.captured = createArtemisDrawShaderPreset(hash, kind, 1);
    this.nullOrdinary = createArtemisDrawShaderPreset(hash, kind, 0, false);
    this.nullCaptured = createArtemisDrawShaderPreset(hash, kind, 1, false);
    if (artemisRevision(hash).shaderConstantBinding === 'named-effect') {
      this.effect = new ArtemisDx9EffectConstants(this.ordinary.fields);
      this.maskedOrdinary = createArtemisDrawShaderPreset(hash, kind, 0, false, 0);
      this.maskedCaptured = createArtemisDrawShaderPreset(hash, kind, 1, false, 1);
      prepare(this.maskedOrdinary.fragment, 1);
      prepare(this.maskedCaptured.fragment, 2);
    }
    prepare(this.nullOrdinary.fragment, 0);
    prepare(this.nullCaptured.fragment, 1);
    prepare(this.ordinary.fragment, this.ordinary.needsUserTexture ? 1 : 0);
    prepare(this.captured.fragment, this.captured.needsUserTexture ? 2 : 1);
  }
  preset(captured: boolean, userTextureBound = true, maskBound = false): ArtemisDrawShaderPreset {
    if (this.closed) throw Error('Artemis draw shader resource disposed');
    if (maskBound && this.effect) return (captured ? this.maskedCaptured : this.maskedOrdinary)!;
    return userTextureBound
      ? captured
        ? this.captured
        : this.ordinary
      : captured
        ? this.nullCaptured
        : this.nullOrdinary;
  }
  namedParameters(values: readonly ArtemisShaderConstant[], alpha: number): Float32Array {
    if (this.closed || !this.effect) throw Error('Artemis named effect owner missing');
    return this.effect.update(values, alpha);
  }
  /** 5cf080 skips SetTexture for null masks;447968 retains the last assignment. */
  bindMask(
    mask?: ArtemisShaderTextureLease<{readonly texture: number}>,
  ): ArtemisShaderTextureLease<{readonly texture: number}> | undefined {
    if (this.closed || !this.effect) throw Error('Artemis named effect owner missing');
    if (mask && mask.resource !== this.mask?.resource) {
      const next = mask.retain(),
        prior = this.mask;
      this.mask = next;
      prior?.release();
    }
    // The renderer batches commands. Preserve each sampled dependency until submission,
    // even if a later actor changes this same effect's texture parameter.
    return this.mask?.retain();
  }
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    const mask = this.mask;
    this.mask = undefined;
    mask?.release();
  }
}
/** Exact-source selector plus mandatory actual GPU preparation. */
export function createArtemisDrawShaderCompiler(
  hash: string,
  prepare: (fragment: string, additionalTextureCount: number) => void,
) {
  artemisRevision(hash);
  return {
    async compile(_id: string, bytes: Uint8Array): Promise<{shader: ArtemisDrawShaderResource}> {
      const program = await compileArtemisShaderPreset(hash, bytes);
      return {shader: new ArtemisDrawShaderResource(hash, program.kind, prepare)};
    },
    dispose(shader: ArtemisDrawShaderResource): void {
      shader.dispose();
    },
  };
}

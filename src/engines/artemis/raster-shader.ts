import {
  artemisCompositeShade,
  artemisCompositeFragmentSource,
  type ArtemisCompositeKind,
  type ArtemisCompositeUniforms,
} from './composite-shader.js';
import {artemisMosaicShade, ARTEMIS_MOSAIC_FRAGMENT_SOURCE} from './mosaic-shader.js';
import {artemisNoiseShade, ARTEMIS_NOISE_FRAGMENT_SOURCE} from './noise-shader.js';
import {
  artemisDimensionShade,
  artemisDimensionFragmentSource,
  type ArtemisDimensionKind,
  type ArtemisDimensionUniforms,
} from './dimension-shader.js';
import {
  artemisPerspectiveShade,
  artemisPerspectiveFragmentSource,
  type ArtemisPerspectiveKind,
} from './perspective-shader.js';
import {artemisRadialShade, ARTEMIS_RADIAL_FRAGMENT_SOURCE} from './radial-shader.js';
import {
  artemisBlurShade,
  artemisDiagonalBlurShade,
  artemisOffsetBlurFragmentSource,
  type ArtemisOffsetBlurKind,
  artemisBlurFragmentSource,
  type ArtemisBlurKind,
  type ArtemisBlurUniforms,
} from './blur-shader.js';
import {
  artemisColorShade,
  artemisColorFragmentSource,
  type ArtemisColorKind,
  type ArtemisColorUniforms,
} from './color-shader.js';
import {artemisRevision} from './revision.js';
import {ARTEMIS_SCREEN_FRAGMENT_SOURCE, artemisScreenShade} from './screen-shader.js';
import {
  artemisDx9ShaderSources,
  artemisDx9ShaderFragmentSource,
  artemisDx9ShaderShade,
  artemisDx9ShaderExecutable,
  type ArtemisDx9ShaderKind,
  type ArtemisDx9BlurKind,
  type ArtemisDx9ShaderExecutable,
} from './dx9-shader.js';

export interface ArtemisRasterUniforms {
  readonly alpha: number;
  readonly angle: number;
  readonly inter: number;
  readonly size: number;
}
export type ArtemisShaderSample = (
  u: number,
  v: number,
) => readonly [number, number, number, number];
const f = Math.fround;

/** CPU executable reference for the recognized game raster program. Texture
 * filtering/addressing belongs to the sampler; hardware sin approximations vary.
 */
export function artemisRasterCoordinates(
  u: number,
  v: number,
  p: ArtemisRasterUniforms,
): readonly [number, number] {
  if (![u, v, p.alpha, p.angle, p.inter, p.size].every(Number.isFinite))
    throw Error('Unsupported nonfinite Artemis raster uniform');
  const phase = f(f(f(v) * f(p.inter)) - f(p.angle)),
    radians = f(phase * f(Math.PI / 180));
  return [f(f(u) + f(f(Math.sin(radians)) * f(p.size))), f(v)];
}
export function artemisRasterShade(
  sample: ArtemisShaderSample,
  u: number,
  v: number,
  p: ArtemisRasterUniforms,
): readonly [number, number, number, number] {
  const [x, y] = artemisRasterCoordinates(u, v, p),
    pixel = sample(x, y);
  return [pixel[0], pixel[1], pixel[2], f(f(pixel[3]) * f(p.alpha))];
}

export const ARTEMIS_RASTER_FRAGMENT_SOURCE = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uFore;
uniform float uAlpha;
uniform float uAngle;
uniform float uInter;
uniform float uSize;
out vec4 outColor;
void main() {
  vec2 uv = vUv;
  uv.x += sin(radians(uv.y * uInter - uAngle)) * uSize;
  vec4 color = texture(uFore, uv);
  color.a *= uAlpha;
  outColor = color;
}`;

/** Exact input signature selects a reconstructed executable; unknown HLSL is
 * refused rather than registered as compiled. Original shader text is not shipped.
 */
export async function compileArtemisRasterPreset(
  hash: string,
  bytes: Uint8Array,
): Promise<{
  readonly kind: 'raster';
  readonly fragmentSource: string;
  readonly shade: typeof artemisRasterShade;
}> {
  const revision = artemisRevision(hash);
  const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer),
    signature = [...new Uint8Array(digest)]
      .map((value) => value.toString(16).padStart(2, '0'))
      .join('');
  if (revision.graphicsApi === 'd3d9') {
    if (artemisDx9ShaderSources[signature] !== 'raster')
      throw Error('Unsupported Artemis custom shader source');
    return {
      kind: 'raster',
      fragmentSource: artemisDx9ShaderFragmentSource('raster'),
      shade: (sample, u, v, p) => artemisDx9ShaderShade('raster', sample, u, v, p),
    };
  }
  if (signature !== '56f51f6ef596f287bc75bfe9266ce382a98884b8659267822ca74c1a22e49aba')
    throw Error('Unsupported Artemis custom shader source');
  return {
    kind: 'raster',
    fragmentSource: ARTEMIS_RASTER_FRAGMENT_SOURCE,
    shade: artemisRasterShade,
  };
}

export async function compileArtemisShaderPreset(
  hash: string,
  bytes: Uint8Array,
): Promise<
  | {
      readonly kind: ArtemisDx9ShaderKind;
      readonly fragmentSource: string;
      readonly shade: ArtemisDx9ShaderExecutable;
    }
  | {
      readonly kind: 'raster';
      readonly fragmentSource: string;
      readonly shade: typeof artemisRasterShade;
    }
  | {
      readonly kind: 'screen';
      readonly fragmentSource: string;
      readonly shade: typeof artemisScreenShade;
    }
  | {
      readonly kind: ArtemisColorKind;
      readonly fragmentSource: string;
      readonly shade: (
        sample: ArtemisShaderSample,
        u: number,
        v: number,
        p: ArtemisColorUniforms,
      ) => readonly [number, number, number, number];
    }
  | {
      readonly kind: ArtemisBlurKind;
      readonly fragmentSource: string;
      readonly shade: (
        sample: ArtemisShaderSample,
        u: number,
        v: number,
        p: ArtemisBlurUniforms,
      ) => readonly [number, number, number, number];
    }
  | {
      readonly kind: 'radial';
      readonly fragmentSource: string;
      readonly shade: typeof artemisRadialShade;
    }
  | {
      readonly kind: ArtemisCompositeKind;
      readonly fragmentSource: string;
      readonly shade: (
        fore: ArtemisShaderSample,
        user: ArtemisShaderSample,
        u: number,
        v: number,
        p: ArtemisCompositeUniforms,
      ) => readonly [number, number, number, number];
    }
  | {
      readonly kind: 'mosaic';
      readonly fragmentSource: string;
      readonly shade: typeof artemisMosaicShade;
    }
  | {
      readonly kind: ArtemisPerspectiveKind;
      readonly fragmentSource: string;
      readonly shade: typeof artemisPerspectiveShade;
    }
  | {
      readonly kind: ArtemisOffsetBlurKind;
      readonly fragmentSource: string;
      readonly shade: typeof artemisDiagonalBlurShade;
    }
  | {
      readonly kind: 'noise';
      readonly fragmentSource: string;
      readonly shade: typeof artemisNoiseShade;
    }
  | {
      readonly kind: ArtemisDimensionKind;
      readonly fragmentSource: string;
      readonly shade: (
        sample: ArtemisShaderSample,
        u: number,
        v: number,
        p: ArtemisDimensionUniforms,
      ) => readonly [number, number, number, number];
    }
> {
  const revision = artemisRevision(hash);
  const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer),
    signature = [...new Uint8Array(digest)]
      .map((value) => value.toString(16).padStart(2, '0'))
      .join('');
  if (revision.graphicsApi === 'd3d9') {
    const kind = artemisDx9ShaderSources[signature];
    if (!kind) throw Error('Unsupported Artemis custom shader source');
    return {
      kind,
      fragmentSource: artemisDx9ShaderFragmentSource(kind),
      shade: artemisDx9ShaderExecutable(kind),
    };
  }
  if (signature === '56f51f6ef596f287bc75bfe9266ce382a98884b8659267822ca74c1a22e49aba')
    return {
      kind: 'raster',
      fragmentSource: ARTEMIS_RASTER_FRAGMENT_SOURCE,
      shade: artemisRasterShade,
    };
  const perspectives: Readonly<Record<string, ArtemisPerspectiveKind>> = {
    '271173e75305f3754627750f0e782bd38f217da903a5f79971dd126d677d18d6': 'perspective',
    '3a5b63e574b3e9fa6135a756dc09eaaa27de3c930ef48792a0a53e1cf65b604b': 'perspective_anchored',
    '07f6d756956160c90aef1c0ccd37a13161d8986a218e4439891b751309d0763d': 'perspective_vertical',
    db1b5dc85206ab9ab553870420f61befa1f3e8aa7e1ce8fb31dd5ef09b3e3ac9:
      'perspective_vertical_anchored',
  };
  const perspective = perspectives[signature];
  if (perspective)
    return {
      kind: perspective,
      fragmentSource: artemisPerspectiveFragmentSource(perspective),
      shade: (sample, u, v, p) => artemisPerspectiveShade(sample, u, v, p, perspective),
    };
  if (signature === 'd55bc26b8b72c1f38ff34aa1d41a15a7be69f2351518a8f8a3e99b39f61b59d2')
    return {
      kind: 'screen',
      fragmentSource: ARTEMIS_SCREEN_FRAGMENT_SOURCE,
      shade: artemisScreenShade,
    };
  const offsetBlurs: Readonly<Record<string, ArtemisOffsetBlurKind>> = {
    '80d646d64254becbb1fa0ff5e84fb01af7b5261894d79a9a204a2be7b59e02ad': 'blur_diag',
    b993e9021e84f01c2e9f1cb5c8abedc7e0938ab5660c900797dfd6f678dd38a2: 'blur_pair_h',
    '613c946b72ad2fdc2ff96b03e33e51f67d507528ae7d15f57743a7ab63953122': 'blur_pair_v',
    '91b27ada3f68ff604b7aad330ac03d91f20fafff36e63bf0111fd0f8fb977cb1': 'blur_k',
    d26e58ceae414ca0b8df667eea57ccd099096c0e64d55ef37ce215a7971d849b: 'blur_kx',
    ff65397a10c8423873969453701754d6bbba5ebc441dfb8ad85e097d66c94fe4: 'blur_ky',
    eb5112786c30de01300e5623be2261daaacb9f12eedc3ee8fefb70020021efef: 'blur_k_premultiplied',
    '6caab0c658ae5139d4a7b1ebcbba09ab3304784aa05d65869f80eb08a119c757': 'blur_kx_premultiplied',
    bd8aa1e5b8f8e8dc552572915766ef8b19a58a6760d9db84c5c50b691712ad5c: 'blur_ky_premultiplied',
  };
  const offsetBlur = offsetBlurs[signature];
  if (offsetBlur)
    return {
      kind: offsetBlur,
      fragmentSource: artemisOffsetBlurFragmentSource(offsetBlur),
      shade: (sample, u, v, p) => artemisDiagonalBlurShade(sample, u, v, p, offsetBlur),
    };
  if (signature === 'c4bf785cfb1ec5e2bbb9470764ccec206e400f142854106eea0aa4e7eefde20a')
    return {kind: 'noise', fragmentSource: ARTEMIS_NOISE_FRAGMENT_SOURCE, shade: artemisNoiseShade};
  const colors: Record<string, ArtemisColorKind> = {
    e296e41bbad54c2a5e30e9cdf044aef6482baffa055a9e4dd939dd1ea6f4f748: 'cadd',
    '807fd3b8ef52658c6ee664aa43ccafc61632d3bd1e72810f108cde9edba68254': 'cmul',
    da797c82c78f9c4929262a40c4d6f58a47e4401cd0c048680f81f7450d32997d: 'reset',

    c7c5cebcfb6cacb90e9c7dc22c847ece6f3954b725eb9c565920be1a2a430c0d: 'nega',
    d4204bafc284e3becc3cdcf3a0477c9c34ee4ecfea27abf716229d81132017b0: 'rgb',
    '36c560ed78d7f48b8f04426b45c1cc18c441e0fbcad9967f0809a26e5c391e9b': 'sepia',
    a637849ea00721f8aebdf2a197c33c7198951401bc5530fc89bfa13973b31fc6: 'sepia2',
    '693a8b58386c0b58e7e8cbb9b655ca42d71ce6792db7a6172ad3eac4836c3e1e': 'gray',
  };
  const kind = colors[signature];
  if (kind)
    return {
      kind,
      fragmentSource: artemisColorFragmentSource(kind),
      shade: (sample: ArtemisShaderSample, u: number, v: number, p: ArtemisColorUniforms) =>
        artemisColorShade(kind, sample, u, v, p),
    };
  const blurKind =
    signature === 'd39f149a08d912ab94ab6770fb4fa082a8df78d8e3ad5fef449ffdbad3b6d799'
      ? 'blur_h'
      : signature === '7fc240a2d4ac5f4264661078ab2fa343cd4a17366a859f018941111478a71662'
        ? 'blur_v'
        : null;
  if (blurKind)
    return {
      kind: blurKind,
      fragmentSource: artemisBlurFragmentSource(blurKind),
      shade: (sample: ArtemisShaderSample, u: number, v: number, p: ArtemisBlurUniforms) =>
        artemisBlurShade(blurKind, sample, u, v, p),
    };
  if (signature === '33f20c759657d25064c273dcc5f55b6d25de00c49d1fc3b4d21fa307f53c3f96')
    return {
      kind: 'radial',
      fragmentSource: ARTEMIS_RADIAL_FRAGMENT_SOURCE,
      shade: artemisRadialShade,
    };
  const composite: Record<string, ArtemisCompositeKind> = {
    '7f8bdd36691555ba007e13419dc0e1f2bbdc9f161bbdb580879a199049910826': 'add',
    cd766e279e166d58badef0665dc4867d5cdbae12bfda3acaba5e23ef9b509d51: 'mul',
    d9ca93dba80619b4fd24c1e027244de7580f6ce9fb91e400ad11e640a00f5120: 'compbr',
    f7af4d49fab7ace7dacb4b8ca6aea33492384fd13ec9acab0a0264a9de0c8c5f: 'compbrc',
    ba6c993f0416c6e66bafb769c245e26d6f36ed45756a5669f53ff913013176ff: 'compdk',
    ecdc808ce2aeeb243a87f36177bd15c696c3ed3fccfe770bab4273457bd30e59: 'compdkc',
  };
  const comp = composite[signature];
  if (comp)
    return {
      kind: comp,
      fragmentSource: artemisCompositeFragmentSource(comp),
      shade: (
        fore: ArtemisShaderSample,
        user: ArtemisShaderSample,
        u: number,
        v: number,
        p: ArtemisCompositeUniforms,
      ) => artemisCompositeShade(comp, fore, user, u, v, p),
    };
  if (signature === 'faf7e8e1e83551bdfde4c5bc1b3af08cb9d4c9a06fa1b2d8f5b529bb52c94e0d')
    return {
      kind: 'mosaic',
      fragmentSource: ARTEMIS_MOSAIC_FRAGMENT_SOURCE,
      shade: artemisMosaicShade,
    };
  const dimension =
    signature === 'a939dd872d2d041cb9e45eb6ddda4bb771709672c8b10572ca242a50cf3daa5d'
      ? 'dimhole'
      : signature === '0da6785d89443f1b11d4beba44b1e197cb4d773e35cba2540b6574f35f1e67ea'
        ? 'dimring'
        : null;
  if (dimension)
    return {
      kind: dimension,
      fragmentSource: artemisDimensionFragmentSource(dimension),
      shade: (sample: ArtemisShaderSample, u: number, v: number, p: ArtemisDimensionUniforms) =>
        artemisDimensionShade(dimension, sample, u, v, p),
    };
  throw Error('Unsupported Artemis custom shader source');
}

export type ArtemisShaderPresetKind =
  | ArtemisDx9BlurKind
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
  | ArtemisCompositeKind;
/** Reconstructed preset source, independent of resource selection/registration. */
export function artemisShaderFragmentSource(kind: ArtemisShaderPresetKind): string {
  switch (kind) {
    case 'blur_h_plain':
    case 'blur_h_aa':
    case 'blur_h_mask':
    case 'blur_h_mask_aa':
    case 'blur_v_plain':
    case 'blur_v_aa':
    case 'blur_v_mask':
    case 'blur_v_mask_aa':
      return artemisDx9ShaderFragmentSource(kind);
    case 'raster':
      return ARTEMIS_RASTER_FRAGMENT_SOURCE;
    case 'noise':
      return ARTEMIS_NOISE_FRAGMENT_SOURCE;
    case 'screen':
      return ARTEMIS_SCREEN_FRAGMENT_SOURCE;
    case 'radial':
      return ARTEMIS_RADIAL_FRAGMENT_SOURCE;
    case 'mosaic':
      return ARTEMIS_MOSAIC_FRAGMENT_SOURCE;
    case 'dimhole':
    case 'dimring':
      return artemisDimensionFragmentSource(kind);
    case 'perspective':
    case 'perspective_anchored':
    case 'perspective_vertical':
    case 'perspective_vertical_anchored':
      return artemisPerspectiveFragmentSource(kind);
    case 'blur_h':
    case 'blur_v':
      return artemisBlurFragmentSource(kind);
    case 'blur_diag':
    case 'blur_pair_h':
    case 'blur_pair_v':
    case 'blur_k':
    case 'blur_kx':
    case 'blur_ky':
    case 'blur_k_premultiplied':
    case 'blur_kx_premultiplied':
    case 'blur_ky_premultiplied':
      return artemisOffsetBlurFragmentSource(kind);
    case 'sepia':
    case 'sepia2':
    case 'gray':
    case 'nega':
    case 'rgb':
    case 'cadd':
    case 'cmul':
    case 'reset':
      return artemisColorFragmentSource(kind);
    case 'add':
    case 'mul':
    case 'mul_lerp':
    case 'compbr':
    case 'compbrc':
    case 'compdk':
    case 'compdkc':
      return artemisCompositeFragmentSource(kind);
    default:
      throw Error('Unsupported Artemis shader preset');
  }
}

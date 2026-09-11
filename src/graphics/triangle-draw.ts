import type {AlphaMask} from './alpha-mask.js';
import type {BlendState} from './blend.js';
/** Textured triangle list in pixel coordinates; vertices are x,y,z,r,g,b,a,u,v.
 * UVs are pixel coordinates. Colors/alpha are interpolated independently. */
export interface AdditionalTexture {
  texture: number;
  uv: Float32Array;
  filter?: 'nearest' | 'linear';
  wrapS?: 'clamp' | 'repeat' | 'mirror';
  wrapT?: 'clamp' | 'repeat' | 'mirror';
}
export interface TriangleDraw {
  kind: 'triangles';
  depthClip?: boolean;
  texture: number;
  vertices: Float32Array;
  topology?: 'points' | 'lines' | 'line-strip' | 'triangles' | 'triangle-strip';
  blendState?: BlendState;
  filter?: 'nearest' | 'linear';
  blend?: 'source-over' | 'add';
  normalizedUV?: boolean;
  transform?: Float32Array;
  fragment?: string;
  parameters?: Float32Array;
  additionalTextures?: AdditionalTexture[];
  discardTransparent?: boolean;
  mask?: Omit<AlphaMask, 'source'> & {uv: Float32Array};
  wrapS?: 'clamp' | 'repeat' | 'mirror';
  wrapT?: 'clamp' | 'repeat' | 'mirror';
}
export interface TriangleImage {
  width: number;
  height: number;
  pixels: Uint8Array;
}

import {WebGLDrawTarget} from './webgl-draw.js';
import type {BlendState} from './blend.js';
import type {TriangleImage, TriangleDraw} from './triangle-draw.js';
import type {Rect} from './surface.js';
import type {AlphaMask} from './alpha-mask.js';

/** Engine-independent textured rectangles, in target pixel coordinates. */
export interface SpriteDraw {
  texture: number;
  source: Rect;
  destination: Rect;
  color: number;
  alpha: number;
  filter?: 'nearest' | 'linear';
  mask?: AlphaMask;
  blend?: 'source-over' | 'add';
  fragment?: string;
  blendState?: BlendState;
  wrapS?: 'clamp' | 'repeat' | 'mirror';
  wrapT?: 'clamp' | 'repeat' | 'mirror';
}
export interface SolidDraw {
  kind: 'solid';
  destination: Rect;
  color: number;
  alpha: number;
  blendState?: BlendState;
}
export interface CaptureDraw {
  kind: 'capture';
  texture: number;
  width: number;
  height: number;
}
export interface TargetDraw {
  kind: 'target';
  texture: number | null;
  width: number;
  height: number;
}
/** Replace a texture allocation at this point in the command stream. */
export interface TextureDraw {
  kind: 'texture';
  texture: number;
  image: TriangleImage;
}
export type DrawCommand =
  TextureDraw | SpriteDraw | SolidDraw | TriangleDraw | CaptureDraw | TargetDraw;
export interface DrawList {
  sprites: SpriteDraw[];
  commands?: DrawCommand[];
}

/** Canvas presentation with a single WebGL framebuffer for all draw operations. */
export class CanvasDrawTarget extends WebGLDrawTarget {}

import {WebGLDrawTarget} from './webgl-draw.js';
import type {GpuRenderSurface} from './gpu-render-surface.js';
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
/** Bind a prepared GPU surface, or return to the presentation target.
 * Contents persist across draws; clear only when explicitly requested. */
export interface GpuTargetDraw {
  kind: 'gpu-target';
  surface: GpuRenderSurface | null;
  clearColor?: readonly [number, number, number, number];
}
/** Copy a complete persistent color attachment without publishing CPU pixels. A null
 * source is the presentation target: the frame presented last, unless this list already drew
 * into it. */
export interface GpuCopyDraw {
  kind: 'gpu-copy';
  source: GpuRenderSurface | null;
  destination: GpuRenderSurface;
}
/** Replace a texture allocation at this point in the command stream. */
export interface TextureDraw {
  kind: 'texture';
  texture: number;
  image: TriangleImage;
}
export type DrawCommand =
  | TextureDraw
  | SpriteDraw
  | SolidDraw
  | TriangleDraw
  | CaptureDraw
  | TargetDraw
  | GpuTargetDraw
  | GpuCopyDraw;
export interface DrawList {
  sprites: SpriteDraw[];
  commands?: DrawCommand[];
  /** Initial framebuffer RGBA; omitted preserves the ordinary opaque black clear. */
  clearColor?: readonly [number, number, number, number];
  /** Draws only into GPU surfaces: the presented canvas keeps its content. */
  offscreen?: boolean;
}
/** Shared raster resource preparation and draw-list presentation contract. */
export interface DrawListTarget {
  readonly width: number;
  readonly height: number;
  prepareImage(image: TriangleImage): void;
  /** Eagerly compile/link an executable triangle program on the actual target. */
  prepareTriangleShader?(fragment: string, additionalTextureCount: number): void;
  prepareRenderSurface?(surface: GpuRenderSurface): void;
  /** RGBA rows, top row first, of a prepared GPU surface scaled to `width` x `height`. */
  readRenderSurface?(surface: GpuRenderSurface, width: number, height: number): Uint8Array;
  draw(list: DrawList, texture: (id: number) => TriangleImage): void;
  invalidate(image: object): void;
}

/** Canvas presentation with a single WebGL framebuffer for all draw operations. */
export class CanvasDrawTarget extends WebGLDrawTarget {}

import {serveWorkerPool} from '../../../platform/worker-pool.js';
import {BurikoFontTextCanvas, type BurikoFontCanvasStyle} from './font-canvas.js';

export interface BurikoFontRasterWorkerRequest {
  readonly font: {
    /** The main thread's CSS family, so `style.font` resolves identically here. */
    readonly family: string;
    /** Distinguishes resource fonts that reuse a family name across engine instances. */
    readonly id: number;
    readonly kind: 'bytes' | 'generic';
    readonly descriptors: {readonly weight: string; readonly style: string} | null;
    readonly bytes?: ArrayBuffer;
  };
  readonly style: BurikoFontCanvasStyle;
  readonly width: number;
  readonly height: number;
  readonly texts: readonly string[];
}

export type BurikoFontRasterWorkerResponse =
  {readonly missingFont: true} | {readonly dibs: Uint8Array[]};

const fonts = (globalThis as unknown as {fonts: FontFaceSet}).fonts;
const loaded = new Map<string, {id: number; face: FontFace}>();
let canvas: {key: string; canvas: BurikoFontTextCanvas} | null = null;

serveWorkerPool<BurikoFontRasterWorkerRequest, BurikoFontRasterWorkerResponse>(
  async ({font, style, width, height, texts}) => {
    if (font.kind === 'bytes') {
      const current = loaded.get(font.family);
      if (current?.id !== font.id) {
        if (font.bytes === undefined) return {response: {missingFont: true}};
        if (current) fonts.delete(current.face);
        const face = new FontFace(font.family, font.bytes, font.descriptors ?? {});
        await face.load();
        fonts.add(face);
        loaded.set(font.family, {id: font.id, face});
      }
    }
    const key = JSON.stringify([font.family, font.id, style]);
    if (canvas?.key !== key) canvas = {key, canvas: new BurikoFontTextCanvas(style)};
    const dibs = texts.map((text) => canvas!.canvas.raster(text, width, height).bytes);
    return {response: {dibs}, transfer: dibs.map((dib) => dib.buffer)};
  },
);

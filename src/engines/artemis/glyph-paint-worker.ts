import {
  paintArtemisGrayGlyph,
  type ArtemisGlyphPaint,
  type ArtemisGlyphSurface,
} from './glyph-paint.js';
import type {ArtemisFileGlyph} from './file-fonts.js';
export interface ArtemisGlyphPaintRequest {
  id: number;
  executableSha256: string;
  glyph: ArtemisFileGlyph;
  style: ArtemisGlyphPaint;
}
export interface ArtemisGlyphPaintResponse {
  id: number;
  surface?: ArtemisGlyphSurface;
  error?: string;
}
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<ArtemisGlyphPaintRequest>) => void) | null;
  postMessage(value: ArtemisGlyphPaintResponse, transfers: Transferable[]): void;
};
scope.onmessage = ({data}) => {
  try {
    const surface = paintArtemisGrayGlyph(data.executableSha256, data.glyph, data.style);
    scope.postMessage({id: data.id, surface}, surface.image ? [surface.image.pixels.buffer] : []);
  } catch (error) {
    scope.postMessage({id: data.id, error: String(error)}, []);
  }
};

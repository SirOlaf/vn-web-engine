import {buildAtlasFont, type AtlasFontGlyph} from './atlas-font.js';
const worker = globalThis as unknown as {
  onmessage: ((event: MessageEvent<{id: number; glyphs: AtlasFontGlyph[]}>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};
worker.onmessage = ({data}) => {
  try {
    const buffer = buildAtlasFont(data.glyphs);
    worker.postMessage({id: data.id, buffer}, [buffer]);
  } catch (error) {
    worker.postMessage({
      id: data.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

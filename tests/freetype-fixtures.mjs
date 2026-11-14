import {buildAtlasFont} from '../dist/text/atlas-font.js';
/** Synthetic single rectangle glyph. Remap the cmap from COLR's empty base to its
 * outline layer, so historical FreeType tests ordinary glyf data without COLR.
 */
export function rectangleFont() {
  const bytes = new Uint8Array(
    buildAtlasFont([
      {
        codePoint: 65,
        width: 0.25,
        height: 0.5,
        advance: 0.75,
        pixels: Uint8Array.of(255, 255, 255, 255),
        pixelWidth: 1,
        pixelHeight: 1,
        sourceX: 0,
        sourceY: 0,
        sourceWidth: 1,
        sourceHeight: 1,
      },
    ]),
  );
  const view = new DataView(bytes.buffer);
  const sum = (start, length) => {
    let value = 0;
    for (let i = 0; i < length; i += 4) value = (value + view.getUint32(start + i)) >>> 0;
    return value;
  };
  let head;
  for (let i = 0; i < view.getUint16(4); i++) {
    const at = 12 + i * 16,
      tag = new TextDecoder().decode(bytes.subarray(at, at + 4)),
      offset = view.getUint32(at + 8),
      length = view.getUint32(at + 12);
    if (tag === 'cmap') {
      view.setUint32(offset + 36, 2);
      view.setUint32(at + 4, sum(offset, (length + 3) & ~3));
    }
    if (tag === 'head') head = offset;
  }
  view.setUint32(head + 8, 0);
  view.setUint32(head + 8, (0xb1b0afba - sum(0, bytes.length)) >>> 0);
  return bytes;
}

export async function createNodeFontWorker() {
  const {Worker} = await import('node:worker_threads');
  const {FreeTypeWorker} = await import('../dist/text/freetype-worker-client.js');
  return new FreeTypeWorker(() => {
    const raw = new Worker(new URL('./freetype-node-worker.mjs', import.meta.url));
    const host = {
      onmessage: null,
      onerror: null,
      onmessageerror: null,
      postMessage: (value, transfers) => raw.postMessage(value, transfers),
      terminate: () => raw.terminate(),
    };
    raw.on('message', (data) => host.onmessage?.({data}));
    raw.on('error', (error) => host.onerror?.(error));
    return host;
  });
}

export async function createNodeGlyphPainter(hash) {
  const {Worker} = await import('node:worker_threads');
  const {ArtemisGlyphPainter} = await import('../dist/engines/artemis/glyph-paint-client.js');
  return new ArtemisGlyphPainter(hash, () => {
    const raw = new Worker(new URL('./artemis-glyph-node-worker.mjs', import.meta.url));
    const host = {
      onmessage: null,
      onerror: null,
      onmessageerror: null,
      postMessage: (value, transfers) => raw.postMessage(value, transfers),
      terminate: () => raw.terminate(),
    };
    raw.on('message', (data) => host.onmessage?.({data}));
    raw.on('error', (error) => host.onerror?.(error));
    return host;
  });
}

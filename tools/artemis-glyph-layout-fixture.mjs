/** Actual font/glyph/layout resources for nonvisual control-flow diagnostics.
 * No canvas, image encoding, screen output or game-picture decoder is used. */
import {createHash} from 'node:crypto';
import {createNodeBrowserWorker} from './node-browser-worker.mjs';
import {FreeTypeWorker} from '../dist/text/freetype-worker-client.js';
import {ArtemisGlyphPainter} from '../dist/engines/artemis/glyph-paint-client.js';
import {ArtemisFileFonts} from '../dist/engines/artemis/file-fonts.js';
import {ArtemisTextGlyphs} from '../dist/engines/artemis/text-glyphs.js';
import {ArtemisRuntimeGlyphOwner} from '../dist/engines/artemis/runtime-glyphs.js';
export function createArtemisGlyphLayoutFixture(hash, readFont) {
  const fontWorker = new FreeTypeWorker(() =>
      createNodeBrowserWorker(new URL('../dist/text/freetype-worker.js', import.meta.url)),
    ),
    painter = new ArtemisGlyphPainter(hash, () =>
      createNodeBrowserWorker(
        new URL('../dist/engines/artemis/glyph-paint-worker.js', import.meta.url),
      ),
    );
  const openedFonts = [],
    samples = [];
  let rasterJobs = 0;
  const fonts = new ArtemisFileFonts(hash, {
    readFontFile: async (path) => {
      const bytes = await readFont(path);
      if (bytes)
        openedFonts.push({
          path,
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        });
      return bytes;
    },
    hasSystemFontFamily: async () => false,
    openFontFace: async (bytes) => {
      const face = await fontWorker.open(bytes);
      return {
        requestSize: (...args) => face.requestSize(...args),
        rasterize: (...args) => {
          rasterJobs++;
          return face.rasterize(...args);
        },
        close: () => face.close(),
      };
    },
  });
  const glyphs = new ArtemisTextGlyphs(hash, fonts, painter);
  const owner = new ArtemisRuntimeGlyphOwner(hash, glyphs, (resource, block) => {
    if (samples.length < 128)
      samples.push({
        layer: resource.name,
        mainGlyphs: block.main.length,
        rubyGlyphs: block.ruby.length,
        width: block.width,
        height: block.height,
        paintedSha256: [...block.main, ...block.ruby]
          .filter((g) => g.glyph.surface.image)
          .map((g) => createHash('sha256').update(g.glyph.surface.image.pixels).digest('hex')),
      });
  });
  return {
    restoreFontCache: (path) => glyphs.restoreFontCache(path),
    get: (resource) => owner.get(resource),
    copy: (old, resource) => owner.copy(old, resource),
    release: (resource) => owner.release(resource),
    summary: () => ({
      glyphLayout: 'actual-workers-nonvisual',
      sceneRendering: false,
      gameVisualAssetsDisplayed: false,
      rasterJobs,
      restoredFontCache: glyphs.restoredFontCacheStatistics(),
      openedFonts,
      samples,
      layers: owner.entries().map(([resource, insertion]) => ({
        name: resource.name,
        glyphCount: insertion.glyphCount,
        ...insertion.measure(),
      })),
    }),
    close: async () => {
      owner.close();
      await glyphs.close();
      await fonts.close();
      painter.close();
      fontWorker.close();
    },
  };
}

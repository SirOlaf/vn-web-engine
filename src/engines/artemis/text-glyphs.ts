import {
  ArtemisMissingFontFile,
  type ArtemisFileFont,
  type ArtemisFileFontMetrics,
  type ArtemisFileFonts,
  type ArtemisFileGlyph,
} from './file-fonts.js';
import type {ArtemisGlyphPainter} from './glyph-paint-client.js';
import type {ArtemisGlyphSurface} from './glyph-paint.js';
import {
  layoutArtemisTextBlock,
  type ArtemisTextBlock,
  type ArtemisTextBlockStyle,
  type ArtemisBlockGlyph,
} from './text-block.js';
import type {ArtemisFontFace} from './font-state.js';
import {artemisRevision} from './revision.js';
import {ArtemisRestoredFontCache, artemisClippedCellGlyph} from './font-cache.js';

export interface ArtemisTextGlyphStyle extends ArtemisTextBlockStyle {
  readonly face: ArtemisFontFace;
  readonly rubyface: ArtemisFontFace;
  readonly styleBits: number;
  readonly color: number;
  readonly shadowcolor: number;
  readonly outlinecolor: number;
}
export interface ArtemisTextGlyphResource {
  readonly codePoint: number;
  readonly surface: ArtemisGlyphSurface;
}
/** One text layer's CFontRenderer current-provider state. setFont (0x1401662e0) keeps
 * the first of the FreeType, rendered (.rft) and system providers that opens the face; when
 * none opens it the previous provider stays current. A renderer that has never opened a face
 * has no provider, and 0x140166420 then yields empty character surfaces, as it does for a
 * failed provider glyph. */
export class ArtemisGlyphRenderer {
  /** The current provider's face path, byte size and style bits. */
  current: ArtemisGlyphProvider | null = null;
}
interface ArtemisGlyphProvider {
  /** CFreeTypeFont file or CRenderedFont `.rft` face. */
  readonly kind: 'file' | 'rendered';
  readonly path: string;
  readonly size: number;
  readonly styleBits: number;
}
/** A provider's glyph call: null when it fails. */
interface ArtemisGlyphFont {
  readonly metrics: ArtemisFileFontMetrics;
  glyph(codePoint: number): Promise<ArtemisFileGlyph | null>;
}
const emptyGlyph = (codePoint: number): ArtemisTextGlyphResource =>
  Object.freeze({
    codePoint,
    surface: Object.freeze({image: null, left: 0, top: 0, advance: 0}),
  });
const glyphWindow = 16;
const nativeFontStyle = (provider: number, current: number) =>
  (provider & 8 ? 1 : 0) |
  (provider & 16 ? 2 : 0) |
  (current & 32 ? 8 : 0) |
  (current & 64 ? 16 : 0);
interface Cached {
  promise: Promise<ArtemisTextGlyphResource>;
  bytes: number;
}
/** File font→native paint→normal/ruby block pipeline. Resources can outlive this
 * cache through a frame owner's references. This does not claim line insertion,
 * scene attachment, display transforms or tween completion.
 */
export class ArtemisTextGlyphs {
  private readonly fonts = new Map<string, Promise<ArtemisFileFont>>();
  private readonly glyphs = new Map<string, Cached>();
  private cachedBytes = 0;
  private closed = false;
  private readonly restored: ArtemisRestoredFontCache | undefined;
  constructor(
    private readonly hash: string,
    private readonly fontOwner: ArtemisFileFonts,
    private readonly painter: ArtemisGlyphPainter,
  ) {
    if (artemisRevision(hash).fontCacheKey !== null)
      this.restored = new ArtemisRestoredFontCache(hash, (path) =>
        fontOwner.readCacheResource(path),
      );
  }
  async restoreFontCache(path: string): Promise<void> {
    this.assertOpen();
    if (!this.restored) throw Error('Unsupported Artemis font cache layout');
    await this.restored.restore(path);
    // Restored entries replace generated entries with the same native key only.
    for (const [name, entry] of this.glyphs) {
      const [
        ,
        face,
        size,
        providerStyle,
        style,
        shadow,
        outline,
        color,
        shadowColor,
        outlineColor,
        codePoint,
      ] = JSON.parse(name);
      if (
        this.restored.has({
          face,
          size,
          shadow,
          outline,
          color,
          shadowColor,
          outlineColor,
          codePoint,
          style: nativeFontStyle(providerStyle, style),
        })
      ) {
        this.glyphs.delete(name);
        this.cachedBytes -= entry.bytes;
      }
    }
  }
  restoredFontCacheStatistics(): {entries: number; atlasBytes: number; hits: number} | null {
    return this.restored?.statistics() ?? null;
  }
  async load(
    mainText: string,
    rubyText: string,
    style: ArtemisTextGlyphStyle,
    renderer?: ArtemisGlyphRenderer,
  ): Promise<ArtemisTextBlock<ArtemisTextGlyphResource>> {
    this.assertOpen();
    const snapshot = {...style};
    if (
      !Number.isInteger(snapshot.styleBits) ||
      snapshot.styleBits < -0x80000000 ||
      snapshot.styleBits > 0x7fffffff
    )
      throw Error('Unsupported Artemis font style bits');
    // Validate all reserved geometry before allocating fonts or worker resources.
    layoutArtemisTextBlock(this.hash, [], [], snapshot);
    const symbolsFor = (text: string): string[] => {
      text = text.split('\0', 1)[0]!;
      if (
        new TextDecoder('utf-8', {ignoreBOM: true}).decode(new TextEncoder().encode(text)) !== text
      )
        throw Error('Unsupported Artemis glyph text UTF-8');
      const symbols = Array.from(text);
      if (symbols.length > 10000) throw Error('Artemis text glyph budget exceeded');
      return symbols;
    };
    const mainSymbols = symbolsFor(mainText),
      rubySymbols = symbolsFor(rubyText);
    if (
      (snapshot.size ? mainSymbols.length : 0) + (snapshot.rubysize ? rubySymbols.length : 0) >
      10000
    )
      throw Error('Artemis text block glyph budget exceeded');
    // setFont for the normal stream, then the ruby stream; a stream without characters or
    // size selects no font.
    const open = async (provider: ArtemisGlyphProvider): Promise<ArtemisGlyphFont | null> =>
      provider.kind === 'file'
        ? this.font(provider.path, provider.size, provider.styleBits)
        : this.fontOwner.loadRendered(provider.path, provider.size);
    const select = async (
      ruby: boolean,
    ): Promise<{provider: ArtemisGlyphProvider; font: ArtemisGlyphFont} | null | undefined> => {
      const size = ruby ? snapshot.rubysize : snapshot.size;
      if (!size || !(ruby ? rubySymbols : mainSymbols).length) return undefined;
      const face = ruby ? snapshot.rubyface : snapshot.face;
      if (typeof face === 'string') {
        const path = face.split('\0', 1)[0]!,
          styleBits = snapshot.styleBits;
        const file: ArtemisGlyphProvider = {kind: 'file', path, size, styleBits};
        try {
          const font = await open(file);
          if (renderer) renderer.current = file;
          return {provider: file, font: font!};
        } catch (error) {
          if (!(error instanceof ArtemisMissingFontFile) || !renderer) throw error;
        }
        // CRenderedFont (0x14018a160) opens `<face>_<size>.rft`, CSystemFont (0x140191720)
        // a UTF-8 EnumFontFamiliesExW family name.
        const rendered: ArtemisGlyphProvider = {kind: 'rendered', path, size, styleBits};
        const font = await open(rendered);
        if (font) {
          renderer.current = rendered;
          return {provider: rendered, font};
        }
        if (await this.fontOwner.hasSystemFamily(path))
          throw Error('Unsupported Artemis system font');
      } else if (!renderer) {
        // In this UTF-8 revision a face that is not UTF-8 (the 193720 Shift-JIS default)
        // names no font file or <face>_<size>.rft, and CSystemFont looks it up among UTF-8
        // family names, so no provider opens it.
        throw Error('Unsupported Artemis legacy/system font face');
      }
      const previous = renderer!.current;
      if (!previous) return null;
      const font = await open(previous);
      if (!font) throw Error('Artemis glyph provider no longer opens');
      return {provider: previous, font};
    };
    const mainFont = await select(false);
    this.assertOpen();
    const rubyFont = await select(true);
    this.assertOpen();
    const stream = async (
      symbols: string[],
      ruby: boolean,
    ): Promise<ArtemisBlockGlyph<ArtemisTextGlyphResource>[]> => {
      const selected = ruby ? rubyFont : mainFont;
      if (selected === undefined) return [];
      if (selected === null)
        return symbols.map((symbol) => {
          const glyph = emptyGlyph(symbol.codePointAt(0)!);
          return {glyph, advance: 0};
        });
      const {provider, font} = selected;
      const shadow = ruby ? snapshot.rubyshadow : snapshot.shadow,
        outline = ruby ? snapshot.rubyoutline : snapshot.outline;
      // Glyph jobs overlap in a bounded window instead of one worker round trip per
      // glyph; main and ruby together stay below the 64-job font and paint budgets.
      const pending: Promise<ArtemisTextGlyphResource>[] = [];
      for (const symbol of symbols) {
        if (pending.length >= glyphWindow) await pending[pending.length - glyphWindow];
        this.assertOpen();
        const codePoint = symbol.codePointAt(0)!;
        const key = JSON.stringify([
          provider.kind,
          provider.path,
          provider.size,
          provider.styleBits,
          snapshot.styleBits,
          shadow,
          outline,
          snapshot.color,
          snapshot.shadowcolor,
          snapshot.outlinecolor,
          codePoint,
        ]);
        let cached = this.glyphs.get(key);
        if (cached) {
          this.glyphs.delete(key);
          this.glyphs.set(key, cached);
        } else {
          const entry: Cached = {
            bytes: 0,
            promise: Promise.resolve().then(async () => {
              const nativeStyle = nativeFontStyle(provider.styleBits, snapshot.styleBits);
              const restored = this.restored?.get({
                face: provider.path,
                size: provider.size,
                shadow,
                outline,
                color: snapshot.color,
                shadowColor: snapshot.shadowcolor,
                outlineColor: snapshot.outlinecolor,
                style: nativeStyle,
                codePoint,
              });
              if (restored) {
                entry.bytes = restored.image?.pixels.byteLength ?? 0;
                if (this.glyphs.get(key) === entry) {
                  this.cachedBytes += entry.bytes;
                  this.trim();
                }
                return Object.freeze({codePoint, surface: restored});
              }
              let glyph = await font.glyph(
                artemisRevision(this.hash).glyphGeometry === 'clipped-cell'
                  ? codePoint & 65535
                  : codePoint,
              );
              this.assertOpen();
              if (!glyph) return emptyGlyph(codePoint);
              if (
                artemisRevision(this.hash).glyphGeometry === 'clipped-cell' &&
                provider.kind === 'file'
              )
                glyph = artemisClippedCellGlyph(glyph, font.metrics.size);
              const surface = await this.painter.paint(glyph, {
                shadow,
                outline,
                color: snapshot.color,
                shadowColor: snapshot.shadowcolor,
                outlineColor: snapshot.outlinecolor,
                underline: !!(snapshot.styleBits & 32),
                strikeout: !!(snapshot.styleBits & 64),
                decorationMetrics: font.metrics,
              });
              this.assertOpen();
              const result =
                artemisRevision(this.hash).glyphGeometry === 'clipped-cell'
                  ? {...surface, left: 0, top: 0, advance: surface.image?.width ?? surface.advance}
                  : surface;
              entry.bytes = surface.image?.pixels.byteLength ?? 0;
              if (this.glyphs.get(key) === entry) {
                this.cachedBytes += entry.bytes;
                this.trim();
              }
              return Object.freeze({codePoint, surface: result});
            }),
          };
          entry.promise.catch(() => {
            if (this.glyphs.get(key) === entry) this.glyphs.delete(key);
          });
          this.glyphs.set(key, entry);
          this.trim();
          cached = entry;
        }
        pending.push(cached.promise);
      }
      const glyphs = await Promise.all(pending);
      return glyphs.map((glyph) => ({glyph, advance: glyph.surface.advance}));
    };
    // Size changes are atomic in each worker job; simultaneous main/ruby owners
    // can safely borrow one file face without drawing at another stream's size.
    const [main, ruby] = await Promise.all([stream(mainSymbols, false), stream(rubySymbols, true)]);
    this.assertOpen();
    return layoutArtemisTextBlock(this.hash, main, ruby, snapshot);
  }
  private font(path: string, size: number, styleBits: number): Promise<ArtemisFileFont> {
    const key = JSON.stringify([path, size, styleBits & 24]);
    let font = this.fonts.get(key);
    if (!font) {
      if (this.fonts.size >= 128) throw Error('Artemis text font budget exceeded');
      font = this.fontOwner.load(path, size, styleBits);
      this.fonts.set(key, font);
      font.catch(() => {
        if (this.fonts.get(key) === font) this.fonts.delete(key);
      });
    }
    return font;
  }
  private trim(): void {
    while (this.glyphs.size > 512 || this.cachedBytes > 10 * 1024 * 1024) {
      const [key, entry] = this.glyphs.entries().next().value!;
      this.glyphs.delete(key);
      this.cachedBytes -= entry.bytes;
    }
  }
  private assertOpen(): void {
    if (this.closed) throw Error('Artemis text glyphs closed');
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.restored?.close();
    this.glyphs.clear();
    this.cachedBytes = 0;
    const fonts = [...this.fonts.values()];
    this.fonts.clear();
    const results = await Promise.allSettled(
      fonts.map(async (promise) => {
        let font: ArtemisFileFont;
        try {
          font = await promise;
        } catch {
          return;
        }
        await font.close();
      }),
    );
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
}

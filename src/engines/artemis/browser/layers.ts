import type {AsbTag} from '../../../formats/artemis/asb.js';
import type {DrawListTarget} from '../../../graphics/draw-list.js';
import type {TriangleImage} from '../../../graphics/triangle-draw.js';
import type {ArtemisImageSource} from '../image-loader.js';
import {
  ArtemisImageGraphics,
  type ArtemisDisplayActor,
  type ArtemisImageShaderPrograms,
  type ArtemisTextCell,
  type ArtemisTextSource,
  type ArtemisTextSprite,
} from '../image-graphics.js';
import type {ArtemisRasterPolicy} from '../gpu-raster.js';
import {ArtemisLayerOwner, type ArtemisMessageActorOwner} from '../layer-owner.js';
import type {ArtemisRuleImage} from '../transition.js';
import type {ArtemisMessageResource, ArtemisRuntimeLayerHost} from '../runtime.js';
import type {ArtemisRuntimeGlyphOwner} from '../runtime-glyphs.js';
import {workerTheoraThreads} from '../video-thread-client.js';
import {luaText, type Lua51} from '../../../core/lua51/runtime.js';

/** The script's custom cursor is a live stage overlay. Read only its configured ID,
 * without copying the full csv table or assuming a game-specific layer name. */
export function artemisCursorLayer(vm: Lua51): string | null {
  let reference = vm.referenceGlobal('csv');
  try {
    for (const key of ['mw', 'cursor', 'id']) {
      if (reference.type !== 5) return null;
      const next = reference.get(key);
      reference.release();
      reference = next;
    }
    const value = reference.read();
    const id =
      value instanceof Uint8Array
        ? luaText(value)
        : typeof value === 'number' && Number.isFinite(value)
          ? String(value)
          : '';
    return id.split('\0', 1)[0] || null;
  } finally {
    reference.release();
  }
}

export interface ArtemisBrowserLayerOptions {
  readonly executableSha256: string;
  readonly target: DrawListTarget;
  readonly raster: ArtemisRasterPolicy;
  /** The surface manager: layer images share its cache and loans. */
  readonly images: ArtemisImageSource;
  readonly runMode: ArtemisRuntimeLayerHost;
  loadRule(path: string): Promise<ArtemisRuleImage | null>;
  readVideoFile(path: string): Promise<Uint8Array | null>;
  /** timeGetTime of the presentation clock (animation and video layers). */
  readonly clock: {now(): number};
  readonly shaderPrograms?: ArtemisImageShaderPrograms;
  /** Message-layer text. */
  readonly glyphs: ArtemisRuntimeGlyphOwner;
  /** Display properties of an animated glyph or block. */
  textProperties(key: object): ReadonlyMap<string, number> | undefined;
  /** Native script error reports (c7260) of failed layer resources; the layer stays. */
  report(message: string): void;
}

export type ArtemisBrowserLayers = ArtemisLayerOwner<
  ArtemisDisplayActor,
  TriangleImage,
  ArtemisMessageResource
>;

const f = Math.fround;
const property = (values: ReadonlyMap<string, number> | undefined, name: string, base: number) =>
  values?.get(name) ?? base;

/** Each displayed glyph of a message layer with its display tweens: the glyph and block
 * `xscale`, `yscale` and `rotate` (degrees) combined, the `left`/`top` offsets added and
 * `alpha` multiplied into the font opacity. Invisible fonts show nothing. */
function* displayedGlyphs(
  options: Pick<ArtemisBrowserLayerOptions, 'glyphs' | 'textProperties'>,
  message: ArtemisMessageResource,
) {
  const insertion = options.glyphs.peek(message);
  if (!insertion) return;
  let lineIndex = 0,
    blockIndex = 0;
  for (const line of insertion.displayLines()) {
    for (const positioned of line.geometry.blocks) {
      const block = positioned.block,
        blockValues = options.textProperties(block);
      for (const [ruby, glyph] of [
        ...block.main.map((glyph) => [false, glyph] as const),
        ...block.ruby.map((glyph) => [true, glyph] as const),
      ]) {
        const resource = glyph.glyph,
          font = resource.font;
        if (!font.visible) continue;
        const values = options.textProperties(resource);
        const xscale = f(property(values, 'xscale', 1) * property(blockValues, 'xscale', 1)),
          yscale = f(property(values, 'yscale', 1) * property(blockValues, 'yscale', 1)),
          radians =
            ((property(values, 'rotate', 0) + property(blockValues, 'rotate', 0)) * Math.PI) / 180;
        yield {
          line,
          lineIndex,
          blockIndex,
          positioned,
          glyph,
          resource,
          font,
          ruby,
          xscale,
          yscale,
          cos: Math.cos(radians),
          sin: Math.sin(radians),
          left: property(values, 'left', 0),
          blockLeft: property(blockValues, 'left', 0),
          top: property(values, 'top', 0),
          blockTop: property(blockValues, 'top', 0),
          alpha: f(
            font.alpha *
              font.entirealpha *
              property(values, 'alpha', 1) *
              property(blockValues, 'alpha', 1),
          ),
        };
      }
      blockIndex++;
    }
    lineIndex++;
  }
}

/** Glyph sprites of a message layer. Each glyph keeps the font attributes it was inserted
 * with: `left`/`top` place the text in the layer and `alpha` multiplies the entire and
 * per-glyph opacity; invisible fonts draw nothing. Text display tweens offset glyphs and
 * blocks (`left`, `top`), scale and rotate them about the glyph origin and multiply their
 * opacity. */
export function artemisTextSprites(
  options: Pick<ArtemisBrowserLayerOptions, 'glyphs' | 'textProperties'>,
  message: ArtemisMessageResource,
): ArtemisTextSprite[] {
  const sprites: ArtemisTextSprite[] = [];
  for (const shown of displayedGlyphs(options, message)) {
    const {line, positioned, glyph, font, xscale, yscale, cos, sin} = shown,
      surface = shown.resource.surface,
      image = surface.image;
    if (!image) continue;
    const x = f(font.left + positioned.x + glyph.x + surface.left + shown.left + shown.blockLeft),
      y = f(font.top + line.y + positioned.y + glyph.y + surface.top + shown.top + shown.blockTop);
    sprites.push({
      image,
      matrix: new Float32Array([
        f(cos * xscale),
        f(-sin * yscale),
        x,
        f(sin * xscale),
        f(cos * yscale),
        y,
      ]),
      alpha: shown.alpha,
    });
  }
  return sprites;
}

/** The characters of a message layer for browser text, with the sprites' display tweens.
 * A cell's origin is the glyph's pen position at the top of its stream's em box. */
export function artemisTextCells(
  options: Pick<ArtemisBrowserLayerOptions, 'glyphs' | 'textProperties'>,
  message: ArtemisMessageResource,
): ArtemisTextCell[] {
  const cells: ArtemisTextCell[] = [];
  for (const shown of displayedGlyphs(options, message)) {
    const {line, positioned, glyph, font, ruby, xscale, yscale, cos, sin} = shown;
    const face = ruby ? font.rubyface : font.face;
    cells.push({
      text: String.fromCodePoint(shown.resource.codePoint),
      matrix: new Float32Array([
        f(cos * xscale),
        f(-sin * yscale),
        f(font.left + positioned.x + glyph.x + shown.left + shown.blockLeft),
        f(sin * xscale),
        f(cos * yscale),
        f(font.top + line.y + positioned.y + glyph.y + shown.top + shown.blockTop),
      ]),
      advance: glyph.advance,
      size: (ruby ? font.rubysize : font.size) & 255,
      face: typeof face === 'string' ? face.split('\0', 1)[0]! : null,
      bold: !!(font.styleBits & 8),
      italic: !!(font.styleBits & 16),
      color: font.color,
      alpha: shown.alpha,
      shadow: ruby ? font.rubyshadow : font.shadow,
      shadowcolor: font.shadowcolor,
      outline: ruby ? font.rubyoutline : font.outline,
      outlinecolor: font.outlinecolor,
      ruby,
      line: shown.lineIndex,
      block: shown.blockIndex,
    });
  }
  return cells;
}

function textSource(
  options: ArtemisBrowserLayerOptions,
  message: ArtemisMessageResource,
  owner: ArtemisMessageActorOwner<ArtemisMessageResource>,
): ArtemisTextSource {
  let revision = 0,
    previous: ArtemisTextSprite[] = [];
  const sprites = () => {
    // Native insertion is synchronous: frames during an asynchronous glyph load keep the
    // text from before the insertion.
    if (options.glyphs.peek(message)?.busy) return previous;
    const next = artemisTextSprites(options, message);
    const same =
      next.length === previous.length &&
      next.every(
        (sprite, index) =>
          sprite.image === previous[index]!.image &&
          sprite.alpha === previous[index]!.alpha &&
          sprite.matrix.every((value, entry) => value === previous[index]!.matrix[entry]),
      );
    if (!same) revision++;
    previous = next;
    return next;
  };
  let previousCells: ArtemisTextCell[] = [];
  return {
    // Sprites are compared with the previous sample: insertion, clearing and display
    // tweens all change them.
    get revision() {
      sprites();
      return revision;
    },
    sprites,
    cells: () =>
      options.glyphs.peek(message)?.busy
        ? previousCells
        : (previousCells = artemisTextCells(options, message)),
    retain: () => owner.retain(message),
    release: () => owner.release(message),
  };
}

/** The browser layer system: image, group, animation, video, E-mote and message-layer actors
 * drawn through the shared raster target. Layer images load through the surface manager
 * so they share its cache and loans. */
export function createArtemisBrowserLayers(options: ArtemisBrowserLayerOptions): {
  readonly owner: ArtemisBrowserLayers;
  readonly graphics: ArtemisImageGraphics;
} {
  let graphics: ArtemisImageGraphics | undefined;
  const name = (tag: AsbTag, key: string) => tag.args.get(key) ?? '';
  const owner: ArtemisBrowserLayers = new ArtemisLayerOwner<
    ArtemisDisplayActor,
    TriangleImage,
    ArtemisMessageResource
  >(options.executableSha256, {
    createGraphics: (registry) =>
      (graphics = new ArtemisImageGraphics(
        options.executableSha256,
        options.target,
        {
          creationMode: () => 0,
          clearLayerCommands: (ids) => registry.clearLayerCommands(ids),
          resetLayerCommands: (id, tag) => registry.resetLayerCommands(id, tag),
          recordLayerProperties: (tag) => registry.recordLayerProperties(tag),
          appendLayerCommand: (id, tag) => registry.appendLayerCommand!(id, tag),
          imageLoadFailed: (tag) => options.report(`Image not found: ${name(tag, 'file')}`),
          layerNotFound: (tag) => options.report(`Layer not found: ${name(tag, 'id')}`),
          animationError: (tag, error) =>
            options.report(
              `Animation ${error === 'mode' ? 'mode error' : 'not found'}: ${name(tag, 'id')}`,
            ),
          readVideoFile: (path) => options.readVideoFile(path),
          videoThreads: workerTheoraThreads(),
          videoError: (tag, error) =>
            options.report(
              `Video ${error === 'unsupported' ? 'unsupported' : 'not found'}: ${name(tag, 'file')}`,
            ),
        },
        options.raster,
        options.shaderPrograms,
        options.clock,
      )),
    images: options.images,
    runMode: options.runMode,
    loadRule: (path) => options.loadRule(path),
    createMessageActor: (message, messageOwner) =>
      graphics!.createTextLayer(textSource(options, message, messageOwner)),
    applyTweenProperties: (id, actor, patch) => graphics!.applyImageProperties(id, actor, patch),
    videoOf: (actor) => graphics!.videoOf(actor),
    emoteOf: (actor) => graphics!.emoteOf(actor),
    displayOf: (actor) => actor.display,
    layerInfo: (actor) => graphics!.layerInfo(actor),
  });
  return {owner, graphics: graphics!};
}

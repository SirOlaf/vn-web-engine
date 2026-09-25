import {
  allocateAokanaBitmap,
  aokanaBitmapFormatsCompatible,
  aokanaBitmapRectangle,
  cropAokanaBitmap,
  fillAokanaBitmap,
  intersectAokanaBitmapRectangle,
  translateAokanaBitmapRectangle,
  type AokanaBitmap,
  type AokanaBitmapRectangle,
} from './bitmap.js';
import {clearAokanaBitmap, copyAokanaBitmapRows} from './bitmap-copy.js';
import {AokanaDisplayObject, type AokanaDisplayPoint} from './display-object.js';
import {AokanaWindowDisplayState} from './display-window-state.js';
import {AokanaMemoryDx} from './memory-dx.js';
import {configureAokanaOwnedBitmap} from './owned-bitmap.js';
import {AokanaInnerDisplayObjectManager} from './object-manager.js';
import {AokanaDisplaySprite} from './display-sprite.js';

const emptyBitmap = (): AokanaBitmap => ({
  storage: null,
  offset: 0,
  stride: 0,
  width: 0,
  height: 0,
  format: 0,
  bytesPerPixel: 0,
});

interface WindowLayer {
  readonly owner: AokanaMemoryDx;
  readonly bitmap: AokanaBitmap;
  enabled: number;
  x: number;
  y: number;
  transparency: number;
}

/** CDspObjWindow, constructor 0691a0 and vtable 17d838. Its descriptor storage is
 * distinct from the base object's geometry and from the optional local object manager. */
export class AokanaWindowDisplayObject extends AokanaDisplayObject {
  private ready = 0;
  private configuredWidth: number | undefined;
  private configuredHeight: number | undefined;
  private readonly composedOwner = new AokanaMemoryDx();
  private readonly backgroundOwner = new AokanaMemoryDx();
  private readonly textOwner = new AokanaMemoryDx();
  private readonly composed = emptyBitmap();
  private readonly background = emptyBitmap();
  private readonly text = emptyBitmap();
  private backup = emptyBitmap();
  private backgroundEnabled = 0;
  private textEnabled = 0;
  private textTransparency = 0;
  private textMaskMode = 0;
  private textRectangle: AokanaBitmapRectangle | null = null;
  private cursor: AokanaDisplayPoint | null = null;
  private readonly layers: WindowLayer[] = Array.from({length: 8}, () => ({
    owner: new AokanaMemoryDx(),
    bitmap: emptyBitmap(),
    enabled: 0,
    x: 0,
    y: 0,
    transparency: 0,
  }));
  private order = [0, 1, 2];
  private inner: AokanaInnerDisplayObjectManager | null = null;
  private innerObjects: (AokanaDisplayObject | null)[] = [];
  private innerOrigin: AokanaDisplayPoint | null = null;
  private innerProjection: number | undefined;
  fontId = 0;
  characterSpacing = 0;
  fontSize = 0;
  fontWidth: number | undefined;
  lineSpacing = 0;
  extendTextRight = 0;
  writingDirection = 0;
  alignment = 0;
  lineExtent = 0;
  private customTextParametersEnabled = 0;
  private customTextParameters: Uint32Array | null = null;

  constructor(
    readonly windowState: AokanaWindowDisplayState,
    depthOrder: number,
  ) {
    super(windowState.manager.environment, 3, depthOrder, 1);
    this.blendMode = 1;
    this.blendValue = 0;
    // Native constructor composition calls all return while +178 is zero.
    // Its text cursor becomes defined when 068ec0 supplies the actual rectangle.
  }

  get initialized(): number {
    this.check();
    return this.ready;
  }
  get compositionBitmap(): AokanaBitmap {
    this.check();
    return {...this.composed};
  }
  get backgroundBitmap(): AokanaBitmap {
    this.check();
    return {...this.background};
  }
  get textBitmap(): AokanaBitmap {
    this.check();
    return {...this.text};
  }

  /** 0670c0 crops both local descriptors with the composed bitmap's native bounds. */
  copyCompositionTo(destination: AokanaBitmap): number {
    this.check();
    if (this.ready === 0) return 0;
    const target = {...destination},
      source = {...this.composed};
    const targetBounds = aokanaBitmapRectangle(target),
      sourceBounds = aokanaBitmapRectangle(source);
    intersectAokanaBitmapRectangle(targetBounds, sourceBounds);
    cropAokanaBitmap(target, sourceBounds);
    cropAokanaBitmap(source, sourceBounds);
    this.environment.compositor.copy(target, source);
    return this.ready;
  }

  /** 068d90's unused sixth argument does not update CDspObj's transparency field. */
  configureDisplay(x: number, y: number, mode: number, blendValue: number, layer: number): void {
    this.move(x, y);
    this.blendMode = mode >>> 0;
    this.setBlendValue(blendValue);
    this.setLayer(layer);
  }

  /** 068ec0 interprets small dimensions as 32-pixel units, independently on each axis. */
  configureInitial(width: number, height: number): 0 | 1 {
    this.check();
    this.ready = 0;
    width >>>= 0;
    height >>>= 0;
    if (width < 32) width = (width << 5) >>> 0;
    if (height < 20) height = (height << 5) >>> 0;
    if (width === 0 || width > 8192 || height === 0 || height > 32768) return 0;
    this.configuredWidth = width;
    this.configuredHeight = height;
    const compositor = this.environment.compositor;
    configureAokanaOwnedBitmap(this.composedOwner, this.composed, width, height, compositor);
    this.setBackgroundEnabled(0);
    configureAokanaOwnedBitmap(this.backgroundOwner, this.background, width, height, compositor);
    clearAokanaBitmap(this.background);
    this.setTextEnabled(0);
    configureAokanaOwnedBitmap(this.textOwner, this.text, width, height, compositor);
    this.textRectangle = aokanaBitmapRectangle(this.text);
    this.resetTextCursor();
    this.clearText();
    this.ready = this.configureGeometry(width, height);
    return this.ready as 0 | 1;
  }

  /** 0690d0 disposes the three image owners and overlays before the local manager and base. */
  override dispose(): void {
    this.check();
    this.composedOwner.dispose();
    this.backgroundOwner.dispose();
    this.textOwner.dispose();
    this.backup.storage?.release();
    for (const layer of this.layers) layer.owner.dispose();
    this.configureInnerObjects(0);
    super.dispose();
  }

  /** 069010 applies the shared window fade after CDspObj's effective blend calculation. */
  override draw(destination: AokanaBitmap, rectangle: AokanaBitmapRectangle, _key: number): void {
    this.check();
    if (this.windowState.enabled === 0) return;
    const source = {...this.composed};
    cropAokanaBitmap(source, rectangle);
    const transparency =
      (256 -
        (Math.imul(256 - this.effectiveBlendValue(), 256 - this.windowState.transparency) >>>
          8)) >>>
      0;
    this.environment.compositor.composite(destination, source, this.blendMode, transparency, true);
  }

  /** 066d30 composes only the clipped destination, but passes the original damage to inner objects. */
  composeRectangle(rectangle: AokanaBitmapRectangle): number {
    this.check();
    if (this.ready === 0) return 0;
    const clipped = {...rectangle};
    if (!intersectAokanaBitmapRectangle(clipped, aokanaBitmapRectangle(this.composed)))
      return this.ready;
    const destination = {...this.composed},
      compositor = this.environment.compositor;
    cropAokanaBitmap(destination, clipped);
    for (const stage of this.order) {
      if (stage === 0) {
        if (this.backgroundEnabled === 0) clearAokanaBitmap(destination);
        else {
          const background = {...this.background};
          cropAokanaBitmap(background, clipped);
          compositor.composite(destination, background, 0x80, 0, true);
        }
      } else if (stage === 1) {
        if (this.textEnabled !== 0) {
          const text = {...this.text};
          cropAokanaBitmap(text, clipped);
          if (this.textMaskMode === 0)
            compositor.composite(destination, text, 1, this.textTransparency, true);
          else {
            const temporary = allocateAokanaBitmap(text.width, text.height, 1);
            compositor.composite(temporary, text, 0x80, 0, true);
            for (const layer of this.layers)
              if (layer.enabled !== 0 && layer.bitmap.storage !== null)
                compositor.draw(
                  temporary,
                  (layer.x - clipped.left) | 0,
                  (layer.y - clipped.top) | 0,
                  layer.bitmap,
                  0x40,
                  1,
                );
            compositor.composite(destination, temporary, 1, this.textTransparency, true);
            temporary.storage?.release();
          }
        }
        for (const layer of this.layers)
          if (layer.enabled !== 0 && layer.bitmap.storage !== null)
            compositor.draw(
              destination,
              (layer.x - clipped.left) | 0,
              (layer.y - clipped.top) | 0,
              layer.bitmap,
              1,
              layer.transparency,
            );
      } else if (stage === 2 && this.inner !== null) {
        this.inner.damage.record(0, rectangle);
        this.inner.renderer.drawDamage();
      }
    }
    return this.ready;
  }
  /** 067090. */
  composeAll(): number {
    this.check();
    return this.ready === 0 ? 0 : this.composeRectangle(aokanaBitmapRectangle(this.composed));
  }
  /** 066cf0. */
  private composeImageArea(x: number, y: number, bitmap: AokanaBitmap): void {
    const rectangle = aokanaBitmapRectangle(bitmap);
    translateAokanaBitmapRectangle(rectangle, x, y);
    this.composeRectangle(rectangle);
  }
  private overlay(index: number): WindowLayer {
    this.check();
    const layer = this.layers[index | 0];
    if (layer === undefined)
      throw new RangeError('Aokana window overlay indexes outside native storage');
    return layer;
  }
  /** 066c70 temporarily substitutes the selected overlay's enabled field while recomposing it. */
  private composeLayer(index: number, temporaryEnabled: number): boolean {
    index |= 0;
    if (index >= 8) return false;
    const layer = this.overlay(index),
      previous = layer.enabled;
    if (previous !== 0 && layer.bitmap.storage !== null) {
      layer.enabled = temporaryEnabled | 0;
      this.composeImageArea(layer.x, layer.y, layer.bitmap);
      layer.enabled = previous;
    }
    return true;
  }
  /** 068250 validates against the shared default format, then preserves the source's own format. */
  setOverlayBitmap(index: number, source: AokanaBitmap): 0 | 4 {
    const compositor = this.environment.compositor;
    if (!aokanaBitmapFormatsCompatible(compositor.defaultFormat, source.format)) return 4;
    this.composeLayer(index, 0);
    const layer = this.overlay(index);
    configureAokanaOwnedBitmap(
      layer.owner,
      layer.bitmap,
      source.width,
      source.height,
      compositor,
      source,
    );
    compositor.composite(layer.bitmap, source, 0x80, 0, true);
    this.composeLayer(index, 1);
    return 0;
  }
  /** 068320. */
  setOverlayPosition(index: number, x: number, y: number, transparency: number): void {
    this.composeLayer(index, 0);
    const layer = this.overlay(index);
    layer.x = x | 0;
    layer.y = y | 0;
    layer.transparency = transparency >>> 0;
    this.composeLayer(index, 1);
  }
  /** 0683a0. */
  setOverlayEnabled(index: number, enabled: number): void {
    this.composeLayer(index, 0);
    this.overlay(index).enabled = enabled | 0;
    this.composeLayer(index, 1);
  }
  /** 068210. */
  disableOverlays(): void {
    for (let index = 0; index < 8; index++) this.setOverlayEnabled(index, 0);
  }
  /** 067870. */
  overlayRectangle(index: number): AokanaBitmapRectangle | null {
    const layer = this.overlay(index);
    if (layer.enabled === 0 || layer.bitmap.storage === null) return null;
    const rectangle = aokanaBitmapRectangle(layer.bitmap),
      position = this.effectivePosition();
    translateAokanaBitmapRectangle(
      rectangle,
      (position.x + layer.x) | 0,
      (position.y + layer.y) | 0,
    );
    return rectangle;
  }

  /** 068d50, 068d70 recompute immediately; 068b70 and 068b60 only update their fields. */
  setBackgroundEnabled(value: number): void {
    this.check();
    this.backgroundEnabled = value | 0;
    this.composeAll();
  }
  setTextMaskMode(value: number): void {
    this.check();
    this.textMaskMode = value | 0;
    this.composeAll();
  }
  setTextEnabled(value: number): void {
    this.check();
    this.textEnabled = value | 0;
  }
  setTextTransparency(value: number): void {
    this.check();
    this.textTransparency = value >>> 0;
  }
  /** 068de0. A surface of -1 clears and disables the background. */
  setBackgroundSurface(surface: number): 0 | 1 | 2 {
    this.check();
    if (this.ready === 0) return 1;
    surface |= 0;
    if (surface === -1) clearAokanaBitmap(this.background);
    else {
      const source = this.windowState.manager.surfaces.snapshot(surface);
      if (source === null) return 2;
      clearAokanaBitmap(this.background);
      this.environment.compositor.draw(this.background, 0, 0, source, 0x80, 0);
    }
    this.setBackgroundEnabled(surface === -1 ? 0 : 1);
    this.composeAll();
    return 0;
  }
  /** 068d00 fills the stored background without changing its enabled field. */
  fillBackground(color: number): 0 | 1 {
    this.check();
    if (this.ready === 0) return 1;
    fillAokanaBitmap(this.background, color >>> 0);
    this.composeAll();
    return 0;
  }
  /** 068b80. The output rectangle is written only after a successful composite. */
  drawBackgroundSurface(
    output: AokanaBitmapRectangle,
    x: number,
    y: number,
    surface: number,
    mode: number,
    transparency: number,
  ): number {
    this.check();
    if (this.ready === 0) return 1;
    const source = this.windowState.manager.surfaces.snapshot(surface);
    if (source === null) return 2;
    const result = this.environment.compositor.draw(
      this.background,
      x,
      y,
      source,
      mode,
      transparency,
    );
    if (result !== 0) return result + 3;
    Object.assign(output, aokanaBitmapRectangle(this.background));
    const area = aokanaBitmapRectangle(source);
    translateAokanaBitmapRectangle(area, x, y);
    intersectAokanaBitmapRectangle(output, area);
    const position = this.effectivePosition();
    translateAokanaBitmapRectangle(output, position.x, position.y);
    this.composeImageArea(x, y, source);
    return 0;
  }

  /** 067980 copies the raw text rectangle. 067960 optionally extends its right edge. */
  getTextRectangle(extended = false): AokanaBitmapRectangle {
    this.check();
    if (this.textRectangle === null)
      throw new Error('Aokana window text rectangle is not initialized');
    const rectangle = {...this.textRectangle};
    if (extended && this.extendTextRight !== 0)
      rectangle.right = (rectangle.right + this.fontSize) | 0;
    return rectangle;
  }
  /** 068630 checks each edge independently; it does not sort or normalize them. */
  setTextRectangle(rectangle: AokanaBitmapRectangle): 0 | 1 {
    this.check();
    const {left, top, right, bottom} = rectangle;
    if (
      left < 0 ||
      right < 0 ||
      top < 0 ||
      bottom < 0 ||
      left >>> 0 >= this.text.width >>> 0 ||
      right >>> 0 >= this.text.width >>> 0 ||
      top >>> 0 >= this.text.height >>> 0 ||
      bottom >>> 0 >= this.text.height >>> 0
    )
      return 0;
    this.textRectangle = {left: left | 0, top: top | 0, right: right | 0, bottom: bottom | 0};
    this.resetTextCursor();
    return 1;
  }
  /** 0685f0. */
  setTextRegion(x: number, y: number, width: number, height: number): 0 | 1 {
    return this.setTextRectangle({
      left: x | 0,
      top: y | 0,
      right: (x + width - 1) | 0,
      bottom: (y + height - 1) | 0,
    });
  }
  /** 0675a0. The constructor reaches this before its text rectangle is defined. */
  resetTextCursor(): void {
    this.check();
    if (this.textRectangle === null) {
      this.cursor = null;
      return;
    }
    const {left, top, right} = this.textRectangle;
    if (this.writingDirection === 0) this.cursor = {x: left, y: top};
    else if (this.writingDirection === 1) this.cursor = {x: right, y: top};
  }
  getTextCursor(): AokanaDisplayPoint {
    this.check();
    if (this.cursor === null) throw new Error('Aokana window text cursor is not initialized');
    return {...this.cursor};
  }
  setTextCursor(x: number, y: number): void {
    this.check();
    this.cursor = {x: x | 0, y: y | 0};
  }
  /** 067490. */
  advanceTextCursor(distance: number): void {
    const point = this.getTextCursor();
    if (this.writingDirection === 0) point.x = (point.x + distance) | 0;
    else if (this.writingDirection === 1) point.y = (point.y + distance) | 0;
    this.cursor = point;
  }
  /** 0674c0. */
  textAdvanceFits(distance: number): number {
    const point = this.getTextCursor(),
      rectangle = this.getTextRectangle();
    if (this.writingDirection === 0)
      return ((point.x + (distance | 0)) | 0) <= ((rectangle.right + 1) | 0) ? 1 : 0;
    if (this.writingDirection === 1)
      return ((point.y + (distance | 0)) | 0) <= ((rectangle.bottom + 1) | 0) ? 1 : 0;
    throw new Error('Aokana window text fit returns an undefined native value');
  }
  /** 067650. */
  setWritingDirection(value: number): 0 | 1 {
    if (value >>> 0 >= 2) return 0;
    this.writingDirection = value >>> 0;
    this.resetTextCursor();
    return 1;
  }
  /** 067620. */
  setAlignment(value: number): 0 | 1 {
    this.check();
    if (value >>> 0 >= 3) return 0;
    this.alignment = value >>> 0;
    return 1;
  }
  /** 067750. */
  setLineSpacing(value: number): 0 | 1 {
    this.check();
    if (value >>> 0 >= 0x321) return 0;
    this.lineSpacing = value >>> 0;
    return 1;
  }
  /** 0676b0, 067690 and 067600 are raw per-window DWORD setters. */
  setCharacterSpacing(value: number): void {
    this.check();
    this.characterSpacing = value | 0;
  }
  setTextRightExtension(value: number): void {
    this.check();
    this.extendTextRight = value >>> 0;
  }
  setLineExtent(value: number): void {
    this.check();
    this.lineExtent = value | 0;
  }
  /** 067790 uses the shared font manager's output ID, including its initial zero write. */
  async configureFont(
    name: Uint8Array | null,
    size: number,
    widthPercent: number,
    bold: number,
  ): Promise<number> {
    this.check();
    this.fontId = 0;
    size |= 0;
    widthPercent |= 0;
    const selected = await this.windowState.manager.surfaces.fonts.get(
      name,
      size,
      widthPercent,
      bold,
    );
    this.fontId = selected.id >>> 0;
    if (selected.result !== 0) return selected.result;
    this.fontSize = size;
    this.lineExtent = size;
    this.fontWidth = Math.trunc(Math.imul(size, widthPercent) / 100);
    if (this.extendTextRight !== 0) {
      const rectangle = this.getTextRectangle(),
        limit = (this.text.width - 1 - this.fontWidth) | 0;
      if (limit < rectangle.right) {
        rectangle.right = limit;
        this.setTextRectangle(rectangle);
      }
    }
    return selected.result;
  }
  /** 067710 through 03ed40. The multiply wraps before the signed division. */
  textLineGap(): number {
    this.check();
    return Math.trunc(Math.imul(this.fontSize, this.lineSpacing) / 100);
  }
  /** 0676f0 combines the font cell size and the percentage-derived gap. */
  textLineAdvance(): number {
    return (this.textLineGap() + this.fontSize) | 0;
  }
  /** 0676c0 always uses the raw rectangle's height, including in vertical writing. */
  textLineCount(): number {
    const rectangle = this.getTextRectangle(),
      advance = this.textLineAdvance(),
      height = (rectangle.bottom - rectangle.top + 1) | 0;
    if (advance === 0 || (height === -2147483648 && advance === -1))
      throw new RangeError('Aokana window line count has an undefined native quotient');
    return Math.trunc(height / advance) | 0;
  }
  /** 067530 resets the inline coordinate to the raw region edge on each new line. */
  newTextLine(): 0 | 1 {
    const rectangle = this.getTextRectangle(),
      advance = this.textLineAdvance();
    if (this.writingDirection !== 0 && this.writingDirection !== 1) return 0;
    const cursor = this.getTextCursor();
    if (this.writingDirection === 0) {
      cursor.y = (cursor.y + advance) | 0;
      cursor.x = rectangle.left;
    } else {
      cursor.x = (cursor.x - advance) | 0;
      cursor.y = rectangle.top;
    }
    this.cursor = cursor;
    return 1;
  }
  /** 0673f0 checks the shared line-start offset without altering or resetting the cursor. */
  atTextLineStart(): 0 | 1 {
    const cursor = this.getTextCursor(),
      rectangle = this.getTextRectangle(),
      offset = this.windowState.textLayout.lineStartOffset;
    if (this.writingDirection === 0) return cursor.x === ((rectangle.left + offset) | 0) ? 1 : 0;
    if (this.writingDirection === 1) return cursor.y === ((rectangle.top + offset) | 0) ? 1 : 0;
    return 0;
  }
  /** 067340/067280 preserve the previous array when only its enabled flag is cleared. */
  setTextParameters(values: Uint32Array | null): void {
    this.check();
    this.customTextParametersEnabled = values === null ? 0 : 1;
    if (values !== null && values.length < 16)
      throw new RangeError('Aokana window text parameters need sixteen DWORDs');
    if (values !== null) this.customTextParameters = values.slice(0, 16);
  }
  getTextParameters(output: Uint32Array): number {
    this.check();
    if (this.customTextParametersEnabled === 0) return 0;
    output.set(this.customTextParameters!);
    return 1;
  }
  /** 067180 returns one even for a selector that leaves the current order unchanged. */
  setCompositionOrder(value: number): 1 {
    this.check();
    const order = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ][value >>> 0];
    if (order !== undefined) this.order = order;
    return 1;
  }

  /** 0685c0. */
  clearText(): void {
    this.check();
    clearAokanaBitmap(this.text);
    this.composeAll();
  }
  /** 068450/068400 store a separate owned copy, independently of subsequent composition. */
  saveText(): void {
    this.check();
    this.backup.storage?.release();
    this.backup = allocateAokanaBitmap(this.text.width, this.text.height, this.text.format);
    copyAokanaBitmapRows(this.backup, this.text);
  }
  restoreText(): 0 | 10 {
    this.check();
    if (this.text.width !== this.backup.width || this.text.height !== this.backup.height) return 10;
    copyAokanaBitmapRows(this.text, this.backup);
    return 0;
  }
  /** 0684b0 moves retained rows upward and clears the vacated part of the extended region. */
  scrollText(distance: number): boolean {
    this.check();
    distance |= 0;
    if (distance <= 0) return false;
    const region = this.getTextRectangle(true),
      cleared = {...region};
    if (distance < ((region.bottom - region.top + 1) | 0)) {
      const source = {...this.text};
      cleared.top = (region.top + distance) | 0;
      cropAokanaBitmap(source, cleared);
      this.environment.compositor.draw(this.text, region.left, region.top, source, 0x80, 0);
      cleared.top = (cleared.bottom - distance + 1) | 0;
    }
    clearAokanaBitmap(this.text, cleared);
    this.composeAll();
    return true;
  }
  /** 068950 draws inside the extended text region and returns screen-space damage on success. */
  drawTextBitmap(
    output: AokanaBitmapRectangle,
    x: number,
    y: number,
    source: AokanaBitmap,
    mode: number,
    transparency: number,
  ): number {
    this.check();
    const region = this.getTextRectangle(true),
      destination = {...this.text};
    cropAokanaBitmap(destination, region);
    const result = this.environment.compositor.draw(
      destination,
      (x - region.left) | 0,
      (y - region.top) | 0,
      source,
      mode,
      transparency,
    );
    if (result !== 0) return result + 3;
    Object.assign(output, region);
    const area = aokanaBitmapRectangle(source);
    translateAokanaBitmapRectangle(area, x, y);
    intersectAokanaBitmapRectangle(output, area);
    const position = this.effectivePosition();
    translateAokanaBitmapRectangle(output, position.x, position.y);
    this.composeImageArea(x, y, source);
    return 0;
  }
  /** 068ae0. */
  drawTextSurface(
    output: AokanaBitmapRectangle,
    x: number,
    y: number,
    surface: number,
    mode: number,
    transparency: number,
  ): number {
    const source = this.windowState.manager.surfaces.snapshot(surface);
    return source === null ? 2 : this.drawTextBitmap(output, x, y, source, mode, transparency);
  }
  /** 067910 reports the full text bitmap's rectangle, rather than the selected text subregion. */
  textBitmapRectangle(): AokanaBitmapRectangle {
    this.check();
    const rectangle = aokanaBitmapRectangle(this.text),
      point = this.effectivePosition();
    translateAokanaBitmapRectangle(rectangle, point.x, point.y);
    return rectangle;
  }

  /** 067D60 replaces one owned inner Sprite, then inserts only a configured object. */
  createInnerSprite(
    index: number,
    source: number,
    x: number,
    y: number,
    pivotX: number,
    pivotY: number,
    layer: number,
  ): 0 | 2 | 9 {
    this.check();
    index >>>= 0;
    if (index >= this.innerObjects.length) return 9;
    const previous = this.innerObjects[index]!;
    if (previous !== null) {
      this.inner!.lists.remove(previous);
      previous.dispose();
    }
    const sprite = new AokanaDisplaySprite(
      this.environment,
      this.windowState.manager.surfaces,
      index,
      0,
    );
    this.innerObjects[index] = sprite;
    sprite.usesGlobalOrigin = 0;
    if (this.innerOrigin === null || this.innerProjection === undefined)
      throw new Error('Aokana Window consumes unwritten inner projection');
    const result = sprite.initializeAffineBlend(
      ((this.innerOrigin.x + x) | 0) << 16,
      ((this.innerOrigin.y + y) | 0) << 16,
      0,
      {
        sourceSurface: source,
        secondarySurface: -1,
        mixValue: 0,
        blendSelector: 0,
        pivotX,
        pivotY,
        angle: 0,
        perspective: this.innerProjection,
        pivotPolicy: 0,
        sampling: 1,
      },
      0x20,
      0,
      layer,
    );
    if (result === 0) {
      sprite.setActivation(1);
      this.inner!.lists.insert(sprite);
      return 0;
    }
    sprite.dispose();
    this.innerObjects[index] = null;
    return 2;
  }

  /** 067A70 publishes the actual inner rectangle before composing and translating it. */
  composeInnerObject(output: AokanaBitmapRectangle, index: number): 0 | 1 {
    this.check();
    index >>>= 0;
    if (index >= this.innerObjects.length) return 0;
    const object = this.innerObjects[index]!;
    if (object === null) return 0;
    Object.assign(output, object.inputRectangle(0));
    this.composeRectangle(output);
    const point = this.effectivePosition();
    translateAokanaBitmapRectangle(output, point.x, point.y);
    return 1;
  }

  /** 0679D0 composes the old area while temporarily deactivating the inner object. */
  eraseInnerObject(output: AokanaBitmapRectangle, index: number): 0 | 1 {
    const object = this.innerSprite(index);
    if (object === null) return 0;
    object.setActivation(0);
    this.composeInnerObject(output, index);
    this.innerSprite(index)!.setActivation(1);
    return 1;
  }
  private innerSprite(index: number): AokanaDisplaySprite | null {
    this.check();
    index >>>= 0;
    if (index >= this.innerObjects.length) return null;
    const object = this.innerObjects[index]!;
    if (object !== null && !(object instanceof AokanaDisplaySprite))
      throw new Error('Aokana Window inner operation requires its actual Sprite');
    return object;
  }

  /** 067F30 rebases inner sprites after the shared descriptor changes, retaining
   * the window's own bitmaps. Native stores perspective after moving each sprite. */
  refreshDisplayGeometry(): void {
    this.check();
    if (this.innerObjects.length === 0) return;
    if (this.innerOrigin === null)
      throw new Error('Aokana Window consumes unwritten inner origin');
    const previous = this.innerOrigin,
      display = this.environment.displayBitmap();
    this.innerOrigin = {x: -(display.width >>> 1) | 0, y: -(display.height >>> 1) | 0};
    this.innerProjection = display.width >>> 1;
    for (let index = 0; index < this.innerObjects.length; index++) {
      const sprite = this.innerSprite(index);
      if (sprite === null) continue;
      const coordinates = sprite.coordinates();
      sprite.setCoordinates(
        (coordinates.x + ((this.innerOrigin.x - previous.x) << 16)) | 0,
        (coordinates.y + ((this.innerOrigin.y - previous.y) << 16)) | 0,
        coordinates.z,
      );
      sprite.setPerspective(this.innerProjection);
    }
  }

  /** 067B00. */
  setInnerLayer(index: number, layer: number): 0 | 9 {
    const object = this.innerSprite(index);
    if (object === null) return 9;
    object.setLayer(layer);
    this.inner!.lists.resort(this.innerSprite(index)!);
    return 0;
  }
  /** 067B90. */
  setInnerRotation(index: number, angle: number): 0 | 9 {
    const object = this.innerSprite(index);
    if (object === null) return 9;
    object.setAngle(angle);
    return 0;
  }
  /** 067BD0. */
  setInnerBlendValue(index: number, value: number): 0 | 9 {
    const object = this.innerSprite(index);
    if (object === null) return 9;
    object.setBlendValue(value);
    return 0;
  }
  /** 067C20. */
  setInnerCoordinates(index: number, x: number, y: number, z: number): 0 | 9 {
    const object = this.innerSprite(index);
    if (object === null) return 9;
    if (this.innerOrigin === null) throw new Error('Aokana Window consumes unwritten inner origin');
    object.setCoordinates((this.innerOrigin.x + x) << 16, (this.innerOrigin.y + y) << 16, z << 16);
    this.inner!.lists.resort(this.innerSprite(index)!);
    return 0;
  }
  /** 067CD0. */
  replaceInnerSource(index: number, source: number): 0 | 2 | 9 {
    const object = this.innerSprite(index);
    if (object === null) return 9;
    return object.replaceSource(source) === 0 ? 0 : 2;
  }
  /** 067D20 calls the nonvirtual secondary visibility owner. */
  setInnerVisibility(index: number, value: number): 0 | 9 {
    const object = this.innerSprite(index);
    if (object === null) return 9;
    AokanaDisplayObject.prototype.setSecondaryVisibility.call(object, value);
    return 0;
  }

  /** 068040 owns the inner array and local CObjectManager; no global display pool is created. */
  configureInnerObjects(count: number): void {
    this.check();
    count >>>= 0;
    for (const object of this.innerObjects) {
      this.inner!.lists.remove(object);
      object?.dispose();
    }
    this.inner?.dispose();
    this.innerObjects = Array<AokanaDisplayObject | null>(count).fill(null);
    if (count === 0) this.inner = null;
    else {
      const bitmap = {...this.composed},
        context = {bitmap, bounds: aokanaBitmapRectangle(bitmap)},
        manager = this.windowState.manager;
      this.inner = new AokanaInnerDisplayObjectManager(
        count,
        context,
        manager.surfaces,
        manager.effectors,
      );
      this.inner.clearDamage();
      const display = this.environment.displayBitmap();
      this.innerOrigin = {x: -(display.width >>> 1) | 0, y: -(display.height >>> 1) | 0};
      this.innerProjection = display.width >>> 1;
    }
  }
}

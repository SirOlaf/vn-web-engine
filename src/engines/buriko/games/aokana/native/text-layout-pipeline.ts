import type {AokanaBpPointer} from '../bp/memory.js';
import {
  allocateAokanaBitmap,
  aokanaBitmapRectangle,
  translateAokanaBitmapRectangle,
  type AokanaBitmap,
  type AokanaBitmapRectangle,
} from './bitmap.js';
import {clearAokanaBitmap} from './bitmap-copy.js';
import {AokanaWindowDisplayObject} from './display-window.js';
import type {AokanaWindowDisplayState} from './display-window-state.js';
import {rasterAokanaGlyph} from './font-bitmap.js';
import {drawAokanaCachedGlyphOutline} from './font-outline.js';
import type {AokanaFontRecord} from './fonts.js';
import {AokanaRubyAnnotations, type AokanaRubyAnnotation} from './text-annotations.js';
import {
  buildAokanaHorizontalTextLayout,
  measureAokanaHorizontalWideText,
  releaseAokanaHorizontalTextLayout,
  type AokanaHorizontalTextCursor,
  type AokanaHorizontalTextEffect,
  type AokanaHorizontalTextLayoutNode,
} from './text-layout-horizontal.js';
import type {AokanaTextLayoutState} from './text-layout-state.js';

export interface AokanaHorizontalTextLineOutput {
  value: number;
}

export const AOKANA_DEFAULT_HORIZONTAL_TEXT_EFFECT: AokanaHorizontalTextEffect = Object.freeze({
  mode: 0,
  radiusXPercent: 17,
  radiusYPercent: 17,
  color: 0,
  opacity: 192,
});

export const AOKANA_DISABLED_HORIZONTAL_TEXT_EFFECT: AokanaHorizontalTextEffect = Object.freeze({
  mode: 0,
  radiusXPercent: 0,
  radiusYPercent: 0,
  color: 0,
  opacity: 0,
});

function signedDivide(numerator: number, denominator: number): number {
  numerator |= 0;
  denominator |= 0;
  if (denominator === 0 || (numerator === -0x80000000 && denominator === -1))
    throw new RangeError('Aokana horizontal text pipeline integer division fault');
  return Math.trunc(numerator / denominator) | 0;
}

function unsignedDivide(numerator: number, denominator: number): number {
  numerator >>>= 0;
  denominator >>>= 0;
  if (denominator === 0)
    throw new RangeError('Aokana horizontal reading layout integer division fault');
  return Math.trunc(numerator / denominator) >>> 0;
}

function emptyBitmap(): AokanaBitmap {
  return {storage: null, offset: 0, stride: 0, width: 0, height: 0, format: 0, bytesPerPixel: 0};
}

function alphaBitmapFormat(state: AokanaTextLayoutState): number {
  const format = state.surfaces.compositor.defaultFormat;
  return format === 1 ? 2 : format;
}

function snapNearInteger(value: number): number {
  const floor = Math.floor(value),
    fraction = value - floor;
  if (1 - 2 ** -14 <= fraction) return Math.ceil(value);
  return fraction <= 2 ** -14 ? floor : value;
}

function copiedBitmap(state: AokanaTextLayoutState, source: AokanaBitmap): AokanaBitmap {
  const result = allocateAokanaBitmap(source.width, source.height, source.format);
  clearAokanaBitmap(result);
  state.surfaces.compositor.copy(result, source);
  return result;
}

function recolorAlpha(destination: AokanaBitmap, source: AokanaBitmap, color: number): void {
  if (destination.format !== 2 || source.format !== 2) return;
  for (let y = 0; y < source.height >>> 0; y++)
    for (let x = 0; x < source.width >>> 0; x++) {
      const input = source.offset + y * source.stride + x * 4,
        output = destination.offset + y * destination.stride + x * 4,
        sourceStorage = source.storage,
        destinationStorage = destination.storage;
      if (sourceStorage === null || destinationStorage === null)
        throw new TypeError('Aokana horizontal reading shadow dereferences a null bitmap');
      sourceStorage.range(input, 4, true);
      destinationStorage.range(output, 4, false);
      destinationStorage.view.setUint32(
        output,
        (sourceStorage.view.getUint32(input, true) & 0xff000000) | (color & 0xffffff),
        true,
      );
      destinationStorage.written(output, 4);
    }
}

function relink(nodes: readonly AokanaHorizontalTextLayoutNode[]): void {
  for (let index = 0; index < nodes.length; index++) nodes[index]!.next = nodes[index + 1] ?? null;
}

/** 077DF0 constructs the five-DWORD effect only for its ordinary accepted domain. */
export function createAokanaHorizontalTextEffect(
  mode: number,
  radiusXPercent: number,
  radiusYPercent: number,
  color: number,
  opacity: number,
): AokanaHorizontalTextEffect {
  mode |= 0;
  radiusXPercent >>>= 0;
  radiusYPercent >>>= 0;
  color >>>= 0;
  opacity >>>= 0;
  if (mode === 0) return {...AOKANA_DISABLED_HORIZONTAL_TEXT_EFFECT};
  if ((mode - 1) >>> 0 >= 2 || radiusXPercent >= 101 || radiusYPercent >= 101 || opacity >= 257)
    throw new RangeError('Aokana text effect leaves its native stack output undefined');
  return {mode, radiusXPercent, radiusYPercent, color, opacity};
}

function readingGlyphNodes(
  state: AokanaTextLayoutState,
  parent: AokanaHorizontalTextLayoutNode,
  annotation: AokanaRubyAnnotation,
  font: AokanaFontRecord,
  color: number,
  effect: AokanaHorizontalTextEffect,
  anchorX: number,
  anchorY: number,
): AokanaHorizontalTextLayoutNode[] {
  const fontSize = font.size | 0,
    radiusX = Math.max(1, signedDivide(Math.imul(effect.radiusXPercent, fontSize), 100)),
    radiusY = Math.max(1, signedDivide(Math.imul(effect.radiusYPercent, fontSize), 100)),
    cellWidth = signedDivide(Math.imul(font.widthPercent, fontSize), 100),
    sideBearing =
      state.proportionalSideBearing === 0
        ? -1
        : Math.imul(state.proportionalSideBearing, cellWidth) >> 16,
    zeroBearing = state.proportionalSideBearing === 0 ? -1 : 0,
    measured = measureAokanaHorizontalWideText(state, annotation.readingWide, font, 1),
    readingWider = (parent.annotationBaseExtent | 0) < (measured.total | 0),
    count = annotation.readingLength | 0;
  if (count <= 0)
    throw new RangeError('Aokana horizontal reading layout divides by an empty reading');

  let startX = anchorX | 0;
  if (readingWider)
    startX = (startX + (((parent.annotationBaseExtent | 0) - (measured.total | 0)) >> 1)) | 0;
  const perCharacter = (((parent.annotationBaseExtent | 0) + 1) | 0) / count;
  let effectWidth = 0,
    effectHeight = 0;
  if ((effect.mode | 0) === 1) {
    effectWidth = radiusX;
    effectHeight = radiusY;
  } else if ((effect.mode | 0) === 2) {
    effectWidth = Math.imul(radiusX, 2);
    effectHeight = Math.imul(radiusY, 2);
    startX = (startX - radiusX) | 0;
    anchorY = (anchorY - radiusY) | 0;
  }

  const revealStep = unsignedDivide(
      Math.imul(annotation.keyWideLength, state.field1C9100) >>> 0,
      count,
    ),
    format = alphaBitmapFormat(state);
  const raster = font.raster;
  if (raster === null)
    throw new Error('Aokana horizontal reading layout reads an uninitialized font raster');
  const scratch = allocateAokanaBitmap(Math.imul(fontSize, 3), Math.imul(fontSize, 2), format),
    nodes: AokanaHorizontalTextLayoutNode[] = [];
  let revealTime = ((revealStep >>> 1) + parent.revealTime) >>> 0,
    position = startX;
  try {
    for (let index = 0; index < count; index++) {
      clearAokanaBitmap(scratch);
      const character = annotation.codes[index];
      if (character === undefined)
        throw new RangeError('Aokana horizontal reading code exceeds its native array');
      const glyph = rasterAokanaGlyph(scratch, raster, character, color),
        abcTotal = glyph.abc[0] + glyph.abc[1] + glyph.abc[2];
      let x: number, advance: number;
      if (readingWider) {
        x = Math.trunc(snapNearInteger(position)) | 0;
        if (zeroBearing < 0)
          advance =
            (Math.trunc(glyph.abc[0] + 0.5) +
              Math.trunc(glyph.abc[1] + 0.5) +
              Math.trunc(glyph.abc[2] + 0.5)) |
            0;
        else {
          const glyphWidth = (glyph.right - glyph.left + 1) | 0,
            croppedWidth = Math.min(glyphWidth >>> 0, (scratch.width - glyph.left) >>> 0);
          advance = (croppedWidth + sideBearing) >>> 0;
        }
      } else {
        x = Math.trunc(snapNearInteger((perCharacter - abcTotal) * 0.5 + position + 0.5)) | 0;
        advance = perCharacter;
      }
      position += advance;

      const bitmapWidth = (Math.trunc(snapNearInteger(abcTotal + 1.5)) + effectWidth) | 0,
        bitmap = allocateAokanaBitmap(bitmapWidth, (fontSize + effectHeight) | 0, format),
        node: AokanaHorizontalTextLayoutNode = {
          procedureTime: 0,
          revealTime,
          procedureState: 0,
          interval: state.field1C90E8 >>> 0,
          x,
          y: anchorY | 0,
          annotationX: 0,
          annotationY: 0,
          fontSize: 0,
          bitmap,
          auxiliary: emptyBitmap(),
          annotationKey: null,
          annotationBaseExtent: 0,
          kind: 2,
          next: null,
          character,
          sourceIndex: parent.sourceIndex,
          line: parent.line,
        };
      clearAokanaBitmap(bitmap);
      if ((effect.mode | 0) === 0) state.surfaces.compositor.draw(bitmap, 0, 0, scratch, 0, 0);
      else if ((effect.mode | 0) === 1) {
        const shadow = allocateAokanaBitmap(scratch.width, scratch.height, format);
        clearAokanaBitmap(shadow);
        if (effect.color >>> 0 === 0) recolorAlpha(shadow, scratch, 0);
        else rasterAokanaGlyph(shadow, raster, character, effect.color);
        state.surfaces.compositor.draw(
          bitmap,
          radiusX,
          radiusY,
          shadow,
          1,
          (0x100 - effect.opacity) >>> 0,
        );
        shadow.storage?.release();
        state.surfaces.compositor.draw(bitmap, 0, 0, scratch, 0, 0);
      } else if ((effect.mode | 0) === 2) {
        const outline = allocateAokanaBitmap(bitmap.width, bitmap.height, format);
        clearAokanaBitmap(outline);
        drawAokanaCachedGlyphOutline(outline, character, font, radiusX, radiusY, effect.color);
        const previous = nodes.at(-1);
        if (previous?.auxiliary.storage !== null && previous?.auxiliary.storage !== undefined)
          state.surfaces.compositor.draw(
            outline,
            (previous.x - node.x + radiusX) | 0,
            (previous.y - node.y + radiusY) | 0,
            previous.auxiliary,
            7,
            0x100,
          );
        state.surfaces.compositor.draw(bitmap, 0, 0, outline, 1, (0x100 - effect.opacity) >>> 0);
        outline.storage?.release();
        state.surfaces.compositor.draw(bitmap, radiusX, radiusY, scratch, 0, 0);
        node.auxiliary = copiedBitmap(state, scratch);
      }
      nodes.push(node);
      revealTime = (revealTime + revealStep) >>> 0;
    }
  } finally {
    scratch.storage?.release();
  }
  relink(nodes);
  return nodes;
}

/** 074B00 creates the configured reading font and splices 074410's nodes after each parent. */
export async function addAokanaHorizontalReadings(
  state: AokanaTextLayoutState,
  nodes: AokanaHorizontalTextLayoutNode[],
  fontId: number,
  color: number,
  effect: AokanaHorizontalTextEffect,
  annotations: AokanaRubyAnnotations,
): Promise<0 | 1> {
  const base = state.surfaces.fonts.find(fontId);
  if (base === null) return 0;
  const size = state.readingSize(base.size),
    nameEnd = state.readingFontName.indexOf(0),
    configuredName = state.readingFontName.slice(
      0,
      nameEnd < 0 ? state.readingFontName.length : nameEnd,
    ),
    name = configuredName.length === 0 ? base.name : configuredName,
    width = state.readingWidth > 0 ? state.readingWidth : base.widthPercent,
    readingColor = state.readingValue1C90F8 === 0xffffffff ? color : state.readingValue1C90F8,
    readingEffect: AokanaHorizontalTextEffect = {
      ...effect,
      color: state.readingValue1C90F4 === 0xffffffff ? effect.color : state.readingValue1C90F4,
    },
    selected = await state.surfaces.fonts.get(name, size, width, base.bold);
  if (selected.result !== 0) return 0;
  const font = state.surfaces.fonts.find(selected.id);
  if (font === null)
    throw new Error('Aokana horizontal reading font creation did not publish its record');

  const originalNodes = [...nodes];
  for (const node of originalNodes) {
    if (node.annotationKey === null) continue;
    const annotation = annotations.query({bytes: node.annotationKey, offset: 0});
    if (annotation === null)
      throw new Error('Aokana prepared reading key is absent from its per-call registry');
    const y = (node.annotationY - size + state.readingYOffset) | 0,
      readings = readingGlyphNodes(
        state,
        node,
        annotation,
        font,
        readingColor,
        readingEffect,
        (node.annotationX + state.readingXOffset) | 0,
        y,
      );
    const parentIndex = nodes.indexOf(node);
    if (parentIndex < 0)
      throw new Error('Aokana horizontal reading parent left its prepared-node chain');
    if (readings.length !== 0) nodes.splice(parentIndex + 1, 0, ...readings);
    relink(nodes);
    annotations.remove({bytes: annotation.key, offset: 0}, 1);
  }
  annotations.clearInline();
  return 1;
}

/** 073950 groups ordinary nodes by Y and applies the native horizontal center/right offsets. */
export function alignAokanaHorizontalTextNodes(
  state: AokanaTextLayoutState,
  nodes: readonly AokanaHorizontalTextLayoutNode[],
  cursor: AokanaHorizontalTextCursor,
  rectangle: AokanaBitmapRectangle,
  fontId: number,
  wrapping: number,
  effect: AokanaHorizontalTextEffect,
  alignment: number,
): void {
  alignment |= 0;
  if (alignment === 0) return;
  const lines: {right: number; y: number}[] = [];
  let currentY = -0x80000000;
  for (const node of nodes) {
    if ((node.kind | 0) !== 0) continue;
    if ((node.y | 0) !== currentY) {
      currentY = node.y | 0;
      lines.push({right: -0x80000000, y: currentY});
    }
    const line = lines.at(-1)!,
      right = (node.x - 1 + node.bitmap.width) | 0;
    if (line.right < right) line.right = right;
  }
  const fontSize = state.surfaces.fonts.find(fontId)?.size ?? 0,
    firstOverlayHeight = state.overlayFrames?.[0]?.height ?? 0,
    readingInset = signedDivide(Math.imul(effect.radiusXPercent, fontSize), 100);
  let lineIndex = -1,
    lineY = -0x80000000,
    offset = 0;
  for (const node of nodes) {
    if ((node.kind | 0) === 0 && (node.y | 0) !== lineY) {
      lineY = node.y | 0;
      const line = lines[++lineIndex];
      if (line === undefined)
        throw new Error('Aokana horizontal alignment lost its ordinary line record');
      if (alignment === 1) {
        const wrappedInset =
          (wrapping | 0) !== 0 && line.right < (rectangle.right | 0) ? fontSize : 0;
        offset =
          (((rectangle.right - wrappedInset - line.right + readingInset - state.lineStartOffset) |
            0) >>
            1) |
          0;
      } else if (alignment === 2)
        offset = (rectangle.right - line.right - firstOverlayHeight + readingInset) | 0;
    }
    node.x = (node.x + offset) | 0;
  }
  if ((rectangle.left | 0) < (cursor.x | 0)) cursor.x = (cursor.x + offset) | 0;
}

/** 073E90 draws every prepared node and emits its translated inclusive bitmap rectangle. */
export function emitAokanaHorizontalTextNodes(
  state: AokanaTextLayoutState,
  destination: AokanaBitmap,
  nodes: readonly AokanaHorizontalTextLayoutNode[],
): AokanaBitmapRectangle[] {
  const rectangles: AokanaBitmapRectangle[] = [];
  for (const node of nodes) {
    state.surfaces.compositor.draw(destination, node.x, node.y, node.bitmap, 0, 0);
    const rectangle = aokanaBitmapRectangle(node.bitmap);
    translateAokanaBitmapRectangle(rectangle, node.x, node.y);
    rectangles.push(rectangle);
  }
  return rectangles;
}

export interface AokanaHorizontalTextDrawOptions {
  readonly destination: AokanaBitmap;
  /** 078C10 param_2 receives the final emitted-node count. */
  readonly emittedOutput: AokanaHorizontalTextLineOutput;
  /** 078C10 param_4 is the builder output exposed by 0792F0. */
  readonly lineOutput: AokanaHorizontalTextLineOutput;
  readonly cursor: AokanaHorizontalTextCursor;
  readonly rectangle: AokanaBitmapRectangle;
  readonly source: AokanaBpPointer;
  readonly readingEnabled: number;
  readonly annotations: AokanaBpPointer | null;
  readonly fontId: number;
  readonly proportional: number;
  readonly wrapping: number;
  readonly alignment: number;
  readonly lineSpacingPercent: number;
  readonly color: number;
  readonly readingColor: number;
  readonly effect: AokanaHorizontalTextEffect;
  readonly maximumFontSize?: AokanaHorizontalTextLineOutput | null;
}

export type AokanaHorizontalTextDrawResult =
  | {readonly result: 0}
  | {
      readonly result: 1;
      readonly emittedCount: number;
      readonly rectangles: readonly AokanaBitmapRectangle[];
    };

/** 078C10 owns the complete horizontal prepare/read/align/emit/release phase order. */
export async function drawAokanaHorizontalText(
  state: AokanaTextLayoutState,
  options: AokanaHorizontalTextDrawOptions,
): Promise<AokanaHorizontalTextDrawResult> {
  const font = state.surfaces.fonts.find(options.fontId);
  if (font === null) return {result: 0};
  const annotations = new AokanaRubyAnnotations(state.text);
  annotations.import(options.annotations);
  const lineAdvance =
      (font.size + signedDivide(Math.imul(font.size, options.lineSpacingPercent), 100)) | 0,
    prepared = await buildAokanaHorizontalTextLayout(state, {
      source: options.source,
      readingEnabled: options.readingEnabled,
      annotations,
      cursor: options.cursor,
      rectangle: options.rectangle,
      lineAdvance,
      fontId: options.fontId,
      proportional: options.proportional,
      wrapping: options.wrapping,
      color: options.color,
      effect: options.effect,
      maximumFontSize: options.maximumFontSize,
    });
  options.lineOutput.value = prepared.outputCount;
  try {
    if ((options.readingEnabled | 0) !== 0)
      await addAokanaHorizontalReadings(
        state,
        prepared.nodes,
        options.fontId,
        options.readingColor,
        options.effect,
        annotations,
      );
    alignAokanaHorizontalTextNodes(
      state,
      prepared.nodes,
      options.cursor,
      options.rectangle,
      options.fontId,
      options.wrapping,
      options.effect,
      options.alignment,
    );
    const rectangles = emitAokanaHorizontalTextNodes(state, options.destination, prepared.nodes);
    options.emittedOutput.value = rectangles.length >>> 0;
    return {result: 1, emittedCount: rectangles.length >>> 0, rectangles};
  } finally {
    releaseAokanaHorizontalTextLayout(prepared.nodes);
    annotations.clear();
  }
}

export interface AokanaBitmapHorizontalTextOptions {
  readonly destination: AokanaBitmap;
  readonly lineOutput: AokanaHorizontalTextLineOutput;
  readonly x: number;
  readonly y: number;
  readonly source: AokanaBpPointer;
  readonly readingEnabled: number;
  readonly annotations: AokanaBpPointer | null;
  readonly fontId: number;
  readonly proportional: number;
  readonly wrapping: number;
  readonly lineSpacingPercent: number;
  readonly color: number;
  readonly readingColor: number;
  readonly effect: AokanaHorizontalTextEffect;
}

/** 0792F0 borrows the shared 1D1E58 cursor and fixes bitmap alignment to zero. */
export async function drawAokanaHorizontalTextToBitmap(
  state: AokanaTextLayoutState,
  options: AokanaBitmapHorizontalTextOptions,
): Promise<0 | 1> {
  state.surfaceCursor.x = options.x | 0;
  state.surfaceCursor.y = options.y | 0;
  const emittedOutput = {value: 0};
  const result = await drawAokanaHorizontalText(state, {
    destination: options.destination,
    emittedOutput,
    lineOutput: options.lineOutput,
    cursor: state.surfaceCursor,
    rectangle: aokanaBitmapRectangle(options.destination),
    source: options.source,
    readingEnabled: options.readingEnabled,
    annotations: options.annotations,
    fontId: options.fontId,
    proportional: options.proportional,
    wrapping: options.wrapping,
    alignment: 0,
    lineSpacingPercent: options.lineSpacingPercent,
    color: options.color,
    readingColor: options.readingColor,
    effect: options.effect,
  });
  return result.result;
}

export interface AokanaRegisteredSurfaceHorizontalTextOptions extends Omit<
  AokanaBitmapHorizontalTextOptions,
  'destination' | 'fontId'
> {
  readonly surface: number;
  readonly registeredFont: number;
  readonly fontSize: number;
  readonly fontWidth: number;
  readonly bold: number;
}

/** 034E70 snapshots the destination and maps 035840's registered-font creation statuses. */
export async function drawAokanaRegisteredHorizontalTextToSurface(
  state: AokanaTextLayoutState,
  options: AokanaRegisteredSurfaceHorizontalTextOptions,
): Promise<number> {
  const destination = state.surfaces.snapshot(options.surface);
  if (destination === null) return 0x80000004;
  const name = state.surfaces.fonts.name(options.registeredFont);
  if (name === null) return 0x80000003;
  const selected = await state.surfaces.fonts.get(
    name,
    options.fontSize,
    options.fontWidth,
    options.bold,
  );
  if (selected.result === 0x80000002) return 0x80000001;
  if (selected.result === 0x80000003) return 0x80000002;
  if (selected.result === 0x80000004) return 0x80000003;
  if (selected.result !== 0)
    throw new Error('Aokana registered horizontal text received an unknown font status');
  await drawAokanaHorizontalTextToBitmap(state, {
    ...options,
    destination,
    fontId: selected.id,
  });
  return 0;
}

/** 0686A0's horizontal branch mutates the real window and composes emitted rectangles in order. */
export async function drawAokanaHorizontalTextToWindow(
  state: AokanaTextLayoutState,
  window: AokanaWindowDisplayObject,
  source: AokanaBpPointer,
  readingEnabled: number,
  wrapping: number,
  color: number,
  readingColor: number,
  effect: AokanaHorizontalTextEffect,
): Promise<0 | 1> {
  window.setTextTransparency(0);
  window.setTextEnabled(1);
  window.disableOverlays();
  const cursor = window.getTextCursor(),
    beforeY = cursor.y | 0,
    rectangle = window.getTextRectangle(),
    annotationBytes = new Uint8Array(1024);
  if ((readingEnabled | 0) !== 0)
    state.annotations.extract({bytes: annotationBytes, offset: 0}, source);
  const fontId = window.fontId,
    proportional = window.characterSpacing,
    alignment = window.alignment,
    lineSpacingPercent = window.lineSpacing;
  if ((window.writingDirection | 0) !== 0) {
    if ((window.writingDirection | 0) === 1)
      throw new Error('Aokana vertical text remains outside the horizontal pipeline');
    throw new Error('Aokana window text direction yields an undefined native result');
  }
  const previousLineExtent = window.lineExtent >>> 0,
    maximumFontSize = {value: window.lineExtent | 0},
    emittedOutput = {value: 0},
    lineOutput = {value: proportional | 0},
    result = await drawAokanaHorizontalText(state, {
      destination: window.textBitmap,
      emittedOutput,
      lineOutput,
      cursor,
      rectangle,
      source,
      readingEnabled,
      annotations: {bytes: annotationBytes, offset: 0},
      fontId,
      proportional,
      wrapping,
      alignment,
      lineSpacingPercent,
      color,
      readingColor,
      effect,
      maximumFontSize,
    });
  if (result.result === 0) return 0;
  if (beforeY !== (cursor.y | 0) || previousLineExtent < maximumFontSize.value >>> 0)
    window.setLineExtent(maximumFontSize.value);
  for (const emitted of result.rectangles.slice(0, emittedOutput.value >>> 0))
    window.composeRectangle(emitted);
  window.setTextCursor(cursor.x, cursor.y);
  return 1;
}

/** 082860 resolves one window and translates 0686A0's zero into status 17. */
export async function drawAokanaHorizontalTextByWindowHandle(
  windows: AokanaWindowDisplayState,
  handle: number,
  source: AokanaBpPointer,
  readingEnabled: number,
  wrapping: number,
  color: number,
  readingColor: number,
  effect: AokanaHorizontalTextEffect,
): Promise<-1 | 0 | 17> {
  const found = windows.manager.find('window', handle);
  if (found === null) return -1;
  if (!(found instanceof AokanaWindowDisplayObject))
    throw new Error('Aokana window pool contains a different native display class');
  const result = await drawAokanaHorizontalTextToWindow(
    windows.textLayout,
    found,
    source,
    readingEnabled,
    wrapping,
    color,
    readingColor,
    effect,
  );
  if (result === 0) return 17;
  if (found.inputActive() !== 0) found.invalidate();
  return 0;
}

/** 0B4910 maps only the missing-font status and otherwise preserves invalid-window minus one. */
export async function drawAokanaHorizontalTextWindowFacade(
  windows: AokanaWindowDisplayState,
  handle: number,
  source: AokanaBpPointer,
  readingEnabled: number,
  wrapping: number,
  color: number,
  readingColor: number,
  effect: AokanaHorizontalTextEffect,
): Promise<-1 | 0 | 1> {
  const result = await drawAokanaHorizontalTextByWindowHandle(
    windows,
    handle,
    source,
    readingEnabled,
    wrapping,
    color,
    readingColor,
    effect,
  );
  return result === 17 ? 1 : result;
}

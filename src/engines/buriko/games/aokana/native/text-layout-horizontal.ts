import {recolorAokanaBitmapAlpha as recolorAlpha} from './bitmap-recolor.js';
import type {AokanaBpPointer} from '../bp/memory.js';
import {
  allocateAokanaBitmap,
  cropAokanaBitmap,
  fillAokanaBitmap,
  type AokanaBitmap,
  type AokanaBitmapRectangle,
} from './bitmap.js';
import {clearAokanaBitmap} from './bitmap-copy.js';
import {aokanaCrtWideLower} from './crt-case.js';
import {isAokanaCustomGlyphCode, type AokanaDrawnGlyph} from './custom-text-glyphs.js';
import type {AokanaFontRecord} from './fonts.js';
import type {AokanaRubyAnnotations} from './text-annotations.js';
import type {AokanaTextLayoutState} from './text-layout-state.js';

export interface AokanaHorizontalTextEffect {
  readonly mode: number;
  readonly radiusXPercent: number;
  readonly radiusYPercent: number;
  readonly color: number;
  readonly opacity: number;
}

export interface AokanaHorizontalTextCursor {
  x: number;
  y: number;
}

export interface AokanaHorizontalTextLayoutNode {
  procedureTime: number;
  revealTime: number;
  procedureState: number;
  interval: number;
  x: number;
  y: number;
  annotationX: number;
  annotationY: number;
  fontSize: number;
  bitmap: AokanaBitmap;
  auxiliary: AokanaBitmap;
  annotationKey: Uint8Array | null;
  annotationBaseExtent: number;
  kind: number;
  next: AokanaHorizontalTextLayoutNode | null;
  /** Character/source/line are non-native diagnostics over the exact node owner. */
  readonly character: number | null;
  readonly sourceIndex: number;
  readonly line: number;
}

export interface AokanaHorizontalTextLayoutOptions {
  readonly source: AokanaBpPointer;
  readonly readingEnabled: number;
  readonly annotations: AokanaRubyAnnotations;
  readonly cursor: AokanaHorizontalTextCursor;
  readonly rectangle: AokanaBitmapRectangle;
  readonly lineAdvance: number;
  readonly fontId: number;
  readonly proportional: number;
  readonly wrapping: number;
  readonly color: number;
  readonly effect: AokanaHorizontalTextEffect;
  readonly maximumFontSize?: {value: number} | null;
  /** The native modal warning is required only when field1D1E40 is enabled. */
  readonly missingGlyph?: ((character: number) => void) | null;
}

export interface AokanaHorizontalTextLayoutResult {
  readonly result: 0 | 1;
  readonly nodes: AokanaHorizontalTextLayoutNode[];
  readonly outputCount: number;
  readonly lineCount: number;
  readonly maximumFontSize: number;
  readonly lineHeights: readonly number[];
  readonly cursor: AokanaHorizontalTextCursor;
}

interface MutableFont {
  readonly name: Uint8Array;
  size: number;
  widthPercent: number;
  bold: number;
  italic: number;
  record: AokanaFontRecord;
  transient: boolean;
}

export interface AokanaHorizontalMeasuredText {
  readonly total: number;
  readonly withoutFirstBearing: number;
  readonly withoutLastBearing: number;
}

interface ParsedTag {
  readonly command: number;
  readonly argument: string;
  readonly indexAfter: number;
}

const commands = [
  '/',
  'b',
  '/b',
  'i',
  '/i',
  'ruby',
  'r',
  '/r',
  'cr',
  'c',
  '/c',
  'l',
  '/l',
  't',
  'ev',
  '2x',
  '/2x',
  'fs',
  '/fs',
  'mxfs',
] as const;

const initialIndentCharacters = new Set([
  0x300c, 0x3000, 0xff08, 0x300e, 0x2018, 0x201c, 0x28, 0x22,
]);
const openingPunctuation = new Set([
  0x5b, 0x7b, 0x28, 0xff08, 0x3014, 0xff3b, 0xff5b, 0x3008, 0x226a, 0x300a, 0x300c, 0x300e, 0x3010,
  0x201c,
]);
const closingPunctuation = new Set([
  0x22, 0x27, 0x2c, 0x2e, 0x3f, 0x21, 0xff9e, 0xff9f, 0xff0c, 0xff0e, 0x3001, 0x3002, 0xff1f,
  0xff01, 0x201d, 0x309b, 0x309c, 0x5d, 0x7d, 0x29, 0xff09, 0x3015, 0xff3d, 0xff5d, 0x3009, 0x226b,
  0x300b, 0x300d, 0x300f, 0x3011, 0x30fd, 0x30fe, 0x309d, 0x309e, 0x3005, 0x30fb, 0x2025, 0x2026,
  0x2501, 0x2015, 0x2500, 0x30fc, 0xff5e, 0x266a, 0x3041, 0x3043, 0x3045, 0x3047, 0x3049, 0x3063,
  0x3083, 0x3085, 0x3087, 0x30a1, 0x30a3, 0x30a5, 0x30a7, 0x30a9, 0x30c3, 0x30e3, 0x30e5, 0x30e7,
  0x3000,
]);
const groupedPunctuation = new Set([
  0x22, 0x27, 0x2c, 0x2e, 0x3a, 0x3b, 0x3f, 0x21, 0xff9e, 0xff9f, 0xff65, 0xff0c, 0xff0e, 0x3001,
  0x3002, 0xff1a, 0xff1b, 0xff1f, 0xff01, 0x201d, 0x309b, 0x309c, 0x2010, 0x5d, 0x7d, 0x29, 0xff09,
  0x3015, 0xff3d, 0xff5d, 0x3009, 0x226b, 0x300b, 0x300d, 0x300f, 0x3011, 0x30fd, 0x30fe, 0x309d,
  0x309e, 0x3005, 0x30fb, 0x2025, 0x2026, 0x2501, 0x2015, 0x2500, 0x30fc, 0xff5e, 0x266a, 0x3041,
  0x3043, 0x3045, 0x3047, 0x3049, 0x3063, 0x3083, 0x3085, 0x3087, 0x30a1, 0x30a3, 0x30a5, 0x30a7,
  0x30a9, 0x30c3, 0x30e3, 0x30e5, 0x30e7, 0x3092, 0x30f2, 0x3000,
]);
const trimmedWordPunctuation = new Set([0x21, 0x22, 0x29, 0x2c, 0x2e, 0x3f, 0x5d, 0x7d]);

function emptyBitmap(): AokanaBitmap {
  return {storage: null, offset: 0, stride: 0, width: 0, height: 0, format: 0, bytesPerPixel: 0};
}

function divide(numerator: number, denominator: number): number {
  numerator |= 0;
  denominator |= 0;
  if (denominator === 0 || (numerator === -0x80000000 && denominator === -1))
    throw new RangeError('Aokana horizontal text layout integer division fault');
  return Math.trunc(numerator / denominator) | 0;
}

function cellWidth(font: MutableFont | AokanaFontRecord): number {
  return divide(Math.imul(font.widthPercent, font.size), 100);
}

function characterAt(text: string, index: number): {value: number; length: number} {
  const first = text.charCodeAt(index);
  if (Number.isNaN(first)) return {value: 0, length: 0};
  if ((first - 0xd800) >>> 0 < 0x400 && index + 1 < text.length) {
    const second = text.charCodeAt(index + 1);
    if ((second - 0xdc00) >>> 0 < 0x400)
      return {value: (((first - 0xd7c0) * 0x400) | (second - 0xdc00)) >>> 0, length: 2};
  }
  return {value: first, length: 1};
}

function skipFormattingTags(text: string, start: number): number {
  let index = start;
  while (text.charCodeAt(index) === 0x3c) {
    const next = text.charCodeAt(index + 1);
    if ((next - 0x41) >>> 0 < 26 || (next - 0x61) >>> 0 < 26 || next === 0x2f) {
      index += 2;
      const close = text.indexOf('>', index);
      if (close >= 0) index = close + 1;
    } else index++;
  }
  return index;
}

function scanWord(text: string, start: number): string {
  let index = start;
  const values: number[] = [];
  for (;;) {
    const unit = text.charCodeAt(index),
      value = Number.isNaN(unit) ? 0 : unit;
    const lowAscii = value > 0x20 && value < 0xad && value !== 0x3c && (value - 0x7f) >>> 0 > 0x21;
    if (!lowAscii && !((value - 0xae) >>> 0 < 0xf52)) {
      if (value === 0xad) {
        values.push(value);
        index++;
      }
      break;
    }
    values.push(value);
    index++;
  }
  while (values.length > 1 && trimmedWordPunctuation.has(values.at(-1)!)) values.pop();
  return String.fromCharCode(...values);
}

function scanGroupedPunctuation(text: string, start: number): string {
  let index = start;
  while (groupedPunctuation.has(text.charCodeAt(index))) index++;
  return text.slice(start, index);
}

function parseTag(text: string, index: number): ParsedTag | null {
  if (text.charCodeAt(index) !== 0x3c) return null;
  const close = text.indexOf('>', index + 1);
  if (close < 0 || close - index <= 1) return null;
  const body = aokanaCrtWideLower(text.slice(index + 1, close));
  for (let command = 0; command < commands.length; command++) {
    const name = commands[command]!;
    if (command === 0 ? body === name : body.startsWith(name))
      return {command, argument: body.slice(name.length), indexAfter: close + 1};
  }
  return {command: -1, argument: '', indexAfter: close + 1};
}

function decimalPrefix(input: string): {value: number; length: number} {
  let index = 0;
  while (input.charCodeAt(index) === 0x20) index++;
  const start = index;
  let value = 0;
  for (;;) {
    const unit = input.charCodeAt(index);
    if (Number.isNaN(unit) || (unit - 0x30) >>> 0 >= 10) break;
    value = (Math.imul(value, 10) + unit - 0x30) >>> 0;
    index++;
  }
  return {value, length: index - start};
}

function rgbPrefix(input: string): number | null {
  let index = 0;
  while (input.charCodeAt(index) === 0x20) index++;
  let color = 0;
  for (let count = 0; count < 6; count++) {
    const code = input.charCodeAt(index++),
      digit =
        code >= 0x30 && code <= 0x39
          ? code - 0x30
          : code >= 0x61 && code <= 0x66
            ? code - 0x57
            : -1;
    if (digit < 0) return null;
    color = ((color << 4) | digit) >>> 0;
  }
  return color;
}

function cropToGlyph(bitmap: AokanaBitmap, glyph: AokanaDrawnGlyph): void {
  const width = (glyph.right - glyph.left + 1) | 0;
  bitmap.width = Math.min(width >>> 0, (bitmap.width - glyph.left) >>> 0);
  bitmap.offset += Math.imul(bitmap.bytesPerPixel, glyph.left) >>> 0;
}

function fillRectangle(bitmap: AokanaBitmap, width: number, height: number, color: number): void {
  const view = {...bitmap};
  if (
    cropAokanaBitmap(view, {
      left: 0,
      top: 0,
      right: (width - 1) | 0,
      bottom: (height - 1) | 0,
    })
  )
    fillAokanaBitmap(view, color);
}

function copyBitmap(state: AokanaTextLayoutState, source: AokanaBitmap): AokanaBitmap {
  const result = allocateAokanaBitmap(source.width, source.height, source.format);
  clearAokanaBitmap(result);
  state.surfaces.compositor.copy(result, source);
  return result;
}

function appendNode(
  nodes: AokanaHorizontalTextLayoutNode[],
  node: AokanaHorizontalTextLayoutNode,
): void {
  const previous = nodes.at(-1);
  if (previous !== undefined) previous.next = node;
  nodes.push(node);
}

export function releaseAokanaHorizontalTextLayout(
  nodes: readonly AokanaHorizontalTextLayoutNode[],
): void {
  for (const node of nodes) {
    node.bitmap.storage?.release();
    node.auxiliary.storage?.release();
    node.annotationKey = null;
    node.next = null;
  }
}

function snapNearInteger(value: number): number {
  const floor = Math.floor(value),
    fraction = value - floor;
  if (1 - 2 ** -14 <= fraction) return Math.ceil(value);
  return fraction <= 2 ** -14 ? floor : value;
}

function fontBitmapDimensions(font: AokanaFontRecord): {width: number; height: number} {
  if (font.raster === null)
    throw new Error('Aokana horizontal text layout reads an uninitialized font raster');
  return {width: font.raster.geometry.width, height: font.raster.geometry.height};
}

function alphaScratchFormat(state: AokanaTextLayoutState): number {
  const format = state.surfaces.compositor.defaultFormat;
  return format === 1 ? 2 : format;
}

function characterSpacing(
  state: AokanaTextLayoutState,
  proportional: number,
  font: Pick<MutableFont, 'italic' | 'record'>,
): number {
  if ((proportional | 0) !== 0) return 0;
  return (state.field1D1E48 + (font.italic !== 0 ? font.record.field48 : font.record.field44)) | 0;
}

function metricInteger(value: number): number {
  const integer = Math.trunc(value);
  return !Number.isFinite(integer) || integer < -2147483648 || integer > 2147483647
    ? -2147483648
    : integer;
}

function fontExtra(font: MutableFont): number {
  if (font.record.raster === null)
    throw new Error('Aokana horizontal metrics read an undefined native font raster');
  return font.record.raster.extraPixels;
}

function glyphMetrics(
  state: AokanaTextLayoutState,
  glyph: AokanaDrawnGlyph,
  customWidth: number | null,
  font: MutableFont,
  proportional: number,
  fixedCellWidth: number,
  extra = fontExtra(font),
): {width: number; left: number; right: number} {
  const integerExtra = metricInteger(extra);
  if ((proportional | 0) === 0)
    return {
      width: customWidth ?? (glyph.wideExtent === 0 ? divide(fixedCellWidth, 2) : fixedCellWidth),
      left: 0,
      right: integerExtra,
    };
  if (customWidth !== null) return {width: customWidth | 0, left: 0, right: integerExtra};
  if ((state.proportionalSideBearing | 0) !== 0) {
    const margin = Math.imul(state.proportionalSideBearing, fixedCellWidth) >> 16,
      left = margin >> 1;
    return {
      width: (glyph.right - glyph.left + 1) | 0,
      left,
      right: (integerExtra - left + margin) | 0,
    };
  }
  const left = metricInteger(snapNearInteger(glyph.abc[0])),
    end = Math.fround(glyph.abc[0] + glyph.abc[1]),
    body = metricInteger(Math.ceil(snapNearInteger(Math.fround(end - Math.fround(left))))),
    remainder = Math.fround(end - Math.fround((body + left) | 0)),
    right = metricInteger(
      Math.fround(Math.fround(Math.fround(remainder + glyph.abc[2]) + extra) + 0.5),
    );
  return {width: body, left, right};
}

function measureWideText(
  state: AokanaTextLayoutState,
  text: string,
  font: MutableFont,
  proportional: number,
): AokanaHorizontalMeasuredText {
  const scratch = allocateAokanaBitmap(
    Math.imul(font.size, 2),
    font.size,
    alphaScratchFormat(state),
  );
  const extra = fontExtra(font),
    integerExtra = metricInteger(extra);
  let total = 0,
    firstLeft = 0,
    lastRight = 0,
    first = true,
    index = 0;
  while (index < text.length) {
    const character = text.charCodeAt(index),
      marked = (character | 0x80000000) >>> 0,
      custom = isAokanaCustomGlyphCode(marked),
      glyph = state.customGlyphs.draw(scratch, character, font.record, 0xffffff, state.field1D1D94),
      spacing = characterSpacing(state, proportional, font);
    let metrics: {width: number; left: number; right: number};
    if ((proportional | 0) === 0) {
      const width = custom
        ? state.customGlyphs.width(marked)
        : glyph.fullWidth === 0
          ? divide(cellWidth(font), 2)
          : cellWidth(font);
      metrics = {
        width: (width + integerExtra) | 0,
        left: 0,
        right: 0,
      };
    } else if (custom) metrics = {width: state.customGlyphs.width(marked), left: 0, right: 0};
    else metrics = glyphMetrics(state, glyph, null, font, proportional, cellWidth(font), extra);
    total = (total + spacing + metrics.left + metrics.width + metrics.right) | 0;
    if (first) firstLeft = metrics.left;
    first = false;
    lastRight = metrics.right;
    index++;
  }
  scratch.storage?.release();
  const trailingSpacing = characterSpacing(state, proportional, font);
  total = (total - trailingSpacing) | 0;
  const withoutLastBearing = (total - lastRight) | 0;
  return {
    total,
    withoutLastBearing,
    withoutFirstBearing: (withoutLastBearing - firstLeft) | 0,
  };
}

/** 078FF0's drawing-backed wide-text measurement for callers after the preparation phase. */
export function measureAokanaHorizontalWideText(
  state: AokanaTextLayoutState,
  text: string,
  font: AokanaFontRecord,
  proportional: number,
): AokanaHorizontalMeasuredText {
  return measureWideText(
    state,
    text,
    {
      name: font.name,
      size: font.size | 0,
      widthPercent: font.widthPercent | 0,
      bold: font.bold | 0,
      italic: font.italic | 0,
      record: font,
      transient: false,
    },
    proportional,
  );
}

/**
 * 074f30's horizontal preparation pass. It owns prepared bitmaps/nodes but deliberately stops
 * before the separate reading, alignment, emission and scene-procedure phases.
 */
export async function buildAokanaHorizontalTextLayout(
  state: AokanaTextLayoutState,
  options: AokanaHorizontalTextLayoutOptions,
): Promise<AokanaHorizontalTextLayoutResult> {
  const operationAllocator = state.surfaces.allocator,
    operationActor = operationAllocator.currentActor;
  const runAsActor = <T>(operation: () => T): T =>
    operationAllocator.withActor(operationActor, operation);

  const base = state.surfaces.fonts.find(options.fontId);
  if (base === null)
    return {
      result: 0,
      nodes: [],
      outputCount: 0,
      lineCount: 0,
      maximumFontSize: options.maximumFontSize?.value ?? 0,
      lineHeights: [],
      cursor: options.cursor,
    };
  if (base.raster === null)
    throw new Error('Aokana horizontal text builder found an uninitialized native font');

  state.resetLinkRegions();
  state.currentInlineColor = options.color >>> 0;
  const text = state.customGlyphs.decode(options.source),
    nodes: AokanaHorizontalTextLayoutNode[] = [],
    lineHeights: number[] = [],
    current: MutableFont = {
      name: base.name,
      size: base.size | 0,
      widthPercent: base.widthPercent | 0,
      bold: base.bold | 0,
      italic: base.italic | 0,
      record: base,
      transient: false,
    },
    baseSize = base.size | 0,
    format = alphaScratchFormat(state);
  let index = 0,
    reservedCharacter: number | null = null,
    initialPunctuation = false,
    fillGlyphCell = false,
    wordGroupingEnabled = true;
  for (;;) {
    const character = text.charCodeAt(index);
    if (!(character < 0x10)) break;
    if (character === 2) fillGlyphCell = true;
    else if (character === 3) initialPunctuation = true;
    else if (character === 4) reservedCharacter = 0x300c;
    else if (character === 5) reservedCharacter = state.field1D1DB8 === 0 ? 0x3000 : 0x20;
    else if (character === 6) reservedCharacter = state.field1D1DB8 === 0 ? 0xff08 : 0x28;
    else if (character === 7) reservedCharacter = state.field1D1DB8 === 0 ? 0x201c : 0x22;
    else if (character === 8) reservedCharacter = 0x300e;
    else if (character === 0xb) wordGroupingEnabled = false;
    else if (character === 0xe) reservedCharacter = 0x2018;
    else break;
    index++;
  }

  const effectRadiusX = Math.max(
      1,
      divide(Math.imul(options.effect.radiusXPercent, baseSize), 100),
    ),
    effectRadiusY = Math.max(1, divide(Math.imul(options.effect.radiusYPercent, baseSize), 100));
  let effectWidth = 0,
    effectHeight = 0;
  if ((options.effect.mode | 0) === 1) {
    effectWidth = effectRadiusX;
    effectHeight = effectRadiusY;
  } else if ((options.effect.mode | 0) === 2) {
    effectWidth = Math.imul(effectRadiusX, 2);
    effectHeight = Math.imul(effectRadiusY, 2);
  }
  let readingOffset = 0;
  if ((options.readingEnabled | 0) !== 0) {
    readingOffset = state.readingSize(baseSize);
    if (state.field1D27A0 !== 0) readingOffset = (readingOffset - state.readingYOffset) | 0;
    if ((options.effect.mode | 0) === 2 && state.field1D27A0 !== 0)
      readingOffset = (readingOffset + effectRadiusY) | 0;
  }

  let scratchDimensions = fontBitmapDimensions(base),
    lineStartIndent = 0;
  const firstCharacter = characterAt(text, index).value;
  if ((options.wrapping | 0) !== 0 && state.field1D1E4C !== 0 && !initialPunctuation) {
    const indentCharacter = initialIndentCharacters.has(firstCharacter)
      ? firstCharacter
      : reservedCharacter;
    if (indentCharacter !== null) {
      const measured = runAsActor(() =>
        measureWideText(
          state,
          String.fromCodePoint(indentCharacter),
          current,
          options.proportional,
        ),
      );
      lineStartIndent =
        (measured.total + characterSpacing(state, options.proportional, current)) | 0;
      if (reservedCharacter !== null && options.cursor.x === options.rectangle.left)
        options.cursor.x = (options.cursor.x + lineStartIndent) | 0;
    }
  }
  if ((options.readingEnabled | 0) !== 0) {
    if (options.cursor.x === options.rectangle.left)
      options.cursor.x = (options.cursor.x + state.lineStartOffset) | 0;
    lineStartIndent = (lineStartIndent + state.lineStartOffset) | 0;
  }

  const rightInset = (options.wrapping | 0) === 0 ? 0 : Math.imul(state.field1C90E0, baseSize) | 0;
  let currentColor = options.color >>> 0,
    revealTime = 0,
    markerIndex = 0,
    lineCount = 1,
    lineMaximum = options.maximumFontSize?.value ?? baseSize,
    hadSource = false,
    escapedTag = false,
    wordCountdown = 0,
    rubyCountdown = 0,
    punctuationCountdown = 0,
    hangingGroupRemaining = 0,
    lineJustBroke = false,
    linkStart: {index: number; x: number; y: number; wrapIndex: number | null} | null = null,
    lineFirstGlyphIndex: number | null = null;
  const colorStack: number[] = [],
    sizeStack: number[] = [];

  const installFont = async (
    size: number,
    widthPercent: number,
    bold: number,
    italic: number,
    effectiveBold = bold,
    updateScratch = false,
  ): Promise<boolean> => {
    size |= 0;
    widthPercent |= 0;
    bold |= 0;
    italic |= 0;
    effectiveBold |= 0;
    let selected: AokanaFontRecord | null = null;
    if (
      size === base.size &&
      widthPercent === base.widthPercent &&
      effectiveBold === base.bold &&
      italic === (base.italic | 0)
    )
      selected = base;
    else {
      const created = await state.surfaces.fonts.createTransient(
        current.name,
        size,
        widthPercent,
        effectiveBold,
        italic,
      );
      if (created.result !== 0) return false;
      selected = created.record;
      if (selected === null) return false;
      selected.field44 = base.field44;
      selected.field48 = base.field48;
    }
    if (current.transient) state.surfaces.fonts.releaseTransient(current.record);
    current.size = size;
    current.widthPercent = widthPercent;
    current.bold = bold;
    current.italic = italic;
    current.record = selected;
    current.transient = selected !== base;
    if (updateScratch) scratchDimensions = fontBitmapDimensions(selected);
    return true;
  };

  const finishLine = (moveCursor: boolean): void => {
    const extra =
      state.field1D1DBC !== 0 && baseSize < lineMaximum ? (lineMaximum - baseSize) | 0 : 0;
    if (state.field1D1DBC !== 0) {
      const slot = lineCount - 1,
        height = (extra + options.lineAdvance) >>> 0;
      lineHeights[slot] = Math.max(lineHeights[slot] ?? 0, height);
      for (let node = lineFirstGlyphIndex ?? nodes.length; node < nodes.length; node++) {
        const value = nodes[node]!;
        if (value.fontSize < lineMaximum) {
          const difference = (lineMaximum - value.fontSize) | 0;
          value.y = (value.y + difference) | 0;
          value.annotationY = (value.annotationY + difference) | 0;
        }
      }
    }
    if (moveCursor) {
      options.cursor.x = (options.rectangle.left + lineStartIndent) | 0;
      options.cursor.y = (options.cursor.y + extra + options.lineAdvance) | 0;
      lineCount = (lineCount + 1) | 0;
      lineFirstGlyphIndex = null;
      lineMaximum = current.size;
      lineJustBroke = true;
    }
  };

  while (index < text.length) {
    hadSource = true;
    const sourceIndex = index,
      decoded = characterAt(text, index);
    let character = decoded.value;
    if (character === 0) break;

    if (character < 0xe) {
      index += decoded.length;
      if (character === 10) finishLine(true);
      else lineJustBroke = false;
      continue;
    }

    if (character === 0x3c) {
      const tag = parseTag(text, index);
      if (tag !== null && !escapedTag) {
        const argument = tag.argument;
        switch (tag.command) {
          case 0:
            escapedTag = true;
            break;
          case 1:
            if (current.bold === 0)
              await installFont(current.size, current.widthPercent, 1, current.italic);
            break;
          case 2:
            if (current.bold !== 0)
              await installFont(current.size, current.widthPercent, 0, current.italic);
            break;
          case 3:
            if (current.italic === 0)
              await installFont(current.size, current.widthPercent, current.bold, 1);
            break;
          case 4:
            if (current.italic !== 0)
              await installFont(current.size, current.widthPercent, current.bold, 0);
            break;
          case 5: {
            const content = argument.trimStart(),
              comma = content.indexOf(',');
            if (comma >= 0)
              options.annotations.addInlineWide(content.slice(0, comma), content.slice(comma + 1));
            break;
          }
          case 6: {
            const reading = argument.trimStart(),
              nextTag = text.indexOf('<', tag.indexAfter),
              key = text.slice(tag.indexAfter, nextTag < 0 ? text.length : nextTag);
            if (reading.length !== 0 && key.length !== 0)
              options.annotations.addInlineWide(key, reading);
            break;
          }
          case 8:
            options.cursor.x = options.rectangle.left | 0;
            break;
          case 9: {
            const selected = rgbPrefix(argument);
            if (selected !== null) {
              colorStack.push(currentColor);
              currentColor = selected;
              state.currentInlineColor = selected;
            }
            break;
          }
          case 10:
            if (colorStack.length !== 0) {
              currentColor = colorStack.pop()! >>> 0;
              state.currentInlineColor = currentColor;
            }
            break;
          case 11:
            if (linkStart === null) {
              linkStart = {
                index: tag.indexAfter,
                x: options.cursor.x | 0,
                y: options.cursor.y | 0,
                wrapIndex: null,
              };
              colorStack.push(currentColor);
              if (state.linkColor !== 0xffffffff) {
                currentColor = state.linkColor >>> 0;
                state.currentInlineColor = currentColor;
              }
              if (current.bold === 0 && current.italic === 0) {
                const end = state.alternateFontName.indexOf(0),
                  alternateName = state.alternateFontName.slice(
                    0,
                    end < 0 ? state.alternateFontName.length : end,
                  ),
                  name = alternateName.length === 0 ? current.name : alternateName,
                  size = state.alternateFontSize > 0 ? state.alternateFontSize : current.size,
                  width =
                    state.alternateFontWidth > 0 ? state.alternateFontWidth : current.widthPercent,
                  selected = await state.surfaces.fonts.createTransient(
                    name,
                    size,
                    width,
                    state.alternateFontBold,
                    state.alternateFontItalic,
                  );
                if (selected.result === 0) {
                  const record = selected.record;
                  if (record !== null) {
                    record.field44 = base.field44;
                    record.field48 = base.field48;
                    if (current.transient) state.surfaces.fonts.releaseTransient(current.record);
                    current.record = record;
                    current.transient = true;
                  }
                }
              }
            }
            break;
          case 12:
            if (linkStart !== null) {
              state.addLinkRegion(
                text.slice(linkStart.index, linkStart.wrapIndex ?? index),
                linkStart.x,
                linkStart.y,
              );
              linkStart = null;
              if (colorStack.length !== 0) {
                currentColor = colorStack.pop()! >>> 0;
                state.currentInlineColor = currentColor;
              }
              if (current.bold === 0 && current.italic === 0) {
                if (current.transient) state.surfaces.fonts.releaseTransient(current.record);
                current.record = base;
                current.transient = false;
              }
            }
            break;
          case 13: {
            const delay = decimalPrefix(argument);
            revealTime = Math.imul(delay.value, state.field1C9100) >>> 0;
            break;
          }
          case 14: {
            const event = decimalPrefix(argument),
              node: AokanaHorizontalTextLayoutNode = {
                procedureTime: 0,
                revealTime,
                procedureState: 0,
                interval: 0,
                x: markerIndex++,
                y: event.length === 0 ? -1 : event.value | 0,
                annotationX: 0,
                annotationY: 0,
                fontSize: 0,
                bitmap: emptyBitmap(),
                auxiliary: emptyBitmap(),
                annotationKey: null,
                annotationBaseExtent: 0,
                kind: 0x80000000,
                next: null,
                character: null,
                sourceIndex,
                line: lineCount,
              };
            appendNode(nodes, node);
            break;
          }
          case 15:
            await installFont(
              current.size,
              Math.imul(current.widthPercent, 2),
              current.bold,
              current.italic,
              1,
            );
            break;
          case 16:
            if (base.widthPercent < current.widthPercent)
              await installFont(
                current.size,
                divide(current.widthPercent, 2),
                current.bold,
                current.italic,
                0,
              );
            break;
          case 17: {
            const size = decimalPrefix(argument);
            if (size.length !== 0 && (size.value - 4) >>> 0 < 0xc5) {
              sizeStack.push(current.size);
              if (
                await installFont(
                  size.value,
                  current.widthPercent,
                  current.bold,
                  current.italic,
                  current.bold,
                  true,
                )
              )
                lineMaximum = Math.max(lineMaximum, size.value | 0);
            }
            break;
          }
          case 18:
            if (sizeStack.length !== 0) {
              const size = sizeStack.pop()!;
              await installFont(
                size,
                current.widthPercent,
                current.bold,
                current.italic,
                current.bold,
                true,
              );
            }
            break;
          case 19: {
            const size = decimalPrefix(argument);
            if (size.length !== 0 && (size.value - 4) >>> 0 < 0xc5) lineMaximum = size.value | 0;
            break;
          }
        }
        index = tag.indexAfter;
        continue;
      }
      escapedTag = false;
    }

    const nextIndex = index + decoded.length,
      selectedSpace =
        decoded.length === 1 && character === (state.field1D1DB8 === 0 ? 0x3000 : 0x20);
    if (
      (options.wrapping | 0) !== 0 &&
      selectedSpace &&
      index !== 0 &&
      text.charCodeAt(index - 1) !== character
    ) {
      const spaceAdvance =
        state.field1D1DB8 === 0 ? cellWidth(current) : divide(cellWidth(current), 2);
      if (options.cursor.x + spaceAdvance > ((options.rectangle.right - baseSize + 1) | 0)) {
        finishLine(true);
        index = nextIndex;
        continue;
      }
    }

    const marked = (character | 0x80000000) >>> 0,
      custom = isAokanaCustomGlyphCode(marked),
      registeredCustomWidth = custom ? state.customGlyphs.width(marked) : 0;
    if (custom && registeredCustomWidth === 0) {
      index = nextIndex;
      continue;
    }
    const customWidth = custom
        ? state.field1D1D94 === 0
          ? registeredCustomWidth
          : baseSize
        : null,
      customHeight = custom
        ? state.field1D1D94 === 0
          ? state.customGlyphs.height(marked)
          : baseSize
        : 0,
      allocationWidth = custom ? (customWidth! + effectWidth) | 0 : scratchDimensions.width,
      allocationHeight = custom ? (customHeight + effectHeight) | 0 : scratchDimensions.height,
      glyphBitmap = allocateAokanaBitmap(allocationWidth, allocationHeight, format);
    clearAokanaBitmap(glyphBitmap);
    const glyph = runAsActor(() =>
      state.customGlyphs.draw(
        glyphBitmap,
        character,
        current.record,
        currentColor,
        state.field1D1D94,
      ),
    );

    if (state.field1D1E40 !== 0 && character > 0x7f && character !== 0x3000) {
      const ordinary = current.record.raster?.glyph(character),
        covered = ordinary?.pixels.some((value) => value !== 0) ?? false;
      if (!covered) {
        const missingGlyph = options.missingGlyph ?? state.missingGlyphHandler;
        if (missingGlyph === null) {
          glyphBitmap.storage?.release();
          throw new Error('Aokana missing-glyph modal callback is not connected');
        }
        missingGlyph(character);
      }
    }

    if (fillGlyphCell || linkStart !== null) {
      const fixedCellWidth = sizeStack.length === 0 ? cellWidth(base) : cellWidth(current);
      const width =
        (options.proportional | 0) === 0
          ? (customWidth ?? (glyph.fullWidth === 0 ? divide(fixedCellWidth, 2) : fixedCellWidth))
          : (glyphBitmap.width - 1) | 0;
      fillRectangle(glyphBitmap, width, baseSize, currentColor | 0xff000000);
    }

    if ((options.proportional | 0) !== 0 && !custom) cropToGlyph(glyphBitmap, glyph);
    const fixedCellWidth = sizeStack.length === 0 ? cellWidth(base) : cellWidth(current);
    const metrics = glyphMetrics(
        state,
        glyph,
        customWidth,
        current,
        options.proportional,
        fixedCellWidth,
      ),
      spacing = characterSpacing(state, options.proportional, current),
      fullAdvance = (metrics.left + metrics.width + metrics.right) | 0;
    let groupExtent = (metrics.left + metrics.width) | 0;

    const opens = openingPunctuation.has(character);
    let canScanPunctuation = true,
      openingNeedsOwnExtent = opens;
    if (wordGroupingEnabled) {
      if (wordCountdown === 0) {
        const wordStart = opens ? skipFormattingTags(text, nextIndex) : index,
          word = scanWord(text, wordStart);
        if (word.length > 0) {
          const measured = runAsActor(() =>
            measureWideText(state, word, current, options.proportional),
          );
          openingNeedsOwnExtent = false;
          if (opens) {
            wordCountdown = word.length;
            if (options.cursor.x !== ((options.rectangle.left + lineStartIndent) | 0))
              groupExtent = (groupExtent + metrics.right + measured.withoutLastBearing) | 0;
          } else {
            wordCountdown = Math.max(0, word.length - decoded.length);
            if (options.cursor.x !== ((options.rectangle.left + lineStartIndent) | 0))
              groupExtent = Math.max(groupExtent, measured.withoutLastBearing);
          }
        }
      } else {
        wordCountdown--;
        canScanPunctuation = false;
      }
    }

    let annotationKey: Uint8Array | null = null,
      annotationBaseExtent = 0;
    if ((options.readingEnabled | 0) !== 0) {
      if (rubyCountdown === 0) {
        const remaining = state.text.encodeWide(text.slice(index), 1),
          match = options.annotations.matchPrefix({bytes: remaining, offset: 0}, true);
        if (match !== null && match.wide !== null) {
          const measured = runAsActor(() =>
            measureWideText(state, match.wide, current, options.proportional),
          );
          openingNeedsOwnExtent = false;
          groupExtent = Math.max(groupExtent, measured.withoutLastBearing);
          annotationKey = match.key.slice();
          annotationBaseExtent = measured.withoutFirstBearing;
          rubyCountdown = Math.max(0, match.wide.length - decoded.length);
        }
      } else {
        rubyCountdown--;
        canScanPunctuation = false;
      }
    }

    let punctuationTrailingExtent = 0;
    if ((options.wrapping | 0) !== 0) {
      if (punctuationCountdown === 0 && canScanPunctuation) {
        const punctuationStart = skipFormattingTags(text, nextIndex),
          punctuation = scanGroupedPunctuation(text, punctuationStart);
        const following = text.charCodeAt(punctuationStart + punctuation.length);
        if (
          punctuation.length > 0 &&
          (punctuation.length !== 1 ||
            (punctuation.charCodeAt(0) !== 0x22 && punctuation.charCodeAt(0) !== 0x27) ||
            ((Number.isNaN(following) ? 0 : following) & 0xffdf) === 0 ||
            following === 0x3000)
        ) {
          const measured = runAsActor(() =>
            measureWideText(state, punctuation, current, options.proportional),
          );
          punctuationTrailingExtent = measured.total;
          let lastNonClosing = -1;
          for (let unit = 0; unit < punctuation.length; unit++)
            if (!closingPunctuation.has(punctuation.charCodeAt(unit))) lastNonClosing = unit;
          let retainedLength = punctuation.length;
          if (lastNonClosing >= 0) {
            retainedLength = lastNonClosing + 1;
            const retained = runAsActor(() =>
              measureWideText(
                state,
                punctuation.slice(0, retainedLength),
                current,
                options.proportional,
              ),
            );
            groupExtent = (groupExtent + retained.withoutLastBearing) | 0;
            punctuationTrailingExtent =
              (punctuationTrailingExtent - retained.withoutLastBearing) | 0;
          }
          hangingGroupRemaining = Math.max(0, retainedLength - 1);
          wordCountdown = (wordCountdown + punctuation.length) | 0;
          punctuationCountdown = wordCountdown;
        }
      } else if (punctuationCountdown > 0) punctuationCountdown--;
    }

    let projectedExtent = groupExtent;
    if (opens && openingNeedsOwnExtent) {
      const measured = runAsActor(() =>
        measureWideText(state, String.fromCodePoint(character), current, options.proportional),
      );
      projectedExtent = (projectedExtent + measured.total) | 0;
    }
    if ((options.effect.mode | 0) === 1 || (options.effect.mode | 0) === 2)
      projectedExtent = (projectedExtent + effectRadiusX) | 0;
    let activeRightInset = rightInset;
    if (punctuationTrailingExtent === 0 && hangingGroupRemaining > 0) {
      activeRightInset = 0;
      hangingGroupRemaining--;
    }
    const insetLimit = (options.rectangle.right - activeRightInset + 1) | 0,
      lineOrigin = (options.rectangle.left + lineStartIndent) | 0;
    if (
      (options.wrapping | 0) !== 0 &&
      options.cursor.x + projectedExtent > insetLimit &&
      options.cursor.x !== lineOrigin
    ) {
      let keepHanging = false;
      const following = text.charCodeAt(nextIndex),
        canHangCharacter =
          closingPunctuation.has(character) &&
          ((character !== 0x22 && character !== 0x27) ||
            ((Number.isNaN(following) ? 0 : following) & 0xffdf) === 0 ||
            following === 0x3000);
      if (canHangCharacter) {
        const hangingInset = state.field1C90F0 !== 0 ? 0 : rightInset,
          hangingLimit = (options.rectangle.right - hangingInset + 1) | 0;
        keepHanging =
          options.cursor.x + spacing + punctuationTrailingExtent + fullAdvance <= hangingLimit;
      }
      if (!keepHanging) {
        hangingGroupRemaining = 0;
        if (linkStart !== null) linkStart.wrapIndex = sourceIndex;
        finishLine(true);
        if (
          options.cursor.x + projectedExtent <=
          ((options.rectangle.right - rightInset + 1) | 0)
        ) {
          wordCountdown = 0;
          rubyCountdown = 0;
          punctuationCountdown = 0;
        }
      }
    }

    const dropWrappedSpace = state.field1D27B0 !== 0 && lineJustBroke && selectedSpace;
    if (!dropWrappedSpace) {
      const x = (options.cursor.x + metrics.left) | 0,
        y = (options.cursor.y + readingOffset) | 0,
        node: AokanaHorizontalTextLayoutNode = {
          procedureTime: 0,
          revealTime,
          procedureState: 0,
          interval: state.field1C90E8 >>> 0,
          x,
          y,
          annotationX: (x + (state.field1D1DAC !== 0 ? effectRadiusX : 0)) | 0,
          annotationY: (y + (state.field1D1DAC !== 0 ? effectRadiusY : 0)) | 0,
          fontSize: current.size | 0,
          bitmap: emptyBitmap(),
          auxiliary: emptyBitmap(),
          annotationKey,
          annotationBaseExtent,
          kind: 0,
          next: null,
          character,
          sourceIndex,
          line: lineCount,
        };
      options.cursor.x = (options.cursor.x + spacing + fullAdvance) | 0;

      const main = allocateAokanaBitmap(glyphBitmap.width, glyphBitmap.height, format);
      clearAokanaBitmap(main);
      node.bitmap = main;
      if ((options.effect.mode | 0) === 0) {
        runAsActor(() => state.surfaces.compositor.draw(main, 0, 0, glyphBitmap, 0, 0));
      } else if ((options.effect.mode | 0) === 1) {
        const shadow = allocateAokanaBitmap(glyphBitmap.width, glyphBitmap.height, format);
        clearAokanaBitmap(shadow);
        recolorAlpha(shadow, glyphBitmap, options.effect.color);
        runAsActor(() =>
          state.surfaces.compositor.draw(
            main,
            effectRadiusX,
            effectRadiusY,
            shadow,
            1,
            (0x100 - options.effect.opacity) >>> 0,
          ),
        );
        shadow.storage?.release();
        runAsActor(() => state.surfaces.compositor.draw(main, 0, 0, glyphBitmap, 0, 0));
      } else if ((options.effect.mode | 0) === 2) {
        const outline = allocateAokanaBitmap(
          (scratchDimensions.width + effectWidth) | 0,
          (scratchDimensions.height + effectHeight) | 0,
          format,
        );
        clearAokanaBitmap(outline);
        runAsActor(() =>
          state.drawGlyphOutline(
            outline,
            character,
            current.record,
            effectRadiusX,
            effectRadiusY,
            options.effect.color,
          ),
        );
        const outlineView = {...outline};
        if ((options.proportional | 0) !== 0) cropToGlyph(outlineView, glyph);
        const previous = nodes.at(-1);
        if (previous?.auxiliary.storage !== null && previous?.auxiliary.storage !== undefined)
          runAsActor(() =>
            state.surfaces.compositor.draw(
              outlineView,
              (previous.x - node.x + effectRadiusX) | 0,
              (previous.y - node.y + effectRadiusY) | 0,
              previous.auxiliary,
              7,
              0x100,
            ),
          );
        runAsActor(() =>
          state.surfaces.compositor.draw(
            main,
            0,
            0,
            outlineView,
            1,
            (0x100 - options.effect.opacity) >>> 0,
          ),
        );
        runAsActor(() =>
          state.surfaces.compositor.draw(main, effectRadiusX, effectRadiusY, glyphBitmap, 0, 0),
        );
        node.auxiliary = runAsActor(() => copyBitmap(state, glyphBitmap));
        outline.storage?.release();
      }
      if (lineFirstGlyphIndex === null) lineFirstGlyphIndex = nodes.length;
      appendNode(nodes, node);
      revealTime = (revealTime + state.field1C9100) >>> 0;
      lineJustBroke = false;
    }
    glyphBitmap.storage?.release();
    index = nextIndex;
  }

  finishLine(false);
  const maximumFontSize = hadSource ? lineMaximum | 0 : 0;
  if (options.maximumFontSize !== undefined && options.maximumFontSize !== null)
    options.maximumFontSize.value = maximumFontSize;
  const outputCount =
    state.field1D1DBC === 0 ? lineCount : state.publishLineHeightLayout(lineHeights);
  if (current.transient) state.surfaces.fonts.releaseTransient(current.record);
  return {
    result: 1,
    nodes,
    outputCount,
    lineCount,
    maximumFontSize,
    lineHeights,
    cursor: options.cursor,
  };
}

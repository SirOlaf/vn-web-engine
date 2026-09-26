import {allocateAokanaBitmap, type AokanaBitmap, type AokanaBitmapRectangle} from './bitmap.js';
import {clearAokanaBitmap, copyAokanaBitmapRows} from './bitmap-copy.js';
import {rasterAokanaGlyph} from './font-bitmap.js';
import {recordAokanaBitmapText} from './bitmap-dom-text.js';
import {withAokanaBitmapText} from './bitmap-dom-text.js';
import type {AokanaFontRecord} from './fonts.js';
import {aokanaTextCodes, type AokanaRubyAnnotations} from './text-annotations.js';
import {isNativeCp932Lead, nativeCp932CharacterToWide, textByte} from './text.js';
import type {AokanaTextLayoutState} from './text-layout-state.js';
import type {
  AokanaHorizontalTextCursor,
  AokanaHorizontalTextEffect,
  AokanaHorizontalTextLayoutNode,
  AokanaHorizontalTextLayoutOptions,
} from './text-layout-horizontal.js';

// Exact CP932 byte tables at 17DFE0/17E010/17E0A0/17E0F0/17E110/17E120.
function table(hex: string): number[] {
  const bytes = Uint8Array.from(hex.match(/../g)!, (value) => parseInt(value, 16)),
    result: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    const first = bytes[i]!;
    result.push(isNativeCp932Lead(first) ? (first << 8) + bytes[++i]! : first);
  }
  return result;
}
const shifted = table(
  '8143814481418142829f82a182a382a582a782c182e182e382e5834083428344834683488362838383858387',
);
const grouped = new Set(
  table(
    '22272c2e3a3b3f21dedfa5814381448141814281468147814881498168814a814b815d5d7d29816a816c816e8170817281e2817481768178817a8152815381548155815881458164816384aa815c849f815b816081f4829f82a182a382a582a782c182e182e382e583408342834483468348836283838385838782f083928140',
  ),
);
const rotated = new Set(
  table(
    '81758176817781788179817a81738174816b816c8183818481e181e2817181728169816a816f8170816d816e818181e0817c8180815e816281648163815c849f8160815b81468147',
  ),
);
const opening = new Set(table('5b7b288169816b816d816f817181e181738175817781798167'));
const indented = new Set(table('8175814081698177816581672822'));
const trailing = new Set(
  table(
    '22272c2e3f21dedf8143814481418142814881498168814a814b5d7d29816a816c816e8170817281e2817481768178817a8152815381548155815881458164816384aa815c849f815b816081f4829f82a182a382a582a782c182e182e382e58340834283448346834883628383838583878140',
  ),
);

function divide(a: number, b: number): number {
  a |= 0;
  b |= 0;
  if (b === 0 || (a === -0x80000000 && b === -1))
    throw new RangeError('Aokana vertical layout native integer division fault');
  return Math.trunc(a / b) | 0;
}
function unit(bytes: Uint8Array, offset: number): {code: number; length: number} {
  const first = textByte(bytes, offset),
    lead = isNativeCp932Lead(first);
  return {code: lead ? (first << 8) + textByte(bytes, offset + 1) : first, length: lead ? 2 : 1};
}
function placement(code: number): {rotate: boolean; x: number; y: number} {
  if (rotated.has(code)) return {rotate: true, x: 0, y: 0};
  const index = shifted.indexOf(code),
    offset = index < 0 ? 0 : index < 4 ? 67 : 20;
  return {rotate: false, x: offset, y: -offset};
}
function allocate(state: AokanaTextLayoutState, width: number, height: number): AokanaBitmap {
  const format = state.surfaces.compositor.defaultFormat;
  const bitmap = allocateAokanaBitmap(width, height, format === 1 ? 2 : format);
  clearAokanaBitmap(bitmap);
  return bitmap;
}
function empty(): AokanaBitmap {
  return {storage: null, offset: 0, stride: 0, width: 0, height: 0, format: 0, bytesPerPixel: 0};
}

/** 0798E0: square-only clockwise copy, retaining the caller's descriptor/backing. */
function rotateAokanaVerticalGlyphPixels(bitmap: AokanaBitmap): boolean {
  if (bitmap.width !== bitmap.height) return false;
  const temporary = allocateAokanaBitmap(bitmap.width, bitmap.height, bitmap.format);
  try {
    const count = bitmap.bytesPerPixel === 4 ? 4 : bitmap.bytesPerPixel === 2 ? 2 : 1;
    for (let y = 0; y < bitmap.height >>> 0; y++)
      for (let x = 0; x < bitmap.width >>> 0; x++) {
        const input = bitmap.offset + y * bitmap.stride + x * bitmap.bytesPerPixel,
          output =
            temporary.offset +
            x * temporary.stride +
            (bitmap.width - 1 - y) * temporary.bytesPerPixel;
        if (bitmap.storage === null || temporary.storage === null)
          throw new TypeError('Aokana vertical glyph rotation dereferences null storage');
        bitmap.storage.range(input, count, true);
        temporary.storage.range(output, count, false);
        temporary.storage.bytes.set(bitmap.storage.bytes.subarray(input, input + count), output);
        temporary.storage.written(output, count);
      }
    copyAokanaBitmapRows(bitmap, temporary);
  } finally {
    temporary.storage?.release();
  }
  return true;
}

export const rotateAokanaVerticalGlyph = withAokanaBitmapText(rotateAokanaVerticalGlyphPixels, {
  source: 0,
  destination: 0,
  replace: true,
  map: (x, y, [bitmap]) => [bitmap.width - y, x],
});

function glyph(
  state: AokanaTextLayoutState,
  font: AokanaFontRecord,
  code: number,
  color: number,
  effect: AokanaHorizontalTextEffect,
  rotation: boolean,
  reading: boolean,
): AokanaBitmap {
  const size = font.size | 0,
    radiusX = Math.max(1, divide(Math.imul(effect.radiusXPercent, size), 100)),
    radiusY = Math.max(1, divide(Math.imul(effect.radiusYPercent, size), 100)),
    main = allocate(state, size, size),
    bitmap = allocate(
      state,
      (size + (effect.mode !== 0 ? radiusX : 0)) | 0,
      (size + (effect.mode !== 0 ? radiusY : 0)) | 0,
    ),
    wide = nativeCp932CharacterToWide(code);
  const draw = (destination: AokanaBitmap, selectedColor: number, decorative = false): void => {
    if (wide === 0) return;
    if (reading) {
      if (font.raster === null)
        throw new Error('Aokana vertical reading font raster is uninitialized');
      rasterAokanaGlyph(destination, font.raster, wide, selectedColor, {
        vertical: true,
        decorative,
      });
    } else
      state.customGlyphs.draw(destination, wide, font, selectedColor, state.field1D1D94, {
        vertical: true,
        decorative,
      });
  };
  try {
    draw(main, color);
    if (rotation) rotateAokanaVerticalGlyph(main);
    if ((effect.mode | 0) !== 0) {
      const shadow = allocate(state, size, size);
      try {
        if (effect.color >>> 0 === 0)
          state.surfaces.compositor.composite(shadow, main, 5, 256, true);
        else {
          draw(shadow, effect.color, true);
          // 079B60's colored reading shadow does not repeat the main glyph rotation.
          if (rotation && !reading) rotateAokanaVerticalGlyph(shadow);
        }
        recordAokanaBitmapText(shadow, '', {decorative: true, vertical: true});
        state.surfaces.compositor.draw(
          bitmap,
          radiusX,
          radiusY,
          shadow,
          1,
          (256 - effect.opacity) | 0,
        );
      } finally {
        shadow.storage?.release();
      }
    }
    state.surfaces.compositor.draw(bitmap, 0, 0, main, 0, 0);
    return bitmap;
  } catch (error) {
    bitmap.storage?.release();
    throw error;
  } finally {
    main.storage?.release();
  }
}
function node(
  state: AokanaTextLayoutState,
  bitmap: AokanaBitmap,
  code: number,
  sourceIndex: number,
  line: number,
  time: number,
  x: number,
  y: number,
  kind: number,
): AokanaHorizontalTextLayoutNode {
  return {
    procedureTime: 0,
    revealTime: time | 0,
    procedureState: 0,
    interval: state.field1C90E8,
    x: x | 0,
    y: y | 0,
    annotationX: 0,
    annotationY: 0,
    fontSize: 0,
    bitmap,
    auxiliary: empty(),
    annotationKey: null,
    annotationBaseExtent: 0,
    kind,
    next: null,
    character: code,
    sourceIndex,
    line,
  };
}
function relink(nodes: AokanaHorizontalTextLayoutNode[]): void {
  for (let i = 0; i < nodes.length; i++) nodes[i]!.next = nodes[i + 1] ?? null;
}

/** 07A090: independent CP932 vertical preparation; outputCount is the column count. */
export function buildAokanaVerticalTextLayout(
  state: AokanaTextLayoutState,
  options: AokanaHorizontalTextLayoutOptions,
): {result: 0 | 1; nodes: AokanaHorizontalTextLayoutNode[]; outputCount: number} {
  const font = state.surfaces.fonts.find(options.fontId),
    nodes: AokanaHorizontalTextLayoutNode[] = [];
  if (font === null) return {result: 0, nodes, outputCount: 0};
  const bytes = options.source.bytes,
    size = font.size | 0,
    half = (size + 1) >> 1,
    reading = (options.readingEnabled | 0) !== 0,
    wrapping = (options.wrapping | 0) !== 0,
    readingSize = reading ? state.readingSize(size) : 0,
    cursor = options.cursor,
    rectangle = options.rectangle;
  let offset = options.source.offset,
    forcedIndent = false;
  if (textByte(bytes, offset) >= 4 && textByte(bytes, offset) <= 8) {
    offset++;
    forcedIndent = true;
  }
  let resetY = 0;
  if (
    wrapping &&
    state.field1D1E4C !== 0 &&
    (forcedIndent || indented.has(unit(bytes, offset).code))
  )
    resetY =
      ((forcedIndent || unit(bytes, offset).length === 2 ? size : half) + state.field1D1E48) | 0;
  if (reading) {
    if ((cursor.y | 0) === (rectangle.top | 0)) cursor.y = (cursor.y + state.lineStartOffset) | 0;
    resetY = (resetY + state.lineStartOffset) | 0;
  }
  let columns = 1,
    rubyLeft = 0,
    punctuationLeft = 0,
    allowedCode = 0,
    time = 0;
  const newline = (): void => {
    cursor.x = (cursor.x - options.lineAdvance) | 0;
    cursor.y = (rectangle.top + resetY) | 0;
    columns = (columns + 1) | 0;
  };
  while (textByte(bytes, offset) !== 0) {
    const first = textByte(bytes, offset);
    if (first < 14) {
      if (first === 10) newline();
      offset++;
      continue;
    }
    const decoded = unit(bytes, offset),
      position = placement(decoded.code),
      bitmap = glyph(
        state,
        font,
        decoded.code,
        options.color,
        options.effect,
        position.rotate,
        false,
      ),
      entry = node(
        state,
        bitmap,
        decoded.code,
        offset - options.source.offset,
        columns - 1,
        time,
        0,
        0,
        position.y !== 0 ? 1 : 0,
      ),
      cell = (size + state.field1D1E48) | 0,
      next = offset + decoded.length;
    let lookahead = cell,
      afterKey = next,
      matchedRemaining = 0;
    if (reading) {
      if (rubyLeft < 1) {
        const key = options.annotations.matchEncodedPrefix({bytes, offset});
        if (key !== null) {
          const length = key.indexOf(0) < 0 ? key.length : key.indexOf(0),
            extent = Math.imul(length >>> 1, cell);
          lookahead = Math.max(lookahead, extent);
          entry.annotationKey = key.slice();
          entry.annotationBaseExtent = extent;
          matchedRemaining = (aokanaTextCodes(state.text, {bytes: key, offset: 0}) - 1) | 0;
          rubyLeft = matchedRemaining;
          afterKey = offset + length;
        }
      } else rubyLeft = (rubyLeft - 1) | 0;
    }
    let cancelReserve = false;
    if (wrapping) {
      if (punctuationLeft < 1) {
        let end = afterKey,
          count = 0,
          last = 0;
        for (;;) {
          const candidate = unit(bytes, end);
          if (!grouped.has(candidate.code)) break;
          last = candidate.code;
          count++;
          end += candidate.length;
        }
        if (count > 0) {
          punctuationLeft = (count + matchedRemaining) | 0;
          lookahead = (lookahead + Math.imul((end - afterKey) >>> 1, cell)) | 0;
          cancelReserve = trailing.has(last);
          if (cancelReserve) allowedCode = last;
        } else if (opening.has(decoded.code) && textByte(bytes, next) !== 0)
          lookahead = (lookahead + (isNativeCp932Lead(textByte(bytes, next)) ? size : half)) | 0;
      } else punctuationLeft = (punctuationLeft - 1) | 0;
    }
    const bottom = (rectangle.bottom - (wrapping && !cancelReserve ? size : 0) + 1) | 0;
    if (((cursor.y + lookahead) | 0) > bottom) {
      if (decoded.code === allowedCode) allowedCode = 0;
      else newline();
    }
    entry.x = (cursor.x + 1 + divide(Math.imul(position.x, size), 100) - readingSize - size) | 0;
    entry.y = (cursor.y + divide(Math.imul(position.y, size), 100)) | 0;
    cursor.y = (cursor.y + cell) | 0;
    nodes.push(entry);
    time = (time + state.field1C9100) | 0;
    offset = next;
  }
  relink(nodes);
  return {result: 1, nodes, outputCount: columns};
}

/** 079F00/079B60 use the base font settings and splice readings after each keyed parent. */
export async function addAokanaVerticalReadings(
  state: AokanaTextLayoutState,
  nodes: AokanaHorizontalTextLayoutNode[],
  fontId: number,
  color: number,
  effect: AokanaHorizontalTextEffect,
  annotations: AokanaRubyAnnotations,
): Promise<0 | 1> {
  const operationAllocator = state.surfaces.allocator,
    operationActor = operationAllocator.currentActor;
  const runAsActor = <T>(operation: () => T): T =>
    operationAllocator.withActor(operationActor, operation);
  const base = state.surfaces.fonts.find(fontId);
  if (base === null) return 0;
  const selected = await state.surfaces.fonts.get(
    base.name,
    state.readingSize(base.size),
    base.widthPercent,
    base.bold,
  );
  if (selected.result !== 0) return 0;
  const font = state.surfaces.fonts.find(selected.id);
  if (font === null) throw new Error('Aokana vertical reading font was not published');
  for (let index = 0; index < nodes.length; index++) {
    const parent = nodes[index]!;
    if (parent.annotationKey === null) continue;
    const annotation = annotations.query({bytes: parent.annotationKey, offset: 0});
    if (annotation === null)
      throw new Error('Aokana vertical reading key is absent from its registry');
    const count = annotation.readingLength | 0,
      size = font.size | 0,
      advance = Math.max(size, divide(parent.annotationBaseExtent, count)),
      step =
        Math.trunc(
          (Math.imul(annotation.keyWideLength, state.field1C9100) >>> 0) / (count >>> 0),
        ) >>> 0,
      readings: AokanaHorizontalTextLayoutNode[] = [];
    let y =
        (parent.y +
          (size >> 3) +
          (((parent.annotationBaseExtent - (Math.imul(count - 1, advance) + size)) | 0) >> 1)) |
        0,
      time = (parent.revealTime + (step >>> 1)) | 0;
    for (let i = 0; i < count; i++) {
      const code = annotation.codes[i];
      if (code === undefined)
        throw new RangeError('Aokana vertical reading code exceeds its native array');
      const first = code > 255 ? (code >>> 8) & 255 : code & 255,
        packed = isNativeCp932Lead(first) ? (first << 8) + (code & 255) : first,
        bitmap = runAsActor(() =>
          glyph(state, font, code, color, effect, placement(packed).rotate, true),
        );
      readings.push(
        node(
          state,
          bitmap,
          code,
          parent.sourceIndex,
          parent.line,
          time,
          (base.size + parent.x) | 0,
          y,
          2,
        ),
      );
      y = (y + advance) | 0;
      time = (time + step) | 0;
    }
    nodes.splice(index + 1, 0, ...readings);
  }
  relink(nodes);
  return 1;
}

/** 0796E0 groups only on kind-zero X; kind-one contributes height and kind-two inherits shift. */
export function alignAokanaVerticalTextNodes(
  state: AokanaTextLayoutState,
  nodes: AokanaHorizontalTextLayoutNode[],
  cursor: AokanaHorizontalTextCursor,
  rectangle: AokanaBitmapRectangle,
  fontId: number,
  wrapping: number,
  alignment: number,
): void {
  if ((alignment | 0) === 0) return;
  const size = state.surfaces.fonts.find(fontId)?.size ?? 0,
    groups = [{x: -0x80000000, extent: 0}];
  let group = groups[0]!;
  for (const entry of nodes) {
    if (entry.kind >>> 0 < 2) {
      if (entry.kind === 0 && group.x !== (entry.x | 0)) {
        group = {x: entry.x | 0, extent: entry.y | 0};
        groups.push(group);
      }
      group.extent = (group.extent + size) | 0;
    }
  }
  let index = 0,
    shift = 0;
  group = groups[0]!;
  for (const entry of nodes) {
    if (entry.kind === 0 && group.x !== (entry.x | 0)) {
      group = groups[++index]!;
      if ((alignment | 0) === 1)
        shift =
          ((rectangle.bottom -
            (wrapping !== 0 && group.extent < rectangle.bottom ? size : 0) -
            group.extent -
            state.lineStartOffset) |
            0) >>
          1;
      else if ((alignment | 0) === 2)
        shift = (rectangle.bottom - group.extent - (state.overlayFrames?.[0]?.height ?? 0)) | 0;
    }
    entry.y = (entry.y + shift) | 0;
  }
  if ((cursor.y | 0) > (rectangle.top | 0)) cursor.y = (cursor.y + shift) | 0;
}

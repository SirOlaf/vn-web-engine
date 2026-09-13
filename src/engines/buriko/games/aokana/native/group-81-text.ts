import type {AokanaBpPointer} from '../bp/memory.js';
import {pointerView} from '../bp/memory.js';
import {pop32, push32} from '../bp/state.js';
import type {AokanaBpOpcodeContext, AokanaNativeSlotDefinition} from './types.js';
import {AokanaNativeText, copyText, textByte, textBytes, textLength, writeText} from './text.js';

function popPointer(h: AokanaBpOpcodeContext): AokanaBpPointer | null {
  return h.memory.resolve(h.thread, pop32(h.thread));
}
function requirePointer(pointer: AokanaBpPointer | null): AokanaBpPointer {
  if (pointer === null) throw new Error('Aokana native text null pointer');
  return pointer;
}

/** 1400f7500 retains native character values, truncating each to one WORD. */
export function nativeCharacterWords(
  text: AokanaNativeText,
  destination: AokanaBpPointer | null,
  source: AokanaBpPointer,
): number {
  const mode = text.detectEncoding(source.bytes, source.offset);
  let count = 0,
    offset = source.offset;
  while (textByte(source.bytes, offset) !== 0) {
    const character = text.readCharacter(source.bytes, offset, mode);
    offset += character.length;
    if (destination !== null) {
      pointerView({bytes: destination.bytes, offset: destination.offset + count * 2}, 2).setUint16(
        0,
        character.value,
        true,
      );
    }
    count = (count + 1) | 0;
  }
  if (destination !== null) {
    pointerView({bytes: destination.bytes, offset: destination.offset + count * 2}, 2).setUint16(
      0,
      0,
      true,
    );
  }
  return count;
}

function words(pointer: AokanaBpPointer): number[] {
  const result: number[] = [];
  for (let offset = pointer.offset; ; offset += 2) {
    const value = pointerView({bytes: pointer.bytes, offset}, 2).getUint16(0, true);
    if (value === 0) return result;
    result.push(value);
  }
}

/** 1400f7590: native WORD-sequence similarity via shortest common supersequence. */
export function nativeWordSimilarity(
  left: AokanaBpPointer | null,
  right: AokanaBpPointer | null,
): number {
  if (left === null || right === null) return 0xffffffff;
  const a = words(left),
    b = words(right);
  if (a.length === 0) return 0;
  const width = a.length + 1,
    height = b.length + 1;
  const equalCount = a.length * b.length,
    costCount = width * height;
  if (equalCount > 0x7fffffff || costCount > 0x7fffffff) {
    throw new RangeError('Aokana native similarity allocation size overflows signed DWORD');
  }
  const equal = new Uint32Array(equalCount),
    cost = new Uint32Array(costCount);
  for (let y = 0; y < b.length; y++) {
    for (let x = 0; x < a.length; x++) equal[y * a.length + x] = Number(a[x] === b[y]);
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x === 0 && y === 0) continue;
      const leftCost = x > 0 ? cost[y * width + x - 1]! : -1;
      const aboveCost = y > 0 ? cost[(y - 1) * width + x]! : -1;
      const diagonal =
        x > 0 && y > 0 && equal[(y - 1) * a.length + x - 1] !== 0
          ? cost[(y - 1) * width + x - 1]!
          : -1;
      let minimum =
        leftCost < 0 ? aboveCost : aboveCost < 0 ? leftCost : Math.min(leftCost, aboveCost);
      if (diagonal >= 0 && diagonal < minimum) minimum = diagonal;
      cost[y * width + x] = minimum + 1;
    }
  }
  return (a.length + b.length - cost[cost.length - 1]!) >>> 0;
}

/** The six text slots of primary 81 share the native encoding globals. */
export function createGroup81Text(text: AokanaNativeText): AokanaNativeSlotDefinition[] {
  return [
    {
      primary: 0x81,
      secondary: 0x00,
      nativeAddress: 0x1400ec8a0,
      name: 'SelectTextEncoding',
      execute: (h) => {
        push32(h.thread, Number(text.selectMode(pop32(h.thread))));
        return 0;
      },
    },
    {
      primary: 0x81,
      secondary: 0x20,
      nativeAddress: 0x1400ec170,
      name: 'ConvertTextEncoding',
      execute: (h) => {
        const mode = pop32(h.thread),
          source = popPointer(h),
          destination = popPointer(h);
        let length = 0;
        if (mode === 0 || mode === 1 || mode === 0xffffffff) {
          const input = requirePointer(source);
          const sourceMode = text.detectEncoding(input.bytes, input.offset);
          const targetMode = mode === 0xffffffff ? text.mode : mode;
          if (destination !== null && (sourceMode === 0x80000000 || sourceMode === targetMode)) {
            copyText(destination, input);
            length = textLength(destination);
          } else {
            const converted = text.convertEncoding(input, mode);
            if (destination !== null) writeText(destination, converted);
            length = converted.indexOf(0);
          }
        } else if (mode === 2) {
          const decoded = text.decodeAuto(requirePointer(source));
          const nul = decoded.indexOf('\0');
          length = nul < 0 ? decoded.length : nul;
          if (destination !== null) {
            const view = pointerView(destination, (length + 1) * 2);
            for (let index = 0; index < length; index++)
              view.setUint16(index * 2, decoded.charCodeAt(index), true);
            view.setUint16(length * 2, 0, true);
          }
        }
        push32(h.thread, length);
        return 0;
      },
    },
    {
      primary: 0x81,
      secondary: 0x21,
      nativeAddress: 0x1400ec130,
      name: 'ConvertCp932ToUtf8',
      execute: (h) => {
        const source = popPointer(h),
          destination = popPointer(h);
        if (source !== null) {
          const converted = text.encodeWide(text.decodeCp932(textBytes(source)), 1);
          if (destination !== null) writeText(destination, converted);
        }
        return 0;
      },
    },
    {
      primary: 0x81,
      secondary: 0x27,
      nativeAddress: 0x1400ec100,
      name: 'DetectTextEncoding',
      execute: (h) => {
        const source = requirePointer(popPointer(h));
        push32(h.thread, text.detectEncoding(source.bytes, source.offset));
        return 0;
      },
    },
    {
      primary: 0x81,
      secondary: 0xb0,
      nativeAddress: 0x1400eaeb0,
      name: 'WordSequenceSimilarity',
      execute: (h) => {
        const right = popPointer(h),
          left = popPointer(h);
        push32(h.thread, nativeWordSimilarity(left, right));
        return 0;
      },
    },
    {
      primary: 0x81,
      secondary: 0xb7,
      nativeAddress: 0x1400eae60,
      name: 'DecodeNativeCharacterWords',
      execute: (h) => {
        const source = popPointer(h),
          destination = popPointer(h);
        // The detector dereferences source before the lower function's nominal null check.
        push32(h.thread, nativeCharacterWords(text, destination, requirePointer(source)));
        return 0;
      },
    },
  ];
}

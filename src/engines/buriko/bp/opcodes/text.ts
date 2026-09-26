import type {BurikoBpOpcodeContext, BurikoBpOpcodeHandler} from '../../native/types.js';
import {
  BurikoNativeText,
  copyText,
  isNativePunctuation,
  nativeCp932CharacterToWide,
  textLength,
  writeNativeUtf8,
  writeText,
} from '../../native/text.js';
import {formatVmText} from '../../native/text-format.js';
import type {BurikoBpPointer} from '../memory.js';
import {pop32, push32} from '../state.js';
import {moveBytes} from './operands.js';

function popPointer(h: BurikoBpOpcodeContext): BurikoBpPointer | null {
  return h.memory.resolve(h.thread, pop32(h.thread));
}

function nonnull(pointer: BurikoBpPointer | null): BurikoBpPointer {
  if (pointer === null) throw new Error('Buriko native text dereferences a null pointer');
  return pointer;
}

function displaced(pointer: BurikoBpPointer, offset: number): BurikoBpPointer {
  return {bytes: pointer.bytes, offset: pointer.offset + offset};
}

/** 1400f80d0 keeps pointers live across writes; the search needle's original byte length advances input. */
function replaceText(
  text: BurikoNativeText,
  destination: BurikoBpPointer,
  source: BurikoBpPointer,
  needle: BurikoBpPointer,
  replacement: BurikoBpPointer,
): number {
  const replacementBytes = text.convertEncoding(
    replacement,
    text.detectEncoding(source.bytes, source.offset),
  );
  const replacementPointer = {bytes: replacementBytes, offset: 0};
  const needleLength = textLength(needle),
    replacementLength = textLength(replacementPointer);
  const mode = text.detectEncoding(source.bytes, source.offset);
  let count = 0;
  for (;;) {
    const found = text.find(source, needle, mode);
    if (found === null || (found | 0) < 0) break;
    if (found !== 0) {
      moveBytes(destination, source, found);
      destination = displaced(destination, found);
      source = displaced(source, found);
    }
    copyText(destination, replacementPointer);
    source = displaced(source, needleLength | 0);
    destination = displaced(destination, replacementLength | 0);
    count = (count + 1) | 0;
  }
  copyText(destination, source);
  return count;
}

function wrapText(
  text: BurikoNativeText,
  destination: BurikoBpPointer,
  source: BurikoBpPointer | null,
  character: number,
): void {
  if (text.mode === 0) {
    // Native narrow sprintf writes the first %c before measuring its %s operand.
    writeText(destination, Uint8Array.of(character));
    const input = source ?? {bytes: Uint8Array.of(40, 110, 117, 108, 108, 41, 0), offset: 0};
    const length = textLength(input);
    const middle = displaced(destination, 1);
    // CRT string_output_adapter<char>::write_string at 14001b5b8 calls native memmove.
    moveBytes(middle, input, length);
    writeText(displaced(destination, length + 1), Uint8Array.of(character, 0));
  } else {
    const encoded = writeNativeUtf8(character),
      input = nonnull(source),
      length = textLength(input);
    writeText(destination, encoded);
    moveBytes(displaced(destination, encoded.length), input, length);
    writeText(displaced(destination, encoded.length + length), encoded);
    writeText(displaced(destination, encoded.length * 2 + length), Uint8Array.of(0));
  }
}

/** Primary 66..6f share the executable's mutable text mode with native groups 7f and 81. */
export function createTextOpcodes(
  text: BurikoNativeText,
): Readonly<Record<number, BurikoBpOpcodeHandler>> {
  return {
    0x66: (h) => {
      const needle = popPointer(h),
        source = popPointer(h);
      push32(h.thread, text.find(nonnull(source), nonnull(needle)) ?? -1);
      return 0;
    },
    0x67: (h) => {
      const replacement = popPointer(h),
        needle = popPointer(h),
        source = popPointer(h),
        destination = popPointer(h);
      push32(
        h.thread,
        replaceText(
          text,
          nonnull(destination),
          nonnull(source),
          nonnull(needle),
          nonnull(replacement),
        ),
      );
      return 0;
    },
    0x68: (h) => {
      push32(h.thread, textLength(nonnull(popPointer(h))));
      return 0;
    },
    0x69: (h) => {
      const right = popPointer(h),
        left = popPointer(h);
      push32(
        h.thread,
        Number(left !== null && right !== null && text.decodeAuto(left) === text.decodeAuto(right)),
      );
      return 0;
    },
    0x6a: (h) => {
      const source = popPointer(h),
        destinationAddress = pop32(h.thread);
      if (h.diagnostics.writeWatchEnabled)
        h.diagnostics.checkWrite(h.thread, destinationAddress, textLength(nonnull(source)) + 1);
      const destination = h.memory.resolve(h.thread, destinationAddress);
      copyText(nonnull(destination), nonnull(source));
      return 0;
    },
    0x6b: (h) => {
      const second = popPointer(h),
        first = popPointer(h),
        destination = popPointer(h);
      copyText(nonnull(destination), nonnull(first));
      copyText(displaced(nonnull(destination), textLength(nonnull(first))), nonnull(second));
      return 0;
    },
    0x6c: (h) => {
      const source = nonnull(popPointer(h)),
        mode = text.detectEncoding(source.bytes, source.offset);
      const character = text.readCharacter(source.bytes, source.offset, mode);
      push32(h.thread, character.length);
      push32(h.thread, character.value);
      push32(h.thread, character.fullWidth);
      push32(
        h.thread,
        Number(
          isNativePunctuation(
            mode === 0 ? nativeCp932CharacterToWide(character.value) : character.value,
          ),
        ),
      );
      return 0;
    },
    0x6d: (h) => {
      text.lowercase(nonnull(popPointer(h)));
      return 0;
    },
    0x6e: (h) => {
      const character = pop32(h.thread),
        source = popPointer(h),
        destination = popPointer(h);
      wrapText(text, nonnull(destination), source, character);
      return 0;
    },
    0x6f: (h) => {
      const format = popPointer(h),
        destinationAddress = pop32(h.thread);
      const destination = nonnull(h.memory.resolve(h.thread, destinationAddress));
      writeText(destination, formatVmText(h, nonnull(format), text));
      h.diagnostics.checkWrite(h.thread, destinationAddress, textLength(destination) + 1);
      return 0;
    },
  };
}

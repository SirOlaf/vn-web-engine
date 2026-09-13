import type {AokanaBpPointer} from '../bp/memory.js';
import {AokanaNativeFonts} from './fonts.js';
import {AokanaNativeDisplayState, type AokanaNativeRectangle} from './display-state.js';
import {aokanaWideCharacter} from './font-raster.js';
import {copyText} from './text.js';

/** 1400f8a50 consumes one UTF-16 unit or one well-formed surrogate pair. */
export function aokanaInlineTextWidth(value: string): number {
  let width = 0;
  for (let index = 0; index < value.length; index++) {
    let character = value.charCodeAt(index);
    if (character === 0) break;
    const following = value.charCodeAt(index + 1);
    if (character >= 0xd800 && character < 0xdc00 && following >= 0xdc00 && following < 0xe000) {
      character = ((character - 0xd800) << 10) + following - 0xdc00 + 0x10000;
      index++;
    }
    width = (width + Number(aokanaWideCharacter(character) !== 0) + 1) | 0;
  }
  return width;
}

export interface AokanaInlineTextSpecification {
  readonly font: Uint8Array;
  readonly fontSize: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly nativeRectangle: AokanaNativeRectangle;
  readonly multiline: boolean;
  readonly limit: number;
  readonly focus: number;
}

/** Globals and input policy for the actual EDIT subclass at 1400b8590. */
export class AokanaInlineTextState {
  widthPercent = 100; // 1401c913c
  textColorBgr = 0xffffff; // 1401c9148
  hideOnReturn = 0; // 1401e6ff0
  limit = 0; // 1401e6ff4
  rejectAscii = 0; // 1401e7008
  alignment = 0; // 1401e700c
  readonly initial = new Uint8Array(256); // 1401e7010..1401e710f
  visible = 0; // 1401e7110
  rectangle: AokanaNativeRectangle = [0, 0, 0, 0];

  setWidthPercent(value: number): 0 | 1 {
    if ((value - 25) >>> 0 >= 176) return 0;
    this.widthPercent = value | 0;
    return 1;
  }
  setAlignment(value: number): 0 | 1 {
    if (value >>> 0 >= 3) return 0;
    this.alignment = value | 0;
    return 1;
  }
  setColor(value: number): void {
    this.textColorBgr =
      (((value >>> 8) & 255) << 8) | ((value >>> 16) & 255) | ((value & 255) << 16);
  }
  setInitial(source: AokanaBpPointer | null): void {
    if (source === null) throw new Error('Aokana inline text initial string dereferences NULL');
    // The next global after this raw buffer is the visibility word; continuing past
    // the buffer corrupts native control globals rather than extending the string.
    copyText({bytes: this.initial, offset: 0}, source);
  }

  /** Only WM_CHAR enters this filter; WM_PASTE/direct text replacement does not. */
  character(
    wParam: number | bigint,
    current: string,
    selectionStart: number,
    selectionEnd: number,
    clipboard: string | null = null,
  ): 'consume' | 'default' | 'submit' {
    const character = BigInt.asUintN(64, BigInt(wParam));
    if ((this.rejectAscii !== 0 && character >= 0x20n && character <= 0x7fn) || character === 9n)
      return 'consume';
    if (character === 13n) return 'submit';
    let incoming = 0;
    if (character === 0x16n) {
      if (clipboard !== null) {
        const nul = clipboard.indexOf('\0'),
          copied = nul < 0 ? clipboard : clipboard.slice(0, nul);
        if (copied.length > 1023)
          throw new RangeError('Aokana inline text clipboard overwrites native wide stack scratch');
        incoming = aokanaInlineTextWidth(copied);
      }
    } else if (character < 0x20n) {
      if (character === 3n || character === 8n || character === 24n) return 'default';
      return 'consume';
    } else incoming = Number(aokanaWideCharacter(Number(BigInt.asUintN(32, character))) !== 0) + 1;
    const nul = current.indexOf('\0');
    const copied = (nul < 0 ? current : current.slice(0, nul)).slice(0, 1023);
    const existing = aokanaInlineTextWidth(copied);
    // EM_GETSEL returns -1 when the indices do not fit its packed return DWORD.
    const start = selectionStart > 65535 || selectionEnd > 65535 ? 65535 : selectionStart & 65535;
    const end = selectionStart > 65535 || selectionEnd > 65535 ? 65535 : selectionEnd & 65535;
    if (end > start) {
      if (end > copied.length + 1)
        throw new Error('Aokana inline selection copies unwritten native wide stack bytes');
      incoming = (incoming - aokanaInlineTextWidth((copied + '\0').slice(start, end))) | 0;
    }
    return ((incoming + existing) | 0) <= (this.limit | 0) ? 'default' : 'consume';
  }

  /** Validation order of b8b30; successful state mutation belongs to the control lifecycle. */
  specification(
    display: AokanaNativeDisplayState,
    fonts: AokanaNativeFonts,
    x: number,
    y: number,
    width: number,
    height: number,
    font: number,
    size: number,
    limit: number,
    focus: number,
  ): {result: 1 | 2 | 3 | 4} | {result: 0; value: AokanaInlineTextSpecification} {
    width >>>= 0;
    height >>>= 0;
    size >>>= 0;
    if (width <= 7 || width > display.logicalWidth || height <= 7 || height > display.logicalHeight)
      return {result: 1};
    const name = fonts.name(font);
    if (name === null) return {result: 2};
    if ((size - 8) >>> 0 >= 57) return {result: 3};
    if ((limit - 1) >>> 0 >= 256) return {result: 4};
    const rectangle: AokanaNativeRectangle = [x | 0, y | 0, (x + width) | 0, (y + height) | 0];
    return {
      result: 0,
      value: {
        font: name,
        fontSize: size,
        x: x | 0,
        y: y | 0,
        width,
        height,
        nativeRectangle: [
          rectangle[0],
          rectangle[1],
          (rectangle[2] - 1) | 0,
          (rectangle[3] - 1) | 0,
        ],
        multiline: Math.floor(height / size) >= 2,
        limit: limit | 0,
        focus: focus | 0,
      },
    };
  }
}

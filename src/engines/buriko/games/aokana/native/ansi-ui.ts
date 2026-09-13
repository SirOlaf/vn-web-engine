import type {AokanaBpPointer} from '../bp/memory.js';
import {AokanaNativeText, copyText, textBytes} from './text.js';

/** Japanese Windows host ACP, independent of BGI_Text_SelectEncodingMode. */
export class AokanaAnsiUi {
  constructor(readonly text: AokanaNativeText) {}

  decode(pointer: AokanaBpPointer): string {
    return this.text.decodeCp932(textBytes(pointer));
  }
  encode(value: string): Uint8Array {
    return this.text.encodeWide(value, 0);
  }
  byteLength(value: string): number {
    return this.encode(value).length - 1;
  }

  /** GetWindowTextA copies a raw byte prefix; its final byte can be a DBCS lead. */
  getText(value: string, capacity: number): Uint8Array {
    if (capacity <= 0) return new Uint8Array();
    const encoded = this.encode(value);
    const count = Math.min(encoded.length - 1, capacity - 1);
    const output = new Uint8Array(count + 1);
    output.set(encoded.subarray(0, count));
    return output;
  }
  writeText(output: AokanaBpPointer | null, value: string, capacity: number): void {
    if (capacity <= 0) return;
    if (output === null) throw new Error('Aokana ANSI control writes text through a null output');
    copyText(output, {bytes: this.getText(value, capacity), offset: 0});
  }

  /** b01d0/afcb0 copy a byte-limited initial value into a zeroed 1024-byte local. */
  initial(pointer: AokanaBpPointer | null, requestedLimit: number): {value: string; bytes: number} {
    if (pointer === null) return {value: '', bytes: 0};
    const bytes = textBytes(pointer);
    const count = Math.min(bytes.length, requestedLimit > 0 ? requestedLimit : bytes.length);
    if (count > 1024)
      throw new RangeError('Aokana ANSI initial text overwrites its 1024-byte native stack buffer');
    if (count === 1024)
      throw new Error('Aokana ANSI initial text scans beyond its unterminated native stack buffer');
    return {value: this.text.decodeCp932(bytes.subarray(0, count)), bytes: count};
  }

  /** EM_LIMITTEXT counts UTF-16 units on Unicode controls and ACP bytes on ANSI controls. */
  insertion(
    current: string,
    start: number,
    end: number,
    inserted: string,
    limit: number,
    unicode: boolean,
  ): string {
    const count = (value: string): number => (unicode ? value.length : this.byteLength(value));
    const left = current.slice(0, start),
      right = current.slice(end);
    let remaining = Math.max(0, limit - count(left) - count(right)),
      accepted = '';
    for (let index = 0; index < inserted.length; index++) {
      const character = inserted[index]!;
      if (character === '\0') break;
      const size = count(character);
      if (size > remaining) break;
      accepted += character;
      remaining -= size;
    }
    return accepted;
  }

  /** b0420 checks emptiness before '-' without accounting for the selected replacement. */
  numericCharacter(code: number, current: string): boolean {
    return code === 0x2d
      ? this.byteLength(current) === 0
      : code === 8 || (code >= 0x30 && code <= 0x39);
  }

  /** Real browser editing, with platform limit enforcement separate from the native WM_CHAR filter. */
  bindEdit(
    input: HTMLInputElement,
    requestedLimit: number,
    unicode: boolean,
    numeric: boolean,
  ): void {
    const limit = requestedLimit > 0 ? Math.min(requestedLimit, 0x7ffffffe) : 32767;
    let previous = input.value,
      composing = false;
    const replace = (value: string, filter: boolean): void => {
      const start = input.selectionStart ?? 0,
        end = input.selectionEnd ?? start;
      let inserted = '',
        current = input.value;
      for (let index = 0; index < value.length; index++) {
        const character = value[index]!;
        if (filter && numeric && !this.numericCharacter(character.charCodeAt(0), current)) continue;
        const accepted = this.insertion(
          current,
          start + inserted.length,
          inserted.length === 0 ? end : start + inserted.length,
          character,
          limit,
          unicode,
        );
        if (accepted.length === 0) break;
        inserted += accepted;
        current = input.value.slice(0, start) + inserted + input.value.slice(end);
      }
      if (inserted.length !== 0) input.setRangeText(inserted, start, end, 'end');
      previous = input.value;
    };
    input.addEventListener('beforeinput', (event) => {
      if (event.isComposing) return;
      if (!event.inputType.startsWith('insert') || event.data === null) {
        previous = input.value;
        return;
      }
      event.preventDefault();
      replace(event.data, event.inputType === 'insertText');
    });
    input.addEventListener('paste', (event) => {
      if (event.clipboardData === null) return;
      event.preventDefault();
      replace(event.clipboardData.getData('text/plain'), false);
    });
    const reconcile = (): void => {
      const value = input.value;
      let start = 0,
        oldEnd = previous.length,
        newEnd = value.length;
      while (start < oldEnd && start < newEnd && previous[start] === value[start]) start++;
      while (oldEnd > start && newEnd > start && previous[oldEnd - 1] === value[newEnd - 1]) {
        oldEnd--;
        newEnd--;
      }
      const accepted = this.insertion(
        previous,
        start,
        oldEnd,
        value.slice(start, newEnd),
        limit,
        unicode,
      );
      if (accepted !== value.slice(start, newEnd)) {
        input.value = previous.slice(0, start) + accepted + previous.slice(oldEnd);
        input.setSelectionRange(start + accepted.length, start + accepted.length);
      }
      previous = input.value;
    };
    input.addEventListener('compositionstart', () => {
      previous = input.value;
      composing = true;
    });
    input.addEventListener('compositionend', () => {
      composing = false;
      reconcile();
    });
    input.addEventListener('input', () => {
      if (!composing) reconcile();
    });
  }
}

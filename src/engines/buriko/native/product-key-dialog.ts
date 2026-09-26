import type {BurikoBpPointer} from '../bp/memory.js';
import {BurikoEngineDialogs} from './engine-dialogs.js';
import {BurikoNativeText, textBytes, writeText} from './text.js';
import {burikoWideCharacter} from './font-raster.js';

/** 1400af330/1400af420 and its four subclassed Unicode edit controls (1400af990). */
export class BurikoProductKeyDialog {
  /** DAT_1401e6498 survives closing/reopening the dialog. */
  private discardNextCharacter = false;
  constructor(
    readonly document: Document,
    readonly parent: HTMLElement,
    readonly dialogs: BurikoEngineDialogs,
    readonly text: BurikoNativeText,
  ) {}

  /** WM_CHAR filtering does not apply to paste, programmatic text, or other edit messages. */
  acceptCharacter(code: number, numeric: boolean): boolean {
    code >>>= 0;
    if (this.discardNextCharacter) {
      this.discardNextCharacter = false;
      return false;
    }
    if (burikoWideCharacter(code) !== 0) {
      this.discardNextCharacter = true;
      return false;
    }
    if (code === 8) return true;
    return (
      (code >= 48 && code <= 57) ||
      (!numeric && ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)))
    );
  }

  show(
    output: BurikoBpPointer | null,
    title: BurikoBpPointer | null,
    prompt: BurikoBpPointer | null,
    requestedLength: number,
  ): Promise<0 | 1> {
    return this.dialogs.withNativeModal(async () => {
      requestedLength |= 0;
      const numeric = requestedLength < 0;
      const absolute = numeric ? -requestedLength | 0 : requestedLength;
      const limit = absolute < 33 ? absolute : 32;
      const caption = title === null ? 'プロダクトキーの入力' : this.text.decodeAuto(title);
      let prompts: string[];
      if (prompt === null) prompts = ['プロダクトキーを入力してください'];
      else {
        const raw = textBytes(prompt);
        if (raw.length >= 1024)
          throw new RangeError('Buriko product-key prompt overwrites native stack scratch storage');
        // Native character search f86e0 locates LF in the detected source encoding.
        const position = this.text.findCharacter(prompt, 10);
        if (position === null) prompts = [this.text.decodeAuto(prompt)];
        else {
          const first = new Uint8Array(position - prompt.offset + 1);
          first.set(prompt.bytes.subarray(prompt.offset, position));
          prompts = [
            this.text.decodeAuto({bytes: first, offset: 0}),
            this.text.decodeAuto({bytes: prompt.bytes, offset: position + 1}),
          ];
        }
      }
      return new Promise<0 | 1>((resolve, reject) => {
        const dialog = this.document.createElement('dialog');
        dialog.setAttribute('aria-label', caption);
        const heading = this.document.createElement('h2');
        heading.textContent = caption;
        dialog.append(heading);
        for (const value of prompts) {
          const paragraph = this.document.createElement('p');
          paragraph.textContent = value;
          dialog.append(paragraph);
        }
        const inputs: HTMLInputElement[] = [];
        for (let index = 0; index < 4; index++) {
          const input = this.document.createElement('input');
          input.type = 'text';
          input.autocomplete = 'off';
          input.setAttribute('aria-label', `${index + 1}`);
          if (limit > 0) input.maxLength = limit;
          input.inputMode = numeric ? 'numeric' : 'text';
          if (index > 0) dialog.append(this.document.createTextNode(' - '));
          dialog.append(input);
          inputs.push(input);
        }
        const okay = this.document.createElement('button');
        okay.type = 'button';
        okay.textContent = 'OK';
        const cancel = this.document.createElement('button');
        cancel.type = 'button';
        cancel.textContent = 'ｷｬﾝｾﾙ';
        const finish = (accepted: boolean): void => {
          try {
            if (accepted) {
              if (output === null)
                throw new Error('Buriko product-key dialog dereferences a null output');
              // Four GetWindowTextW(...,33) calls, forced UTF-8 encoding, separator writes in order.
              writeText(output, Uint8Array.of(0));
              let offset = output.offset;
              for (const input of inputs) {
                const encoded = this.text.encodeWide(input.value.slice(0, 32), 1);
                writeText({bytes: output.bytes, offset}, encoded);
                offset += encoded.length - 1;
                writeText({bytes: output.bytes, offset}, Uint8Array.of(45));
                offset++;
              }
              writeText({bytes: output.bytes, offset: offset - 1}, Uint8Array.of(0));
            }
            dialog.close();
            dialog.remove();
            resolve(accepted ? 1 : 0);
          } catch (error) {
            reject(error);
          }
        };
        inputs.forEach((input, index) => {
          input.addEventListener('beforeinput', (event) => {
            if (event.inputType !== 'insertText' || event.data === null) return;
            let inserted = '';
            const start = input.selectionStart ?? input.value.length;
            const end = input.selectionEnd ?? start;
            for (let at = 0; at < event.data.length; at++) {
              const code = event.data.charCodeAt(at);
              if (!this.acceptCharacter(code, numeric)) continue;
              if (
                limit > 0 &&
                Math.min(input.value.length, 32) + start - end + inserted.length >= limit - 1
              )
                (inputs[index + 1] ?? okay).focus();
              inserted += String.fromCharCode(code);
            }
            event.preventDefault();
            const capacity =
              limit > 0 ? Math.max(0, limit - (input.value.length - (end - start))) : Infinity;
            input.setRangeText(inserted.slice(0, capacity), start, end, 'end');
          });
          input.addEventListener('keydown', (event) => {
            // Backspace also passes through the global discard latch before the native edit proc.
            if (event.key === 'Backspace' && !this.acceptCharacter(8, numeric))
              event.preventDefault();
          });
        });
        okay.addEventListener('click', () => finish(true));
        cancel.addEventListener('click', () => finish(false));
        dialog.append(okay, cancel);
        dialog.addEventListener('cancel', (event) => {
          event.preventDefault();
          finish(false);
        });
        try {
          this.parent.append(dialog);
          dialog.showModal();
          inputs[0]!.focus();
        } catch (error) {
          dialog.remove();
          reject(error);
        }
      });
    });
  }
}

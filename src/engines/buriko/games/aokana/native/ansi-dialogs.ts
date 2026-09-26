import type {AokanaBpPointer} from '../bp/memory.js';
import {AokanaAnsiUi} from './ansi-ui.js';
import type {AokanaEngineDialogs} from './engine-dialogs.js';
import type {AokanaNativeLanguage} from './group-81-language.js';
import {isNativeCp932Lead, copyText} from './text.js';
import {readPropertyWord, writePropertyWord} from './property-values.js';

export interface AokanaAnsiDialogField {
  readonly output: AokanaBpPointer | null;
  readonly label: AokanaBpPointer | null;
  readonly initial: AokanaBpPointer | null;
  readonly limit: number;
  readonly numeric: number;
}

/** b00e0/afb70/aebd0 and their concrete native edit/combobox control paths. */
export class AokanaAnsiDialogs {
  constructor(
    readonly document: Document,
    readonly parent: HTMLElement,
    readonly dialogs: AokanaEngineDialogs,
    readonly ansi: AokanaAnsiUi,
    readonly language: AokanaNativeLanguage,
  ) {}

  private frame(title: string): HTMLDialogElement {
    const dialog = this.document.createElement('dialog');
    const heading = this.document.createElement('h2');
    heading.textContent = title;
    dialog.append(heading);
    dialog.setAttribute('aria-label', title);
    dialog.style.cssText = 'max-width:90vw;max-height:90vh;overflow:auto';
    return dialog;
  }
  private input(
    parent: HTMLElement,
    label: string,
    initial: AokanaBpPointer | null,
    limit: number,
    unicode: boolean,
    numeric: boolean,
  ): {input: HTMLInputElement; initialBytes: number} {
    const row = this.document.createElement('label');
    row.textContent = label;
    const input = this.document.createElement('input');
    input.type = 'text';
    row.append(input);
    parent.append(row);
    const initialText = this.ansi.initial(initial, limit);
    input.value = initialText.value;
    this.ansi.bindEdit(input, limit, unicode, numeric);
    return {input, initialBytes: initialText.bytes};
  }

  /** The single-field template is created with DialogBoxParamW, despite its ANSI text calls. */
  single(
    output: AokanaBpPointer | null,
    title: AokanaBpPointer | null,
    initial: AokanaBpPointer | null,
    requestedLimit: number,
  ): Promise<number> {
    return this.dialogs.withNativeModal(
      () =>
        new Promise((resolve, reject) => {
          const limit = Math.abs(requestedLimit | 0) | 0;
          const japanese = (this.language.value & 0x3ff) === 0x11;
          const dialog = this.frame(title === null ? 'コメント入力' : this.ansi.decode(title));
          dialog.lang = japanese ? 'ja' : 'en';
          const {input, initialBytes} = this.input(
            dialog,
            '',
            initial,
            limit,
            true,
            (requestedLimit | 0) < 0,
          );
          const finish = (accept: boolean): void => {
            try {
              if (accept) this.ansi.writeText(output, input.value, 256);
              dialog.close();
              dialog.remove();
              resolve(Number(accept));
            } catch (error) {
              reject(error);
            }
          };
          this.buttons(dialog, finish);
          input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              finish(true);
            }
          });
          dialog.addEventListener('cancel', (event) => {
            event.preventDefault();
            finish(false);
          });
          try {
            this.parent.append(dialog);
            dialog.showModal();
            input.focus();
            // ANSI byte strlen is passed as EM_SETSEL's character index and the Unicode control clamps it.
            const cursor = initialBytes;
            input.setSelectionRange(
              Math.min(cursor, input.value.length),
              Math.min(cursor, input.value.length),
            );
          } catch (error) {
            dialog.remove();
            reject(error);
          }
        }),
    );
  }

  /** DialogBoxParamA 72 is stacked; 7e places both fields beside its two command buttons. */
  pair(
    kind: number,
    title: AokanaBpPointer | null,
    first: AokanaAnsiDialogField,
    second: AokanaAnsiDialogField,
  ): Promise<number> {
    return this.dialogs.withNativeModal(
      () =>
        new Promise((resolve, reject) => {
          const dialog = this.frame(title === null ? 'データ入力' : this.ansi.decode(title));
          const fields = this.document.createElement('div');
          fields.style.cssText =
            (kind | 0) === 0 ? 'display:grid;gap:1rem' : 'display:flex;gap:2rem;align-items:center';
          dialog.append(fields);
          const inputs = [first, second].map(
            (field, index) =>
              this.input(
                fields,
                field.label === null
                  ? index === 0
                    ? '第一文字列'
                    : '第二文字列'
                  : this.ansi.decode(field.label),
                field.initial,
                field.limit | 0,
                false,
                field.numeric !== 0,
              ).input,
          );
          const finish = (accept: boolean): void => {
            try {
              if (accept) {
                this.ansi.writeText(first.output, inputs[0]!.value, 256);
                this.ansi.writeText(second.output, inputs[1]!.value, 256);
              }
              dialog.close();
              dialog.remove();
              resolve(Number(accept));
            } catch (error) {
              reject(error);
            }
          };
          const buttons = this.buttons(dialog, finish);
          for (const input of inputs)
            input.addEventListener('keydown', (event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                finish(true);
              }
            });
          dialog.addEventListener('cancel', (event) => {
            event.preventDefault();
            finish(false);
          });
          try {
            this.parent.append(dialog);
            dialog.showModal();
            // Both nonnull initial values return TRUE from WM_INITDIALOG: the first resource tab-stop is OK.
            if (first.initial === null) inputs[0]!.focus();
            else if (second.initial === null) inputs[1]!.focus();
            else buttons[0]!.focus();
          } catch (error) {
            dialog.remove();
            reject(error);
          }
        }),
    );
  }

  private buttons(
    dialog: HTMLDialogElement,
    finish: (accept: boolean) => void,
  ): HTMLButtonElement[] {
    const buttons: HTMLButtonElement[] = [];
    for (const [label, accept] of [
      ['OK', true],
      ['Cancel', false],
    ] as const) {
      const button = this.document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.addEventListener('click', () => finish(accept));
      dialog.append(button);
      buttons.push(button);
    }
    return buttons;
  }

  /** af2b0 checks only bytes at even offsets, then copies each successful field immediately. */
  private acceptName(output: AokanaBpPointer | null, value: string): boolean {
    const bytes = this.ansi.getText(value, 11);
    for (let index = 0; ; index += 2) {
      if (index >= bytes.length)
        throw new Error(
          'Aokana name validation reads uninitialized bytes beyond its ANSI text terminator',
        );
      const byte = bytes[index]!;
      if (byte === 0) {
        if (output === null) throw new Error('Aokana name validation copies through a null output');
        copyText(output, {bytes, offset: 0});
        return true;
      }
      if (!isNativeCp932Lead(byte)) return false;
    }
  }

  /** Template 77 has no cancel button or system menu; its callback ignores IDCANCEL. */
  nameAndBirthday(
    last: AokanaBpPointer | null,
    first: AokanaBpPointer | null,
    nickname: AokanaBpPointer | null,
    firstPerson: AokanaBpPointer | null,
    monthOutput: AokanaBpPointer | null,
    dayOutput: AokanaBpPointer | null,
  ): Promise<number> {
    return this.dialogs.withNativeModal(
      () =>
        new Promise((resolve, reject) => {
          const dialog = this.frame('名前／誕生日を入力して下さい');
          const outputs = [last, first, nickname, firstPerson];
          const labels = ['姓', '名', 'ニックネーム', '一人称'];
          const inputs = outputs.map((output, index) => {
            if (output === null)
              throw new Error('Aokana name initialization scans a null native string');
            const {input} = this.input(dialog, labels[index]!, output, 10, false, false);
            if (input.value.length !== 0) input.select();
            return input;
          });
          const date = this.document.createElement('label');
          date.textContent = '誕生日';
          const month = this.document.createElement('select'),
            day = this.document.createElement('select');
          month.setAttribute('aria-label', '月');
          day.setAttribute('aria-label', '日');
          date.append(month, day);
          dialog.append(date);
          const populate = (select: HTMLSelectElement, count: number): void => {
            select.replaceChildren();
            for (let index = 1; index <= count; index++) {
              const option = this.document.createElement('option');
              option.textContent = String(index);
              select.append(option);
            }
          };
          populate(month, 12);
          populate(day, 31);
          const selectedMonth = readPropertyWord(monthOutput),
            selectedDay = readPropertyWord(dayOutput);
          month.selectedIndex = selectedMonth >= 0 && selectedMonth < 12 ? selectedMonth : -1;
          day.selectedIndex = selectedDay >= 0 && selectedDay < 31 ? selectedDay : -1;
          month.addEventListener('change', () => {
            try {
              const count = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month.selectedIndex];
              if (count === undefined)
                throw new RangeError(
                  'Aokana birthday callback indexes outside its native month table',
                );
              const selected = day.selectedIndex;
              populate(day, count);
              day.selectedIndex = selected < count ? selected : 0;
            } catch (error) {
              reject(error);
            }
          });
          let accepting = false;
          const finish = async (): Promise<void> => {
            if (accepting) return;
            accepting = true;
            try {
              for (let index = 0; index < inputs.length; index++) {
                if (!this.acceptName(outputs[index]!, inputs[index]!.value)) {
                  await this.dialogs.show(
                    this.ansi.encode(`「${labels[index]}」に半角文字が含まれています`),
                    this.ansi.encode('入力エラー'),
                    0x10,
                  );
                  accepting = false;
                  return;
                }
              }
              writePropertyWord(monthOutput, month.selectedIndex);
              writePropertyWord(dayOutput, day.selectedIndex);
              dialog.close();
              dialog.remove();
              resolve(1);
            } catch (error) {
              reject(error);
            }
          };
          const button = this.document.createElement('button');
          button.type = 'button';
          button.textContent = 'OK';
          button.addEventListener('click', () => {
            void finish();
          });
          dialog.append(button);
          dialog.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void finish();
            }
          });
          dialog.addEventListener('cancel', (event) => event.preventDefault());
          try {
            this.parent.append(dialog);
            dialog.showModal();
            button.focus();
          } catch (error) {
            dialog.remove();
            reject(error);
          }
        }),
    );
  }
}

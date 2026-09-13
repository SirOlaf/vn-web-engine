export type AokanaDiagnosticButtons = 'ok' | 'ok-cancel' | 'yes-no';

export interface AokanaDiagnosticDialog {
  readonly title: string;
  readonly text: string;
  readonly buttons: AokanaDiagnosticButtons;
  readonly defaultSecondButton?: boolean;
}

export interface AokanaFontDialog {
  readonly title: string;
  readonly prompt: string;
  readonly faces: readonly string[];
}

/** Browser presentation of Aokana's diagnostic dialogs; native result IDs remain intact. */
export class AokanaDiagnosticDialogs {
  constructor(
    private readonly document: Document,
    private readonly parent: HTMLElement,
  ) {}

  show(message: AokanaDiagnosticDialog): Promise<1 | 2 | 6 | 7> {
    return new Promise((resolve, reject) => {
      const dialog = this.create(message.title, message.text);
      const choices: readonly (readonly [string, 1 | 2 | 6 | 7])[] =
        message.buttons === 'yes-no'
          ? [
              ['はい', 6],
              ['いいえ', 7],
            ]
          : message.buttons === 'ok-cancel'
            ? [
                ['OK', 1],
                ['キャンセル', 2],
              ]
            : [['OK', 1]];
      const finish = (result: 1 | 2 | 6 | 7): void => {
        dialog.close();
        dialog.remove();
        resolve(result);
      };
      const buttons = choices.map(([label, result]) => {
        const button = this.document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.addEventListener('click', () => finish(result));
        dialog.append(button);
        return button;
      });
      dialog.addEventListener('cancel', (event) => {
        event.preventDefault();
        if (message.buttons !== 'yes-no') finish(message.buttons === 'ok-cancel' ? 2 : 1);
      });
      try {
        this.parent.append(dialog);
        dialog.showModal();
        buttons[message.defaultSecondButton && buttons.length > 1 ? 1 : 0]!.focus();
      } catch (error) {
        dialog.remove();
        reject(error);
      }
    });
  }

  chooseFont(message: AokanaFontDialog): Promise<{accepted: boolean; index: number | null}> {
    return new Promise((resolve, reject) => {
      const dialog = this.create(message.title, message.prompt);
      const select = this.document.createElement('select');
      select.size = 12;
      select.setAttribute('aria-label', message.prompt);
      for (const face of message.faces) {
        const option = this.document.createElement('option');
        option.textContent = face;
        select.append(option);
      }
      select.selectedIndex = message.faces.length === 0 ? -1 : 0;
      const finish = (accepted: boolean): void => {
        const index = select.selectedIndex;
        dialog.close();
        dialog.remove();
        resolve({accepted, index: index < 0 ? null : index});
      };
      select.addEventListener('dblclick', () => finish(true));
      select.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          finish(true);
        }
      });
      dialog.append(select);
      for (const [label, accepted] of [
        ['OK', true],
        ['キャンセル', false],
      ] as const) {
        const button = this.document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.addEventListener('click', () => finish(accepted));
        dialog.append(button);
      }
      dialog.addEventListener('cancel', (event) => {
        event.preventDefault();
        finish(false);
      });
      try {
        this.parent.append(dialog);
        dialog.showModal();
        select.focus();
      } catch (error) {
        dialog.remove();
        reject(error);
      }
    });
  }

  private create(title: string, text: string): HTMLDialogElement {
    const dialog = this.document.createElement('dialog');
    dialog.setAttribute('aria-label', title);
    dialog.style.cssText =
      'max-width: min(80vw, 60rem); max-height: 85vh; overflow: auto; white-space: pre-wrap;';
    const heading = this.document.createElement('h2');
    heading.textContent = title;
    const content = this.document.createElement('p');
    content.textContent = text;
    dialog.append(heading, content);
    return dialog;
  }
}

/** The web platform performs clipboard ownership/permission checks during this blocking call. */
export async function writeAokanaClipboard(navigator: Navigator, text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

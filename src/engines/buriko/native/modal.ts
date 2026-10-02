import {
  BrowserWindowsMessageBoxHost,
  type WindowsMessageBoxHost,
  type WindowsMessageBoxResult,
} from '../../../platform/windows-message-box.js';

export interface BurikoFontDialog {
  readonly title: string;
  readonly prompt: string;
  readonly faces: readonly string[];
}

/** Browser presentation of Buriko's message boxes and list dialogs. */
export class BurikoDiagnosticDialogs implements WindowsMessageBoxHost {
  private readonly messageBoxes: WindowsMessageBoxHost;
  constructor(
    private readonly document: Document,
    private readonly parent: HTMLElement,
  ) {
    this.messageBoxes = new BrowserWindowsMessageBoxHost(parent);
  }

  messageBox(text: string, caption: string, type: number): Promise<WindowsMessageBoxResult> {
    return this.messageBoxes.messageBox(text, caption, type);
  }

  chooseFont(message: BurikoFontDialog): Promise<{accepted: boolean; index: number | null}> {
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
export async function writeBurikoClipboard(navigator: Navigator, text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

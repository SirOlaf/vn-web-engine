/**
 * MessageBox (user32) as engines call it: `type` takes the native MB_* flags and the result
 * is the native ID* value. Hosts decide how the box appears; engines keep the native
 * arguments and results.
 */
export interface WindowsMessageBoxHost {
  messageBox(text: string, caption: string, type: number): Promise<WindowsMessageBoxResult>;
}

export const MB_OK = 0x0;
export const MB_OKCANCEL = 0x1;
export const MB_ABORTRETRYIGNORE = 0x2;
export const MB_YESNOCANCEL = 0x3;
export const MB_YESNO = 0x4;
export const MB_RETRYCANCEL = 0x5;
export const MB_CANCELTRYCONTINUE = 0x6;
export const MB_TYPEMASK = 0xf;
export const MB_ICONHAND = 0x10;
export const MB_ICONQUESTION = 0x20;
export const MB_ICONEXCLAMATION = 0x30;
export const MB_ICONASTERISK = 0x40;
export const MB_ICONMASK = 0xf0;
export const MB_DEFBUTTON2 = 0x100;
export const MB_DEFBUTTON3 = 0x200;
export const MB_DEFBUTTON4 = 0x300;
export const MB_DEFMASK = 0xf00;

export const IDOK = 1;
export const IDCANCEL = 2;
export const IDABORT = 3;
export const IDRETRY = 4;
export const IDIGNORE = 5;
export const IDYES = 6;
export const IDNO = 7;
export const IDTRYAGAIN = 10;
export const IDCONTINUE = 11;
export type WindowsMessageBoxResult = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 10 | 11;

/** The buttons of each MB_* button set, in their native order. */
const BUTTON_SETS: readonly (readonly WindowsMessageBoxResult[])[] = [
  [IDOK],
  [IDOK, IDCANCEL],
  [IDABORT, IDRETRY, IDIGNORE],
  [IDYES, IDNO, IDCANCEL],
  [IDYES, IDNO],
  [IDRETRY, IDCANCEL],
  [IDCANCEL, IDTRYAGAIN, IDCONTINUE],
];

/** The buttons a MessageBox of `type` shows. Unknown button sets are rejected, as natively. */
export function messageBoxButtons(type: number): readonly WindowsMessageBoxResult[] {
  const buttons = BUTTON_SETS[type & MB_TYPEMASK];
  if (!buttons) throw new RangeError(`Unsupported MessageBox button set ${type & MB_TYPEMASK}`);
  return buttons;
}

/** The result of closing the box (Escape or the close button), or null when it cannot close. */
export function messageBoxCloseResult(type: number): WindowsMessageBoxResult | null {
  const buttons = messageBoxButtons(type);
  if (buttons.includes(IDCANCEL)) return IDCANCEL;
  return buttons.length === 1 ? buttons[0]! : null;
}

/** The button focused first: MB_DEFBUTTONn, or the first when the set has fewer buttons. */
export function messageBoxDefaultButton(type: number): number {
  const index = (type & MB_DEFMASK) >>> 8;
  return index < messageBoxButtons(type).length ? index : 0;
}

/** Button captions of Japanese Windows, the system the supported titles target. */
const LABELS: Readonly<Record<WindowsMessageBoxResult, string>> = {
  [IDOK]: 'OK',
  [IDCANCEL]: 'キャンセル',
  [IDABORT]: '中止(A)',
  [IDRETRY]: '再試行(R)',
  [IDIGNORE]: '無視(I)',
  [IDYES]: 'はい(Y)',
  [IDNO]: 'いいえ(N)',
  [IDTRYAGAIN]: '再実行(T)',
  [IDCONTINUE]: '続行(C)',
};

/**
 * A modal dialog appended to `owner`, so it stays visible while the owner is fullscreen.
 * Line breaks in the text are kept.
 */
export class BrowserWindowsMessageBoxHost implements WindowsMessageBoxHost {
  constructor(
    private readonly owner: HTMLElement,
    /** Called after the dialog closes, to give focus back to the game. */
    private readonly closed: () => void = () => {},
  ) {}

  messageBox(text: string, caption: string, type: number): Promise<WindowsMessageBoxResult> {
    const results = messageBoxButtons(type),
      closeResult = messageBoxCloseResult(type);
    const document = this.owner.ownerDocument;
    const dialog = document.createElement('dialog');
    dialog.setAttribute('aria-label', caption);
    dialog.style.cssText =
      'max-width:min(90%,40rem);max-height:85vh;overflow:auto;padding:1.25rem 1.5rem;border:1px solid #39414c;border-radius:8px;background:#171c24;color:#e8ecf2';
    const heading = document.createElement('h2');
    heading.textContent = caption;
    heading.style.cssText = 'margin:0 0 .75rem;font-size:1rem';
    const message = document.createElement('p');
    message.textContent = text;
    message.style.cssText = 'margin:0 0 1rem;white-space:pre-wrap';
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:.5rem;justify-content:flex-end';
    dialog.append(heading, message, actions);
    return new Promise((resolve, reject) => {
      const finish = (result: WindowsMessageBoxResult): void => {
        dialog.close();
        dialog.remove();
        this.closed();
        resolve(result);
      };
      const buttons = results.map((result) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = LABELS[result];
        button.addEventListener('click', () => finish(result), {once: true});
        actions.append(button);
        return button;
      });
      dialog.addEventListener('cancel', (event) => {
        event.preventDefault();
        if (closeResult !== null) finish(closeResult);
      });
      try {
        this.owner.append(dialog);
        dialog.showModal();
        buttons[messageBoxDefaultButton(type)]!.focus();
      } catch (error) {
        dialog.remove();
        reject(error);
      }
    });
  }
}

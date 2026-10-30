export interface TextDialogRequest {
  readonly title: string;
  /** The message, or the initial text of the field when `textField` is set. */
  readonly message: string;
  /** Adds a Cancel button next to OK. */
  readonly canCancel: boolean;
  readonly fontSize: number;
  readonly minimumWidth: number;
  readonly applyDesktopScale: boolean;
  /** Shows a single-line text field instead of the message. */
  readonly textField: boolean;
  /** Milliseconds after opening during which accepting or cancelling is ignored. */
  readonly inputDelay: number;
}
export interface TextDialogResult {
  /** 1 when accepted (OK or Enter), 0 when cancelled (Cancel or Escape). */
  readonly result: number;
  /** The field text when accepted or cancelled; the message without a field. */
  readonly text: string;
}

/** Host-owned asynchronous dialog presentation. Completion may also be synchronous. */
export interface TextDialogHost {
  present(request: TextDialogRequest, complete: (result: TextDialogResult) => void): void;
}

/** Modal `<dialog>` text dialogs following the native window: the title, the message or a
 * focused text field, OK and an optional Cancel. Enter accepts and Escape cancels from any
 * control, also without a Cancel button; Tab moves forward through field, OK and Cancel. An
 * Enter that confirms an IME composition stays with the composition. Closing requests from
 * the browser are ignored. Sizes are CSS pixels, which already follow the desktop scale. */
export class BrowserTextDialogHost implements TextDialogHost {
  constructor(
    private readonly owner: HTMLElement,
    /** Called after the dialog closes, to give focus back to the game. */
    private readonly closed: () => void = () => {},
    private readonly now: () => number = () => performance.now(),
  ) {}

  present(request: TextDialogRequest, complete: (result: TextDialogResult) => void): void {
    const document = this.owner.ownerDocument;
    const opened = this.now();
    const dialog = document.createElement('dialog');
    dialog.setAttribute('aria-label', request.title);
    dialog.style.cssText = `box-sizing:border-box;width:max-content;min-width:min(90vw,${request.minimumWidth}px);max-width:90vw;max-height:85vh;overflow:auto;padding:1rem 1.25rem;border:1px solid #39414c;border-radius:8px;background:#171c24;color:#e8ecf2;font:${request.fontSize}px Tahoma,sans-serif`;
    const heading = document.createElement('h2');
    heading.textContent = request.title;
    heading.style.cssText = 'margin:0 0 .75rem;font-size:1em';
    let body: HTMLElement,
      field: HTMLInputElement | null = null;
    if (request.textField) {
      field = document.createElement('input');
      field.type = 'text';
      field.value = request.message;
      field.setAttribute('aria-label', request.title);
      field.style.cssText =
        'box-sizing:border-box;width:100%;margin:0 0 1rem;font:inherit;padding:.25em .4em';
      body = field;
    } else {
      body = document.createElement('p');
      body.textContent = request.message;
      body.tabIndex = 0;
      body.style.cssText = 'margin:0 0 1rem;white-space:pre-wrap';
    }
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:.5rem;justify-content:center';
    const button = (label: string, result: number): HTMLButtonElement => {
      const element = document.createElement('button');
      element.type = 'button';
      element.textContent = label;
      element.style.font = 'inherit';
      element.addEventListener('click', () => finish(result));
      actions.append(element);
      return element;
    };
    let done = false;
    const finish = (result: number): void => {
      if (done || this.now() - opened < request.inputDelay) return;
      done = true;
      const text = field ? field.value : request.message;
      dialog.close();
      dialog.remove();
      this.closed();
      complete({result, text});
    };
    const ok = button('OK', 1);
    const cancel = request.canCancel ? button('Cancel', 0) : null;
    const order = [body, ok, ...(cancel ? [cancel] : [])];
    dialog.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') {
        if (event.isComposing || event.keyCode === 229) return;
        event.preventDefault();
        finish(1);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        finish(0);
      } else if (event.key === 'Tab') {
        event.preventDefault();
        const index = order.indexOf(document.activeElement as HTMLElement);
        order[(index + 1) % order.length]!.focus();
      }
    });
    dialog.addEventListener('keyup', (event) => event.stopPropagation());
    dialog.addEventListener('cancel', (event) => event.preventDefault());
    dialog.append(heading, body, actions);
    try {
      this.owner.append(dialog);
      dialog.showModal();
      if (field) {
        field.focus();
        // SetFocus on the edit control leaves the caret before the text, nothing selected.
        field.setSelectionRange(0, 0);
      } else ok.focus();
    } catch (error) {
      dialog.remove();
      throw error;
    }
  }
}

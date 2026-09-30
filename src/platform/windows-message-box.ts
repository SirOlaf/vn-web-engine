/** MessageBox with OK and Cancel (MB_OKCANCEL); resolves true for IDOK. */
export interface WindowsMessageBoxHost {
  confirm(caption: string, text: string): Promise<boolean>;
}

/**
 * A modal dialog inside `owner`, so it stays visible while the owner is fullscreen. Escape
 * cancels, like closing the native message box. Native CR LF line breaks are kept.
 */
export class BrowserWindowsMessageBoxHost implements WindowsMessageBoxHost {
  constructor(
    private readonly owner: HTMLElement,
    /** Called after the dialog closes, to give focus back to the game. */
    private readonly closed: () => void = () => {},
  ) {}

  confirm(caption: string, text: string): Promise<boolean> {
    const document = this.owner.ownerDocument;
    const dialog = document.createElement('dialog');
    dialog.setAttribute('aria-label', caption);
    dialog.style.cssText =
      'max-width:min(90%,28rem);padding:1.25rem 1.5rem;border:1px solid #39414c;border-radius:8px;background:#171c24;color:#e8ecf2';
    const heading = document.createElement('h2');
    heading.textContent = caption;
    heading.style.cssText = 'margin:0 0 .75rem;font-size:1rem';
    const message = document.createElement('p');
    message.textContent = text;
    message.style.cssText = 'margin:0 0 1rem;white-space:pre-line';
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:.5rem;justify-content:flex-end';
    const button = (label: string): HTMLButtonElement => {
      const element = document.createElement('button');
      element.type = 'button';
      element.textContent = label;
      return element;
    };
    const ok = button('OK'),
      cancel = button('Cancel');
    actions.append(ok, cancel);
    dialog.append(heading, message, actions);
    this.owner.append(dialog);
    return new Promise((resolve) => {
      const finish = (confirmed: boolean): void => {
        dialog.close();
        dialog.remove();
        this.closed();
        resolve(confirmed);
      };
      ok.addEventListener('click', () => finish(true), {once: true});
      cancel.addEventListener('click', () => finish(false), {once: true});
      dialog.addEventListener(
        'cancel',
        (event) => {
          event.preventDefault();
          finish(false);
        },
        {once: true},
      );
      dialog.showModal();
      ok.focus();
    });
  }
}

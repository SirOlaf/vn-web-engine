/** MessageBoxW-style information dialog selected by the application process. */
export interface WindowsPostTeardownDialogHost {
  showInformation(title: string, text: string): Promise<void> | void;
}

/** Browser owner is attached to the document, so engine surface teardown cannot remove it. */
export class BrowserWindowsPostTeardownDialogHost implements WindowsPostTeardownDialogHost {
  constructor(private readonly document: Document) {}

  showInformation(title: string, text: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const dialog = this.document.createElement('dialog');
      dialog.setAttribute('aria-label', title);
      dialog.style.cssText =
        'max-width: min(80vw, 60rem); max-height: 85vh; overflow: auto; white-space: pre-wrap;';
      const heading = this.document.createElement('h2'),
        content = this.document.createElement('p'),
        button = this.document.createElement('button');
      heading.textContent = title;
      content.textContent = text;
      button.type = 'button';
      button.textContent = 'OK';
      dialog.append(heading, content, button);
      const finish = (): void => {
        dialog.close();
        dialog.remove();
        resolve();
      };
      button.addEventListener('click', finish, {once: true});
      dialog.addEventListener('cancel', (event) => {
        event.preventDefault();
        finish();
      }, {once: true});
      try {
        this.document.body.append(dialog);
        dialog.showModal();
        button.focus();
      } catch (error) {
        dialog.remove();
        reject(error);
      }
    });
  }
}

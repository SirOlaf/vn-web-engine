/** Structured modal forms used by Windows installers on browser and desktop hosts. */
export interface WindowsDestinationDialogRequest {
  readonly template: number;
  readonly path: string;
  readonly pathEditable: boolean;
  readonly optionA: number;
  readonly optionB: number;
  readonly optionALabel: string;
  readonly optionBLabel: string;
  readonly description: string | null;
  readonly browseFolder: () => Promise<string | null>;
}

export interface WindowsDestinationDialogResult {
  readonly result: number;
  readonly path: string;
  readonly optionA: number;
  readonly optionB: number;
}

export interface WindowsComponentDialogRequest {
  readonly template: number;
  readonly description: string;
  readonly choices: readonly [string | null, string, string];
  readonly disabledChoice: number;
  readonly defaultChoice: number;
  readonly showSpecialButton: boolean;
}

/** Returns native dialog result: -1 cancel, 3 special, or selected choice index. */
export interface WindowsInstallerDialogHost {
  chooseDestination(request: WindowsDestinationDialogRequest): Promise<WindowsDestinationDialogResult>;
  chooseComponent(request: WindowsComponentDialogRequest): Promise<number>;
  runProgress(request: WindowsInstallerProgressRequest): Promise<number>;
}

export interface WindowsInstallerProgressReport {
  readonly completedFiles: number;
  readonly totalFiles: number;
  readonly completedBlocks: number;
  readonly totalBlocks: number;
  readonly fileName: string | null;
}

export interface WindowsInstallerProgressRequest {
  readonly template: number;
  readonly cancellable: boolean;
  readonly totalFiles: number;
  /** The caller reveals the dialog after native directory and taskbar preparation. */
  readonly run: (
    report: (progress: WindowsInstallerProgressReport) => void,
    showModal: () => void,
  ) => Promise<boolean>;
  readonly requestCancel: () => Promise<boolean>;
}

/** Minimal asset-free browser form host. The installer owner handles native validation. */
export class BrowserWindowsInstallerDialogHost implements WindowsInstallerDialogHost {
  constructor(readonly document: Document, readonly parent: HTMLElement) {}

  private addTitle(dialog: HTMLDialogElement): void {
    const title = this.document.createElement('h2');
    title.textContent = 'BURIKO General Interpreter Integrated Installer';
    dialog.append(title);
  }

  async chooseDestination(request: WindowsDestinationDialogRequest): Promise<WindowsDestinationDialogResult> {
    const dialog = this.document.createElement('dialog');
    this.addTitle(dialog);
    const path = this.document.createElement('input');
    path.value = request.path;
    path.disabled = !request.pathEditable;
    path.setAttribute('aria-label', request.template === 0x6c ? 'インストールフォルダ' : 'Installation Folder');
    dialog.append(path);
    const browse = this.document.createElement('button');
    browse.textContent = request.template === 0x6c ? '参照' : 'Browse...';
    browse.disabled = !request.pathEditable;
    dialog.append(browse);
    if (request.description !== null) {
      const detail = this.document.createElement('p');
      detail.textContent = request.description;
      dialog.append(detail);
    }
    const first = this.document.createElement('input');
    first.type = 'checkbox';
    first.checked = request.optionA !== 0;
    first.setAttribute('aria-label', request.optionALabel);
    const firstLabel = this.document.createElement('label');
    firstLabel.append(first, this.document.createTextNode(request.optionALabel));
    dialog.append(firstLabel);
    const second = this.document.createElement('input');
    second.type = 'checkbox';
    second.checked = request.optionB !== 0;
    second.setAttribute('aria-label', request.optionBLabel);
    const secondLabel = this.document.createElement('label');
    secondLabel.append(second, this.document.createTextNode(request.optionBLabel));
    dialog.append(secondLabel);
    const accept = this.document.createElement('button');
    accept.textContent = request.template === 0x6c ? '次へ' : 'Next';
    dialog.append(accept);
    const cancel = this.document.createElement('button');
    cancel.textContent = request.template === 0x6c ? '中止' : 'Cancel';
    dialog.append(cancel);
    this.parent.append(dialog);
    return new Promise((resolve) => {
      const finish = (result: number) => {
        dialog.close();
        dialog.remove();
        resolve({result, path: path.value, optionA: Number(first.checked), optionB: Number(second.checked)});
      };
      browse.addEventListener('click', async () => {
        const selected = await request.browseFolder();
        if (selected !== null) path.value = selected;
      });
      accept.addEventListener('click', () => finish(1));
      cancel.addEventListener('click', () => finish(0));
      dialog.addEventListener('cancel', (event) => { event.preventDefault(); finish(0); });
      dialog.showModal();
    });
  }

  async chooseComponent(request: WindowsComponentDialogRequest): Promise<number> {
    const dialog = this.document.createElement('dialog');
    this.addTitle(dialog);
    const description = this.document.createElement('p');
    description.textContent = request.description;
    dialog.append(description);
    const choices: HTMLInputElement[] = [];
    request.choices.forEach((name, index) => {
      if (name === null) return;
      const label = this.document.createElement('label');
      const input = this.document.createElement('input');
      input.type = 'radio';
      input.name = 'installer-component';
      input.disabled = index === request.disabledChoice;
      input.checked = index === request.defaultChoice && !input.disabled;
      label.append(input, this.document.createTextNode(name));
      dialog.append(label);
      choices[index] = input;
    });
    const accept = this.document.createElement('button');
    accept.textContent = 'インストール';
    dialog.append(accept);
    const special = this.document.createElement('button');
    special.textContent = '戻る';
    special.hidden = !request.showSpecialButton;
    dialog.append(special);
    const cancel = this.document.createElement('button');
    cancel.textContent = '中止';
    dialog.append(cancel);
    this.parent.append(dialog);
    return new Promise((resolve) => {
      const finish = (result: number) => { dialog.close(); dialog.remove(); resolve(result); };
      accept.addEventListener('click', () => {
        const chosen = choices.findIndex((choice) => choice?.checked);
        finish(chosen < 0 ? Math.max(0, request.defaultChoice) : chosen);
      });
      special.addEventListener('click', () => finish(3));
      cancel.addEventListener('click', () => finish(-1));
      dialog.addEventListener('cancel', (event) => { event.preventDefault(); finish(-1); });
      dialog.showModal();
    });
  }

  async runProgress(request: WindowsInstallerProgressRequest): Promise<number> {
    const dialog = this.document.createElement('dialog');
    this.addTitle(dialog);
    let askingToCancel = false;
    const requestCancellation = async () => {
      if (askingToCancel) return;
      askingToCancel = true;
      try { await request.requestCancel(); }
      finally { askingToCancel = false; }
    };
    const label = this.document.createElement('p');
    label.textContent = request.template === 0x6f ? 'インストール中…' : 'Installing...';
    dialog.append(label);
    const overall = this.document.createElement('progress');
    overall.max = Math.max(1, request.totalFiles);
    overall.value = 0;
    dialog.append(overall);
    const detail = this.document.createElement('progress');
    detail.max = 1;
    detail.value = 0;
    dialog.append(detail);
    if (request.cancellable) {
      const cancel = this.document.createElement('button');
      cancel.textContent = request.template === 0x6f ? '中止' : 'Cancel';
      cancel.addEventListener('click', () => { void requestCancellation(); });
      dialog.append(cancel);
    }
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      if (request.cancellable) void requestCancellation();
    });
    this.parent.append(dialog);
    try {
      const completed = await request.run((progress) => {
        overall.max = Math.max(1, progress.totalFiles);
        overall.value = progress.completedFiles;
        detail.max = Math.max(1, progress.totalBlocks);
        detail.value = progress.completedBlocks;
        if (progress.fileName !== null)
          label.textContent = request.template === 0x6f
            ? `『${progress.fileName}』をインストール中…`
            : `Installing "${progress.fileName}"...`;
      }, () => dialog.showModal());
      return Number(completed);
    } finally {
      if (dialog.open) dialog.close();
      dialog.remove();
    }
  }
}

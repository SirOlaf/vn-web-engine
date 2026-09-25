import {FileError, filePath, type FileSystem} from './filesystem.js';

export interface WindowsFileDialogRequest {
  readonly structureSize: 0x98;
  readonly owner: object;
  /** ANSI description/pattern pairs ending in a second NUL. */
  readonly filter: Uint8Array;
  readonly filterIndex: 1;
  readonly fileCapacity: 0x30c;
  readonly initialDirectory: Uint8Array | null;
  readonly title: Uint8Array | null;
  readonly defaultExtension: Uint8Array;
  readonly flags: number;
}

export interface WindowsFileDialogHost {
  selectOpenFile(request: WindowsFileDialogRequest): Promise<Uint8Array | null>;
  selectSaveFile(request: WindowsFileDialogRequest): Promise<Uint8Array | null>;
}

export interface WindowsFolderDialogRequest {
  readonly owner: object;
  readonly rootItemIdentifier: 0x11;
  readonly displayNameCapacity: 784;
  readonly title: string;
  readonly flags: 3;
  readonly initialFolder: string | null;
  readonly centerOnInitialize: true;
  readonly image: 0;
}

export interface WindowsFolderDialogHost {
  selectFolder(request: WindowsFolderDialogRequest): Promise<string | null>;
}

/** One declared native directory and the actual mounted byte namespace it exposes. */
export interface WindowsPickerMount {
  readonly native: string;
  readonly mounted: string;
}

export interface BrowserWindowsPickerOptions {
  readonly document: Document;
  readonly parent: HTMLElement;
  readonly files: FileSystem;
  readonly mounts: readonly WindowsPickerMount[];
  /** GetOpenFileNameA paths and filters use the selected ANSI code page. */
  readonly decodeAnsi: (bytes: Uint8Array) => string;
  readonly encodeAnsi: (wide: string) => Uint8Array;
  /** Save results are admitted only on a selected writable mounted volume. */
  readonly isWritable: (mountedPath: string) => boolean;
}

interface PickerEntry {
  readonly native: string;
  readonly mounted: string;
  readonly kind: 'file' | 'directory';
}

interface PickerFilter {
  readonly label: string;
  readonly patterns: readonly RegExp[];
}

function parentPath(path: string): string | null {
  const slash = path.lastIndexOf('/');
  return slash <= 0 ? null : path.slice(0, slash);
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function stripNul(bytes: Uint8Array): Uint8Array {
  const end = bytes.indexOf(0);
  return end < 0 ? bytes : bytes.subarray(0, end);
}

function glob(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp('^' + escaped + '$', 'i');
}

/** Project-level picker over files already present in the browser's mounted namespace.
 * It never reports an arbitrary host path returned by `<input type=file>` as a Win32 path. */
export class BrowserWindowsDialogPicker implements WindowsFileDialogHost, WindowsFolderDialogHost {
  private closed = false;
  private pendingCancel: (() => void) | null = null;
  private tail: Promise<void> = Promise.resolve();
  private readonly mounts: readonly WindowsPickerMount[];

  constructor(readonly options: BrowserWindowsPickerOptions) {
    this.mounts = options.mounts.map(({native, mounted}) => {
      if (
        !/^(?:[a-z]:(?:\\(?:[^\\]+(?:\\[^\\]+)*)?)?|\\\\[^\\]+\\[^\\]+(?:\\[^\\]+)*)$/i.test(native)
      )
        throw new RangeError('Browser picker requires declared native and mounted roots');
      return {
        native: /^[a-z]:\\?$/i.test(native)
          ? native.slice(0, 2).toUpperCase() + '\\'
          : native.replace(/\\$/, ''),
        mounted: filePath(mounted),
      };
    });
  }

  selectOpenFile(request: WindowsFileDialogRequest): Promise<Uint8Array | null> {
    return this.enqueue(() => this.pickFile(request, false));
  }

  selectSaveFile(request: WindowsFileDialogRequest): Promise<Uint8Array | null> {
    return this.enqueue(() => this.pickFile(request, true));
  }

  selectFolder(request: WindowsFolderDialogRequest): Promise<string | null> {
    return this.enqueue(() => this.pickFolder(request));
  }

  private enqueue<T>(work: () => Promise<T | null>): Promise<T | null> {
    if (this.closed) return Promise.resolve(null);
    const result = this.tail.then(() => (this.closed ? null : work()));
    this.tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  private filters(bytes: Uint8Array): PickerFilter[] {
    const fields: string[] = [];
    for (let at = 0; at < bytes.length;) {
      const end = bytes.indexOf(0, at);
      if (end < 0 || end === at) break;
      fields.push(this.options.decodeAnsi(bytes.subarray(at, end)));
      at = end + 1;
    }
    const result: PickerFilter[] = [];
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const pattern = fields[i + 1]!;
      result.push({
        label: fields[i]!,
        patterns: pattern
          .split(';')
          .map((part) => part.trim())
          .filter(Boolean)
          .map((part) => glob(part === '*.*' ? '*' : part)),
      });
    }
    return result;
  }

  private nativePath(mount: WindowsPickerMount, mounted: string): string {
    const tail = mounted.slice(mount.mounted.length).replace(/^\//, '').replaceAll('/', '\\');
    return tail ? mount.native.replace(/\\$/, '') + '\\' + tail : mount.native;
  }

  private start(initial: string | null): {mount: WindowsPickerMount; mounted: string} | null {
    if (initial !== null) {
      const folded = initial.replaceAll('/', '\\').replace(/[\\]$/, '').toUpperCase();
      const mount = this.mounts
        .filter(({native}) => {
          const root = native.replace(/\\$/, '').toUpperCase();
          return folded === root || folded.startsWith(root + '\\');
        })
        .sort((a, b) => b.native.length - a.native.length)[0];
      if (mount !== undefined) {
        const tail = initial
          .replaceAll('/', '\\')
          .slice(mount.native.replace(/\\$/, '').length)
          .replace(/^\\/, '');
        return {
          mount,
          mounted:
            mount.mounted +
            (tail ? (mount.mounted === '/' ? '' : '/') + tail.replaceAll('\\', '/') : ''),
        };
      }
    }
    const mount = this.mounts[0];
    return mount === undefined ? null : {mount, mounted: mount.mounted};
  }

  private async pickFile(
    request: WindowsFileDialogRequest,
    save: boolean,
  ): Promise<Uint8Array | null> {
    const initial =
      request.initialDirectory === null
        ? null
        : this.options.decodeAnsi(stripNul(request.initialDirectory));
    const filters = this.filters(request.filter);
    const selected = await this.show({
      title:
        request.title === null
          ? save
            ? 'Save file'
            : 'Open file'
          : this.options.decodeAnsi(stripNul(request.title)),
      initial,
      filters,
      mode: save ? 'save' : 'open',
      fileCapacity: request.fileCapacity,
    });
    if (selected === null) return null;
    const encoded = this.options.encodeAnsi(selected);
    return encoded;
  }

  private pickFolder(request: WindowsFolderDialogRequest): Promise<string | null> {
    return this.show({
      title: request.title,
      initial: request.initialFolder,
      filters: [],
      mode: 'folder',
      fileCapacity: request.displayNameCapacity,
    });
  }

  private show(config: {
    title: string;
    initial: string | null;
    filters: readonly PickerFilter[];
    mode: 'open' | 'save' | 'folder';
    fileCapacity: number;
  }): Promise<string | null> {
    const {document, parent, files} = this.options;
    const previousFocus = document.activeElement as HTMLElement | null;
    const shell = document.createElement('div');
    shell.setAttribute('role', 'dialog');
    shell.setAttribute('aria-modal', 'true');
    shell.tabIndex = -1;
    shell.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;background:#0009;display:flex;align-items:center;justify-content:center;font:14px sans-serif';
    const panel = document.createElement('div');
    panel.style.cssText =
      'width:min(42rem,95vw);max-height:90vh;overflow:auto;background:#fff;color:#111;padding:1rem;border:1px solid #555;box-shadow:0 1rem 3rem #0008';
    const heading = document.createElement('h2');
    heading.textContent = config.title;
    const notice = document.createElement('p');
    notice.textContent = 'Choose from files and folders mounted in this browser session.';
    const roots = document.createElement('select');
    roots.setAttribute('aria-label', 'Mounted location');
    for (const [index, mount] of this.mounts.entries()) {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = mount.native;
      roots.append(option);
    }
    const location = document.createElement('p');
    const back = document.createElement('button');
    back.type = 'button';
    back.textContent = 'Up';
    const list = document.createElement('div');
    list.style.cssText = 'min-height:8rem;max-height:45vh;overflow:auto;border:1px solid #999';
    const filter = document.createElement('select');
    filter.setAttribute('aria-label', 'File type');
    for (const [index, item] of config.filters.entries()) {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = item.label;
      filter.append(option);
    }
    const filename = document.createElement('input');
    filename.type = 'text';
    filename.setAttribute('aria-label', 'File name');
    const feedback = document.createElement('p');
    feedback.setAttribute('role', 'status');
    const accept = document.createElement('button');
    accept.type = 'button';
    accept.textContent =
      config.mode === 'open' ? 'Open' : config.mode === 'save' ? 'Save' : 'Choose folder';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    panel.append(heading, notice, roots, location, back, list);
    if (config.mode !== 'folder' && config.filters.length > 1) panel.append(filter);
    if (config.mode === 'save') panel.append(filename);
    panel.append(feedback, accept, cancel);
    shell.append(panel);
    parent.append(shell);

    const first = this.start(config.initial);
    if (config.initial !== null && first !== null && first.mounted === first.mount.mounted) {
      const requested = config.initial.replaceAll('/', '\\').replace(/\\$/, '').toUpperCase();
      const root = first.mount.native.replace(/\\$/, '').toUpperCase();
      if (requested !== root)
        notice.textContent =
          'The requested Windows location is unavailable here. Choose from mounted files and folders.';
    }
    let current = first;
    let selected: PickerEntry | null = null;
    let generation = 0;
    let overwrite: string | null = null;
    if (first !== null) roots.value = String(this.mounts.indexOf(first.mount));

    return new Promise<string | null>((resolve) => {
      let done = false;
      const finish = (value: string | null): void => {
        if (done) return;
        done = true;
        generation++;
        this.pendingCancel = null;
        shell.removeEventListener('keydown', onKeydown);
        shell.remove();
        if (previousFocus?.isConnected) previousFocus.focus();
        resolve(value);
      };
      const onKeydown = (event: KeyboardEvent): void => {
        if (event.key === 'Escape') {
          event.preventDefault();
          finish(null);
        }
      };
      this.pendingCancel = () => finish(null);
      shell.addEventListener('keydown', onKeydown);
      shell.focus();
      cancel.addEventListener('click', () => finish(null));
      roots.addEventListener('change', () => {
        const mount = this.mounts[Number(roots.value)];
        if (mount === undefined) return;
        current = {mount, mounted: mount.mounted};
        selected = null;
        overwrite = null;
        void refresh();
      });
      back.addEventListener('click', () => {
        if (current === null) return;
        const parentPathValue = parentPath(current.mounted);
        if (parentPathValue === null || parentPathValue.length < current.mount.mounted.length)
          return;
        current = {...current, mounted: parentPathValue};
        selected = null;
        overwrite = null;
        void refresh();
      });
      filter.addEventListener('change', () => {
        selected = null;
        void refresh();
      });
      const validName = (value: string): boolean =>
        value.length > 0 &&
        value !== '.' &&
        value !== '..' &&
        !/[\\/:*?"<>|\x00-\x1f]/.test(value) &&
        !/[ .]$/.test(value);
      accept.addEventListener('click', () => {
        void (async () => {
          if (current === null) return;
          let candidate: PickerEntry | null;
          if (config.mode === 'folder')
            candidate = {
              native: this.nativePath(current.mount, current.mounted),
              mounted: current.mounted,
              kind: 'directory',
            };
          else if (config.mode === 'open') candidate = selected;
          else {
            const name = filename.value;
            if (!validName(name)) {
              feedback.textContent = 'Enter a valid file name.';
              return;
            }
            const mounted = current.mounted + (current.mounted === '/' ? '' : '/') + name;
            candidate = {native: this.nativePath(current.mount, mounted), mounted, kind: 'file'};
          }
          if (candidate === null) {
            feedback.textContent = 'Select a file.';
            return;
          }
          const turn = generation;
          try {
            if (config.mode === 'save') {
              if ((await files.stat(current.mounted)).kind !== 'directory')
                throw new FileError('NOT_DIRECTORY', current.mounted);
              if (done || turn !== generation) return;
              if (!this.options.isWritable(candidate.mounted)) {
                feedback.textContent = 'This mounted location is read only.';
                return;
              }
              const exists = await files.stat(candidate.mounted).then(
                (info) => {
                  if (info.kind !== 'file') throw new FileError('IS_DIRECTORY', candidate.mounted);
                  return true;
                },
                (error: unknown) => {
                  if (error instanceof FileError && error.code === 'NOT_FOUND') return false;
                  throw error;
                },
              );
              if (done || turn !== generation) return;
              if (exists && overwrite !== candidate.mounted) {
                overwrite = candidate.mounted;
                feedback.textContent = 'This file exists. Select Save again to replace it.';
                return;
              }
            } else if ((await files.stat(candidate.mounted)).kind !== candidate.kind) {
              feedback.textContent = 'That item is unavailable.';
              return;
            }
            if (done || turn !== generation) return;
            if (config.mode === 'folder') {
              if (candidate.native.length >= config.fileCapacity) {
                feedback.textContent = 'The folder path is too long.';
                return;
              }
            } else {
              const encoded = this.options.encodeAnsi(candidate.native);
              const decoded = this.options.decodeAnsi(stripNul(encoded));
              if (decoded !== candidate.native || encoded.length > config.fileCapacity) {
                feedback.textContent =
                  'This path cannot be represented by the selected Windows code page.';
                return;
              }
            }
            finish(candidate.native);
          } catch {
            if (!done && turn === generation)
              feedback.textContent = 'That mounted item is unavailable.';
          }
        })();
      });
      const refresh = async (): Promise<void> => {
        const turn = ++generation;
        list.replaceChildren();
        if (current === null) {
          roots.disabled = true;
          back.disabled = true;
          accept.disabled = true;
          feedback.textContent =
            'No mounted Windows location is available in this browser session.';
          return;
        }
        const place = current;
        location.textContent = this.nativePath(place.mount, place.mounted);
        back.disabled = place.mounted === place.mount.mounted;
        try {
          const info = await files.stat(place.mounted);
          if (info.kind !== 'directory') throw new Error('Not a folder');
          const entries = await files.list(place.mounted);
          if (turn !== generation || done) return;
          feedback.textContent = '';
          const activeFilter = config.filters[Number(filter.value) || 0];
          for (const entry of entries) {
            const name = basename(entry.path);
            if (
              entry.kind === 'file' &&
              config.mode !== 'save' &&
              activeFilter !== undefined &&
              activeFilter.patterns.length !== 0 &&
              !activeFilter.patterns.some((pattern) => pattern.test(name))
            )
              continue;
            const button = document.createElement('button');
            button.type = 'button';
            button.style.cssText = 'display:block;width:100%;text-align:left';
            button.textContent = (entry.kind === 'directory' ? '📁 ' : '') + name;
            button.addEventListener('click', () => {
              if (entry.kind === 'directory') {
                current = {...place, mounted: entry.path};
                selected = null;
                overwrite = null;
                void refresh();
              } else if (config.mode === 'open') {
                generation++;
                selected = {
                  native: this.nativePath(place.mount, entry.path),
                  mounted: entry.path,
                  kind: 'file',
                };
                feedback.textContent = `Selected ${name}`;
              } else if (config.mode === 'save') {
                generation++;
                filename.value = name;
                overwrite = null;
              }
            });
            list.append(button);
          }
        } catch {
          if (turn === generation && !done)
            feedback.textContent = 'This mounted location is unavailable.';
        }
      };
      filename.addEventListener('input', () => {
        generation++;
        overwrite = null;
      });
      void refresh();
    });
  }

  async closeAndJoin(): Promise<void> {
    this.closed = true;
    this.pendingCancel?.();
    await this.tail;
  }
}

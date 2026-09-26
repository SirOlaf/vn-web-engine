import {filePath} from './filesystem.js';
import {isInstallationMetadata} from './installation-path.js';

export interface SelectedInstallationFile {
  readonly path: string;
  readonly file: File;
}
export interface InstallationSelection {
  readonly files: readonly SelectedInstallationFile[];
  readonly directory: boolean;
  /** A reusable reference to device files, when the browser provides one. */
  readonly directoryHandle?: FileSystemDirectoryHandle;
}

/** Folder selection replaces the tree; individual picks fill in or replace its entries. */
export class InstallationSelectionFiles {
  private readonly files = new Map<string, SelectedInstallationFile>();
  constructor(
    private readonly canonical: (path: string) => string = filePath,
    private readonly selectedPath: (path: string, directory: boolean) => string = (path) => path,
  ) {}
  add(selection: InstallationSelection): InstallationSelection {
    if (selection.directory) this.files.clear();
    for (const entry of selection.files) {
      const path = filePath(this.selectedPath(entry.path, selection.directory));
      this.files.set(this.canonical(path), {path, file: entry.file});
    }
    return {files: Array.from(this.files.values()), directory: true};
  }
  clear(): void {
    this.files.clear();
  }
}

/** Keep the browser's File objects: slicing them reads the selected files on demand. */
export function selectedInstallationFiles(
  files: Iterable<File>,
  directory: boolean,
): InstallationSelection {
  let root: string | undefined;
  const paths = new Set<string>();
  const selected: SelectedInstallationFile[] = [];
  for (const file of files) {
    const parts = directory ? file.webkitRelativePath.split('/') : [file.name];
    if (directory) {
      if (parts.length < 2)
        throw new Error('The browser did not provide folder paths. Use Add files or Add one file.');
      root ??= parts[0];
      if (parts[0] !== root) throw new Error('Choose one installation folder.');
      parts.shift();
    }
    const path = filePath('/' + parts.join('/'));
    if (isInstallationMetadata(path)) continue;
    if (paths.has(path)) throw new Error(`Duplicate selected file: ${path}`);
    paths.add(path);
    selected.push({path, file});
  }
  return {files: selected, directory};
}

type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: (options: {mode: 'read'}) => Promise<FileSystemDirectoryHandle>;
  showOpenFilePicker?: (options: {
    multiple: boolean;
    excludeAcceptAllOption: false;
  }) => Promise<FileSystemFileHandle[]>;
};
export function hasInstallationDirectoryPicker(view: Window): boolean {
  return typeof (view as DirectoryPickerWindow).showDirectoryPicker === 'function';
}

export function hasInstallationFilePicker(view: Window): boolean {
  return typeof (view as DirectoryPickerWindow).showOpenFilePicker === 'function';
}

/** Unfiltered selection preserves unknown game formats in supporting platform pickers. */
export async function pickInstallationFiles(view: Window): Promise<InstallationSelection> {
  const handles = await (view as DirectoryPickerWindow).showOpenFilePicker!({
    multiple: true,
    excludeAcceptAllOption: false,
  });
  const files = [];
  for (const handle of handles) files.push(await handle.getFile());
  return selectedInstallationFiles(files, false);
}

/** Invoke directly from a click handler, before awaiting anything, to preserve activation. */
export async function pickInstallationDirectory(view: Window): Promise<InstallationSelection> {
  const root = await (view as DirectoryPickerWindow).showDirectoryPicker!({mode: 'read'});
  return readInstallationDirectory(root);
}

type PermissionDirectoryHandle = FileSystemDirectoryHandle & {
  queryPermission?(options: {mode: 'read'}): Promise<PermissionState>;
  requestPermission?(options: {mode: 'read'}): Promise<PermissionState>;
};

/** A stored handle is not a permission grant. This never shows a browser prompt. */
export function installationDirectoryPermission(
  handle: FileSystemDirectoryHandle,
): Promise<PermissionState> {
  return (
    (handle as PermissionDirectoryHandle).queryPermission?.({mode: 'read'}) ??
    Promise.resolve('prompt')
  );
}

/** Call directly in the reconnect click, before awaiting storage or other work. */
export function requestInstallationDirectoryPermission(
  handle: FileSystemDirectoryHandle,
): Promise<PermissionState> {
  return (
    (handle as PermissionDirectoryHandle).requestPermission?.({mode: 'read'}) ??
    Promise.resolve('denied')
  );
}

/** Refresh File snapshots after a reload instead of retaining stale file contents. */
export async function readInstallationDirectory(
  root: FileSystemDirectoryHandle,
): Promise<InstallationSelection> {
  const files: SelectedInstallationFile[] = [];
  async function visit(directory: FileSystemDirectoryHandle, prefix: string): Promise<void> {
    // The browser's async directory iterator is not yet included in every TS DOM library.
    const entries = directory as FileSystemDirectoryHandle & {
      values(): AsyncIterableIterator<FileSystemHandle>;
    };
    for await (const handle of entries.values()) {
      if (isInstallationMetadata(handle.name)) continue;
      const path = filePath(prefix + '/' + handle.name);
      if (handle.kind === 'directory') await visit(handle as FileSystemDirectoryHandle, path);
      else files.push({path, file: await (handle as FileSystemFileHandle).getFile()});
    }
  }
  await visit(root, '');
  return {files, directory: true, directoryHandle: root};
}

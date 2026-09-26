import {FileError} from '../../../platform/filesystem.js';
import type {BurikoBpPointer} from '../bp/memory.js';
import {BurikoDirectoryTree} from './directory-tree.js';
import type {BurikoShellShortcuts} from './shell-shortcuts.js';

export interface BurikoInstallerShortcutCall {
  readonly executableFolder: Uint8Array;
  readonly executableName: Uint8Array;
  readonly mainShortcutName: Uint8Array;
  readonly uninstallerName: Uint8Array;
  readonly uninstallerShortcutName: Uint8Array;
  readonly programsSubfolder: Uint8Array;
  readonly createPrograms: number;
  readonly createDesktop: number;
}

const pointer = (bytes: Uint8Array): BurikoBpPointer => ({bytes, offset: 0});

/** C82E0 shares the selected ShellLink and folder owners with F7 and F6. */
export class BurikoInstallerShortcutTransaction {
  constructor(readonly shortcuts: BurikoShellShortcuts) {
    if (shortcuts.files.specialFolders !== shortcuts.folders || shortcuts.files.metadata === null)
      throw new Error('Buriko installer shortcuts require mounted folder and file owners');
  }

  private combine(first: Uint8Array, second: Uint8Array): Uint8Array {
    const output = new Uint8Array(784);
    this.shortcuts.folders.combine(pointer(output), pointer(first), 1, pointer(second));
    return output;
  }

  private async folder(selector: 1 | 2): Promise<Uint8Array> {
    const output = new Uint8Array(784);
    await this.shortcuts.folders.query(pointer(output), selector);
    return output;
  }

  private async deleteSaved(paths: readonly Uint8Array[]): Promise<void> {
    const files = this.shortcuts.files;
    for (let index = paths.length - 1; index >= 0; index--) {
      try {
        const path = files.mountedPath(files.path(paths[index]!));
        const attributes = await files.metadata!.getAttributes(path);
        if (attributes !== null) await files.metadata!.setAttributes(path, attributes & ~3);
        await files.metadata!.deleteFile(path);
      } catch (error) {
        if (!(error instanceof FileError) && !(error instanceof DOMException)) throw error;
      }
    }
  }

  async create(call: BurikoInstallerShortcutCall): Promise<0 | 1> {
    const target = this.combine(call.executableFolder, call.executableName),
      saved: Uint8Array[] = [];
    if (call.createDesktop !== 0) {
      const desktop = this.combine(await this.folder(1), call.mainShortcutName);
      if (this.shortcuts.saveAtPath(desktop, target) !== 0) saved.push(desktop);
    }
    const tree = new BurikoDirectoryTree(this.shortcuts.files);
    try {
      if (call.createPrograms === 0) return 1;
      const directory = this.combine(await this.folder(2), call.programsSubfolder);
      if ((await tree.ensure(directory)) !== 0) {
        const primary = this.combine(directory, call.mainShortcutName);
        if (this.shortcuts.saveAtPath(primary, target) !== 0) {
          saved.push(primary);
          const secondary = this.combine(directory, call.uninstallerShortcutName),
            uninstaller = this.combine(call.executableFolder, call.uninstallerName);
          if (this.shortcuts.saveAtPath(secondary, uninstaller) !== 0) {
            saved.push(secondary);
            return 1;
          }
        }
      }
      await this.deleteSaved(saved);
      await tree.removeCreatedDirectories();
      return 0;
    } finally {
      tree.dispose();
    }
  }
}

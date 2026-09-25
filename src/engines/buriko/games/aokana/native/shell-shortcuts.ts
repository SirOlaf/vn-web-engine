import type {AokanaBpPointer} from '../bp/memory.js';
import {AokanaDirectoryTree} from './directory-tree.js';
import type {AokanaProgramFiles} from './program-files.js';
import type {AokanaSpecialFolders} from './special-folders.js';

/** Live IPersistFile portion of the selected ShellLink platform primitive. */
export interface AokanaShellShortcutPersistFile {
  save(destination: string, remember: boolean): number;
  release(): void;
}

/** Live IShellLinkW portion of the selected ShellLink platform primitive. */
export interface AokanaShellShortcutLink {
  setPath(target: string): number;
  setArguments(arguments_: string): number;
  setWorkingDirectory(directory: string): number;
  queryPersistFile(): {hresult: number; persist: AokanaShellShortcutPersistFile | null};
  release(): void;
}

/**
 * Explicit CoCreateInstance(CLSID_ShellLink/IID_IShellLinkW/CLSCTX_INPROC_SERVER)
 * boundary. A configured browser host may report failure, while a capable platform
 * implementation supplies the real shell-link primitive; this owner never writes a
 * substitute file format.
 */
export interface AokanaShellShortcutHost {
  createShellLink(): {hresult: number; link: AokanaShellShortcutLink | null};
}

const pointer = (bytes: Uint8Array): AokanaBpPointer => ({bytes, offset: 0});

/** C8650/C8790: special-folder destination selection and strict-S_OK ShellLink writer. */
export class AokanaShellShortcuts {
  constructor(
    readonly files: AokanaProgramFiles,
    readonly folders: AokanaSpecialFolders,
    readonly host: AokanaShellShortcutHost,
  ) {}

  /** C8790 releases each acquired interface at its exact failure/success boundary. */
  private saveShortcut(
    destination: Uint8Array,
    target: Uint8Array,
    arguments_: Uint8Array | null,
  ): 0 | 1 {
    const created = this.host.createShellLink();
    if (created.hresult !== 0) return 0;
    const link = created.link;
    if (link === null)
      throw new Error('Aokana shell-shortcut host returned S_OK without an IShellLinkW');
    try {
      if (link.setPath(this.files.text.decodeAuto(pointer(target))) !== 0) return 0;
      const decodedArguments =
        arguments_ === null ? '' : this.files.text.decodeAuto(pointer(arguments_));
      if (link.setArguments(decodedArguments) !== 0) return 0;
      if (link.setWorkingDirectory('') !== 0) return 0;
      const queried = link.queryPersistFile();
      if (queried.hresult !== 0) return 0;
      const persist = queried.persist;
      if (persist === null)
        throw new Error('Aokana shell-shortcut host returned S_OK without an IPersistFile');
      try {
        return persist.save(this.files.text.decodeAuto(pointer(destination)), true) === 0 ? 1 : 0;
      } finally {
        persist.release();
      }
    } finally {
      link.release();
    }
  }

  /** C8650 keeps newly created Programs directories only after a successful shortcut save. */
  async create(
    subdirectory: Uint8Array | null,
    filename: Uint8Array,
    target: Uint8Array,
    arguments_: Uint8Array | null,
  ): Promise<0 | 1> {
    const folderBytes = new Uint8Array(784),
      destination = new Uint8Array(784);
    if (subdirectory === null) {
      await this.folders.query(pointer(folderBytes), 1);
      this.folders.combine(pointer(destination), pointer(folderBytes), 1, pointer(filename));
      return this.saveShortcut(destination, target, arguments_);
    }

    const directories = new AokanaDirectoryTree(this.files),
      programDirectory = new Uint8Array(784);
    try {
      await this.folders.query(pointer(folderBytes), 2);
      this.folders.combine(
        pointer(programDirectory),
        pointer(folderBytes),
        1,
        pointer(subdirectory),
      );
      if ((await directories.ensure(programDirectory)) === 0) return 0;
      this.folders.combine(pointer(destination), pointer(programDirectory), 1, pointer(filename));
      const result = this.saveShortcut(destination, target, arguments_);
      if (result === 0) await directories.removeCreatedDirectories();
      return result;
    } finally {
      directories.dispose();
    }
  }
}

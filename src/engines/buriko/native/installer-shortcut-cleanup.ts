import {FileError} from '../../../platform/filesystem.js';
import type {BurikoBpPointer} from '../bp/memory.js';
import type {BurikoMountedFileMetadata} from './file-metadata.js';
import type {BurikoProgramFiles} from './program-files.js';
import type {BurikoSpecialFolders} from './special-folders.js';

/** C81C0 removes the installer shortcuts using the same shell folders and files as other VM calls. */
export class BurikoInstallerShortcutCleanup {
  readonly metadata: BurikoMountedFileMetadata;

  constructor(
    readonly folders: BurikoSpecialFolders,
    readonly files: BurikoProgramFiles,
  ) {
    if (folders.text !== files.text || files.specialFolders !== folders || files.metadata === null)
      throw new Error(
        'Buriko shortcut cleanup requires shared folder, text and mounted file owners',
      );
    this.metadata = files.metadata;
  }

  private async folder(selector: 1 | 2): Promise<string> {
    const scratch: BurikoBpPointer = {bytes: new Uint8Array(784), offset: 0};
    if ((await this.folders.query(scratch, selector)) === 0)
      throw new Error('Buriko shortcut cleanup consumes an unwritten special-folder path');
    return this.files.text.decodeAuto(scratch);
  }

  private path(wide: string): string {
    return this.files.mountedPath(wide);
  }

  private async deleteFile(wide: string): Promise<void> {
    try {
      await this.metadata.deleteFile(this.path(wide));
    } catch (error) {
      // C81C0 ignores DeleteFileW's Boolean result.
      if (!(error instanceof FileError) && !(error instanceof DOMException)) throw error;
    }
  }

  /** Native arguments are the desktop/program filename, companion filename, subfolder, and flag. */
  async remove(
    first: BurikoBpPointer | null,
    second: BurikoBpPointer | null,
    third: BurikoBpPointer | null,
    removeFolder: number,
  ): Promise<void> {
    if (first === null || second === null || third === null)
      throw new Error('Buriko shortcut cleanup dereferences a null name');
    const primary = this.files.text.decodeAuto(first),
      companion = this.files.text.decodeAuto(second),
      subfolder = this.files.text.decodeAuto(third),
      desktop = await this.folder(1);
    await this.deleteFile(`${desktop}\\${primary}`);
    const programs = await this.folder(2),
      programFolder = `${programs}\\${subfolder}`;
    await this.deleteFile(`${programFolder}\\${primary}`);
    await this.deleteFile(`${programFolder}\\${companion}`);
    if (removeFolder !== 0) {
      try {
        await this.metadata.removeDirectory(this.path(programFolder));
      } catch (error) {
        // C81C0 also ignores RemoveDirectoryW's Boolean result.
        if (!(error instanceof FileError) && !(error instanceof DOMException)) throw error;
      }
    }
  }
}

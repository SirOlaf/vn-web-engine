import {FileError} from '../../../platform/filesystem.js';
import {
  BrowserWindowsTemporaryFileHost,
  type WindowsTemporaryFileOperations,
} from '../../../platform/windows-temporary-file.js';
import {BurikoDirectoryTree} from './directory-tree.js';
import {BurikoNativeFile} from './native-file.js';
import type {BurikoProgramFiles} from './program-files.js';
import {textBytes} from './text.js';

export {copyBurikoPathComponentPrefix} from './directory-tree.js';

/** GetTempFileNameW/DeleteFileW-shaped boundary over the same mounted file owner. */
export interface BurikoTemporaryFileHost {
  createTemporaryFile(
    files: BurikoProgramFiles,
    directory: string,
    prefix: string,
  ): Promise<string | null>;
  deleteTemporaryFile(files: BurikoProgramFiles, path: string): Promise<number>;
}

/** Binds the shared browser candidate/operation host to this program's mounted files. */
export class BurikoBrowserTemporaryFileHost implements BurikoTemporaryFileHost {
  constructor(readonly host: BrowserWindowsTemporaryFileHost) {}

  private operations(files: BurikoProgramFiles): WindowsTemporaryFileOperations | null {
    const metadata = files.metadata;
    if (metadata === null) return null;
    return {
      exists: async (path) => {
        try {
          await metadata.stat(files.mountedPath(path));
          return true;
        } catch (error) {
          if (error instanceof FileError && error.code === 'NOT_FOUND') return false;
          if (error instanceof FileError || error instanceof DOMException) return null;
          throw error;
        }
      },
      create: async (path) => {
        const created = await files.createOutput(files.text.encodeWide(path, 1));
        if (created === null) return false;
        created.close();
        return true;
      },
      remove: async (path) => {
        try {
          await metadata.commit([{kind: 'delete', path: files.mountedPath(path)}]);
          return true;
        } catch (error) {
          if (error instanceof FileError || error instanceof DOMException) return false;
          throw error;
        }
      },
    };
  }

  createTemporaryFile(
    files: BurikoProgramFiles,
    directory: string,
    prefix: string,
  ): Promise<string | null> {
    const operations = this.operations(files);
    return operations === null
      ? Promise.resolve(null)
      : this.host.createTemporaryFile(operations, directory, prefix);
  }

  deleteTemporaryFile(files: BurikoProgramFiles, path: string): Promise<number> {
    const operations = this.operations(files);
    return operations === null
      ? Promise.resolve(0)
      : this.host.deleteTemporaryFile(operations, path);
  }
}

/** Explicit candidate names that are created in the selected mounted namespace. */
export class BurikoTemporaryFileProfile implements BurikoTemporaryFileHost {
  private nextCandidate = 0;

  constructor(private readonly candidates: readonly string[]) {
    for (const candidate of candidates)
      if (candidate.length === 0 || /[\\/:\0]/.test(candidate) || !candidate.startsWith('BGI'))
        throw new RangeError('Buriko temporary candidates must be BGI-prefixed file names');
  }

  async createTemporaryFile(
    files: BurikoProgramFiles,
    directory: string,
    prefix: string,
  ): Promise<string | null> {
    if (prefix !== 'BGI')
      throw new RangeError('Buriko temporary-file profile requires the native BGI prefix');
    const metadata = files.metadata;
    if (metadata === null) return null;
    while (this.nextCandidate < this.candidates.length) {
      const candidate = this.candidates[this.nextCandidate++]!;
      const path = directory + (directory.endsWith('\\') ? '' : '\\') + candidate;
      let exists = true;
      try {
        await metadata.stat(files.mountedPath(path));
      } catch (error) {
        if (!(error instanceof FileError) || error.code !== 'NOT_FOUND') return null;
        exists = false;
      }
      if (exists) continue;
      const created = await files.createOutput(files.text.encodeWide(path, 1));
      if (created === null) return null;
      created.close();
      return path;
    }
    return null;
  }

  async deleteTemporaryFile(files: BurikoProgramFiles, path: string): Promise<number> {
    const metadata = files.metadata;
    if (metadata === null) return 0;
    try {
      await metadata.commit([{kind: 'delete', path: files.mountedPath(path)}]);
      return 1;
    } catch (error) {
      if (error instanceof FileError || error instanceof DOMException) return 0;
      throw error;
    }
  }
}

export class BurikoTemporaryDirectoryProbe {
  constructor(
    readonly files: BurikoProgramFiles,
    private readonly host: BurikoTemporaryFileHost,
  ) {}

  /** BA720 performs the real empty-create/write-close/read-close/delete round trip. */
  async probe(path: Uint8Array): Promise<number> {
    const directories = new BurikoDirectoryTree(this.files);
    try {
      if ((await directories.ensure(path)) === 0) return 0;
      const directory = this.files.path(path);
      const temporary = await this.host.createTemporaryFile(this.files, directory, 'BGI');
      if (temporary === null) return 0;
      const file = new BurikoNativeFile(this.files);
      let result = 0;
      try {
        const nativePath = this.files.text.encodeWide(temporary, 1);
        const pointer = {bytes: nativePath, offset: 0};
        if ((await file.openWrite(pointer, 0)) !== 0) {
          file.close();
          if ((await file.openRead(pointer)) !== 0) {
            file.close();
            result = 1;
          }
        }
        await this.host.deleteTemporaryFile(this.files, temporary);
      } finally {
        file.dispose();
      }
      return result;
    } finally {
      await directories.removeCreatedDirectories();
      directories.dispose();
    }
  }
}

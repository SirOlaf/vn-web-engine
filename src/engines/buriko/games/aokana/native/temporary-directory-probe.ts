import {FileError} from '../../../../../platform/filesystem.js';
import {AokanaDirectoryTree} from './directory-tree.js';
import {AokanaNativeFile} from './native-file.js';
import type {AokanaProgramFiles} from './program-files.js';
import {textBytes} from './text.js';

export {copyAokanaPathComponentPrefix} from './directory-tree.js';

/** GetTempFileNameW/DeleteFileW-shaped boundary over the same mounted file owner. */
export interface AokanaTemporaryFileHost {
  createTemporaryFile(
    files: AokanaProgramFiles,
    directory: string,
    prefix: string,
  ): Promise<string | null>;
  deleteTemporaryFile(files: AokanaProgramFiles, path: string): Promise<number>;
}

/** Explicit candidate names that are created in the selected mounted namespace. */
export class AokanaTemporaryFileProfile implements AokanaTemporaryFileHost {
  private nextCandidate = 0;

  constructor(private readonly candidates: readonly string[]) {
    for (const candidate of candidates)
      if (candidate.length === 0 || /[\\/:\0]/.test(candidate) || !candidate.startsWith('BGI'))
        throw new RangeError('Aokana temporary candidates must be BGI-prefixed file names');
  }

  async createTemporaryFile(
    files: AokanaProgramFiles,
    directory: string,
    prefix: string,
  ): Promise<string | null> {
    if (prefix !== 'BGI')
      throw new RangeError('Aokana temporary-file profile requires the native BGI prefix');
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

  async deleteTemporaryFile(files: AokanaProgramFiles, path: string): Promise<number> {
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

export class AokanaTemporaryDirectoryProbe {
  constructor(
    readonly files: AokanaProgramFiles,
    private readonly host: AokanaTemporaryFileHost,
  ) {}

  /** BA720 performs the real empty-create/write-close/read-close/delete round trip. */
  async probe(path: Uint8Array): Promise<number> {
    const directories = new AokanaDirectoryTree(this.files);
    try {
      if ((await directories.ensure(path)) === 0) return 0;
      const directory = this.files.path(path);
      const temporary = await this.host.createTemporaryFile(this.files, directory, 'BGI');
      if (temporary === null) return 0;
      const file = new AokanaNativeFile(this.files);
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

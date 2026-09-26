import {FileError} from '../../../platform/filesystem.js';
import type {BurikoProgramFiles} from './program-files.js';
import {textByte, textBytes} from './text.js';

/** BC6F0 copies the indexed component prefix at native character boundaries. */
export function copyBurikoPathComponentPrefix(
  files: BurikoProgramFiles,
  path: Uint8Array,
  index: number,
): Uint8Array | null {
  index |= 0;
  let remaining = index;
  if (remaining < 0) return null;
  const source = textBytes({bytes: path, offset: 0}, true);
  const mode = files.text.detectEncoding(source);
  const output: number[] = [];
  let offset = 0;
  while (remaining >= 0) {
    const first = textByte(source, offset);
    if (first === 0) break;
    if (first === 92 && textByte(source, offset + 1) !== 0) remaining--;
    const character = files.text.readCharacter(source, offset, mode);
    for (let count = 0; count < character.length; count++) output.push(textByte(source, offset++));
    if (textByte(source, offset) === 0) remaining--;
  }
  if (remaining >= 0) return null;
  if (index > 0 && textByte(source, offset) !== 0) output.pop();
  output.push(0);
  return Uint8Array.from(output);
}

/** CA170/CAB00/C99E0: one operation's mounted directory-creation bookkeeping owner. */
export class BurikoDirectoryTree {
  private readonly created: string[] = [];

  constructor(private readonly files: BurikoProgramFiles) {}

  /** CA170 retains only directories that this invocation actually created. */
  async ensure(path: Uint8Array): Promise<0 | 1> {
    const metadata = this.files.metadata;
    if (metadata === null) return 0;
    for (let index = 0; ; index++) {
      const prefix = copyBurikoPathComponentPrefix(this.files, path, index);
      if (prefix === null) return 1;
      let mounted: string;
      try {
        mounted = this.files.mountedPath(this.files.path(prefix));
      } catch (error) {
        if (error instanceof FileError || error instanceof DOMException) return 0;
        throw error;
      }
      try {
        if ((await metadata.stat(mounted)).kind !== 'directory') return 0;
        continue;
      } catch (error) {
        if (!(error instanceof FileError) || error.code !== 'NOT_FOUND' || index === 0) return 0;
      }
      try {
        await metadata.createDirectory(mounted);
      } catch (error) {
        if (error instanceof FileError || error instanceof DOMException) return 0;
        throw error;
      }
      this.created.push(mounted);
    }
  }

  /** CAB00 removes the recorded directories child-first and attempts every record. */
  async removeCreatedDirectories(): Promise<0 | 1> {
    const metadata = this.files.metadata;
    let success = true;
    for (let index = this.created.length - 1; index >= 0; index--)
      try {
        await metadata!.removeDirectory(this.created[index]!);
      } catch (error) {
        if (!(error instanceof FileError) && !(error instanceof DOMException)) throw error;
        success = false;
      }
    return Number(success) as 0 | 1;
  }

  /** C99E0 destroys the bookkeeping records without changing the mounted directories. */
  dispose(): void {
    this.created.length = 0;
  }
}

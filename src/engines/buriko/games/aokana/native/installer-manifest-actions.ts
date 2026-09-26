import {FileError} from '../../../../../platform/filesystem.js';
import type {AokanaProgramResources} from './program-resources.js';
import {terminatedNativeBytes} from './program-files.js';
import {textBytes} from './text.js';

const manifestName = new TextEncoder().encode('uninst.lst\0');

function nativeString(bytes: Uint8Array): Uint8Array {
  return terminatedNativeBytes(bytes).slice();
}

function key(bytes: Uint8Array): string {
  return Array.from(textBytes({bytes, offset: 0})).join(',');
}

function appendUnique(entries: Uint8Array[], keys: Set<string>, entry: Uint8Array): void {
  const identity = key(entry);
  if (keys.has(identity)) return;
  entries.push(entry);
  keys.add(identity);
}

/** C7D50/C7B50 borrow the same mounted files and text owner as installation. */
export class AokanaInstallerManifestActions {
  constructor(readonly resources: AokanaProgramResources) {}

  private path(root: Uint8Array): Uint8Array {
    return this.resources.loosePath(root, manifestName, true);
  }

  /** C7D50: return the open result, ignoring each DeleteFileW result. */
  async deleteUnlisted(root: Uint8Array, retain: readonly Uint8Array[]): Promise<0 | 1> {
    const rootName = nativeString(root),
      retainKeys = new Set(retain.map((entry) => key(nativeString(entry)))),
      opened = await this.resources.files.open(this.path(rootName));
    if (opened.source === null) return 0;
    const metadata = this.resources.files.metadata;
    if (metadata === null)
      throw new Error('Aokana installer deletion requires the shared mounted metadata owner');
    const bytes = await this.resources.files.read(opened.source, 0, opened.source.size);
    // The ordinary native manifest has a trailing LF on every record.
    for (let start = 0; start < bytes.length && bytes[start] !== 0;) {
      const end = bytes.indexOf(10, start);
      if (end < 0) throw new Error('Aokana installer deletion reads an unterminated manifest line');
      const line = bytes.slice(start, end);
      start = end + 1;
      const name = nativeString(line);
      if (name[0] === 64 || key(name) === key(manifestName) || retainKeys.has(key(name))) continue;
      const path = this.resources.loosePath(rootName, name, true),
        mounted = this.resources.files.mountedPath(this.resources.files.path(path));
      try {
        await metadata.deleteFile(mounted);
      } catch (error) {
        if (!(error instanceof FileError) && !(error instanceof DOMException)) throw error;
      }
    }
    return 1;
  }

  /** C7B50: merge the existing two lists and caller entries, then write LF records plus NUL. */
  async mergeUninstallList(root: Uint8Array, additions: readonly Uint8Array[]): Promise<boolean> {
    const path = this.path(root),
      appended = additions.map(nativeString),
      opened = await this.resources.files.open(path),
      normal: Uint8Array[] = [],
      directories: Uint8Array[] = [],
      normalKeys = new Set<string>(),
      directoryKeys = new Set<string>();
    if (opened.source !== null) {
      const contents = await this.resources.files.read(opened.source, 0, opened.source.size);
      const end = contents.indexOf(0),
        limit = end < 0 ? contents.length : end;
      for (let start = 0; start < limit;) {
        let finish = start;
        while (finish < limit && contents[finish] !== 13 && contents[finish] !== 10) finish++;
        while (start < finish && (contents[start] === 32 || contents[start] === 9)) start++;
        if (start < finish) {
          const raw = nativeString(contents.subarray(start, finish));
          const converted = this.resources.files.text.convertEncoding({bytes: raw, offset: 0}, 1);
          this.resources.files.text.lowercase({bytes: converted, offset: 0});
          if (converted[0] === 36) appendUnique(directories, directoryKeys, converted);
          else appendUnique(normal, normalKeys, converted);
        }
        start = finish;
        while (start < limit && (contents[start] === 13 || contents[start] === 10)) start++;
      }
    }
    for (const copied of appended) {
      this.resources.files.text.lowercase({bytes: copied, offset: 0});
      appendUnique(normal, normalKeys, copied);
    }
    const output: number[] = [];
    for (const entry of [...normal, ...directories])
      output.push(...textBytes({bytes: entry, offset: 0}), 10);
    output.push(0);
    const file = await this.resources.files.createOutput(path);
    if (file === null) return false;
    try {
      return (await file.write(Uint8Array.from(output))) === output.length;
    } finally {
      file.close();
    }
  }
}

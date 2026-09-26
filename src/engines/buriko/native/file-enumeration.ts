import {FileError} from '../../../platform/filesystem.js';
import type {WindowsDirectoryNamespaceHost} from '../../../platform/windows-directory-namespace.js';
import {type BurikoBpPointer, pointerView} from '../bp/memory.js';
import type {BurikoProgramFiles} from './program-files.js';
import {textBytes} from './text.js';
import {assertBurikoPathDomain} from './path-domain.js';

/** Win32 expression translation and DOS_STAR/DOS_QM/DOS_DOT matching over UTF-16 units. */
export function burikoDosMatch(
  pattern: string,
  name: string,
  fold: (value: string) => string,
): boolean {
  if (pattern === '' || pattern === '*.*') pattern = '*';
  let expression = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '?') expression += '>';
    else if (c === '.' && i === pattern.length - 1 && i > 0 && pattern[i - 1] === '*')
      expression = expression.slice(0, -1) + '<';
    else if (c === '.' && (pattern[i + 1] === '?' || pattern[i + 1] === '*')) expression += '"';
    else expression += c;
  }
  expression = fold(expression);
  name = fold(name);
  const visited = new Set<string>(),
    pending: [number, number][] = [[0, 0]],
    lastDot = name.lastIndexOf('.');
  while (pending.length) {
    const [p, n] = pending.pop()!,
      key = `${p}:${n}`;
    if (visited.has(key)) continue;
    visited.add(key);
    if (p === expression.length) {
      if (n === name.length) return true;
      continue;
    }
    const c = expression[p]!;
    if (c === '*' || c === '<') {
      pending.push([p + 1, n]);
      if (n < name.length && (c === '*' || n !== lastDot)) pending.push([p, n + 1]);
    } else if (c === '>') {
      pending.push([p + 1, n === name.length || name[n] === '.' ? n : n + 1]);
    } else if (c === '"') {
      if (n === name.length) pending.push([p + 1, n]);
      else if (name[n] === '.') pending.push([p + 1, n + 1]);
    } else if (n < name.length && c === name[n]) pending.push([p + 1, n + 1]);
  }
  return false;
}

export class BurikoFileEnumeration {
  readonly metadata;
  constructor(
    readonly files: BurikoProgramFiles,
    readonly browserNamespace: WindowsDirectoryNamespaceHost | null = null,
  ) {
    if (files.metadata === null)
      throw new Error('Buriko enumeration requires the shared metadata owner');
    this.metadata = files.metadata;
  }
  get available(): boolean {
    return this.metadata.profile.namespace !== undefined || this.browserNamespace !== null;
  }
  private async find(pattern: string) {
    assertBurikoPathDomain(pattern, true);
    const profile = this.metadata.profile.namespace;
    if (profile === undefined && this.browserNamespace === null)
      throw new Error('Buriko enumeration requires a selected namespace host');
    if (pattern.length > 783)
      throw new RangeError('Buriko find path exceeds native wide stack buffer');
    try {
      if (pattern === '' || /[\\/]$/.test(pattern)) return [];
      const normalized = pattern.replaceAll('/', '\\'),
        slash = normalized.lastIndexOf('\\');
      const directory =
        slash >= 0 ? normalized.slice(0, slash + 1) : (normalized.match(/^[a-z]:/i)?.[0] ?? '.');
      const expression = normalized.slice(slash >= 0 ? slash + 1 : directory === '.' ? 0 : 2);
      const mounted = this.files.mountedPath(directory);
      const entries =
        profile === undefined
          ? await this.browserNamespace!.list(this.metadata, mounted)
          : await this.metadata.findEntries(mounted);
      const fold =
        profile === undefined
          ? (name: string) => this.browserNamespace!.fold(name)
          : (name: string) => profile.fold(name);
      return entries.filter(
        (entry) =>
          burikoDosMatch(expression, entry.name, fold) ||
          (entry.shortName !== null && burikoDosMatch(expression, entry.shortName, fold)),
      );
    } catch (error) {
      if (error instanceof FileError || error instanceof DOMException) return [];
      throw error;
    }
  }
  /** F84F0 searches native characters, never CP932 trail bytes. */
  private lastSlash(bytes: Uint8Array): number {
    const text = this.files.text,
      mode = text.detectEncoding(bytes);
    let result = -1;
    for (let offset = 0; bytes[offset] !== 0;) {
      const character = text.readCharacter(bytes, offset, mode);
      if (character.value === 92) result = offset;
      offset += character.length;
    }
    return result;
  }
  async enumerate(
    output: BurikoBpPointer | null,
    capacity: number,
    pattern: BurikoBpPointer,
    recursive: boolean,
    maximum: number,
    directories = false,
  ): Promise<{count: number; size: number}> {
    capacity >>>= 0;
    maximum >>>= 0;
    let size = 0,
      count = 0;
    const append = (name: string): boolean => {
      const bytes = this.files.text.encodeWide(name, 1);
      if (bytes.length > 784)
        throw new RangeError('Buriko enumeration name exceeds native byte stack buffer');
      if (output !== null) {
        if (size + bytes.length > capacity) return false;
        const view = pointerView({...output, offset: output.offset + size}, bytes.length);
        new Uint8Array(view.buffer, view.byteOffset, view.byteLength).set(bytes);
      }
      size = (size + bytes.length) >>> 0;
      count = (count + 1) >>> 0;
      return true;
    };
    const visit = async (native: Uint8Array, prefix: string, limit: number): Promise<boolean> => {
      const pointer = {bytes: native, offset: 0},
        wide = this.files.text.decodeAuto(pointer);
      const entries = await this.find(wide);
      if (entries.length === 0) return true;
      const startCount = count;
      for (const entry of entries) {
        if (
          (entry.kind === 'directory') === directories &&
          entry.name !== '.' &&
          entry.name !== '..'
        ) {
          if (!append(prefix + entry.name)) return false;
        }
        if (limit !== 0 && (count - startCount) >>> 0 >= limit) break;
      }
      if (!recursive || directories) return true;
      if (native.length > 784)
        throw new RangeError('Buriko recursive pattern exceeds native byte stack buffer');
      const slash = this.lastSlash(native),
        head = native.subarray(0, slash + 1);
      const search = new Uint8Array(head.length + 2);
      search.set(head);
      search[head.length] = 42;
      for (const entry of await this.find(this.files.text.decodeAuto({bytes: search, offset: 0}))) {
        if (entry.kind !== 'directory' || entry.name === '.' || entry.name === '..') continue;
        if (slash < 0)
          throw new Error('Buriko recursive child path dereferences a null native suffix');
        const suffix = this.files.text.decodeAuto({bytes: native, offset: slash});
        const child = this.files.text.encodeWide(entry.name + suffix, 1);
        if (child.length > 784 || head.length + child.length > 784)
          throw new RangeError('Buriko recursive child exceeds native byte stack buffer');
        const next = new Uint8Array(head.length + child.length);
        next.set(head);
        next.set(child, head.length);
        const nextPrefix = prefix + entry.name + '\\';
        if (this.files.text.encodeWide(nextPrefix, 1).length > 784)
          throw new RangeError('Buriko recursive prefix exceeds native byte stack buffer');
        if (
          !(await visit(next, nextPrefix, limit === 0 ? 0 : (limit - (count - startCount)) >>> 0))
        )
          return false;
      }
      return true;
    };
    const success = await visit(textBytes(pattern, true).slice(), '', maximum);
    return {count: success ? count : 0xffffffff, size};
  }
}

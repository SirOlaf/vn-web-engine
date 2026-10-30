import {checkRange} from '../../core/binary.js';
import type {ByteSource} from '../../core/source.js';
import {beginRuntimeSpan, recordRuntimeMetric} from '../../platform/runtime-performance.js';
import {PfsArchive, pfsPathKey, type PfsEntry} from '../../formats/artemis/pfs.js';

export type ArtemisFileLookup = (
  segments: readonly string[],
) => ByteSource | undefined | Promise<ByteSource | undefined>;
function segments(path: string): string[] {
  const parts = pfsPathKey(path).split('/');
  if (
    !path ||
    parts.some((p) => !p || p === '.' || p === '..' || p.includes(':') || p.includes('\0'))
  )
    throw new Error(`Unsupported installation-relative Artemis path ${path}`);
  return parts;
}

/** A file read ahead of its use. Every read returns a new array, as `BlobSource` does. */
class BytesSource implements ByteSource {
  readonly size: number;
  constructor(private readonly bytes: Uint8Array) {
    this.size = bytes.length;
  }
  async read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array> {
    checkRange(this.size, offset, length);
    signal?.throwIfAborted();
    return this.bytes.slice(offset, offset + length);
  }
}

/** A name a scenario block refers to: a file name, optionally under a magic-path directory. */
export interface ArtemisReadAheadName {
  readonly directory?: string;
  readonly name: string;
}
/** Read-ahead limits: whole archive entries up to `FILE_BYTES`, `TOTAL_BYTES` kept. */
const READ_AHEAD_FILE_BYTES = 16 * 1024 * 1024;
const READ_AHEAD_TOTAL_BYTES = 96 * 1024 * 1024;
const READ_AHEAD_MATCHES = 4;

/** Loose-first resolution, numeric overlays and installation-relative native magic paths. */
export class ArtemisFiles {
  readonly archives: {readonly name: string; readonly archive: PfsArchive}[] = [];
  private readonly magicPaths = new Map<string, string>();
  private readonly entries = new Map<string, {archive: PfsArchive; entry: PfsEntry}>();
  /** Archive entries read ahead, by key, oldest use first. */
  private readonly ahead = new Map<string, Promise<Uint8Array | null>>();
  private readonly aheadSizes = new Map<string, number>();
  private aheadBytes = 0;
  private aheadGeneration = 0;
  /** Lower-case file name without extension -> archive keys. */
  private baseNames: Map<string, string[]> | undefined;
  private constructor(private readonly lookup: ArtemisFileLookup) {}

  static async mount(basePath: string, lookup: ArtemisFileLookup): Promise<ArtemisFiles> {
    segments(basePath);
    const files = new ArtemisFiles(lookup);
    for (let i = -1; i < 1000; i++) {
      const name = i < 0 ? basePath : `${basePath}.${String(i).padStart(3, '0')}`;
      const source = await lookup(segments(name));
      if (!source) {
        if (i < 0) throw new Error(`Missing Artemis base archive ${basePath}`);
        continue;
      }
      const archive = await PfsArchive.open(source);
      files.archives.push({name, archive});
      for (const entry of archive.entries)
        files.entries.set(pfsPathKey(entry.name), {archive, entry});
    }
    return files;
  }

  /** CLua 0x14012fa10: update one alias; an empty root deletes it. */
  setMagicPath(name: string, root: string): void {
    if (name.includes('\0') || root.includes('\0'))
      throw new Error('Unsupported Artemis magic path NUL');
    if (!root) {
      this.magicPaths.delete(name);
      return;
    }
    segments(root);
    this.magicPaths.set(name, pfsPathKey(root));
  }
  /** CArtemisPackFile 0x1401193d0 applies a single literal substitution before base lookup. */
  resolvePath(path: string): string {
    if (path.startsWith(':')) {
      const delimiter = path.slice(1).search(/[\\/]/);
      const end = delimiter < 0 ? path.length : delimiter + 1;
      const name = path.slice(1, end);
      const root = this.magicPaths.get(name);
      // Native reports success without opening for unknown/empty aliases. This
      // stateless ByteSource interface cannot represent a stale/unopened native handle.
      if (!name || root === undefined) throw new Error(`Unsupported Artemis magic path ${path}`);
      path = root + path.slice(end);
    }
    path = pfsPathKey(path);
    segments(path.endsWith('/') ? path.slice(0, -1) : path);
    return path;
  }
  async open(path: string): Promise<ByteSource | null> {
    // The loose open 0x1401658c0 fails on an empty name, and no archive key is empty.
    if (!path) return null;
    path = this.resolvePath(path);
    if (path.endsWith('/')) return null;
    const loose = await this.lookup(segments(path));
    if (loose !== undefined) return loose;
    const key = pfsPathKey(path);
    const ahead = this.ahead.get(key);
    if (ahead) {
      // Most recently used last.
      this.ahead.delete(key);
      this.ahead.set(key, ahead);
      const bytes = await ahead;
      recordRuntimeMetric('artemis.read-ahead.hit', bytes ? bytes.length : 0);
      if (bytes) return new BytesSource(bytes);
    }
    const found = this.entries.get(key);
    return found ? found.archive.entrySource(found.entry) : null;
  }

  /**
   * Reads the archive entries named by the next scenario block into memory, one after
   * another, so that its tags open them without waiting for the disk. A later call
   * replaces the queue of an earlier one; entries already read stay until the byte limit.
   */
  readAhead(names: readonly ArtemisReadAheadName[]): void {
    const generation = ++this.aheadGeneration;
    const keys = new Set<string>();
    for (const name of names)
      for (const key of this.matches(name)) if (!this.ahead.has(key)) keys.add(key);
    if (!keys.size) return;
    void (async () => {
      for (const key of keys) {
        if (generation !== this.aheadGeneration) return;
        const found = this.entries.get(key);
        if (!found || found.entry.size > READ_AHEAD_FILE_BYTES || this.ahead.has(key)) continue;
        const finish = beginRuntimeSpan('artemis.read-ahead.read');
        const source = found.archive.entrySource(found.entry);
        const bytes = source.read(0, source.size).catch(() => null);
        this.ahead.set(key, bytes);
        this.aheadSizes.set(key, found.entry.size);
        this.aheadBytes += found.entry.size;
        this.evict();
        await bytes;
        finish?.({sourceBytes: found.entry.size});
      }
    })();
  }
  private evict(): void {
    for (const key of this.ahead.keys()) {
      if (this.aheadBytes <= READ_AHEAD_TOTAL_BYTES) return;
      this.ahead.delete(key);
      this.aheadBytes -= this.aheadSizes.get(key) ?? 0;
      this.aheadSizes.delete(key);
    }
  }
  /** Archive keys of one name: the exact file under its directory with any extension,
   * else the same file name anywhere. */
  private matches({directory, name}: ArtemisReadAheadName): string[] {
    const base = name.split(/[\\/]/).pop()!.toLowerCase();
    if (!base) return [];
    if (!this.baseNames) {
      this.baseNames = new Map();
      for (const key of this.entries.keys()) {
        const file = key.slice(key.lastIndexOf('/') + 1),
          dot = file.lastIndexOf('.'),
          stem = (dot > 0 ? file.slice(0, dot) : file).toLowerCase();
        const list = this.baseNames.get(stem);
        if (list) list.push(key);
        else this.baseNames.set(stem, [key]);
      }
    }
    const candidates = this.baseNames.get(base) ?? [];
    if (directory !== undefined) {
      let prefix: string | undefined;
      try {
        prefix = (this.resolvePath(directory + name) + '.').toLowerCase();
      } catch {
        prefix = undefined;
      }
      const exact = prefix ? candidates.filter((key) => key.toLowerCase().startsWith(prefix)) : [];
      if (exact.length) return exact;
    }
    return candidates.slice(0, READ_AHEAD_MATCHES);
  }

  /** Plain CFile namespace: no archive lookup or CArtemisPackFile magic aliases. */
  async openPlain(path: string): Promise<ByteSource | null> {
    return (await this.lookup(segments(path))) ?? null;
  }
  async readPlain(path: string): Promise<Uint8Array | null> {
    const source = await this.openPlain(path);
    return source ? source.read(0, source.size) : null;
  }

  async read(path: string): Promise<Uint8Array | null> {
    const source = await this.open(path);
    return source ? source.read(0, source.size) : null;
  }
}

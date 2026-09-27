import type {ByteSource} from '../../core/source.js';
import {XflArchive, xflNameKey} from '../../formats/rscript/xfl.js';

/** Installation-relative lookup with native case-insensitivity for ASCII letters. */
export type RScriptFileLookup = (segments: readonly string[]) => ByteSource | undefined;

/** Splits a native relative path such as `.\grpo\0001.wcg` into case-folded segments. */
export function rscriptPathSegments(path: string): string[] {
  const segments = path
    .split(/[\\/]+/)
    .filter((segment) => segment && segment !== '.')
    .map(xflNameKey);
  if (!segments.length || segments.includes('..')) throw new Error(`Invalid RScript path ${path}`);
  return segments;
}

/**
 * Native resource resolution (0x436880, 0x43CE00, 0x43CEB0, 0x43D0D0): a loose file wins;
 * otherwise the longest directory prefix naming an `.xfl` archive is opened and the rest
 * of the path is looked up inside it, one nested `.xfl` per remaining directory.
 */
export class RScriptFiles {
  private readonly archives = new Map<string, Promise<XflArchive | null>>();
  constructor(private readonly lookup: RScriptFileLookup) {}

  async open(path: string): Promise<ByteSource | null> {
    const segments = rscriptPathSegments(path);
    const loose = this.lookup(segments);
    if (loose) return loose;
    for (let split = segments.length - 1; split >= 1; split--) {
      const archive = await this.archive(segments.slice(0, split));
      if (!archive) continue;
      return this.openInside(archive, segments.slice(split), segments.slice(0, split));
    }
    return null;
  }

  async read(path: string): Promise<Uint8Array | null> {
    const source = await this.open(path);
    return source ? source.read(0, source.size) : null;
  }

  private async openInside(
    archive: XflArchive,
    rest: readonly string[],
    prefix: readonly string[],
  ): Promise<ByteSource | null> {
    if (rest.length === 1) {
      const entry = archive.find(rest[0]!);
      return entry ? archive.entrySource(entry) : null;
    }
    const nestedPath = [...prefix, rest[0]!];
    const nested = await this.cached(nestedPath, async () => {
      const entry = archive.find(`${rest[0]!}.XFL`);
      return entry ? XflArchive.open(archive.entrySource(entry)) : null;
    });
    return nested ? this.openInside(nested, rest.slice(1), nestedPath) : null;
  }

  private archive(directory: readonly string[]): Promise<XflArchive | null> {
    return this.cached(directory, async () => {
      const file = [...directory];
      file[file.length - 1] += '.XFL';
      const source = this.lookup(file);
      return source ? XflArchive.open(source) : null;
    });
  }

  private cached(
    key: readonly string[],
    open: () => Promise<XflArchive | null>,
  ): Promise<XflArchive | null> {
    const id = key.join('\\');
    let archive = this.archives.get(id);
    if (!archive) {
      archive = open().catch((error: unknown) => {
        this.archives.delete(id);
        throw error;
      });
      this.archives.set(id, archive);
    }
    return archive;
  }
}

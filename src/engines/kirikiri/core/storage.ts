/**
 * The TVP storage system (krkrz `base/StorageIntf.cpp`, `base/win32/StorageImpl.cpp`): storage
 * names (`media://domain/path`, `archive.xp3>member`), registered media, the current
 * directory, XP3 archives opened by the core, auto search paths and stream creation.
 *
 * Existence checks, listings and name resolution are synchronous, as natively: the `file`
 * medium answers from an index of the installation, archive indexes are kept in memory once
 * loaded. Opening a storage returns a promise when bytes have to be fetched.
 */
import {Xp3Archive, type Xp3Entry} from '../../../formats/kirikiri/xp3.js';
import type {ByteSource} from '../../../core/source.js';
import {throwTjsError, TjsError, tjsMessage} from '../tjs2/runtime/errors.js';
import {
  TJS_BS_ACCESS_MASK,
  TJS_BS_READ,
  TJS_BS_WRITE,
  type TjsBinaryStream,
  type TvpStorageMedia,
} from '../tjs2/runtime/interface.js';
import {MemoryStream, SourceStream} from './streams.js';

/** `TVPArchiveDelimiter`. */
export const ARCHIVE_DELIMITER = '>';

/**
 * The installation as the `file` medium sees it. Local names are Windows paths
 * (`c:\game\data.xp3`) and compare case-insensitively.
 */
export interface KirikiriLocalFiles {
  exists(localName: string): boolean;
  /** Names of the files (not directories) directly inside a directory. */
  list(localDirectory: string): string[];
  open(localName: string): Promise<ByteSource>;
  /** Replaces a file's contents (`tTVPLocalFileStream` in write mode, on close). */
  write(localName: string, data: Uint8Array): void;
}

function lowerAscii(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** `tTVPFileMedia`: the `file` medium over the local file system. */
export class FileMedia implements TvpStorageMedia {
  constructor(private readonly files: KirikiriLocalFiles) {}
  addRef(): void {}
  release(): void {}
  getName(): string {
    return 'file';
  }
  normalizeDomainName(name: string): string {
    return lowerAscii(name);
  }
  normalizePathName(name: string): string {
    return lowerAscii(name);
  }
  #localName(name: string): string {
    const local = this.getLocallyAccessibleName(name);
    if (!local) throwTjsError('TVPCannotGetLocalName', name);
    return local;
  }
  checkExistentStorage(name: string): boolean {
    if (!name) return false;
    return this.files.exists(this.#localName(name));
  }
  open(name: string, flags: number): TjsBinaryStream | Promise<TjsBinaryStream> {
    if (!name) throwTjsError('TVPCannotOpenStorage', '""');
    const local = this.#localName(name);
    const access = flags & TJS_BS_ACCESS_MASK;
    if (access === TJS_BS_READ) {
      if (!this.files.exists(local)) throwTjsError('TVPCannotOpenStorage', name);
      return this.files.open(local).then((source) => new SourceStream(name, source));
    }
    return new LocalWriteStream(this.files, local);
  }
  getListAt(name: string, add: (file: string) => void): void {
    for (const file of this.files.list(this.#localName(name))) add(lowerAscii(file));
  }
  /** `./c/path` → `c:\path`; other domains are UNC names (`\\domain\path`). */
  getLocallyAccessibleName(name: string): string {
    let local: string;
    if (!name.startsWith('./')) local = '\\\\' + name;
    else {
      const rest = name.slice(2);
      const d = rest[0];
      if (!d || d < 'a' || d > 'z' || rest[1] !== '/') local = '';
      else local = d + ':' + rest.slice(1);
    }
    return local.replace(/\//g, '\\');
  }
}

/** A file opened for writing; its contents replace the file when it is closed. */
class LocalWriteStream extends MemoryStream {
  constructor(
    private readonly files: KirikiriLocalFiles,
    private readonly local: string,
  ) {
    super();
  }
  override destruct(): void {
    this.files.write(this.local, this.bytes.slice());
  }
}

interface MediaRecord {
  media: TvpStorageMedia;
  currentDomain: string;
  currentPath: string;
}

/** An XP3 archive opened by the core (`tTVPXP3Archive`), with names sorted as `ttstr <`. */
export class CoreArchive {
  readonly names: string[];
  readonly #byName = new Map<string, Xp3Entry>();

  constructor(
    readonly name: string,
    readonly archive: Xp3Archive,
  ) {
    for (const entry of archive.entries) {
      const n = normalizeInArchiveName(entry.name);
      if (!this.#byName.has(n)) this.#byName.set(n, entry);
    }
    this.names = [...this.#byName.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  isExistent(name: string): boolean {
    return name !== '' && this.#byName.has(name);
  }

  createStream(name: string): Promise<TjsBinaryStream> {
    const entry = this.#byName.get(name);
    if (!entry) throwTjsError('TVPStorageInArchiveNotFound', name, this.name);
    return this.archive.read(entry).then((bytes) => new MemoryStream(bytes));
  }

  /** `GetFirstIndexStartsWith`. */
  firstIndexStartsWith(prefix: string): number {
    let s = 0,
      e = this.names.length;
    while (e - s > 1) {
      const m = (e + s) >> 1;
      if (!(this.names[m]! < prefix)) e = m;
      else s = m;
    }
    if (s >= this.names.length) return -1;
    if (this.names[s]!.startsWith(prefix)) return s;
    s++;
    if (s >= this.names.length) return -1;
    if (this.names[s]!.startsWith(prefix)) return s;
    return -1;
  }
}

/** `tTVPArchive::NormalizeInArchiveStorageName`: lower case, `/`, no duplicate slashes. */
export function normalizeInArchiveName(name: string): string {
  if (!name) return name;
  let s = lowerAscii(name).replace(/\\/g, '/');
  const leading = s.startsWith('/');
  s = s.replace(/\/+/g, '/');
  if (leading) s = s.replace(/^\/+/, '');
  return s;
}

/** `TVPExtractStorageExt`: the extension with its dot, or the empty string. */
export function extractStorageExt(name: string): string {
  for (let p = name.length - 1; p >= 0; p--) {
    const c = name[p];
    if (c === '\\' || c === '/' || c === ARCHIVE_DELIMITER) break;
    if (c === '.') return name.slice(p);
  }
  return '';
}
/** `TVPExtractStorageName`: the name without its path. */
export function extractStorageName(name: string): string {
  let p = name.length - 1;
  for (; p >= 0; p--) {
    const c = name[p];
    if (c === '\\' || c === '/' || c === ARCHIVE_DELIMITER) break;
  }
  return name.slice(p + 1);
}
/** `TVPExtractStoragePath`: the path including its last delimiter. */
export function extractStoragePath(name: string): string {
  let p = name.length - 1;
  for (; p >= 0; p--) {
    const c = name[p];
    if (c === '\\' || c === '/' || c === ARCHIVE_DELIMITER) break;
  }
  return name.slice(0, p + 1);
}
/** `TVPChopStorageExt`. */
export function chopStorageExt(name: string): string {
  for (let p = name.length - 1; p >= 0; p--) {
    const c = name[p];
    if (c === '\\' || c === '/' || c === ARCHIVE_DELIMITER) break;
    if (c === '.') return name.slice(0, p);
  }
  return name;
}

/** `TVPPreNormalizeStorageName`: Windows `c:…` and UNC names to storage names. */
function preNormalize(name: string): string {
  if (name.length >= 2 && /^[A-Za-z]:/.test(name)) return 'file://./' + name[0] + name.slice(2);
  if (name.length >= 3 && (name.startsWith('\\\\') || name.startsWith('//'))) return 'file:' + name;
  return name;
}

export type StorageLog = (message: string) => void;

/** One core's storage state. */
export class StorageSystem {
  readonly #media = new Map<string, MediaRecord>();
  #currentMedia = 'file';
  readonly #archives = new Map<string, CoreArchive>();
  readonly #archiveLoads = new Map<string, Promise<CoreArchive>>();
  readonly #autoPathList: string[] = [];
  readonly #autoPathCache = new Map<string, string>();
  #autoPathTable: Map<string, string> | null = null;

  constructor(
    fileMedia: TvpStorageMedia,
    private readonly log: StorageLog,
    private readonly tickCount: () => number,
  ) {
    this.registerMedia(fileMedia);
  }

  // --- media ------------------------------------------------------------------------------

  registerMedia(media: TvpStorageMedia): void {
    const name = media.getName();
    if (this.#media.has(mediaKey(name)))
      throwTjsError('TVPMediaNameHadAlreadyBeenRegistered', name);
    media.addRef();
    this.#media.set(mediaKey(name), {media, currentDomain: '.', currentPath: '/'});
  }

  unregisterMedia(media: TvpStorageMedia): void {
    const name = media.getName();
    const rec = this.#media.get(mediaKey(name));
    if (!rec) throwTjsError('TVPMediaNameIsNotRegistered', name);
    this.#media.delete(mediaKey(name));
    rec.media.release();
  }

  #record(name: string): MediaRecord {
    const rec = this.#media.get(mediaKey(name));
    if (!rec) throwTjsError('TVPUnsupportedMediaName', extractMediaName(name));
    return rec;
  }

  // --- names --------------------------------------------------------------------------------

  /** `TVPNormalizeStorageName`: `media://domain/path[>member]`, with `.`/`..` resolved. */
  normalize(name: string): string {
    return this.#normalize(name).full;
  }

  #normalize(name: string): {full: string; media: string; domain: string; path: string} {
    if (!name) return {full: name, media: '', domain: '', path: ''};
    let tmp = preNormalize(name).replace(/\\/g, '/');
    let inArchive: string | null = null;
    const delim = tmp.indexOf(ARCHIVE_DELIMITER);
    if (delim >= 0) {
      inArchive = normalizeInArchiveName(tmp.slice(delim + 1));
      tmp = tmp.slice(0, delim);
    }
    if (!tmp) throwTjsError('TVPInvalidPathName', name);

    let media = '',
      domain = '',
      i = 0;
    while (i < tmp.length && /[A-Za-z]/.test(tmp[i]!)) i++;
    if (tmp[i] === ':') {
      media = tmp.slice(0, i);
      i++;
    } else i = 0;
    if (tmp[i] === '/') {
      if (tmp[i + 1] === '/') {
        if (tmp[i + 2] === '/') i += 2;
        else {
          i += 2;
          const pc = tmp.indexOf('/', i);
          if (pc < 0) throwTjsError('TVPInvalidPathName', name);
          domain = tmp.slice(i, pc);
          i = pc;
        }
      }
    }
    let path = tmp.slice(i);

    media = media ? lowerAscii(media) : this.#currentMedia;
    const rec = this.#record(media);
    if (!domain) domain = rec.currentDomain;
    domain = rec.media.normalizeDomainName(domain);
    if (!path) path = '/';
    else if (path[0] !== '/') path = rec.currentPath + path;
    path = rec.media.normalizePathName(path);
    if (inArchive !== null) path += ARCHIVE_DELIMITER + inArchive;
    path = compressPath(path, name);
    return {full: media + '://' + domain + path, media, domain, path};
  }

  /** `TVPSetCurrentDirectory`: the name must end with a delimiter. */
  setCurrentDirectory(name: string): void {
    const ch = name[name.length - 1];
    if (ch !== '/' && ch !== '\\' && ch !== ARCHIVE_DELIMITER)
      throwTjsError('TVPMissingPathDelimiterAtLast');
    const n = this.#normalize(name);
    const rec = this.#record(n.media);
    rec.currentDomain = n.domain;
    rec.currentPath = n.path;
    this.#currentMedia = n.media;
    this.clearStorageCaches();
  }

  /** `TVPGetLocallyAccessibleName`: empty for archive members and non-local media. */
  getLocallyAccessibleName(name: string): string {
    if (name.includes(ARCHIVE_DELIMITER)) return '';
    const rec = this.#record(name);
    return rec.media.getLocallyAccessibleName(domainAndPath(name));
  }

  /** `TVPGetLocalName`. */
  getLocalName(name: string): string {
    const local = this.getLocallyAccessibleName(name);
    if (!local) throwTjsError('TVPCannotGetLocalName', name);
    return local;
  }

  // --- archives -----------------------------------------------------------------------------

  /** Opens an XP3 archive of the core and keeps its index (the archive cache). */
  async openArchive(name: string): Promise<CoreArchive> {
    const normalized = this.normalize(name);
    const cached = this.#archives.get(normalized);
    if (cached) return cached;
    let pending = this.#archiveLoads.get(normalized);
    if (!pending) {
      pending = (async () => {
        if (!this.isExistentStorageNoSearch(normalized))
          throwTjsError('TVPCannotFindStorage', normalized);
        const stream = await this.#mediaOpen(normalized, TJS_BS_READ);
        const archive = new CoreArchive(normalized, await Xp3Archive.open(streamSource(stream)));
        this.#archives.set(normalized, archive);
        return archive;
      })().finally(() => this.#archiveLoads.delete(normalized));
      this.#archiveLoads.set(normalized, pending);
    }
    return pending;
  }

  /** The cached archive; archives must be opened before synchronous use. */
  #archive(name: string): CoreArchive {
    const normalized = this.normalize(name);
    const archive = this.#archives.get(normalized);
    if (archive) return archive;
    if (!this.isExistentStorageNoSearch(normalized))
      throwTjsError('TVPCannotFindStorage', normalized);
    throw new TjsError(`Archive ${normalized} is not loaded`);
  }

  clearArchiveCache(): void {
    this.#archives.clear();
  }

  // --- existence and search ---------------------------------------------------------------

  #isExistentNoSearchNoNormalize(name: string): boolean {
    const sharp = name.indexOf(ARCHIVE_DELIMITER);
    if (sharp >= 0) {
      const arc = this.#archive(name.slice(0, sharp));
      return arc.isExistent(normalizeInArchiveName(name.slice(sharp + 1)));
    }
    const rec = this.#record(name);
    return rec.media.checkExistentStorage(domainAndPath(name));
  }

  /** `TVPIsExistentStorageNoSearch`. */
  isExistentStorageNoSearch(name: string): boolean {
    return this.#isExistentNoSearchNoNormalize(this.normalize(name));
  }

  /** `TVPAddAutoPath`. */
  addAutoPath(name: string): void {
    checkDelimiterAtLast(name);
    const normalized = this.normalize(name);
    if (!this.#autoPathList.includes(normalized)) this.#autoPathList.push(normalized);
    this.#clearAutoPathCache();
  }

  /** `TVPRemoveAutoPath`. */
  removeAutoPath(name: string): void {
    checkDelimiterAtLast(name);
    const normalized = this.normalize(name);
    const i = this.#autoPathList.indexOf(normalized);
    if (i >= 0) this.#autoPathList.splice(i, 1);
    this.#clearAutoPathCache();
  }

  #clearAutoPathCache(): void {
    this.#autoPathCache.clear();
    this.#autoPathTable = null;
  }

  /** `TVPRebuildAutoPathTable`: storage name → the auto path it is found in (last wins). */
  #rebuildAutoPathTable(): Map<string, string> {
    if (this.#autoPathTable) return this.#autoPathTable;
    const table = new Map<string, string>();
    const tick = this.tickCount();
    this.log(tjsMessage('TVPInfoRebuildingAutoPath'));
    let total = 0;
    for (const path of this.#autoPathList) {
      const sharp = path.indexOf(ARCHIVE_DELIMITER);
      if (sharp >= 0) {
        const arc = this.#archive(path.slice(0, sharp));
        const prefix = normalizeInArchiveName(path.slice(sharp + 1));
        let i = arc.firstIndexStartsWith(prefix);
        if (i !== -1) {
          for (; i < arc.names.length; i++) {
            const n = arc.names[i]!;
            if (!n.startsWith(prefix)) break;
            if (!n.slice(prefix.length).includes('/')) {
              table.set(extractStorageName(n), path);
              total++;
            }
          }
        }
      } else {
        const rec = this.#record(path);
        rec.media.getListAt(domainAndPath(path), (file) => {
          table.set(file, path);
          total++;
        });
      }
    }
    const end = this.tickCount();
    this.log(
      `(info) Total ${total} file(s) found, ${table.size} file(s) activated. (${end - tick}ms)`,
    );
    this.#autoPathTable = table;
    return table;
  }

  /** `TVPGetPlacedPath`: where a storage is, searching the auto paths; empty if nowhere. */
  getPlacedPath(name: string): string {
    const cached = this.#autoPathCache.get(name);
    if (cached !== undefined) return cached;
    const normalized = this.normalize(name);
    if (this.#isExistentNoSearchNoNormalize(normalized)) {
      this.#autoPathCache.set(name, normalized);
      return normalized;
    }
    const storageName = extractStorageName(normalized);
    const found = this.#rebuildAutoPathTable().get(storageName);
    const result = found !== undefined ? found + storageName : '';
    this.#autoPathCache.set(name, result);
    return result;
  }

  /** `TVPSearchPlacedPath`. */
  searchPlacedPath(name: string): string {
    const place = this.getPlacedPath(name);
    if (!place) throwTjsError('TVPCannotFindStorage', name);
    return place;
  }

  /** `TVPIsExistentStorage`. */
  isExistentStorage(name: string): boolean {
    return this.getPlacedPath(name) !== '';
  }

  // --- streams ----------------------------------------------------------------------------

  #mediaOpen(name: string, flags: number): TjsBinaryStream | Promise<TjsBinaryStream> {
    const rec = this.#record(name);
    return rec.media.open(domainAndPath(name), flags);
  }

  /** `TVPCreateStream`: read access searches the auto paths; archives are read-only. */
  createStream(name: string, flags: number): TjsBinaryStream | Promise<TjsBinaryStream> {
    try {
      return this.#createStream(name, flags);
    } catch (e) {
      if (e instanceof TjsError && name.includes('#'))
        e.message += '[' + tjsMessage('TVPFilenameContainsSharpWarn', name) + ']';
      throw e;
    }
  }

  #createStream(name: string, flags: number): TjsBinaryStream | Promise<TjsBinaryStream> {
    // Natively the archive cache opens an archive on first use; here its index loads first.
    const normalized = this.normalize(name);
    const sharpAt = normalized.indexOf(ARCHIVE_DELIMITER);
    if (sharpAt >= 0) {
      const arcName = normalized.slice(0, sharpAt);
      if (!this.#archives.has(arcName))
        return this.openArchive(arcName).then(() => this.#createStream(name, flags));
    }
    const access = flags & TJS_BS_ACCESS_MASK;
    const placed = access === TJS_BS_WRITE ? this.normalize(name) : this.getPlacedPath(name);
    if (!placed) throwTjsError('TVPCannotOpenStorage', name);
    try {
      const sharp = placed.indexOf(ARCHIVE_DELIMITER);
      if (sharp >= 0) {
        if (access !== TJS_BS_READ) throwTjsError('TVPCannotWriteToArchive');
        const member = normalizeInArchiveName(placed.slice(sharp + 1));
        const arcName = placed.slice(0, sharp);
        const cached = this.#archives.get(this.normalize(arcName));
        if (cached) return cached.createStream(member);
        return this.openArchive(arcName).then((arc) => arc.createStream(member));
      }
      return this.#mediaOpen(placed, flags);
    } finally {
      if (access >= 1) this.clearStorageCaches();
    }
  }

  /** `TVPClearStorageCaches`: the auto path tables (the XP3 segment cache has no state here). */
  clearStorageCaches(): void {
    this.#clearAutoPathCache();
  }
}

/** A byte source over a core stream, for format readers that read ranges asynchronously. */
export function streamSource(stream: TjsBinaryStream): ByteSource {
  return {
    size: stream.getSize(),
    async read(offset: number, length: number): Promise<Uint8Array> {
      await stream.prefetch(offset, length);
      stream.seek(offset, 0);
      return stream.read(length);
    },
  };
}

/** Media names compare up to the colon (`tMediaNameString`). */
function mediaKey(name: string): string {
  const colon = name.indexOf(':');
  return colon >= 0 ? name.slice(0, colon) : name;
}

/** `ExtractMediaName`. */
function extractMediaName(name: string): string {
  return mediaKey(name);
}

/** The domain-and-path part of a normalized name (after `media://`). */
function domainAndPath(name: string): string {
  return name.slice(mediaKey(name).length + 3);
}

function checkDelimiterAtLast(name: string): void {
  const last = name[name.length - 1];
  if (last !== ARCHIVE_DELIMITER && last !== '/' && last !== '\\')
    throwTjsError('TVPMissingPathDelimiterAtLast');
}

/**
 * The redundant-access compression of `NormalizeStorageName`: duplicate slashes are dropped
 * and a segment of n dots climbs n − 1 levels (`..` one, `...` two); climbing out of an
 * archive or above the root is an invalid name.
 */
function compressPath(path: string, original: string): string {
  const out: string[] = [];
  let dotCount = -1;
  for (let pa = 0; ; pa++) {
    const ch = pa < path.length ? path[pa]! : '\0';
    if (ch === ARCHIVE_DELIMITER || ch === '/' || ch === '\0') {
      let delim = '';
      if (ch !== '\0' && dotCount === 0) {
        out.pop(); // duplicated slash
      } else if (dotCount > 0) {
        let pb = out.length - 1;
        for (; pb >= 0; pb--) {
          const c = out[pb];
          if (c === '/' || c === ARCHIVE_DELIMITER) {
            dotCount--;
            if (dotCount === 0) {
              delim = c;
              break;
            }
            if (c === ARCHIVE_DELIMITER) throwTjsError('TVPInvalidPathName', original);
          }
        }
        if (pb < 0) throwTjsError('TVPInvalidPathName', original);
        out.length = pb;
      }
      if (ch === '\0') {
        if (delim) out.push(delim);
        break;
      }
      out.push(delim || ch);
      dotCount = 0;
    } else if (ch === '.') {
      out.push(ch);
      if (dotCount !== -1) dotCount++;
    } else {
      out.push(ch);
      dotCount = -1;
    }
  }
  return out.join('');
}

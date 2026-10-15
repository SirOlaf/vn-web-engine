/**
 * `nekopara_vol1.tpm` (internal name `cxdec.tpm.dll`, SHA-256 `26903726…`): the CxDec
 * storage plugin. It registers the storage medium `archive` (`CxFilterFS`), makes
 * `archive://data.xp3/` the current directory and hooks `Storages.addAutoPath` /
 * `removeAutoPath` so that `<app path>name.xp3>` paths go through the medium.
 *
 * The medium reads an archive's index itself (`XP3IndexParser`): `eliF` chunks give the
 * readable names, whose lower-case MD5 names the `File` entries. Opening a member opens the
 * core stream `<app path>name.xp3><md5 name>` and XORs it with a key from the member's
 * Adler-32 (`TinyFilterCore`).
 *
 * Archives are indexed when first needed, as natively. Where the native plugin indexes
 * synchronously, this one needs the index loaded first: `V2Link` indexes `data.xp3`, the
 * auto-path hook indexes the archive it adds, and `open` indexes on demand; existence checks and
 * listings of an archive that is not indexed yet are errors.
 *
 * The TJS2 helpers (`NativeFunction`, variants) are the counterpart of `tp_stub`.
 */
import {Xp3Archive, type Xp3Entry} from '../../formats/kirikiri/xp3.js';
import {
  applyCxTinyFilter,
  CX_TINY_FILTERS,
  CxArchive,
  type CxTinyFilter,
} from '../../formats/kirikiri/cx-archive.js';
import type {ByteSource} from '../../core/source.js';
import type {NativeLibraryImplementation} from '../../platform/native-libraries.js';
import {
  TJS_BS_READ,
  TJS_BS_SEEK_CUR,
  TJS_BS_SEEK_END,
  TJS_BS_SEEK_SET,
  TJS_E_BADPARAMCOUNT,
  TJS_MEMBERENSURE,
  TJS_S_OK,
  TVP_PLUGIN,
  type Dispatch,
  type TjsBinaryStream,
  type TvpFunctionExporter,
  type TvpPluginExports,
  type TvpStorageMedia,
} from '../tvp-plugin/contract.js';
import {NativeFunction} from '../../engines/kirikiri/tjs2/runtime/native.js';
import {VariantSlot} from '../../engines/kirikiri/tjs2/runtime/slot.js';
import {asString, obj} from '../../engines/kirikiri/tjs2/runtime/variant.js';

const SHA256 = '26903726725a45bab530d153e8f06f0607268783c89b3bf3ad300a960259a792';
const MEDIA_NAME = 'archive';

function lowerAscii(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** A member's decrypted bytes. */
class MemberStream implements TjsBinaryStream {
  #position = 0;
  constructor(private readonly bytes: Uint8Array) {}
  seek(offset: number, whence: number): number {
    const base =
      whence === TJS_BS_SEEK_SET
        ? 0
        : whence === TJS_BS_SEEK_CUR
          ? this.#position
          : whence === TJS_BS_SEEK_END
            ? this.bytes.length
            : this.#position;
    this.#position = Math.max(0, base + offset);
    return this.#position;
  }
  read(length: number): Uint8Array {
    const start = Math.min(this.#position, this.bytes.length);
    const end = Math.min(start + length, this.bytes.length);
    this.#position = end;
    return this.bytes.slice(start, end);
  }
  prefetch(): void {}
  write(): number {
    return 0;
  }
  setEndOfStorage(): void {}
  getSize(): number {
    return this.bytes.length;
  }
  destruct(): void {}
}

/** Reads a core stream as a byte source (the plugin's own index parser reads ranges). */
function streamSource(stream: TjsBinaryStream): ByteSource {
  return {
    size: stream.getSize(),
    async read(offset: number, length: number): Promise<Uint8Array> {
      await stream.prefetch(offset, length);
      stream.seek(offset, TJS_BS_SEEK_SET);
      return stream.read(length);
    },
  };
}

interface IndexedArchive {
  readonly cx: CxArchive;
  /** Lower-case member path → entry. */
  readonly members: Map<string, Xp3Entry>;
  /** Lower-case directory (`""` for the root, `dir/` otherwise) → lower-case file names. */
  readonly directories: Map<string, string[]>;
}

/** `CxFilterFS`. Names are the domain-and-path part: `data.xp3/system/initialize.tjs`. */
class CxFilterFS implements TvpStorageMedia {
  readonly #archives = new Map<string, IndexedArchive>();
  readonly #loading = new Map<string, Promise<IndexedArchive>>();
  #refs = 1;

  constructor(
    private readonly exporter: TvpFunctionExporter,
    private readonly filter: CxTinyFilter,
  ) {}

  addRef(): void {
    this.#refs++;
  }
  release(): void {
    this.#refs--;
  }
  getName(): string {
    return MEDIA_NAME;
  }
  normalizeDomainName(name: string): string {
    return lowerAscii(name);
  }
  /**
   * `CxFilterFS__NormalizePathName` (0x100059c0): lower case, `/` for `\`, leading slashes
   * dropped and runs collapsed (`FUN_10009b10`), then one leading `/` again.
   */
  normalizePathName(name: string): string {
    if (!name) return name;
    const n = lowerAscii(name).replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/');
    return n ? '/' + n : name;
  }

  #split(name: string): {archive: string; path: string} | null {
    const slash = name.indexOf('/');
    if (slash < 0) return null;
    return {archive: name.slice(0, slash), path: name.slice(slash + 1)};
  }

  /** Indexes an archive beside the executable (`FUN_100089d0`). */
  index(archive: string): IndexedArchive | Promise<IndexedArchive> {
    const key = lowerAscii(archive);
    const done = this.#archives.get(key);
    if (done) return done;
    let pending = this.#loading.get(key);
    if (!pending) {
      pending = (async () => {
        const stream = await this.exporter.TVPCreateStream(
          this.exporter.TVPGetAppPath() + archive,
          TJS_BS_READ,
        );
        let xp3: Xp3Archive;
        try {
          xp3 = await Xp3Archive.open(streamSource(stream));
        } catch (e) {
          this.exporter.TVPAddImportantLog(`${archive}: XP3ArchiveIndex.open: invalid index`);
          throw e;
        } finally {
          stream.destruct();
        }
        const cx = new CxArchive(xp3, this.filter);
        const members = new Map<string, Xp3Entry>();
        const directories = new Map<string, string[]>();
        for (const record of cx.names) {
          const path = lowerAscii(record.name);
          const entry = cx.find(record.name);
          if (!entry || members.has(path)) continue;
          members.set(path, entry);
          const slash = path.lastIndexOf('/');
          const dir = path.slice(0, slash + 1);
          let list = directories.get(dir);
          if (!list) directories.set(dir, (list = []));
          list.push(path.slice(slash + 1));
        }
        const indexed = {cx, members, directories};
        this.#archives.set(key, indexed);
        return indexed;
      })().finally(() => this.#loading.delete(key));
      this.#loading.set(key, pending);
    }
    return pending;
  }

  #indexed(archive: string): IndexedArchive {
    const a = this.#archives.get(lowerAscii(archive));
    if (!a) throw new Error(`${MEDIA_NAME}://${archive}/ is not indexed yet`);
    return a;
  }

  checkExistentStorage(name: string): boolean {
    const s = this.#split(name);
    if (!s) return false;
    return this.#indexed(s.archive).members.has(s.path);
  }

  open(name: string, _flags: number): TjsBinaryStream | Promise<TjsBinaryStream> {
    const s = this.#split(name);
    if (!s) throw new Error(`${MEDIA_NAME}://${name}: no archive`);
    const read = async (a: IndexedArchive) => {
      const entry = a.members.get(s.path);
      if (!entry) throw new Error(`${MEDIA_NAME}://${name}: not found`);
      const stream = await this.exporter.TVPCreateStream(
        this.exporter.TVPGetAppPath() + s.archive + '>' + entry.name,
        TJS_BS_READ,
      );
      await stream.prefetch(0, stream.getSize());
      stream.seek(0, TJS_BS_SEEK_SET);
      const bytes = stream.read(stream.getSize());
      stream.destruct();
      applyCxTinyFilter(this.filter, entry.adler32 ?? 0, bytes);
      return new MemberStream(bytes);
    };
    const a = this.index(s.archive);
    return a instanceof Promise ? a.then(read) : read(a);
  }

  getListAt(name: string, add: (file: string) => void): void {
    const s = this.#split(name);
    if (!s) return;
    for (const file of this.#indexed(s.archive).directories.get(s.path) ?? []) add(file);
  }

  getLocallyAccessibleName(): string {
    return '';
  }
}

/**
 * The auto-path hooks' rewrite (`FUN_10002540`): `<app path>name.xp3>rest` becomes
 * `archive://name.xp3/rest`; other paths are unchanged. Returns the archive to index.
 */
function rewriteAutoPath(
  exporter: TvpFunctionExporter,
  path: string,
): {path: string; archive: string | null} {
  const gt = path.lastIndexOf('>');
  if (gt < 0) return {path, archive: null};
  const archivePath = path.slice(0, gt);
  if (
    lowerAscii(exporter.TVPExtractStoragePath(archivePath)) !== lowerAscii(exporter.TVPGetAppPath())
  )
    return {path, archive: null};
  const archive = exporter.TVPExtractStorageName(archivePath);
  return {path: `${MEDIA_NAME}://${archive}/${path.slice(gt + 1)}`, archive};
}

class CxPlugin implements TvpPluginExports {
  #media: CxFilterFS | null = null;
  #exporter: TvpFunctionExporter | null = null;

  constructor(private readonly filter: CxTinyFilter) {}

  /** `V2Link` → `CxPluginLink` (0x10009290) → `CxFilterFS__Init` (0x10008f10). */
  v2Link(exporter: TvpFunctionExporter): number | Promise<number> {
    this.#exporter = exporter;
    // TVPMIDIOutData is absent on Kirikiri Z; the plugin uses it to tell the cores apart.
    exporter.has('void ::TVPMIDIOutData(const tjs_uint8 *,int)');
    exporter.TVPSetCommandLine('-debugwin', '');
    const media = (this.#media = new CxFilterFS(exporter, this.filter));
    exporter.TVPRegisterStorageMedia(media);
    exporter.TVPClearStorageCaches();
    exporter.TVPSetCurrentDirectory(`${MEDIA_NAME}://data.xp3/`);
    this.#hookStorages(exporter);
    const indexed = media.index('data.xp3');
    return indexed instanceof Promise ? indexed.then(() => 0) : 0;
  }

  #hookStorages(exporter: TvpFunctionExporter): void {
    const global = exporter.TVPGetScriptDispatch();
    const storages = new VariantSlot();
    try {
      if (global.propGet(0, 'Storages', storages, global) < 0) return;
      const target = storages.value;
      if (target.type !== 1 || !target.object) return;
      const hook = (add: boolean) =>
        new NativeFunction((result, args) => {
          if (args.length < 1) return TJS_E_BADPARAMCOUNT;
          const {path, archive} = rewriteAutoPath(exporter, asString(args[0]!));
          const finish = () => {
            if (add) exporter.TVPAddAutoPath(path);
            else exporter.TVPRemoveAutoPath(path);
            result?.clear();
            return TJS_S_OK;
          };
          const indexed = add && archive ? this.#media!.index(archive) : null;
          return indexed instanceof Promise ? exporter.suspend(indexed, finish) : finish();
        });
      for (const [name, add] of [
        ['addAutoPath', true],
        ['removeAutoPath', false],
      ] as const) {
        const fn: Dispatch = hook(add);
        target.object.propSet(TJS_MEMBERENSURE, name, obj(fn), target.object);
        fn.release();
      }
    } finally {
      storages.clear();
      global.release();
    }
  }

  v2Unlink(): number {
    if (this.#media && this.#exporter) this.#exporter.TVPUnregisterStorageMedia(this.#media);
    this.#media = null;
    return 0;
  }
}

export const NEKOPARA_VOL1_TPM: NativeLibraryImplementation<TvpPluginExports> = {
  contract: TVP_PLUGIN,
  identities: [{kind: 'image', sha256: SHA256}],
  imports: [],
  link() {
    const filter = CX_TINY_FILTERS.get(SHA256)!;
    return {exports: new CxPlugin(filter)};
  },
};

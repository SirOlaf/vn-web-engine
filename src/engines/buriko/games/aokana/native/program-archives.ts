import type {AokanaBpPointer} from '../bp/memory.js';
import {FileError} from '../../../../../platform/filesystem.js';
import {signature} from '../../../../../formats/buriko/binary.js';
import {AokanaProgramFiles, terminatedNativeBytes} from './program-files.js';
import {
  AokanaUndefinedResourceRead,
  decodeAokanaResource,
  type AokanaResourceDestination,
} from './resource-decode.js';
import {textBytes, textLength, writeText} from './text.js';
import type {AokanaEngineErrors} from './engine-errors.js';
import type {AokanaDistributedProcessing} from './distributed-processing.js';

interface ArchiveBase {
  initialized: boolean;
  path: Uint8Array;
  next: ArchiveNode | null;
}
interface OrdinaryArchive extends ArchiveBase {
  kind: 'ordinary';
  count: number;
  payloadBase: number;
  index: Uint8Array;
}
interface ComplexArchive extends ArchiveBase {
  kind: 'complex';
  components: Uint8Array[];
  cache: OrdinaryArchive;
}
type ArchiveNode = OrdinaryArchive | ComplexArchive;
interface ArchiveMatch {
  archive: ArchiveNode;
  prefix: Uint8Array | null;
}
function node(): OrdinaryArchive {
  return {
    kind: 'ordinary',
    initialized: false,
    path: Uint8Array.of(0),
    count: 0,
    payloadBase: 0,
    index: new Uint8Array(),
    next: null,
  };
}
function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export interface AokanaArchiveResource {
  /** Actual byte count on success; native 0x800000xx on failure. */
  readonly result: number;
  readonly bytes: Uint8Array | null;
  readonly initialized?: Uint8Array;
}

/** Native linked CArchive cache. Raw mutable 128-byte records preserve name conversion writes. */
export class AokanaProgramArchives {
  private root = node();
  private pending: Promise<void> = Promise.resolve();
  constructor(
    readonly files: AokanaProgramFiles,
    readonly errors: AokanaEngineErrors,
    readonly mainProcessing: AokanaDistributedProcessing,
  ) {}

  clear(): void {
    this.root = node();
  }

  private normalize(bytes: Uint8Array, capacity: number | null = 784): Uint8Array {
    const result = this.files.text.convertEncoding(
      {bytes: terminatedNativeBytes(bytes), offset: 0},
      1,
    );
    if (capacity !== null && result.length > capacity)
      throw new RangeError('Aokana archive path exceeds native scratch storage');
    this.files.text.lowercase({bytes: result, offset: 0});
    return result;
  }

  private async openIndex(target: OrdinaryArchive, path: Uint8Array): Promise<boolean> {
    const opened = await this.files.open(path);
    if (opened.source === null) return false;
    const header = await this.files.read(opened.source, 0, 16);
    if (header.length !== 16) return false;
    const packed = signature(header, 'PackFile    ');
    if (!packed && !signature(header, 'BURIKO ARC20')) return false;
    // Native stores this before allocating/reading its index.
    target.path = path.slice();
    target.count = new DataView(header.buffer, header.byteOffset, 16).getUint32(12, true);
    const recordSize = packed ? 32 : 128;
    const storedSize = Math.imul(target.count, recordSize) >>> 0;
    target.payloadBase = (storedSize + 16) >>> 0;
    target.index = new Uint8Array(target.count * 128);
    const stored = await this.files.read(opened.source, 16, storedSize);
    if (stored.length !== target.count * recordSize) {
      throw new AokanaUndefinedResourceRead(
        'Aokana archive index includes unwritten allocation bytes',
      );
    }
    if (!packed) target.index.set(stored);
    const source = new DataView(stored.buffer, stored.byteOffset, stored.byteLength);
    const records = new DataView(target.index.buffer);
    for (let index = 0; index < target.count; index++) {
      const offset = index * 128;
      const destination = {bytes: target.index, offset};
      if (packed) {
        // Each destination record is cleared immediately before converting that record.
        target.index.fill(0, offset, offset + 128);
        writeText(
          destination,
          this.files.text.convertEncoding({bytes: stored, offset: index * 32}, 1),
        );
        this.files.text.lowercase(destination);
        records.setUint32(offset + 96, source.getUint32(index * 32 + 16, true), true);
        records.setUint32(offset + 100, source.getUint32(index * 32 + 20, true), true);
      } else {
        if (this.files.text.detectEncoding(target.index, offset) === 0) {
          const original = textBytes(destination, true).slice();
          if (original.length > 96)
            throw new RangeError('Aokana ARC20 name overflows native conversion scratch');
          writeText(destination, this.files.text.convertEncoding({bytes: original, offset: 0}, 1));
        }
        this.files.text.lowercase(destination);
      }
    }
    target.initialized = true;
    return true;
  }

  private async archive(
    pathBytes: Uint8Array,
    root: ArchiveNode = this.root,
    context = true,
  ): Promise<ArchiveMatch | null> {
    return this.serialized(() => this.findOrOpenArchive(pathBytes, root, context));
  }

  /** BB110/039460 append a real virtual cache node, rejecting any identical stored path. */
  async registerComplex(
    logical: AokanaBpPointer | null,
    components: readonly (AokanaBpPointer | null)[],
  ): Promise<0 | 1> {
    return this.serialized(async () => {
      if (logical === null) return 0;
      const path = this.normalize(textBytes(logical, true));
      if (path.length > 780)
        throw new RangeError('Aokana complex logical name exceeds its native path field');
      if (components.length === 0 || components[0] === null) return 0;
      const names: Uint8Array[] = [];
      for (const pointer of components) {
        if (pointer === null) break;
        const original = textBytes(pointer, true),
          converted = this.normalize(original, null);
        if (converted.length > original.length)
          throw new RangeError(
            'Aokana complex component exceeds its native original-byte allocation',
          );
        names.push(converted);
      }
      const complex: ComplexArchive = {
        kind: 'complex',
        initialized: true,
        path,
        components: names,
        cache: node(),
        next: null,
      };
      let current: ArchiveNode = this.root;
      for (;;) {
        if (equal(current.path, path)) return 0;
        if (current.next === null) {
          current.next = complex;
          return 1;
        }
        current = current.next;
      }
    });
  }

  /** F84F0 operates on encoded characters: CP932 trail byte5C is not a separator. */
  private lastSlash(bytes: Uint8Array): number {
    const mode = this.files.text.detectEncoding(bytes);
    let slash = -1;
    for (let offset = 0; bytes[offset] !== 0;) {
      const character = this.files.text.readCharacter(bytes, offset, mode);
      if (character.value === 92) slash = offset;
      offset += character.length;
    }
    return slash;
  }

  private next(current: ArchiveNode): ArchiveNode | null {
    // 039390 returns an existing successor even when this node is unopened/released.
    return current.next ?? (current.initialized ? (current.next = node()) : null);
  }

  private async match(
    current: ArchiveNode,
    pathBytes: Uint8Array,
    context: boolean,
  ): Promise<ArchiveMatch | null> {
    if (current.kind === 'ordinary') {
      const path = this.normalize(pathBytes),
        same = equal(current.path, path);
      if (
        current.initialized
          ? same
          : (same || current.path.length === 1) && (await this.openIndex(current, path))
      )
        return {archive: current, prefix: null};
      return null;
    }
    const original = terminatedNativeBytes(pathBytes),
      slash = this.lastSlash(original);
    if (slash < 0 || !equal(current.path, this.normalize(original.subarray(slash + 1))))
      return null;
    let prefix: Uint8Array | null = null;
    if (context) {
      prefix = this.normalize(original, null);
      if (prefix.length > original.length)
        throw new RangeError('Aokana complex prefix exceeds its native original-byte allocation');
      // 08ADA0 converts the full input before replacing its last backslash with NUL.
      prefix = prefix.slice(0, this.lastSlash(prefix) + 1);
      prefix[prefix.length - 1] = 0;
    }
    return {archive: current, prefix};
  }

  /** BD370 converts to UTF8 and inserts exactly one backslash, without path qualification. */
  private componentPath(prefix: Uint8Array, component: Uint8Array): Uint8Array {
    const path = new Uint8Array(prefix.length + component.length);
    if (path.length > 784)
      throw new RangeError('Aokana complex component path exceeds native scratch storage');
    path.set(prefix.subarray(0, -1));
    path[prefix.length - 1] = 92;
    path.set(component, prefix.length);
    return path;
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.pending;
    let release!: () => void;
    this.pending = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async findOrOpenArchive(
    pathBytes: Uint8Array,
    root: ArchiveNode,
    context: boolean,
  ): Promise<ArchiveMatch | null> {
    for (let current: ArchiveNode | null = root; current !== null; current = this.next(current)) {
      const found = await this.match(current, pathBytes, context);
      if (found !== null) return found;
    }
    return null;
  }

  /** 039A70 calls the successor's virtual release, not its generic match operation. */
  async release(path: Uint8Array): Promise<0 | 0x80000010> {
    return this.serialized(() => this.releaseFrom(this.root, path));
  }

  private async releaseFrom(current: ArchiveNode, path: Uint8Array): Promise<0 | 0x80000010> {
    if (current.kind === 'complex') {
      const original = terminatedNativeBytes(path),
        slash = this.lastSlash(original);
      if (slash < 0) return 0x80000010;
      const basename = this.normalize(original.subarray(slash + 1));
      for (const component of current.components) {
        if (equal(component, basename) && (await this.releaseFrom(current.cache, path)) === 0)
          return 0;
      }
    } else if ((await this.match(current, path, false)) !== null) {
      current.initialized = false;
      current.index = new Uint8Array();
      return 0;
    }
    const next = this.next(current);
    return next === null ? 0x80000010 : this.releaseFrom(next, path);
  }

  private find(archive: OrdinaryArchive, name: Uint8Array): number | null {
    const query = this.normalize(name);
    for (let index = 0; index < archive.count; index++) {
      const offset = index * 128;
      if (equal(textBytes({bytes: archive.index, offset}, true), query)) return offset;
    }
    return null;
  }

  /** 0399B0 clones the matching cache node's 128-byte index before exposing its names. */
  async enumerateNames(path: Uint8Array): Promise<Uint8Array[] | null> {
    const matched = await this.archive(path, this.root, false);
    if (matched === null) return null;
    const archive = matched.archive;
    // 0399B0 bypasses complex virtuals and reads the never-written inherited count+318.
    if (archive.kind === 'complex')
      throw new AokanaUndefinedResourceRead(
        'Aokana complex index enumeration reads an unwritten inherited count',
      );
    const names: Uint8Array[] = [];
    for (let index = 0; index < archive.count; index++)
      names.push(textBytes({bytes: archive.index, offset: index * 128}, true).slice());
    return names;
  }

  async size(path: Uint8Array, name: Uint8Array): Promise<number> {
    return this.sizeFrom(this.root, path, name);
  }

  private async sizeFrom(root: ArchiveNode, path: Uint8Array, name: Uint8Array): Promise<number> {
    const matched = await this.archive(path, root);
    if (matched === null) return 0x80000010;
    const archive = matched.archive;
    if (archive.kind === 'complex') {
      let result = 0x80000000;
      for (const component of archive.components) {
        result = await this.sizeFrom(
          archive.cache,
          this.componentPath(matched.prefix!, component),
          name,
        );
        if (result <= 0x7fffffff) break;
      }
      return result;
    }
    const record = this.find(archive, name);
    return record === null
      ? 0x80000020
      : new DataView(archive.index.buffer).getUint32(record + 100, true);
  }

  /** +18/+20/+28/+40 all stop at the first actual member, including zero metadata/size. */
  private async entry(
    root: ArchiveNode,
    path: Uint8Array,
    name: Uint8Array,
  ): Promise<{
    archive: OrdinaryArchive;
    record: number;
  } | null> {
    const matched = await this.archive(path, root);
    if (matched === null) return null;
    const archive = matched.archive;
    if (archive.kind === 'complex') {
      for (const component of archive.components) {
        const found = await this.entry(
          archive.cache,
          this.componentPath(matched.prefix!, component),
          name,
        );
        if (found !== null) return found;
      }
      return null;
    }
    const record = this.find(archive, name);
    return record === null ? null : {archive, record};
  }

  /** BB350 tests record identity directly, so a present zero-byte entry remains available. */
  async contains(path: Uint8Array, name: Uint8Array): Promise<boolean> {
    if (textLength({bytes: terminatedNativeBytes(name), offset: 0}) >= 96) {
      return this.errors.fatal(
        this.files.text.encodeWide(
          `指定されたファイル名 [ ${this.files.path(name)} ] は95文字を超えています`,
          1,
        ),
      );
    }
    return (await this.entry(this.root, path, name)) !== null;
  }

  /** Native metadata query 038a00 returns the first matching entry's untouched qword at +104. */
  async metadata(path: Uint8Array, name: Uint8Array): Promise<bigint | null> {
    const found = await this.entry(this.root, path, name);
    return found === null
      ? null
      : new DataView(found.archive.index.buffer).getBigUint64(found.record + 104, true);
  }

  /** 0398A0/+18 copies the actual first matching 128-byte entry, without decoding its payload. */
  async copyEntry(path: Uint8Array, name: Uint8Array): Promise<Uint8Array | null> {
    const found = await this.entry(this.root, path, name);
    return found === null ? null : found.archive.index.slice(found.record, found.record + 128);
  }

  /** 039780/+28 repeats member selection and returns the physical component's path. */
  async entryPath(path: Uint8Array, name: Uint8Array): Promise<Uint8Array | null> {
    const matched = await this.archive(path);
    if (matched === null) return null;
    const archive = matched.archive;
    if (archive.kind === 'ordinary')
      return this.find(archive, name) === null ? null : archive.path.slice();
    for (const component of archive.components) {
      const physical = this.componentPath(matched.prefix!, component);
      if (await this.entry(archive.cache, physical, name)) return physical;
    }
    return null;
  }

  /** 039920/+10 selects by archive identity, independently of a member lookup. */
  async payloadBase(path: Uint8Array): Promise<number | null> {
    return this.payloadBaseFrom(this.root, path);
  }
  private async payloadBaseFrom(root: ArchiveNode, path: Uint8Array): Promise<number | null> {
    const matched = await this.archive(path, root);
    if (matched === null) return null;
    const archive = matched.archive;
    if (archive.kind === 'ordinary') return archive.payloadBase;
    for (const component of archive.components) {
      const base = await this.payloadBaseFrom(
        archive.cache,
        this.componentPath(matched.prefix!, component),
      );
      if (base !== null) return base;
    }
    // 08ABD0 initializes its local to zero; the outer matched-node result remains success.
    return 0;
  }

  async read(
    path: Uint8Array,
    name: Uint8Array,
    offset = 0,
    length = 0,
  ): Promise<AokanaArchiveResource> {
    return this.readFrom(this.root, path, name, offset, length);
  }

  private async readFrom(
    root: ArchiveNode,
    path: Uint8Array,
    name: Uint8Array,
    offset: number,
    length: number,
  ): Promise<AokanaArchiveResource> {
    const matched = await this.archive(path, root);
    if (matched === null) return {result: 0x80000010, bytes: null};
    const archive = matched.archive;
    if (archive.kind === 'complex') {
      // BB110 only publishes complex nodes with at least one component.
      let result: AokanaArchiveResource = {result: 0x80000010, bytes: null};
      for (const component of archive.components) {
        result = await this.readFrom(
          archive.cache,
          this.componentPath(matched.prefix!, component),
          name,
          offset,
          length,
        );
        if (
          result.result < 0x80000000 ||
          result.result === 0x80000030 ||
          result.result === 0x80000040
        )
          break;
      }
      return result;
    }
    const record = this.find(archive, name);
    if (record === null) return {result: 0x80000020, bytes: null};
    // The cached index survives replacement of the mounted archive, but the file is reopened.
    let attempts = 4000;
    let opened = await this.files.open(archive.path);
    while (opened.source === null && opened.error === 5 && attempts !== 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      attempts--;
      opened = await this.files.open(archive.path);
    }
    if (opened.source === null || attempts === 0) return {result: 0x80000010, bytes: null};
    const data = new DataView(archive.index.buffer);
    const size = data.getUint32(record + 100, true);
    offset >>>= 0;
    length >>>= 0;
    if (length === 0) length = (size - offset) >>> 0;
    if (size < length) return {result: 0x80000040, bytes: null};
    if (size < (offset + length) >>> 0) return {result: 0x80000030, bytes: null};
    const position = (archive.payloadBase + data.getUint32(record + 96, true) + offset) >>> 0;
    const bytes = await this.files.read(opened.source, position, length);
    return {result: bytes.length, bytes};
  }

  /** 1400bbee0 maps cache/read/decode statuses; callers receive the native high-bit result. */
  async resource(
    path: Uint8Array,
    name: Uint8Array,
    offset = 0,
    length = 0,
    destination?: AokanaResourceDestination | null,
    actor = this.mainProcessing.allocator.currentActor,
  ): Promise<AokanaArchiveResource> {
    if (textLength({bytes: terminatedNativeBytes(name), offset: 0}) > 95) {
      return this.errors.fatal(
        this.files.text.encodeWide(
          `指定されたファイル名 [ ${this.files.path(name)} ] は95文字を超えています`,
          1,
        ),
      );
    }
    const size = await this.size(path, name);
    if (size > 0x7fffffff) return {result: 0x80000020, bytes: null};
    if (size > 0x4000000) return {result: 0x80000060, bytes: null};
    let stored: AokanaArchiveResource;
    try {
      stored = await this.read(path, name, 0, size);
    } catch (error) {
      if (error instanceof FileError || error instanceof DOMException)
        return {result: 0x80000050, bytes: null};
      throw error;
    }
    if (stored.result !== size || stored.bytes === null) return {result: 0x80000050, bytes: null};
    const decoded = await decodeAokanaResource(
      stored.bytes,
      this.mainProcessing,
      offset,
      length,
      destination,
      undefined,
      actor,
    );
    const mapped = {0: 0, 2: 0x80000030, 3: 0x80000040, 5: 0x80000050, 6: 0x80000060}[
      decoded.status
    ];
    return {
      result: decoded.status === 0 ? decoded.bytes!.length : mapped,
      bytes: decoded.bytes,
      initialized: decoded.initialized,
    };
  }
}

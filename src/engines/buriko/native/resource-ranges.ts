import type {BurikoBpPointer} from '../bp/memory.js';
import {BurikoProgramResources} from './program-resources.js';
import {terminatedNativeBytes} from './program-files.js';
import {textLength} from './text.js';

interface RawRead {
  readonly result: number;
  readonly size: number | null;
}

/** BA0E0/BA220 and BDAA0 use raw file/archive bytes, before resource decompression. */
export class BurikoResourceRanges {
  constructor(readonly resources: BurikoProgramResources) {}

  private async file(
    path: Uint8Array,
    destination: BurikoBpPointer | null,
    offset: number,
    length: number,
  ): Promise<RawRead> {
    const files = this.resources.files;
    if (!files.isAvailable(path)) return {result: 1, size: null};
    const opened = await files.open(path);
    if (opened.source === null) return {result: 1, size: null};
    const size = opened.source.size >>> 0;
    if (destination === null) return {result: 0, size};
    if (size <= offset >>> 0) return {result: 2, size: null};
    const bytes = await files.read(opened.source, offset >>> 0, length >>> 0);
    destination.bytes.set(bytes, destination.offset);
    return {result: bytes.length === length >>> 0 ? 0 : 3, size: bytes.length >>> 0};
  }

  private async loose(
    root: Uint8Array,
    name: Uint8Array,
    destination: BurikoBpPointer | null,
    offset: number,
    length: number,
  ): Promise<RawRead> {
    const terminated = terminatedNativeBytes(name);
    if (terminated[0] === 92 || terminated[1] === 58)
      return this.file(terminated, destination, offset, length);
    let result = await this.file(
      this.resources.loosePath(root, terminated),
      destination,
      offset,
      length,
    );
    if (this.resources.configuration.searchDirectoriesEnabled !== 0) {
      for (const directory of this.resources.configuration.searchDirectories) {
        if (result.result !== 1) break;
        result = await this.file(
          this.resources.loosePath(this.resources.loosePath(root, directory), terminated, true),
          destination,
          offset,
          length,
        );
      }
    }
    return result;
  }

  private async archive(
    root: Uint8Array,
    archive: Uint8Array,
    name: Uint8Array,
    destination: BurikoBpPointer | null,
    offset: number,
    length: number,
  ): Promise<number> {
    if (textLength({bytes: terminatedNativeBytes(name), offset: 0}) >= 96) {
      return this.resources.errors.fatal(
        this.resources.files.text.encodeWide(
          `指定されたファイル名 [ ${this.resources.files.path(name)} ] は95文字を超えています`,
          1,
        ),
      );
    }
    const path = this.resources.archivePath(root, archive);
    const size = await this.resources.archives.size(path, name);
    if (size >= 0x80000000 || destination === null) return size;
    const read = await this.resources.archives.read(path, name, offset, length);
    if (read.bytes !== null) destination.bytes.set(read.bytes, destination.offset);
    return read.result;
  }

  /** BD950 is shared with native80:34 through the canonical resource owner. */
  async isAvailable(archive: Uint8Array | null, name: Uint8Array): Promise<boolean> {
    return (
      (await this.resources.isAvailable(archive, {
        bytes: terminatedNativeBytes(name),
        offset: 0,
      })) !== 0
    );
  }

  /** BD400 queries the stored size; BD6B0's decoded-size service remains separate. */
  async size(archive: Uint8Array | null, name: Uint8Array): Promise<number> {
    const configuration = this.resources.configuration;
    let result = await this.loose(configuration.primaryRoot, name, null, 0, 0);
    if (archive === null) {
      if (result.result !== 0)
        result = await this.loose(configuration.secondaryRoot, name, null, 0, 0);
      return result.size ?? 0;
    }
    if (result.size !== null && result.size !== 0) return result.size;
    let size = await this.archive(configuration.primaryRoot, archive, name, null, 0, 0);
    if (
      size === 0x80000010 &&
      this.resources.files.media.isAvailable(configuration.secondaryMediaPath)
    )
      size = await this.archive(configuration.secondaryRoot, archive, name, null, 0, 0);
    return size > 0x7fffffff ? 0 : size;
  }

  /** BDAA0 falls through to archive lookup only after a missing primary loose file. */
  async read(
    destination: BurikoBpPointer | null,
    archive: Uint8Array | null,
    name: Uint8Array,
    offset: number,
    length: number,
  ): Promise<RawRead> {
    length >>>= 0;
    if (length > 0x4000000) return {result: 3, size: null};
    const configuration = this.resources.configuration;
    const result = await this.loose(configuration.primaryRoot, name, destination, offset, length);
    if (result.result !== 1) return result;
    if (archive === null)
      return this.loose(configuration.secondaryRoot, name, destination, offset, length);
    let count = await this.archive(
      configuration.primaryRoot,
      archive,
      name,
      destination,
      offset,
      length,
    );
    if (
      (count === 0x80000010 || count === 0x80000020) &&
      this.resources.files.media.isAvailable(configuration.secondaryMediaPath)
    )
      count = await this.archive(
        configuration.secondaryRoot,
        archive,
        name,
        destination,
        offset,
        length,
      );
    if (count === 0x80000010 || count === 0x80000020) return {result: 1, size: null};
    if (count === 0x80000030) return {result: 2, size: null};
    if (count === 0x80000040) return {result: 3, size: null};
    return {result: 0, size: count};
  }

  /** BB560 preserves the caller's metadata value when no archive record matches. */
  async metadata(
    archive: Uint8Array | null,
    name: Uint8Array,
    output: {value: bigint},
  ): Promise<number> {
    if (archive === null) return 9;
    const configuration = this.resources.configuration;
    let value = await this.resources.archives.metadata(
      this.resources.archivePath(configuration.primaryRoot, archive),
      name,
    );
    if (value === null) {
      if (!this.resources.files.media.isAvailable(configuration.secondaryMediaPath)) return 1;
      value = await this.resources.archives.metadata(
        this.resources.archivePath(configuration.secondaryRoot, archive),
        name,
      );
      if (value === null) return 1;
    }
    output.value = value;
    return value === 0n ? 10 : 0;
  }
}

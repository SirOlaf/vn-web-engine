import {AokanaNativeFonts} from './fonts.js';
import {AokanaProgramResources} from './program-resources.js';
import {terminatedNativeBytes} from './program-files.js';
import {aokanaCrtWideLower, aokanaCrtWidePrefixEqual} from './crt-case.js';
import {FileError} from '../../../../../platform/filesystem.js';

const englishDefaults = [
  new TextEncoder().encode('MS Gothic'),
  new TextEncoder().encode('MS Mincho'),
] as const;
const japaneseDefaults = [
  Uint8Array.of(0x82, 0x6c, 0x82, 0x72, 0x20, 0x83, 0x53, 0x83, 0x56, 0x83, 0x62, 0x83, 0x4e),
  Uint8Array.of(0x82, 0x6c, 0x82, 0x72, 0x20, 0x96, 0xbe, 0x92, 0xa9),
] as const;

export interface AokanaFontEnumeration {
  readonly names: readonly Uint8Array[];
  readonly byteCount: number;
}

/** Global font-resource map at 14027cbb8 and name enumeration at 14006b170. */
export class AokanaFontResources {
  private readonly loaded = new Map<
    string,
    {readonly token: number; readonly filePath: string | null}
  >();
  constructor(
    readonly fonts: AokanaNativeFonts,
    readonly resources: AokanaProgramResources,
  ) {}

  /** 1400bdee0: cache identity is the lowercased wide filename, independently of archive. */
  async load(
    archive: Uint8Array | null | (() => Uint8Array),
    filename: Uint8Array,
  ): Promise<number> {
    const key = aokanaCrtWideLower(
      this.fonts.text.decodeAuto({bytes: terminatedNativeBytes(filename), offset: 0}),
    );
    if (this.loaded.has(key)) return 0;
    let bytes: Uint8Array;
    let filePath: string | null = null;
    if (archive === null) {
      filePath = this.resources.configuration.nativeFileRoot + key;
      const opened = await this.resources.files.openWide(filePath);
      if (opened.source === null) return 0x8000001a;
      try {
        bytes = await opened.source.read(0, opened.source.size);
      } catch (error) {
        if (error instanceof FileError || error instanceof DOMException) return 0x8000001a;
        throw error;
      }
    } else {
      // The resource-name pointer is not scanned at all for an already loaded filename.
      const archiveName = typeof archive === 'function' ? archive() : archive;
      const size = await this.resources.size(archiveName, filename);
      if (size === 0) return 0x80000019;
      const loaded = await this.resources.load(archiveName, filename, true);
      if (loaded.result !== size) return 0x8000001b;
      if (loaded.bytes === null)
        throw new Error('Aokana font resource dereferences a null successful load');
      if (loaded.bytes.length < size)
        throw new RangeError('Aokana font resource reads past the loaded allocation');
      bytes = loaded.bytes.subarray(0, size);
    }
    // AddFontResourceExW(FR_PRIVATE) is enumerable; AddFontMemResourceEx never is.
    const token = await this.fonts.browser.loadResource(bytes, archive === null);
    if (token === null) return 0x8000001a;
    this.loaded.set(key, {token, filePath});
    return 0;
  }

  /** 1400bdde0 clears names/mappings before releasing fonts in std::map UTF-16 order. */
  clear(): void {
    this.fonts.clearNamesAndMappings();
    for (const key of [...this.loaded.keys()].sort())
      this.fonts.browser.unloadResource(this.loaded.get(key)!.token);
    this.loaded.clear();
  }

  /** 1400be370; callers select whether the current CFontManager is replaced first. */
  reset(replaceManager: boolean, japanese: boolean): void {
    if (replaceManager) this.fonts.resetManager();
    this.clear();
    for (const name of japanese ? japaneseDefaults : englishDefaults)
      this.fonts.registerName(name, -1);
  }

  async enumerate(charset: number, japanese: boolean): Promise<AokanaFontEnumeration> {
    charset |= 0;
    const defaults = japanese ? japaneseDefaults : englishDefaults;
    const wideDefaults = defaults.map((name) =>
      this.fonts.text.decodeAuto({bytes: terminatedNativeBytes(name), offset: 0}),
    );
    const seen = [false, false];
    const names: Uint8Array[] = [];
    let byteCount = 0;
    for (const wide of await this.fonts.browser.enumerate(charset, japanese)) {
      for (let index = 0; index < 2; index++)
        seen[index] ||= aokanaCrtWidePrefixEqual(wide, wideDefaults[index]!);
      const bytes = this.fonts.text.encodeWide(wide);
      names.push(bytes);
      byteCount = (byteCount + bytes.length) | 0;
    }
    // This comparison uses the complete original integer, not lfCharSet's truncated byte.
    if (charset === 128)
      for (let index = 0; index < 2; index++)
        if (!seen[index]) {
          const bytes = terminatedNativeBytes(defaults[index]!);
          names.push(bytes);
          byteCount = (byteCount + bytes.length) | 0;
        }
    return {names, byteCount};
  }
}

import type {BurikoBpPointer} from '../bp/memory.js';
import type {BurikoProgramResourceConfiguration} from './program-resources.js';
import {terminatedNativeBytes} from './program-files.js';
import {BurikoNativeText, copyText, textBytes, writeText} from './text.js';
import {BurikoNativeRegistry} from './windows-registry.js';

export interface BurikoUserFolderProfile {
  desktop: string | null;
  programs: string | null;
  documents: string | null;
  profile: string | null;
}

/** The mounted environment supplies values returned by the native shell primitives.
 * null is a failed location lookup. Missing shell infrastructure is explicit; no host OS
 * account, registry, token, or desktop information is queried. */
export interface BurikoSpecialFolderProfile {
  shellAllocatorAvailable: boolean;
  windows: string | null;
  programFiles: string | null;
  currentUser: BurikoUserFolderProfile;
  shellUser: BurikoUserFolderProfile;
  elevated: boolean;
  shellTokenAvailable: boolean;
  debugPrivilegeAvailable: boolean;
  shellAccountName: string | null;
}

function wideRegistryString(bytes: Uint8Array): string {
  let result = '';
  for (let offset = 0; offset + 1 < bytes.length; offset += 2) {
    const unit = bytes[offset]! | (bytes[offset + 1]! << 8);
    if (unit === 0) return result;
    result += String.fromCharCode(unit);
  }
  throw new Error('Buriko special folder reads an unterminated native registry string');
}

/** Shared 1400bcff0/1400bd320 path service, including the elevated shell-user fallback.
 * The default runtime profile must be selected explicitly by its composition owner. */
export class BurikoSpecialFolders {
  constructor(
    readonly text: BurikoNativeText,
    readonly registry: BurikoNativeRegistry,
    readonly roots: Pick<BurikoProgramResourceConfiguration, 'primaryRoot' | 'secondaryRoot'>,
    readonly profile: BurikoSpecialFolderProfile,
  ) {}

  resourceRoot(output: BurikoBpPointer | null, selector: number): 0 | 1 {
    const source =
      selector === 0 ? this.roots.primaryRoot : selector === 1 ? this.roots.secondaryRoot : null;
    if (source === null || (selector === 1 && (source.length === 0 || source[0] === 0))) return 0;
    if (output === null) throw new Error('Buriko resource root dereferences a null output');
    copyText(output, {bytes: terminatedNativeBytes(source), offset: 0});
    return 1;
  }

  private encode(path: string): Uint8Array {
    if (path.length > 783)
      throw new RangeError('Buriko special folder overwrites native wide stack scratch');
    return this.text.encodeWide(path, 1);
  }

  private async programFilesRegistry(): Promise<Uint8Array | null> {
    const opened = await this.registry.openKey(
      0x80000002,
      'SOFTWARE\\Microsoft\\Windows\\CurrentVersion',
      0x20119,
    );
    if (opened.result !== 0) return null;
    try {
      const query = await this.registry.queryValue(opened.handle!, 'ProgramFilesDir');
      if (query.result !== 0 || query.value!.type !== 1 || query.value!.data.length > 0x618)
        return null;
      return this.encode(wideRegistryString(query.value!.data));
    } finally {
      this.registry.closeKey(opened.handle!);
    }
  }

  async query(output: BurikoBpPointer | null, selector: number): Promise<0 | 1> {
    if (!this.profile.shellAllocatorAvailable) return 0;
    let encoded: Uint8Array | null;
    if (selector === 5) encoded = await this.programFilesRegistry();
    else if (selector === 0 || selector === 4) {
      const path = selector === 0 ? this.profile.windows : this.profile.programFiles;
      // These two branches ignore SHGetFolderPathW's result and consume unwritten scratch.
      if (path === null)
        throw new Error('Buriko special folder reads unwritten native wide stack scratch');
      encoded = this.encode(path);
    } else {
      const field =
        selector === 1
          ? 'desktop'
          : selector === 2
            ? 'programs'
            : selector === 3
              ? 'documents'
              : null;
      if (field === null) return 0;
      const impersonated = this.profile.elevated && this.profile.shellTokenAvailable;
      const path = (impersonated ? this.profile.shellUser : this.profile.currentUser)[field];
      if (path === null) return 0;
      encoded = this.encode(path);
      if (output === null) throw new Error('Buriko special folder dereferences a null output');
      writeText(output, encoded);
      if (this.profile.elevated && !impersonated) {
        const prefix = this.profile.currentUser.profile;
        if (prefix !== null) {
          const prefixBytes = this.encode(prefix);
          if (prefixBytes.length > 784)
            throw new RangeError('Buriko special folder overwrites native encoded profile scratch');
          const base = textBytes({bytes: prefixBytes, offset: 0});
          // Native strncmp is byte-sensitive, and deliberately does not require a separator.
          if (
            base.every((byte, index) => encoded![index] === byte) &&
            this.profile.debugPrivilegeAvailable
          ) {
            const account = this.profile.shellAccountName;
            if (account === null)
              throw new Error('Buriko special folder cannot resolve its native shell account');
            const accountBytes = this.encode(account);
            if (accountBytes.length > 784 || encoded.length > 784)
              throw new RangeError('Buriko special folder overwrites native fallback scratch');
            // _wsplitpath supplies drive + directory; a trailing separator remains significant.
            const slash = Math.max(prefix.lastIndexOf('\\'), prefix.lastIndexOf('/'));
            const driveEnd = prefix[1] === ':' ? 2 : 0;
            const parent = prefix.slice(0, Math.max(slash + 1, driveEnd));
            if (this.encode(parent).length > 780)
              throw new Error(
                'Buriko special folder reads incomplete native split-path conversion',
              );
            const first = this.encode(parent + account);
            const suffix = encoded.subarray(base.length);
            const joined = new Uint8Array(first.length - 1 + suffix.length);
            joined.set(first.subarray(0, -1));
            joined.set(suffix, first.length - 1);
            encoded = joined;
          }
        }
      }
    }
    if (encoded === null) return 0;
    if (output === null) throw new Error('Buriko special folder dereferences a null output');
    writeText(output, encoded);
    return 1;
  }

  /** 1400bd370 converts both strings separately to UTF-8, then copies its 784-byte scratch. */
  combine(
    output: BurikoBpPointer,
    first: BurikoBpPointer,
    separator: number,
    second: BurikoBpPointer,
  ): void {
    const a = this.text.convertEncoding(first, 1);
    const b = this.text.convertEncoding(second, 1);
    const bytes = new Uint8Array(784),
      position = a.length - 1;
    writeText({bytes, offset: 0}, a);
    if (separator !== 0) writeText({bytes, offset: position}, Uint8Array.of(92));
    writeText({bytes, offset: position + Number(separator !== 0)}, b);
    copyText(output, {bytes, offset: 0});
  }
}

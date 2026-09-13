import {
  RegistryError,
  StoredRegistry,
  type RegistryHive,
  type RegistryKey,
  type RegistryValue,
} from '../../../../../platform/registry.js';
import type {RecordStore} from '../../../../../platform/store.js';
import {aokanaRegistryFold} from './registry-case.js';

interface OpenKey {
  readonly key: RegistryKey;
  readonly access: number;
  readonly predefined?: true;
}
const hives: readonly RegistryHive[] = ['HKCR', 'HKCU', 'HKLM', 'HKU', 'HKCC'];

function terminated(value: string): string {
  const at = value.indexOf('\0');
  return at < 0 ? value : value.slice(0, at);
}
function status(error: unknown): number {
  if (error instanceof RegistryError) {
    switch (error.code) {
      case 'NOT_FOUND':
        return 2;
      case 'NOT_EMPTY':
        return 5;
      case 'INVALID_NAME':
        return 123;
      case 'INVALID_VALUE':
        return 87;
      case 'UNSUPPORTED_NAME':
        throw error;
    }
  }
  // This is the browser storage profile's explicit Win32 error mapping.
  if (error instanceof DOMException) {
    if (error.name === 'QuotaExceededError') return 112;
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') return 5;
    if (error.name === 'InvalidStateError') return 1010;
  }
  throw error;
}

/** Win64 registry handles over the existing per-title persistent registry namespace.
 * Host OS registry access is never performed. Installation and wallpaper callers share this owner. */
export class AokanaNativeRegistry {
  private nextHandle = 0x100000000n;
  private readonly keys = new Map<bigint, OpenKey>();
  readonly storage: StoredRegistry;
  constructor(store: RecordStore) {
    this.storage = new StoredRegistry(store, aokanaRegistryFold);
  }

  get openHandleCount(): number {
    return this.keys.size;
  }

  private resolve(handle: number | bigint): OpenKey | null {
    const value = BigInt.asUintN(64, BigInt(handle));
    const low = Number(value & 0xffffffffn);
    const root = value === BigInt(low) || value === BigInt.asUintN(64, BigInt(low | 0));
    if (root) {
      const index = low === 0x80000005 ? 4 : low - 0x80000000;
      if ((index >= 0 && index <= 3) || low === 0x80000005)
        return {
          key: {hive: hives[index]!, view: '64', path: ''},
          access: 0xf003f,
          predefined: true,
        };
    }
    return this.keys.get(value) ?? null;
  }

  private path(root: OpenKey, subkey: string, access: number): RegistryKey {
    const suffix = terminated(subkey).replace(/\\+$/g, '').replace(/\\+/g, '\\');
    return {
      hive: root.key.hive,
      view: access & 0x200 ? '32' : access & 0x100 ? '64' : root.key.view,
      path: root.key.path + (root.key.path && suffix ? '\\' : '') + suffix,
    };
  }

  async createKey(
    rootHandle: number | bigint,
    subkey: string,
    access: number,
  ): Promise<{result: number; handle?: bigint; disposition?: 1 | 2}> {
    const root = this.resolve(rootHandle);
    if (root === null) return {result: 6};
    if ((access & 0x300) === 0x300) return {result: 87};
    if (subkey.startsWith('\\')) return {result: 161};
    const key = this.path(root, subkey, access);
    let existed: boolean;
    try {
      existed = await this.storage.hasKey(key);
      await this.storage.createKey(key);
    } catch (error) {
      return {result: status(error)};
    }
    const handle = this.nextHandle++;
    this.keys.set(handle, {key, access: access >>> 0});
    return {result: 0, handle, disposition: existed ? 2 : 1};
  }

  async openKey(
    rootHandle: number | bigint,
    subkey: string | null,
    access: number,
  ): Promise<{result: number; handle?: bigint}> {
    const root = this.resolve(rootHandle);
    if (root === null) return {result: 6, handle: 0n};
    let name = terminated(subkey ?? '');
    if (root.predefined && name === '')
      return {result: 0, handle: BigInt.asUintN(64, BigInt(rootHandle))};
    if ((access & 0x300) === 0x300) return {result: 87, handle: 0n};
    // RegOpenKeyExW alone removes one leading separator for predefined HKCR.
    if (root.predefined && root.key.hive === 'HKCR' && name.startsWith('\\')) name = name.slice(1);
    if (name.startsWith('\\')) return {result: 161, handle: 0n};
    const key = this.path(root, name, access);
    try {
      if (!(await this.storage.hasKey(key))) return {result: 2, handle: 0n};
    } catch (error) {
      return {result: status(error), handle: 0n};
    }
    const handle = this.nextHandle++;
    this.keys.set(handle, {key, access: access >>> 0});
    return {result: 0, handle};
  }

  closeKey(handle: number | bigint): number {
    const key = BigInt.asUintN(64, BigInt(handle));
    if (this.keys.delete(key)) return 0;
    return this.resolve(handle) === null ? 6 : 0;
  }

  async setValue(
    handle: number | bigint,
    name: string | null,
    type: number,
    data: Uint8Array,
  ): Promise<number> {
    const open = this.resolve(handle);
    if (open === null) return 6;
    if ((open.access & 2) === 0) return 5;
    try {
      await this.storage.setValue(open.key, terminated(name ?? ''), {
        type: type >>> 0,
        data: data.slice(),
      });
      return 0;
    } catch (error) {
      return status(error);
    }
  }

  async queryValue(
    handle: number | bigint,
    name: string | null,
  ): Promise<{result: number; value?: RegistryValue}> {
    const open = this.resolve(handle);
    if (open === null) return {result: 6};
    if ((open.access & 1) === 0) return {result: 5};
    try {
      const value = await this.storage.getValue(open.key, terminated(name ?? ''));
      return value === undefined ? {result: 2} : {result: 0, value};
    } catch (error) {
      return {result: status(error)};
    }
  }
}

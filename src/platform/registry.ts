import type {RecordStore} from './store.js';

export type RegistryHive = 'HKCU' | 'HKLM' | 'HKCR' | 'HKU' | 'HKCC';
export interface RegistryKey {
  hive: RegistryHive;
  view: '32' | '64';
  path: string;
}
/** Preserve the native type tag and bytes, including unknown types and unterminated strings. */
export interface RegistryValue {
  type: number;
  data: Uint8Array;
}
export interface NamedRegistryValue extends RegistryValue {
  name: string;
}
export interface Registry {
  createKey(key: RegistryKey): Promise<void>;
  hasKey(key: RegistryKey): Promise<boolean>;
  getValue(key: RegistryKey, name: string): Promise<RegistryValue | undefined>;
  setValue(key: RegistryKey, name: string, value: RegistryValue): Promise<void>;
  deleteValue(key: RegistryKey, name: string): Promise<void>;
  enumerate(key: RegistryKey): Promise<{subkeys: string[]; values: NamedRegistryValue[]}>;
  deleteKey(key: RegistryKey, recursive?: boolean): Promise<void>;
}
export class RegistryError extends Error {
  constructor(
    readonly code:
      'NOT_FOUND' | 'NOT_EMPTY' | 'INVALID_NAME' | 'INVALID_VALUE' | 'UNSUPPORTED_NAME',
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'RegistryError';
  }
}
/** Windows Unicode casing is versioned. Fail on non-ASCII until an engine supplies an audited policy. */
export function asciiRegistryFold(name: string): string {
  if (/[^\x00-\x7f]/.test(name))
    throw new RegistryError(
      'UNSUPPORTED_NAME',
      'Registry Unicode name requires a Windows casing policy',
    );
  return name.replace(/[a-z]/g, (c) => c.toUpperCase());
}
interface KeyDocument {
  path: string;
  values: {name: string; type: number; data: number[]}[];
}
const encoder = new TextEncoder(),
  decoder = new TextDecoder('utf-8', {fatal: true});
function decode(bytes: Uint8Array): KeyDocument {
  const d = JSON.parse(decoder.decode(bytes)) as KeyDocument;
  if (
    !d ||
    typeof d.path !== 'string' ||
    !Array.isArray(d.values) ||
    d.values.some(
      (v) =>
        !v ||
        typeof v.name !== 'string' ||
        !Number.isInteger(v.type) ||
        v.type < 0 ||
        v.type > 0xffffffff ||
        !Array.isArray(v.data) ||
        v.data.some((b) => !Number.isInteger(b) || b < 0 || b > 255),
    )
  )
    throw new Error('Corrupt registry document');
  return d;
}
function encode(d: KeyDocument): Uint8Array {
  return encoder.encode(JSON.stringify(d));
}
/** Virtual storage, not Win32 API emulation. Views/hives are explicitly isolated. */
export class StoredRegistry implements Registry {
  constructor(
    private readonly store: RecordStore,
    private readonly fold: (name: string) => string = asciiRegistryFold,
  ) {}
  private name(name: string): string {
    if (name.includes('\0')) throw new RegistryError('INVALID_NAME', name);
    return this.fold(name);
  }
  private address(key: RegistryKey): {id: string; prefix: string; parts: string[]} {
    if (
      !['HKCU', 'HKLM', 'HKCR', 'HKU', 'HKCC'].includes(key.hive) ||
      !['32', '64'].includes(key.view)
    )
      throw new RegistryError('INVALID_NAME', 'Hive or view');
    const parts = key.path === '' ? [] : key.path.split('\\');
    if (parts.some((p) => !p || p.includes('\0')))
      throw new RegistryError('INVALID_NAME', key.path);
    // URI encoding prevents slashes or punctuation in key components from aliasing our record namespace.
    const prefix = `registry:${key.hive}:${key.view}/`;
    return {
      id: prefix + parts.map((p) => encodeURIComponent(this.name(p))).join('/'),
      prefix,
      parts,
    };
  }
  private get(records: ReadonlyMap<string, Uint8Array>, key: RegistryKey): KeyDocument {
    const {id, parts} = this.address(key),
      bytes = records.get(id);
    if (bytes) return decode(bytes);
    if (!parts.length) return {path: '', values: []}; // Hive roots always exist in the virtual registry.
    throw new RegistryError('NOT_FOUND', key.path);
  }
  async createKey(key: RegistryKey): Promise<void> {
    const {prefix, parts} = this.address(key);
    await this.store.update((records) => {
      for (let i = 0; i <= parts.length; i++) {
        const current = parts.slice(0, i),
          id = prefix + current.map((p) => encodeURIComponent(this.name(p))).join('/');
        if (!records.has(id)) records.set(id, encode({path: current.join('\\'), values: []}));
      }
    });
  }
  async hasKey(key: RegistryKey): Promise<boolean> {
    const {id, parts} = this.address(key);
    return (await this.store.snapshot()).has(id) || !parts.length;
  }
  async getValue(key: RegistryKey, name: string): Promise<RegistryValue | undefined> {
    key = {...key};
    const folded = this.name(name),
      d = this.get(await this.store.snapshot(), key);
    const v = d.values.find((v) => this.name(v.name) === folded);
    return v ? {type: v.type, data: Uint8Array.from(v.data)} : undefined;
  }
  async setValue(key: RegistryKey, name: string, value: RegistryValue): Promise<void> {
    key = {...key};
    const {id} = this.address(key),
      folded = this.name(name);
    if (
      !Number.isInteger(value.type) ||
      value.type < 0 ||
      value.type > 0xffffffff ||
      !(value.data instanceof Uint8Array)
    )
      throw new RegistryError('INVALID_VALUE', name);
    const captured = {name, type: value.type, data: Array.from(value.data)};
    await this.store.update((records) => {
      const d = this.get(records, key),
        i = d.values.findIndex((v) => this.name(v.name) === folded);
      if (i < 0) d.values.push(captured);
      else d.values[i] = {...captured, name: d.values[i]!.name};
      records.set(id, encode(d));
    });
  }
  async deleteValue(key: RegistryKey, name: string): Promise<void> {
    key = {...key};
    const {id} = this.address(key),
      folded = this.name(name);
    await this.store.update((records) => {
      const d = this.get(records, key),
        i = d.values.findIndex((v) => this.name(v.name) === folded);
      if (i < 0) throw new RegistryError('NOT_FOUND', name);
      d.values.splice(i, 1);
      records.set(id, encode(d));
    });
  }
  async enumerate(key: RegistryKey): Promise<{subkeys: string[]; values: NamedRegistryValue[]}> {
    key = {...key};
    const {id, parts} = this.address(key),
      records = await this.store.snapshot(),
      d = this.get(records, key);
    const prefix = parts.length ? id + '/' : id,
      subkeys: string[] = [];
    for (const [k, bytes] of records) {
      const tail = k.slice(prefix.length);
      if (k.startsWith(prefix) && tail && !tail.includes('/'))
        subkeys.push(decode(bytes).path.split('\\').at(-1)!);
    }
    return {
      subkeys: subkeys.sort(),
      values: d.values.map((v) => ({...v, data: Uint8Array.from(v.data)})),
    };
  }
  async deleteKey(key: RegistryKey, recursive = false): Promise<void> {
    key = {...key};
    const {id, parts} = this.address(key);
    if (!parts.length) throw new RegistryError('INVALID_NAME', 'Cannot delete a hive root');
    await this.store.update((records) => {
      this.get(records, key);
      const children = Array.from(records.keys()).filter((k) => k.startsWith(id + '/'));
      if (children.length && !recursive) throw new RegistryError('NOT_EMPTY', key.path);
      for (const child of children) records.delete(child);
      records.delete(id);
    });
  }
}
export const REG = {
  NONE: 0,
  SZ: 1,
  EXPAND_SZ: 2,
  BINARY: 3,
  DWORD: 4,
  DWORD_BIG_ENDIAN: 5,
  MULTI_SZ: 7,
  QWORD: 11,
} as const;
export function registryDword(n: number): RegistryValue {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff)
    throw new RegistryError('INVALID_VALUE', 'DWORD');
  const data = new Uint8Array(4);
  new DataView(data.buffer).setUint32(0, n, true);
  return {type: REG.DWORD, data};
}
export function registryQword(n: bigint): RegistryValue {
  if (n < 0n || n > 0xffffffffffffffffn) throw new RegistryError('INVALID_VALUE', 'QWORD');
  const data = new Uint8Array(8);
  new DataView(data.buffer).setBigUint64(0, n, true);
  return {type: REG.QWORD, data};
}
export function registryString(text: string): RegistryValue {
  if (text.includes('\0'))
    throw new RegistryError('INVALID_VALUE', 'Embedded NUL in REG_SZ helper');
  const data = new Uint8Array((text.length + 1) * 2),
    view = new DataView(data.buffer);
  for (let i = 0; i < text.length; i++) view.setUint16(i * 2, text.charCodeAt(i), true);
  return {type: REG.SZ, data};
}

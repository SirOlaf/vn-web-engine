import {defineNativeContract} from '../../platform/native-libraries.js';

/**
 * `advapi32.dll`: the registry functions plugins call. Key handles are numbers; the predefined
 * root keys keep their native values. Registry storage is asynchronous in a browser, so the
 * calls return promises; a caller suspends on them.
 */
export interface Advapi32Exports {
  /** `RegCreateKeyExW(root, subKey, …)`: the result code and the opened key. */
  RegCreateKeyExW(root: number, subKey: string): Promise<{result: number; key: number}>;
  /** `RegSetValueExW(key, name, 0, type, data, size)`. */
  RegSetValueExW(key: number, name: string, type: number, data: Uint8Array): Promise<number>;
  RegCloseKey(key: number): number;
}

export const HKEY_CLASSES_ROOT = 0x80000000 | 0;
export const HKEY_CURRENT_USER = 0x80000001 | 0;
export const HKEY_LOCAL_MACHINE = 0x80000002 | 0;
export const HKEY_USERS = 0x80000003 | 0;
export const HKEY_PERFORMANCE_DATA = 0x80000004 | 0;
export const HKEY_CURRENT_CONFIG = 0x80000005 | 0;
export const HKEY_DYN_DATA = 0x80000006 | 0;
export const REG_SZ = 1;
export const REG_DWORD = 4;

export const ADVAPI32 = defineNativeContract<Advapi32Exports>('advapi32.dll', '1');

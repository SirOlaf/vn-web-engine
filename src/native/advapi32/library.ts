import type {NativeLibraryImplementation} from '../../platform/native-libraries.js';
import type {Registry, RegistryHive} from '../../platform/registry.js';
import {
  ADVAPI32,
  HKEY_CLASSES_ROOT,
  HKEY_CURRENT_CONFIG,
  HKEY_CURRENT_USER,
  HKEY_LOCAL_MACHINE,
  HKEY_USERS,
  type Advapi32Exports,
} from './contract.js';

const ERROR_SUCCESS = 0;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_ACCESS_DENIED = 5;
const ERROR_INVALID_HANDLE = 6;

const HIVES: ReadonlyMap<number, RegistryHive> = new Map([
  [HKEY_CLASSES_ROOT, 'HKCR'],
  [HKEY_CURRENT_USER, 'HKCU'],
  [HKEY_LOCAL_MACHINE, 'HKLM'],
  [HKEY_USERS, 'HKU'],
  [HKEY_CURRENT_CONFIG, 'HKCC'],
]);

/**
 * `advapi32.dll` over a registry store, seen by a 32-bit process (the 32-bit view). Without a
 * store every key fails to open with `ERROR_ACCESS_DENIED`; the performance and dynamic data
 * roots are not stored keys.
 */
export function advapi32Library(
  registry: Registry | null,
): NativeLibraryImplementation<Advapi32Exports> {
  return {
    contract: ADVAPI32,
    identities: [{kind: 'system', fileName: 'advapi32.dll'}],
    imports: [],
    link() {
      const keys = new Map<number, {hive: RegistryHive; path: string}>();
      let next = 0x00000100;
      const exports: Advapi32Exports = {
        RegCreateKeyExW: async (root, subKey) => {
          const parent = HIVES.has(root) ? {hive: HIVES.get(root)!, path: ''} : keys.get(root);
          if (!parent)
            return {result: HIVES.has(root) ? ERROR_FILE_NOT_FOUND : ERROR_INVALID_HANDLE, key: 0};
          if (!registry) return {result: ERROR_ACCESS_DENIED, key: 0};
          const path = [parent.path, subKey].filter(Boolean).join('\\');
          await registry.createKey({hive: parent.hive, view: '32', path});
          const key = next;
          next += 4;
          keys.set(key, {hive: parent.hive, path});
          return {result: ERROR_SUCCESS, key};
        },
        RegSetValueExW: async (key, name, type, data) => {
          const k = keys.get(key);
          if (!k) return ERROR_INVALID_HANDLE;
          if (!registry) return ERROR_ACCESS_DENIED;
          await registry.setValue({hive: k.hive, view: '32', path: k.path}, name, {type, data});
          return ERROR_SUCCESS;
        },
        RegCloseKey: (key) =>
          keys.delete(key) || HIVES.has(key) ? ERROR_SUCCESS : ERROR_INVALID_HANDLE,
      };
      return {exports};
    },
  };
}

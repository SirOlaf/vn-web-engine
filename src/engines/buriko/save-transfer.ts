import {StoredFileSystem, filePath, type FileSystem} from '../../platform/filesystem.js';
import type {RecordStore} from '../../platform/store.js';
import {burikoRegistryFold} from './native/registry-case.js';

export type BurikoSaveArea = 'game' | 'user';
export type BurikoSaveKind = 'global' | 'slot' | 'user-data';

export interface BurikoSaveEntry {
  readonly area: BurikoSaveArea;
  /** Internal mounted path; callers should display name instead. */
  readonly path: string;
  readonly name: string;
  readonly size: number;
  readonly kind: BurikoSaveKind;
}

const MAX_IMPORT_BYTES = 64 * 1024 * 1024;
const GLOBAL_SAVE_NAME = /^BGI\.gdb$/i;
const SLOT_SAVE_NAME = /^BGI-?\d{4,}\.cad$/i;
// userdata._bp substitutes this literal before formatting its `%03d` index.
// `%03d` is a minimum width: larger indices are not truncated, and a negative
// value spends one padding column on its sign (for example, -1 becomes -01).
const USER_DATA_PREFIX = 'JewelryHeartsAcademia';
const SAVE_INDEX = '(?:\\d{3,}|-\\d{2,})';
const USER_DATA_SAVE_NAME = new RegExp(`^${USER_DATA_PREFIX}${SAVE_INDEX}\\.sud$`, 'i');
const USER_DATA_SAVE_PATH = new RegExp(`^/USERDATA/${USER_DATA_PREFIX}${SAVE_INDEX}\\.SUD$`, 'i');

function saveEntry(
  path: string,
  area: BurikoSaveArea,
): Pick<BurikoSaveEntry, 'name' | 'kind'> | null {
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (GLOBAL_SAVE_NAME.test(name)) return {name, kind: 'global'};
  if (SLOT_SAVE_NAME.test(name)) return {name, kind: 'slot'};
  if (area === 'game' && USER_DATA_SAVE_PATH.test(path)) return {name, kind: 'user-data'};
  return null;
}

function savePath(path: string, area: BurikoSaveArea): string {
  path = filePath(path);
  if (saveEntry(path, area) === null)
    throw new Error('Choose a BGI save or a JewelryHeartsAcademia UserData file.');
  return path;
}

/** Browser-persistent Buriko saves, using the same stores and case policy as the native runtime. */
export class BurikoSaveTransfer {
  constructor(private readonly openStore: (area: BurikoSaveArea) => Promise<RecordStore>) {}

  private async useStore<T>(
    area: BurikoSaveArea,
    action: (files: FileSystem) => Promise<T>,
  ): Promise<T> {
    const store = await this.openStore(area);
    try {
      return await action(new StoredFileSystem(store, burikoRegistryFold));
    } finally {
      store.close();
    }
  }

  async list(): Promise<BurikoSaveEntry[]> {
    const entries: BurikoSaveEntry[] = [];
    for (const area of ['game', 'user'] as const)
      await this.useStore(area, async (files) => {
        async function visit(directory: string): Promise<void> {
          for (const entry of await files.list(directory)) {
            if (entry.kind === 'directory') await visit(entry.path);
            else {
              const save = saveEntry(entry.path, area);
              if (save !== null) entries.push({area, path: entry.path, ...save, size: entry.size});
            }
          }
        }
        await visit('/');
      });
    return entries.sort(
      (left, right) =>
        left.name.localeCompare(right.name) ||
        left.area.localeCompare(right.area) ||
        left.path.localeCompare(right.path),
    );
  }

  async import(
    name: string,
    bytes: Uint8Array,
    destination?: Pick<BurikoSaveEntry, 'area' | 'path'>,
  ): Promise<BurikoSaveEntry> {
    const global = GLOBAL_SAVE_NAME.test(name),
      slot = SLOT_SAVE_NAME.test(name),
      userData = USER_DATA_SAVE_NAME.test(name);
    if ((!global && !slot && !userData) || name.includes('/') || name.includes('\\'))
      throw new Error('Choose a BGI save or a JewelryHeartsAcademia UserData file.');
    if (bytes.length > MAX_IMPORT_BYTES) throw new Error('Import exceeds 64 MiB.');
    const area = destination?.area ?? 'game',
      kind: BurikoSaveKind = global ? 'global' : slot ? 'slot' : 'user-data',
      defaultPath = userData ? '/UserData/' + name : '/' + name,
      path = savePath(destination?.path ?? defaultPath, area),
      save = saveEntry(path, area);
    if (save === null || save.kind !== kind)
      throw new Error('Choose a BGI save or a JewelryHeartsAcademia UserData file.');
    await this.useStore(area, (files) => files.commit([{kind: 'write', path, data: bytes}]));
    return {area, path: burikoRegistryFold(path), ...save, size: bytes.length};
  }

  async read(entry: Pick<BurikoSaveEntry, 'area' | 'path'>): Promise<Uint8Array> {
    const path = savePath(entry.path, entry.area);
    return this.useStore(entry.area, async (files) => {
      const source = await files.open(path);
      return source.read(0, source.size);
    });
  }
}

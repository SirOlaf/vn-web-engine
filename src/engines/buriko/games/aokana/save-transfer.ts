import {StoredFileSystem, filePath, type FileSystem} from '../../../../platform/filesystem.js';
import {IndexedDbStore, type RecordStore} from '../../../../platform/store.js';
import {aokanaRegistryFold} from './native/registry-case.js';

export type AokanaSaveArea = 'game' | 'user';

export interface AokanaSaveEntry {
  readonly area: AokanaSaveArea;
  /** Internal mounted path; callers should display name instead. */
  readonly path: string;
  readonly name: string;
  readonly size: number;
}

const MAX_IMPORT_BYTES = 64 * 1024 * 1024;
const SAVE_NAME = /^BGI(?:\.gdb|-?\d{4,}\.cad)$/i;

function saveName(path: string): string | null {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return SAVE_NAME.test(name) ? name : null;
}

function savePath(path: string): string {
  path = filePath(path);
  if (saveName(path) === null) throw new Error('Choose an Aokana save file.');
  return path;
}

/** Browser-persistent Aokana saves, using the same stores and case policy as the native runtime. */
export class AokanaSaveTransfer {
  constructor(
    private readonly openStore: (area: AokanaSaveArea) => Promise<RecordStore> = (area) =>
      IndexedDbStore.open(['aokana', 'default', area]),
  ) {}

  private async useStore<T>(
    area: AokanaSaveArea,
    action: (files: FileSystem) => Promise<T>,
  ): Promise<T> {
    const store = await this.openStore(area);
    try {
      return await action(new StoredFileSystem(store, aokanaRegistryFold));
    } finally {
      store.close();
    }
  }

  async list(): Promise<AokanaSaveEntry[]> {
    const entries: AokanaSaveEntry[] = [];
    for (const area of ['game', 'user'] as const)
      await this.useStore(area, async (files) => {
        async function visit(directory: string): Promise<void> {
          for (const entry of await files.list(directory)) {
            if (entry.kind === 'directory') await visit(entry.path);
            else {
              const name = saveName(entry.path);
              if (name !== null) entries.push({area, path: entry.path, name, size: entry.size});
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
    destination?: Pick<AokanaSaveEntry, 'area' | 'path'>,
  ): Promise<AokanaSaveEntry> {
    if (!SAVE_NAME.test(name) || name.includes('/') || name.includes('\\'))
      throw new Error('Choose a BGI.gdb or numbered BGI save slot file.');
    if (bytes.length > MAX_IMPORT_BYTES) throw new Error('Import exceeds 64 MiB.');
    const area = destination?.area ?? 'game';
    const path = savePath(destination?.path ?? '/' + name);
    await this.useStore(area, (files) => files.commit([{kind: 'write', path, data: bytes}]));
    return {area, path: aokanaRegistryFold(path), name: saveName(path)!, size: bytes.length};
  }

  async read(entry: Pick<AokanaSaveEntry, 'area' | 'path'>): Promise<Uint8Array> {
    const path = savePath(entry.path);
    return this.useStore(entry.area, async (files) => {
      const source = await files.open(path);
      return source.read(0, source.size);
    });
  }
}

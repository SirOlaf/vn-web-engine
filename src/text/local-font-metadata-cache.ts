import type {SfntFontMetadata} from '../formats/sfnt.js';
import {beginRuntimeSpan} from '../platform/runtime-performance.js';

/** Installed-font metadata by record identity. Implementations never throw. */
export interface LocalFontMetadataCache {
  /** Cached faces by key; keys without a usable entry are absent. */
  getMany(keys: readonly string[]): Promise<Map<string, readonly SfntFontMetadata[]>>;
  putMany(entries: ReadonlyMap<string, readonly SfntFontMetadata[]>): Promise<void>;
}

const databaseName = 'vn-web-engine-font-metadata';
const storeName = 'faces';
/** Bump when readSfntFontMetadata's output changes so older entries are re-read. */
const formatVersion = 1;

interface StoredEntry {
  readonly version: number;
  readonly faces: readonly SfntFontMetadata[];
}

function usable(value: unknown): value is StoredEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Partial<StoredEntry>;
  return (
    entry.version === formatVersion &&
    Array.isArray(entry.faces) &&
    entry.faces.length !== 0 &&
    entry.faces.every(
      (face) => typeof face === 'object' && face !== null && Array.isArray(face.names),
    )
  );
}

/**
 * Local Font Access exposes no file size, version or timestamp without the costly blob()
 * request, so entries are keyed by the record's names. A font replaced in place under the
 * same names keeps its old metadata until the cache is cleared or its format changes.
 */
export class IndexedDbLocalFontMetadataCache implements LocalFontMetadataCache {
  private database: Promise<IDBDatabase | null> | null = null;
  constructor(private readonly factory: IDBFactory | undefined = globalThis.indexedDB) {}

  private open(): Promise<IDBDatabase | null> {
    return (this.database ??= new Promise((resolve) => {
      if (typeof this.factory?.open !== 'function') {
        resolve(null);
        return;
      }
      let request: IDBOpenDBRequest;
      try {
        request = this.factory.open(databaseName, 1);
      } catch {
        resolve(null);
        return;
      }
      request.onupgradeneeded = () => request.result.createObjectStore(storeName);
      request.onblocked = request.onerror = () => resolve(null);
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          this.database = null;
        };
        resolve(db);
      };
    }));
  }

  private async transaction(
    mode: IDBTransactionMode,
    work: (store: IDBObjectStore) => void,
  ): Promise<boolean> {
    const db = await this.open();
    if (db === null) return false;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(storeName, mode);
        tx.oncomplete = () => resolve(true);
        tx.onabort = tx.onerror = () => resolve(false);
        work(tx.objectStore(storeName));
      } catch {
        resolve(false);
      }
    });
  }

  async getMany(keys: readonly string[]): Promise<Map<string, readonly SfntFontMetadata[]>> {
    const found = new Map<string, readonly SfntFontMetadata[]>();
    if (keys.length === 0) return found;
    const finish = beginRuntimeSpan('text.font.cache-read');
    await this.transaction('readonly', (store) => {
      for (const key of keys) {
        const request = store.get(key);
        request.onsuccess = () => {
          if (usable(request.result)) found.set(key, request.result.faces);
        };
      }
    });
    finish?.({requested: keys.length, found: found.size});
    return found;
  }

  async putMany(entries: ReadonlyMap<string, readonly SfntFontMetadata[]>): Promise<void> {
    if (entries.size === 0) return;
    const finish = beginRuntimeSpan('text.font.cache-write');
    await this.transaction('readwrite', (store) => {
      for (const [key, faces] of entries)
        store.put({version: formatVersion, faces} satisfies StoredEntry, key);
    });
    finish?.({entries: entries.size});
  }
}

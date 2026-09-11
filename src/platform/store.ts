/** Transactional byte records, shared by files and the virtual registry. */
export interface RecordStore {
  snapshot(): Promise<Map<string, Uint8Array>>;
  /** Callback must be synchronous. Throwing aborts the entire update. */
  update(change: (records: Map<string, Uint8Array>) => void): Promise<void>;
  close(): void;
}
function copy(records: ReadonlyMap<string, Uint8Array>): Map<string, Uint8Array> {
  return new Map(Array.from(records, ([key, value]) => [key, value.slice()]));
}
function changed(
  records: Map<string, Uint8Array>,
  change: (records: Map<string, Uint8Array>) => void,
): Map<string, Uint8Array> {
  const result: unknown = change(records);
  if (result !== undefined)
    throw new Error('Storage transaction callbacks must be synchronous and return void');
  for (const [key, value] of records)
    if (typeof key !== 'string' || !(value instanceof Uint8Array))
      throw new Error('Invalid storage record');
  return copy(records); // Do not retain references supplied to or retained by the callback.
}
export class MemoryStore implements RecordStore {
  private records = new Map<string, Uint8Array>();
  private closed = false;
  private check(): void {
    if (this.closed) throw new Error('Storage is closed');
  }
  async snapshot(): Promise<Map<string, Uint8Array>> {
    this.check();
    return copy(this.records);
  }
  async update(change: (records: Map<string, Uint8Array>) => void): Promise<void> {
    this.check();
    this.records = changed(copy(this.records), change);
  }
  close(): void {
    this.closed = true;
  }
}

/** One database per application/game/profile. Never falls back to transient storage. */
export class IndexedDbStore implements RecordStore {
  private closed = false;
  private constructor(private readonly db: IDBDatabase) {
    db.onversionchange = () => this.close();
  }
  static open(
    namespace: readonly string[],
    factory: IDBFactory = globalThis.indexedDB,
  ): Promise<IndexedDbStore> {
    if (!namespace.length || namespace.some((s) => !s || s.includes('\0')))
      return Promise.reject(new Error('Invalid storage namespace'));
    if (!factory) return Promise.reject(new Error('Persistent browser storage is unavailable'));
    return new Promise((resolve, reject) => {
      const request = factory.open(`vn-runtime:${JSON.stringify(namespace)}`, 1);
      let rejected = false;
      request.onupgradeneeded = () => {
        request.result.createObjectStore('records');
      };
      request.onblocked = () => {
        rejected = true;
        reject(new Error('Storage upgrade blocked by another open page'));
      };
      request.onerror = () => reject(request.error ?? new Error('Cannot open persistent storage'));
      request.onsuccess = () => {
        if (rejected) request.result.close();
        else resolve(new IndexedDbStore(request.result));
      };
    });
  }
  private transaction(
    change?: (records: Map<string, Uint8Array>) => void,
  ): Promise<Map<string, Uint8Array>> {
    if (this.closed) return Promise.reject(new Error('Storage is closed'));
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('records', change ? 'readwrite' : 'readonly');
      const store = tx.objectStore('records'),
        records = new Map<string, Uint8Array>();
      let failure: unknown,
        result = records;
      tx.onabort = () => reject(failure ?? tx.error ?? new Error('Storage transaction aborted'));
      tx.onerror = () => {
        /* Abort reports the transaction failure; never cancel it. */
      };
      tx.oncomplete = () => resolve(result);
      const cursor = store.openCursor();
      cursor.onsuccess = () => {
        try {
          const row = cursor.result;
          if (row) {
            if (typeof row.key !== 'string' || !(row.value instanceof Uint8Array))
              throw new Error('Corrupt storage record');
            records.set(row.key, row.value);
            row.continue();
            return;
          }
          if (!change) return;
          // Read and modify inside ONE readwrite transaction: updates from other tabs serialize.
          result = changed(copy(records), change);
          for (const key of records.keys()) if (!result.has(key)) store.delete(key);
          for (const [key, bytes] of result) {
            const old = records.get(key);
            if (!old || old.length !== bytes.length || old.some((b, i) => b !== bytes[i]))
              store.put(bytes, key);
          }
        } catch (error) {
          failure = error;
          tx.abort();
        }
      };
    });
  }
  snapshot(): Promise<Map<string, Uint8Array>> {
    return this.transaction();
  }
  async update(change: (records: Map<string, Uint8Array>) => void): Promise<void> {
    await this.transaction(change);
  }
  close(): void {
    this.closed = true;
    this.db.close();
  }
}

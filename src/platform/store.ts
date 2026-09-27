import {beginRuntimeSpan, recordRuntimeMetric} from './runtime-performance.js';

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

/** Exact equality without a callback for every byte of a large unchanged record. */
function equalBytes(first: Uint8Array, second: Uint8Array): boolean {
  if (first.length !== second.length) return false;
  let byte = 0;
  if (((first.byteOffset | second.byteOffset) & 3) === 0) {
    const count = Math.floor(first.length / 4),
      left = new Uint32Array(first.buffer, first.byteOffset, count),
      right = new Uint32Array(second.buffer, second.byteOffset, count);
    for (let word = 0; word < count; word++) if (left[word] !== right[word]) return false;
    byte = count * 4;
  }
  for (; byte < first.length; byte++) if (first[byte] !== second[byte]) return false;
  return true;
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
    const finishTransaction = beginRuntimeSpan('storage.idb.transaction');
    return new Promise((resolve, reject) => {
      const records = new Map<string, Uint8Array>();
      let failure: unknown,
        result = records,
        readBytes = 0,
        copiedBytes = 0,
        comparedBytes = 0,
        writes = 0,
        writeBytes = 0,
        deletes = 0;
      const finish = (aborted: boolean): void => {
        if (!finishTransaction) return;
        finishTransaction({
          update: !!change,
          aborted,
          records: records.size,
          readBytes,
          copiedBytes,
          comparedBytes,
          writes,
          deletes,
        });
        recordRuntimeMetric('storage.idb.read-bytes', readBytes);
        recordRuntimeMetric('storage.idb.copy-bytes', copiedBytes);
        recordRuntimeMetric('storage.idb.compare-bytes', comparedBytes);
        recordRuntimeMetric('storage.idb.write-bytes', writeBytes);
      };
      try {
        const tx = this.db.transaction('records', change ? 'readwrite' : 'readonly');
        const store = tx.objectStore('records');
        tx.onabort = () => {
          finish(true);
          reject(failure ?? tx.error ?? new Error('Storage transaction aborted'));
        };
        tx.onerror = () => {
          /* Abort reports the transaction failure; never cancel it. */
        };
        tx.oncomplete = () => {
          finish(false);
          resolve(result);
        };
        const cursor = store.openCursor();
        cursor.onsuccess = () => {
          try {
            const finishCursor = beginRuntimeSpan('storage.idb.cursor-sync');
            let more = false,
              rowBytes = 0;
            try {
              const row = cursor.result;
              if (row) {
                const key = row.key,
                  value = row.value;
                if (typeof key !== 'string' || !(value instanceof Uint8Array))
                  throw new Error('Corrupt storage record');
                rowBytes = value.byteLength;
                readBytes += rowBytes;
                records.set(key, value);
                more = true;
                row.continue();
              }
            } finally {
              finishCursor?.({records: Number(more), bytes: rowBytes});
            }
            if (more || !change) return;
            // Read and modify inside ONE readwrite transaction: updates from other tabs serialize.
            const finishApply = beginRuntimeSpan('storage.idb.apply-copy-sync');
            try {
              const input = copy(records);
              copiedBytes = readBytes;
              result = changed(input, change);
              if (finishTransaction)
                for (const bytes of result.values()) copiedBytes += bytes.byteLength;
            } finally {
              finishApply?.({records: result.size, copiedBytes});
            }
            const finishCompare = beginRuntimeSpan('storage.idb.compare-sync');
            let comparedRecords = 0;
            try {
              for (const key of records.keys())
                if (!result.has(key)) {
                  store.delete(key);
                  deletes++;
                }
              for (const [key, bytes] of result) {
                const old = records.get(key);
                if (old && old.length === bytes.length) {
                  comparedRecords++;
                  comparedBytes += bytes.byteLength;
                }
                if (!old || !equalBytes(old, bytes)) {
                  store.put(bytes, key);
                  writes++;
                  writeBytes += bytes.byteLength;
                }
              }
            } finally {
              // Byte totals describe comparison inputs; mismatches can exit early.
              finishCompare?.({records: comparedRecords, bytes: comparedBytes, writes, deletes});
            }
          } catch (error) {
            failure = error;
            tx.abort();
          }
        };
      } catch (error) {
        finish(true);
        reject(error);
      }
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

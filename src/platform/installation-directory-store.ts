const databaseName = 'vn-web-engine-installation-directories';

/** Device folder references only. Game bytes and saves remain in their existing stores.
 * FileSystemHandle requires structured cloning, so it cannot use the byte RecordStore.
 */
export class BrowserInstallationDirectoryStore {
  constructor(private readonly factory: IDBFactory | undefined = globalThis.indexedDB) {}

  available(): boolean {
    return typeof this.factory?.open === 'function';
  }

  private open(): Promise<IDBDatabase> {
    if (!this.available())
      return Promise.reject(
        new Error('Remembering device folders is unavailable in this browser.'),
      );
    return new Promise((resolve, reject) => {
      const request = this.factory!.open(databaseName, 1);
      let rejected = false;
      request.onupgradeneeded = () => request.result.createObjectStore('directories');
      request.onblocked = () => {
        rejected = true;
        reject(new Error('Remembered folders are blocked by another open page.'));
      };
      request.onerror = () => reject(request.error ?? new Error('Cannot open remembered folders.'));
      request.onsuccess = () => {
        const db = request.result;
        if (rejected) db.close();
        else {
          db.onversionchange = () => db.close();
          resolve(db);
        }
      };
    });
  }

  private async transaction<T>(
    key: string,
    mode: IDBTransactionMode,
    work: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    if (!key) throw new Error('An installation key is required.');
    const db = await this.open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction('directories', mode);
        let request: IDBRequest<T>;
        tx.onabort = () => reject(tx.error ?? new Error('Remembered folder update was aborted.'));
        tx.onerror = () => {};
        tx.oncomplete = () => resolve(request.result);
        try {
          request = work(tx.objectStore('directories'));
        } catch (error) {
          tx.abort();
          reject(error);
        }
      });
    } finally {
      db.close();
    }
  }

  async get(key: string): Promise<FileSystemDirectoryHandle | null> {
    const value: unknown = await this.transaction(key, 'readonly', (store) => store.get(key));
    if (value === undefined) return null;
    if (
      typeof value !== 'object' ||
      value === null ||
      !('kind' in value) ||
      value.kind !== 'directory' ||
      !('getFileHandle' in value) ||
      typeof value.getFileHandle !== 'function'
    )
      throw new Error('The remembered folder is invalid. Choose the game folder again.');
    return value as FileSystemDirectoryHandle;
  }

  async set(key: string, handle: FileSystemDirectoryHandle): Promise<void> {
    await this.transaction(key, 'readwrite', (store) => store.put(handle, key));
  }

  async remove(key: string): Promise<void> {
    await this.transaction(key, 'readwrite', (store) => store.delete(key));
  }
}

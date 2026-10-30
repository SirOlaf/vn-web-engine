/** Save directory storage (SaveDataPath). */
export interface ArtemisRuntimeStorage {
  read(name: string): Promise<Uint8Array | null>;
  write(name: string, bytes: Uint8Array): void | Promise<void>;
  /** Removes `name`; absent names are ignored. Without it save files cannot be deleted. */
  delete?(name: string): void | Promise<void>;
  /** The stored names; without it the save directory appears empty to `isFileExists`
   * until files are written. */
  list?(): Promise<readonly string[]>;
}

/** The save directory over asynchronous storage, with the native synchronous file semantics:
 * a written or removed file exists or is gone for the script at once, storage changes apply
 * in call order, and a read sees every earlier change. */
export class ArtemisSaveDirectory {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly changes: Promise<void>[] = [];
  private constructor(
    private readonly storage: ArtemisRuntimeStorage,
    private readonly names: Set<string>,
  ) {}
  static async open(storage: ArtemisRuntimeStorage): Promise<ArtemisSaveDirectory> {
    return new ArtemisSaveDirectory(storage, new Set(await storage.list?.()));
  }
  has(name: string): boolean {
    return this.names.has(name);
  }
  read(name: string): Promise<Uint8Array | null> {
    return this.tail.then(() => this.storage.read(name));
  }
  /** `bytes` may still be in preparation; later changes wait for it. */
  write(name: string, bytes: Uint8Array | Promise<Uint8Array>): Promise<void> {
    this.names.add(name);
    return this.change(async () => this.storage.write(name, await bytes));
  }
  remove(name: string): Promise<void> {
    const storage = this.storage;
    if (!storage.delete) throw Error('Artemis save storage cannot delete files');
    this.names.delete(name);
    return this.change(async () => storage.delete!(name));
  }
  /** Settles the storage changes made so far; rejects when one of them failed. */
  async flush(): Promise<void> {
    await Promise.all(this.changes);
  }
  private change(apply: () => Promise<void>): Promise<void> {
    const result = this.tail.then(apply);
    this.tail = result.catch(() => {});
    this.changes.push(result);
    return result;
  }
}

import type {RecordStore} from './store.js';

function decode(data: Uint8Array | undefined): number[] {
  const values: unknown = data ? JSON.parse(new TextDecoder().decode(data)) : [];
  if (!Array.isArray(values) || values.some((v) => !Number.isSafeInteger(v) || v < 0))
    throw new Error('Invalid achievement data');
  return values;
}

/** Emulated platform API state, outside the game's file and registry namespaces. */
export class StoredAchievements {
  private readonly unlocked = new Set<number>();
  private readonly key: string;
  private pending = Promise.resolve();
  private error: unknown;
  constructor(
    readonly store: RecordStore | undefined,
    readonly gameId: string,
  ) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(gameId))
      throw new Error('Invalid stable achievement game ID');
    this.key = 'host:achievements:' + gameId;
  }
  identifier(id: number): string {
    if (!Number.isSafeInteger(id) || id < 0) throw new Error('Invalid achievement ID');
    return this.gameId + ':' + id;
  }
  async load(): Promise<void> {
    if (!this.store) return;
    for (const id of decode((await this.store.snapshot()).get(this.key))) this.unlocked.add(id);
  }
  has(id: number): boolean {
    return this.unlocked.has(id);
  }
  unlock(id: number): void {
    this.identifier(id);
    if (!this.store) return;
    this.unlocked.add(id);
    // Merge inside the transaction, so separate runtimes cannot overwrite unlocks.
    this.pending = this.pending
      .then(() =>
        this.store!.update((records) => {
          const values = new Set(decode(records.get(this.key)));
          values.add(id);
          records.set(
            this.key,
            new TextEncoder().encode(JSON.stringify([...values].sort((a, b) => a - b))),
          );
        }),
      )
      .catch((e) => {
        this.error = e;
      });
  }
  async settle(): Promise<void> {
    await this.pending;
    if (this.error !== undefined) throw this.error;
  }
}

interface SectionWaiter {
  readonly actor: object;
  readonly resume: () => void;
}

/** A distinct recursive Win32 section over cooperative async host operations.
 * Each caller captures its existing allocator actor before waiting; no new worker identity is made. */
export class BurikoAsyncCriticalSection {
  private live = false;
  private ownerValue: object | null = null;
  private depthValue = 0;
  private readonly waiters: SectionWaiter[] = [];
  get owner(): object | null {
    return this.ownerValue;
  }
  get depth(): number {
    return this.depthValue;
  }

  initialize(): void {
    if (this.live) throw new Error('Buriko async section is already initialized');
    this.live = true;
  }
  async enter(actor: object): Promise<void> {
    if (!this.live) throw new Error('Buriko async section is not initialized');
    if (this.ownerValue === null || this.ownerValue === actor) {
      this.ownerValue = actor;
      this.depthValue++;
      return;
    }
    await new Promise<void>((resume) => this.waiters.push({actor, resume}));
  }
  leave(actor: object): void {
    if (!this.live || this.ownerValue !== actor || this.depthValue === 0)
      throw new Error('Buriko async section is not owned by the captured actor');
    if (--this.depthValue !== 0) return;
    const next = this.waiters.shift();
    if (next === undefined) this.ownerValue = null;
    else {
      this.ownerValue = next.actor;
      this.depthValue = 1;
      next.resume();
    }
  }
  dispose(): void {
    if (this.ownerValue !== null || this.waiters.length !== 0)
      throw new Error('Buriko async section still has an active owner');
    this.live = false;
  }
}

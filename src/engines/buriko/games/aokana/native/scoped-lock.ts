import {AokanaDisplayCriticalSection} from './display-critical-section.js';

/** DCLock: a root owns its section; a scope holds and later releases a supplied parent. */
export class AokanaScopedLock {
  private readonly section: AokanaDisplayCriticalSection | null;
  private count = 0;
  private disposed = false;
  constructor(
    private readonly currentActor: () => object,
    private readonly parent: AokanaScopedLock | null = null,
  ) {
    if (parent === null)
      this.section = new AokanaDisplayCriticalSection(currentActor); // 094c30.
    else {
      this.section = null;
      parent.enter();
    } // 094b30.
  }
  private check(): void {
    if (this.disposed) throw new Error('Aokana DCLock is no longer available');
  }
  get depth(): number {
    return this.count;
  }
  /** 094ba0 scopes do not forward explicit enter calls to their parent. */
  enter(): 0 | 1 {
    this.check();
    if (this.parent !== null) return 0;
    this.section!.enter();
    this.count = (this.count + 1) | 0;
    return 1;
  }
  /** 094b60 counts ownership independently of the underlying recursive section. */
  leave(): 0 | 1 {
    this.check();
    if (this.parent !== null || this.count <= 0) return 0;
    this.count = (this.count - 1) | 0;
    this.section!.leave();
    return 1;
  }
  scope(): AokanaScopedLock {
    this.check();
    return new AokanaScopedLock(this.currentActor, this);
  }
  /** 094be0's scope destructor leaves its parent; the root deletes its own section. */
  dispose(): void {
    this.check();
    if (this.parent !== null) this.parent.leave();
    this.disposed = true;
  }
}

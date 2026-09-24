/** The cooperative native actor is the existing OS-worker profile, not a BP thread ID. */
export interface AokanaLockActors {
  readonly currentActor: object;
  advance?(): boolean;
}

class RecursiveSection {
  owner: object | null = null;
  depth = 0;
  private alive = true;
  private readonly waiters: {
    actor: object;
    acquired: () => void;
    resolve: () => void;
    reject: (reason: Error) => void;
  }[] = [];
  constructor(private readonly actors: AokanaLockActors) {}
  tryEnter(actor = this.actors.currentActor): boolean {
    if (!this.alive) throw new Error('Aokana exclusion section is no longer available');
    if (this.owner !== null && this.owner !== actor) return false;
    this.owner = actor;
    this.depth++;
    return true;
  }
  enter(): void {
    while (!this.tryEnter()) {
      if (this.actors.advance?.() !== true)
        throw new Error('Aokana exclusion wait has no runnable owning-actor continuation');
    }
  }
  enterAsync(actor: object, acquired: () => void): Promise<void> {
    if (this.tryEnter(actor)) {
      acquired();
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) =>
      this.waiters.push({actor, acquired, resolve, reject}),
    );
  }
  leave(actor = this.actors.currentActor): void {
    if (!this.alive || this.depth === 0 || this.owner !== actor)
      throw new Error('Aokana exclusion section is not owned by its current actor');
    if (--this.depth === 0) {
      const next = this.waiters.shift();
      this.owner = next?.actor ?? null;
      if (next !== undefined) {
        this.depth = 1;
        next.acquired();
        next.resolve();
      }
    }
  }
  run<T>(operation: () => T): T {
    this.enter();
    try {
      return operation();
    } finally {
      this.leave();
    }
  }
  runAs<T>(actor: object, operation: () => T): T {
    // Registry metadata never yields; no actor is globally installed across an await.
    if (!this.tryEnter(actor))
      throw new Error('Aokana async admission encountered a suspended registry section');
    try {
      return operation();
    } finally {
      this.leave(actor);
    }
  }
  dispose(): void {
    this.alive = false;
    for (const waiter of this.waiters.splice(0))
      waiter.reject(
        new Error('Aokana pending exclusion acquisition targets a removed native section'),
      );
  }
}

/** Shared atomic DWORD 1d2818. Both native DCExclusionControl instances consume it. */
export class AokanaExclusionIds {
  private last = 0;
  next(): number {
    this.last = (this.last + 1) >>> 0;
    return this.last;
  }
}

interface LockRecord {
  readonly id: number;
  /** +04 includes admitted callers that have not yet acquired the record section. */
  admitted: number;
  /** +08 counts successful acquisitions only. */
  acquired: number;
  readonly section: RecursiveSection;
  next: LockRecord | null;
}
export type AokanaExclusionResult = 0 | 0x80000001 | 0x80000002 | 0x80000003 | 0x80000004;

/** DCExclusionControl, 08c910: registry section +08 and newest-first record list +30. */
export class AokanaExclusionRegistry {
  private readonly registry: RecursiveSection;
  private head: LockRecord | null = null;
  constructor(
    private readonly ids: AokanaExclusionIds,
    private readonly actors: AokanaLockActors,
  ) {
    this.registry = new RecursiveSection(actors);
  }

  /** 08c500 returns the first matching DWORD identity. */
  private find(id: number): LockRecord | null {
    for (let node = this.head; node !== null; node = node.next)
      if (node.id === id >>> 0) return node;
    return null;
  }
  /** Read-only bookkeeping view; it does not create an acquisition. */
  snapshot(): readonly {
    id: number;
    admitted: number;
    acquired: number;
    owner: object | null;
  }[] {
    return this.registry.run(() => {
      const output = [];
      for (let node = this.head; node !== null; node = node.next)
        output.push({
          id: node.id,
          admitted: node.admitted,
          acquired: node.acquired,
          owner: node.section.owner,
        });
      return output;
    });
  }
  /** 08c820 increments the common ID after clearing a new record, then prepends it. */
  create(): number {
    return this.registry.run(() => {
      const record: LockRecord = {
        id: this.ids.next(),
        admitted: 0,
        acquired: 0,
        section: new RecursiveSection(this.actors),
        next: this.head,
      };
      this.head = record;
      return record.id;
    });
  }
  /** 08c690 releases the registry after admission and before waiting for the record. */
  enter(id: number): AokanaExclusionResult {
    const record = this.registry.run(() => {
      const found = this.find(id);
      if (found !== null) found.admitted = (found.admitted + 1) | 0;
      return found;
    });
    if (record === null) return 0x80000001;
    record.section.enter();
    record.acquired = (record.acquired + 1) | 0;
    return 0;
  }
  /** Same08c690 record and counters, awaiting an actual host continuation when contended. */
  async enterAsync(id: number, actor: object): Promise<AokanaExclusionResult> {
    const record = this.registry.runAs(actor, () => {
      const found = this.find(id);
      if (found !== null) found.admitted = (found.admitted + 1) | 0;
      return found;
    });
    if (record === null) return 0x80000001;
    await record.section.enterAsync(actor, () => {
      record.acquired = (record.acquired + 1) | 0;
    });
    return 0;
  }
  /** 08c700's record behavior; AokanaNativeLocks exposes it only on the script instance. */
  tryEnter(id: number): AokanaExclusionResult {
    return this.registry.run(() => {
      const record = this.find(id);
      if (record === null) return 0x80000001;
      if (!record.section.tryEnter()) return 0x80000002;
      record.admitted = (record.admitted + 1) | 0;
      record.acquired = (record.acquired + 1) | 0;
      return 0;
    });
  }
  /** 08c600 checks acquired depth before its temporary ownership-proving acquisition. */
  leave(id: number, actor?: object): AokanaExclusionResult {
    const operation = (): AokanaExclusionResult => {
      const record = this.find(id);
      if (record === null) return 0x80000001;
      if (record.acquired < 1) return 0x80000003;
      if (!record.section.tryEnter(actor)) return 0x80000002;
      record.section.leave(actor);
      record.acquired = (record.acquired - 1) | 0;
      record.section.leave(actor);
      record.admitted = (record.admitted - 1) | 0;
      return 0;
    };
    return actor === undefined
      ? this.registry.run(operation)
      : this.registry.runAs(actor, operation);
  }
  /** 08c770 unlinks before destroying the selected record section. */
  remove(id: number, force = 0): AokanaExclusionResult {
    return this.registry.run(() => {
      let previous: LockRecord | null = null;
      for (let record = this.head; record !== null; record = record.next) {
        if (record.id === id >>> 0) {
          if (record.admitted >= 1 && (force | 0) === 0) return 0x80000004;
          if (previous === null) this.head = record.next;
          else previous.next = record.next;
          record.section.dispose();
          return 0;
        }
        previous = record;
      }
      return 0x80000001;
    });
  }
  /** 08c570 repeatedly releases each current-actor acquisition, newest record first. */
  releaseCurrentActor(actor?: object): number {
    const operation = (): number => {
      let count = 0;
      for (let record = this.head; record !== null; record = record.next)
        while (this.leave(record.id, actor) === 0) count = (count + 1) | 0;
      return count;
    };
    return actor === undefined
      ? this.registry.run(operation)
      : this.registry.runAs(actor, operation);
  }
  /** 08c8a0 force-removes the current head until empty, then deletes its registry section. */
  dispose(): void {
    this.registry.run(() => {
      while (this.head !== null) this.remove(this.head.id, 1);
    });
    this.registry.dispose();
  }
}

/** The two authoritative global instances, with five shared engine IDs at 1e7140. */
export class AokanaNativeLocks {
  readonly ids = new AokanaExclusionIds();
  readonly engine: AokanaExclusionRegistry;
  readonly script: AokanaExclusionRegistry;
  private readonly engineIds = new Uint32Array(5);
  constructor(actors: AokanaLockActors) {
    this.engine = new AokanaExclusionRegistry(this.ids, actors);
    this.script = new AokanaExclusionRegistry(this.ids, actors);
  }
  /** b97a0; native startup invokes this before creating the display and audio subsystems. */
  initializeEngine(): void {
    for (let index = 0; index < 5; index++) this.engineIds[index] = this.engine.create();
  }
  /** b9750 preserves the ID array while force-removing each saved engine record. */
  disposeEngine(): void {
    for (let index = 0; index < 5; index++) this.engine.remove(this.engineIds[index]!, 1);
  }
  engineId(index: number): number {
    const id = this.engineIds[index >>> 0];
    if (id === undefined) throw new RangeError('Aokana engine lock index is outside its five IDs');
    return id;
  }
  /** b9800/b9820 deliberately discard the common lower status. */
  enterEngine(index: number): void {
    this.engine.enter(this.engineId(index));
  }
  async enterEngineAsync(index: number, actor: object): Promise<void> {
    await this.engine.enterAsync(this.engineId(index), actor);
  }
  leaveEngine(index: number, actor?: object): void {
    this.engine.leave(this.engineId(index), actor);
  }
  /** b97f0's thunk targets the script instance, never the five engine locks. */
  releaseScriptCurrentActor(actor?: object): number {
    return this.script.releaseCurrentActor(actor);
  }
}

/** Standalone display construction performs the same concrete five-lock startup. */
export function createAokanaDisplayLocks(actors: AokanaLockActors): AokanaNativeLocks {
  const locks = new AokanaNativeLocks(actors);
  locks.initializeEngine();
  return locks;
}

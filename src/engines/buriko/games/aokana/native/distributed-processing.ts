type Actor = object;

/** Native manual-reset event, with a deterministic cooperative web-thread profile. */
class WorkEvent {
  closed = false;
  constructor(public signaled: boolean) {}
  set(): void {
    this.check();
    this.signaled = true;
  }
  reset(): void {
    this.check();
    this.signaled = false;
  }
  close(): void {
    this.check();
    this.closed = true;
  }
  check(): void {
    if (this.closed) throw new Error('Aokana work manager uses a closed event');
  }
}

export type AokanaWorkYield =
  {readonly kind: 'event'; readonly event: WorkEvent} | {readonly kind: 'cooperate'};
export type AokanaWorkContinuation = Generator<AokanaWorkYield, number, number>;
export type AokanaWorkResult = number | AokanaWorkContinuation;
export type AokanaAsyncWorkerCallback<T> = (
  context: T,
  worker: number,
  actor: object,
) => number | Promise<number>;

type WorkerPhase = 'idle' | 'callback' | 'activation' | 'event' | 'finishing' | 'terminated';
interface WorkThread {
  readonly id: number;
  readonly actor: Actor;
  readonly activation: WorkEvent | null;
  readonly wake: WorkEvent;
  started: boolean;
  parked: boolean;
  phase: WorkerPhase;
  continuation: AokanaWorkContinuation | null;
  pendingEvent: WorkEvent | null;
  executing: boolean;
  // Four native handshake critical sections: ownership at the completed barriers.
  gate0: 'worker' | null;
  gate1: 'main' | null;
  gate2: 'main' | null;
  gate3: 'worker' | null;
}

/** 14008b830 global registry: weighted quotas across the currently running pools. */
export class AokanaDistributedAllocator {
  private readonly active: AokanaDistributedProcessing[] = [];
  private readonly runningPools: AokanaDistributedProcessing[] = [];
  private scheduleIndex = 0;
  currentActor: Actor = {};
  initialized = true;

  constructor(readonly processorCount: number) {
    if (!Number.isInteger(processorCount) || processorCount <= 0 || processorCount > 0xffffffff)
      throw new RangeError('Aokana work-manager processor count must be a positive DWORD');
  }

  /** Native actor scope ends as soon as invocation returns, even for a promise result. */
  withActor<T>(actor: Actor, operation: () => T): T {
    const previous = this.currentActor;
    this.currentActor = actor;
    try {
      return operation();
    } finally {
      this.currentActor = previous;
    }
  }

  initialize(): void {
    if (!this.initialized) this.initialized = true;
  }

  beginRun(pool: AokanaDistributedProcessing): void {
    this.runningPools.push(pool);
  }

  endRun(pool: AokanaDistributedProcessing): void {
    const index = this.runningPools.indexOf(pool);
    if (index < 0) throw new Error('Aokana cooperative pool has no active run');
    this.runningPools.splice(index, 1);
  }

  /** Nested native pools can depend on callbacks belonging to an ancestor pool. */
  advance(): boolean {
    for (let attempt = 0; attempt < this.runningPools.length; attempt++) {
      const pool = this.runningPools[this.scheduleIndex++ % this.runningPools.length]!;
      if (pool.advanceCooperatively()) return true;
    }
    return false;
  }

  update(pool: AokanaDistributedProcessing, enabled: boolean): void {
    if (!this.initialized) throw new Error('Aokana work allocator critical section was deleted');
    let total = 0;
    for (let i = 0; i < this.active.length;) {
      const entry = this.active[i]!;
      if (entry === pool) {
        if (!enabled) entry.setActiveCapacity(0);
        this.active.splice(i, 1);
      } else {
        total = (total + Math.imul(entry.capacity, entry.priority)) >>> 0;
        i++;
      }
    }
    if (enabled) {
      this.active.unshift(pool);
      total = (total + Math.imul(pool.capacity, pool.priority)) >>> 0;
    }
    if (total === 0) return;
    let assigned = 0,
      bestPriority = 0,
      bestQuota = 0;
    let best: AokanaDistributedProcessing | undefined;
    for (const entry of this.active) {
      const product =
        Math.imul(Math.imul(entry.capacity, entry.priority), this.processorCount) >>> 0;
      const quota = Math.max(1, Math.floor(product / total));
      entry.setActiveCapacity(quota);
      // The native accumulator includes rejected over-capacity requests too.
      assigned = (assigned + quota) >>> 0;
      if (entry.priority >>> 0 > bestPriority) {
        bestPriority = entry.priority >>> 0;
        best = entry;
        bestQuota = quota;
      }
    }
    if (assigned < this.processorCount) {
      if (best === undefined)
        throw new Error('Aokana work allocator has no native highest-priority pool');
      best.setActiveCapacity((this.processorCount + bestQuota - assigned) >>> 0);
    }
  }

  dispose(): void {
    if (!this.initialized) return;
    while (this.active.length !== 0) this.update(this.active[0]!, false);
    this.initialized = false;
  }
}

/**
 * DCDstrbtdPrcssng, 14008b830–14008c2c0. Each callback invocation is an atomic
 * cooperative slice unless it yields an actual native event wait through park().
 * Running pools retain their full capacity and native worker IDs; quotas gate
 * callbacks rather than deleting logical workers.
 */
export class AokanaDistributedProcessing {
  readonly capacity: number;
  activeCapacity: number;
  priority = 2;
  alive = true;
  distributedFlag = 0;
  private wakeAllLatch: number | undefined;
  private callback: ((context: unknown) => AokanaWorkResult) | null = null;
  private workerCallback: ((context: unknown, worker: number) => AokanaWorkResult) | null = null;
  private asyncWorkerCallback: AokanaAsyncWorkerCallback<unknown> | null = null;
  private context: unknown = null;
  private readonly workers: WorkThread[];
  private running = false;
  private mainActor: Actor | null = null;
  private sharedOwner: Actor | null = null;
  private sharedDepth = 0;
  private nextWorker = 0;

  constructor(
    readonly allocator: AokanaDistributedAllocator,
    workerCount: number,
  ) {
    workerCount >>>= 0;
    if (workerCount === 0)
      throw new Error('Aokana work constructor writes worker zero in an empty allocation');
    this.capacity = this.activeCapacity = workerCount;
    this.workers = Array.from({length: workerCount}, (_, id): WorkThread => ({
      id,
      actor: {},
      activation: id === 0 ? null : new WorkEvent(true),
      wake: new WorkEvent(false),
      started: true,
      parked: false,
      phase: 'idle',
      continuation: null,
      pendingEvent: null,
      executing: false,
      gate0: null,
      gate1: null,
      gate2: id === 0 ? null : 'main',
      gate3: id === 0 ? null : 'worker',
    }));
    // Native construction waits for every background thread to reach this gate.
  }

  setCallback<T>(callback: ((context: T) => AokanaWorkResult) | null, context: T): void {
    this.check();
    if (this.asyncWorkerCallback !== null)
      throw new Error('Aokana asynchronous indexed callback is already installed');
    this.callback = callback === null ? null : (value) => callback(value as T);
    this.context = context;
  }

  setWorkerCallback<T>(
    callback: ((context: T, worker: number) => AokanaWorkResult) | null,
    context: T,
  ): void {
    this.check();
    if (this.asyncWorkerCallback !== null)
      throw new Error('Aokana asynchronous indexed callback is already installed');
    this.workerCallback =
      callback === null ? null : (value, worker) => callback(value as T, worker);
    this.context = context;
  }

  setActiveCapacity(requested: number): 0 | 1 {
    this.check();
    requested >>>= 0;
    if (requested === 0) requested = this.capacity;
    if (requested === 0 || requested > this.capacity) return 0;
    if (this.activeCapacity < requested) {
      for (let id = this.activeCapacity; id < requested; id++) this.workers[id]!.activation!.set();
    } else {
      for (let id = requested; id < this.activeCapacity; id++)
        this.workers[id]!.activation!.reset();
    }
    this.activeCapacity = requested;
    return 1;
  }

  enterShared(): 0 | 1 {
    this.check();
    if (this.capacity <= 1 || this.distributedFlag === 0) return 0;
    const actor = this.allocator.currentActor;
    if (this.sharedOwner !== null && this.sharedOwner !== actor)
      throw new Error(
        'Aokana cooperative callback yielded while holding another worker’s critical section',
      );
    this.sharedOwner = actor;
    this.sharedDepth++;
    return 1;
  }

  leaveShared(force = 0): void {
    this.check();
    if ((this.capacity <= 1 || this.distributedFlag === 0) && force === 0) return;
    if (this.sharedOwner !== this.allocator.currentActor || this.sharedDepth === 0)
      throw new Error('Aokana native work callback leaves an unowned critical section');
    if (--this.sharedDepth === 0) this.sharedOwner = null;
  }

  /** 14008bd30: count zero latches wake-all, while positive counts wake lowest IDs first. */
  wake(count: number): void {
    this.enterShared();
    count >>>= 0;
    if (this.wakeAllLatch === undefined)
      throw new Error('Aokana work callback reads its uninitialized wake-all flag');
    this.wakeAllLatch = this.wakeAllLatch !== 0 || count === 0 ? 1 : 0;
    if (count === 0 || count > this.capacity) count = this.capacity;
    let index = 0;
    for (let remaining = count; remaining > 0; remaining--) {
      while (index < this.capacity) {
        const worker = this.workers[index++]!;
        if (worker.parked) {
          worker.wake.set();
          break;
        }
      }
    }
    this.leaveShared(1);
  }

  /** 14008bde0: yielded event wait resumes at ResetEvent, then reacquires the shared lock. */
  *park(id: number): AokanaWorkContinuation {
    this.check();
    id >>>= 0;
    if (id >= this.capacity) return 0;
    this.enterShared();
    if (this.wakeAllLatch === undefined)
      throw new Error('Aokana work callback reads its uninitialized wake-all flag');
    let result = 0;
    if (
      this.wakeAllLatch === 0 &&
      this.workers.some((worker) => worker.id !== id && !worker.parked)
    ) {
      const worker = this.workers[id]!;
      worker.parked = true;
      this.leaveShared(1);
      yield {kind: 'event', event: worker.wake};
      worker.wake.reset();
      this.enterShared();
      worker.parked = false;
      result = 1;
    }
    this.leaveShared(1);
    return result;
  }

  private check(): void {
    if (!this.alive) throw new Error('Aokana work manager has been destroyed');
  }

  private invoke(worker: WorkThread): boolean {
    if (worker.executing) return false;
    const actor = worker.id === 0 ? this.mainActor! : worker.actor;
    // Callback slices which use the native shared claim lock start only when
    // that lock can be acquired. A running slice is never restarted at entry.
    if (this.sharedOwner !== null && this.sharedOwner !== actor) return false;
    if (worker.phase === 'finishing' || worker.phase === 'idle' || worker.phase === 'terminated')
      return false;
    if (worker.pendingEvent !== null) {
      worker.pendingEvent.check();
      if (!worker.pendingEvent.signaled) return false;
      worker.pendingEvent = null;
    }
    const previousActor = this.allocator.currentActor;
    this.allocator.currentActor = actor;
    worker.executing = true;
    try {
      if (worker.continuation === null) {
        // Native tests both callback pointers before the worker activation event.
        const resumedActivation = worker.phase === 'activation';
        if (!resumedActivation && this.callback === null && this.workerCallback === null) {
          worker.phase = 'finishing';
          return true;
        }
        if (resumedActivation || worker.id >= this.activeCapacity) {
          if (worker.activation === null)
            throw new Error('Aokana worker zero waits on a null activation event');
          worker.activation.check();
          if (!worker.activation.signaled) {
            worker.phase = 'activation';
            return false;
          }
        }
        worker.phase = 'callback';
        if (this.callback === null && this.workerCallback === null)
          throw new Error('Aokana work callback became null during its native activation wait');
        const result =
          this.callback !== null
            ? this.callback(this.context)
            : this.workerCallback!(this.context, worker.id);
        if (typeof result === 'number') {
          if ((result | 0) === 0) worker.phase = 'finishing';
          return true;
        }
        worker.continuation = result;
      }
      const step = worker.continuation.next(1);
      if (step.done) {
        worker.continuation = null;
        worker.phase = (step.value | 0) === 0 ? 'finishing' : 'callback';
      } else {
        worker.pendingEvent = step.value.kind === 'event' ? step.value.event : null;
        worker.phase = step.value.kind === 'event' ? 'event' : 'callback';
      }
      return true;
    } finally {
      worker.executing = false;
      this.allocator.currentActor = previousActor;
    }
  }

  advanceCooperatively(): boolean {
    // Promise callbacks are serialized by their own barrier so the allocator's
    // single actor identity remains current across every await.
    if (this.asyncWorkerCallback !== null) return false;
    const count = this.capacity > 1 && this.distributedFlag !== 0 ? this.capacity : 1;
    for (let attempt = 0; attempt < count; attempt++) {
      const id = this.nextWorker++ % count;
      if (this.invoke(this.workers[id]!)) return true;
    }
    return false;
  }

  /** Scheduling point for native polling loops whose progress belongs to another worker. */
  *cooperate(): Generator<AokanaWorkYield, void, number> {
    yield {kind: 'cooperate'};
  }

  private mainFinished(): boolean {
    return this.workers[0]!.phase === 'finishing';
  }

  run(distributedFlag: number, actor = this.allocator.currentActor): void {
    this.check();
    if (this.running) throw new Error('Aokana work manager entered a recursive native run barrier');
    this.running = true;
    this.allocator.beginRun(this);
    this.mainActor = actor;
    this.distributedFlag = distributedFlag | 0;
    this.nextWorker = 0;
    const distributed = this.capacity > 1 && this.distributedFlag !== 0;
    if (distributed) {
      this.wakeAllLatch = 0;
      this.allocator.update(this, true);
      for (const worker of this.workers.slice(1)) {
        worker.gate1 = 'main';
        worker.gate2 = null;
        worker.gate0 = 'worker';
        worker.gate3 = null;
        worker.phase = 'callback';
      }
    }
    this.workers[0]!.phase = 'callback';
    while (!this.mainFinished()) {
      if (!this.allocator.advance())
        throw new Error('Aokana native work run is blocked with no signaled worker event');
    }
    if (distributed) {
      // Unregister restores all activation events before the completion barrier.
      this.allocator.update(this, false);
      for (const worker of this.workers.slice(1)) {
        worker.gate2 = 'main';
        worker.gate1 = null;
      }
      while (this.workers.some((worker) => worker.phase !== 'finishing')) {
        if (!this.allocator.advance())
          throw new Error('Aokana native work completion is blocked with no signaled worker event');
      }
      for (const worker of this.workers.slice(1)) {
        worker.gate3 = 'worker';
        worker.gate0 = null;
        worker.phase = 'idle';
      }
    }
    this.workers[0]!.phase = 'idle';
    this.distributedFlag = 0;
    this.running = false;
    this.allocator.endRun(this);
    this.mainActor = null;
  }

  private async invokeAsync(worker: WorkThread): Promise<boolean> {
    if (worker.executing) return false;
    const actor = worker.id === 0 ? this.mainActor! : worker.actor;
    if (this.sharedOwner !== null && this.sharedOwner !== actor) return false;
    if (worker.phase === 'finishing' || worker.phase === 'idle' || worker.phase === 'terminated')
      return false;
    if (worker.id !== 0 && worker.id >= this.activeCapacity) {
      const activation = worker.activation!;
      activation.check();
      if (!activation.signaled) {
        worker.phase = 'activation';
        return false;
      }
    }
    const callback = this.asyncWorkerCallback;
    if (callback === null)
      throw new Error('Aokana asynchronous indexed callback became null during its run');
    worker.executing = true;
    worker.phase = 'callback';
    try {
      const pending = this.allocator.withActor(actor, () =>
        callback(this.context, worker.id, actor),
      );
      const result = await pending;
      worker.phase = (result | 0) === 0 ? 'finishing' : 'callback';
      return true;
    } finally {
      worker.executing = false;
    }
  }

  private async advanceAsync(): Promise<boolean> {
    const count = this.capacity > 1 && this.distributedFlag !== 0 ? this.capacity : 1;
    for (let attempt = 0; attempt < count; attempt++) {
      const id = this.nextWorker++ % count;
      if (await this.invokeAsync(this.workers[id]!)) return true;
    }
    return false;
  }

  /**
   * Promise-aware companion for native indexed callbacks. It uses this pool's
   * real worker records; actor scope covers invocation only, never the awaited continuation.
   */
  async runWorkerCallbackAsync<T>(
    callback: AokanaAsyncWorkerCallback<T>,
    context: T,
    distributedFlag: number,
    actor = this.allocator.currentActor,
  ): Promise<void> {
    this.check();
    if (this.running) throw new Error('Aokana work manager entered a recursive native run barrier');
    if (this.callback !== null || this.workerCallback !== null || this.asyncWorkerCallback !== null)
      throw new Error('Aokana work manager already has an installed callback');
    this.asyncWorkerCallback = (value, worker, workerActor) =>
      callback(value as T, worker, workerActor);
    this.context = context;
    this.running = true;
    this.allocator.beginRun(this);
    this.mainActor = actor;
    this.distributedFlag = distributedFlag | 0;
    this.nextWorker = 0;
    const distributed = this.capacity > 1 && this.distributedFlag !== 0;
    let registered = false;
    try {
      if (distributed) {
        this.wakeAllLatch = 0;
        this.allocator.update(this, true);
        registered = true;
        for (const worker of this.workers.slice(1)) {
          worker.gate1 = 'main';
          worker.gate2 = null;
          worker.gate0 = 'worker';
          worker.gate3 = null;
          worker.phase = 'callback';
        }
      }
      this.workers[0]!.phase = 'callback';
      while (!this.mainFinished()) {
        if (!(await this.advanceAsync()))
          throw new Error('Aokana asynchronous work run is blocked with no runnable worker');
      }
      if (distributed) {
        this.allocator.update(this, false);
        registered = false;
        for (const worker of this.workers.slice(1)) {
          worker.gate2 = 'main';
          worker.gate1 = null;
        }
        while (this.workers.some((worker) => worker.phase !== 'finishing')) {
          if (!(await this.advanceAsync()))
            throw new Error('Aokana asynchronous work completion has no runnable worker');
        }
      }
    } finally {
      if (registered) this.allocator.update(this, false);
      for (const worker of this.workers.slice(1)) {
        worker.gate3 = 'worker';
        worker.gate2 = 'main';
        worker.gate1 = null;
        worker.gate0 = null;
        worker.phase = 'idle';
      }
      this.workers[0]!.phase = 'idle';
      this.distributedFlag = 0;
      this.running = false;
      this.allocator.endRun(this);
      this.mainActor = null;
      this.asyncWorkerCallback = null;
      this.context = null;
    }
  }

  workerState(id: number): Readonly<{
    started: boolean;
    parked: boolean;
    phase: WorkerPhase;
    activation: boolean | null;
    wake: boolean;
    gates: readonly (string | null)[];
  }> {
    const worker = this.workers[id >>> 0];
    if (worker === undefined) throw new RangeError('Aokana work-thread index outside capacity');
    return {
      started: worker.started,
      parked: worker.parked,
      phase: worker.phase,
      activation: worker.activation?.signaled ?? null,
      wake: worker.wake.signaled,
      gates: [worker.gate0, worker.gate1, worker.gate2, worker.gate3],
    };
  }

  dispose(): void {
    this.check();
    if (this.running) throw new Error('Aokana work manager destroyed during a native run barrier');
    this.allocator.update(this, false);
    this.alive = false;
    for (const worker of this.workers) {
      worker.gate2 = null;
      worker.gate3 = null;
      worker.gate0 = null;
      worker.phase = 'terminated';
      worker.activation?.close();
      worker.wake.close();
    }
    this.sharedOwner = null;
    this.sharedDepth = 0;
  }
}

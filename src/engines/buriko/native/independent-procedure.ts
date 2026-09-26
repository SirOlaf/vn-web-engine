import type {BurikoDisplayManager} from './display-manager.js';
import type {BurikoDisplayObject} from './display-object.js';

interface Message {
  readonly words: Uint32Array;
  next: Message | null;
}

/** DCIndProc, 08e240; this is separate from a BP thread's CProcedure wait process. */
export class BurikoIndependentProcedure {
  readonly id: number;
  category = 0x80;
  enabled = 1;
  dirty = 0;
  private firstMessage: Message | null = null;
  private disposed = false;

  constructor(
    readonly shared: BurikoIndependentProcedures,
    readonly object: BurikoDisplayObject,
  ) {
    object.attachOwnerIfEmpty(this);
    try {
      this.id = shared.allocateId();
    } catch (error) {
      object.removeOwnerIfMatches(this);
      throw error;
    }
  }

  protected check(): void {
    if (this.disposed) throw new Error('Buriko accesses a deleted DCIndProc');
  }

  getEnabled(): number {
    this.check();
    return this.enabled >>> 0;
  }
  setEnabled(value: number): void {
    this.check();
    this.enabled = value >>> 0;
  }

  /** 08e070 copies one through 256 DWORDs before appending to the live FIFO. */
  enqueue(words: Uint32Array): 0 | 1 {
    this.check();
    if ((words.length - 1) >>> 0 >= 256) return 0;
    const message: Message = {words: words.slice(), next: null};
    if (this.firstMessage === null) this.firstMessage = message;
    else {
      let last = this.firstMessage;
      while (last.next !== null) last = last.next;
      last.next = message;
    }
    return 1;
  }

  private dequeue(): Uint32Array | null {
    this.check();
    const first = this.firstMessage;
    if (first === null) return null;
    this.firstMessage = first.next;
    return first.words;
  }

  /** The native base message virtual, 08dee0, returns one without changing state. */
  protected handleMessage(_words: Uint32Array): number | Promise<number> {
    this.check();
    return 1;
  }

  /** 08e000; disabling a procedure does not interrupt the remainder of its queued messages. */
  protected async drainMessages(): Promise<void> {
    const operationAllocator = this.shared.surfaces.allocator,
      operationActor = operationAllocator.currentActor;
    const runAsActor = <T>(operation: () => T): T =>
      operationAllocator.withActor(operationActor, operation);

    let words: Uint32Array | null;
    while ((words = this.dequeue()) !== null) {
      if (words[0] === 0) {
        if (words.length === 2) runAsActor(() => this.setEnabled(words![1]!));
      } else {
        const result = runAsActor(() => this.handleMessage(words!));
        if (result instanceof Promise) await result;
      }
    }
  }

  /** 08df70 uses the associated object's virtual38 and the live minimum render key. */
  redrawEligible(): boolean {
    this.check();
    return this.shared.manager.minimumKey >>> 0 <= this.object.sortKey() >>> 0;
  }

  /** 08dfb0 clears the dirty latch whether or not the object reaches the render threshold. */
  protected flushRedraw(): void {
    this.check();
    if (this.dirty !== 0 && this.redrawEligible()) this.shared.manager.redraw.request(0);
    this.dirty = 0;
  }

  /** Native base virtual +8, 08e140. Derived DCIP classes provide their concrete polling. */
  async poll(): Promise<number> {
    const operationAllocator = this.shared.surfaces.allocator,
      operationActor = operationAllocator.currentActor;
    const runAsActor = <T>(operation: () => T): T =>
      operationAllocator.withActor(operationActor, operation);

    await runAsActor(() => this.drainMessages());
    if (runAsActor(() => this.getEnabled()) !== 0) runAsActor(() => this.flushRedraw());
    return 0;
  }

  /** 08e1f0 discards remaining messages and conditionally clears the CDspObj association. */
  dispose(): void {
    this.check();
    while (this.dequeue() !== null) {}
    this.object.removeOwnerIfMatches(this);
    this.disposed = true;
  }
}

class Entry {
  private removed = false;
  constructor(
    readonly id: number,
    readonly procedure: BurikoIndependentProcedure,
    private following: Entry | null,
  ) {}
  get next(): Entry | null {
    if (this.removed) throw new Error('Buriko DCIndProc traversal reads a removed registry node');
    return this.following;
  }
  set next(value: Entry | null) {
    if (this.removed) throw new Error('Buriko DCIndProc traversal writes a removed registry node');
    this.following = value;
  }
  release(): void {
    this.removed = true;
  }
}

/** The one registry at 1e9120. 08e1d0/08e1b0 bind the actual display/surface manager aliases. */
export class BurikoIndependentProcedures {
  private lastId = 0; // 1d281c, distinct from CProcedure and lock counters.
  private first: Entry | null = null;
  private registrations = 0; // 1e9110 is reset only by c2b10, not decremented by c2b50.
  private phase = 0; // 1e90ac, independent-procedure polling phase.
  private activePoll = false;
  private frameLaneToken: object | null = null;
  private finalAdmissionClosed = false;
  private finalDisposed = false;
  private finalDisposalError: {error: unknown} | null = null;
  private pendingNativeCallbacks: (() => boolean) | null = null;
  private pollDrainWaiters: Array<() => void> = [];
  private pollFailure: {error: unknown} | null = null;
  private frameLaneDrainWaiters: Array<() => void> = [];
  private frameLaneFailure: {error: unknown} | null = null;

  constructor(readonly manager: BurikoDisplayManager) {}

  get surfaces() {
    return this.manager.surfaces;
  }
  get registrationCount(): number {
    return this.registrations;
  }
  get pollingPhase(): number {
    return this.phase;
  }
  get hasActivePoll(): boolean {
    return this.activePoll;
  }
  get hasActiveFrameLane(): boolean {
    return this.frameLaneToken !== null;
  }
  get admissionClosed(): boolean {
    return this.finalAdmissionClosed;
  }

  /** The VM core assigns its callback counter once, before either ingress can run. */
  bindNativeCallbackGuard(pending: () => boolean): void {
    if (this.pendingNativeCallbacks !== null || this.finalAdmissionClosed)
      throw new Error('Buriko independent procedure callback guard is already bound');
    this.pendingNativeCallbacks = pending;
  }

  beginFinalClose(): void {
    this.finalAdmissionClosed = true;
  }

  private assertMutationAdmission(): void {
    if (this.finalAdmissionClosed)
      throw new Error('Buriko independent procedure admission is closed');
    if (this.activePoll) throw new Error('Buriko independent procedure registry is being polled');
    if (this.frameLaneToken !== null)
      throw new Error('Buriko independent procedure frame lane is active');
  }

  private beginPoll(frameLaneToken: object | null = null): void {
    if (frameLaneToken !== null) {
      if (this.frameLaneToken !== frameLaneToken)
        throw new Error('Buriko independent procedure frame lane token is stale');
      if (this.activePoll) throw new Error('Buriko independent procedure registry is being polled');
    } else this.assertMutationAdmission();
    if (this.pendingNativeCallbacks?.())
      throw new Error('Buriko independent procedure poll overlaps a native callback');
    this.activePoll = true;
  }

  private endPoll(): void {
    this.activePoll = false;
    const waiters = this.pollDrainWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  async joinPendingPoll(): Promise<void> {
    if (this.activePoll) await new Promise<void>((resolve) => this.pollDrainWaiters.push(resolve));
    if (this.pollFailure !== null) throw this.pollFailure.error;
  }
  /** ECB90 prefix admission spans its awaited poll and synchronous input suffix. */
  withFrameLane<T>(
    operation: (poll: {
      enabled: () => Promise<0 | 1>;
      reset: () => Promise<void>;
      phaseOneEnabled: () => Promise<0 | 1>;
    }) => Promise<T>,
  ): Promise<T> {
    this.assertMutationAdmission();
    if (this.pendingNativeCallbacks?.())
      throw new Error('Buriko independent frame lane overlaps a native callback');
    const token = {};
    this.frameLaneToken = token;
    let pollUsed = false;
    let phaseOneUsed = false;
    const takePoll = (): void => {
      if (pollUsed) throw new Error('Buriko independent frame lane already polled');
      pollUsed = true;
    };
    return (async () => {
      try {
        return await operation({
          enabled: () => {
            takePoll();
            return this.pollEnabledInternal(token);
          },
          reset: () => {
            takePoll();
            return this.resetEnabledInternal(token);
          },
          phaseOneEnabled: () => {
            if (!pollUsed || phaseOneUsed || this.phase !== 1)
              throw new Error('Buriko phase-one frame poll requires completed phase-one prefix');
            phaseOneUsed = true;
            return this.pollEnabledInternal(token);
          },
        });
      } catch (error) {
        this.frameLaneFailure ??= {error};
        throw error;
      } finally {
        this.frameLaneToken = null;
        const waiters = this.frameLaneDrainWaiters.splice(0);
        for (const resolve of waiters) resolve();
      }
    })();
  }

  async joinPendingFrameLane(): Promise<void> {
    if (this.frameLaneToken !== null)
      await new Promise<void>((resolve) => this.frameLaneDrainWaiters.push(resolve));
    if (this.frameLaneFailure !== null) throw this.frameLaneFailure.error;
  }
  /** c2c60 accepts only zero and one; the controller reads this before each phase. */
  setPollingPhase(value: number): 0 | 1 {
    this.assertMutationAdmission();
    value >>>= 0;
    if (value > 1) return 0;
    this.phase = value;
    return 1;
  }

  /** ID assignment belongs to construction, which can precede registry insertion. */
  allocateId(): number {
    this.assertMutationAdmission();
    this.lastId = (this.lastId + 1) >>> 0;
    return this.lastId;
  }

  register(procedure: BurikoIndependentProcedure): number {
    this.assertMutationAdmission();
    if (procedure.shared !== this)
      throw new Error('Buriko DCIndProc belongs to another native registry owner');
    const id = procedure.id >>> 0;
    const entry = new Entry(id, procedure, this.first);
    this.registrations = (this.registrations + 1) >>> 0;
    this.first = entry;
    return id;
  }

  find(id: number): BurikoIndependentProcedure | null {
    id >>>= 0;
    for (let entry = this.first; entry !== null; entry = entry.next)
      if (entry.id === id) return entry.procedure;
    return null;
  }

  /** c2b50 unlinks before disposal; it intentionally retains the registration counter. */
  remove(id: number): 0 | 1 {
    this.assertMutationAdmission();
    return this.removeInternal(id);
  }

  private removeInternal(id: number): 0 | 1 {
    id >>>= 0;
    let previous: Entry | null = null;
    for (let entry = this.first; entry !== null; entry = entry.next) {
      if (entry.id === id) {
        if (previous === null) this.first = entry.next;
        else previous.next = entry.next;
        try {
          entry.procedure.dispose();
        } finally {
          entry.release();
        }
        return 1;
      }
      previous = entry;
    }
    return 0;
  }

  clear(): void {
    this.assertMutationAdmission();
    while (this.first !== null) this.removeInternal(this.first.id);
    this.registrations = 0;
  }

  private clearFinalInternal(): void {
    let firstError: {error: unknown} | null = null;
    while (this.first !== null) {
      const id = this.first.id;
      try {
        this.removeInternal(id);
      } catch (error) {
        firstError ??= {error};
      }
    }
    this.registrations = 0;
    if (firstError !== null) throw firstError.error;
  }

  /** Final host disposal is separate from native program-reset clear(). */
  disposeFinal(): void {
    if (!this.finalAdmissionClosed)
      throw new Error('Buriko independent procedure final disposal requires closed admission');
    if (this.activePoll || this.frameLaneToken !== null)
      throw new Error('Buriko independent procedure final disposal requires joined frame polls');
    if (this.finalDisposed) {
      if (this.finalDisposalError !== null) throw this.finalDisposalError.error;
      return;
    }
    this.finalDisposed = true;
    try {
      this.clearFinalInternal();
    } catch (error) {
      this.finalDisposalError = {error};
      throw error;
    }
  }

  /** c2a80 deliberately calls the base poll, while message dispatch remains virtual. */
  async resetEnabled(): Promise<void> {
    return this.resetEnabledInternal(null);
  }

  private async resetEnabledInternal(frameLaneToken: object | null): Promise<void> {
    this.beginPoll(frameLaneToken);
    try {
      const operationAllocator = this.surfaces.allocator,
        operationActor = operationAllocator.currentActor;
      const runAsActor = <T>(operation: () => T): T =>
        operationAllocator.withActor(operationActor, operation);

      for (let entry = this.first; entry !== null; entry = entry.next)
        if (runAsActor(() => entry!.procedure.getEnabled()) !== 0)
          await runAsActor(() => BurikoIndependentProcedure.prototype.poll.call(entry!.procedure));
    } catch (error) {
      this.pollFailure ??= {error};
      throw error;
    } finally {
      this.endPoll();
    }
  }

  /** c2ac0 visits enabled entries newest first and stops at the first nonzero poll result. */
  async pollEnabled(): Promise<0 | 1> {
    return this.pollEnabledInternal(null);
  }

  private async pollEnabledInternal(frameLaneToken: object | null): Promise<0 | 1> {
    this.beginPoll(frameLaneToken);
    try {
      const operationAllocator = this.surfaces.allocator,
        operationActor = operationAllocator.currentActor;
      const runAsActor = <T>(operation: () => T): T =>
        operationAllocator.withActor(operationActor, operation);

      let result: 0 | 1 = 1;
      for (let entry = this.first; entry !== null && result !== 0; entry = entry.next)
        if (runAsActor(() => entry!.procedure.getEnabled()) !== 0)
          result = (await runAsActor(() => entry!.procedure.poll())) === 0 ? 1 : 0;
      return result;
    } catch (error) {
      this.pollFailure ??= {error};
      throw error;
    } finally {
      this.endPoll();
    }
  }
}

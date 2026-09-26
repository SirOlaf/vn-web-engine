import type {
  BurikoBpHandlerResult,
  BurikoBpInstructionResult,
  BurikoBpWaitProcess,
} from '../native/types.js';
import type {BurikoBpThread} from './state.js';
import type {BurikoGridEvaluationWorkers} from '../native/grid-evaluation-workers.js';
import type {BurikoDataCodecWorkers} from '../native/data-codec-workers.js';
import type {BurikoSharedLoaderWorker} from '../native/shared-loader-worker.js';

export const BURIKO_BP_BURST_INSTRUCTIONS = 0x400000;
export type BurikoBpSchedulerResult = 0 | 1 | 2;

/** Scheduler-owned portions of native CThread; root is a non-executable list sentinel. */
export class BurikoBpScheduledThread {
  next: BurikoBpScheduledThread | null = null;
  flags = 0;
  process: BurikoBpWaitProcess | null = null;
  processStopMessagePending = true;
  deadline = 0;
  private readonly messages: number[] = [];

  constructor(
    readonly state: BurikoBpThread,
    private readonly owner: BurikoBpScheduler | null = null,
  ) {}

  enqueueMessage(value: number): void {
    this.messages.push(value >>> 0);
  }

  /** Absence is distinct from a queued zero, including for the native receive retry path. */
  dequeueMessage(): number | undefined {
    return this.messages.shift();
  }

  peekMessage(): number | undefined {
    return this.messages[0];
  }

  installProcess(process: BurikoBpWaitProcess | null): void {
    if (this.process?.hasOutstandingExternalBorrow?.())
      throw new Error('Buriko process replacement retains a borrowed BP destination');
    this.process?.dispose();
    this.process = process;
    this.flags = (this.flags | 1) >>> 0;
  }

  /** 0x140087e10 forwards the latched stop as a single (0,0,0) process message. */
  pollProcess(stopping: boolean, invocationToken?: object): number | Promise<number> {
    if (this.owner !== null)
      return this.owner.pollOwnedProcess(
        () => this.pollProcessUnchecked(stopping),
        invocationToken,
      );
    return this.pollProcessUnchecked(stopping);
  }

  /** The owning scheduler admits this call before invoking the native process. */
  private pollProcessUnchecked(stopping: boolean): number | Promise<number> {
    if (this.process === null) return -1;
    if (stopping && this.processStopMessagePending) {
      this.process.enqueueMessage({code: 0, value1: 0, value2: 0});
      this.processStopMessagePending = false;
    }
    const result = this.process.poll();
    return typeof result === 'number'
      ? this.finishPoll(result)
      : result.then((value) => this.finishPoll(value));
  }

  private finishPoll(value: number): number {
    const result = value | 0;
    if (result === -1 || result === 1) {
      if (this.process?.hasOutstandingExternalBorrow?.())
        throw new Error('Buriko completed process retains a borrowed BP destination');
      // Poll may have installed a replacement. The native code destroys the current pointer.
      this.process?.dispose();
      this.process = null;
      this.flags = (this.flags & ~1) >>> 0;
    }
    return result;
  }

  clearMessages(): void {
    this.messages.length = 0;
  }
}

/** Exact cooperative traversal from 0x1400ec9a0, independent of browser frame timing. */
export class BurikoBpScheduler {
  readonly root: BurikoBpScheduledThread;
  selectedThreadId = 0;
  stopRequested = false;
  exclusiveThread: BurikoBpScheduledThread | null = null;
  exclusiveMode = false;
  private running = false;
  private invocationToken: object | null = null;
  private dispatchingInstruction: BurikoBpThread | null = null;
  private processPollToken: object | null = null;
  private finalAdmissionClosed = false;
  private pendingNativeCallbacks: (() => boolean) | null = null;
  private processPollDrainWaiters: Array<() => void> = [];
  private invocationDrainWaiters: Array<() => void> = [];
  private gridEvaluationWorkers: BurikoGridEvaluationWorkers | null = null;
  private dataCodecWorkers: BurikoDataCodecWorkers | null = null;
  private sharedLoaderWorker: BurikoSharedLoaderWorker | null = null;
  private executeInstruction: ((thread: BurikoBpThread) => BurikoBpInstructionResult) | null;

  constructor(
    root: BurikoBpThread,
    executeInstruction?: (thread: BurikoBpThread) => BurikoBpInstructionResult,
    private readonly onThreadRemoved?: (thread: BurikoBpScheduledThread) => void,
  ) {
    this.root = new BurikoBpScheduledThread(root, this);
    this.executeInstruction = executeInstruction ?? null;
  }

  get hasActiveProcessPoll(): boolean {
    return this.processPollToken !== null;
  }

  get hasActiveInvocation(): boolean {
    return this.invocationToken !== null;
  }

  /** A native callback may enter only on the current synchronous instruction stack. */
  isDispatchingInstructionFor(thread: BurikoBpThread): boolean {
    return this.invocationToken !== null && this.dispatchingInstruction === thread;
  }

  get processPollAdmissionClosed(): boolean {
    return this.finalAdmissionClosed;
  }

  /** The mounted VM supplies its direct-callback and independent-frame exclusion once. */
  bindProcessPollGuard(pending: () => boolean): void {
    if (this.pendingNativeCallbacks !== null || this.finalAdmissionClosed)
      throw new Error('Buriko scheduler process-poll guard is already bound');
    this.pendingNativeCallbacks = pending;
  }

  beginFinalClose(): void {
    this.finalAdmissionClosed = true;
  }

  private beginProcessPoll(invocationToken?: object): object {
    // A run admitted before final close may reach another child after close ingress;
    // core.close joins that entire invocation before removing its children.
    if (invocationToken === undefined && this.finalAdmissionClosed)
      throw new Error('Buriko scheduler process-poll admission is closed');
    if (
      invocationToken === undefined
        ? this.invocationToken !== null
        : this.invocationToken !== invocationToken || !this.running
    )
      throw new Error('Buriko scheduler invocation excludes a direct process poll');
    if (this.processPollToken !== null)
      throw new Error('Buriko scheduler process poll is already active');
    if (this.pendingNativeCallbacks?.())
      throw new Error('Buriko scheduler process poll overlaps native or frame work');
    const token = {};
    this.processPollToken = token;
    return token;
  }

  private endProcessPoll(token: object): void {
    if (this.processPollToken !== token)
      throw new Error('Buriko scheduler process-poll token is stale');
    this.processPollToken = null;
    const waiters = this.processPollDrainWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  async joinPendingProcessPoll(): Promise<void> {
    if (this.processPollToken !== null)
      await new Promise<void>((resolve) => this.processPollDrainWaiters.push(resolve));
  }

  private beginInvocation(): object {
    if (this.finalAdmissionClosed)
      throw new Error('Buriko scheduler invocation admission is closed');
    if (this.invocationToken !== null || this.processPollToken !== null)
      throw new Error('Buriko scheduler invocation overlaps a process poll');
    if (this.pendingNativeCallbacks?.())
      throw new Error('Buriko scheduler invocation overlaps native or frame work');
    const token = {};
    this.invocationToken = token;
    return token;
  }

  private endInvocation(token: object): void {
    if (this.invocationToken !== token)
      throw new Error('Buriko scheduler invocation token is stale');
    this.invocationToken = null;
    const waiters = this.invocationDrainWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  async joinPendingInvocation(): Promise<void> {
    if (this.invocationToken !== null)
      await new Promise<void>((resolve) => this.invocationDrainWaiters.push(resolve));
  }

  /** Direct child polls retain a lease through asynchronous process settlement. */
  pollOwnedProcess(
    poll: () => number | Promise<number>,
    invocationToken?: object,
  ): number | Promise<number> {
    const token = this.beginProcessPoll(invocationToken);
    try {
      const result = poll();
      if (typeof result === 'number') {
        this.endProcessPoll(token);
        return result;
      }
      return result.then(
        (value) => {
          this.endProcessPoll(token);
          return value;
        },
        (error: unknown) => {
          this.endProcessPoll(token);
          throw error;
        },
      );
    } catch (error) {
      this.endProcessPoll(token);
      throw error;
    }
  }

  /** The aggregate installs its complete interpreter after slot factories receive this scheduler. */
  bindInstructionExecutor(
    executeInstruction: (thread: BurikoBpThread) => BurikoBpInstructionResult,
  ): void {
    if (this.executeInstruction !== null)
      throw new Error('Buriko scheduler instruction executor is already bound');
    if (typeof executeInstruction !== 'function')
      throw new TypeError('Buriko scheduler instruction executor must be a function');
    this.executeInstruction = executeInstruction;
  }

  get firstThread(): BurikoBpScheduledThread | null {
    return this.root.next;
  }

  /** The native evaluator owns its tasks; the VM only gives the browser event loop a scheduling point. */
  attachGridEvaluationWorkers(workers: BurikoGridEvaluationWorkers): void {
    if (this.gridEvaluationWorkers !== null && this.gridEvaluationWorkers !== workers)
      throw new Error('Buriko scheduler already has its native grid evaluator workers');
    this.gridEvaluationWorkers = workers;
  }

  private yieldBackgroundWork(): Promise<void> | undefined {
    const gridPending = this.gridEvaluationWorkers?.hasPendingWork() ?? false,
      codecPending = this.dataCodecWorkers?.hasPendingWork() ?? false,
      loaderPending = this.sharedLoaderWorker?.hasPendingWork() ?? false;
    if (gridPending || codecPending || loaderPending)
      return new Promise<void>((resolve) => setTimeout(resolve, 0));
    return undefined;
  }

  attachDataCodecWorkers(workers: BurikoDataCodecWorkers): void {
    if (this.dataCodecWorkers !== null && this.dataCodecWorkers !== workers)
      throw new Error('Buriko scheduler already has its native data codec workers');
    this.dataCodecWorkers = workers;
  }

  attachSharedLoaderWorker(worker: BurikoSharedLoaderWorker): void {
    if (this.sharedLoaderWorker !== null && this.sharedLoaderWorker !== worker)
      throw new Error('Buriko scheduler already has its shared loader worker');
    this.sharedLoaderWorker = worker;
  }

  append(thread: BurikoBpThread): BurikoBpScheduledThread {
    const node = new BurikoBpScheduledThread(thread, this);
    let last = this.root;
    while (last.next !== null) last = last.next;
    last.next = node;
    return node;
  }

  findById(id: number): BurikoBpScheduledThread | null {
    if (id >>> 0 === 0) return null;
    let node: BurikoBpScheduledThread | null = this.root;
    while (node !== null) {
      if (node.state.id === id >>> 0) return node;
      node = node.next;
    }
    return null;
  }

  remove(thread: BurikoBpScheduledThread): boolean {
    let previous = this.root;
    let node = this.root.next;
    while (node !== null) {
      if (node === thread) {
        if (node.process?.hasOutstandingExternalBorrow?.())
          throw new Error('Buriko child removal retains a borrowed BP destination');
        // This process publishes to the operand stack in dispose(). Retire it
        // while the child still owns that stack, before native-order storage teardown.
        if (node.process?.needsLiveOperandStorageOnDispose?.()) node.installProcess(null);
        previous.next = node.next;
        this.destroy(node);
        this.onThreadRemoved?.(node);
        return true;
      }
      previous = node;
      node = node.next;
    }
    return false;
  }

  /** 888E0 retires the root's linked descendants from the tail back to the sentinel. */
  removeAllChildren(): void {
    if (this.running || this.invocationToken !== null || this.processPollToken !== null)
      throw new Error('Buriko child-tree teardown requires an idle scheduler');
    for (let node = this.root.next; node !== null; node = node.next)
      if (node.process?.hasOutstandingExternalBorrow?.())
        throw new Error('Buriko child-tree teardown retains a borrowed BP destination');
    while (this.root.next !== null) {
      let last = this.root.next;
      while (last.next !== null) last = last.next;
      if (!this.remove(last)) throw new Error('Buriko child-tree teardown lost its linked tail');
    }
  }

  private destroy(node: BurikoBpScheduledThread): void {
    if (
      node.process?.hasOutstandingExternalBorrow?.() ||
      node.process?.needsLiveOperandStorageOnDispose?.()
    )
      throw new Error('Buriko child destruction requires live-storage process retirement');
    // DCTChildThread first releases its owner's reservation in disposeStorage().
    // CThread then frees storage/heap/modules/call records before its pending process.
    node.state.disposeStorage();
    node.process?.dispose();
    node.process = null;
    node.clearMessages();
    while (node.state.moduleReservations.length !== 0) {
      const borrower = node.state.moduleReservations[0]!.borrower;
      const child = this.findById(borrower.id);
      if (child === null || child.state !== borrower) {
        throw new Error('Buriko thread reservation points to an unlinked borrower');
      }
      this.remove(child);
    }
  }

  async run(): Promise<BurikoBpSchedulerResult> {
    if (this.running) throw new Error('Buriko scheduler invocation is already in progress');
    const executeInstruction = this.executeInstruction;
    if (executeInstruction === null)
      throw new Error('Buriko scheduler instruction executor is not bound');
    const token = this.beginInvocation();
    this.running = true;
    try {
      return await this.runInvocation(executeInstruction, token);
    } finally {
      this.running = false;
      this.endInvocation(token);
    }
  }

  private async runInvocation(
    executeInstruction: (thread: BurikoBpThread) => BurikoBpInstructionResult,
    invocationToken: object,
  ): Promise<BurikoBpSchedulerResult> {
    let stop = this.stopRequested;
    let condition = false;
    let node = this.root.next;
    while (node !== null) {
      if (this.exclusiveMode && node !== this.exclusiveThread) {
        node = node.next;
        continue;
      }
      if ((node.flags & 0x80000000) !== 0) {
        const terminated = node;
        node = node.next;
        if (
          terminated.state.retentionCount === 0 &&
          !terminated.process?.hasOutstandingExternalBorrow?.()
        )
          this.remove(terminated);
        continue;
      }
      if ((node.flags & 1) !== 0) {
        const pollResult = node.pollProcess(stop, invocationToken);
        const processResult = typeof pollResult === 'number' ? pollResult : await pollResult;
        if (processResult === 0 || processResult === -1) {
          if (processResult === -1) stop = true;
          node = node.next;
          continue;
        }
      }
      // Stop still permits polling and terminated-node removal on subsequent nodes.
      if (stop) {
        node = node.next;
        continue;
      }
      let result: BurikoBpHandlerResult = 0;
      for (let count = 0; count < BURIKO_BP_BURST_INSTRUCTIONS; count++) {
        let instruction: BurikoBpInstructionResult;
        this.dispatchingInstruction = node.state;
        try {
          instruction = executeInstruction(node.state);
        } finally {
          // A returned Promise keeps its callback lease, but cannot admit a new callback.
          this.dispatchingInstruction = null;
        }
        result = typeof instruction === 'number' ? instruction : await instruction;
        if (result !== 0) break;
      }
      switch (result) {
        case 0:
        case 1:
          node = node.next;
          break;
        case 2:
          break;
        case 3:
          node = this.findById(this.selectedThreadId);
          break;
        case 4:
          node.flags = (node.flags | 0x80000000) >>> 0;
          break;
        case 5:
          condition = true;
          node = node.next;
          break;
        case 6:
          stop = true;
          node = node.next;
          break;
        default:
          // The x64 dispatch also advances for values outside its six special cases.
          node = node.next;
          break;
      }
      const work = this.yieldBackgroundWork();
      if (work !== undefined) await work;
    }
    // An invocation that only polled waiting processes still cannot starve a native worker.
    const work = this.yieldBackgroundWork();
    if (work !== undefined) await work;
    return stop ? 1 : condition ? 2 : 0;
  }
}

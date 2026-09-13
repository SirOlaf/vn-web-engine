import type {
  AokanaBpHandlerResult,
  AokanaBpInstructionResult,
  AokanaBpWaitProcess,
} from '../native/types.js';
import type {AokanaBpThread} from './state.js';
import type {AokanaGridEvaluationWorkers} from '../native/grid-evaluation-workers.js';

export const AOKANA_BP_BURST_INSTRUCTIONS = 0x400000;
export type AokanaBpSchedulerResult = 0 | 1 | 2;

/** Scheduler-owned portions of native CThread; root is a non-executable list sentinel. */
export class AokanaBpScheduledThread {
  next: AokanaBpScheduledThread | null = null;
  flags = 0;
  process: AokanaBpWaitProcess | null = null;
  processStopMessagePending = true;
  deadline = 0;
  private readonly messages: number[] = [];

  constructor(readonly state: AokanaBpThread) {}

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

  installProcess(process: AokanaBpWaitProcess | null): void {
    this.process?.dispose();
    this.process = process;
    this.flags = (this.flags | 1) >>> 0;
  }

  /** 0x140087e10 forwards the latched stop as a single (0,0,0) process message. */
  pollProcess(stopping: boolean): number | Promise<number> {
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
export class AokanaBpScheduler {
  readonly root: AokanaBpScheduledThread;
  selectedThreadId = 0;
  stopRequested = false;
  exclusiveThread: AokanaBpScheduledThread | null = null;
  exclusiveMode = false;
  private running = false;
  private gridEvaluationWorkers: AokanaGridEvaluationWorkers | null = null;

  constructor(
    root: AokanaBpThread,
    private readonly executeInstruction: (thread: AokanaBpThread) => AokanaBpInstructionResult,
    private readonly onThreadRemoved?: (thread: AokanaBpScheduledThread) => void,
  ) {
    this.root = new AokanaBpScheduledThread(root);
  }

  get firstThread(): AokanaBpScheduledThread | null {
    return this.root.next;
  }

  /** The native evaluator owns its tasks; the VM only gives the browser event loop a scheduling point. */
  attachGridEvaluationWorkers(workers: AokanaGridEvaluationWorkers): void {
    if (this.gridEvaluationWorkers !== null && this.gridEvaluationWorkers !== workers)
      throw new Error('Aokana scheduler already has its native grid evaluator workers');
    this.gridEvaluationWorkers = workers;
  }

  private yieldBackgroundWork(): Promise<void> | undefined {
    if (this.gridEvaluationWorkers?.hasPendingWork())
      return new Promise<void>((resolve) => setTimeout(resolve, 0));
    return undefined;
  }

  append(thread: AokanaBpThread): AokanaBpScheduledThread {
    const node = new AokanaBpScheduledThread(thread);
    let last = this.root;
    while (last.next !== null) last = last.next;
    last.next = node;
    return node;
  }

  findById(id: number): AokanaBpScheduledThread | null {
    if (id >>> 0 === 0) return null;
    let node: AokanaBpScheduledThread | null = this.root;
    while (node !== null) {
      if (node.state.id === id >>> 0) return node;
      node = node.next;
    }
    return null;
  }

  remove(thread: AokanaBpScheduledThread): boolean {
    let previous = this.root;
    let node = this.root.next;
    while (node !== null) {
      if (node === thread) {
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

  private destroy(node: AokanaBpScheduledThread): void {
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
        throw new Error('Aokana thread reservation points to an unlinked borrower');
      }
      this.remove(child);
    }
  }

  async run(): Promise<AokanaBpSchedulerResult> {
    if (this.running) throw new Error('Aokana scheduler invocation is already in progress');
    this.running = true;
    try {
      return await this.runInvocation();
    } finally {
      this.running = false;
    }
  }

  private async runInvocation(): Promise<AokanaBpSchedulerResult> {
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
        if (terminated.state.retentionCount === 0) this.remove(terminated);
        continue;
      }
      if ((node.flags & 1) !== 0) {
        const pollResult = node.pollProcess(stop);
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
      let result: AokanaBpHandlerResult = 0;
      for (let count = 0; count < AOKANA_BP_BURST_INSTRUCTIONS; count++) {
        const instruction = this.executeInstruction(node.state);
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

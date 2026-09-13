import {push32, type AokanaBpThread} from '../bp/state.js';
import type {AokanaNativeClock} from './clock.js';
import type {AokanaDiagnosticDialogs} from './modal.js';
import type {AokanaNativeInput} from './input.js';
import type {AokanaBpProcessMessage, AokanaBpWaitProcess} from './types.js';

/** Executable globals shared by every CProcedure and the outer native controller. */
export class AokanaProcedureState {
  nextId = 0;
  enabled = 1;
}

/** The actual CProcedure FIFO, stop override, DWORD deadline, and lifetime fields. */
export abstract class AokanaProcedure implements AokanaBpWaitProcess {
  readonly id: number;
  deadline = 0;
  completionRequested = false;
  private stopped = false;
  private enabledOverride = false;
  private readonly messages: AokanaBpProcessMessage[] = [];

  constructor(
    readonly thread: AokanaBpThread,
    protected readonly shared: AokanaProcedureState,
    protected readonly clock: AokanaNativeClock,
  ) {
    this.id = shared.nextId;
    shared.nextId = (shared.nextId + 1) >>> 0;
  }

  enqueueMessage(message: AokanaBpProcessMessage): void {
    this.messages.push({
      code: message.code >>> 0,
      value1: message.value1 >>> 0,
      value2: message.value2 >>> 0,
    });
  }

  protected consumeMessages(): void {
    let message: AokanaBpProcessMessage | undefined;
    while ((message = this.messages.shift()) !== undefined) {
      if (message.code === 0) {
        this.stopped = true;
        return;
      }
      if (message.code === 3) this.enabledOverride = true;
      else this.handleMessage(message);
    }
  }

  /** Base vtable +0x30 is the verified empty 0x14006fd00 procedure message handler. */
  protected handleMessage(_message: AokanaBpProcessMessage): void {}

  protected canRun(): boolean {
    return (this.enabledOverride || this.shared.enabled !== 0) && !this.stopped;
  }

  setDeadline(duration: number): void {
    this.deadline = (Number(BigInt.asUintN(32, this.clock.read())) + duration) >>> 0;
  }

  protected deadlineReached(): boolean {
    // Vtable+18's 0x14006fe40 explicitly MOV EAX,EAX before this unsigned comparison.
    return this.deadline <= Number(BigInt.asUintN(32, this.clock.read()));
  }

  abstract poll(): number | Promise<number>;

  dispose(): void {
    this.messages.length = 0;
  }
}

/** 0x14007ea00: timeout completion is tested before the enabled/stop state. */
export class AokanaWaitTiming extends AokanaProcedure {
  constructor(
    thread: AokanaBpThread,
    shared: AokanaProcedureState,
    clock: AokanaNativeClock,
    duration: number,
  ) {
    super(thread, shared, clock);
    this.setDeadline(duration);
  }

  poll(): number {
    this.consumeMessages();
    return this.deadlineReached() || !this.canRun() ? 1 : 0;
  }
}

/** 0x14007ead0: input completion pushes one; elapsed/stopped/message completion pushes zero. */
export class AokanaWaitTimingEx extends AokanaProcedure {
  private finishRequested = false;
  private readonly token: number;

  constructor(
    thread: AokanaBpThread,
    shared: AokanaProcedureState,
    clock: AokanaNativeClock,
    private readonly input: AokanaNativeInput,
    duration: number,
    private readonly inputEnabled: number,
    keyGroup: number,
  ) {
    super(thread, shared, clock);
    this.setDeadline(duration);
    this.token = ((keyGroup << 16) | 0xffff) >>> 0;
    if (inputEnabled !== 0) {
      input.installPointerCapture(this.token);
      input.installKeyCapture(this.token);
      input.collect(this.token, this.token);
    }
  }

  protected override handleMessage(message: AokanaBpProcessMessage): void {
    if (message.code === 1) this.finishRequested = true;
  }

  poll(): number {
    this.consumeMessages();
    let inputFinished = 0;
    if (!this.deadlineReached() && this.canRun() && !this.finishRequested) {
      if (this.inputEnabled === 0) return 0;
      const collected = this.input.collect(this.token, this.token);
      if (((this.input.allowMask | 0x80000181) & collected) === 0) return 0;
      inputFinished = 1;
    }
    push32(this.thread, inputFinished);
    return 1;
  }

  override dispose(): void {
    if (this.inputEnabled !== 0) {
      this.input.releasePointerCapture(this.token);
      this.input.releaseKeyCapture(this.token);
    }
    super.dispose();
  }
}

interface WindowMessageRecord {
  readonly thread: AokanaBpThread;
  readonly message: number;
  value1: bigint;
  value2: bigint;
  received: boolean;
}

/** 0x1401009a0/9f0/940 and 0x1400fee00: newest registration first, broadcast delivery. */
export class AokanaWindowMessages {
  private readonly records: WindowMessageRecord[] = [];

  register(thread: AokanaBpThread, message: number): void {
    this.records.unshift({thread, message: message >>> 0, value1: 0n, value2: 0n, received: false});
  }

  unregister(thread: AokanaBpThread, message: number): void {
    const index = this.records.findIndex(
      (record) => record.thread === thread && record.message === message >>> 0,
    );
    if (index >= 0) this.records.splice(index, 1);
  }

  dispatch(message: number, value1: bigint, value2: bigint): void {
    for (const record of this.records) {
      if (record.message === message >>> 0) {
        record.value1 = BigInt.asUintN(64, value1);
        record.value2 = BigInt.asUintN(64, value2);
        record.received = true;
      }
    }
  }

  consume(thread: AokanaBpThread, message: number): WindowMessageRecord | null {
    const record = this.records.find(
      (entry) => entry.thread === thread && entry.message === message >>> 0,
    );
    if (record === undefined) return null;
    const snapshot = {...record};
    record.received = false;
    return snapshot;
  }

  clear(): void {
    this.records.length = 0;
  }
}

/** This procedure calls MessageBoxA directly; it does not use the engine modal wrapper. */
export class AokanaWaitWindowMessage extends AokanaProcedure {
  constructor(
    thread: AokanaBpThread,
    shared: AokanaProcedureState,
    clock: AokanaNativeClock,
    private readonly registry: AokanaWindowMessages,
    private readonly dialogs: AokanaDiagnosticDialogs,
    private readonly message: number,
  ) {
    super(thread, shared, clock);
    registry.register(thread, message);
  }

  poll(): number | Promise<number> {
    this.consumeMessages();
    const event = this.registry.consume(this.thread, this.message);
    if (event === null) {
      return this.dialogs
        .show({
          title: 'バグ発見！！',
          text: '検出対象となるWindowsMessageが削除されてしまっている',
          buttons: 'ok',
        })
        .then(() => 1);
    }
    if (!this.canRun()) {
      push32(this.thread, 0xffffffff);
      push32(this.thread, 0xffffffff);
      return 1;
    }
    if (!event.received) return 0;
    push32(this.thread, Number(BigInt.asUintN(32, event.value1)));
    push32(this.thread, Number(BigInt.asUintN(32, event.value2)));
    return 1;
  }

  override dispose(): void {
    this.registry.unregister(this.thread, this.message);
    super.dispose();
  }
}

import type {AokanaNativeInput} from './input.js';

/** Native HWND identity; numeric window tokens are independent of script-visible 0xf8 handles. */
export type AokanaWindowTarget = 'main' | number;
export interface AokanaWindowMessage {
  readonly target: AokanaWindowTarget;
  readonly message: number;
  readonly wParam: number | bigint;
  readonly lParam: number | bigint;
}
export interface AokanaWindowMessageReceiver {
  receive(message: AokanaWindowMessage): number | bigint;
}
export type AokanaQueuedNumericReceiver = (
  message: AokanaWindowMessage,
) => boolean | Promise<boolean>;
export interface AokanaDispatchedWindowMessage {
  readonly message: AokanaWindowMessage;
  readonly result: number | bigint;
}
interface QueuedMessage {
  readonly kind: 'window';
  readonly message: AokanaWindowMessage;
  readonly physicalTransitions: readonly {readonly key: number; readonly down: boolean}[];
}
export type AokanaPostedWindowEvent =
  | {readonly kind: 'window'; readonly message: AokanaWindowMessage}
  | {readonly kind: 'quit'; readonly exitCode: number};
export type AokanaPumpWindowEvent = AokanaPostedWindowEvent;
interface QueuedQuit {
  readonly kind: 'quit';
  readonly exitCode: number;
}
interface QueuedInputReset {
  readonly kind: 'input-reset';
  readonly keys: readonly number[];
}

function nativeParameter(value: number | bigint): number | bigint {
  if (typeof value === 'bigint') {
    if (value < -0x8000000000000000n || value > 0xffffffffffffffffn)
      throw new RangeError('Aokana window message parameter exceeds native pointer width');
  } else if (!Number.isSafeInteger(value)) {
    throw new RangeError('Aokana window message parameter requires an exact integer or bigint');
  }
  return value;
}

/** The native GUI thread's FIFO, shared by real input and PostMessageW senders. */
export class AokanaWindowMessages {
  private readonly queue: (QueuedMessage | QueuedQuit | QueuedInputReset)[] = [];
  private first = 0;
  private nextTarget = 0;
  private readonly targets = new Set<AokanaWindowTarget>();
  private readonly invalidated = new Set<AokanaWindowTarget>();
  private readonly paintInFlight = new Map<AokanaWindowTarget, AokanaWindowMessage>();
  private readonly generatedPaint = new WeakSet<AokanaWindowMessage>();
  private readonly physicalMessages = new WeakSet<AokanaWindowMessage>();
  private readonly numericReceivers = new Map<number, AokanaQueuedNumericReceiver>();
  private mainReceiver: AokanaWindowMessageReceiver | null = null;
  constructor(readonly input: AokanaNativeInput) {}

  createTarget(): number {
    if (this.nextTarget === 0xffffffff)
      throw new RangeError('Aokana browser window identity table is exhausted');
    const target = ++this.nextTarget;
    this.targets.add(target);
    return target;
  }

  /** Called by the concrete main-window profile when its native window is created. */
  createMainTarget(): 'main' {
    this.targets.add('main');
    return 'main';
  }

  /** The concrete main-window profile installs its one synchronous, re-entrant receiver here. */
  bindMainReceiver(receiver: AokanaWindowMessageReceiver): void {
    if (this.mainReceiver !== null && this.mainReceiver !== receiver)
      throw new Error('Aokana main-window receiver is already bound');
    this.mainReceiver = receiver;
  }

  hasMainReceiver(receiver: AokanaWindowMessageReceiver): boolean {
    return this.mainReceiver === receiver;
  }

  /** Current native HWND global: null represents a not-yet-created or destroyed main window. */
  mainTarget(): 'main' | null {
    return this.targets.has('main') ? 'main' : null;
  }

  hasTarget(target: AokanaWindowTarget): boolean {
    return this.targets.has(target);
  }

  /** One live numeric HWND is routed to its actual awaitable owner at dequeue. */
  bindQueuedNumericTarget(target: number, receiver: AokanaQueuedNumericReceiver): void {
    if (!this.targets.has(target) || !Number.isInteger(target) || target <= 0)
      throw new Error('Aokana queued numeric receiver requires a live target');
    if (this.numericReceivers.has(target))
      throw new Error('Aokana queued numeric target already has a receiver');
    this.numericReceivers.set(target, receiver);
  }

  /** This path is independent of synchronous SendMessage and main HWND dispatch. */
  async dispatchQueuedNumeric(message: AokanaWindowMessage): Promise<boolean> {
    if (typeof message.target !== 'number')
      throw new TypeError('Aokana queued numeric dispatch requires a numeric target');
    if (!this.targets.has(message.target)) return false;
    const receiver = this.numericReceivers.get(message.target);
    if (receiver === undefined)
      throw new Error('Aokana live numeric target has no queued receiver');
    return receiver(message);
  }

  /** Browser default EDIT actions already ran for these messages before native dequeue. */
  isPhysical(message: AokanaWindowMessage): boolean {
    return this.physicalMessages.has(message);
  }

  get pending(): number {
    return this.queue.length - this.first + this.invalidated.size;
  }

  /** Invalid regions coalesce; generated paint follows ordinary posted/input messages. */
  invalidate(target: AokanaWindowTarget): void {
    if (!this.paintInFlight.has(target)) this.invalidated.add(target);
  }

  /** InvalidateRect(NULL,NULL,TRUE) over the title's actual HWND registry. */
  invalidateAll(): void {
    for (const target of this.targets) this.invalidate(target);
  }

  private generatePaint(target: AokanaWindowTarget): AokanaWindowMessage {
    this.invalidated.delete(target);
    const message = {target, message: 0xf, wParam: 0, lParam: 0};
    this.paintInFlight.set(target, message);
    this.generatedPaint.add(message);
    return message;
  }

  isGeneratedPaint(message: AokanaWindowMessage): boolean {
    return this.generatedPaint.has(message);
  }

  /** BeginPaint validates the region after the receiver's wait broadcast. */
  validatePaint(message: AokanaWindowMessage): void {
    if (message.message !== 0xf) throw new Error('Aokana paint validation requires WM_PAINT');
    if (this.generatedPaint.has(message)) {
      if (this.paintInFlight.get(message.target) === message)
        this.paintInFlight.delete(message.target);
    } else this.invalidated.delete(message.target);
  }

  /** An unsuccessful generated dispatch leaves its invalidation available to retry. */
  releasePaint(message: AokanaWindowMessage): void {
    if (this.paintInFlight.get(message.target) !== message) return;
    this.paintInFlight.delete(message.target);
    if (this.targets.has(message.target)) this.invalidated.add(message.target);
  }

  /** UpdateWindow dispatches only this pending paint, without consuming the posted/input FIFO. */
  takePaint(target: AokanaWindowTarget): AokanaWindowMessage | null {
    if (!this.invalidated.has(target)) return null;
    return this.generatePaint(target);
  }

  /** Window destruction drops its invalid region, without rewriting ordinary queued messages. */
  forgetTarget(target: AokanaWindowTarget): void {
    this.invalidated.delete(target);
    this.paintInFlight.delete(target);
    this.targets.delete(target);
    if (typeof target === 'number') this.numericReceivers.delete(target);
  }

  private append(
    message: AokanaWindowMessage,
    physicalTransitions: QueuedMessage['physicalTransitions'],
    physical = false,
    priority = false,
  ): void {
    const copy: AokanaWindowMessage = {
      target: message.target === 'main' ? 'main' : message.target >>> 0,
      message: message.message >>> 0,
      wParam: nativeParameter(message.wParam),
      lParam: nativeParameter(message.lParam),
    };
    if (physical) this.physicalMessages.add(copy);
    const entry = {
      kind: 'window' as const,
      message: copy,
      physicalTransitions: physicalTransitions.map((transition) => ({...transition})),
    };
    // Later host input cannot overtake a quit already posted by WM_DESTROY.
    if (priority && !this.queue.slice(this.first).some((queued) => queued.kind === 'quit'))
      this.queue.splice(this.first, 0, entry);
    else this.queue.push(entry);
  }

  /** A synthetic keyboard PostMessage does not change GetAsyncKeyState or GetKeyboardState. */
  post(message: AokanaWindowMessage): void {
    this.append(message, []);
  }

  /** PostQuitMessage is a GUI-thread event after the existing FIFO tail, not a HWND message. */
  postQuit(exitCode: number): void {
    this.queue.push({kind: 'quit', exitCode: exitCode | 0});
  }

  /** SendMessage's synchronous path; null targets retain its zero-result behavior. */
  send(
    target: AokanaWindowTarget | null,
    message: number,
    wParam: number | bigint,
    lParam: number | bigint,
  ): number | bigint {
    if (target === null) return 0;
    return this.dispatch({
      target,
      message: message >>> 0,
      wParam: nativeParameter(wParam),
      lParam: nativeParameter(lParam),
    });
  }

  /** Both direct sends and the GUI dequeue path enter this same receiver synchronously. */
  dispatch(message: AokanaWindowMessage): number | bigint {
    if (!this.targets.has(message.target)) return 0;
    if (message.target === 'main') return this.mainReceiver?.receive(message) ?? 0;
    return 0;
  }

  /** Host input changes asynchronous state at arrival and queued keyboard state at dequeue. */
  enqueuePhysicalKey(
    target: AokanaWindowTarget,
    key: number,
    down: boolean,
    lParam: number | bigint,
    message = down ? 0x100 : 0x101,
  ): void {
    this.enqueuePhysicalTransitions({target, message, wParam: key, lParam}, [{key, down}]);
  }

  /** Generic modifier and left/right modifier state travel with the same native message. */
  enqueuePhysicalTransitions(
    message: AokanaWindowMessage,
    transitions: readonly {readonly key: number; readonly down: boolean}[],
    priority = false,
  ): void {
    for (const {key, down} of transitions) this.input.setPhysicalKey(key, down);
    this.append(message, transitions, true, priority);
  }

  /** PeekMessage-style mouse motion coalesces only with the unconsumed physical move at the FIFO tail. */
  enqueuePhysicalMouseMove(wParam: number, lParam: number): void {
    const tailIndex = this.queue.length - 1,
      tail = tailIndex >= this.first ? this.queue[tailIndex] : undefined,
      message: AokanaWindowMessage = {target: 'main', message: 0x200, wParam, lParam};
    if (
      tail?.kind === 'window' &&
      tail.message.target === 'main' &&
      tail.message.message === 0x200 &&
      tail.physicalTransitions.length === 0 &&
      this.physicalMessages.has(tail.message)
    ) {
      this.physicalMessages.add(message);
      this.queue[tailIndex] = {kind: 'window', message, physicalTransitions: []};
      return;
    }
    this.append(message, [], true);
  }

  /** Browser focus loss releases async state now and dequeued state after older input. */
  releasePhysicalKeys(keys: readonly number[]): void {
    const unique = [...new Set(keys)];
    if (unique.length === 0) return;
    this.input.releasePhysicalKeys(unique);
    this.input.releaseDequeuedKeys(unique);
    const entry: QueuedInputReset = {kind: 'input-reset', keys: unique};
    const quit = this.queue.findIndex((item, index) => index >= this.first && item.kind === 'quit');
    if (quit < 0) this.queue.push(entry);
    else this.queue.splice(quit, 0, entry);
  }

  private drainInputResets(): void {
    while (this.queue[this.first]?.kind === 'input-reset') {
      const entry = this.queue[this.first] as QueuedInputReset;
      this.advanceQueue();
      this.input.releaseDequeuedKeys(entry.keys);
    }
  }

  /** The concrete window-message loop dispatches the returned message after this transition. */
  take(): AokanaWindowMessage | null {
    this.drainInputResets();
    const entry = this.queue[this.first];
    if (entry === undefined) {
      const next = this.invalidated.values().next();
      if (next.done) return null;
      return this.generatePaint(next.value);
    }
    if (entry.kind === 'quit')
      throw new Error('Aokana thread quit requires the posted-event dequeue');
    if (entry.kind === 'input-reset') throw new Error('Aokana input reset was not drained');
    return this.dequeueWindow(entry);
  }

  /** Posted FIFO only. A paint invalidation never becomes a synthetic posted event. */
  takePostedEvent(): AokanaPostedWindowEvent | null {
    this.drainInputResets();
    const entry = this.queue[this.first];
    if (entry === undefined) return null;
    if (entry.kind === 'quit') {
      this.advanceQueue();
      return {kind: 'quit', exitCode: entry.exitCode};
    }
    if (entry.kind === 'input-reset') throw new Error('Aokana input reset was not drained');
    return {kind: 'window', message: this.dequeueWindow(entry)};
  }

  /** PeekMessageW's thread-wide removal order, including generated invalid-region paint. */
  takePumpEvent(): AokanaPumpWindowEvent | null {
    const posted = this.takePostedEvent();
    if (posted !== null) return posted;
    const next = this.invalidated.values().next();
    if (next.done) return null;
    return {kind: 'window', message: this.generatePaint(next.value)};
  }

  private dequeueWindow(entry: QueuedMessage): AokanaWindowMessage {
    this.advanceQueue();
    for (const {key, down} of entry.physicalTransitions) this.input.setDequeuedKey(key, down);
    return entry.message;
  }

  private advanceQueue(): void {
    this.first++;
    if (this.first === this.queue.length) {
      this.queue.length = 0;
      this.first = 0;
    }
  }

  /** The concrete GUI pump's dequeue-and-dispatch boundary. */
  dispatchNext(): AokanaDispatchedWindowMessage | null {
    const message = this.take();
    if (message === null) return null;
    if (message.message === 0xf) {
      this.releasePaint(message);
      throw new Error('Aokana WM_PAINT requires awaited queued dispatch');
    }
    try {
      return {message, result: this.dispatch(message)};
    } catch (error) {
      this.releasePaint(message);
      throw error;
    }
  }
}

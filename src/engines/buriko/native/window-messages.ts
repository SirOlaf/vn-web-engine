import type {BurikoNativeInput} from './input.js';
import type {BurikoNativeTouchSample} from './touch-input.js';
import type {WindowsKeyCharacterEvidence} from '../../../platform/windows-character-translation.js';

/** Native HWND identity; numeric window tokens are independent of script-visible 0xf8 handles. */
export type BurikoWindowTarget = 'main' | number;
export interface BurikoWindowMessage {
  readonly target: BurikoWindowTarget;
  readonly message: number;
  readonly wParam: number | bigint;
  readonly lParam: number | bigint;
}
export interface BurikoWindowMessageReceiver {
  receive(message: BurikoWindowMessage): number | bigint;
}
export type BurikoQueuedNumericReceiver = (
  message: BurikoWindowMessage,
) => boolean | Promise<boolean>;
export interface BurikoDispatchedWindowMessage {
  readonly message: BurikoWindowMessage;
  readonly result: number | bigint;
}
interface QueuedMessage {
  readonly kind: 'window';
  readonly message: BurikoWindowMessage;
  readonly physicalTransitions: readonly {readonly key: number; readonly down: boolean}[];
}
export type BurikoPostedWindowEvent =
  | {readonly kind: 'window'; readonly message: BurikoWindowMessage}
  | {readonly kind: 'quit'; readonly exitCode: number};
export type BurikoPumpWindowEvent = BurikoPostedWindowEvent;
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
      throw new RangeError('Buriko window message parameter exceeds native pointer width');
  } else if (!Number.isSafeInteger(value)) {
    throw new RangeError('Buriko window message parameter requires an exact integer or bigint');
  }
  return value;
}

/** The native GUI thread's FIFO, shared by real input and PostMessageW senders. */
export class BurikoWindowMessages {
  private readonly cdNotifications = new WeakMap<BurikoWindowMessage, number>();
  private readonly touchBatches = new Map<
    BurikoWindowMessage,
    readonly BurikoNativeTouchSample[]
  >();
  private readonly touchMouseMessages = new WeakSet<BurikoWindowMessage>();
  private nextTouchHandle = 0;
  private readonly queue: (QueuedMessage | QueuedQuit | QueuedInputReset)[] = [];
  private first = 0;
  private nextTarget = 0;
  private readonly targets = new Set<BurikoWindowTarget>();
  private readonly invalidated = new Set<BurikoWindowTarget>();
  private readonly paintInFlight = new Map<BurikoWindowTarget, BurikoWindowMessage>();
  private readonly generatedPaint = new WeakSet<BurikoWindowMessage>();
  private readonly physicalMessages = new WeakSet<BurikoWindowMessage>();
  private readonly keyCharacterEvidence = new WeakMap<
    BurikoWindowMessage,
    WindowsKeyCharacterEvidence
  >();
  private readonly numericReceivers = new Map<number, BurikoQueuedNumericReceiver>();
  private mainReceiver: BurikoWindowMessageReceiver | null = null;
  constructor(readonly input: BurikoNativeInput) {}

  createTarget(): number {
    if (this.nextTarget === 0xffffffff)
      throw new RangeError('Buriko browser window identity table is exhausted');
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
  bindMainReceiver(receiver: BurikoWindowMessageReceiver): void {
    if (this.mainReceiver !== null && this.mainReceiver !== receiver)
      throw new Error('Buriko main-window receiver is already bound');
    this.mainReceiver = receiver;
  }

  hasMainReceiver(receiver: BurikoWindowMessageReceiver): boolean {
    return this.mainReceiver === receiver;
  }

  /** Current native HWND global: null represents a not-yet-created or destroyed main window. */
  mainTarget(): 'main' | null {
    return this.targets.has('main') ? 'main' : null;
  }

  hasTarget(target: BurikoWindowTarget): boolean {
    return this.targets.has(target);
  }

  /** One live numeric HWND is routed to its actual awaitable owner at dequeue. */
  bindQueuedNumericTarget(target: number, receiver: BurikoQueuedNumericReceiver): void {
    if (!this.targets.has(target) || !Number.isInteger(target) || target <= 0)
      throw new Error('Buriko queued numeric receiver requires a live target');
    if (this.numericReceivers.has(target))
      throw new Error('Buriko queued numeric target already has a receiver');
    this.numericReceivers.set(target, receiver);
  }

  /** This path is independent of synchronous SendMessage and main HWND dispatch. */
  async dispatchQueuedNumeric(message: BurikoWindowMessage): Promise<boolean> {
    if (typeof message.target !== 'number')
      throw new TypeError('Buriko queued numeric dispatch requires a numeric target');
    if (!this.targets.has(message.target)) return false;
    const receiver = this.numericReceivers.get(message.target);
    if (receiver === undefined)
      throw new Error('Buriko live numeric target has no queued receiver');
    return receiver(message);
  }

  /** Browser default EDIT actions already ran for these messages before native dequeue. */
  isPhysical(message: BurikoWindowMessage): boolean {
    return this.physicalMessages.has(message);
  }

  recordKeyCharacterEvidence(
    message: BurikoWindowMessage,
    evidence: WindowsKeyCharacterEvidence,
  ): void {
    if (!this.physicalMessages.has(message))
      throw new Error('Buriko character evidence requires an exact physical queued key message');
    this.keyCharacterEvidence.set(message, {...evidence});
  }

  keyEvidence(message: BurikoWindowMessage): WindowsKeyCharacterEvidence | null {
    return this.keyCharacterEvidence.get(message) ?? null;
  }

  get pending(): number {
    return this.queue.length - this.first + this.invalidated.size;
  }

  /** Invalid regions coalesce; generated paint follows ordinary posted/input messages. */
  invalidate(target: BurikoWindowTarget): void {
    if (!this.paintInFlight.has(target)) this.invalidated.add(target);
  }

  /** InvalidateRect(NULL,NULL,TRUE) over the title's actual HWND registry. */
  invalidateAll(): void {
    for (const target of this.targets) this.invalidate(target);
  }

  private generatePaint(target: BurikoWindowTarget): BurikoWindowMessage {
    this.invalidated.delete(target);
    const message = {target, message: 0xf, wParam: 0, lParam: 0};
    this.paintInFlight.set(target, message);
    this.generatedPaint.add(message);
    return message;
  }

  isGeneratedPaint(message: BurikoWindowMessage): boolean {
    return this.generatedPaint.has(message);
  }

  /** BeginPaint validates the region after the receiver's wait broadcast. */
  validatePaint(message: BurikoWindowMessage): void {
    if (message.message !== 0xf) throw new Error('Buriko paint validation requires WM_PAINT');
    if (this.generatedPaint.has(message)) {
      if (this.paintInFlight.get(message.target) === message)
        this.paintInFlight.delete(message.target);
    } else this.invalidated.delete(message.target);
  }

  /** An unsuccessful generated dispatch leaves its invalidation available to retry. */
  releasePaint(message: BurikoWindowMessage): void {
    if (this.paintInFlight.get(message.target) !== message) return;
    this.paintInFlight.delete(message.target);
    if (this.targets.has(message.target)) this.invalidated.add(message.target);
  }

  /** UpdateWindow dispatches only this pending paint, without consuming the posted/input FIFO. */
  takePaint(target: BurikoWindowTarget): BurikoWindowMessage | null {
    if (!this.invalidated.has(target)) return null;
    return this.generatePaint(target);
  }

  /** Window destruction drops its invalid region, without rewriting ordinary queued messages. */
  forgetTarget(target: BurikoWindowTarget): void {
    this.invalidated.delete(target);
    this.paintInFlight.delete(target);
    this.targets.delete(target);
    if (target === 'main') {
      this.cancelPendingTouchBatches();
      this.cancelPendingTouchMouse();
    }
    if (typeof target === 'number') this.numericReceivers.delete(target);
  }

  private append(
    message: BurikoWindowMessage,
    physicalTransitions: QueuedMessage['physicalTransitions'],
    physical = false,
    priority = false,
  ): BurikoWindowMessage {
    const copy: BurikoWindowMessage = {
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
    return copy;
  }

  /** Browser HTouchInput substitute: samples belong to this exact FIFO message, not its integer handle. */
  enqueuePhysicalTouch(samples: readonly BurikoNativeTouchSample[]): boolean {
    if (!this.targets.has('main')) return false;
    if (samples.length === 0 || samples.length > 256)
      throw new RangeError('Buriko WM_TOUCH requires 1 to 256 contacts per batch');
    if (this.touchBatches.size >= 256) return false;
    const batch = samples.map((sample) => ({...sample}));
    this.nextTouchHandle = (this.nextTouchHandle + 1) >>> 0 || 1;
    const message = this.append(
      {target: 'main', message: 0x240, wParam: batch.length, lParam: this.nextTouchHandle},
      [],
      true,
    );
    this.touchBatches.set(message, batch);
    return true;
  }

  /** Only a sidecar owned by this queue is a valid GetTouchInputInfo result. */
  touchBatch(message: BurikoWindowMessage): readonly BurikoNativeTouchSample[] | null {
    return this.touchBatches.get(message) ?? null;
  }

  /** Scoped deactivation invalidates queued contacts without changing FIFO or wait broadcasts. */
  cancelPendingTouchBatches(): void {
    this.touchBatches.clear();
  }

  /** Primary-touch mouse compatibility messages share FIFO order but can be withdrawn on contact loss. */
  enqueueTouchMouse(
    message: BurikoWindowMessage,
    transitions: readonly {readonly key: number; readonly down: boolean}[] = [],
  ): void {
    if (!this.targets.has('main')) return;
    for (const {key, down} of transitions) this.input.setPhysicalKey(key, down);
    this.touchMouseMessages.add(this.append(message, transitions, true));
  }

  cancelPendingTouchMouse(): void {
    for (let index = this.queue.length - 1; index >= this.first; index--) {
      const entry = this.queue[index];
      if (entry?.kind === 'window' && this.touchMouseMessages.has(entry.message))
        this.queue.splice(index, 1);
    }
    if (this.first === this.queue.length) {
      this.queue.length = 0;
      this.first = 0;
    }
  }

  /** A synthetic keyboard PostMessage does not change GetAsyncKeyState or GetKeyboardState. */
  post(message: BurikoWindowMessage): void {
    this.append(message, []);
  }

  /** An MCI completion keeps its playback token beside its exact posted FIFO message. */
  postCdSuccessfulNotification(token: number): void {
    if (!this.targets.has('main')) return;
    const message = this.append({target: 'main', message: 0x3b9, wParam: 1, lParam: 1}, []);
    this.cdNotifications.set(message, token);
  }

  cdSuccessfulNotificationToken(message: BurikoWindowMessage): number | null {
    return this.cdNotifications.get(message) ?? null;
  }

  /** PostQuitMessage is a GUI-thread event after the existing FIFO tail, not a HWND message. */
  postQuit(exitCode: number): void {
    this.queue.push({kind: 'quit', exitCode: exitCode | 0});
  }

  /** SendMessage's synchronous path; null targets retain its zero-result behavior. */
  send(
    target: BurikoWindowTarget | null,
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
  dispatch(message: BurikoWindowMessage): number | bigint {
    try {
      if (!this.targets.has(message.target)) return 0;
      if (message.target === 'main') return this.mainReceiver?.receive(message) ?? 0;
      return 0;
    } finally {
      this.touchBatches.delete(message);
    }
  }

  /** Host input changes asynchronous state at arrival and queued keyboard state at dequeue. */
  enqueuePhysicalKey(
    target: BurikoWindowTarget,
    key: number,
    down: boolean,
    lParam: number | bigint,
    message = down ? 0x100 : 0x101,
  ): void {
    this.enqueuePhysicalTransitions({target, message, wParam: key, lParam}, [{key, down}]);
  }

  /** Generic modifier and left/right modifier state travel with the same native message. */
  enqueuePhysicalTransitions(
    message: BurikoWindowMessage,
    transitions: readonly {readonly key: number; readonly down: boolean}[],
    priority = false,
  ): BurikoWindowMessage {
    for (const {key, down} of transitions) this.input.setPhysicalKey(key, down);
    return this.append(message, transitions, true, priority);
  }

  /** PeekMessage-style mouse motion coalesces only with the unconsumed physical move at the FIFO tail. */
  enqueuePhysicalMouseMove(wParam: number, lParam: number): void {
    const tailIndex = this.queue.length - 1,
      tail = tailIndex >= this.first ? this.queue[tailIndex] : undefined,
      message: BurikoWindowMessage = {target: 'main', message: 0x200, wParam, lParam};
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
  take(): BurikoWindowMessage | null {
    this.drainInputResets();
    const entry = this.queue[this.first];
    if (entry === undefined) {
      const next = this.invalidated.values().next();
      if (next.done) return null;
      return this.generatePaint(next.value);
    }
    if (entry.kind === 'quit')
      throw new Error('Buriko thread quit requires the posted-event dequeue');
    if (entry.kind === 'input-reset') throw new Error('Buriko input reset was not drained');
    return this.dequeueWindow(entry);
  }

  /** Posted FIFO only. A paint invalidation never becomes a synthetic posted event. */
  takePostedEvent(): BurikoPostedWindowEvent | null {
    this.drainInputResets();
    const entry = this.queue[this.first];
    if (entry === undefined) return null;
    if (entry.kind === 'quit') {
      this.advanceQueue();
      return {kind: 'quit', exitCode: entry.exitCode};
    }
    if (entry.kind === 'input-reset') throw new Error('Buriko input reset was not drained');
    return {kind: 'window', message: this.dequeueWindow(entry)};
  }

  /** PeekMessageW's thread-wide removal order, including generated invalid-region paint. */
  takePumpEvent(): BurikoPumpWindowEvent | null {
    const posted = this.takePostedEvent();
    if (posted !== null) return posted;
    const next = this.invalidated.values().next();
    if (next.done) return null;
    return {kind: 'window', message: this.generatePaint(next.value)};
  }

  private dequeueWindow(entry: QueuedMessage): BurikoWindowMessage {
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
  dispatchNext(): BurikoDispatchedWindowMessage | null {
    const message = this.take();
    if (message === null) return null;
    if (message.message === 0xf) {
      this.releasePaint(message);
      throw new Error('Buriko WM_PAINT requires awaited queued dispatch');
    }
    try {
      return {message, result: this.dispatch(message)};
    } catch (error) {
      this.releasePaint(message);
      throw error;
    }
  }
}

import type {AokanaNativeInput} from './input.js';

/** Native HWND identity; numeric window tokens are independent of script-visible 0xf8 handles. */
export type AokanaWindowTarget = 'main' | number;
export interface AokanaWindowMessage {
  readonly target: AokanaWindowTarget;
  readonly message: number;
  readonly wParam: number | bigint;
  readonly lParam: number | bigint;
}
interface QueuedMessage {
  readonly message: AokanaWindowMessage;
  readonly physicalTransitions: readonly {readonly key: number; readonly down: boolean}[];
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
  private readonly queue: QueuedMessage[] = [];
  private first = 0;
  private nextTarget = 0;
  private readonly targets = new Set<AokanaWindowTarget>();
  private readonly invalidated = new Set<AokanaWindowTarget>();
  private readonly physicalMessages = new WeakSet<AokanaWindowMessage>();
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

  hasTarget(target: AokanaWindowTarget): boolean {
    return this.targets.has(target);
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
    this.invalidated.add(target);
  }

  /** InvalidateRect(NULL,NULL,TRUE) over the title's actual HWND registry. */
  invalidateAll(): void {
    for (const target of this.targets) this.invalidated.add(target);
  }

  /** UpdateWindow dispatches only this pending paint, without consuming the posted/input FIFO. */
  takePaint(target: AokanaWindowTarget): AokanaWindowMessage | null {
    if (!this.invalidated.delete(target)) return null;
    return {target, message: 0xf, wParam: 0, lParam: 0};
  }

  /** Window destruction drops its invalid region, without rewriting ordinary queued messages. */
  forgetTarget(target: AokanaWindowTarget): void {
    this.invalidated.delete(target);
    this.targets.delete(target);
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
      message: copy,
      physicalTransitions: physicalTransitions.map((transition) => ({...transition})),
    };
    if (priority) this.queue.splice(this.first, 0, entry);
    else this.queue.push(entry);
  }

  /** A synthetic keyboard PostMessage does not change GetAsyncKeyState or GetKeyboardState. */
  post(message: AokanaWindowMessage): void {
    this.append(message, []);
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

  /** The concrete window-message loop dispatches the returned message after this transition. */
  take(): AokanaWindowMessage | null {
    const entry = this.queue[this.first];
    if (entry === undefined) {
      const next = this.invalidated.values().next();
      if (next.done) return null;
      this.invalidated.delete(next.value);
      return {target: next.value, message: 0xf, wParam: 0, lParam: 0};
    }
    this.first++;
    if (this.first === this.queue.length) {
      this.queue.length = 0;
      this.first = 0;
    }
    for (const {key, down} of entry.physicalTransitions) {
      this.input.setDequeuedKey(key, down);
    }
    return entry.message;
  }
}

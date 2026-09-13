import type {AokanaDisplayManager} from './display-manager.js';
import type {AokanaDisplayObject} from './display-object.js';

interface Message {
  readonly words: Uint32Array;
  next: Message | null;
}

/** DCIndProc, 08e240; this is separate from a BP thread's CProcedure wait process. */
export class AokanaIndependentProcedure {
  readonly id: number;
  category = 0x80;
  enabled = 1;
  dirty = 0;
  private firstMessage: Message | null = null;
  private disposed = false;

  constructor(
    readonly shared: AokanaIndependentProcedures,
    readonly object: AokanaDisplayObject,
  ) {
    object.attachOwnerIfEmpty(this);
    this.id = shared.allocateId();
  }

  protected check(): void {
    if (this.disposed) throw new Error('Aokana accesses a deleted DCIndProc');
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
    let words: Uint32Array | null;
    while ((words = this.dequeue()) !== null) {
      if (words[0] === 0) {
        if (words.length === 2) this.setEnabled(words[1]!);
      } else {
        const result = this.handleMessage(words);
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
    await this.drainMessages();
    if (this.getEnabled() !== 0) this.flushRedraw();
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
    readonly procedure: AokanaIndependentProcedure,
    private following: Entry | null,
  ) {}
  get next(): Entry | null {
    if (this.removed) throw new Error('Aokana DCIndProc traversal reads a removed registry node');
    return this.following;
  }
  set next(value: Entry | null) {
    if (this.removed) throw new Error('Aokana DCIndProc traversal writes a removed registry node');
    this.following = value;
  }
  release(): void {
    this.removed = true;
  }
}

/** The one registry at 1e9120. 08e1d0/08e1b0 bind the actual display/surface manager aliases. */
export class AokanaIndependentProcedures {
  private lastId = 0; // 1d281c, distinct from CProcedure and lock counters.
  private first: Entry | null = null;
  private registrations = 0; // 1e9110 is reset only by c2b10, not decremented by c2b50.
  private phase = 0; // 1e90ac, independent-procedure polling phase.

  constructor(readonly manager: AokanaDisplayManager) {}

  get surfaces() {
    return this.manager.surfaces;
  }
  get registrationCount(): number {
    return this.registrations;
  }
  get pollingPhase(): number {
    return this.phase;
  }
  /** c2c60 accepts only zero and one; the controller reads this before each phase. */
  setPollingPhase(value: number): 0 | 1 {
    value >>>= 0;
    if (value > 1) return 0;
    this.phase = value;
    return 1;
  }

  /** ID assignment belongs to construction, which can precede registry insertion. */
  allocateId(): number {
    this.lastId = (this.lastId + 1) >>> 0;
    return this.lastId;
  }

  register(procedure: AokanaIndependentProcedure): number {
    if (procedure.shared !== this)
      throw new Error('Aokana DCIndProc belongs to another native registry owner');
    const id = procedure.id >>> 0;
    const entry = new Entry(id, procedure, this.first);
    this.registrations = (this.registrations + 1) >>> 0;
    this.first = entry;
    return id;
  }

  find(id: number): AokanaIndependentProcedure | null {
    id >>>= 0;
    for (let entry = this.first; entry !== null; entry = entry.next)
      if (entry.id === id) return entry.procedure;
    return null;
  }

  /** c2b50 unlinks before disposal; it intentionally retains the registration counter. */
  remove(id: number): 0 | 1 {
    id >>>= 0;
    let previous: Entry | null = null;
    for (let entry = this.first; entry !== null; entry = entry.next) {
      if (entry.id === id) {
        if (previous === null) this.first = entry.next;
        else previous.next = entry.next;
        entry.procedure.dispose();
        entry.release();
        return 1;
      }
      previous = entry;
    }
    return 0;
  }

  clear(): void {
    while (this.first !== null) this.remove(this.first.id);
    this.registrations = 0;
  }

  /** c2a80 deliberately calls the base poll, while message dispatch remains virtual. */
  async resetEnabled(): Promise<void> {
    for (let entry = this.first; entry !== null; entry = entry.next)
      if (entry.procedure.getEnabled() !== 0)
        await AokanaIndependentProcedure.prototype.poll.call(entry.procedure);
  }

  /** c2ac0 visits enabled entries newest first and stops at the first nonzero poll result. */
  async pollEnabled(): Promise<0 | 1> {
    let result: 0 | 1 = 1;
    for (let entry = this.first; entry !== null && result !== 0; entry = entry.next)
      if (entry.procedure.getEnabled() !== 0) result = (await entry.procedure.poll()) === 0 ? 1 : 0;
    return result;
  }
}

import {pointerView} from '../bp/memory.js';
import type {BurikoBpPointer} from '../bp/memory.js';
import {nativeVectorAngle} from '../bp/opcodes/native-math.js';
import {native1665VectorAngle} from '../bp/opcodes/legacy-1665.js';
import type {BurikoBpAbi} from '../bp/abi.js';
import type {BurikoNativeClock} from './clock.js';
import type {BurikoNativeInput} from './input.js';

/** The fields read from Win32 TOUCHINPUT; positions and contact sizes are hundredths of pixels. */
export interface BurikoNativeTouchSample {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly flags: number;
  readonly mask: number;
  readonly time: number;
  readonly contactWidth: number;
  readonly contactHeight: number;
}
interface Contact {
  id: number;
  sequence: number;
  x: number;
  y: number;
  width: number;
  height: number;
  time: number;
}
type HistoryPoint = Omit<Contact, 'id'>;

/** Native OS primitives used at 1400c0930 and 1400c0bb0. */
export interface BurikoNativeTouchWindow {
  readonly available: boolean;
  register(flags: 1): number;
  unregister(): number;
  screenToClient(x: number, y: number): readonly [number, number];
}

/** The native touch list and its separate, distance-filtered primary-contact history. */
export class BurikoNativeTouch {
  private readonly contacts: Contact[] = [];
  private readonly history: HistoryPoint[] = [];
  private sequence = 0;
  private previouslyActive = false;
  private historyLimit = 0;
  private minimumDistance = 0;

  constructor(
    readonly input: BurikoNativeInput,
    private readonly clock: BurikoNativeClock,
    readonly window: BurikoNativeTouchWindow,
    readonly revision: BurikoBpAbi['revision'] = '1.685.3',
  ) {}

  /** C0D50 reads the same capability gate used by native touch registration. */
  get available(): boolean {
    return this.window.available;
  }

  /** 1400c0930 clears contacts after either OS call, including an OS failure. */
  setRegistration(enabled: number): number {
    if (!this.window.available) return 0;
    const result = enabled !== 0 ? this.window.register(1) : this.window.unregister();
    this.clearContacts();
    return result;
  }

  /** 1400c0b50 deliberately leaves the history intact. */
  clearContacts(): void {
    this.contacts.length = 0;
    this.sequence = 0;
    this.previouslyActive = false;
    this.input.touchPositions = [];
  }

  configureHistory(limit: number, distance: number): number {
    limit >>>= 0;
    distance >>>= 0;
    if (limit > 512) return 0;
    this.history.length = 0;
    this.historyLimit = limit;
    this.minimumDistance = distance;
    return 1;
  }

  private apply(sample: BurikoNativeTouchSample): void {
    const id = sample.id >>> 0;
    const index = this.contacts.findIndex((contact) => contact.id === id);
    if ((sample.flags & 4) !== 0) {
      if (index >= 0) this.contacts.splice(index, 1);
      return;
    }
    let contact = index < 0 ? undefined : this.contacts[index];
    if (contact === undefined) {
      contact = {id, sequence: this.sequence, x: 0, y: 0, width: 0, height: 0, time: 0};
      this.sequence = (this.sequence + 1) >>> 0;
      this.contacts.push(contact);
    }
    const [clientX, clientY] = this.window.screenToClient(
      Math.trunc((sample.x | 0) / 100),
      Math.trunc((sample.y | 0) / 100),
    );
    [contact.x, contact.y] = this.input.display.transformPoint(clientX, clientY, 1);
    contact.width = (sample.mask & 4) !== 0 ? Math.floor((sample.contactWidth >>> 0) / 100) : 0;
    contact.height = (sample.mask & 4) !== 0 ? Math.floor((sample.contactHeight >>> 0) / 100) : 0;
    contact.time =
      (sample.mask & 1) !== 0 ? sample.time >>> 0 : Number(BigInt.asUintN(32, this.clock.read()));
  }

  /** 1400c09a0 after successful GetTouchInputInfo; null models its failure before any mutation. */
  receive(samples: readonly BurikoNativeTouchSample[] | null): number {
    if (samples === null || samples.length === 0) return 0;
    // DOWN and PRIMARY samples are processed once here and again in the complete second pass.
    for (const sample of samples) if ((sample.flags & 0x12) !== 0) this.apply(sample);
    for (const sample of samples) this.apply(sample);
    const primary = this.contacts[0];
    if (primary === undefined) {
      this.clearContacts();
      this.configureHistory(this.historyLimit, this.minimumDistance);
    } else {
      const latest = this.history[0];
      let append = true;
      if (latest !== undefined) {
        if (latest.sequence === primary.sequence) {
          const dx = (latest.x - primary.x) | 0,
            dy = (latest.y - primary.y) | 0;
          append = !(Math.sqrt(dx * dx + dy * dy) < this.minimumDistance);
        } else this.configureHistory(this.historyLimit, this.minimumDistance);
      }
      if (append && this.historyLimit !== 0) {
        if (this.history.length >= this.historyLimit) this.history.pop();
        const {sequence, x, y, width, height, time} = primary;
        this.history.unshift({sequence, x, y, width, height, time});
      }
    }
    if (!this.previouslyActive && this.contacts.length !== 0) this.input.recordKeyCount(7);
    this.previouslyActive = this.contacts.length !== 0;
    this.input.touchPositions = this.contacts.map((contact) => [contact.x, contact.y]);
    return 1;
  }

  /** 1400c08e0 copies six DWORDs per contact, excluding the OS contact id. */
  copyContacts(destination: BurikoBpPointer | null): number {
    for (let index = 0; index < this.contacts.length; index++) {
      if (destination !== null) {
        const contact = this.contacts[index]!;
        const view = pointerView(
          {bytes: destination.bytes, offset: destination.offset + index * 24},
          24,
        );
        const words = [
          contact.sequence,
          contact.x,
          contact.y,
          contact.width,
          contact.height,
          contact.time,
        ];
        for (let word = 0; word < 6; word++) view.setUint32(word * 4, words[word]!, true);
      }
    }
    return this.contacts.length;
  }

  /** 1400c0680 starts at head.next, so the newest point is intentionally excluded. */
  copyHistory(
    positions: BurikoBpPointer | null,
    angles: BurikoBpPointer | null,
    index: number,
    count: number,
  ): number {
    index >>>= 0;
    count >>>= 0;
    if (index >= this.history.length || count === 0) return 0;
    let copied = 0;
    for (
      let source = index + 1;
      copied < count && source < this.history.length;
      source++, copied++
    ) {
      const point = this.history[source]!,
        next = this.history[source + 1];
      if (positions === null) throw new Error('Buriko native touch-history null position output');
      const view = pointerView({bytes: positions.bytes, offset: positions.offset + copied * 8}, 8);
      view.setInt32(0, point.x, true);
      view.setInt32(4, point.y, true);
      const angle =
        next === undefined
          ? 0xffffffff
          : (this.revision === '1.665' ? native1665VectorAngle : nativeVectorAngle)(
              (point.x - next.x) | 0,
              (point.y - next.y) | 0,
            );
      if (angles === null) throw new Error('Buriko native touch-history null angle output');
      pointerView({bytes: angles.bytes, offset: angles.offset + copied * 4}, 4).setUint32(
        0,
        angle,
        true,
      );
    }
    return copied;
  }
}

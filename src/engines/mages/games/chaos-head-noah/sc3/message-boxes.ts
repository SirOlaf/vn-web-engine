import type {NoahState} from './noah-state.js';
import {romByte} from './text-rom.js';

export interface MessageBoxHost {
  byte(address: number): number;
  expression(address: number): {value: number; next: number};
  hit(group: number, index: number, activate: boolean): boolean;
  sound(id: number, volume: number): void;
}
const BASE = 0x1de15a0,
  STRIDE = 0xb8;
export interface MessageBoxSnapshot {
  channel: number;
  style: number;
  width: number;
  lines: number[];
  choices: number[];
}
/** Native 14003cc50/3ccc0/3cde0/3ce50. Rendering consumes this retained state. */
export class MessageBoxes {
  readonly snapshots: MessageBoxSnapshot[] = [];
  constructor(
    readonly state: NoahState,
    readonly host: MessageBoxHost,
  ) {}
  private base(channel: number): number {
    if (channel !== 0 && channel !== 1) throw new Error('Invalid dialog channel');
    return BASE + channel * STRIDE;
  }
  private randomize(): void {
    for (let i = 0; i < 11; i++) {
      const a = this.state.random15() & 32767,
        b = this.state.random15() & 32767;
      this.state.put(0x5a97e0 + i * 8, Math.floor((a * 2000) / 0x1f40000));
      this.state.put(0x5a97e4 + i * 8, Math.floor(((b * 16000) >>> 15) / 1000));
    }
  }
  clear(channel: number, style: number): void {
    const s = this.state,
      b = this.base(channel);
    s.put(b + 0xa8, style, 8);
    s.put(b + 0xa0, 255);
    s.zero(b, 8);
    s.put(b + 8, 255);
    this.randomize();
  }
  measure(address: number, size = 28, limit = 255): number {
    return measureNativeText(this.host, address, size, limit);
  }
  append(channel: number, address: number, choice: boolean): void {
    const s = this.state,
      b = this.base(channel),
      count = b + (choice ? 4 : 0),
      n = s.get(count) >>> 0;
    // Native stores the pointer before measuring, then increments the count.
    s.put(b + (choice ? 0x40 : 0x10) + n * 8, address, 8);
    s.put(b + (choice ? 0x88 : 0x70) + n * 4, this.measure(address));
    s.put(count, n + 1);
  }
  open(channel: number, selection: number, mode: number): void {
    const s = this.state,
      b = this.base(channel);
    s.put(b + 0xb0, mode);
    s.put(b + 0xa0, selection);
    s.setVariable(channel + 0x850, 255);
    let width = 0,
      choices = 0;
    for (let i = 0; i < s.get(b) >>> 0; i++) width = Math.max(width, s.get(b + 0x70 + i * 4) >>> 0);
    for (let i = 0; i < s.get(b + 4) >>> 0; i++)
      choices = (choices + 40 + s.get(b + 0x88 + i * 4)) >>> 0;
    s.put(b + 0xa4, Math.max(294, width, choices));
    this.randomize();
    this.snapshots.push({
      channel,
      style: s.get(b + 0xa8),
      width: s.get(b + 0xa4) >>> 0,
      lines: Array.from({length: s.get(b) >>> 0}, (_, i) =>
        Number(s.view(b + 0x10 + i * 8, 8).getBigUint64(0, true)),
      ),
      choices: Array.from({length: s.get(b + 4) >>> 0}, (_, i) =>
        Number(s.view(b + 0x40 + i * 8, 8).getBigUint64(0, true)),
      ),
    });
  }
  private sound(id: number): void {
    const s = this.state,
      v =
        Math.trunc(Math.fround(Math.fround(Math.fround(s.get(0x17ac2e8) >>> 0) * 70) / 100)) >>> 0;
    s.put(0x5a7100, v);
    this.host.sound(id, v);
  }
  interact(channel: number): boolean {
    const s = this.state,
      b = this.base(channel),
      count = () => s.get(b + 4) >>> 0,
      selection = () => s.get(b + 8) >>> 0;
    const confirm = () => !!(s.get(0x5a70d4) & s.get(0x872dd4)),
      cancel = () => !!(s.get(0x5a70d4) & s.get(0x872dd8));
    const click = () => {
      if (s.get(0x17add90) & 1) s.put(0x5a70d4, s.get(0x5a70d4) | s.get(0x872dd4));
    };
    if (!count()) click();
    else {
      for (let i = 0; i < count(); i++)
        if (this.host.hit(channel + 1, i, true)) {
          if (selection() !== i) {
            s.put(b + 8, i);
            this.sound(1);
          }
          click();
        }
      if (s.get(0x5a6f74) & s.get(0x872dc8)) {
        this.sound(1);
        const n = selection();
        s.put(b + 8, n === 255 ? 0 : (n === 0 ? count() : n) - 1);
      }
      if (s.get(0x5a6f74) & s.get(0x872dcc)) {
        this.sound(1);
        const n = selection();
        s.put(b + 8, n === 255 ? count() - 1 : n < count() - 1 ? n + 1 : 0);
      }
    }
    if (confirm()) {
      if (!count()) {
        this.sound(2);
        return true;
      }
      this.sound(2);
      if (selection() !== 255) {
        s.setVariable(channel + 0x850, selection());
        return true;
      }
      s.put(b + 8, 0); // First confirm selects; a simultaneous cancel still runs below.
    }
    if (cancel()) {
      if (!count()) {
        this.sound(2);
        return true;
      }
      this.sound(3);
      s.put(b + 8, count() !== 1 ? 1 : 0);
    }
    return false;
  }
}

/** 140046320: simple native glyph measurement, including expression side effects. */
export function measureNativeText(
  host: Pick<MessageBoxHost, 'byte' | 'expression'>,
  address: number,
  size = 28,
  limit = 255,
): number {
  limit = limit >>> 0 || 255;
  let width = 0,
    count = 0;
  for (;;) {
    const byte = host.byte(address);
    if (byte === 255 || count > limit) return width | 0;
    if (byte >= 128) {
      const id = (byte & 127) * 256 + host.byte(address + 1);
      address += 2;
      width =
        (width +
          (id < 351
            ? Math.imul(romByte(0x1da350 + id), size) >>> 5
            : id < 0x2800
              ? size
              : Math.imul(size, 17) >>> 5)) |
        0;
      count++;
    } else if (byte === 4) {
      address = host.expression(address + 1).next;
    } else
      throw new Error(
        `Native dialog measurement cannot advance on control ${byte} at 0x${address.toString(16)}`,
      );
  }
}

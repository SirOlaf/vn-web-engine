import type {InputFrame} from '../../../../../input/browser-input.js';
import {NoahCursor} from './cursor.js';
import {NoahMouse} from './mouse.js';
import {queryInput} from './input-query.js';
import {updateInputHints} from './input-hints.js';
import type {NoahState} from './noah-state.js';
/** DirectInput keyboard identities used by 1400475f0's configurable bindings. */
const scan: Readonly<Record<string, number>> = {
  Escape: 1,
  Digit1: 2,
  Digit2: 3,
  Digit3: 4,
  Digit4: 5,
  Digit5: 6,
  Digit6: 7,
  Digit7: 8,
  Digit8: 9,
  Digit9: 10,
  Digit0: 11,
  Minus: 12,
  Equal: 13,
  Backspace: 14,
  Tab: 15,
  KeyQ: 16,
  KeyW: 17,
  KeyE: 18,
  KeyR: 19,
  KeyT: 20,
  KeyY: 21,
  KeyU: 22,
  KeyI: 23,
  KeyO: 24,
  KeyP: 25,
  BracketLeft: 26,
  BracketRight: 27,
  Enter: 28,
  ControlLeft: 29,
  KeyA: 30,
  KeyS: 31,
  KeyD: 32,
  KeyF: 33,
  KeyG: 34,
  KeyH: 35,
  KeyJ: 36,
  KeyK: 37,
  KeyL: 38,
  Semicolon: 39,
  Quote: 40,
  Backquote: 41,
  ShiftLeft: 42,
  Backslash: 43,
  KeyZ: 44,
  KeyX: 45,
  KeyC: 46,
  KeyV: 47,
  KeyB: 48,
  KeyN: 49,
  KeyM: 50,
  Comma: 51,
  Period: 52,
  Slash: 53,
  ShiftRight: 54,
  NumpadMultiply: 55,
  AltLeft: 56,
  Space: 57,
  CapsLock: 58,
  F1: 59,
  F2: 60,
  F3: 61,
  F4: 62,
  F5: 63,
  F6: 64,
  F7: 65,
  F8: 66,
  F9: 67,
  F10: 68,
  NumLock: 69,
  ScrollLock: 70,
  Numpad7: 71,
  Numpad8: 72,
  Numpad9: 73,
  NumpadSubtract: 74,
  Numpad4: 75,
  Numpad5: 76,
  Numpad6: 77,
  NumpadAdd: 78,
  Numpad1: 79,
  Numpad2: 80,
  Numpad3: 81,
  Numpad0: 82,
  NumpadDecimal: 83,
  F11: 87,
  F12: 88,
  NumpadEnter: 156,
  ControlRight: 157,
  NumpadDivide: 181,
  AltRight: 184,
  Home: 199,
  ArrowUp: 200,
  PageUp: 201,
  ArrowLeft: 203,
  ArrowRight: 205,
  End: 207,
  ArrowDown: 208,
  PageDown: 209,
  Insert: 210,
  Delete: 211,
};
const masks = [
  1, 2, 4, 8, 4096, 8192, 16384, 32768, 256, 1024, 64, 512, 2048, 128, 16, 32, 0x100000, 0x200000,
  0x400000, 0x800000, 0x1000000, 0x2000000, 0x4000000, 0x8000000,
];
export interface HitRegion {
  group: number;
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
  value?: number;
}
/** Keyboard reduction and repeat cadence from 140026230/26e70; pointer grid from 140062e60. */
export class NoahInput {
  private regions: readonly HitRegion[] = [];
  private hits = new Map<string, number>();
  readonly cursor: NoahCursor;
  private readonly mouse: NoahMouse;
  onActivate: (() => void) | undefined;
  constructor(readonly state: NoahState) {
    state.put(0x17add70, 1920, 2);
    state.put(0x17add76, 1, 1);
    this.cursor = new NoahCursor(state);
    this.mouse = new NoahMouse(state);
    this.onActivate = () => this.cursor.activate();
  }
  query(action: number): number {
    return +queryInput(this, action | 0);
  }
  bindings(row: number): number[] {
    return Array.from({length: 8}, (_, i) => this.state.get(0x872140 + row * 32 + i * 4)).filter(
      Boolean,
    );
  }
  keyEdge(row: number): boolean {
    const keys = this.bindings(row),
      s = this.state;
    if (!keys.some((k) => s.bytes(0x1bae6e0 + k, 1)[0]! & 128)) return false;
    for (const key of keys) {
      const b = s.bytes(0x1bae6e0 + key, 1);
      b[0] = b[0]! & 127;
    }
    return true;
  }
  setRegions(regions: readonly HitRegion[]): void {
    this.regions = regions;
  }
  hit(group: number, index: number, activate: boolean): boolean {
    if (group >= 32 || index >= 65535 || !this.state.bytes(0x17add76, 1)[0]) return false;
    const value = this.hits.get(`${group}/${index}`) ?? 0;
    if (value && activate && this.onActivate) {
      this.onActivate();
      this.state.put(0x17add72, 1, 1);
      return !!this.hits.get(`${group}/${index}`);
    }
    return !!value;
  }
  update(frame: InputFrame): void {
    // No virtual gamepad attached: native analog coordinates are zero each tick.
    this.state.put(0x5a6f98, 0);
    this.state.put(0x5a6f9c, 0);
    const s = this.state,
      heldKeys = new Set([...frame.keys].map((k) => scan[k]).filter((k) => k !== undefined)),
      edges = new Set([...frame.pressed].map((k) => scan[k]).filter((k) => k !== undefined));
    // 1400792e0 keyboard snapshot, edge buffer, and delayed-held buffer.
    const raw = s.bytes(0x1bae4e0, 256),
      previous = s.bytes(0x1bae5e0, 256),
      pressedRaw = s.bytes(0x1bae6e0, 256),
      delayed = s.bytes(0x1bae7e0, 256);
    raw.fill(0);
    pressedRaw.fill(0);
    delayed.fill(0);
    s.put(0x1baf0e0, 0, 1);
    for (const k of heldKeys) raw[k] = 128;
    for (const k of edges) pressedRaw[k] = 128;
    previous.set(raw);
    for (let k = 0; k < 256; k++) {
      const age = 0x1bae8e0 + k * 4,
        delay = 0x1baece0 + k * 4;
      if (raw[k]) {
        s.put(0x1baf0e0, 1, 1);
        if (s.get(age) >>> 0 !== 0xffffffff) s.put(age, s.get(age) + 1);
        if (s.get(delay) >>> 0 < 8) s.put(delay, s.get(delay) + 1);
        else {
          s.put(delay, 8);
          delayed[k] = 128;
        }
      } else {
        s.put(age, 0);
        s.put(delay, 0);
      }
    }
    const heldRow = (r: number) =>
      this.bindings(r).some((k) => !!(s.bytes(0x1bae4e0 + k, 1)[0]! & 128));
    const edgeRow = (r: number) => this.keyEdge(r);
    let held = 0,
      pressed = 0;
    for (let r = 0; r < 24; r++) if (heldRow(r)) held |= masks[r]!;
    for (let axis = 0; axis < 4; axis++)
      if ([axis, 16 + axis, 20 + axis].some(heldRow)) held |= 0x10000 << axis;
    s.put(0x5a6f70, 0);
    for (let r = 0; r < 24; r++)
      if (edgeRow(r)) {
        pressed |= r < 4 ? 0x10000 << r : masks[r]!;
        if (r === 5) s.put(0x5a6f70, 1);
      }
    for (let axis = 0; axis < 4; axis++)
      for (const row of [axis, 16 + axis, 20 + axis]) if (edgeRow(row)) pressed |= 0x10000 << axis;
    s.put(0x5a70d0, held);
    s.put(0x5a70d4, pressed);
    let repeat = 0,
      fast = 0;
    for (let i = 0; i < 32; i++) {
      const bit = 1 << i,
        offset = i * 4,
        age = 0x5a6ef0 + offset,
        delay = 0x5a6e70 + offset,
        accelerate = 0x5a7030 + offset,
        rapid = 0x5a6fb0 + offset;
      if (!(held & bit)) {
        for (const a of [age, delay, accelerate, rapid]) s.put(a, 0);
        continue;
      }
      const n = (s.get(age) + 1) >>> 0;
      s.put(age, n);
      if (n === 1) {
        repeat |= bit;
        fast |= bit;
        continue;
      }
      if (n > 29) {
        s.put(delay, s.get(delay) + 1);
        if (s.get(delay) >>> 0 > 3) {
          repeat |= bit;
          if (n < 90) fast |= bit;
          s.put(delay, 0);
        }
      }
      if (n >= 90) {
        if (n < 180) {
          s.put(accelerate, s.get(accelerate) + 1);
          if (s.get(accelerate) >>> 0 > 1) {
            fast |= bit;
            s.put(accelerate, 0);
          }
        } else {
          s.put(rapid, s.get(rapid) + 1);
          if (s.get(rapid) !== 0) {
            fast |= bit;
            s.put(rapid, 0);
          }
        }
      }
    }
    s.put(0x5a6f74, repeat);
    s.put(0x58734c, fast);
    // The device/grid pass precedes the application's mouse-mode gate.
    this.mouse.poll(frame);
    this.cursor.prepare();
    if (s.bytes(0x17add76, 1)[0]) {
      this.hits.clear();
      const x = s.get(0x17adddc),
        y = s.get(0x17adde0);
      for (const r of this.regions) {
        const key = `${r.group}/${r.index}`;
        if (
          !this.hits.get(key) &&
          x >= Math.fround(r.x) &&
          y >= Math.fround(r.y) &&
          x <= Math.fround(Math.fround(r.x) + Math.fround(r.width)) &&
          y <= Math.fround(Math.fround(r.y) + Math.fround(r.height))
        )
          this.hits.set(key, (r.value ?? 1) & 255);
      }
    }
    updateInputHints(s);
    this.mouse.gate(frame, Array.from({length: 6}, (_, row) => row).some(heldRow), this.cursor);
  }
}

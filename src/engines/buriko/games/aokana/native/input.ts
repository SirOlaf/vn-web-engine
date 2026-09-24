import type {AokanaNativeClock} from './clock.js';
import type {AokanaBitmapRectangle} from './bitmap.js';
import {AokanaNativeDisplayState} from './display-state.js';
import type {AokanaNativeRectangle} from './display-state.js';

/** The three verified CDspObj virtual calls used by native input-region nodes. */
export interface AokanaInputHitObject {
  inputActive(): number; // vtable +10
  inputRectangle(mode: 0): AokanaNativeRectangle | AokanaBitmapRectangle; // vtable +48
  inputHitTest(x: number, y: number, mode: 1): number; // vtable +C8
}
interface Capture {
  token: number;
  rectangle: AokanaNativeRectangle;
  object: AokanaInputHitObject | null;
}
export type AokanaInputCaptureView = Readonly<Pick<Capture, 'token' | 'object'>>;
const DEFAULT_KEYS: readonly (readonly [number, readonly number[]])[] = [
  [1, [1]],
  [2, [2]],
  [4, [4]],
  [16, [5]],
  [32, [6]],
  [64, [14]],
  [128, [15]],
  [256, [13]],
  [512, [32]],
  [4096, [38]],
  [8192, [40]],
  [16384, [37]],
  [32768, [39]],
  [65536, [49, 97]],
  [131072, [50, 98]],
  [262144, [51, 99]],
  [524288, [52, 100]],
  [1048576, [53, 101]],
  [2097152, [54, 102]],
  [4194304, [55, 103]],
  [8388608, [56, 104]],
  [16777216, [57, 105]],
  [33554432, [48, 96]],
  [1073741824, [9]],
  [2147483648, [17]],
];
const MODIFIABLE_GROUPS = new Set([
  0x40, 0x80, 0x100, 0x200, 0x1000, 0x2000, 0x4000, 0x8000, 0x40000000, 0x80000000,
]);
const EMPTY_RECTANGLE: AokanaNativeRectangle = [0, 0, 0, 0];
const FULL_RECTANGLE: AokanaNativeRectangle = [-2147483648, -2147483648, 2147483647, 2147483647];

/** Aokana's input globals and capture lists; no state is shared with other engine families. */
export class AokanaNativeInput {
  allowMask = 0x2000; // DAT_1401c90b0
  enabled = 1;
  skipAllowed = 1;
  skipForced = 0;
  skipReleaseLatch = false;
  allowBackgroundQuery = 0;
  foreground = false;
  inputActive = false;
  pointerAvailable = false;
  iconic = 0; // IsIconic window state; independent of foreground and script-minimize latch.
  scriptMinimizeLatch = 0; // DAT_1401e8b3c, set by 1400e85b0 and cleared on active restore.
  mouseButtonMode = 0;
  systemMouseButtonsSwapped = false;
  pointerClientX = 0;
  pointerClientY = 0;
  /** Raw host screen coordinates retained separately for GetCursorPos consumers. */
  pointerScreenX = 0;
  pointerScreenY = 0;
  /** Positions are already in native logical coordinates, as stored by the touch receiver. */
  touchPositions: readonly (readonly [number, number])[] = [];
  inputEventCount = 0;
  readonly keyboardState = new Uint8Array(256);
  private readonly rawKeys = new Uint16Array(256);
  private readonly keyRecords = new Uint32Array(256 * 6);
  private readonly clickPositions = new Int32Array(10).fill(-1);
  private readonly groups = new Map<number, number[]>(
    DEFAULT_KEYS.map(([mask, keys]) => [mask, [...keys]]),
  );
  private readonly pointerCaptures: Capture[] = [];
  private readonly keyCaptures: Capture[] = [];

  constructor(
    readonly display: AokanaNativeDisplayState,
    private readonly clock: AokanaNativeClock,
  ) {}

  private keyIndex(key: number): number {
    key >>>= 0;
    if (key >= 256) throw new RangeError('Aokana native virtual-key index outside 0..255');
    return key * 6;
  }

  /** Browser/host physical state is separate from the native script-consumable event records. */
  setPhysicalKey(key: number, down: boolean): void {
    this.keyIndex(key);
    const wasDown = (this.rawKeys[key]! & 0x8000) !== 0;
    this.rawKeys[key] = (down ? 0x8000 : 0) | (this.rawKeys[key]! & 1) | Number(down && !wasDown);
  }

  /** GetKeyboardState changes when the OS message is dequeued, independently of async state. */
  setDequeuedKey(key: number, down: boolean): void {
    this.keyIndex(key);
    const wasDown = (this.keyboardState[key]! & 0x80) !== 0;
    let toggle = this.keyboardState[key]! & 1;
    if (down && !wasDown && (key === 0x14 || key === 0x90 || key === 0x91)) toggle ^= 1;
    this.keyboardState[key] = (down ? 0x80 : 0) | toggle;
  }

  private rawKey(key: number): number {
    if (key >>> 0 >= 256) return 0;
    const result = this.rawKeys[key]!;
    this.rawKeys[key] = result & 0x8000;
    return result;
  }

  /** Direct GetAsyncKeyState consumers bypass logical-button mapping and foreground gating. */
  asynchronousKeyState(key: number): number {
    return this.rawKey(key >>> 0);
  }

  /** Browser GetCursorPos boundary; this deliberately performs no client/logical transform. */
  screenCursorPosition(): readonly [number, number] {
    return [this.pointerScreenX | 0, this.pointerScreenY | 0];
  }

  /** 1400c4290 is a wrapping DWORD increment shared by every input-message handler. */
  incrementActivityGeneration(): void {
    this.inputEventCount = (this.inputEventCount + 1) >>> 0;
  }

  /** 1400c4c50 maps logical mouse buttons before the foreground gate. */
  queryKey(key: number): number {
    key >>>= 0;
    let alternate = 0;
    if (key === 1 && this.mouseButtonMode === 1) alternate = 2;
    else if (key === 2 && this.mouseButtonMode === 1) key = 0;
    if (this.systemMouseButtonsSwapped) {
      if (key === 1) {
        alternate = Number(alternate !== 0);
        key = 2;
      } else if (key === 2) key = 1;
    }
    let result = key === 7 ? Number(this.touchPositions.length !== 0) * 0x8000 : this.rawKey(key);
    if (alternate !== 0) result |= this.rawKey(alternate);
    if (!this.foreground && this.allowBackgroundQuery === 0) result = 0;
    return result;
  }

  /** 1400c4b70. Mouse down messages reset the consumed latch even for a repeated down. */
  recordKeyDown(key: number): boolean {
    const offset = this.keyIndex(key),
      wasDown = this.keyRecords[offset] !== 0;
    const mouse = key === 1 || key === 2 || key === 4 || key === 5 || key === 6;
    if (mouse) this.keyRecords[offset + 1] = 0;
    if (mouse || !wasDown) {
      this.keyRecords[offset + 2] = this.keyRecords[offset + 2]! + 1;
      this.keyRecords[offset + 3] = this.keyRecords[offset + 3]! + 1;
      this.keyRecords[offset + 4] = Number(BigInt.asUintN(32, this.clock.read())) + 500;
    }
    this.keyRecords[offset] = 1;
    return !wasDown;
  }

  /** 1400c4bf0 changes only the held field. */
  recordKeyUp(key: number): void {
    this.keyRecords[this.keyIndex(key)] = 0;
  }

  /** 1400c4b40 increments the cumulative count without a pending press. */
  recordKeyCount(key: number): void {
    const offset = this.keyIndex(key) + 3;
    this.keyRecords[offset] = this.keyRecords[offset]! + 1;
  }

  totalPresses(key: number): number {
    return this.keyRecords[this.keyIndex(key) + 3]!;
  }

  exchangeKeyOption(key: number, value: number): number {
    const offset = this.keyIndex(key) + 5,
      previous = this.keyRecords[offset]!;
    this.keyRecords[offset] = value;
    return previous;
  }

  keyOption(key: number): number {
    return this.keyRecords[this.keyIndex(key) + 5]!;
  }

  repeatReady(key: number): boolean {
    const offset = this.keyIndex(key);
    return (
      this.keyRecords[offset] !== 0 &&
      this.keyRecords[offset + 4]! <= Number(BigInt.asUintN(32, this.clock.read()))
    );
  }

  /** 1400c4c20 preserves cumulative presses and each key's option word. */
  clearTransientKeys(): void {
    for (let offset = 0; offset < this.keyRecords.length; offset += 6) {
      this.keyRecords[offset] =
        this.keyRecords[offset + 1] =
        this.keyRecords[offset + 2] =
        this.keyRecords[offset + 4] =
          0;
    }
  }

  /** 1400c4640 clears the full 256-by-24-byte record array. */
  clearAllKeyRecords(): void {
    this.keyRecords.fill(0);
  }

  /** 1400c4e40 returns pending repeats and a once-consumed held bit. */
  consumeKey(key: number, recursion = new Set<number>()): number {
    const offset = this.keyIndex(key);
    const asynchronous = this.queryKey(key);
    if (this.keyRecords[offset] !== 0 && (asynchronous & 0x8000) === 0) this.recordKeyUp(key);
    if (key >= 0xc1 && key <= 0xd7) {
      if (recursion.has(key)) throw new Error('Aokana native recursive virtual-key mapping');
      recursion.add(key);
      const keys =
        key === 0xc1
          ? this.groups.get(0x100)!
          : key === 0xc2
            ? this.groups.get(0x200)!
            : key === 0xc3
              ? [38, 14]
              : key === 0xc4
                ? [40, 15]
                : [];
      let held = 0,
        count = 0;
      for (const mapped of keys) {
        const result = this.consumeKey(mapped, recursion);
        held |= result & 0x80000000;
        count = (count + (result & 0x7fffffff)) >>> 0;
      }
      recursion.delete(key);
      return (held | count) >>> 0;
    }
    let result = this.keyRecords[offset + 2]!;
    if (this.keyRecords[offset] !== 0 && this.keyRecords[offset + 1] === 0) {
      result |= 0x80000000;
      this.keyRecords[offset + 1] = 1;
    }
    this.keyRecords[offset + 2] = 0;
    return result >>> 0;
  }

  replaceKeyGroup(mask: number, keys: readonly number[]): number {
    if (keys.length > 15) return 0x80000002;
    if (!MODIFIABLE_GROUPS.has(mask >>> 0)) return 0x80000001;
    this.groups.set(
      mask >>> 0,
      keys.map((key) => key >>> 0),
    );
    return 0;
  }

  groupPressCount(mask: number): number {
    let count = 0;
    for (const [group, keys] of this.groups) {
      if (((mask >>> 0) & group) !== 0 && group !== 0x80000000) {
        for (const key of keys) count = (count + this.totalPresses(key)) | 0;
      }
    }
    return count;
  }

  /** 1400c46c0 arms skip release and consumes each configured skip key once. */
  armSkipRelease(): void {
    this.skipReleaseLatch = true;
    for (const key of this.groups.get(0x80000000)!) this.consumeKey(key);
  }

  /** 1400c5810 handles held-skip, forced-skip and the release latch independently. */
  skipRequested(): boolean {
    let pressed = false,
      result = this.skipForced;
    if (this.foreground && this.enabled !== 0) {
      for (const key of this.groups.get(0x80000000)!) {
        const state = this.queryKey(key);
        pressed ||= (state & 0x8000) !== 0;
        if (!this.skipReleaseLatch) {
          if ((state & 0x8000) !== 0 && this.inputActive) return this.skipAllowed !== 0;
        } else if (this.consumeKey(key) !== 0 && this.inputActive) result = 1;
      }
    }
    if (this.skipReleaseLatch && !pressed) this.skipReleaseLatch = false;
    return result !== 0 && this.skipAllowed !== 0;
  }

  pointerPosition(): readonly [number, number] {
    if (!this.pointerAvailable) return [0, 0];
    if (this.touchPositions.length !== 0) return this.touchPositions[0]!;
    return this.display.transformPoint(this.pointerClientX, this.pointerClientY, 1);
  }

  /** 1400ef820 stores the logical position only for the five supported buttons. */
  recordClickPosition(index: number, clientX: number, clientY: number): boolean {
    index >>>= 0;
    if (index >= 5) return false;
    const [x, y] = this.display.transformPoint(clientX, clientY, 1);
    this.clickPositions[index * 2] = x;
    this.clickPositions[index * 2 + 1] = y;
    return true;
  }

  /** 1400efeb0 validates the index before touching the caller's destination. */
  clickPosition(index: number): readonly [number, number] | null {
    index >>>= 0;
    return index < 5
      ? [this.clickPositions[index * 2]!, this.clickPositions[index * 2 + 1]!]
      : null;
  }

  /** AB3C0 reads the actual capture nodes; no separate diagnostic registry. */
  captureDiagnosticView(): {
    pointer: readonly AokanaInputCaptureView[];
    key: readonly AokanaInputCaptureView[];
  } {
    return {pointer: this.pointerCaptures, key: this.keyCaptures};
  }

  private insertCapture(
    list: Capture[],
    token: number,
    rectangle: AokanaNativeRectangle,
    object: AokanaInputHitObject | null,
  ): void {
    token >>>= 0;
    let index = 0;
    while (index < list.length && token < list[index]!.token) index++;
    list.splice(index, 0, {
      token,
      rectangle: [rectangle[0] | 0, rectangle[1] | 0, rectangle[2] | 0, rectangle[3] | 0],
      object,
    });
  }

  installPointerCapture(token: number): void {
    this.insertCapture(this.pointerCaptures, token, FULL_RECTANGLE, null);
  }
  installKeyCapture(token: number): void {
    this.insertCapture(this.keyCaptures, token, EMPTY_RECTANGLE, null);
  }
  installObjectCapture(
    token: number,
    rectangle: AokanaNativeRectangle,
    object: AokanaInputHitObject | null,
  ): void {
    this.insertCapture(this.pointerCaptures, token, rectangle, object);
  }
  releasePointerCapture(token: number): boolean {
    const index = this.pointerCaptures.findIndex((node) => node.token === token >>> 0);
    if (index < 0) return false;
    this.pointerCaptures.splice(index, 1);
    return true;
  }
  /** 1400C4E30/1400C4930 remove the first pointer capture with this object identity. */
  releaseObjectCapture(object: AokanaInputHitObject): boolean {
    const index = this.pointerCaptures.findIndex((node) => node.object === object);
    if (index < 0) return false;
    this.pointerCaptures.splice(index, 1);
    return true;
  }
  releaseKeyCapture(token: number): boolean {
    const index = this.keyCaptures.findIndex((node) => node.token === token >>> 0);
    if (index < 0) return false;
    this.keyCaptures.splice(index, 1);
    return true;
  }
  resetCaptures(): void {
    this.pointerCaptures.length = this.keyCaptures.length = 0;
    this.installPointerCapture(1);
    this.installKeyCapture(1);
  }

  keyCaptureAllowed(token: number): boolean {
    return (
      this.enabled !== 0 &&
      (this.keyCaptures.length === 0 || this.keyCaptures[0]!.token <= token >>> 0)
    );
  }

  /** 1400c52e0 preserves sorted occlusion, signed inclusive bounds and native object calls. */
  pointerCaptureAllowed(token: number): boolean {
    if (this.enabled === 0) return false;
    token >>>= 0;
    const [x, y] = this.pointerPosition();
    const inView =
      x >= 0 &&
      x < (this.display.logicalWidth | 0) &&
      y >= 0 &&
      y < (this.display.logicalHeight | 0);
    for (const node of this.pointerCaptures) {
      if (node.object !== null) {
        if (!inView || node.object.inputActive() === 0) continue;
        const rectangle = node.object.inputRectangle(0);
        node.rectangle =
          'left' in rectangle
            ? [rectangle.left, rectangle.top, rectangle.right, rectangle.bottom]
            : rectangle;
      }
      if (node.token < token) return false;
      const [left, top, right, bottom] = node.rectangle;
      if (x < left || x > right || y < top || y > bottom) continue;
      const hit =
        node.object === null || node.object.inputHitTest((x - left) | 0, (y - top) | 0, 1) !== 0;
      if (hit) return node.token === token;
    }
    return false;
  }

  collect(keyToken: number, pointerToken: number): number {
    let result = 0;
    if (this.keyCaptureAllowed(keyToken)) {
      for (const [mask, keys] of this.groups) {
        if (mask < 0x40 || mask === 0x80000000) continue;
        for (const key of keys) {
          if (this.consumeKey(key) !== 0) {
            result |= mask;
            break;
          }
        }
      }
      if (this.skipRequested()) result |= 0x80000000;
    }
    if (this.pointerCaptureAllowed(pointerToken)) {
      for (const [key, mask] of [
        [1, 1],
        [2, 2],
        [4, 4],
        [5, 0x10],
        [6, 0x20],
      ]) {
        if (this.consumeKey(key!) !== 0) result |= mask!;
      }
    }
    return result >>> 0;
  }
}

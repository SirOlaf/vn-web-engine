import type {DirectInputJoystickState} from '../../input/directinput-joystick.js';

/** One frame's device sample for `ArtemisInput.update`. */
export interface ArtemisInputSample {
  /** Virtual-key codes held at the update (GetAsyncKeyState high bit). A host that
   * receives a press and release between two updates reports the key held once, so the
   * press is not lost. */
  readonly down: ReadonlySet<number>;
  /** Wheel notches since the last update: 136 up, 137 down (0x1400aca40). */
  readonly wheel?: readonly (136 | 137)[];
  /** The pointer is inside the client area (virtual +0x48, required for keys 1 and 2). */
  readonly pointerInside: boolean;
  /** The game window is the foreground window (virtual +0xe8, 0x1400b5650); absent means
   * foreground. */
  readonly foreground?: boolean;
  /** The game controller state (GetDeviceState after Poll), axes in -1000..1000
   * (DIPROP_RANGE set by 0x140178db0); absent without a device. */
  readonly joystick?: DirectInputJoystickState | null;
}

/** Query slots of CArtemisInput (vftable 0x140369ea0), in override bit order. */
export type ArtemisInputQuery = 'push' | 'down' | 'downEdge' | 'upEdge' | 'decide';
const queryBit: Record<ArtemisInputQuery, number> = {
  push: 1,
  down: 2,
  downEdge: 3,
  upEdge: 4,
  decide: 5,
};

/** Keys whose decide query is their up edge (CInput +0x3138, set through virtual +0x98).
 * Rev.3179 has no decoded writer, so decide is the down edge for every key. */
const decideOnRelease: ReadonlySet<number> = new Set();
/** CInputBase +8: a key held this many milliseconds repeats every update. */
const REPEAT_DELAY = 500;
/** DIPROP_RANGE of every joystick axis is -JOYSTICK_RANGE..JOYSTICK_RANGE. */
export const ARTEMIS_JOYSTICK_RANGE = 1000;
/** Joystick keys 0x120..0x12f: [axis, sign] past +-499 (lX lY lZ lRx lRy lRz slider0 slider1). */
const JOYSTICK_AXIS_KEYS: readonly (readonly [number, -1 | 1])[] = [
  [0, -1],
  [1, -1],
  [0, 1],
  [1, 1],
  [2, -1],
  [2, 1],
  [3, -1],
  [4, -1],
  [3, 1],
  [4, 1],
  [5, -1],
  [5, 1],
  [6, -1],
  [6, 1],
  [7, -1],
  [7, 1],
];
const WHEEL_UP = 0x88,
  WHEEL_DOWN = 0x89,
  /** A touch tap; key 1 queries fall back to it. */
  TAP = 0x8a;

/** CArtemisInput (0x1400f5a30 over CInput 0x140177e90): per-key states updated once a
 * frame and the one-frame overrides of Lua `overrideKey`.
 *
 * Keys 0..0xff hold 0 idle, 1 pressed this update, 2 held, 3 held past the repeat delay
 * (every update) and 4 released this update (update 0x140178130). The wheel keys 136/137
 * are not sampled: a notch sets state 1, which persists until a push, down or down-edge
 * query that sees it resets it to 0. Keys 0x100..0x13f are joystick states with the same
 * transitions: 0x100+i button i, 0x120..0x12f axes past +-499 (`JOYSTICK_AXIS_KEYS`),
 * 0x130+4n+d POV n left, up, right, down (sectors of 90 degrees centered on each
 * direction; a centered POV holds none). The native update leaves them unchanged when the
 * device read fails; here a lost or absent device releases them.
 *
 * Queries (virtual +0x18 push: 1 or 3; +0x20 down: 1..3; +0x28 down edge: 1; +0x30 up
 * edge: 4; +0x38 decide) first consult the override of keys below 0x140: a nonzero
 * override answers with its bit 1..5. Otherwise a key is false while the window is not
 * the foreground window, and keys 1 and 2 also require the pointer inside the client area. A false key 1 query repeats for the tap key 0x8a. `update` (virtual +8,
 * 0x1400b51a0) clears every override after sampling. */
export class ArtemisInput {
  private readonly states = new Uint32Array(0x140);
  private readonly pressedAt = new Uint32Array(0x140);
  private readonly overrides = new Uint32Array(0x140);
  private inside = false;
  private foreground = true;

  update(now: number, sample: ArtemisInputSample): void {
    const tick = now >>> 0;
    for (let key = 0; key < 0x100; key++)
      if (key !== WHEEL_UP && key !== WHEEL_DOWN) this.step(key, sample.down.has(key), tick);
    const joystick = sample.joystick;
    for (let key = 0x100; key < 0x140; key++)
      this.step(key, !!joystick && joystickHeld(joystick, key - 0x100), tick);
    for (const key of sample.wheel ?? []) this.states[key] = 1;
    this.inside = sample.pointerInside;
    this.foreground = sample.foreground ?? true;
    this.overrides.fill(0);
  }

  private step(key: number, held: boolean, tick: number): void {
    const state = this.states[key]!;
    if (held) {
      if ((state & ~4) === 0) {
        this.states[key] = 1;
        this.pressedAt[key] = tick;
      } else this.states[key] = (this.pressedAt[key]! + REPEAT_DELAY) >>> 0 < tick ? 3 : 2;
    } else this.states[key] = state >= 1 && state <= 3 ? 4 : 0;
  }

  /** Lua `overrideKey` (0x140135480): `status` absent (or -1) clears the override,
   * otherwise it becomes `status & 0x3e | 1`; `key` absent (or -1) applies to every key.
   * Keys from 0x140 are refused. */
  override(key: number | undefined, status: number | undefined): boolean {
    const value =
      status === undefined || status >>> 0 === 0xffffffff ? 0 : ((status & 0x3e) | 1) >>> 0;
    if (key === undefined || key >>> 0 === 0xffffffff) {
      this.overrides.fill(value);
      return true;
    }
    if (key >>> 0 >= 0x140) return false;
    this.overrides[key] = value;
    return true;
  }

  query(kind: ArtemisInputQuery, key: number): boolean {
    return this.answer(kind, key) || (key === 1 && this.answer(kind, TAP));
  }

  private answer(kind: ArtemisInputQuery, key: number): boolean {
    if (key >>> 0 < 0x140 && this.overrides[key])
      return !!((this.overrides[key]! >> queryBit[kind]) & 1);
    if (kind === 'decide') return this.state(decideOnRelease.has(key) ? 'upEdge' : 'downEdge', key);
    return this.state(kind, key);
  }

  private state(kind: Exclude<ArtemisInputQuery, 'decide'>, key: number): boolean {
    if (!this.foreground) return false;
    if ((key === 1 || key === 2) && !this.inside) return false;
    if (key < 0 || key >= 0x140) throw Error('Unsupported Artemis input key ' + key);
    const state = this.states[key]!;
    const result =
      kind === 'push'
        ? state === 1 || state === 3
        : kind === 'down'
          ? state >= 1 && state <= 3
          : kind === 'downEdge'
            ? state === 1
            : state === 4;
    // A seen wheel notch is consumed.
    if (result && kind !== 'upEdge' && (key === WHEEL_UP || key === WHEEL_DOWN))
      this.states[key] = 0;
    return result;
  }
}

/** Whether joystick key 0x100 + `index` is held (update 0x140178130). */
function joystickHeld(state: DirectInputJoystickState, index: number): boolean {
  if (index < 32) return ((state.buttons[index] ?? 0) & 0x80) !== 0;
  if (index < 48) {
    const [axis, sign] = JOYSTICK_AXIS_KEYS[index - 32]!;
    const value = state.axes[axis] ?? 0;
    return sign < 0 ? value < -499 : value > 499;
  }
  const pov = (state.povs[(index - 48) >> 2] ?? 0xffffffff) >>> 0;
  if ((pov & 0xffff) === 0xffff) return false;
  switch ((index - 48) & 3) {
    case 0:
      return (pov - 22500) >>> 0 < 9000;
    case 1:
      return (pov - 4500) >>> 0 > 26999;
    case 2:
      return (pov - 4500) >>> 0 < 9000;
    default:
      return (pov - 13500) >>> 0 < 9000;
  }
}

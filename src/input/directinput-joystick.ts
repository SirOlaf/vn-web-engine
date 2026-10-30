/** DIJOYSTATE (c_dfDIJoystick, 80 bytes) as a DirectInput game controller reports it. */
export interface DirectInputJoystickState {
  /** lX, lY, lZ, lRx, lRy, lRz, rglSlider[0], rglSlider[1] within the DIPROP_RANGE. */
  readonly axes: readonly number[];
  /** rgdwPOV[0..3] in hundredths of a degree clockwise from up; 0xffffffff when centered. */
  readonly povs: readonly number[];
  /** rgbButtons[0..31]: 0x80 while held. */
  readonly buttons: readonly number[];
}

export interface BrowserGamepadSnapshot {
  readonly id: string;
  readonly connected: boolean;
  readonly mapping: string;
  readonly axes: readonly number[];
  readonly buttons: readonly {readonly pressed: boolean; readonly value: number}[];
}

export interface BrowserGamepadProvider {
  getGamepads(): ArrayLike<BrowserGamepadSnapshot | null>;
}

const CENTERED = 0xffffffff;
/** Standard-mapping button indices of the d-pad. */
const DPAD = {up: 12, down: 13, left: 14, right: 15};
/** DirectInput button order of an XInput controller (A B X Y LB RB Back Start LS RS). */
const XINPUT_BUTTONS = [0, 1, 2, 3, 4, 5, 8, 9, 10, 11];
/** DirectInput button order of a DualShock 4 / DualSense (Square Cross Circle Triangle L1 R1
 * L2 R2 Share Options L3 R3 PS Touchpad). */
const SONY_BUTTONS = [2, 0, 1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 16, 17];
const SONY_VENDOR = /(?:Vendor: |^)054c\b/i;

const unit = (value: number | undefined): number =>
  Number.isFinite(value) ? Math.max(-1, Math.min(1, value!)) : 0;

function pov(gamepad: BrowserGamepadSnapshot): number {
  const held = (index: number) => gamepad.buttons[index]?.pressed === true;
  const up = held(DPAD.up),
    down = held(DPAD.down),
    left = held(DPAD.left),
    right = held(DPAD.right);
  if ((up && down) || (left && right)) return CENTERED;
  if (up) return right ? 4500 : left ? 31500 : 0;
  if (down) return right ? 13500 : left ? 22500 : 18000;
  return right ? 9000 : left ? 27000 : CENTERED;
}

/**
 * The DIJOYSTATE a Windows driver would report for a browser gamepad, axes scaled to
 * `-range..range`. Standard-mapping pads take the layout of their DirectInput driver: Sony
 * pads (vendor 054c) the DualShock 4 layout (Z/Rz right stick, Rx/Ry the L2/R2 triggers from
 * -range), others the XInput layout (Rx/Ry right stick, Z the triggers, LT positive). The
 * d-pad is POV 0. Other mappings pass buttons and the first eight axes through in order.
 */
export function directInputJoystickState(
  gamepad: BrowserGamepadSnapshot,
  range: number,
): DirectInputJoystickState {
  const axis = (index: number) => unit(gamepad.axes[index]);
  const trigger = (index: number) => unit(gamepad.buttons[index]?.value);
  const scale = (value: number) => Math.round(value * range);
  const buttons = new Array<number>(32).fill(0),
    povs = [CENTERED, CENTERED, CENTERED, CENTERED];
  let axes: number[];
  if (gamepad.mapping === 'standard') {
    const sony = SONY_VENDOR.test(gamepad.id);
    (sony ? SONY_BUTTONS : XINPUT_BUTTONS).forEach((source, index) => {
      if (gamepad.buttons[source]?.pressed) buttons[index] = 0x80;
    });
    povs[0] = pov(gamepad);
    axes = sony
      ? [axis(0), axis(1), axis(2), trigger(6) * 2 - 1, trigger(7) * 2 - 1, axis(3), 0, 0]
      : [axis(0), axis(1), trigger(6) - trigger(7), axis(2), axis(3), 0, 0, 0];
  } else {
    for (let index = 0; index < 32; index++)
      if (gamepad.buttons[index]?.pressed) buttons[index] = 0x80;
    axes = Array.from({length: 8}, (_, index) => axis(index));
  }
  return {axes: axes.map(scale), povs, buttons};
}

/** The first attached game controller (DIEDFL_ATTACHEDONLY enumeration stopping at the first
 * device), read once per call; null without one or without the Gamepad API. */
export function readBrowserJoystick(
  provider: BrowserGamepadProvider | undefined,
  range: number,
): DirectInputJoystickState | null {
  let gamepads: ArrayLike<BrowserGamepadSnapshot | null>;
  try {
    gamepads = provider?.getGamepads() ?? [];
  } catch {
    // A document without gamepad permission reports no devices.
    return null;
  }
  for (const gamepad of Array.from(gamepads))
    if (gamepad?.connected) return directInputJoystickState(gamepad, range);
  return null;
}

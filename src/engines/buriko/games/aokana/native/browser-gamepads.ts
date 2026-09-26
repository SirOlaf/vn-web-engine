import {
  AOKANA_GAMEPAD_FAILURE,
  type AokanaNativeGamepadCapabilities,
  type AokanaNativeGamepadDevice,
  type AokanaNativeGamepadEvent,
  type AokanaNativeGamepadEventResult,
  type AokanaNativeGamepadHost,
  type AokanaNativeGamepadState,
  type AokanaNativeGamepadStateResult,
} from './gamepads.js';

export interface AokanaBrowserGamepadButton {
  readonly pressed: boolean;
  readonly value: number;
}

/** Minimal structural Gamepad surface, kept injectable for workers and ordinary tests. */
export interface AokanaBrowserGamepadSnapshot {
  readonly id: string;
  readonly index: number;
  readonly connected: boolean;
  readonly mapping: string;
  readonly axes: readonly number[];
  readonly buttons: readonly AokanaBrowserGamepadButton[];
}

export interface AokanaBrowserGamepadProvider {
  getGamepads(): ArrayLike<AokanaBrowserGamepadSnapshot | null>;
}

export interface AokanaBrowserGamepadAxisProfile {
  readonly index: number;
  readonly invert?: boolean;
}

export interface AokanaBrowserGamepadPovProfile {
  readonly up: number;
  readonly right: number;
  readonly down: number;
  readonly left: number;
}

/**
 * A selected browser device and its explicit DirectInput identity/shape. browserId
 * only selects a provider entry; instanceGuid is independent and authoritative.
 */
export interface AokanaBrowserGamepadProfile {
  readonly browserIndex: number;
  readonly browserId: string;
  readonly browserMapping: string;
  readonly instanceGuid: string;
  readonly capabilities: AokanaNativeGamepadCapabilities;
  /** Exactly eight sources for X/Y/Z/RX/RY/RZ/slider0/slider1. */
  readonly axes: readonly (AokanaBrowserGamepadAxisProfile | null)[];
  /** Exactly four browser direction-button hats. */
  readonly povs: readonly (AokanaBrowserGamepadPovProfile | null)[];
  /** Exactly thirty-two browser button sources. */
  readonly buttons: readonly (number | null)[];
}

interface OwnedProfile extends AokanaBrowserGamepadProfile {
  readonly capabilities: AokanaNativeGamepadCapabilities;
  readonly axes: readonly (AokanaBrowserGamepadAxisProfile | null)[];
  readonly povs: readonly (AokanaBrowserGamepadPovProfile | null)[];
  readonly buttons: readonly (number | null)[];
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validIndex = (value: number): boolean => Number.isInteger(value) && value >= 0;

function ownProfile(source: AokanaBrowserGamepadProfile): OwnedProfile {
  if (!validIndex(source.browserIndex))
    throw new RangeError('Aokana browser gamepad index must be a nonnegative integer');
  if (!GUID.test(source.instanceGuid))
    throw new TypeError('Aokana browser gamepad requires a canonical explicit instance GUID');
  if (source.capabilities.size !== 44)
    throw new RangeError('Aokana browser gamepad capabilities must be the 44-byte record');
  if (source.axes.length !== 8 || source.povs.length !== 4 || source.buttons.length !== 32)
    throw new RangeError(
      'Aokana browser gamepad profile must map exactly 8 axes, 4 POVs and 32 buttons',
    );
  for (const axis of source.axes)
    if (axis !== null && !validIndex(axis.index))
      throw new RangeError('Invalid Aokana browser gamepad axis source');
  for (const button of source.buttons)
    if (button !== null && !validIndex(button))
      throw new RangeError('Invalid Aokana browser gamepad button source');
  for (const pov of source.povs) {
    if (pov !== null && ![pov.up, pov.right, pov.down, pov.left].every(validIndex))
      throw new RangeError('Invalid Aokana browser gamepad POV source');
  }
  return Object.freeze({
    ...source,
    instanceGuid: source.instanceGuid.toLowerCase(),
    capabilities: Object.freeze({...source.capabilities}),
    axes: Object.freeze(
      source.axes.map((axis) => (axis === null ? null : Object.freeze({...axis}))),
    ),
    povs: Object.freeze(source.povs.map((pov) => (pov === null ? null : Object.freeze({...pov})))),
    buttons: Object.freeze([...source.buttons]),
  });
}

const axisValue = (value: number, invert: boolean): number => {
  const finite = Number.isFinite(value) ? value : 0,
    normalized = Math.max(-1, Math.min(1, invert ? -finite : finite));
  return Math.round(normalized * 1024) | 0;
};

const pressed = (gamepad: AokanaBrowserGamepadSnapshot, index: number): boolean =>
  gamepad.buttons[index]?.pressed === true;

function povValue(
  gamepad: AokanaBrowserGamepadSnapshot,
  profile: AokanaBrowserGamepadPovProfile | null,
): number {
  if (profile === null) return 0xffffffff;
  const up = pressed(gamepad, profile.up),
    right = pressed(gamepad, profile.right),
    down = pressed(gamepad, profile.down),
    left = pressed(gamepad, profile.left);
  if ((up && down) || (left && right)) return 0xffffffff;
  if (up) return right ? 4500 : left ? 31500 : 0;
  if (down) return right ? 13500 : left ? 22500 : 18000;
  if (right) return 9000;
  if (left) return 27000;
  return 0xffffffff;
}

function stateFrom(
  gamepad: AokanaBrowserGamepadSnapshot,
  profile: OwnedProfile,
): AokanaNativeGamepadState {
  const axes = profile.axes.map((axis) =>
      axis === null ? 0 : axisValue(gamepad.axes[axis.index]!, axis.invert === true),
    ),
    povs = profile.povs.map((pov) => povValue(gamepad, pov)),
    buttons = profile.buttons.map((index) =>
      index !== null && pressed(gamepad, index) ? 0x80 : 0,
    );
  return {axes, povs, buttons};
}

function validSources(gamepad: AokanaBrowserGamepadSnapshot, profile: OwnedProfile): boolean {
  return (
    profile.axes.every((axis) => axis === null || axis.index < gamepad.axes.length) &&
    profile.buttons.every((index) => index === null || index < gamepad.buttons.length) &&
    profile.povs.every(
      (pov) =>
        pov === null ||
        [pov.up, pov.right, pov.down, pov.left].every((index) => index < gamepad.buttons.length),
    )
  );
}

class AokanaBrowserGamepadDevice implements AokanaNativeGamepadDevice {
  readonly instanceGuid: string;
  private configured = false;
  private previous: AokanaNativeGamepadState | null = null;
  private readonly events: AokanaNativeGamepadEvent[] = [];

  constructor(
    private readonly host: AokanaBrowserGamepads,
    private readonly profile: OwnedProfile,
  ) {
    this.instanceGuid = profile.instanceGuid;
  }

  private gamepad(): AokanaBrowserGamepadSnapshot | null {
    return this.host.selected(this.profile);
  }

  readCapabilities(): {
    readonly status: number;
    readonly capabilities?: AokanaNativeGamepadCapabilities;
  } {
    return this.gamepad() === null
      ? {status: AOKANA_GAMEPAD_FAILURE}
      : {status: 0, capabilities: {...this.profile.capabilities}};
  }

  configure(): number {
    const gamepad = this.gamepad();
    if (gamepad === null || !validSources(gamepad, this.profile)) return AOKANA_GAMEPAD_FAILURE;
    this.previous = stateFrom(gamepad, this.profile);
    this.events.length = 0;
    this.configured = true;
    return 0; // The concrete Gamepad provider is polled before every buffered read.
  }

  poll(): number {
    const gamepad = this.configured ? this.gamepad() : null;
    if (gamepad === null) return AOKANA_GAMEPAD_FAILURE;
    const next = stateFrom(gamepad, this.profile),
      previous = this.previous!;
    for (let index = 0; index < 8; index++)
      if (next.axes[index] !== previous.axes[index])
        this.events.push({offset: index * 4, value: next.axes[index]!});
    for (let index = 0; index < 4; index++)
      if (next.povs[index] !== previous.povs[index])
        this.events.push({offset: 32 + index * 4, value: next.povs[index]!});
    for (let index = 0; index < 32; index++)
      if (next.buttons[index] !== previous.buttons[index])
        this.events.push({offset: 48 + index, value: next.buttons[index]!});
    this.previous = next;
    return 0;
  }

  acquire(): number {
    const gamepad = this.configured ? this.gamepad() : null;
    if (gamepad === null) return AOKANA_GAMEPAD_FAILURE;
    this.previous = stateFrom(gamepad, this.profile);
    this.events.length = 0;
    return 0;
  }

  readState(): AokanaNativeGamepadStateResult {
    const gamepad = this.configured ? this.gamepad() : null;
    return gamepad === null
      ? {status: AOKANA_GAMEPAD_FAILURE}
      : {status: 0, state: stateFrom(gamepad, this.profile)};
  }

  readBufferedEvent(): AokanaNativeGamepadEventResult {
    if (!this.configured || this.gamepad() === null)
      return {status: AOKANA_GAMEPAD_FAILURE, event: null};
    return {status: 0, event: this.events.shift() ?? null};
  }

  close(): void {
    this.configured = false;
    this.previous = null;
    this.events.length = 0;
  }
}

/** Concrete adapter over Navigator.getGamepads and only explicitly selected profiles. */
export class AokanaBrowserGamepads implements AokanaNativeGamepadHost {
  private readonly profiles: readonly OwnedProfile[];
  private readonly devices = new Map<string, AokanaBrowserGamepadDevice>();
  private opened = false;

  constructor(
    private readonly provider: AokanaBrowserGamepadProvider,
    profiles: readonly AokanaBrowserGamepadProfile[],
  ) {
    this.profiles = Object.freeze(profiles.map(ownProfile));
    const selectors = new Set<string>(),
      guids = new Set<string>();
    for (const profile of this.profiles) {
      const selector =
        profile.browserIndex + '\u0000' + profile.browserId + '\u0000' + profile.browserMapping;
      if (selectors.has(selector)) throw new Error('Duplicate Aokana browser gamepad selector');
      if (guids.has(profile.instanceGuid))
        throw new Error('Duplicate Aokana gamepad instance GUID');
      selectors.add(selector);
      guids.add(profile.instanceGuid);
      this.devices.set(profile.instanceGuid, new AokanaBrowserGamepadDevice(this, profile));
    }
  }

  open(): boolean {
    try {
      this.provider.getGamepads();
      this.opened = true;
      return true;
    } catch {
      this.opened = false;
      return false;
    }
  }

  private findSelected(
    gamepads: readonly (AokanaBrowserGamepadSnapshot | null)[],
    profile: OwnedProfile,
  ): AokanaBrowserGamepadSnapshot | null {
    for (const gamepad of gamepads) {
      if (
        gamepad !== null &&
        gamepad.connected &&
        gamepad.index === profile.browserIndex &&
        gamepad.id === profile.browserId &&
        gamepad.mapping === profile.browserMapping
      )
        return gamepad;
    }
    return null;
  }

  selected(profile: OwnedProfile): AokanaBrowserGamepadSnapshot | null {
    if (!this.opened) return null;
    try {
      return this.findSelected(Array.from(this.provider.getGamepads()), profile);
    } catch {
      // The primitive reports an unavailable provider without fabricating a device.
    }
    return null;
  }

  enumerateAttached(): {
    readonly status: number;
    readonly devices: readonly AokanaNativeGamepadDevice[];
  } {
    if (!this.opened) return {status: AOKANA_GAMEPAD_FAILURE, devices: []};
    try {
      const gamepads = Array.from(this.provider.getGamepads()),
        devices: AokanaNativeGamepadDevice[] = [];
      for (const profile of this.profiles) {
        if (this.findSelected(gamepads, profile) !== null)
          devices.push(this.devices.get(profile.instanceGuid)!);
      }
      return {status: 0, devices};
    } catch {
      return {status: AOKANA_GAMEPAD_FAILURE, devices: []};
    }
  }

  close(): void {
    this.opened = false;
    for (const device of this.devices.values()) device.close();
  }
}

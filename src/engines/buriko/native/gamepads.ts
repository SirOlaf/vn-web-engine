import type {BurikoNativeInput} from './input.js';
import type {BurikoNativeNotifications} from './notification-queue.js';

export const BURIKO_GAMEPAD_INPUT_LOST = 0x8007001e;
export const BURIKO_GAMEPAD_FAILURE = 0x80004005;

const POV_MERGE: readonly (readonly number[])[] = [
  [0, 1, 1, 2, 0xffffffff, 6, 7, 7],
  [1, 1, 1, 2, 2, 0xffffffff, 0, 0],
  [1, 1, 2, 3, 3, 4, 0xffffffff, 0],
  [2, 2, 3, 3, 3, 4, 4, 0xffffffff],
  [0xffffffff, 2, 3, 3, 4, 5, 5, 6],
  [6, 0xffffffff, 4, 4, 5, 5, 5, 6],
  [7, 0, 0xffffffff, 4, 5, 5, 6, 7],
  [7, 0, 0, 0xffffffff, 6, 6, 7, 7],
];

/** The copied 44-byte DIDEVCAPS record owned by each native gamepad node. */
export interface BurikoNativeGamepadCapabilities {
  readonly size: number;
  readonly flags: number;
  readonly deviceType: number;
  readonly axes: number;
  readonly buttons: number;
  readonly povs: number;
  readonly forceFeedbackSamplePeriod: number;
  readonly forceFeedbackMinimumTimeResolution: number;
  readonly firmwareRevision: number;
  readonly hardwareRevision: number;
  readonly forceFeedbackDriverVersion: number;
}

/** The fixed 80-byte DIJOYSTATE layout selected by DIDATAFORMAT 14014fe80. */
export interface BurikoNativeGamepadState {
  /** X, Y, Z, RX, RY, RZ and two sliders, at byte offsets 0 through 28. */
  readonly axes: readonly number[];
  /** Four centidegree POV values, at byte offsets 32 through 44. */
  readonly povs: readonly number[];
  /** Thirty-two raw button bytes, at byte offsets 48 through 79. */
  readonly buttons: readonly number[];
}

export interface BurikoNativeGamepadEvent {
  readonly offset: number;
  readonly value: number;
}

export interface BurikoNativeGamepadStateResult {
  readonly status: number;
  readonly state?: BurikoNativeGamepadState;
}

export interface BurikoNativeGamepadEventResult {
  readonly status: number;
  readonly event: BurikoNativeGamepadEvent | null;
}

/**
 * Explicit DirectInput-shaped host device. Implementations own acquisition, the fixed
 * 44-object format, [-1024,1024] axis ranges and the 4096-entry buffered-event configuration.
 */
export interface BurikoNativeGamepadDevice {
  /** Canonical GUID supplied by the selected host profile, never derived from a browser ID. */
  readonly instanceGuid: string;
  readCapabilities(): {
    readonly status: number;
    readonly capabilities?: BurikoNativeGamepadCapabilities;
  };
  /** The returned status is the initial Poll result; zero means this device needs Poll. */
  configure(): number;
  poll(): number;
  acquire(): number;
  readState(): BurikoNativeGamepadStateResult;
  readBufferedEvent(): BurikoNativeGamepadEventResult;
  close(): void;
}

/** DirectInput8 creation/enumeration/release boundary used by the native owner. */
export interface BurikoNativeGamepadHost {
  open(): boolean;
  enumerateAttached(): {
    readonly status: number;
    readonly devices: readonly BurikoNativeGamepadDevice[];
  };
  close(): void;
}

export interface BurikoNativeGamepadQuery {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly rz: number;
  readonly pov: number;
  readonly buttons: number;
}

interface GamepadNode {
  readonly id: number;
  readonly instanceGuid: string;
  readonly device: BurikoNativeGamepadDevice;
  readonly capabilities: BurikoNativeGamepadCapabilities;
  needsPoll: number;
  configured: number;
}

const failed = (status: number): boolean => (status | 0) < 0;
const clampAxis = (value: number): number => Math.max(-1024, Math.min(1024, value | 0));
const copyCapabilities = (
  value: BurikoNativeGamepadCapabilities,
): BurikoNativeGamepadCapabilities => ({
  size: value.size >>> 0,
  flags: value.flags >>> 0,
  deviceType: value.deviceType >>> 0,
  axes: value.axes >>> 0,
  buttons: value.buttons >>> 0,
  povs: value.povs >>> 0,
  forceFeedbackSamplePeriod: value.forceFeedbackSamplePeriod >>> 0,
  forceFeedbackMinimumTimeResolution: value.forceFeedbackMinimumTimeResolution >>> 0,
  firmwareRevision: value.firmwareRevision >>> 0,
  hardwareRevision: value.hardwareRevision >>> 0,
  forceFeedbackDriverVersion: value.forceFeedbackDriverVersion >>> 0,
});

/**
 * The title-local DirectInput owner at 1e6b28..1e6c38. Device IDs are monotonic,
 * nodes are newest-first, while mappings and shared axis caches survive shutdown.
 */
export class BurikoNativeGamepads {
  enabled = 0;
  private counter = 0;
  private readonly mappings = new Uint32Array(36);
  private readonly axisCache = new Int32Array(4); // X, Y, Z, RZ.
  private readonly nodes: GamepadNode[] = [];
  private readonly pendingDeviceCloses: BurikoNativeGamepadDevice[] = [];

  constructor(
    readonly host: BurikoNativeGamepadHost,
    readonly input: BurikoNativeInput,
    readonly notifications: BurikoNativeNotifications,
  ) {}

  get pendingDeviceCloseCount(): number {
    return this.pendingDeviceCloses.length;
  }

  private closeDevice(device: BurikoNativeGamepadDevice): void {
    try {
      device.close();
    } catch (error) {
      this.pendingDeviceCloses.push(device);
      throw error;
    }
  }

  /** B38C0 writes every DWORD mapping verbatim and preserves the table across shutdown. */
  setMapping(index: number, value: number): number {
    index >>>= 0;
    if (index >= this.mappings.length) return 0x80000002;
    this.mappings[index] = value >>> 0;
    return 0;
  }

  mapping(index: number): number | undefined {
    index >>>= 0;
    return index < this.mappings.length ? this.mappings[index]! : undefined;
  }

  get deviceCounter(): number {
    return this.counter;
  }

  get deviceIds(): readonly number[] {
    return this.nodes.map((node) => node.id);
  }

  get cachedAxes(): readonly number[] {
    return [...this.axisCache];
  }

  capabilities(id: number): BurikoNativeGamepadCapabilities | null {
    const node = this.nodes.find((candidate) => candidate.id === id >>> 0);
    return node === undefined ? null : {...node.capabilities};
  }

  /** B3D60: replace the DirectInput owner, enumerate/configure, then enable it. */
  initialize(): number {
    this.shutdown();
    try {
      if (this.host.open() && this.refresh() !== 0) {
        this.enabled = 1;
        return 1;
      }
      this.shutdown();
      return 0;
    } catch (error) {
      try {
        this.shutdown();
      } catch {
        // Preserve the host-open or refresh failure after attempting all owned closes.
      }
      throw error;
    }
  }

  /** B3DD0/B3FE0: skip GUID duplicates, prepend accepted devices and configure all nodes. */
  refresh(): number {
    const enumeration = this.host.enumerateAttached();
    if (failed(enumeration.status)) return 0;
    const unlinked = new Set(enumeration.devices);
    try {
      for (const device of enumeration.devices) {
        if (this.nodes.some((node) => node.instanceGuid === device.instanceGuid)) {
          unlinked.delete(device);
          continue;
        }
        const result = device.readCapabilities(),
          capabilities = result.capabilities;
        if (
          failed(result.status) ||
          capabilities === undefined ||
          ((capabilities.deviceType & 0xff) - 20) >>> 0 >= 2 ||
          capabilities.axes >>> 0 <= 1 ||
          capabilities.buttons >>> 0 === 0
        ) {
          unlinked.delete(device);
          this.closeDevice(device);
          continue;
        }
        this.counter = (this.counter + 1) >>> 0;
        this.nodes.unshift({
          id: this.counter,
          instanceGuid: device.instanceGuid,
          device,
          capabilities: copyCapabilities(capabilities),
          needsPoll: 0,
          configured: 0,
        });
        unlinked.delete(device);
      }
    } catch (error) {
      for (const device of unlinked)
        try {
          this.closeDevice(device);
        } catch {
          // Preserve the enumeration/capability failure; shutdown can retry close.
        }
      throw error;
    }
    for (let index = 0; index < this.nodes.length;) {
      const node = this.nodes[index]!;
      if (this.configure(node) !== 0) index++;
      else this.removeAt(index);
    }
    return 1;
  }

  private configure(node: GamepadNode): number {
    if (node.configured !== 0) return node.configured;
    const status = node.device.configure();
    if (!failed(status)) {
      node.configured = 1;
      node.needsPoll = Number(status >>> 0 === 0);
    }
    return node.configured;
  }

  /** B41C0 preserves the monotonic counter, 36 mappings and four shared axis caches. */
  shutdown(): void {
    this.enabled = 0;
    let failed = false;
    let firstError: unknown;
    while (this.nodes.length !== 0) {
      try {
        this.removeAt(0);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
      }
    }
    const pending = this.pendingDeviceCloses.splice(0);
    for (const device of pending) {
      try {
        this.closeDevice(device);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
      }
    }
    try {
      this.host.close();
    } catch (error) {
      if (!failed) {
        failed = true;
        firstError = error;
      }
    }
    if (failed) throw firstError;
  }

  remove(id: number): number {
    const index = this.nodes.findIndex((node) => node.id === id >>> 0);
    if (index < 0) return 0;
    this.removeAt(index);
    return 1;
  }

  private removeAt(index: number): void {
    const [node] = this.nodes.splice(index, 1);
    this.closeDevice(node!.device);
  }

  /** B35F0: query one ID or merge all present nodes without consulting enabled. */
  query(selector: number): BurikoNativeGamepadQuery | null {
    selector >>>= 0;
    let x = 0,
      y = 0,
      z = 0,
      rz = 0,
      pov = 0xffffffff,
      buttons = 0,
      succeeded = false;
    for (const node of this.nodes) {
      if (selector !== 0 && selector !== node.id) continue;
      const result = node.device.readState(),
        state = result.state;
      if (!failed(result.status) && state !== undefined) {
        x = (x + (state.axes[0]! | 0)) | 0;
        y = (y + (state.axes[1]! | 0)) | 0;
        z = (z + (state.axes[2]! | 0)) | 0;
        rz = (rz + (state.axes[5]! | 0)) | 0;
        const angle = state.povs[0]! >>> 0;
        if (angle < 36000) {
          const sector = Math.floor(angle / 4500);
          pov = pov === 0xffffffff ? sector : POV_MERGE[pov]![sector]!;
        }
        for (let index = 0; index < 32; index++) {
          if ((state.buttons[index]! & 0xff) !== 0) buttons |= 1 << index;
        }
        succeeded = true;
      }
      if (selector !== 0) break;
    }
    return succeeded
      ? {
          x: clampAxis(x),
          y: clampAxis(y),
          z: clampAxis(z),
          rz: clampAxis(rz),
          pov: pov >>> 0,
          buttons: buttons >>> 0,
        }
      : null;
  }

  private pulseMapping(index: number): void {
    const key = this.mappings[index]!;
    if (key === 0) return;
    this.input.recordKeyDown(key);
    this.input.recordKeyUp(this.mappings[index]!);
  }

  private applyEvent(node: GamepadNode, event: BurikoNativeGamepadEvent, changed: boolean[]): void {
    const offset = event.offset >>> 0,
      value = event.value >>> 0;
    if (offset === 0 || offset === 4 || offset === 8 || offset === 20) {
      const cacheIndex = offset === 20 ? 3 : offset >>> 2;
      this.axisCache[cacheIndex] = value | 0;
      changed[cacheIndex] = true;
      return;
    }
    if (offset === 32 || offset === 36 || offset === 40 || offset === 44) {
      const sector = value < 36000 ? Math.floor(value / 4500) : 0xffffffff;
      this.notifications.push(0x102, (((offset - 32) << 16) | (sector & 0xffff)) >>> 0, node.id);
      if (value < 9000) this.pulseMapping(32);
      else if (value < 18000) this.pulseMapping(35);
      else if (value < 27000) this.pulseMapping(33);
      else if (value < 36000) this.pulseMapping(34);
      return;
    }
    if (offset >= 48 && offset < 80) {
      const button = offset - 48,
        pressed = (value & 0xff) !== 0;
      this.notifications.push(0x100, (button & 0x7f) | (pressed ? 0x80 : 0), node.id);
      if (pressed) this.pulseMapping(button);
    }
  }

  private appendAxisNotification(x: number, y: number, pair: number, id: number): void {
    this.notifications.push(
      0x101,
      ((((y & 0xfff) | ((pair & 3) << 12)) << 12) | (x & 0xfff)) >>> 0,
      id,
    );
  }

  private flushAxes(node: GamepadNode, changed: readonly boolean[]): void {
    if (changed[0] || changed[1]) {
      this.appendAxisNotification(this.axisCache[0]!, this.axisCache[1]!, 0, node.id);
      if (changed[0]) {
        if (this.axisCache[0] === 1024) this.pulseMapping(35);
        else if (this.axisCache[0] === -1024) this.pulseMapping(34);
      }
      if (changed[1]) {
        if (this.axisCache[1] === 1024) this.pulseMapping(33);
        else if (this.axisCache[1] === -1024) this.pulseMapping(32);
      }
    }
    if (changed[2] || changed[3])
      this.appendAxisNotification(this.axisCache[2]!, this.axisCache[3]!, 1, node.id);
  }

  /** B38E0: drain every device's buffered records into the shared input/notification owners. */
  poll(): number {
    if (this.enabled === 0) return 1;
    for (let index = 0; index < this.nodes.length;) {
      const node = this.nodes[index]!,
        changed = [false, false, false, false];
      let succeeded = false;
      for (;;) {
        if (node.needsPoll !== 0 && failed(node.device.poll())) break;
        const result = node.device.readBufferedEvent();
        if (!failed(result.status) && result.event !== null) {
          this.applyEvent(node, result.event, changed);
          continue;
        }
        if (result.status >>> 0 === BURIKO_GAMEPAD_INPUT_LOST) {
          node.device.acquire();
          continue;
        }
        succeeded = !failed(result.status);
        break;
      }
      this.flushAxes(node, changed);
      if (succeeded) index++;
      else this.removeAt(index);
    }
    return 0;
  }
}

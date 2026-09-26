import {pop32, push32} from '../bp/state.js';
import {pointerView} from '../bp/memory.js';
import type {BurikoBpPointer} from '../bp/memory.js';
import type {BurikoNativeInput} from './input.js';
import type {BurikoNativeSlotDefinition} from './types.js';

const captureToken = (group: number): number => ((group << 16) | 0xffff) >>> 0;

/** Native key arrays are terminated DWORD sequences; all entries precede mask validation. */
function keyList(pointer: BurikoBpPointer | null): number[] {
  if (pointer === null) throw new Error('Buriko native key-list null source');
  const keys: number[] = [];
  for (let offset = pointer.offset; ; offset += 4) {
    const key = pointerView({bytes: pointer.bytes, offset}, 4).getUint32(0, true);
    if (key === 0) return keys;
    keys.push(key);
  }
}

export function createGroup80Input(input: BurikoNativeInput): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x80,
      secondary: 0x0e,
      nativeAddress: 0x1400ea050,
      name: 'ReadScriptMinimizeLatch',
      execute: (h) => {
        push32(h.thread, input.scriptMinimizeLatch);
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x08,
      nativeAddress: 0x1400ea1b0,
      name: 'PointerPosition',
      execute: (h) => {
        const [x, y] = input.pointerPosition();
        push32(h.thread, x);
        push32(h.thread, y);
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x0f,
      nativeAddress: 0x1400ea030,
      name: 'WindowForeground',
      execute: (h) => {
        push32(h.thread, Number(input.foreground));
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x10,
      nativeAddress: 0x1400ea000,
      name: 'SetInputEnabled',
      execute: (h) => {
        input.enabled = pop32(h.thread);
        input.clearTransientKeys();
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x11,
      nativeAddress: 0x1400e9fc0,
      name: 'QueryHeldKey',
      execute: (h) => {
        push32(h.thread, (input.queryKey(pop32(h.thread)) >>> 15) & 1);
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x12,
      nativeAddress: 0x1400e9f70,
      name: 'KeyPressCounts',
      execute: (h) => {
        const pointer = h.memory.resolve(h.thread, pop32(h.thread));
        // The native routine validates each key before it reads the next list item.
        if (pointer === null) throw new Error('Buriko native key-count null source');
        let sum = 0;
        for (let offset = pointer.offset; ; offset += 4) {
          const key = pointerView({bytes: pointer.bytes, offset}, 4).getUint32(0, true);
          if (key === 0) break;
          sum = (sum + input.totalPresses(key)) | 0;
        }
        push32(h.thread, sum);
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x13,
      nativeAddress: 0x1400e9f50,
      name: 'InputEventCount',
      execute: (h) => {
        push32(h.thread, input.inputEventCount);
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x14,
      nativeAddress: 0x1400e9f30,
      name: 'SetSkipAllowed',
      execute: (h) => {
        input.skipAllowed = pop32(h.thread);
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x15,
      nativeAddress: 0x1400e9f10,
      name: 'SetSkipForced',
      execute: (h) => {
        input.skipForced = pop32(h.thread);
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x16,
      nativeAddress: 0x1400e9ef0,
      name: 'ArmSkipRelease',
      execute: () => {
        input.armSkipRelease();
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x17,
      nativeAddress: 0x1400e9ec0,
      name: 'SkipRequested',
      execute: (h) => {
        push32(h.thread, Number(input.skipRequested()));
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x18,
      nativeAddress: 0x1400e9e80,
      name: 'InstallInputCapture',
      execute: (h) => {
        const token = captureToken(pop32(h.thread));
        input.installPointerCapture(token);
        input.installKeyCapture(token);
        input.collect(token, token);
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x19,
      nativeAddress: 0x1400e9e40,
      name: 'ReleaseInputCapture',
      execute: (h) => {
        const token = captureToken(pop32(h.thread));
        input.collect(token, token);
        input.releasePointerCapture(token);
        input.releaseKeyCapture(token);
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x1a,
      nativeAddress: 0x1400e9e00,
      name: 'CollectInputCapture',
      execute: (h) => {
        const token = captureToken(pop32(h.thread));
        push32(h.thread, input.collect(token, token));
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x1b,
      nativeAddress: 0x1400e9d70,
      name: 'ReplaceKeyGroup',
      execute: (h) => {
        const source = h.memory.resolve(h.thread, pop32(h.thread)),
          mask = pop32(h.thread);
        const result = input.replaceKeyGroup(mask, keyList(source));
        if (result === 0x80000001)
          throw new Error(`Buriko native invalid key-group mask 0x${mask.toString(16)}`);
        if (result === 0x80000002) throw new Error('Buriko native key-group exceeds 15 keys');
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x1c,
      nativeAddress: 0x1400e9d40,
      name: 'KeyGroupPressCount',
      execute: (h) => {
        push32(h.thread, input.groupPressCount(pop32(h.thread)));
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x1d,
      nativeAddress: 0x1400e9cd0,
      name: 'ConsumeCapturedKey',
      execute: (h) => {
        const key = pop32(h.thread),
          token = captureToken(pop32(h.thread));
        const allowed =
          key === 1 || key === 2
            ? input.pointerCaptureAllowed(token)
            : input.keyCaptureAllowed(token);
        push32(h.thread, allowed ? input.consumeKey(key) : 0);
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x1e,
      nativeAddress: 0x1400e9ca0,
      name: 'SetMouseButtonMode',
      execute: (h) => {
        const mode = pop32(h.thread);
        if (mode < 2) input.mouseButtonMode = mode;
        push32(h.thread, Number(mode < 2));
        return 0;
      },
    },
  ];
}

export function createGroup81Input(input: BurikoNativeInput): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x81,
      secondary: 0x0f,
      nativeAddress: 0x1400ec500,
      name: 'WindowIsIconic',
      execute: (h) => {
        push32(h.thread, input.iconic);
        return 0;
      },
    },
    {
      primary: 0x81,
      secondary: 0x07,
      nativeAddress: 0x1400ec740,
      name: 'ReadClickPosition',
      execute: (h) => {
        const index = pop32(h.thread),
          destination = h.memory.resolve(h.thread, pop32(h.thread));
        const point = input.clickPosition(index);
        if (point !== null) {
          if (destination === null)
            throw new Error('Buriko native click-position null destination');
          const view = pointerView(destination, 8);
          view.setInt32(0, point[0], true);
          view.setInt32(4, point[1], true);
        }
        push32(h.thread, Number(point !== null));
        return 0;
      },
    },
    {
      primary: 0x81,
      secondary: 0x10,
      nativeAddress: 0x1400ec4c0,
      name: 'ExchangeKeyOption',
      execute: (h) => {
        const value = pop32(h.thread),
          key = pop32(h.thread);
        push32(h.thread, input.exchangeKeyOption(key, value));
        return 0;
      },
    },
    {
      primary: 0x81,
      secondary: 0x11,
      nativeAddress: 0x1400ec4a0,
      name: 'ReadKeyboardState',
      execute: (h) => {
        const destination = h.memory.resolve(h.thread, pop32(h.thread));
        // A null pointer violates the required 256-byte Win32 destination contract.
        if (destination === null) throw new Error('Buriko native keyboard-state null destination');
        pointerView(destination, 256);
        destination.bytes.set(input.keyboardState, destination.offset);
        return 0;
      },
    },
    {
      primary: 0x81,
      secondary: 0x14,
      nativeAddress: 0x1400ec480,
      name: 'SetBackgroundKeyQuery',
      execute: (h) => {
        input.allowBackgroundQuery = pop32(h.thread);
        return 0;
      },
    },
    {
      primary: 0x81,
      secondary: 0x1f,
      nativeAddress: 0x1400ec280,
      name: 'SetInputAllowMask',
      execute: (h) => {
        input.allowMask = pop32(h.thread);
        return 0;
      },
    },
  ];
}

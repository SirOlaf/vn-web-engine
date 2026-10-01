import type {BurikoBpOpcodeContext, BurikoBpOpcodeHandler} from '../../native/types.js';
import {
  pop32,
  popDeferred32,
  push32,
  pushIndeterminate32,
  setPc,
  validCodeAddress,
} from '../state.js';
import {readU8} from '../decode.js';
import {accessSize, pointer, pointerBytes, readScalar, writeDeferredScalar} from './operands.js';

/** 0047f8b0 stores only selectors 0..2; every other selector leaves memory untouched. */
function store(
  h: BurikoBpOpcodeContext,
  address: number,
  type: number,
  value: {value: number; reason?: string},
): void {
  if (type > 2) return;
  if (h.diagnostics.writeWatchEnabled)
    h.diagnostics.checkWrite(h.thread, address, accessSize(type));
  writeDeferredScalar(h, address, type, value);
}

/** Differences from the x86 1.665 primary table that 1.658.5 otherwise shares.
 * Its table omits 0f, 12, 18-1f, 2c-2f, 3b, 3c, 46, 47 and 73; primary 7f is a
 * direct instruction supplied by the host opcodes. */
export function createLegacy1658CoreOpcodes(): Readonly<Record<number, BurikoBpOpcodeHandler>> {
  return {
    0x08: (h) => {
      const address = pop32(h.thread);
      pointer(h, address);
      const type = readU8(h.thread);
      // 0047f830 pushes its unrelated ECX register for selectors above two.
      if (type > 2)
        throw new Error('Buriko 1.658.5 scalar load reads an undefined native register');
      push32(h.thread, readScalar(h, address, type));
      return 0;
    },
    0x09: (h) => {
      const value = popDeferred32(h.thread),
        address = pop32(h.thread);
      pointer(h, address);
      store(h, address, readU8(h.thread), value);
      if (value.reason === undefined) push32(h.thread, value.value);
      else pushIndeterminate32(h.thread, value.reason);
      return 0;
    },
    0x0a: (h) => {
      const address = pop32(h.thread);
      pointer(h, address);
      const value = popDeferred32(h.thread);
      store(h, address, readU8(h.thread), value);
      return 0;
    },
    0x0c: (h) => {
      const type = readU8(h.thread),
        count = readU8(h.thread);
      const values: number[] = [];
      for (let i = 0; i < count; i++) values.push(pop32(h.thread));
      const address = pop32(h.thread),
        destination = pointer(h, address);
      // 0047f990's stride for selectors above two is its stack cookie, but every such store is ignored.
      if (type > 2) return 0;
      const width = accessSize(type);
      for (let i = 0; i < count; i++) {
        if (h.diagnostics.writeWatchEnabled)
          h.diagnostics.checkWrite(h.thread, (address + i * width) >>> 0, width);
        const bytes = pointerBytes(destination, width, i * width, 'write');
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const value = values[count - i - 1]!;
        if (width === 4) view.setUint32(0, value, true);
        else if (width === 2) view.setUint16(0, value, true);
        else view.setUint8(0, value);
      }
      return 0;
    },
    0x15: (h) => {
      // 0047fb50 has no relative form and switches on the complete selector byte.
      const target = pop32(h.thread),
        value = pop32(h.thread) | 0;
      let taken: boolean;
      switch (readU8(h.thread)) {
        case 0:
          taken = value !== 0;
          break;
        case 1:
          taken = value === 0;
          break;
        case 2:
          taken = value > 0;
          break;
        case 3:
          taken = value >= 0;
          break;
        case 4:
          taken = value <= 0;
          break;
        case 5:
          taken = value < 0;
          break;
        default:
          throw new Error('Buriko 1.658.5 branch selector reads an uninitialized native local');
      }
      if (taken) {
        if (!validCodeAddress(h.thread, target >>> 0))
          throw new Error(`Buriko ._bp invalid code target 0x${(target >>> 0).toString(16)}`);
        setPc(h.thread, target);
      }
      return 0;
    },
  };
}

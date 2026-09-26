import {pop32, push32} from '../bp/state.js';
import type {BurikoBpOpcodeHandler} from './types.js';

export const writeWatchOpcodes: Readonly<Record<number, BurikoBpOpcodeHandler>> = {
  0x74: ({thread, diagnostics}) => {
    diagnostics.writeWatchEnabled = pop32(thread) !== 0;
    return 0;
  },
  0x75: ({thread, memory, diagnostics}) => {
    const namePointer = memory.resolve(thread, pop32(thread));
    const size = pop32(thread);
    const address = pop32(thread);
    // A zero-sized watch returns false without dereferencing the already-resolved name.
    if (size === 0) {
      push32(thread, 0);
      return 0;
    }
    if (namePointer === null) throw new Error('Buriko write-watch name is null');
    const end = namePointer.bytes.indexOf(0, namePointer.offset);
    if (end < 0) throw new RangeError('Unterminated Buriko write-watch name');
    push32(
      thread,
      Number(
        diagnostics.registerWriteWatch(
          thread,
          address,
          size,
          namePointer.bytes.subarray(namePointer.offset, end),
        ),
      ),
    );
    return 0;
  },
};

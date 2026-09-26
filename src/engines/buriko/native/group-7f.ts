import {pop32, push32} from '../bp/state.js';
import type {BurikoBpPointer} from '../bp/memory.js';
import {pointerView} from '../bp/memory.js';
import type {
  BurikoBpOpcodeContext,
  BurikoBpOpcodeHandler,
  BurikoNativeSlotDefinition,
} from './types.js';
import {sortNativeRecords} from './record-sort.js';
import type {BurikoNativeText} from './text.js';
import {formatVmText} from './text-format.js';

const INVALID_HANDLE = 0x80000009;
const INVALID_SIZE = 0x80000008;
const INVALID_OFFSET = 0x80000010;
const ALLOCATION_FAILED = 0x80000005;

function popPointer(h: BurikoBpOpcodeContext): BurikoBpPointer | null {
  return h.memory.resolve(h.thread, pop32(h.thread));
}

function requirePointer(value: BurikoBpPointer | null): BurikoBpPointer {
  if (value === null) throw new Error('Buriko ._bp null memory dereference');
  return value;
}

function cString(value: BurikoBpPointer | null): Uint8Array | null {
  if (value === null) return null;
  const end = value.bytes.indexOf(0, value.offset);
  if (value.offset < 0 || end < 0) throw new Error('Buriko ._bp unterminated byte string');
  return value.bytes.subarray(value.offset, end);
}

/** Each native wrapper recognizes its own explicit subset of the error space. */
function status(result: number, accepted: readonly number[]): number {
  if (result === 0) return 0;
  if (!accepted.includes(result)) return 0xffffffff;
  switch (result) {
    case INVALID_HANDLE:
      return 1;
    case INVALID_OFFSET:
      return 2;
    case INVALID_SIZE:
      return 3;
    case ALLOCATION_FAILED:
      return 4;
    default:
      return 0xffffffff;
  }
}

/** All twelve non-null slots of this executable's primary 7F dispatch table. */
export function createGroup7f(text: BurikoNativeText): BurikoNativeSlotDefinition[] {
  const definitions: BurikoNativeSlotDefinition[] = [];
  const add = (
    secondary: number,
    nativeAddress: number,
    name: string,
    execute: BurikoBpOpcodeHandler,
  ): void => {
    definitions.push({primary: 0x7f, secondary, nativeAddress, name, execute});
  };
  add(0x00, 0x1400ccca0, 'SortRecords', (h) => {
    const selector = pop32(h.thread),
      keyOffset = pop32(h.thread);
    const stride = pop32(h.thread),
      count = pop32(h.thread),
      base = popPointer(h);
    push32(h.thread, sortNativeRecords(base, count, stride, keyOffset, selector));
    return 0;
  });
  add(0x80, 0x1400ccc20, 'CreateBuffer', (h) => {
    const size = pop32(h.thread),
      destination = popPointer(h);
    const result = h.memory.createBuffer(size);
    if (result.result === 0)
      pointerView(requirePointer(destination), 4).setUint32(0, result.address!, true);
    push32(h.thread, status(result.result, [ALLOCATION_FAILED, INVALID_SIZE]));
    return 0;
  });
  add(0x81, 0x1400ccbc0, 'FreeBuffer', (h) => {
    push32(h.thread, status(h.memory.freeIndirect(pop32(h.thread), 0), [INVALID_HANDLE]));
    return 0;
  });
  add(0x82, 0x1400ccb40, 'ResizeBuffer', (h) => {
    const size = pop32(h.thread),
      handle = pop32(h.thread);
    push32(
      h.thread,
      status(h.memory.resizeBuffer(handle, size), [
        ALLOCATION_FAILED,
        INVALID_SIZE,
        INVALID_HANDLE,
      ]),
    );
    return 0;
  });
  add(0x83, 0x1400ccb00, 'GetBufferSize', (h) => {
    const result = h.memory.bufferSize(pop32(h.thread));
    push32(h.thread, result.result === 0 ? result.size! : 0xffffffff);
    return 0;
  });
  add(0x84, 0x1400cca60, 'WriteBuffer', (h) => {
    const size = pop32(h.thread),
      source = popPointer(h);
    const offset = pop32(h.thread),
      handle = pop32(h.thread);
    push32(
      h.thread,
      status(h.memory.writeBuffer(handle, offset, source, size), [
        INVALID_SIZE,
        INVALID_HANDLE,
        INVALID_OFFSET,
      ]),
    );
    return 0;
  });
  add(0x85, 0x1400cc9a0, 'ReadBuffer', (h) => {
    const size = pop32(h.thread),
      offset = pop32(h.thread),
      handle = pop32(h.thread);
    const destination = popPointer(h);
    push32(
      h.thread,
      status(h.memory.readBuffer(handle, offset, destination, size), [
        INVALID_SIZE,
        INVALID_HANDLE,
        INVALID_OFFSET,
      ]),
    );
    return 0;
  });
  add(0x86, 0x1400cc8f0, 'InsertBuffer', (h) => {
    const size = pop32(h.thread),
      source = popPointer(h);
    const offset = pop32(h.thread),
      handle = pop32(h.thread);
    push32(
      h.thread,
      status(h.memory.insertBuffer(handle, offset, source, size), [
        ALLOCATION_FAILED,
        INVALID_SIZE,
        INVALID_HANDLE,
        INVALID_OFFSET,
      ]),
    );
    return 0;
  });
  add(0x88, 0x1400cc880, 'CreateString', (h) => {
    const source = popPointer(h),
      destination = popPointer(h);
    const result = h.memory.createString(() => cString(source));
    if (result.result === 0)
      pointerView(requirePointer(destination), 4).setUint32(0, result.address!, true);
    push32(h.thread, status(result.result, [ALLOCATION_FAILED]));
    return 0;
  });
  add(0x89, 0x1400cc830, 'FreeString', (h) => {
    push32(h.thread, status(h.memory.freeIndirect(pop32(h.thread), 1), [INVALID_HANDLE]));
    return 0;
  });
  add(0x8a, 0x1400cc7a0, 'InsertFormattedString', (h) => {
    const format = popPointer(h),
      offset = pop32(h.thread),
      handle = pop32(h.thread);
    let result = h.memory.stringInsertionStatus(handle, offset);
    if (result === 0) {
      result = h.memory.insertStringBytes(
        handle,
        offset,
        formatVmText(h, requirePointer(format), text),
      );
    }
    push32(h.thread, status(result, [ALLOCATION_FAILED, INVALID_HANDLE, INVALID_OFFSET]));
    return 0;
  });
  add(0x8b, 0x1400cc730, 'ReplaceFormattedString', (h) => {
    const format = popPointer(h),
      handle = pop32(h.thread);
    let result = h.memory.clearString(handle);
    if (result === 0 && format !== null) {
      result = h.memory.insertStringBytes(handle, 0, formatVmText(h, format, text));
    }
    push32(h.thread, status(result, [ALLOCATION_FAILED, INVALID_HANDLE]));
    return 0;
  });
  return definitions;
}

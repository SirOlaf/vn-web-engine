import type {BurikoBpOpcodeContext, BurikoBpOpcodeHandler} from '../../native/types.js';
import {pop32, popDeferred32, push32, validCodeAddress} from '../state.js';
import {readU8, readU16, readU32, readTypedVarInt, readVarInt} from '../decode.js';
import {
  accessSize,
  localAddress,
  localDescriptor,
  moveBytes,
  pointer,
  pointerBytes,
  readScalar,
  writeScalar,
  writeDeferredScalar,
} from './operands.js';
import {arithmetic32, compare32} from './integer.js';

function watchedStore(h: BurikoBpOpcodeContext, reverse: boolean): 0 {
  const watched = h.diagnostics.writeWatchEnabled;
  const first = reverse ? {value: pop32(h.thread)} : popDeferred32(h.thread);
  if (reverse && !watched) pointer(h, first.value);
  const second = reverse ? popDeferred32(h.thread) : {value: pop32(h.thread)};
  const address = reverse ? first.value : second.value,
    value = reverse ? second : first;
  if (!reverse && !watched) pointer(h, address);
  const type = readU8(h.thread);
  if (watched) h.diagnostics.checkWrite(h.thread, address, accessSize(type));
  writeDeferredScalar(h, address, type, value);
  return 0;
}

function calculateStore(h: BurikoBpOpcodeContext, immediate: boolean): 0 {
  const control = readU8(h.thread),
    right = immediate ? readVarInt(h.thread) : pop32(h.thread);
  const left = pop32(h.thread),
    address = pop32(h.thread);
  pointer(h, address);
  const value =
    (control & 0x20) !== 0
      ? compare32(control & 31, left, right)
      : arithmetic32(control & 31, left, right);
  writeScalar(h, address, control >>> 6, value);
  return 0;
}

export const memoryOpcodes: Readonly<Record<number, BurikoBpOpcodeHandler>> = {
  0x08: (h) => {
    const address = pop32(h.thread);
    pointer(h, address);
    push32(h.thread, readScalar(h, address, readU8(h.thread)));
    return 0;
  },
  0x09: (h) => watchedStore(h, false),
  0x0a: (h) => watchedStore(h, true),
  0x0b: (h) => {
    const destination = pointer(h, pop32(h.thread)),
      length = readU8(h.thread);
    if (validCodeAddress(h.thread, (h.thread.pc + length - 1) >>> 0)) {
      moveBytes(destination, {bytes: h.thread.moduleMemory, offset: h.thread.pc}, length);
      h.thread.pc = (h.thread.pc + length) >>> 0;
    }
    return 0;
  },
  0x0c: (h) => {
    const type = readU8(h.thread),
      count = readU8(h.thread);
    const values: number[] = [];
    for (let i = 0; i < count; i++) values.push(pop32(h.thread));
    const address = pop32(h.thread),
      watched = h.diagnostics.writeWatchEnabled;
    const destination = watched ? null : pointer(h, address);
    if (count === 0) return 0;
    if (type > 2) throw new Error('Buriko ._bp scalar sequence reads undefined native stride');
    const width = accessSize(type);
    for (let i = 0; i < count; i++) {
      const currentAddress = (address + i * width) >>> 0;
      if (watched) h.diagnostics.checkWrite(h.thread, currentAddress, width);
      const bytes = watched
        ? pointerBytes(pointer(h, currentAddress), width, 0, 'write')
        : pointerBytes(destination!, width, i * width, 'write');
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const value = values[count - i - 1]!;
      if (width === 4) view.setUint32(0, value, true);
      else if (width === 2) view.setUint16(0, value, true);
      else view.setUint8(0, value);
    }
    return 0;
  },
  0x0d: (h) => {
    const item = readTypedVarInt(h.thread);
    writeScalar(h, pop32(h.thread), item.type, item.value);
    return 0;
  },
  0x0e: (h) => {
    const displacement = readU16(h.thread),
      item = readTypedVarInt(h.thread);
    writeScalar(h, localAddress(h, displacement), item.type, item.value);
    return 0;
  },
  0x0f: (h) => {
    const local = localDescriptor(h);
    writeScalar(h, local.address, local.type, pop32(h.thread));
    return 0;
  },
  0x18: (h) => {
    const descriptor = readU32(h.thread);
    push32(h.thread, readScalar(h, descriptor & 0x3fffffff, descriptor >>> 30));
    return 0;
  },
  0x19: (h) => {
    const local = localDescriptor(h);
    push32(h.thread, readScalar(h, local.address, local.type));
    return 0;
  },
  0x1f: (h) => {
    const item = readTypedVarInt(h.thread),
      base = pop32(h.thread);
    push32(h.thread, readScalar(h, base + item.value, item.type));
    return 0;
  },
  0x3e: (h) => calculateStore(h, false),
  0x3f: (h) => calculateStore(h, true),
  0x60: (h) => {
    const size = pop32(h.thread),
      source = pointer(h, pop32(h.thread)),
      address = pop32(h.thread);
    if (!h.diagnostics.writeWatchEnabled) pointer(h, address);
    h.diagnostics.checkWrite(h.thread, address, size);
    moveBytes(pointer(h, address), source, size);
    return 0;
  },
  0x61: (h) => {
    const size = pop32(h.thread),
      address = pop32(h.thread);
    if (!h.diagnostics.writeWatchEnabled) pointer(h, address);
    h.diagnostics.checkWrite(h.thread, address, size);
    pointerBytes(pointer(h, address), size, 0, 'write').fill(0);
    return 0;
  },
  0x62: (h) => {
    const value = pop32(h.thread),
      size = pop32(h.thread),
      address = pop32(h.thread);
    if (!h.diagnostics.writeWatchEnabled) pointer(h, address);
    h.diagnostics.checkWrite(h.thread, address, size);
    pointerBytes(pointer(h, address), size, 0, 'write').fill(value & 255);
    return 0;
  },
  0x63: (h) => {
    const size = pop32(h.thread),
      right = pointer(h, pop32(h.thread)),
      left = pointer(h, pop32(h.thread));
    const a = pointerBytes(left, size),
      b = pointerBytes(right, size);
    push32(h.thread, Number(a.every((byte, i) => byte === b[i])));
    return 0;
  },
  0x64: (h) => {
    const source = pointer(h, pop32(h.thread)),
      count = pop32(h.thread),
      size = pop32(h.thread),
      destination = pointer(h, pop32(h.thread));
    for (let i = 0; i < count; i++)
      moveBytes({bytes: destination.bytes, offset: destination.offset + size * i}, source, size);
    return 0;
  },
  0x65: (h) => {
    const needle = pointer(h, pop32(h.thread)),
      count = pop32(h.thread),
      size = pop32(h.thread),
      haystack = pointer(h, pop32(h.thread));
    let found = -1;
    for (let i = 0; i < count; i++) {
      const a = pointerBytes(haystack, size, i * size),
        b = pointerBytes(needle, size);
      if (a.every((byte, j) => byte === b[j])) {
        found = i;
        break;
      }
    }
    push32(h.thread, found);
    return 0;
  },
  0x70: (h) => {
    const size = pop32(h.thread);
    const limit = h.memory.abi.addressMask + 1;
    if (h.memory.abi.compatibility === '1.69' ? size > limit : (size - 1) >>> 0 >= limit)
      throw new Error('Buriko ._bp invalid allocation size');
    if (h.thread.heap === null)
      throw new Error('Buriko ._bp allocation through a null native heap manager');
    const base = h.thread.heap.allocate(size);
    if ((base + size) >>> 0 > limit)
      throw new Error('Buriko ._bp allocation exceeds tagged address range');
    push32(h.thread, base + h.memory.abi.heapTag);
    return 0;
  },
  0x71: (h) => {
    const address = pop32(h.thread);
    if (address >>> h.memory.abi.addressBits !== 3)
      throw new Error('Buriko ._bp free requires a thread heap address');
    if (h.thread.heap === null)
      throw new Error('Buriko ._bp free through a null native heap manager');
    if (!h.thread.heap.free(address & h.memory.abi.addressMask))
      throw new Error('Buriko ._bp invalid heap free');
    push32(h.thread, 1);
    return 0;
  },
  0xec: (h) => {
    const size = readVarInt(h.thread) >>> 0,
      source = pointer(h, pop32(h.thread)),
      destination = pointer(h, pop32(h.thread));
    moveBytes(destination, source, size);
    return 0;
  },
  0xed: (h) => {
    const displacement = readU16(h.thread),
      size = readVarInt(h.thread) >>> 0,
      destination = pointer(h, pop32(h.thread));
    moveBytes(destination, pointer(h, localAddress(h, displacement)), size);
    return 0;
  },
};

import type {AokanaBpOpcodeHandler} from '../../native/types.js';
import {pop32, push32} from '../state.js';
import {readI8, readI16, readU8, readU16, readU32, readVarInt, readTypedVarInt} from '../decode.js';
import {localAddress, localDescriptor, pointer, readScalar, writeScalar} from './operands.js';
import {signedShift} from './integer.js';

export const localOpcodes: Readonly<Record<number, AokanaBpOpcodeHandler>> = {
  0x1a: (h) => {
    const local = localDescriptor(h),
      offset = readVarInt(h.thread);
    push32(h.thread, readScalar(h, local.address, local.type) + offset);
    return 0;
  },
  0x1b: (h) => {
    const local = localDescriptor(h),
      scale = readVarInt(h.thread),
      base = pop32(h.thread);
    push32(h.thread, Math.imul(readScalar(h, local.address, local.type), scale) + base);
    return 0;
  },
  0x1c: (h) => {
    const local = localDescriptor(h),
      count = readI8(h.thread);
    push32(h.thread, signedShift(readScalar(h, local.address, local.type), count));
    return 0;
  },
  0x1d: (h) => {
    const local = localDescriptor(h),
      value = pop32(h.thread);
    push32(h.thread, Math.imul(readScalar(h, local.address, local.type), value));
    return 0;
  },
  0x1e: (h) => {
    const local = localDescriptor(h),
      value = pop32(h.thread) | 0;
    const divisor = readScalar(h, local.address, local.type);
    // This handler uses 32-bit IDIV; unlike 23, INT_MIN/-1 traps.
    if (value === -0x80000000 && divisor === -1)
      throw new Error('Aokana ._bp native signed division overflow');
    push32(h.thread, divisor === 0 ? 0x80000000 : Math.trunc(value / divisor));
    return 0;
  },
  0xe2: (h) => {
    const count = readU8(h.thread) + 1;
    for (let i = 0; i < count; i++) {
      const local = localDescriptor(h);
      pointer(h, local.address);
      writeScalar(h, local.address, local.type, pop32(h.thread));
    }
    return 0;
  },
  0xe3: (h) => {
    const count = readU8(h.thread) + 1;
    for (let i = 0; i < count; i++) {
      const local = localDescriptor(h);
      push32(h.thread, readScalar(h, local.address, local.type));
    }
    return 0;
  },
  0xe4: (h) => {
    const local = localDescriptor(h),
      item = readTypedVarInt(h.thread);
    const base = readScalar(h, local.address, local.type);
    push32(h.thread, readScalar(h, base + item.value, item.type));
    return 0;
  },
  0xe5: (h) => {
    const local = localDescriptor(h),
      item = readTypedVarInt(h.thread),
      base = pop32(h.thread);
    const index = readScalar(h, local.address, local.type);
    push32(h.thread, readScalar(h, base + Math.imul(index, item.value), item.type));
    return 0;
  },
  0xe6: (h) => {
    const local = localDescriptor(h),
      item = readTypedVarInt(h.thread),
      destination = pop32(h.thread);
    pointer(h, destination);
    writeScalar(h, destination, item.type, readScalar(h, local.address, local.type) + item.value);
    return 0;
  },
  0xe7: (h) => {
    const local = localDescriptor(h),
      item = readTypedVarInt(h.thread),
      base = pop32(h.thread),
      destination = pop32(h.thread);
    pointer(h, destination);
    writeScalar(
      h,
      destination,
      item.type,
      Math.imul(readScalar(h, local.address, local.type), item.value) + base,
    );
    return 0;
  },
  0xe8: (h) => {
    const local = localDescriptor(h),
      ifFalse = pop32(h.thread),
      ifTrue = pop32(h.thread),
      condition = pop32(h.thread);
    writeScalar(h, local.address, local.type, condition === 0 ? ifFalse : ifTrue);
    return 0;
  },
  0xe9: (h) => {
    const local = localDescriptor(h),
      offset = readU16(h.thread),
      value = pop32(h.thread);
    const base = h.memory.readU32(h.thread, local.address);
    writeScalar(h, base + offset, local.type, value);
    return 0;
  },
  0xea: (h) => {
    const local = localDescriptor(h),
      offset = readU16(h.thread),
      value = readVarInt(h.thread);
    const base = h.memory.readU32(h.thread, local.address);
    writeScalar(h, base + offset, local.type, value);
    return 0;
  },
  0xf0: (h) => {
    const destination = readU32(h.thread),
      local = localDescriptor(h),
      offset = readVarInt(h.thread);
    pointer(h, destination);
    writeScalar(h, destination, local.type, h.memory.readI32(h.thread, local.address) + offset);
    return 0;
  },
  0xf1: (h) => {
    const destination = localAddress(h, readU16(h.thread)),
      local = localDescriptor(h),
      offset = readVarInt(h.thread);
    pointer(h, destination);
    writeScalar(h, destination, local.type, h.memory.readI32(h.thread, local.address) + offset);
    return 0;
  },
  0xf2: (h) => {
    const destinationLocal = localAddress(h, readU16(h.thread)),
      destinationOffset = readU16(h.thread),
      local = localDescriptor(h),
      offset = readVarInt(h.thread);
    const destination = (h.memory.readU32(h.thread, destinationLocal) + destinationOffset) >>> 0;
    pointer(h, destination);
    writeScalar(h, destination, local.type, h.memory.readI32(h.thread, local.address) + offset);
    return 0;
  },
  0xf4: (h) => {
    const destination = localAddress(h, readU16(h.thread)),
      base = readU32(h.thread),
      local = localDescriptor(h),
      scale = readI16(h.thread);
    pointer(h, destination);
    writeScalar(
      h,
      destination,
      local.type,
      Math.imul(h.memory.readI32(h.thread, local.address), scale) + base,
    );
    return 0;
  },
  0xf5: (h) => {
    const destination = localAddress(h, readU16(h.thread)),
      baseLocal = localAddress(h, readU16(h.thread)),
      offset = readI16(h.thread),
      local = localDescriptor(h),
      scale = readI16(h.thread);
    pointer(h, destination);
    const base = h.memory.readI32(h.thread, baseLocal),
      value = h.memory.readI32(h.thread, local.address);
    writeScalar(h, destination, local.type, Math.imul(value, scale) + base + offset);
    return 0;
  },
  0xf7: (h) => {
    const local = localDescriptor(h),
      offset = readU16(h.thread),
      scale = readI16(h.thread),
      base = pop32(h.thread);
    const address = h.memory.readU32(h.thread, local.address) + offset;
    push32(h.thread, Math.imul(readScalar(h, address, local.type), scale) + base);
    return 0;
  },
  0xf8: (h) => {
    const base = readU32(h.thread),
      local = localAddress(h, readU16(h.thread)),
      scale = readI16(h.thread);
    push32(h.thread, Math.imul(h.memory.readI32(h.thread, local), scale) + base);
    return 0;
  },
  0xf9: (h) => {
    const baseLocal = localAddress(h, readU16(h.thread)),
      offset = readI16(h.thread),
      local = localAddress(h, readU16(h.thread)),
      scale = readI16(h.thread);
    const base = h.memory.readI32(h.thread, baseLocal),
      index = h.memory.readI32(h.thread, local);
    push32(h.thread, Math.imul(index, scale) + base + offset);
    return 0;
  },
  0xfa: (h) => {
    const base = readU32(h.thread),
      local = localDescriptor(h),
      scale = readI16(h.thread);
    const address = Math.imul(h.memory.readI32(h.thread, local.address), scale) + base;
    push32(h.thread, readScalar(h, address, local.type));
    return 0;
  },
  0xfb: (h) => {
    const base = localAddress(h, readU16(h.thread)),
      local = localDescriptor(h),
      scale = readI16(h.thread);
    const address = Math.imul(h.memory.readI32(h.thread, local.address), scale) + base;
    push32(h.thread, readScalar(h, address, local.type));
    return 0;
  },
};

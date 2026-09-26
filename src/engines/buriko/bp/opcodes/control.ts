import type {BurikoBpOpcodeContext, BurikoBpOpcodeHandler} from '../../native/types.js';
import {pop32, push32, readFrame32, writeFrame32, setPc, validCodeAddress} from '../state.js';
import {readI8, readI16, readU8, readU16, readU32, readU64, readVarInt} from '../decode.js';
import {localAddress, readScalar} from './operands.js';
import {compare32} from './integer.js';

function checkTarget(h: BurikoBpOpcodeContext, address: number, forbidZero: boolean): void {
  if ((forbidZero && address >>> 0 === 0) || !validCodeAddress(h.thread, address >>> 0)) {
    throw new Error(`Buriko ._bp invalid code target 0x${(address >>> 0).toString(16)}`);
  }
}

function enterCall(h: BurikoBpOpcodeContext, returnAddress: number): void {
  const t = h.thread;
  if (t.frameCursor + 4 > t.frameLimit) throw new Error('Buriko ._bp call frame overflow');
  t.callSites.push(t.instructionStart);
  writeFrame32(t, t.frameCursor, returnAddress);
  t.frameCursor = (t.frameCursor + 4) >>> 0;
}

function comparisonBranch(h: BurikoBpOpcodeContext, immediate: boolean): 0 {
  const control = readU8(h.thread),
    relative = readI16(h.thread);
  const right = immediate ? readVarInt(h.thread) : pop32(h.thread),
    left = pop32(h.thread);
  const comparison = compare32(control & 15, left, right);
  if ((control & 0x80) !== 0 ? comparison !== 0 : comparison === 0) {
    const target = (h.thread.instructionStart + relative) >>> 0;
    checkTarget(h, target, false);
    setPc(h.thread, target);
  }
  return 0;
}

export const controlOpcodes: Readonly<Record<number, BurikoBpOpcodeHandler>> = {
  0x00: (h) => {
    push32(h.thread, readI8(h.thread));
    return 0;
  },
  0x01: (h) => {
    push32(h.thread, readI16(h.thread));
    return 0;
  },
  0x02: (h) => {
    push32(h.thread, readU32(h.thread));
    return 0;
  },
  0x03: (h) => {
    const control = readU8(h.thread);
    if (control < 0x80) {
      for (let i = 0; i <= control; i++) push32(h.thread, readVarInt(h.thread));
    } else if ((control & 0x7c) === 0) {
      const value =
        control === 0x80
          ? readI8(h.thread)
          : control === 0x81
            ? readI16(h.thread)
            : control === 0x82
              ? readU32(h.thread)
              : Number(BigInt.asUintN(32, readU64(h.thread)));
      push32(h.thread, value);
    }
    return 0;
  },
  0x04: (h) => {
    push32(h.thread, localAddress(h, readU16(h.thread)));
    return 0;
  },
  0x05: (h) => {
    const relative = readI16(h.thread);
    push32(h.thread, (h.thread.instructionStart + relative) | h.memory.abi.moduleTag);
    return 0;
  },
  0x06: (h) => {
    const relative = readI16(h.thread);
    push32(h.thread, h.thread.instructionStart + relative);
    return 0;
  },
  0x10: (h) => {
    push32(h.thread, h.thread.frameCursor);
    return 0;
  },
  0x11: (h) => {
    const cursor = pop32(h.thread) >>> 0;
    if (cursor > h.thread.frameLimit) throw new Error('Buriko ._bp invalid frame cursor');
    h.thread.frameCursor = cursor;
    return 0;
  },
  0x12: (h) => {
    h.thread.frameCursor = (h.thread.frameCursor + readVarInt(h.thread)) >>> 0;
    return 0;
  },
  0x13: (h) => {
    const relative = readI16(h.thread);
    setPc(h.thread, (h.thread.instructionStart + relative) >>> 0);
    return 0;
  },
  0x14: (h) => {
    const target = pop32(h.thread);
    checkTarget(h, target, true);
    setPc(h.thread, target);
    return 0;
  },
  0x15: (h) => {
    const control = readU8(h.thread);
    const target =
      (control & 8) === 0 ? pop32(h.thread) : (readI16(h.thread) + h.thread.instructionStart) >>> 0;
    const value = pop32(h.thread) | 0;
    let taken: boolean;
    switch (control & 7) {
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
        throw new Error('Buriko ._bp branch selector reads undefined native stack data');
    }
    if (taken) {
      checkTarget(h, target, false);
      setPc(h.thread, target);
    }
    return 0;
  },
  0x16: (h) => {
    // Native 16 pushes its call record before popping or validating the target.
    enterCall(h, (h.thread.instructionStart + 1) >>> 0);
    const target = pop32(h.thread);
    checkTarget(h, target, true);
    setPc(h.thread, target);
    return 0;
  },
  0x17: (h) => {
    if (h.thread.frameCursor <= h.thread.frameFloor) return 4;
    h.thread.frameCursor = (h.thread.frameCursor - 4) >>> 0;
    setPc(h.thread, readFrame32(h.thread, h.thread.frameCursor));
    h.thread.callSites.pop();
    return 0;
  },
  0x37: (h) => comparisonBranch(h, true),
  0x3b: (h) => comparisonBranch(h, false),
  0xee: (h) => {
    const target = (readI16(h.thread) + h.thread.instructionStart) >>> 0;
    checkTarget(h, target, true);
    enterCall(h, (h.thread.instructionStart + 3) >>> 0);
    setPc(h.thread, target);
    return 0;
  },
  0xef: (h) => {
    const descriptor = readU32(h.thread);
    const target = readScalar(h, descriptor & 0x3fffffff, descriptor >>> 30) >>> 0;
    checkTarget(h, target, true);
    enterCall(h, (h.thread.instructionStart + 5) >>> 0);
    setPc(h.thread, target);
    return 0;
  },
};

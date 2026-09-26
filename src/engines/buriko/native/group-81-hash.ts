import type {BurikoBpPointer} from '../bp/memory.js';
import {pointerView} from '../bp/memory.js';
import {pointerBytes} from '../bp/opcodes/operands.js';
import {pop32} from '../bp/state.js';
import type {BurikoBpOpcodeContext, BurikoNativeSlotDefinition} from './types.js';

const ROUND_CONSTANTS = [
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x2441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x4881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
] as const;
const ROTATIONS = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21] as const;

function requirePointer(pointer: BurikoBpPointer | null): BurikoBpPointer {
  if (pointer === null) throw new Error('Buriko native checksum null pointer');
  return pointer;
}
function popPointer(h: BurikoBpOpcodeContext): BurikoBpPointer | null {
  return h.memory.resolve(h.thread, pop32(h.thread));
}

/** 140032320; source is deliberately reread after each potentially aliasing byte store. */
export function updateNativeChecksum(
  destination: BurikoBpPointer | null,
  source: BurikoBpPointer | null,
  count: number,
): void {
  count >>>= 0;
  if (count === 0) return;
  const output = requirePointer(destination),
    input = requirePointer(source);
  const state = pointerView(output, 8);
  const read = (index: number): number => pointerBytes(input, 1, index)[0]!;
  for (let index = 0; index < count; index++) {
    const value = (Math.imul(state.getInt32(0, true), 233) + read(index)) | 0;
    state.setInt32(0, value, true);
    state.setUint8(4, state.getUint8(4) + value);
    state.setUint8(5, state.getUint8(5) ^ value);
    state.setUint8(6, state.getUint8(6) + read(index));
    state.setUint8(7, state.getUint8(7) ^ read(index));
  }
}

/** 14010aee0, its padding helpers and all 64 rounds at 14010a2c0. */
export function nativeMd5(
  destination: BurikoBpPointer | null,
  source: BurikoBpPointer | null,
  count: number,
): void {
  count >>>= 0;
  const remaining = 64 - (count & 63);
  const padding = remaining > 8 ? remaining : remaining + 64;
  const paddedSize = (count + padding) >>> 0;
  if (paddedSize < count) throw new RangeError('Buriko native MD5 allocation size wraps DWORD');
  const bytes = new Uint8Array(paddedSize);
  if (count !== 0) bytes.set(pointerBytes(requirePointer(source), count));
  bytes[count] = 0x80;
  const view = new DataView(bytes.buffer);
  view.setBigUint64(paddedSize - 8, BigInt(count) * 8n, true);
  let a = 0x67452301,
    b = 0xefcdab89,
    c = 0x98badcfe,
    d = 0x10325476;
  for (let offset = 0; offset < paddedSize; offset += 64) {
    let aa = a,
      bb = b,
      cc = c,
      dd = d;
    for (let round = 0; round < 64; round++) {
      const group = round >>> 4;
      let mix: number, word: number;
      if (group === 0) {
        mix = (~bb & dd) | (bb & cc);
        word = round;
      } else if (group === 1) {
        mix = (~dd & cc) | (bb & dd);
        word = (5 * round + 1) & 15;
      } else if (group === 2) {
        mix = bb ^ cc ^ dd;
        word = (3 * round + 5) & 15;
      } else {
        mix = (~dd | bb) ^ cc;
        word = (7 * round) & 15;
      }
      const sum =
        (mix + aa + view.getUint32(offset + word * 4, true) + ROUND_CONSTANTS[round]!) | 0;
      const shift = ROTATIONS[group * 4 + (round & 3)]!;
      const rotated = ((sum << shift) | (sum >>> (32 - shift))) + bb;
      aa = dd;
      dd = cc;
      cc = bb;
      bb = rotated >>> 0;
    }
    a = (a + aa) >>> 0;
    b = (b + bb) >>> 0;
    c = (c + cc) >>> 0;
    d = (d + dd) >>> 0;
  }
  const output = pointerView(requirePointer(destination), 16);
  output.setUint32(0, a, true);
  output.setUint32(4, b, true);
  output.setUint32(8, c, true);
  output.setUint32(12, d, true);
}

export const group81Hash: readonly BurikoNativeSlotDefinition[] = [
  {
    primary: 0x81,
    secondary: 0xe9,
    nativeAddress: 0x1400ea880,
    name: 'UpdateChecksum',
    execute: (h) => {
      const count = pop32(h.thread),
        source = popPointer(h),
        destination = popPointer(h);
      updateNativeChecksum(destination, source, count);
      return 0;
    },
  },
  {
    primary: 0x81,
    secondary: 0xea,
    nativeAddress: 0x1400ea820,
    name: 'Md5',
    execute: (h) => {
      const count = pop32(h.thread),
        source = popPointer(h),
        destination = popPointer(h);
      nativeMd5(destination, source, count);
      return 0;
    },
  },
];

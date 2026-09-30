import type {BurikoBpAbi} from '../bp/abi.js';
import {burikoPrimarySlots, burikoNativeSlots} from './registry.js';

interface Instruction {
  pc: number;
  opcode: number;
  end: number;
  target?: number;
}

/**
 * Optional metadata evidence from an IPL's native product-identity comparison.
 * This is a bounded static recognizer, not an interpreter or a replacement for
 * the runtime comparison. Unrecognized compiler layouts produce no metadata.
 * Input is the decoded archive member, including its offset/size header.
 */
export function inferBurikoBootProductIdentity(
  program: Uint8Array,
  abi: BurikoBpAbi,
): Uint8Array | null {
  if (program.length < 8) return null;
  const header = new DataView(program.buffer, program.byteOffset, program.byteLength);
  const offset = header.getUint32(0, true),
    size = header.getUint32(4, true);
  if (offset < 8 || size === 0 || size > abi.addressMask + 1 || offset + size > program.length)
    return null;
  const bytes = program.subarray(offset, offset + size);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const old = abi.compatibility === '1.69';
  const primary = burikoPrimarySlots(abi);
  const banks = burikoNativeSlots(abi);
  const fixed = new Map([
    [0x00, 2],
    [0x01, 3],
    [0x02, 5],
    [0x04, 3],
    [0x05, 3],
    [0x06, 3],
    [0x08, 2],
    [0x09, 2],
    [0x0a, 2],
    [0x0c, 3],
    [0x0f, 3],
    [0x13, 3],
    [0x18, 5],
    [0x19, 3],
    [0xee, 3],
    [0xef, 5],
  ]);
  const single = new Set([
    0x10,
    0x11,
    0x14,
    0x16,
    0x17,
    0x20,
    0x21,
    0x22,
    0x23,
    0x24,
    0x25,
    0x26,
    0x27,
    0x28,
    0x29,
    0x2a,
    0x2b,
    0x30,
    0x31,
    0x32,
    0x33,
    0x34,
    0x35,
    0x38,
    0x39,
    0x3a,
    ...Array.from({length: 0x16}, (_, i) => 0x40 + i).filter((opcode) => opcode !== 0x41),
    ...Array.from({length: 0x20}, (_, i) => 0x60 + i).filter(
      (opcode) => opcode !== 0x77 && opcode !== 0x78,
    ),
    0xff,
  ]);
  // 1.685.3 fused operands: b=u8, h=u16, w=u32, v=(typed) varint.
  const fused: ReadonlyMap<number, string> =
    abi.revision === '1.685.3'
      ? new Map([
          [0x0d, 'v'],
          [0x0e, 'hv'],
          [0x12, 'v'],
          [0x1a, 'hv'],
          [0x1b, 'hv'],
          [0x1c, 'hb'],
          [0x1d, 'h'],
          [0x1e, 'h'],
          [0x1f, 'v'],
          [0x2c, 'v'],
          [0x2d, 'v'],
          [0x2e, 'v'],
          [0x2f, 'v'],
          [0x36, 'bv'],
          [0x37, 'bhv'],
          [0x3b, 'bh'],
          [0x3c, 'b'],
          [0x3e, 'b'],
          [0x3f, 'bv'],
          [0xe4, 'hv'],
          [0xe5, 'hv'],
          [0xe6, 'hv'],
          [0xe7, 'hv'],
          [0xe8, 'h'],
          [0xe9, 'hh'],
          [0xea, 'hhv'],
          [0xec, 'v'],
          [0xed, 'hv'],
          [0xf0, 'whv'],
          [0xf1, 'hhv'],
          [0xf2, 'hhhv'],
          [0xf4, 'hwhh'],
          [0xf5, 'hhhhh'],
          [0xf7, 'hhh'],
          [0xf8, 'whh'],
          [0xf9, 'hhhh'],
          [0xfa, 'whh'],
          [0xfb, 'hhh'],
        ])
      : new Map();
  // Varints continue while bit 7 is set; an unterminated operand overruns the module.
  function operandsEnd(pc: number, layout: string): number {
    for (const operand of layout) {
      if (operand !== 'v') pc += operand === 'b' ? 1 : operand === 'h' ? 2 : 4;
      else {
        while (pc < bytes.length && (bytes[pc]! & 0x80) !== 0) pc++;
        pc++;
      }
    }
    return pc;
  }
  function decode(pc: number): Instruction | null {
    if (pc < 0 || pc >= bytes.length) return null;
    const opcode = bytes[pc]!;
    if (primary[opcode] === undefined) return null;
    let length = fixed.get(opcode);
    const layout = fused.get(opcode);
    if (banks[opcode] !== undefined) {
      if (banks[opcode]![bytes[pc + 1]!] === undefined) return null;
      length = 2;
    } else if (single.has(opcode)) length = 1;
    else if (layout !== undefined) length = operandsEnd(pc + 1, layout) - pc;
    else if (opcode === 0x0b) length = 2 + (bytes[pc + 1] ?? bytes.length);
    else if (opcode === 0x15) length = !old && (bytes[pc + 1]! & 8) !== 0 ? 4 : 2;
    else if (fused.size && opcode === 0x03 && pc + 1 < bytes.length) {
      const control = bytes[pc + 1]!;
      length =
        control < 0x80
          ? operandsEnd(pc + 2, 'v'.repeat(control + 1)) - pc
          : (control & 0x7c) !== 0
            ? 2
            : 2 + [1, 2, 4, 8][control & 3]!;
    } else if (fused.size && (opcode === 0xe2 || opcode === 0xe3) && pc + 1 < bytes.length)
      length = 2 + (bytes[pc + 1]! + 1) * 2;
    if (length === undefined || pc + length > bytes.length) return null;
    const instruction: Instruction = {pc, opcode, end: pc + length};
    if ([0x05, 0x06, 0x13, 0xee].includes(opcode))
      instruction.target = pc + view.getInt16(pc + 1, true);
    // Fused comparison branches 37/3b share 15's control byte and relative target.
    if ((opcode === 0x15 && length === 4) || (fused.size && (opcode === 0x37 || opcode === 0x3b)))
      instruction.target = pc + view.getInt16(pc + 2, true);
    return instruction;
  }

  // Only examine instructions reached from the entry through decoded edges.
  // No scanning of string/data bytes, native callbacks, or writable VM memory.
  const pending = [0],
    visited = new Set<number>();
  const identities: Uint8Array[] = [];
  while (pending.length && visited.size < 16384) {
    let pc = pending.pop()!;
    let previous: Instruction | null = null;
    for (;;) {
      if (visited.has(pc) || visited.size >= 16384) break;
      const current = decode(pc);
      if (current === null) break;
      visited.add(pc);

      // 04 local;80/e8 copy identity;04 same local;05 constant;69 equality.
      // All five operations are adjacent: the frame cursor and output bytes
      // cannot change between the producer and its comparison.
      if (
        current.opcode === 0x04 &&
        pc + 12 <= bytes.length &&
        bytes[pc + 3] === 0x80 &&
        bytes[pc + 4] === 0xe8 &&
        bytes[pc + 5] === 0x04 &&
        bytes[pc + 8] === 0x05 &&
        bytes[pc + 11] === 0x69 &&
        view.getUint16(pc + 1, true) === view.getUint16(pc + 6, true)
      ) {
        const start = pc + 8 + view.getInt16(pc + 9, true);
        if (start >= 0 && start < bytes.length) {
          const end = bytes.indexOf(0, start);
          if (end > start && end - start <= 255) {
            const value = bytes.slice(start, end);
            // Product identity is narrow metadata, not a displayed game string.
            if (value.every((byte) => byte >= 0x20 && byte <= 0x7e)) identities.push(value);
          }
        }
        break; // Later scripts and data cannot strengthen this local proof.
      }

      if (
        current.opcode === 0x17 ||
        current.opcode === 0xff ||
        (current.opcode === 0x80 && bytes[pc + 1] === 0x6a)
      )
        break;
      if (
        [0x13, 0x14, 0x15, 0x16, 0xee].includes(current.opcode) ||
        (fused.size && (current.opcode === 0x37 || current.opcode === 0x3b))
      ) {
        const target = current.target ?? (previous?.opcode === 0x06 ? previous.target : undefined);
        if (target !== undefined && target >= 0 && target < bytes.length) pending.push(target);
        if (current.opcode === 0x13 || current.opcode === 0x14) break;
        // Unresolved calls may alter code or escape the module: do not infer beyond them.
        if (current.opcode === 0x16 && target === undefined) break;
      }
      previous = current;
      pc = current.end;
    }
  }
  const first = identities[0];
  if (
    visited.size >= 16384 ||
    first === undefined ||
    identities.some(
      (value) => value.length !== first.length || value.some((byte, i) => byte !== first[i]),
    )
  )
    return null;
  return first;
}

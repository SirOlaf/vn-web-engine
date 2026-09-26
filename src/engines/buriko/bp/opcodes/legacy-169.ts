import type {BurikoBpOpcodeContext, BurikoBpOpcodeHandler} from '../../native/types.js';
import {textByte, textLength} from '../../native/text.js';
import {formatVmConversion} from '../../native/text-format.js';
import type {BurikoBpPointer} from '../memory.js';
import {
  pop32,
  popDeferred32,
  push32,
  pushIndeterminate32,
  readFrame32,
  setPc,
  validCodeAddress,
  writeFrame32,
} from '../state.js';
import {readU8} from '../decode.js';
import {
  accessSize,
  pointer,
  pointerBytes,
  readScalar,
  writeScalar,
  writeDeferredScalar,
} from './operands.js';
import {x87TrigonometricInteger} from '../../../../core/x87-integer.js';
import {copyMemoryBytes} from '../../../../core/indeterminate-memory.js';

/** 00421630 deliberately accepts80..9f ande0..ff, including invalid CP932 leads. */
function character(p: BurikoBpPointer): {value: number; wide: number; length: number} {
  const lead = textByte(p.bytes, p.offset);
  const wide = Number(lead >= 0x80 && (lead < 0xa0 || lead >= 0xe0));
  return {
    value: wide ? (lead << 8) | textByte(p.bytes, p.offset + 1) : lead,
    wide,
    length: wide + 1,
  };
}

// Native punctuation bytes004a7118, compared as encoded characters by00421680.
const punctuation = new Set([
  0x2c, 0x2e, 0xa4, 0xa1, 0x3a, 0x3b, 0x3f, 0x21, 0xde, 0xdf, 0xa5, 0x8141, 0x8142, 0x8143, 0x8144,
  0x8146, 0x8147, 0x8148, 0x8149, 0x814a, 0x814b, 0x815d, 0x5d, 0x7d, 0x29, 0x816a, 0x816c, 0x816e,
  0x8170, 0x8172, 0x8174, 0x8176, 0x8178, 0x817a, 0x8165, 0x8167,
]);

/** REP MOVSD then MOVSB copies forwards; overlapping operands can repeat overwritten DWORDs. */
function copyForward(destination: BurikoBpPointer, source: BurikoBpPointer, length: number): void {
  const dst = pointerBytes(destination, length, 0, 'transport'),
    src = pointerBytes(source, length, 0, 'transport');
  let offset = 0;
  for (; offset + 4 <= length; offset += 4) copyMemoryBytes(dst, offset, src, offset, 4);
  for (; offset < length; offset++) copyMemoryBytes(dst, offset, src, offset, 1);
}

function copyCString(destination: BurikoBpPointer, source: BurikoBpPointer): void {
  let offset = 0;
  for (;;) {
    const value = textByte(source.bytes, source.offset + offset);
    pointerBytes(destination, 1, offset, 'write')[0] = value;
    if (value === 0) return;
    offset++;
  }
}

function cstring(p: BurikoBpPointer): Uint8Array {
  return pointerBytes(p, textLength(p));
}

function store(h: BurikoBpOpcodeContext, reverse: boolean): 0 {
  const watched = h.diagnostics.writeWatchEnabled;
  const first = reverse ? {value: pop32(h.thread)} : popDeferred32(h.thread);
  if (reverse && !watched) pointer(h, first.value);
  const second = reverse ? popDeferred32(h.thread) : {value: pop32(h.thread)};
  const address = reverse ? first.value : second.value,
    value = reverse ? second : first;
  if (!reverse && !watched) pointer(h, address);
  const type = readU8(h.thread);
  if (watched) h.diagnostics.checkWrite(h.thread, address, accessSize(type));
  // 00450650 has no default store; its caller09 still pushes the original value.
  if (type <= 2) writeDeferredScalar(h, address, type, value);
  if (!reverse) {
    if (value.reason === undefined) push32(h.thread, value.value);
    else pushIndeterminate32(h.thread, value.reason);
  }
  return 0;
}

function divide32(h: BurikoBpOpcodeContext, remainder: boolean): 0 {
  const b = pop32(h.thread) | 0,
    a = pop32(h.thread) | 0;
  if (a === -0x80000000 && b === -1) throw new Error('Buriko1.69 native32-bit division overflow');
  push32(h.thread, b === 0 ? -1 : remainder ? a % b : Math.trunc(a / b));
  return 0;
}

function divide64(h: BurikoBpOpcodeContext, remainder: boolean): 0 {
  const right = pointer(h, pop32(h.thread)),
    left = pointer(h, pop32(h.thread));
  const destination = pointer(h, pop32(h.thread));
  const bbytes = pointerBytes(right, 8),
    abytes = pointerBytes(left, 8);
  const b = new DataView(bbytes.buffer, bbytes.byteOffset, 8).getBigInt64(0, true);
  const a = new DataView(abytes.buffer, abytes.byteOffset, 8).getBigInt64(0, true);
  if (b === 0n) throw new Error('Buriko1.69 native64-bit division by zero');
  // The x86 CRT unsigned-magnitude helper wraps INT64_MIN/-1 rather than IDIV overflow.
  const output = pointerBytes(destination, 8, 0, 'write');
  new DataView(output.buffer, output.byteOffset, 8).setBigInt64(
    0,
    BigInt.asIntN(64, remainder ? a % b : a / b),
    true,
  );
  return 0;
}

/** 00450ee0, with PC=53 established by CRT initializer0047aff2. */
function vectorAngle(x: number, y: number): number {
  if (x === 0) return y === 0 ? 0 : y > 0 ? 0x5a0000 : 0x10e0000;
  // FIDIV rounds the integer ratio to53 bits before FPATAN computes its
  // extended result. FMUL uses the original literal, not a rearranged pi ratio.
  const positive = x > 0 && y >= 0;
  const converted = x87TrigonometricInteger(
    'atan',
    y / x,
    positive ? 3754936.206169363 : -3754936.206169363,
  );
  return positive ? converted : (x > 0 ? 0x1680000 : 0xb40000) - converted;
}

/** 0046a7a0: mismatch advances input without retrying a prefix at that character. */
function findCharacters(source: BurikoBpPointer, needle: BurikoBpPointer): number {
  const search: number[] = [];
  for (let at = needle.offset; textByte(needle.bytes, at) !== 0;) {
    const c = character({bytes: needle.bytes, offset: at});
    search.push(c.value);
    at += c.length;
  }
  let matched = 0,
    start = -1;
  for (let at = source.offset; textByte(source.bytes, at) !== 0;) {
    if (search.length === 0) throw new Error('Buriko1.69 substring search reads empty allocation');
    const c = character({bytes: source.bytes, offset: at});
    if (c.value === search[matched]) {
      if (matched === 0) start = at - source.offset;
      if (++matched >= search.length) return start;
    } else matched = 0;
    at += c.length;
  }
  return -1;
}

/** Native004514f0 preloads up to16 arguments before calling narrow CRT sprintf. */
function formatText(
  h: BurikoBpOpcodeContext,
  destination: BurikoBpPointer,
  source: BurikoBpPointer,
): void {
  const format = cstring(source);
  const pieces: {
    literal?: Uint8Array;
    conversion?: string;
    kind?: string;
    value?: number | BurikoBpPointer | null;
  }[] = [];
  let count = 0,
    start = 0;
  for (let at = 0; at < format.length; at++) {
    if (format[at] !== 0x25) continue;
    if (at > start) pieces.push({literal: format.slice(start, at)});
    let end = at + 1;
    if ([0x20, 0x30, 0x2d, 0x2e].includes(format[end]!)) {
      end++;
      while (format[end]! >= 0x30 && format[end]! <= 0x39) end++;
    }
    const kind = String.fromCharCode(format[end] ?? 0);
    if (!['%', 's', 'c', 'd', 'x', 'X'].includes(kind))
      throw new Error(`Buriko1.69 formatter rejects conversion ${kind}`);
    if (kind === '%') pieces.push({literal: Uint8Array.of(0x25)});
    else {
      const value = pop32(h.thread);
      const argument = kind === 's' ? h.memory.resolve(h.thread, value) : value;
      if (++count > 16) throw new Error('Buriko1.69 formatter exceeds16 arguments');
      pieces.push({
        conversion: String.fromCharCode(...format.subarray(at, end + 1)),
        kind,
        value: argument,
      });
    }
    at = end;
    start = end + 1;
  }
  if (start < format.length) pieces.push({literal: format.slice(start)});
  let output = 0;
  for (const piece of pieces) {
    let bytes: Uint8Array;
    if (piece.literal) bytes = piece.literal;
    else {
      let value: number | string = piece.value as number;
      if (piece.kind === 's') {
        const p = piece.value as BurikoBpPointer | null;
        const input = p === null ? new TextEncoder().encode('(null)') : cstring(p);
        value = Array.from(input, (byte) => String.fromCharCode(byte)).join('');
      } else if (piece.kind === 'c') value = String.fromCharCode(Number(piece.value) & 255);
      const formatted = formatVmConversion(piece.conversion!, value);
      bytes = Uint8Array.from(formatted, (c) => c.charCodeAt(0));
    }
    pointerBytes(destination, bytes.length, output, 'write').set(bytes);
    output += bytes.length;
  }
  pointerBytes(destination, 1, output, 'write')[0] = 0;
}

export function createLegacy169CoreOpcodes(): Readonly<Record<number, BurikoBpOpcodeHandler>> {
  return {
    0x08: (h) => {
      const address = pop32(h.thread);
      pointer(h, address);
      const type = readU8(h.thread);
      if (type > 2)
        throw new Error('Buriko1.69 scalar load exposes an unmodeled native thread pointer');
      push32(h.thread, readScalar(h, address, type));
      return 0;
    },
    0x09: (h) => store(h, false),
    0x0a: (h) => store(h, true),
    0x0b: (h) => {
      const destination = pointer(h, pop32(h.thread)),
        length = readU8(h.thread);
      if ((h.thread.pc + length) >>> 0 <= h.thread.moduleLimit) {
        copyForward(destination, {bytes: h.thread.moduleMemory, offset: h.thread.pc}, length);
        h.thread.pc = (h.thread.pc + length) >>> 0;
      }
      return 0;
    },
    0x11: (h) => {
      const cursor = pop32(h.thread);
      if (cursor >= h.thread.frameLimit) throw new Error('Buriko1.69 invalid frame cursor');
      h.thread.frameCursor = cursor;
      return 0;
    },
    0x15: (h) => {
      const target = pop32(h.thread),
        value = pop32(h.thread) | 0,
        control = readU8(h.thread);
      const taken = [value !== 0, value === 0, value > 0, value >= 0, value <= 0, value < 0][
        control
      ];
      if (taken === undefined)
        throw new Error('Buriko1.69 branch reads undefined native stack data');
      if (taken) {
        if (!validCodeAddress(h.thread, target)) throw new Error('Buriko1.69 invalid code target');
        setPc(h.thread, target);
      }
      return 0;
    },
    0x16: (h) => {
      const t = h.thread;
      if ((t.frameCursor + 4) >>> 0 >= t.frameLimit)
        throw new Error('Buriko1.69 call frame overflow');
      t.callSites.push(t.instructionStart);
      writeFrame32(t, t.frameCursor, (t.instructionStart + 1) >>> 0);
      t.frameCursor = (t.frameCursor + 4) >>> 0;
      const target = pop32(t);
      if (target === 0 || !validCodeAddress(t, target))
        throw new Error('Buriko1.69 invalid code target');
      setPc(t, target);
      return 0;
    },
    0x17: (h) => {
      const t = h.thread;
      if (t.frameCursor === 0) return 4;
      t.frameCursor = (t.frameCursor - 4) >>> 0;
      setPc(t, readFrame32(t, t.frameCursor));
      t.callSites.pop();
      return 0;
    },
    0x23: (h) => divide32(h, false),
    0x24: (h) => divide32(h, true),
    0x42: (h) => {
      const divisor = BigInt(pop32(h.thread) | 0),
        multiplier = BigInt(pop32(h.thread) | 0),
        value = BigInt(pop32(h.thread) | 0);
      if (divisor === 0n) throw new Error('Buriko1.69 native64-bit division by zero');
      push32(h.thread, Number(BigInt.asIntN(32, (value * multiplier) / divisor)));
      return 0;
    },
    0x43: (h) => {
      const y = pop32(h.thread) | 0,
        x = pop32(h.thread) | 0;
      push32(h.thread, vectorAngle(x, y));
      return 0;
    },
    0x48: (h) => {
      // 00450fc0: FILD; FMUL49e4d8; FSIN; FMUL65536; __ftol lowDWORD.
      push32(
        h.thread,
        x87TrigonometricInteger('sin', (pop32(h.thread) | 0) * 2.663161090079238e-7, 65536),
      );
      return 0;
    },
    0x49: (h) => {
      push32(
        h.thread,
        x87TrigonometricInteger('cos', (pop32(h.thread) | 0) * 2.663161090079238e-7, 65536),
      );
      return 0;
    },
    0x53: (h) => divide64(h, false),
    0x54: (h) => divide64(h, true),
    0x60: (h) => {
      const size = pop32(h.thread),
        source = pointer(h, pop32(h.thread)),
        address = pop32(h.thread);
      if (!h.diagnostics.writeWatchEnabled) pointer(h, address);
      h.diagnostics.checkWrite(h.thread, address, size);
      copyForward(pointer(h, address), source, size);
      return 0;
    },
    0x66: (h) => {
      const needle = cstring(pointer(h, pop32(h.thread))),
        source = cstring(pointer(h, pop32(h.thread)));
      let result = -1;
      for (let at = 0; at <= source.length - needle.length; at++) {
        if (needle.every((byte, i) => source[at + i] === byte)) {
          result = at;
          break;
        }
      }
      push32(h.thread, result);
      return 0;
    },
    0x67: (h) => {
      const replacement = pointer(h, pop32(h.thread)),
        needle = pointer(h, pop32(h.thread));
      let source = pointer(h, pop32(h.thread)),
        destination = pointer(h, pop32(h.thread));
      const needleLength = textLength(needle),
        replacementLength = textLength(replacement);
      let count = 0;
      for (;;) {
        const found = findCharacters(source, needle);
        if (found < 0) break;
        if (found > 0) {
          copyForward(destination, source, found);
          source = {bytes: source.bytes, offset: source.offset + found};
          destination = {bytes: destination.bytes, offset: destination.offset + found};
        }
        copyCString(destination, replacement);
        source = {bytes: source.bytes, offset: source.offset + needleLength};
        destination = {bytes: destination.bytes, offset: destination.offset + replacementLength};
        count++;
      }
      copyCString(destination, source);
      push32(h.thread, count);
      return 0;
    },
    0x69: (h) => {
      const right = pointer(h, pop32(h.thread)),
        left = pointer(h, pop32(h.thread));
      let same = true;
      for (let i = 0; ; i++) {
        const a = textByte(left.bytes, left.offset + i),
          b = textByte(right.bytes, right.offset + i);
        if (a !== b) {
          same = false;
          break;
        }
        if (a === 0) break;
      }
      push32(h.thread, Number(same));
      return 0;
    },
    0x6a: (h) => {
      const source = pointer(h, pop32(h.thread)),
        address = pop32(h.thread);
      if (h.diagnostics.writeWatchEnabled)
        h.diagnostics.checkWrite(h.thread, address, textLength(source) + 1);
      copyCString(pointer(h, address), source);
      return 0;
    },
    0x6c: (h) => {
      const c = character(pointer(h, pop32(h.thread)));
      push32(h.thread, c.value);
      push32(h.thread, c.wide);
      push32(h.thread, Number(punctuation.has(c.value)));
      return 0;
    },
    0x6d: (h) => {
      const p = pointer(h, pop32(h.thread));
      for (let at = p.offset; textByte(p.bytes, at) !== 0;) {
        const c = character({bytes: p.bytes, offset: at});
        if (!c.wide && c.value >= 0x41 && c.value <= 0x5a) p.bytes[at] = c.value + 0x20;
        at += c.length;
      }
      return 0;
    },
    0x6f: (h) => {
      const format = pointer(h, pop32(h.thread)),
        address = pop32(h.thread);
      const destination = pointer(h, address);
      formatText(h, destination, format);
      h.diagnostics.checkWrite(h.thread, address, textLength(destination) + 1);
      return 0;
    },
  };
}

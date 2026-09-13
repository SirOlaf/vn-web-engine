import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AokanaNativeText,
  classifyUtf8,
  copyText,
  isNativeCp932Lead,
  nativeCp932CharacterToWide,
  readNativeUtf8,
  textBytes,
  writeNativeUtf8,
} from '../dist/engines/buriko/games/aokana/native/text.js';
import {formatVmText} from '../dist/engines/buriko/games/aokana/native/text-format.js';
import {createTextOpcodes} from '../dist/engines/buriko/games/aokana/bp/opcodes/text.js';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpDiagnostics} from '../dist/engines/buriko/games/aokana/native/diagnostics.js';

const bytes = (value) =>
  typeof value === 'string' ? new TextEncoder().encode(value + '\0') : Uint8Array.from(value);
const pointer = (value) => ({bytes: bytes(value), offset: 0});
function context(notice = () => {}) {
  return {
    thread: new AokanaBpThread({
      id: 1,
      operandCapacity: 64,
      moduleCapacity: 4096,
      frameCapacity: 4096,
    }),
    memory: new AokanaBpMemory(new Uint8Array(4096)),
    diagnostics: new AokanaBpDiagnostics(notice),
  };
}
function put(h, offset, value) {
  h.thread.moduleMemory.set(bytes(value), offset);
  return 0x10000000 + offset;
}
function push(h, ...values) {
  for (const value of values) push32(h.thread, value);
}
function format(value, operands, text = new AokanaNativeText()) {
  const h = context();
  push(h, ...operands.slice().reverse());
  return formatVmText(h, pointer(value), text);
}
const ascii = (value) => new TextDecoder().decode(value.subarray(0, value.length - 1));

test('Aokana encoding detection retains six-sequence cutoff and permissive legacy forms', () => {
  const text = new AokanaNativeText();
  assert.equal(text.mode, 0);
  assert.equal(text.codePage, 932);
  assert.equal(text.selectMode(2), false);
  assert.equal(text.detectEncoding(bytes('plain')), 0x80000000);
  assert.equal(text.detectEncoding(Uint8Array.of(0x81, 0x40, 0)), 0);
  assert.equal(
    text.detectEncoding(Uint8Array.from([...Array(6).fill([0xc2, 0xa1]).flat(), 0x81, 0])),
    1,
  );
  assert.equal(text.detectEncoding(Uint8Array.of(3, 0x81, 65, 0), 0, true), 0x80000000);
  assert.deepEqual(classifyUtf8(Uint8Array.of(0xff, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80)), {
    result: 1,
    length: 8,
  });
  assert.deepEqual(classifyUtf8(Uint8Array.of(0xc0, 0x80)), {result: 0});
  assert.deepEqual(readNativeUtf8(Uint8Array.of(0xc0, 0x80)), {value: 0, length: 2});
  for (const value of [
    0x7f, 0x80, 0x7ff, 0x800, 0xffff, 0x10000, 0x1fffff, 0x200000, 0x3ffffff, 0x4000000, 0x7fffffff,
  ]) {
    const encoded = writeNativeUtf8(value);
    assert.deepEqual(readNativeUtf8(encoded), {value, length: encoded.length});
  }
  assert.equal(writeNativeUtf8(0x80000000).length, 0);
});

test('Aokana Win32 CP932 profile preserves private single bytes, best-fit mappings, and malformed-pair consumption', () => {
  const text = new AokanaNativeText();
  assert.equal(text.decodeCp932(Uint8Array.of(0xa0, 0xfd, 0xfe, 0xff)), '\uf8f0\uf8f1\uf8f2\uf8f3');
  assert.equal(text.decodeCp932(Uint8Array.of(0xe0, 0x35, 0x41)), '\u30fbA');
  assert.equal(text.decodeCp932(Uint8Array.of(0x81)), '\u30fb');
  assert.equal(text.decodeCp932(Uint8Array.of(0x81, 0, 0x41)), '\u30fb\0A');
  assert.equal(text.decodeCp932(Uint8Array.of(0x82, 0xa0)), 'あ');
  assert.deepEqual(text.encodeWide('あ'), Uint8Array.of(0x82, 0xa0, 0));
  assert.deepEqual(text.encodeWide('¥'), Uint8Array.of(0x5c, 0));
  assert.deepEqual(text.encodeWide('\ud83d\ude00\ud800'), Uint8Array.of(0x3f, 0x3f, 0x3f, 0));
  assert.equal(text.decodeBytes(Uint8Array.of(0xef, 0xbb, 0xbf, 0x41), 1), '\ufeffA');
  assert.deepEqual(text.encodeWide('\ud800', 1), Uint8Array.of(0xef, 0xbf, 0xbd, 0));
});

test('Aokana native character decode differs from Windows conversion and combines encoded surrogate pairs', () => {
  const text = new AokanaNativeText();
  assert.equal(isNativeCp932Lead(0xff), true);
  assert.equal(isNativeCp932Lead(0xfd), false);
  assert.deepEqual(text.readCharacter(Uint8Array.of(0x81, 0x40), 0, 0), {
    value: 0x8140,
    length: 2,
    fullWidth: 1,
  });
  assert.deepEqual(text.readCharacter(bytes('ｱ'), 0, 1), {value: 0xff71, length: 3, fullWidth: 0});
  assert.deepEqual(text.readCharacter(Uint8Array.of(0xed, 0xa0, 0xbd, 0xed, 0xb8, 0x80), 0, 1), {
    value: 0x1f600,
    length: 6,
    fullWidth: 1,
  });
  assert.equal(nativeCp932CharacterToWide(0x8141), 0);
  assert.equal(nativeCp932CharacterToWide(0xef40), 0xef40);
  assert.equal(nativeCp932CharacterToWide(0xff01), 0xf001);
});

test('Aokana mixed decoder preserves run heuristics and faults only when native output is unwritten', () => {
  const text = new AokanaNativeText();
  assert.equal(text.decodeMixed(pointer('ASCII')), 'ASCII');
  assert.equal(text.decodeMixed(pointer([0x82, 0xa0, 0])), 'あ');
  assert.equal(text.decodeMixed(pointer([0xe3, 0x81, 0x82, 0x82, 0xa0, 0])), 'ああ');
  assert.equal(
    text.decodeMixed(pointer([0x82, 0xa0, 0xe3, 0x81, 0x82, 0xe3, 0x81, 0x84, 0])),
    'ああい',
  );
  // Four-byte UTF-8 needs two UTF-16 units, but the native estimator reserves one plus NUL.
  assert.throws(() => text.decodeMixed(pointer('😀')), /unwritten native allocation/);
});

test('Aokana search preserves multibyte mismatch reset and forward-copy aliasing', () => {
  const text = new AokanaNativeText();
  assert.equal(text.find(pointer('aaab'), pointer('aab')), 1);
  assert.equal(text.find(pointer('aaab'), pointer('aab'), 1), null);
  assert.equal(text.find(pointer('AあB'), pointer('あ')), 1);
  assert.equal(text.find(pointer('abc'), pointer('')), 0);
  assert.throws(() => text.find(pointer('あ'), pointer('')), /empty native allocation/);
  const input = bytes('abc');
  assert.throws(
    () => copyText({bytes: input, offset: 1}, {bytes: input, offset: 0}),
    /outside backing/,
  );
  assert.deepEqual(input, Uint8Array.of(97, 97, 97, 97));
});

test('Aokana VM formatting implements native decimal, hex, precision, padding, and legacy rounding', () => {
  assert.equal(
    ascii(format('%08X %08x %.0d % 6d', [0xabcdef, 0xabcdef, 0, 12])),
    '00ABCDEF 00abcdef      12',
  );
  assert.equal(ascii(format('%06.3d %-6d %06d', [-12, 12, -12])), '  -012 12     -00012');
  assert.equal(
    ascii(format('%.0f %.0f %.1f %.20f', [0x8000, -0x8000, 0x14000, 1])),
    '1 -1 1.3 0.00001525878906250000',
  );
  assert.equal(ascii(format('%2-d %..d %03c', [99, 88, 65])), '-d .d 00A');
  assert.equal(ascii(format('%100.9%', [])), '%');
});

test('Aokana VM formatter consumes byte characters after codepage encoding and rejects native invalid formats', () => {
  assert.deepEqual(format('%cX%c', [0, 0x81]), Uint8Array.of(0, 88, 0x81, 0));
  assert.throws(() => format('%+d', [1]), /rejects conversion/);
  assert.throws(() => format('%', [1]), /unfinished conversion/);
  assert.throws(() => format('\x1a', []), /empty raw-character list/);
  assert.throws(() => format('%s', [0]), /null %s operand/);
  assert.throws(() => format('%65536d', [1]), /65536-wchar/);
  const h = context(),
    text = new AokanaNativeText();
  text.selectMode(1);
  const source = put(h, 100, [0x82, 0xa0, 0]);
  push(h, source);
  assert.equal(ascii(formatVmText(h, pointer('%3.1s'), text)), '  あ');
});

test('Aokana string opcodes keep source encoding conversion, byte offsets, and native stack order', () => {
  const h = context(),
    text = new AokanaNativeText(),
    op = createTextOpcodes(text);
  const source = put(h, 100, [0x82, 0xa0, 65, 0x82, 0xa0, 0]),
    needle = put(h, 200, [0x82, 0xa0, 0]),
    replacement = put(h, 300, 'い');
  push(h, source, needle);
  op[0x66](h);
  assert.equal(pop32(h.thread), 0);
  push(h, 0x10000200, source, needle, replacement);
  op[0x67](h);
  assert.equal(pop32(h.thread), 2);
  assert.deepEqual(
    h.memory.readCString(h.thread, 0x10000200),
    Uint8Array.of(0x82, 0xa2, 65, 0x82, 0xa2),
  );
  push(h, needle, replacement);
  op[0x69](h);
  assert.equal(pop32(h.thread), 0);
  push(h, needle, put(h, 400, 'あ'));
  op[0x69](h);
  assert.equal(pop32(h.thread), 1);
  push(h, 0, 0);
  op[0x69](h);
  assert.equal(pop32(h.thread), 0);
  push(h, needle);
  op[0x6c](h);
  assert.deepEqual(
    [pop32(h.thread), pop32(h.thread), pop32(h.thread), pop32(h.thread)],
    [0, 1, 0x82a0, 2],
  );
  const lower = put(h, 600, 'AあZ');
  push(h, lower);
  op[0x6d](h);
  assert.equal(ascii(textBytes(h.memory.resolve(h.thread, lower), true)), 'aあz');
});

test('Aokana strcpy watch precedes writes and format watch follows all writes', () => {
  const notices = [],
    h = context((notice) => notices.push(h.memory.readCString(h.thread, notice.address).slice())),
    op = createTextOpcodes(new AokanaNativeText());
  h.diagnostics.writeWatchEnabled = true;
  const destination = put(h, 100, 'old'),
    source = put(h, 200, 'new'),
    formatAddress = put(h, 300, '%d');
  h.diagnostics.registerWriteWatch(h.thread, destination, 20, new Uint8Array());
  push(h, destination, source);
  op[0x6a](h);
  push(h, 42, destination, formatAddress);
  op[0x6f](h);
  assert.deepEqual(notices, [bytes('old').subarray(0, 3), bytes('42').subarray(0, 2)]);
});

test('Aokana concatenate measures its first source after copying and wraps with current text mode', () => {
  const h = context(),
    text = new AokanaNativeText(),
    op = createTextOpcodes(text);
  const first = put(h, 100, 'ab'),
    second = put(h, 200, 'cd');
  push(h, 0x10000300, first, second);
  op[0x6b](h);
  assert.equal(ascii(textBytes(h.memory.resolve(h.thread, 0x10000300), true)), 'abcd');
  push(h, 0x10000300, first, 34);
  op[0x6e](h);
  assert.equal(ascii(textBytes(h.memory.resolve(h.thread, 0x10000300), true)), '"ab"');
  text.selectMode(1);
  push(h, 0x10000300, first, 0x300c);
  op[0x6e](h);
  assert.equal(ascii(textBytes(h.memory.resolve(h.thread, 0x10000300), true)), '「ab「');
  text.selectMode(0);
  const overlap = put(h, 900, 'abc');
  push(h, overlap, overlap, 34);
  op[0x6e](h);
  assert.equal(ascii(textBytes(h.memory.resolve(h.thread, overlap), true)), '""bc"');
});

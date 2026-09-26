import {randomByteGenerator} from '../dist/formats/buriko/binary.js';
const encode = (value) => new TextEncoder().encode(value);
const put32 = (bytes, offset, value) => new DataView(bytes.buffer).setUint32(offset, value, true);
function varint(value) {
  const bytes = [];
  do {
    const low = value & 127;
    value >>>= 7;
    bytes.push(low | (value ? 128 : 0));
  } while (value);
  return bytes;
}
export function modernCbg(width = 8, height = 8, depth = 32, retain = false) {
  const head = new Uint8Array(200);
  head[0] = head[16] = 1;
  put32(head, 192, 200);
  const row = Uint8Array.from([1, ...varint(retain ? 0 : depth === 8 ? 64 : 192), 0, 0, 0]);
  put32(head, 196, 200 + row.length);
  // One alpha literal followed by a legal repeat covering the remaining63 pixels.
  const alpha = depth === 32 ? [1, 0, 0, 0, 2, 170, 63, 120] : [];
  const payload = Uint8Array.from([...head, ...row, ...alpha]);
  const bytes = new Uint8Array(176 + payload.length),
    view = new DataView(bytes.buffer);
  bytes.set(encode('CompressedBG___\0'));
  view.setUint16(16, width, true);
  view.setUint16(18, height, true);
  view.setUint16(20, depth, true);
  view.setUint16(46, 2, true);
  put32(bytes, 36, 1);
  put32(bytes, 40, 128);
  const next = randomByteGenerator(1);
  for (let i = 0; i < 128; i++) bytes[48 + i] = (1 + next()) & 255;
  bytes[44] = 128;
  bytes.set(payload, 176);
  return bytes;
}
export function legacyCbg() {
  const table = new Uint8Array(256);
  table[1] = 6;
  table[6] = 1;
  const bytes = new Uint8Array(305),
    view = new DataView(bytes.buffer);
  bytes.set(encode('CompressedBG___\0'));
  view.setUint16(16, 2, true);
  view.setUint16(18, 1, true);
  view.setUint16(20, 24, true);
  view.setUint16(46, 1, true);
  put32(bytes, 32, 7);
  put32(bytes, 36, 1);
  put32(bytes, 40, 256);
  const next = randomByteGenerator(1);
  for (let i = 0; i < table.length; i++) bytes[48 + i] = (table[i] + next()) & 255;
  bytes[44] = 7;
  bytes[45] = 7;
  // Frequencies1:6,6:1 give code6=0,code1=1 (MSB first): literal count6 followed by six residual1 bytes.
  bytes[304] = 0x7e;
  return bytes;
}
export function singleArchive(name, payload) {
  const bytes = new Uint8Array(144 + payload.length);
  bytes.set(encode('BURIKO ARC20'));
  put32(bytes, 12, 1);
  bytes.set(encode(name), 16);
  put32(bytes, 116, payload.length);
  bytes.set(payload, 144);
  return bytes;
}

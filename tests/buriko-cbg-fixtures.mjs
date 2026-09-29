// Synthetic legacy CompressedBG inputs around the reference frequency tree.
import {frequencyTree} from '../dist/formats/buriko/compressed-bg.js';

export function xorshift(seed) {
  return () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed >>> 0;
  };
}

export function varint(value, output) {
  for (;;) {
    const low = value % 128;
    value = Math.floor(value / 128);
    output.push(value ? low | 128 : low);
    if (!value) return output;
  }
}

/** Alternating literal and zero runs, starting with a (possibly empty) literal run. */
export function runs(residuals) {
  const output = [];
  let position = 0;
  while (position < residuals.length) {
    let end = position;
    while (end < residuals.length) {
      let zeros = 0;
      while (end + zeros < residuals.length && residuals[end + zeros] === 0) zeros++;
      if (zeros >= 3 || end + zeros === residuals.length) break;
      end += zeros + 1;
    }
    varint(end - position, output);
    for (let i = position; i < end; i++) output.push(residuals[i]);
    position = end;
    if (position === residuals.length) break;
    let zeros = 0;
    while (position + zeros < residuals.length && residuals[position + zeros] === 0) zeros++;
    varint(zeros, output);
    position += zeros;
  }
  return Uint8Array.from(output);
}

/** Legacy CompressedBG with an independently assembled container around the reference tree. */
export function encode({
  width,
  height,
  depth,
  residuals,
  seed,
  version = 1,
  intermediate = runs(residuals),
}) {
  const weights = new Array(256).fill(0);
  for (const symbol of intermediate) weights[symbol]++;
  const {root, children} = frequencyTree(weights),
    codes = new Array(256);
  const walk = (node, code) => {
    if (node < 256) codes[node] = code;
    else children[node].forEach((child, bit) => walk(child, code + bit));
  };
  walk(root, '');
  const bits = Array.from(intermediate, (symbol) => codes[symbol]).join(''),
    stream = new Uint8Array(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i++) if (bits[i] === '1') stream[i >> 3] |= 128 >> (i & 7);
  const table = [];
  for (const weight of weights) varint(weight, table);
  const bytes = new Uint8Array(48 + table.length + stream.length),
    data = new DataView(bytes.buffer);
  bytes.set(Array.from('CompressedBG___\0', (c) => c.charCodeAt(0)));
  data.setUint16(16, width, true);
  data.setUint16(18, height, true);
  data.setUint16(20, depth, true);
  for (let i = 22; i < 32; i++) bytes[i] = (i * 37) & 255;
  data.setUint32(32, intermediate.length, true);
  data.setUint32(36, seed, true);
  data.setUint32(40, table.length, true);
  let sum = 0,
    xor = 0,
    state = seed;
  table.forEach((value, i) => {
    const product = Number((BigInt(state) * 0x015a4e35n) & 0xffffffffn);
    state = (product + 1) >>> 0;
    bytes[48 + i] = (value + (product >>> 16)) & 255;
    sum = (sum + value) & 255;
    xor ^= value;
  });
  bytes[44] = sum;
  bytes[45] = xor;
  data.setUint16(46, version, true);
  bytes.set(stream, 48 + table.length);
  return bytes;
}

/** Skewed residuals with zero runs; rare symbols have codes longer than sixteen bits. */
export function residuals(random, size) {
  const output = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    const r = random();
    if (r % 29 === 0) {
      const zeros = Math.min(size - i, 1 + ((r >>> 8) % 40));
      i += zeros - 1;
    } else output[i] = Math.min(255, Math.floor(-Math.log2(1 - (r >>> 8) / 2 ** 24) * 24));
  }
  return output;
}

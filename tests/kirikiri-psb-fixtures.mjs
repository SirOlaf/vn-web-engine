/** Synthetic PSB (version 2) writer for Kirikiri format tests. */

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let p = 0;
  for (const part of parts) out.set(part, (p += part.length) - part.length);
  return out;
};
const u16 = (v) => Uint8Array.of(v & 0xff, v >>> 8);
const u32 = (v) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v, true);
  return b;
};

/** PSB name trie: node = charset[parent] + byte; each name ends in a terminator node (byte 0). */
export function nameTrie(names) {
  const tree = [0],
    charset = [1],
    children = [new Map()],
    used = new Set([0]);
  // Build a plain trie first, then place children with a free base per node.
  const terminal = [];
  for (const name of names) {
    let node = 0;
    for (const byte of [...new TextEncoder().encode(name), 0]) {
      if (!children[node].has(byte)) {
        children.push(new Map());
        children[node].set(byte, children.length - 1);
      }
      node = children[node].get(byte);
    }
    terminal.push(node);
  }
  const placed = new Map([[0, 0]]),
    queue = [0];
  while (queue.length) {
    const logical = queue.shift(),
      physical = placed.get(logical),
      kids = [...children[logical]];
    if (!kids.length) continue;
    let base = 1;
    while (kids.some(([byte]) => used.has(base + byte))) base++;
    charset[physical] = base;
    for (const [byte, child] of kids) {
      const at = base + byte;
      used.add(at);
      tree[at] = physical;
      placed.set(child, at);
      queue.push(child);
    }
  }
  const size = Math.max(...used) + 1;
  for (let i = 0; i < size; i++) {
    tree[i] ??= 0;
    charset[i] ??= 0;
  }
  return {charset, tree, indices: terminal.map((t) => placed.get(t))};
}

/** Integer array (`0x0e`): 2-byte count, 4-byte elements. */
export const intArray = (values) =>
  concat(Uint8Array.of(0x0e), u16(values.length), Uint8Array.of(0x10), ...values.map(u32));

/** Marks a number to be stored as a 32-bit float (`0x1e`). */
export const f32 = (value) => ({psbFloat32: value});
/** Marks bytes to be stored as a resource chunk. */
export const resource = (bytes) => ({psbResource: bytes});

/**
 * Encodes a JS value tree as a PSB file. Integers use the narrowest signed width, other
 * numbers 64-bit floats, `f32(x)` 32-bit floats, `resource(bytes)` a chunk. Object keys are
 * written in name order.
 */
export function buildPsb(root) {
  const names = new Set(),
    strings = new Map(),
    chunks = [];
  const scan = (v) => {
    if (typeof v === 'string') strings.has(v) || strings.set(v, strings.size);
    else if (Array.isArray(v)) v.forEach(scan);
    else if (v && typeof v === 'object' && !('psbFloat32' in v) && !('psbResource' in v))
      for (const [k, x] of Object.entries(v)) (names.add(k), scan(x));
  };
  scan(root);
  const sortedNames = [...names].sort((a, b) =>
    Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')),
  );
  const nameIndex = new Map(sortedNames.map((n, i) => [n, i]));
  const offsetsOf = (values) => {
    const offsets = [];
    let at = 0;
    for (const v of values) offsets.push((at += v.length) - v.length);
    return offsets;
  };
  const encode = (v) => {
    if (v === null) return Uint8Array.of(0x01);
    if (v === false) return Uint8Array.of(0x02);
    if (v === true) return Uint8Array.of(0x03);
    if (typeof v === 'number') {
      if (Number.isInteger(v) && Math.abs(v) < 2 ** 31) {
        if (v === 0) return Uint8Array.of(0x04);
        let width = 1;
        while (v < -(2 ** (width * 8 - 1)) || v >= 2 ** (width * 8 - 1)) width++;
        const bytes = new Uint8Array(width);
        let x = BigInt.asUintN(width * 8, BigInt(v));
        for (let i = 0; i < width; i++, x >>= 8n) bytes[i] = Number(x & 0xffn);
        return concat(Uint8Array.of(0x04 + width), bytes);
      }
      return concat(Uint8Array.of(0x1f), new Uint8Array(new Float64Array([v]).buffer));
    }
    if (typeof v === 'string') return concat(Uint8Array.of(0x16), u16(strings.get(v)));
    if (Array.isArray(v)) {
      const values = v.map(encode);
      return concat(Uint8Array.of(0x20), intArray(offsetsOf(values)), ...values);
    }
    if ('psbFloat32' in v)
      return concat(Uint8Array.of(0x1e), new Uint8Array(new Float32Array([v.psbFloat32]).buffer));
    if ('psbResource' in v) {
      chunks.push(v.psbResource);
      return concat(Uint8Array.of(0x1a), u16(chunks.length - 1));
    }
    const entries = Object.entries(v).sort((a, b) => nameIndex.get(a[0]) - nameIndex.get(b[0]));
    const values = entries.map(([, x]) => encode(x));
    return concat(
      Uint8Array.of(0x21),
      intArray(entries.map(([k]) => nameIndex.get(k))),
      intArray(offsetsOf(values)),
      ...values,
    );
  };
  const rootBytes = encode(root);
  const trie = nameTrie(sortedNames),
    namesBlock = concat(intArray(trie.charset), intArray(trie.tree), intArray(trie.indices));
  const stringList = [...strings.keys()].map((s) =>
      concat(new TextEncoder().encode(s), Uint8Array.of(0)),
    ),
    stringOffsets = intArray(offsetsOf(stringList)),
    stringData = concat(...stringList),
    chunkOffsets = intArray(offsetsOf(chunks)),
    chunkLengths = intArray(chunks.map((c) => c.length)),
    chunkData = concat(...chunks);
  const blocks = [namesBlock, stringOffsets, stringData, chunkOffsets, chunkLengths, chunkData];
  const at = [];
  let offset = 0x28;
  for (const block of blocks) (at.push(offset), (offset += block.length));
  return concat(
    new TextEncoder().encode('PSB\0'),
    u16(2),
    u16(0),
    u32(0x28),
    u32(at[0]),
    u32(at[1]),
    u32(at[2]),
    u32(at[3]),
    u32(at[4]),
    u32(at[5]),
    u32(offset),
    ...blocks,
    rootBytes,
  );
}

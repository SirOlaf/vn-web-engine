// Synthetic DSC 1.00 inputs with independently computed expected output.

export function xorshift(seed) {
  return () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed >>> 0;
  };
}

// Independent integer arithmetic for the native wrapping product recurrence.
export function keyStream(seed) {
  let state = BigInt(seed);
  return () => {
    const product = (state * 22695477n) & 0xffffffffn;
    state = (product + 1n) & 0xffffffffn;
    return Number((product >> 16n) & 255n);
  };
}

/** Complete Huffman code lengths; the skew yields codes both shorter and longer than 12 bits. */
export function huffmanLengths(random) {
  let nodes = Array.from({length: 512}, (_, symbol) => ({
    weight: 1 + Math.floor(1e7 * 0.975 ** (random() % 512)),
    symbols: [symbol],
  }));
  const lengths = new Uint8Array(512);
  while (nodes.length > 1) {
    nodes.sort((a, b) => a.weight - b.weight);
    const [a, b] = nodes;
    for (const symbol of [...a.symbols, ...b.symbols]) lengths[symbol]++;
    nodes = [
      {weight: a.weight + b.weight, symbols: [...a.symbols, ...b.symbols]},
      ...nodes.slice(2),
    ];
  }
  return lengths;
}

/** Canonical DSC 1.00 encoding of literal and back-reference tokens with independent expected output. */
export function encode(tokens, lengths, seed) {
  const order = [...lengths.keys()]
    .filter((symbol) => lengths[symbol])
    .sort((a, b) => lengths[a] - lengths[b] || a - b);
  const codes = new Map();
  let code = 0,
    previous = lengths[order[0]];
  for (const symbol of order) {
    code <<= lengths[symbol] - previous;
    previous = lengths[symbol];
    codes.set(symbol, code++);
  }
  const bits = [];
  const put = (value, count) => {
    for (let bit = count - 1; bit >= 0; bit--) bits.push((value >>> bit) & 1);
  };
  const output = [];
  for (const token of tokens) {
    const symbol = token.literal ?? 256 + token.count - 2;
    put(codes.get(symbol), lengths[symbol]);
    if (token.literal !== undefined) output.push(token.literal);
    else {
      put(token.distance - 2, 12);
      for (let i = 0; i < token.count; i++) output.push(output[output.length - token.distance]);
    }
  }
  const stream = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((bit, i) => (stream[i >>> 3] |= bit << (7 - (i & 7))));
  const bytes = new Uint8Array(0x220 + stream.length);
  bytes.set(new TextEncoder().encode('DSC FORMAT 1.00\0'));
  const header = new DataView(bytes.buffer);
  header.setUint32(16, seed, true);
  header.setUint32(20, output.length, true);
  header.setUint32(24, tokens.length, true);
  const key = keyStream(seed);
  for (let symbol = 0; symbol < 512; symbol++) bytes[32 + symbol] = (lengths[symbol] + key()) & 255;
  bytes.set(stream, 0x220);
  return {bytes, expected: Uint8Array.from(output)};
}

export function sample(random, count) {
  // Mostly frequent symbols, with uniform picks to reach long codes; short and
  // overlapping distances exercise repeated-pattern copies.
  const tokens = [];
  let produced = 0;
  for (let i = 0; i < count; i++) {
    const symbol = random() % 4 ? random() % 48 : random() % 512;
    if (symbol < 256 || produced < 2) tokens.push({literal: symbol & 255});
    else {
      const limit = Math.min(produced, 4097),
        distance =
          random() & 1 ? 2 + (random() % Math.min(limit - 1, 19)) : 2 + (random() % (limit - 1));
      tokens.push({count: (symbol & 255) + 2, distance});
    }
    produced += tokens.at(-1).count ?? 1;
  }
  return tokens;
}

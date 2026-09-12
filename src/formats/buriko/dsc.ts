import {checkRange} from '../../core/binary.js';
import {Bits, randomByteGenerator, signature, view} from './binary.js';
/** BGI_DSC_BuildDecodeTree / DecodeSymbols, 0x1400b8390 / 0x1400b8220. */
export function decodeDsc(bytes: Uint8Array, maxBytes = 0x4000000): Uint8Array {
  checkRange(bytes.length, 0, 0x220);
  if (!signature(bytes, 'DSC FORMAT 1.00\0')) throw new Error('Not DSC 1.00');
  const data = view(bytes),
    size = data.getUint32(20, true),
    tokens = data.getUint32(24, true);
  if (size > maxBytes) throw new Error('DSC decoded size exceeds resource limit');
  const random = randomByteGenerator(data.getUint32(16, true));
  const symbols: {symbol: number; length: number}[] = [];
  for (let symbol = 0; symbol < 512; symbol++) {
    const length = (bytes[32 + symbol]! - random()) & 255;
    if (length) symbols.push({symbol, length});
  }
  symbols.sort((a, b) => a.length - b.length || a.symbol - b.symbol);
  const nodes: {symbol: number; children: number[]}[] = [{symbol: -1, children: []}];
  let level = [0],
    cursor = 0;
  for (let depth = 0; cursor < symbols.length; depth++) {
    const next: number[] = [];
    for (const index of level) {
      const node = nodes[index]!;
      if (symbols[cursor]?.length === depth) node.symbol = symbols[cursor++]!.symbol;
      else {
        node.children = [nodes.length, nodes.length + 1];
        next.push(...node.children);
        nodes.push({symbol: -1, children: []}, {symbol: -1, children: []});
        if (nodes.length > 1023) throw new Error('Invalid DSC Huffman tree');
      }
    }
    if (!next.length && cursor < symbols.length) throw new Error('Oversubscribed DSC Huffman tree');
    level = next;
  }
  if (!symbols.length && tokens) throw new Error('Empty DSC Huffman tree');
  const bits = new Bits(bytes.subarray(0x220)),
    output = new Uint8Array(size);
  let p = 0;
  for (let token = 0; token < tokens; token++) {
    let node = nodes[0]!;
    while (node.symbol < 0) {
      const child = node.children[bits.read(1)];
      if (child === undefined) throw new Error('Invalid DSC code');
      node = nodes[child]!;
    }
    if (node.symbol < 256) {
      checkRange(size, p, 1);
      output[p++] = node.symbol;
    } else {
      const count = (node.symbol & 255) + 2,
        distance = bits.read(12) + 2;
      if (distance > p) throw new Error('DSC backreference precedes output');
      checkRange(size, p, count);
      for (let i = 0; i < count; i++, p++) output[p] = output[p - distance]!;
    }
  }
  if (p !== size) throw new Error(`DSC size mismatch: ${p} != ${size}`);
  return output;
}

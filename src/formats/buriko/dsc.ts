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
  // Keep tree construction and scalar tails so incomplete trees and truncated
  // streams retain the same errors. Most symbols fit in a single prefix lookup;
  // longer codes continue from the node reached by those twelve bits. Tiny
  // streams skip the table setup.
  const prefixBits = 12,
    prefixTable = tokens >= 128 ? new Int32Array(1 << prefixBits) : null;
  function fillPrefixes(index: number, prefix: number, depth: number): void {
    const node = nodes[index]!;
    if (node.symbol >= 0) {
      const suffixBits = prefixBits - depth;
      prefixTable!.fill(
        (node.symbol << 4) | depth,
        prefix << suffixBits,
        (prefix + 1) << suffixBits,
      );
    } else if (depth === prefixBits) {
      prefixTable![prefix] = -index;
    } else {
      for (let bit = 0; bit < node.children.length; bit++)
        fillPrefixes(node.children[bit]!, (prefix << 1) | bit, depth + 1);
    }
  }
  if (prefixTable) fillPrefixes(0, 0, 0);
  const input = bytes.subarray(0x220),
    bits = new Bits(input),
    bitLength = input.length * 8,
    output = new Uint8Array(size),
    outputView = view(output);
  let p = 0;
  for (let token = 0; token < tokens; token++) {
    let node = nodes[0]!,
      symbol = -1;
    if (prefixTable && bits.position + prefixBits <= bitLength) {
      const index = bits.position >>> 3,
        shift = bits.position & 7,
        prefix =
          (((input[index]! << 16) | (input[index + 1]! << 8) | input[index + 2]!) >>>
            (12 - shift)) &
          4095,
        entry = prefixTable[prefix]!;
      if (entry > 0) {
        bits.position += entry & 15;
        symbol = entry >>> 4;
      } else if (entry < 0) {
        bits.position += prefixBits;
        node = nodes[-entry]!;
      }
    }
    if (symbol < 0) {
      while (node.symbol < 0) {
        const child = node.children[bits.read(1)];
        if (child === undefined) throw new Error('Invalid DSC code');
        node = nodes[child]!;
      }
      symbol = node.symbol;
    }
    if (symbol < 256) {
      if (p >= size) checkRange(size, p, 1);
      output[p++] = symbol;
    } else {
      const count = (symbol & 255) + 2;
      if (bits.position + 12 > bitLength) bits.read(12);
      const index = bits.position >>> 3,
        shift = bits.position & 7,
        distance =
          ((((input[index]! << 16) | (input[index + 1]! << 8) | input[index + 2]!) >>>
            (12 - shift)) &
            4095) +
          2;
      bits.position += 12;
      if (distance > p) throw new Error('DSC backreference precedes output');
      if (p > size - count) checkRange(size, p, count);
      const end = p + count;
      if (count >= 16) {
        // Read only already decoded bytes before each four-byte write. A
        // distance of two repeats its pair; distance-three overlap stays scalar.
        if (distance >= 4) {
          for (; p + 4 <= end; p += 4)
            outputView.setUint32(p, outputView.getUint32(p - distance, true), true);
        } else if (distance === 2) {
          const pair = output[p - 2]! | (output[p - 1]! << 8),
            word = pair | (pair << 16);
          for (; p + 4 <= end; p += 4) outputView.setUint32(p, word, true);
        }
      }
      for (; p < end; p++) output[p] = output[p - distance]!;
    }
  }
  if (p !== size) throw new Error(`DSC size mismatch: ${p} != ${size}`);
  return output;
}

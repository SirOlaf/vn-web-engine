import {BitReader} from './bits.js';
/** Prefix code table compiled once to a compact binary tree; no speculative overread. */
export class Vlc {
  private readonly zero: number[] = [0];
  private readonly one: number[] = [0];
  private readonly value: (number | undefined)[] = [undefined];
  constructor(entries: readonly (readonly [string, number])[]) {
    for (const [code, value] of entries) {
      let node = 0;
      for (const bit of code) {
        if (this.value[node] !== undefined || !['0', '1'].includes(bit))
          throw new Error('Invalid prefix code');
        const branch = bit === '1' ? this.one : this.zero;
        if (!branch[node]) {
          branch[node] = this.zero.length;
          this.zero.push(0);
          this.one.push(0);
          this.value.push(undefined);
        }
        node = branch[node]!;
      }
      if (this.value[node] !== undefined || this.zero[node] || this.one[node])
        throw new Error('Duplicate/overlapping prefix code');
      this.value[node] = value;
    }
  }
  read(bits: BitReader): number {
    let node = 0;
    for (;;) {
      node = (bits.read(1) ? this.one : this.zero)[node]!;
      if (!node) throw new Error(`Invalid VLC at bit ${bits.position}`);
      const value = this.value[node];
      if (value !== undefined) return value;
    }
  }
}

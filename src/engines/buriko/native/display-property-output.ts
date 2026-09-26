/** Native caller DWORD accesses remain ordered and may start at an unaligned byte address. */
export interface BurikoDisplayPropertyOutput {
  read32(index: number): number;
  write32(index: number, value: number): void;
}

export type BurikoDisplayPropertyDestination = Uint32Array | BurikoDisplayPropertyOutput;

export function displayPropertyOutput(
  output: BurikoDisplayPropertyDestination,
): BurikoDisplayPropertyOutput {
  if (!(output instanceof Uint32Array)) return output;
  const check = (index: number): void => {
    if (!Number.isInteger(index) || index < 0 || index >= output.length)
      throw new RangeError('CDspObj property accesses outside native output');
  };
  return {
    read32(index) {
      check(index);
      return output[index]!;
    },
    write32(index, value) {
      check(index);
      output[index] = value >>> 0;
    },
  };
}

/** 1400fa7f0: the shared status translation used by this executable's D0 wrappers. */
export function aokanaLogicalStatus(status: number): number {
  status >>>= 0;
  if (status === 0) return 0;
  if (status === 1) return 0x1d;
  if (status >= 0x80000000 && status <= 0x8000000b) return status - 0x80000000 + 1;
  if (status === 0x90000002) return 0x10;
  if (status === 0x90000003) return 0x11;
  if (status >= 0xa0000000 && status <= 0xa000000b)
    return [1, 0x12, 0x13, 0x14, 8, 0x15, 0x16, 0x18, 0x19, 0x1a, 0x1b, 0x1c][status - 0xa0000000]!;
  return status === 0xfffffffe ? status : 0xffffffff;
}

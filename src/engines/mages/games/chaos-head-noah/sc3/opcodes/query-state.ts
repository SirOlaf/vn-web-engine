import type {OpcodeExecution} from './types.js';

/** 00/46, 1400560f0. Native query selectors; reads deliberately remain 32-bit. */
export function queryState(h: OpcodeExecution): void {
  h.skip(2);
  const selector = h.expression(),
    s = h.state,
    g = (a: number) => s.get(a);
  const result = (value: number) => h.context.setInt32(0x1c, value, true);
  const channel = () => g(0x20dde8) >>> 0;
  const ready = (base: number, gate: boolean) =>
    Number(
      (!gate || (!g(base + 0x0c) && !g(base + 0x20))) &&
        (g(base + 0x3c) !== 0 || g(base + 0x38) === 0),
    );
  const status = (address: number) => {
    const value = g(address) >>> 0;
    return value < 7 ? [4, 0, 2, 1, 3, 1, 5][value]! : 7;
  };
  const position = (base: number) => (g(base + 0x14) === g(base) ? g(base + 0x24) : 0);
  switch (selector) {
    case 0:
      result(g(0x17abdbc));
      break;
    case 1:
      result(ready(0x5a72d8, true));
      break;
    case 2:
      result(ready(0x5a7110 + channel() * 0x98, false));
      break;
    case 3:
      result(ready(0x5a7110, true));
      break;
    case 4:
      result(ready(0x5a71a8, true));
      break;
    case 5:
      result(g(0x17ac374));
      break;
    case 6:
      result(status(0x1d9ff90));
      break;
    case 7:
      result(status(0x1d90948 + channel() * 0x5218));
      break;
    case 8:
      result(status(0x1d90948));
      break;
    case 9:
      result(status(0x1d95b60));
      break;
    case 10:
      result((g(0x17ac2ec) >>> 2) & 1);
      break;
    case 11:
      result(position(0x5a72d8));
      break;
    case 12:
      result(position(0x5a7110 + channel() * 0x98));
      break;
    case 13:
      result(position(0x5a7110));
      break;
    case 14:
      result(position(0x5a71a8));
      break;
    case 15:
      result(ready(0x5a7240, true));
      break;
    case 16:
      result(status(0x1d9ad78));
      break;
    case 17:
      result(position(0x5a7240));
      break;
  }
}

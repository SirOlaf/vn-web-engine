import type {NoahInput} from './input.js';

/** Complete 14001f7a0 action switch. Query order matters: keyboard edges are consumed. */
export function queryInput(input: NoahInput, action: number): boolean {
  const s = input.state;
  if (s.bytes(0x543836, 1)[0]) return false;
  if (action < 11 && (s.view(0x586a58, 8).getBigInt64(0, true) & BigInt(1 << (action & 31))) !== 0n)
    return true;
  const pressed = s.get(0x5a70d4),
    repeat = s.get(0x5a6f74),
    mouse = s.get(0x17add90);
  const p = (address: number) => !!(pressed & s.get(address)),
    r = (address: number) => !!(repeat & s.get(address));
  const key = (row: number) => input.keyEdge(row),
    hit = (index: number) => input.hit(0, index, true) && !!(mouse & 1);
  switch (action) {
    case 0:
    case 0x29:
    case 0x2a:
      return p(0x872dd4);
    case 1:
    case 2:
      return p(0x872dd8) || !!(mouse & 2);
    case 3:
      return r(0x872dc8);
    case 4:
      return r(0x872dcc);
    case 5:
    case 0x2b:
      return r(0x872dc0);
    case 6:
    case 0x2c:
      return r(0x872dc4);
    case 7:
    case 8:
    case 9:
    case 10:
      return !!(repeat & (1 << (action + 1)));
    case 0x14:
      return p(0x872dd0) || !!(mouse & 1);
    case 0x15:
      return p(s.get(0x17ac370) ? 0x872e1c : 0x872e60) || !!(mouse & 1);
    case 0x16:
      return (
        !!(s.get(0x5a70d0) & s.get(0x872ddc)) ||
        input.bindings(50).some((k) => !!(s.bytes(0x1bae7e0 + k, 1)[0]! & 128))
      );
    case 0x17:
      return p(0x872de0) || key(0x36) || hit(3);
    case 0x18:
      return p(0x872de4) || key(0x35) || hit(4);
    // The first term is the configured mask itself, not a masked input value.
    case 0x19:
      return s.get(0x872dec) !== 0 || p(0x872dd8) || key(0x40);
    case 0x1a:
      return p(0x872df4);
    case 0x1b:
      return p(s.get(0x872dec) ? 0x872dec : 0x872dd8);
    case 0x1c:
      return p(0x872de8) || key(0x41) || !!(mouse & 2) || hit(2);
    case 0x1d:
      return p(0x872df0) || key(0x34) || hit(5);
    case 0x1e:
      return p(0x872e14) || key(0x37);
    case 0x1f:
      return key(0x39);
    case 0x20:
      return key(0x38);
    case 0x21:
      return key(0x3b);
    case 0x22:
      return key(0x3a);
    case 0x23:
      return key(0x33);
    case 0x24:
      return key(0x3e);
    case 0x26:
    case 0x27:
      return p(0x872df8) || !!(mouse & 1);
    case 0x28:
      return !!(pressed & 0x4000);
    case 0x2e:
      return p(0x872e18) || !!(mouse & 4);
    case 0x3f:
      return !!(pressed & 0x20) || !!(s.bytes(0x1bae6e3, 1)[0]! & 128);
    case 0x40:
      return !!(s.bytes(0x1bae6e5, 1)[0]! & 128);
    default:
      return false;
  }
}

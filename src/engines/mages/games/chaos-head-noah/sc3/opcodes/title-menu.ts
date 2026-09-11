import type {OpcodeExecution} from './types.js';

/** 14005bbe0 and its title/menu reducers 140032880 and 140033280.
 * Rendering remains script driven; these are native input/state transitions. */
export function titleMenu(h: OpcodeExecution): void {
  h.skip(2);
  const selector = h.byte(),
    s = h.state;
  const g = (a: number) => s.get(a) >>> 0,
    p = (a: number, v: number) => s.put(a, v);
  const v = (a: number) => s.variable(a / 4),
    w = (a: number, n: number) => s.setVariable(a / 4, n);
  const special = () => !!(s.flags[0xf1]! & 4) && !(s.flags[0xf1]! & 8);
  const signal = () => {
    s.flags[0x9b] = s.flags[0x9b]! | 2;
  };
  const sound = (id: number) => {
    // Native MOV EAX zero-extends the setting before conversion to float.
    const volume = Math.trunc(Math.fround(Math.fround(Math.fround(g(0x17ac2e8)) * 70) / 100)) >>> 0;
    p(0x5a7100, volume);
    h.sound(id, volume);
  };
  const pressed = (mask: number) => !!(g(0x5a70d4) & g(mask));
  const repeat = (mask: number) => !!(g(0x5a6f74) & g(mask));
  const cancel = () =>
    !s.bytes(0x543836, 1)[0] &&
    !!(s.bytes(0x586a58, 1)[0]! & 2 || pressed(0x872dd8) || g(0x17add90) & 2);
  const click = () => {
    if (g(0x17add90) & 1) p(0x5a70d4, g(0x5a70d4) | g(0x872dd4));
  };
  if (selector === 0) {
    s.initializeTitle();
    return;
  }
  if (selector === 3) {
    p(0x5afa9c, special() ? 0 : 1);
    return;
  }
  if (selector !== 1) return; // Native default consumes only the selector.
  switch (v(0x210c)) {
    case 1:
      if (!s.bytes(0x543836, 1)[0] && (pressed(0x872dd0) || g(0x17add90) & 1)) {
        s.variables.setBigUint64(0x210c, 2n, true);
        w(0x211c, 0);
        signal();
      } else w(0x2110, v(0x2110) + 1);
      return;
    case 10:
      p(0x5af948, g(0x5af948) + 1);
      if (g(0x5af948) >= 32) w(0x210c, 11);
      return;
    case 12:
      p(0x5af948, g(0x5af948) - 1);
      if (!g(0x5af948)) w(0x210c, 3);
      return;
    case 11: {
      if (cancel()) {
        sound(3);
        w(0x210c, 12);
        return;
      }
      for (let i = 0; i < 4; i++)
        if (h.input.hit(12, i, true)) {
          if (g(0x17add90) & 1) {
            click();
            p(0x5b0990, i);
          }
          break;
        }
      if (s.flags[0x65]! & 4) {
        if (repeat(0x872dc0)) {
          sound(1);
          p(0x5b0990, g(0x5b0990) ? g(0x5b0990) - 1 : 3);
        }
        // Both directions are evaluated independently in the native route menu.
        if (repeat(0x872dc4)) {
          sound(1);
          p(0x5b0990, g(0x5b0990) < 3 ? g(0x5b0990) + 1 : 0);
        }
      }
      if (pressed(0x872dd4)) {
        sound(2);
        signal();
        const route = [1, 2, 3, 0][g(0x5b0990)];
        if (route === undefined)
          throw new Error('Native title route index outside its four-entry stack table');
        w(0x216c, route + 20);
      }
      return;
    }
    case 3:
      break;
    default:
      return;
  }
  if (g(0x5b0a50)) {
    p(0x5b0a50, g(0x5b0a50) + 1);
    if (g(0x5b0a50) >= 64) {
      p(0x5b0a50, 0);
      signal();
      if (g(0x5afa9c) === 0) w(0x216c, 50);
      else if (g(0x5afa9c) === 1) w(0x216c, 0);
    }
    return;
  }
  const transition = g(0x5b0a40);
  if ((transition - 1) >>> 0 < 63) {
    p(0x5b0a40, transition + (g(0x5a7108) ? 1 : -1));
    return;
  }
  if (transition === 64) {
    const count = () => g(0x20d380 + g(0x5afa9c) * 4),
      row = () => 0x5af910 + g(0x5afa9c) * 4;
    for (let i = 0; i < count(); i++)
      if (h.input.hit(11, i, true)) {
        p(row(), i);
        click();
        break;
      }
    if (repeat(0x872dc0)) {
      sound(1);
      p(row(), g(row()) ? g(row()) - 1 : count() - 1);
      return;
    }
    if (repeat(0x872dc4)) {
      sound(1);
      p(row(), g(row()) + 1);
      if (g(row()) >= count()) p(row(), 0);
      return;
    }
    if (cancel()) {
      sound(3);
      p(0x5b0a40, g(0x5b0a40) - 1);
      p(0x5a7108, 0);
      return;
    }
    if (pressed(0x872dd4)) {
      sound(2);
      const selected = g(0x5afa9c);
      if (selected === 2 || selected === 4) {
        signal();
        w(0x216c, g(row()) + (selected === 2 ? 10 : 20));
      }
    }
    return;
  }
  for (let i = 0; i < 5; i++)
    if (h.input.hit(10, i, true)) {
      p(0x5afa9c, i);
      click();
      break;
    }
  if (repeat(0x872dc0)) {
    sound(1);
    if (g(0x5afa9c)) {
      p(0x5afa9c, g(0x5afa9c) - 1);
      if (special() || g(0x5afa9c)) return;
    }
    p(0x5afa9c, 4);
    return;
  }
  if (repeat(0x872dc4)) {
    sound(1);
    p(0x5afa9c, g(0x5afa9c) < 4 ? g(0x5afa9c) + 1 : special() ? 0 : 1);
    return;
  }
  if (!pressed(0x872dd4)) return;
  switch (g(0x5afa9c)) {
    case 0:
    case 1:
      sound(2);
      p(0x5b0a50, 1);
      return;
    case 2:
      sound(2);
      p(0x5b0a40, g(0x5b0a40) + 1);
      p(0x5a7108, 1);
      return;
    case 3:
      sound(2);
      signal();
      w(0x216c, 30);
      return;
    case 4:
      sound(2);
      w(0x218c, 0);
      w(0x210c, 10);
      return;
  }
}

import type {OpcodeExecution} from './opcodes/types.js';
/** 14005d8b0: native message speed, skip/auto modes and per-slot input state. */
export function updateSceneInput(h: Pick<OpcodeExecution, 'state' | 'input'>): void {
  const s = h.state,
    g = (a: number) => s.get(a),
    p = (a: number, v: number) => s.put(a, v),
    v = (a: number) => s.variable(a / 4),
    flag = (a: number, m: number) => !!(s.flags[a]! & m);
  let speed = g(0x17a0cd8),
    autoSpeed = -0xf000,
    skip = 0,
    fast = 0;
  p(0x17abc9c, speed);
  p(0x17abda8, 0);
  p(0x17add38, autoSpeed);
  p(0x17ac284, 0);
  p(0x17ac374, 0);
  s.setFlag(0x780, g(0x17abe8c) !== 0 ? 1 : 0);
  const blocked = () => s.bytes(0x543836, 1)[0] !== 0,
    pressed = (a: number) => !!(g(0x5a70d4) & g(a)),
    click = () => g(0x17add90) & 1;
  let confirm =
    g(0x17ac370) === 0
      ? blocked()
        ? 0
        : pressed(0x872e60)
          ? 1
          : click()
      : Number(pressed(0x872e60));
  if (
    h.input.hit(0, 5, true) ||
    h.input.hit(0, 2, true) ||
    h.input.hit(30, 0, false) ||
    h.input.hit(30, 1, false)
  )
    confirm = 0;
  else confirm |= click();
  let mode = v(0x34a8) === 255 ? g(0x17ac2ec) >>> 0 : 0;
  if (v(0x34a8) !== 255) p(0x17ac2ec, 0);
  for (let i = 0; i < 3; i++) {
    p(0x17ac200 + i * 4, speed);
    p(0x17ac288 + i * 4, autoSpeed);
    p(0x17ac258 + i * 4, skip);
    p(0x17ac1d0 + i * 4, fast);
  }
  if ((v(0x2104) & 0x105) === 1 && v(0x34a8) === 255) {
    // Native short-circuit order matters: keyEdge() consumes keyboard edges.
    const toggleSkip =
      !blocked() &&
      (pressed(0x872de0) || !!h.input.keyEdge(0x36) || (h.input.hit(0, 3, true) && !!click()));
    const toggleAuto =
      !blocked() &&
      (pressed(0x872de4) || !!h.input.keyEdge(0x35) || (h.input.hit(0, 4, true) && !!click()));
    let held = false;
    if (!blocked()) {
      held = !!(g(0x5a70d0) & g(0x872ddc));
      if (!held)
        for (let i = 0; i < 8; i++) {
          const key = g(0x872780 + i * 4) >>> 0;
          if (key && s.bytes(0x1bae7e0 + key, 1)[0]! & 128) {
            held = true;
            break;
          }
        }
    }
    if (!flag(0x9b, 16)) {
      if (flag(0xe6, 4)) {
        if (held) {
          skip = 1;
          p(0x17abda8, 1);
          p(0x17ac374, 1);
        }
        if (!flag(0x98, 32)) {
          if (toggleSkip) {
            mode = mode & 3 ? mode & 4 : ((mode & 4) + g(0x17abc00) + 1) >>> 0;
            s.put(0x543836, 1, 1);
          }
          if (toggleAuto) {
            mode = mode & 4 ? mode & 3 : mode | 4;
            s.put(0x543836, 1, 1);
          }
          if (mode & 4) autoSpeed = g(0x17adca8);
          if (!blocked() && (g(0x872dec) !== 0 || pressed(0x872dd8) || !!h.input.keyEdge(0x40)))
            mode = 0;
        }
        if (g(0x17a0ccc) !== 0) mode = 0;
        p(0x17ac2ec, mode);
      }
      p(0x17add38, autoSpeed);
      if (flag(0x139, 4)) autoSpeed = g(0x17adca8);
      let confirmedFast = 0;
      if (mode & 2 || g(0x17abda8) === 1) {
        if (mode & 2) skip = 1;
        fast = 1;
        confirmedFast = 1;
        speed = autoSpeed = 0x3fff0000;
      } else {
        confirmedFast = 1;
        if (mode & 1 && g(0x17ac22c) !== 0) {
          skip = 1;
          fast = 1;
          speed = autoSpeed = 0x3fff0000;
        }
      }
      p(0x17add38, autoSpeed);
      p(0x17ac284, fast);
      p(0x17ac374, skip);
      for (let i = 0; i < 3; i++) {
        let slotSpeed = speed,
          slotAuto = autoSpeed,
          slotFast = fast;
        if (!(v(0x4428 + i * 40) & 16)) {
          if (flag(0x139, 2)) slotSpeed = 0x3fff0000;
          if (confirm) {
            slotSpeed = slotAuto = 0x3fff0000;
            slotFast = confirmedFast;
          }
        }
        p(0x17ac200 + i * 4, slotSpeed);
        p(0x17ac288 + i * 4, slotAuto);
        p(0x17ac1d0 + i * 4, slotFast);
      }
      if (flag(0x139, 2)) speed = 0x3fff0000;
      if (confirm) {
        speed = autoSpeed = 0x3fff0000;
        fast = confirmedFast;
      }
      p(0x17abc9c, speed);
      p(0x17add38, autoSpeed);
      p(0x17ac284, fast);
      for (let i = 0; i < 3; i++) p(0x17ac258 + i * 4, skip);
    }
  }
  s.setFlag(0x4d3, g(0x17ac22c) !== 0 ? 1 : 0);
  s.setFlag(0x4d1, fast !== 0 ? 1 : 0);
  s.setFlag(0x4d2, skip !== 0 ? 1 : 0);
  s.setFlag(
    0x4d6,
    g(0x17abda8) !== 0 || (mode & 2) !== 0 || ((mode & 1) !== 0 && g(0x17ac1fc) !== 0) ? 1 : 0,
  );
}

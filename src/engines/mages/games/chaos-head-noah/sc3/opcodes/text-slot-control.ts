import type {OpcodeExecution} from './types.js';

/** 01/11, 14004ef60: text-slot activation, completion waits, and progress reset. */
export function textSlotControl(h: OpcodeExecution): void {
  const s = h.state,
    c = h.context;
  h.skip(2);
  const mode = h.byte();
  let slot = c.getInt32(0x13c, true);
  if (mode >= 5 && mode <= 7) {
    slot = h.expression();
    c.setInt32(0x13c, slot, true);
  }
  const flag = slot + 0x9c6,
    variable = slot + 0x839;
  const deactivate = () => {
    if (s.flag(flag)) {
      s.setFlag(flag, 0);
      h.yield();
    }
  };
  const activate = () => {
    if (s.flag(flag)) return;
    if (s.variable(variable) === 0) {
      s.put(0x80c4d0 + slot * 4, 0);
      s.put(0x80cff0 + slot * 4, 0);
    }
    s.setFlag(flag, 1);
    h.yield();
  };
  const clear = (progress: boolean) => {
    s.setFlag(flag, 0);
    if (progress) s.put(0x80cff0 + slot * 4, 0);
    s.setVariable(variable, 0);
  };
  switch (mode) {
    case 0:
      deactivate();
      return;
    case 1:
      activate();
      return;
    case 2:
      if (s.variable(variable) >>> 0 < 256) h.retry();
      return;
    case 3:
      if (s.variable(variable) !== 0) h.retry();
      return;
    case 4:
      clear(true);
      return;
    case 5:
      deactivate();
      return;
    case 6:
      activate();
      return;
    case 7:
      clear(false);
      return;
    default:
      return;
  }
}

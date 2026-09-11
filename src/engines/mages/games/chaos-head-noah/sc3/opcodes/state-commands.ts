import type {OpcodeExecution} from './types.js';
import {backgroundIndex} from './background.js';

/** 00/08, 1400524f0: the label names a table of uint16 label indices. */
export function indexedJump(h: OpcodeExecution): void {
  h.skip(2);
  const index = h.expression(),
    slot = h.context.getUint32(0x74, true);
  const table = h.labelAddress(slot, h.word()),
    offset = (index * 2) | 0;
  const label = h.scriptByte(table + offset) | (h.scriptByte(table + offset + 1) << 8);
  h.context.setBigUint64(0x158, BigInt(h.labelAddress(slot, label)), true);
}
/** 00/14, 140052d50: both operands are unsigned flag indices. */
export function copyFlag(h: OpcodeExecution): void {
  h.skip(2);
  const source = h.expression() >>> 0,
    target = h.expression() >>> 0;
  h.state.setFlag(target, h.state.flag(source));
}
/** 00/30, 140054ce0. The byte operand is skipped without interpretation. */
export function queryLoaderResult(h: OpcodeExecution): void {
  h.skip(3);
  h.state.setVariable(0x3408 / 4, h.state.get(0x587348));
}
/** 00/3f, 140055c20. */
export function disableTextureRequests(h: OpcodeExecution): void {
  h.skip(2);
  h.state.setFlag(0x73a, 1);
  h.state.setVariable(0x3394 / 4, 0);
}
/** 00/42, 140055c60. */
export function setSceneValue(h: OpcodeExecution): void {
  h.skip(2);
  h.state.setVariable(0x4354 / 4, h.expression());
}

/** 01/27, 140051520: pause device zero only when initialized. */
export function pauseSceneMovie(h: OpcodeExecution): void {
  const s = h.state;
  if (s.get(0x81007c) !== 0) {
    h.yield();
    return;
  }
  h.skip(2);
  const paused = h.byte() !== 0;
  s.setFlag(0x71a, paused ? 1 : 0);
  if (paused) s.put(0x5a6e40, 3);
  h.movies.pause(0, paused);
}
/** 10/06, 140059880. 140010d60 returns a one-based index (zero on invalid masks). */
export function swapCharacter(h: OpcodeExecution): void {
  h.skip(2);
  const first = h.expression(),
    second = h.expression(),
    a = backgroundIndex(first) + 1,
    b = backgroundIndex(second) + 1,
    s = h.state;
  const flagA = s.flag(a + 0x969),
    flagB = s.flag(b + 0x969);
  s.setFlag(b + 0x969, flagA);
  s.setFlag(a + 0x969, flagB);
  const swap = (x: number, y: number) => {
    const value = s.variable(x);
    s.setVariable(x, s.variable(y));
    s.setVariable(y, value);
  };
  for (let i = 0; i < 40; i++) swap(a * 40 + 0x13c4 + i, b * 40 + 0x13c4 + i);
  swap(a + 0xd79, b + 0xd79);
}
/** 10/28, 14005b270. */
export function setSceneMode(h: OpcodeExecution): void {
  h.skip(2);
  const value = h.expression();
  h.state.put(0x17ac2ec, value === 4 ? (h.state.get(0x17abc00) + 1) | 0 : value);
}
/** 10/3c, 14005d6f0: native consumes both expressions only when its gate is clear. */
export function gatedExpressions(h: OpcodeExecution): void {
  if (h.state.get(0x81007c) !== 0) {
    h.yield();
    return;
  }
  h.skip(3);
  h.expression();
  h.expression();
}

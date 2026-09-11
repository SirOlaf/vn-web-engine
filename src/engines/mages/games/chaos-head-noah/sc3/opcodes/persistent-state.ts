import type {OpcodeExecution} from './types.js';

/** 14005a5d0 -> 14005ff70 -> 14005fe10. Reset memory, not filesystem files. */
export function resetPersistentState(h: OpcodeExecution): void {
  h.skip(2);
  const clear = h.byte(),
    s = h.state;
  s.settingsDefaults();
  if (!clear) return;
  s.readFlags.fill(0);
  s.zero(0x17acbd0, 200);
  s.galleryUnlocks.fill(0);
  s.auxiliary.fill(0);
  s.zero(0x873290, 0x3d5e40);
  s.zero(0xc4dc10, 0x3d5e40);
  for (let i = 0; i < 48; i++) s.put(0x179cc20 + i * 4, i);
  s.zero(0x1762020, 0xc508);
  s.put(0x20bbec, 65535);
  s.zero(0x5b09a0, 16);
  s.flags.fill(0, 100, 150);
  s.variableBytes.fill(0, 0x960, 0xfa0);
}

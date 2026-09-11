import type {NoahState} from './noah-state.js';
/** Working fields and native menu backups. The arrays deliberately remain
 * separate: page confirm/cancel copies 17 words; whole-menu operations copy 32. */
export const configFields = [
  [0x5af924, 0x17abdbc],
  [0x5afa94, 0x17acb7c],
  [0x5a9a9c, 0x17abe88],
  [0x5afac0, 0x17ac2e8],
  [0x5afa88, 0x17abdb8],
  [0x5a97d4, 0x17a0cd8],
  [0x5a9ab4, 0x17adca8],
  [0x5af944, 0x17add34],
  [0x5afa90, 0x17abc00],
  [0x5afad8, 0x17add44],
  [0x5a9a98, 0x17ac2ec],
  [0x5b09e0, 0x17add54],
  [0x5a9ac0, 0x17add3c],
  [0x5a9abc, 0x17adca4],
  [0x5afac8, 0x17abc04],
  [0x5b0980, 0x17adca0],
  [0x5b0a4c, 0x17adcac],
  [0x5a97d0, 0x17add30],
  [0x5b0984, 0x17ac370],
  [0x5afadc, 0x17acba0],
  [0x5af938, 0x17abc08],
  [0x5af93c, 0x17abdac],
  [0x5a9acc, 0x17ac318],
  [0x5a7104, 0x17a0cdc],
] as const;
export const configPageFields = [
  [0x17adca0, 0x17acba0, 0x17abc08, 0x17abdac, 0x17ac318, 0x17a0cdc, 0x17ac370, 0x17add30],
  [0x17a0cd8, 0x17adca8, 0x17abc00],
  [0x17abdbc, 0x17acb7c, 0x17abe88, 0x17abdb8, 0x17add34, 0x17abc04],
] as const;
export function configCopy(
  s: NoahState,
  commit: boolean,
  fields: readonly number[] = configFields.map((p) => p[1]),
): void {
  for (const [backup, live] of configFields)
    if (fields.includes(live)) s.put(commit ? backup : live, s.get(commit ? live : backup));
}
export function configCopyVoices(s: NoahState, commit: boolean, words: number): void {
  for (const [backup, live] of [
    [0x5a9ad0, 0x17abcd0],
    [0x5af950, 0x17abdc0],
  ])
    s.bytes(commit ? backup! : live!, words * 4).set(s.bytes(commit ? live! : backup!, words * 4));
}
export function configLanguage(s: NoahState): void {
  s.put(0x5b0440, s.get(0x1badfbc) === 1 ? 0x14020bbb8 : 0x14020d398, 8);
}
/** 140033ff0. */
export function initializeConfig(s: NoahState): void {
  configCopy(s, true);
  configCopyVoices(s, true, 32);
  if (s.get(0x17abe94) !== 0) s.put(0x20d218, 6);
  s.put(0x543837, 1, 1);
  s.put(0x5b099c, s.get(0x17a0cdc));
  s.setVariable(0x21e8 / 4, s.get(0x5b09b4));
  s.put(0x5af928, 0);
  s.flags[0x69] = s.flags[0x69]! | 128;
  for (let i = 0; i < 17; i++) s.put(0x5b0470 + i * 4, i);
  s.put(0x5a9ab0, 17);
  configLanguage(s);
}
/** Signed controller assignments, native structure +184 = serialized +74. */
export function applyConfigPadBindings(s: NoahState, configuration: Uint8Array): void {
  for (const [offset, address] of [
    [7, 0x1dd9fb6],
    [3, 0x1dd9fb2],
    [0, 0x1dd9fac],
    [1, 0x1dd9fae],
    [4, 0x1dd9fba],
    [9, 0x1dd9fc0],
    [10, 0x1dd9fc2],
    [5, 0x1dd9fb8],
    [6, 0x1dd9fb4],
    [2, 0x1dd9fb0],
  ])
    s.put(address!, (configuration[0x74 + offset!]! << 24) >> 24, 2);
}
/** 140064030: input state clear, including both 256-byte delay arrays. Gaps
 * and controller binding words immediately after the structure are preserved. */
export function clearConfigPadInput(s: NoahState): void {
  const base = 0x1dd9c90;
  for (const [offset, length] of [
    [0, 0x28],
    [0x30, 0xc],
    [0x40, 4],
    [0x48, 4],
    [0x50, 4],
    [0x58, 0x14],
    [0x74, 0x14],
    [0x90, 4],
    [0x94, 1],
    [0x98, 0x3c],
    [0xd8, 1],
    [0xdc, 0x3c],
    [0x11c, 0x200],
  ])
    s.zero(base + offset!, length!);
  s.put(base + 0x28, 0xffffffff, 8);
  s.put(base + 0xd4, 0x3f800000);
  s.put(base + 0x118, 0x3f800000);
}
export function resetConfigPage(s: NoahState, configuration: Uint8Array): void {
  const page = s.get(0x5b09b4) >>> 0;
  const defaults =
    page === 0
      ? [
          [0x17adca0, 1],
          [0x17ac370, 0],
          [0x17a0cdc, 0],
          [0x17acba0, 1],
          [0x17add30, 128],
        ]
      : page === 1
        ? [
            [0x17a0cd8, 768],
            [0x17adca8, 768],
            [0x17abc00, 0],
          ]
        : page === 2
          ? [
              [0x17abdbc, 64],
              [0x17acb7c, 64],
              [0x17abe88, 64],
              [0x17abdb8, 64],
              [0x17abc04, 0],
              [0x17add34, 1],
            ]
          : [];
  for (const [live, value] of defaults) s.put(live!, value!);
  configCopy(
    s,
    true,
    defaults.map((p) => p[0]!),
  );
  if (page === 2) {
    s.put(0x17adc9c, 64);
    s.put(0x17ac2e8, 30);
  } else if (page === 3) {
    for (let i = 0; i < 32; i++) {
      s.put(0x17abcd0 + i * 4, 128);
      s.put(0x17abdc0 + i * 4, 1);
    }
    configCopyVoices(s, true, 32);
    s.put(0x17add4c, -1);
  } else if (page === 4) {
    configuration.set([0, 1, 2, 3, 7, 6, 4, 5, 9, 10, 11], 0x74);
    applyConfigPadBindings(s, configuration);
  }
}

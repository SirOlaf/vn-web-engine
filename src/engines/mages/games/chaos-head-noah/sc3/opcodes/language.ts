import type {OpcodeExecution} from './types.js';

export type NoahLanguage = 0 | 1 | 10 | 11;

/** Native startup and 00/5e mapping: platform code to Config row value. */
export function languageSetting(language: number): number {
  switch (language) {
    case 1:
      return 1;
    case 10:
      return 3;
    case 11:
      return 2;
    default:
      return 0;
  }
}

/** Inverse of languageSetting for the persisted CONFIG.DAT field. */
export function languageCode(setting: number): NoahLanguage {
  switch (setting) {
    case 1:
      return 1;
    case 2:
      return 11;
    case 3:
      return 10;
    default:
      return 0;
  }
}

/** 140056f70. The archive selectors change only after both blocking config writes. */
export async function switchLanguage(h: OpcodeExecution): Promise<void> {
  h.skip(2);
  const language: NoahLanguage = h.expression() === 0 ? 0 : 1,
    setting = languageSetting(language),
    s = h.state;
  s.put(0x1badfbc, language);
  s.put(0x17ac318, setting);
  s.setVariable(0x34b8 / 4, setting);
  new DataView(
    h.storage.configuration.buffer,
    h.storage.configuration.byteOffset,
    h.storage.configuration.byteLength,
  ).setUint32(0x48, setting, true);
  await h.storage.writeConfiguration();
  h.setLanguage(language);
}

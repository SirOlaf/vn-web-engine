import {pop32, push32} from '../bp/state.js';
import type {AokanaNativeSlotDefinition} from './types.js';

/** DAT_1402776e8 is a DWORD override, although LANGID/Japanese detection uses its low WORD. */
export class AokanaNativeLanguage {
  value = 0;
  constructor(private readonly readUserDefaultUiLanguage: () => number) {}
  select(value: number): number {
    value >>>= 0;
    this.value = value === 0 ? this.readUserDefaultUiLanguage() & 0xffff : value;
    return this.value;
  }
}

export function createGroup81Language(
  language: AokanaNativeLanguage,
): AokanaNativeSlotDefinition[] {
  return [
    {
      primary: 0x81,
      secondary: 0x01,
      nativeAddress: 0x1400ec870,
      name: 'LanguageIsJapanese',
      execute: (h) => {
        push32(h.thread, Number((language.value & 0x3ff) === 0x11));
        return 0;
      },
    },
    {
      primary: 0x81,
      secondary: 0x02,
      nativeAddress: 0x1400ec840,
      name: 'SelectUiLanguage',
      execute: (h) => {
        push32(h.thread, language.select(pop32(h.thread)));
        return 0;
      },
    },
    {
      primary: 0x81,
      secondary: 0x03,
      nativeAddress: 0x1400ec820,
      name: 'ReadUiLanguage',
      execute: (h) => {
        push32(h.thread, language.value);
        return 0;
      },
    },
  ];
}

/** 1400eb1d0 pushes the literal one; this is an implemented constant native query. */
export const group81Constant: AokanaNativeSlotDefinition = {
  primary: 0x81,
  secondary: 0x6e,
  nativeAddress: 0x1400eb1d0,
  name: 'NativeConstantOne',
  execute: (h) => {
    push32(h.thread, 1);
    return 0;
  },
};

/** DOM facts retained with a physical key message until the GUI thread removes it. */
export interface WindowsKeyCharacterEvidence {
  readonly key: string;
  readonly composing: boolean;
  readonly control: boolean;
  readonly meta: boolean;
}

export interface WindowsTranslatedCharacter {
  readonly message: 0x102 | 0x106;
  readonly codeUnit: number;
}

/** Project-level TranslateMessage boundary; a host may implement a selected layout. */
export interface WindowsCharacterTranslationHost {
  translate(
    message: number,
    virtualKey: number,
    evidence: WindowsKeyCharacterEvidence | null,
  ): readonly WindowsTranslatedCharacter[];
}

/** Browser key values are already layout resolved. No virtual-key-to-character guess is made. */
export class BrowserWindowsCharacterTranslationHost implements WindowsCharacterTranslationHost {
  translate(
    message: number,
    _virtualKey: number,
    evidence: WindowsKeyCharacterEvidence | null,
  ): readonly WindowsTranslatedCharacter[] {
    if ((message !== 0x100 && message !== 0x104) || evidence === null || evidence.composing ||
        evidence.control || evidence.meta) return [];
    const key = evidence.key;
    const control = key === 'Enter' ? 13 : key === 'Tab' ? 9 :
      key === 'Backspace' ? 8 : key === 'Escape' ? 27 : null;
    const text = control === null ? (key.length > 0 && [...key].length === 1 ? key : '') :
      String.fromCharCode(control);
    if (text === '') return [];
    const kind = message === 0x104 ? 0x106 : 0x102;
    return Array.from({length: text.length}, (_, index) => ({
      message: kind,
      codeUnit: text.charCodeAt(index),
    }));
  }
}

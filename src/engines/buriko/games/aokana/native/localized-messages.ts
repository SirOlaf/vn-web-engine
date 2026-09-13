import type {PeResource} from '../../../../../formats/pe/resources.js';
import {decodeDsc} from '../../../../../formats/buriko/dsc.js';
import {signature} from '../../../../../formats/buriko/binary.js';
import type {AokanaBpPointer} from '../bp/memory.js';
import {AokanaNativeText, textByte} from './text.js';
import {AokanaNativeLanguage} from './group-81-language.js';
import {AokanaImportedTextMaps} from './imported-text-maps.js';
import {AokanaNamedValueMap, aokanaCompareNamedBytes} from './named-value-map.js';

interface LanguageSection {
  languages: number[];
  readonly strings: AokanaNamedValueMap;
  readonly next: LanguageSection | null;
}

const languageIdKey: AokanaBpPointer = {
  bytes: new TextEncoder().encode('languageid\0'),
  offset: 0,
};
const whitespace = (byte: number): boolean => byte === 9 || byte === 10 || byte === 13 || byte === 32;
const separator = (byte: number): boolean => byte === 9 || byte === 32 || byte === 44 || byte === 61;

/** 01df80 -> 01cd38, signed strtol(base16), over this file's ASCII language-ID fields.
 * The title's initial narrow C locale classifies TAB..CR and space as whitespace. */
function languageId(source: AokanaBpPointer): number {
  let offset = source.offset;
  const read = (): number => textByte(source.bytes, offset);
  while ((read() >= 9 && read() <= 13) || read() === 32) offset++;
  const negative = read() === 45;
  if (negative || read() === 43) offset++;
  if (read() === 48 && (textByte(source.bytes, offset + 1) | 32) === 120) offset += 2;
  let magnitude = 0n;
  for (;;) {
    const byte = read(),
      letter = byte | 32,
      digit = byte >= 48 && byte <= 57 ? byte - 48 : letter >= 97 && letter <= 122 ? letter - 87 : -1;
    if (digit < 0 || digit >= 16) break;
    magnitude = magnitude * 16n + BigInt(digit);
    offset++;
  }
  const maximum = negative ? 0x80000000n : 0x7fffffffn;
  magnitude = magnitude > maximum ? maximum : magnitude;
  return Number(BigInt.asUintN(32, negative ? -magnitude : magnitude));
}

/** FD290/FD6A0's linked localized system-message sections at2776f0. */
export class AokanaLocalizedMessages {
  private first: LanguageSection | null = null;
  constructor(
    readonly text: AokanaNativeText,
    readonly language: AokanaNativeLanguage,
    /** The actual81 D8 imported-message owner at2776e0, cleared by FCEF0 first. */
    readonly importedMessages: AokanaImportedTextMaps,
  ) {}

  /** FindResourceW(TEXT,131) over the already parsed executable resource catalog.
   * The resource language is explicit when the executable contains several language leaves. */
  loadPeResources(resources: readonly PeResource[], resourceLanguage?: number): 0 | 1 {
    const matches = resources.filter(
      (resource) => resource.type === 'TEXT' && resource.id === 131 &&
        (resourceLanguage === undefined || resource.language === (resourceLanguage & 0xffff)),
    );
    if (matches.length > 1)
      throw new Error('Aokana localized resource requires the selected Windows resource language');
    return this.load(matches[0]?.bytes ?? null);
  }

  /** FCFD0 first clears the independent imported-message map, then every localized section. */
  clear(): void {
    this.importedMessages.clear();
    for (let section = this.first; section !== null; section = section.next) section.strings.clear();
    // Do not retain a dangling native root in the browser representation.
    this.first = null;
  }

  load(stored: Uint8Array | null): 0 | 1 {
    if (stored === null) return 0;
    const decoded = signature(stored, 'DSC FORMAT 1.00\0') ? decodeDsc(stored) : stored,
      bytes = new Uint8Array(decoded.length + 1);
    bytes.set(decoded);
    this.clear();
    this.first = {languages: [], strings: new AokanaNamedValueMap(0), next: null};
    const mode = this.text.detectEncoding(bytes);
    let offset = 0;
    const advance = (): void => {
      const count = this.text.readCharacter(bytes, offset, mode).length;
      if (count === 0) throw new Error('Aokana localized text character does not advance');
      offset += count;
    };
    for (;;) {
      while (whitespace(textByte(bytes, offset))) offset++;
      if (textByte(bytes, offset) === 0) break;
      if (bytes[offset] === 47 && textByte(bytes, offset + 1) === 47) {
        offset += 2;
        while (textByte(bytes, offset) !== 0 && bytes[offset] !== 10 && bytes[offset] !== 13) advance();
        continue;
      }
      const directive = bytes[offset] === 64;
      if (directive) offset++;
      const key = {bytes, offset};
      while (!separator(textByte(bytes, offset))) {
        if (bytes[offset] === 0)
          throw new Error('Aokana localized message has no key/value separator');
        advance();
      }
      bytes[offset++] = 0;
      while (separator(textByte(bytes, offset))) offset++;
      const value = {bytes, offset};
      while (textByte(bytes, offset) !== 0 && bytes[offset] !== 10 && bytes[offset] !== 13) advance();
      if (bytes[offset] !== 0) bytes[offset++] = 0;
      if (!directive) {
        this.first.strings.insert(key, value);
        continue;
      }
      this.text.lowercase(key);
      if (aokanaCompareNamedBytes(key, languageIdKey) !== 0) continue;
      const languages: number[] = [];
      if (textByte(bytes, value.offset) !== 0) {
        let item = value.offset;
        for (;;) {
          const next = this.text.findCharacter({bytes, offset: item}, 44);
          if (next !== null) bytes[next] = 0;
          if (languages.length === 1022)
            throw new RangeError('Aokana localized language IDs exceed native scratch capacity');
          languages.push(languageId({bytes, offset: item}));
          if (next === null) break;
          item = next + 1;
          while (textByte(bytes, item) === 32 || bytes[item] === 9) item++;
        }
      }
      if (this.first.strings.readByIndex(null, 0) === 0)
        this.first = {languages: [], strings: new AokanaNamedValueMap(0), next: this.first};
      if (languages.length !== 0 && (languages.length !== 1 || languages[0] !== 0))
        this.first.languages = languages;
    }
    this.language.select(0);
    return 1;
  }

  /** FD6A0 reads the language once, then tries newer matching sections before older ones. */
  lookup(key: AokanaBpPointer): AokanaBpPointer | null {
    const language = this.language.value >>> 0;
    for (let section = this.first; section !== null; section = section.next) {
      if (section.languages.length === 0) {
        const result = section.strings.findValue(key);
        if (result !== null) return result;
      } else {
        for (const selected of section.languages) {
          if (selected !== language) continue;
          const result = section.strings.findValue(key);
          if (result !== null) return result;
        }
      }
    }
    return null;
  }
}

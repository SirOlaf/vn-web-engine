import {artemisRevision} from './revision.js';

export interface ArtemisTextBlockFlagState {
  readonly head: ReadonlySet<string>;
  readonly foot: ReadonlySet<string>;
  readonly indentPairs: ReadonlyMap<string, string>;
  readonly indentClosing?: string;
  /** Native4c1 suppresses prohibition on the first block after explicit newline. */
  readonly afterExplicitNewline: boolean;
}
export interface ArtemisTextBlockFlags {
  readonly bits: number;
  readonly headProhibited: boolean;
  readonly footProhibited: boolean;
  readonly opensIndent: boolean;
  readonly closesIndent: boolean;
}
/** 1971e0 block98 flags. Only a one-character main stream is classified; neither
 * the first/last character of a word nor ruby text contributes these flags.
 * The owner resolves encoding defaults and retains the actual indent stack.
 */
export function artemisUtf8TextBlockFlags(
  hash: string,
  mainText: string,
  state: ArtemisTextBlockFlagState,
): ArtemisTextBlockFlags {
  artemisRevision(hash);
  mainText = mainText.split('\0', 1)[0]!;
  if (
    new TextDecoder('utf-8', {ignoreBOM: true}).decode(new TextEncoder().encode(mainText)) !==
    mainText
  )
    throw Error('Unsupported Artemis block flag UTF-8');
  let bits = 0;
  if (Array.from(mainText).length === 1) {
    if (!state.afterExplicitNewline) {
      if (state.head.has(mainText)) bits |= 1;
      if (state.foot.has(mainText)) bits |= 2;
    }
    if (state.indentPairs.has(mainText)) bits |= 4;
    else if (state.indentClosing === mainText) bits |= 8;
  }
  return Object.freeze({
    bits,
    headProhibited: !!(bits & 1),
    footProhibited: !!(bits & 2),
    opensIndent: !!(bits & 4),
    closesIndent: !!(bits & 8),
  });
}

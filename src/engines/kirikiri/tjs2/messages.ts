import {parsePeResources} from '../../../formats/pe/resources.js';

/**
 * TJS2 compiler messages, by their native names. The core loads them from its RT_STRING
 * resources (krkrz `msg/win32/MsgLoad.cpp`: `TJSInternalError` is string 10000, the others
 * follow in declaration order) in the user's UI language.
 */
export const TJS2_MESSAGE_IDS = {
  TJSInternalError: 10000,
  TJSWarning: 10001,
  TJSWarnEvalOperator: 10002,
  TJSSubstitutionInBooleanContext: 10007,
  TJSCannotModifyLHS: 10008,
  TJSCannotGetResult: 10010,
  TJSMisplacedBreakContinue: 10022,
  TJSMisplacedCase: 10023,
  TJSStringParseError: 10025,
  TJSNumberError: 10026,
  TJSUnclosedComment: 10027,
  TJSInvalidChar: 10028,
  TJSSyntaxError: 10030,
  TJSPPError: 10031,
  TJSCannotGetSuper: 10032,
} as const;

export type Tjs2MessageName = keyof typeof TJS2_MESSAGE_IDS;
export type Tjs2Messages = Readonly<Record<Tjs2MessageName, string>>;

const LANG_ENGLISH = 0x09;

/** Messages of `nekopara_vol1.exe` (TJS 2.4.28), LANG_ENGLISH and ja-JP string tables. */
export const TJS2_DEFAULT_MESSAGES: ReadonlyMap<number, Tjs2Messages> = new Map([
  [
    LANG_ENGLISH,
    {
      TJSInternalError: 'Internal error',
      TJSWarning: 'Warning: ',
      TJSWarnEvalOperator:
        'Non-global post-! operator is used (note that the post-! operator behavior is changed on TJS2 version 2.4.1)',
      TJSSubstitutionInBooleanContext:
        "Substitution in boolean context (use form of '(A=B)!=0' to compare to zero)",
      TJSCannotModifyLHS: 'This expression cannot be used as a lvalue',
      TJSCannotGetResult: 'Cannot get the value of this expression',
      TJSMisplacedBreakContinue: 'Cannot place "break" or "continue" here',
      TJSMisplacedCase: 'Cannot place "case" here',
      TJSStringParseError: 'Un-terminated string/regexp/octet literal',
      TJSNumberError: 'Cannot be parsed as a number',
      TJSUnclosedComment: 'Un-terminated comment',
      TJSInvalidChar: "Invalid character '%1'",
      TJSSyntaxError: 'Syntax error (%1)',
      TJSPPError: 'Error in conditional compiling expression',
      TJSCannotGetSuper: 'Super class does not exist or cannot specify the super class',
    },
  ],
  [
    0x0411,
    {
      TJSInternalError: '内部エラーが発生しました',
      TJSWarning: '警告: ',
      TJSWarnEvalOperator:
        'グローバルでない場所で後置 ! 演算子が使われています(この演算子の挙動はTJS2 version 2.4.1 で変わりましたのでご注意ください)',
      TJSSubstitutionInBooleanContext:
        '論理値が求められている場所で = 演算子が使用されています(== 演算子の間違いですか？代入した上でゼロと値を比較したい場合は、(A=B) != 0 の形式を使うことをお勧めします)',
      TJSCannotModifyLHS: '不正な代入か不正な式の操作です',
      TJSCannotGetResult: 'この式からは値を得ることができません',
      TJSMisplacedBreakContinue: '"break" または "continue" はここに書くことはできません',
      TJSMisplacedCase: '"case" はここに書くことはできません',
      TJSStringParseError:
        '文字列定数/正規表現/オクテット即値が終わらないままスクリプトの終端に達しました',
      TJSNumberError: '数値として解釈できません',
      TJSUnclosedComment: 'コメントが終わらないままスクリプトの終端に達しました',
      TJSInvalidChar: "不正な文字です : '%1'",
      TJSSyntaxError: '文法エラーです(%1)',
      TJSPPError: '条件コンパイル式にエラーがあります',
      TJSCannotGetSuper: 'スーパークラスが存在しないかスーパークラスを特定できません',
    },
  ],
]);

/**
 * Picks the string-table language the way resource loading does for a UI language: the
 * exact LANGID, then the same primary language, then English, then the first available.
 */
function pickLanguage(available: Iterable<number>, uiLanguage: number): number | undefined {
  const langs = [...available];
  return (
    langs.find((l) => l === uiLanguage) ??
    langs.find((l) => (l & 0x3ff) === (uiLanguage & 0x3ff)) ??
    langs.find((l) => (l & 0x3ff) === LANG_ENGLISH) ??
    langs[0]
  );
}

/** Built-in messages for a UI language (LANGID). */
export function defaultTjs2Messages(uiLanguage: number): Tjs2Messages {
  return TJS2_DEFAULT_MESSAGES.get(pickLanguage(TJS2_DEFAULT_MESSAGES.keys(), uiLanguage)!)!;
}

/**
 * Reads the messages from the core executable's string tables for a UI language. Strings the
 * executable does not contain keep the built-in text.
 */
export function readTjs2Messages(executable: Uint8Array, uiLanguage: number): Tjs2Messages {
  const byLanguage = new Map<number, Map<number, string>>();
  for (const block of parsePeResources(executable, [6])) {
    if (typeof block.id !== 'number') continue;
    let table = byLanguage.get(block.language);
    if (!table) byLanguage.set(block.language, (table = new Map()));
    const b = block.bytes;
    let o = 0;
    for (let i = 0; i < 16 && o + 2 <= b.length; i++) {
      const n = b[o]! | (b[o + 1]! << 8);
      o += 2;
      if (n) table.set((block.id - 1) * 16 + i, utf16(b.subarray(o, o + n * 2)));
      o += n * 2;
    }
  }
  const out: Record<string, string> = {...defaultTjs2Messages(uiLanguage)};
  const language = pickLanguage(byLanguage.keys(), uiLanguage);
  const table = language === undefined ? undefined : byLanguage.get(language);
  if (table)
    for (const [name, id] of Object.entries(TJS2_MESSAGE_IDS)) {
      const text = table.get(id);
      if (text !== undefined) out[name] = text;
    }
  return out as Tjs2Messages;
}

function utf16(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i + 1 < bytes.length; i += 2)
    s += String.fromCharCode(bytes[i]! | (bytes[i + 1]! << 8));
  return s;
}

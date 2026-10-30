import type {Tjs2MessageName} from './messages.js';
import {
  LiteralError,
  escapeC,
  isTjsAlpha,
  isTjsDigit,
  isTjsSpace,
  parseNumber,
  scanOctet,
  scanRegExp,
  scanString,
  skipComment,
} from './literals.js';
import {
  PreprocessorError,
  evaluatePreprocessorExpression,
  type PreprocessorValues,
} from './preprocessor.js';
import {RESERVED_WORDS, Tok} from './tokens.js';

export type Constant =
  | {readonly type: 'int'; readonly value: bigint}
  | {readonly type: 'real'; readonly value: number}
  | {readonly type: 'string'; readonly value: string}
  | {readonly type: 'octet'; readonly value: Uint8Array}
  | {readonly type: 'null'};

export interface Token {
  readonly type: number;
  /** Offset of the token in the (line-break normalised) text. */
  readonly start: number;
  readonly end: number;
  /** Value of a `ConstVal` token. */
  readonly value?: Constant;
  /** Spelling of a word (identifier or reserved word); members after `.` accept any word. */
  readonly word?: string;
  /** Pattern and flags of a `RegExp` token. */
  readonly regexp?: {readonly pattern: string; readonly flags: string};
  /** Lexer state right after this token, for rescanning a `/` as a regular expression. */
  readonly state?: LexerState;
}

/**
 * A lexical error: the native message name, where the native lexer stood when it raised it,
 * and the `%1` argument of the message.
 */
export class LexError extends Error {
  constructor(
    readonly code: Tjs2MessageName,
    readonly offset: number,
    readonly argument?: string,
  ) {
    super(code);
    this.name = 'LexError';
  }
}

export interface LexerOptions {
  /** Expression mode (`Scripts.eval`, `evalStorage`): a `;` is appended to the text. */
  readonly expression?: boolean;
  /** In expression mode, a `return` token comes first so the value becomes the result. */
  readonly resultNeeded?: boolean;
  /**
   * `tjsEnableDicFuncQuickHack`: an expression starting with `[` or `%[` is wrapped in a
   * function. A build option of the core (byte `'0'`/`'1'` in a marker string).
   */
  readonly dicFuncQuickHack?: boolean;
}

/** `@"…"` state (`tEmbeddableExpressionData`). */
interface Embed {
  state: 'start' | 'string' | 'expression';
  readonly waitingNestLevel: number;
  readonly delimiter: string;
  needPlus: boolean;
  waitingToken: number;
}

interface LexerState {
  readonly pos: number;
  readonly nestLevel: number;
  readonly embeds: readonly Embed[];
}

type Pending = {type: number; value?: Constant; start: number};

/**
 * TJS2 lexer (`tTJSLexicalAnalyzer`): tokens, the `@set`/`@if`/`@endif` preprocessor, and the
 * token rewriting of embeddable strings. `@"a${x}b"` yields the tokens of
 * `("a" + string(x) + "b")`, exactly as the native lexer queues them.
 *
 * The text must use LF line breaks (`normalizeLineBreaks`).
 */
export class Lexer {
  readonly text: string;
  #pos = 0;
  #nestLevel = 0;
  #ifLevel = 0;
  #embeds: Embed[] = [];
  readonly #queue: Pending[] = [];
  #first = true;
  #prevToken = -1;
  readonly #dicFunc: boolean;
  /** Set when the text used `@set` or `@if` (`NotifyUsingPreProcessor`). */
  usedPreprocessor = false;

  constructor(
    text: string,
    readonly pp: PreprocessorValues,
    readonly options: LexerOptions = {},
  ) {
    if (options.expression) text += ';';
    else if (text.startsWith('#!')) text = '//' + text.slice(2);
    this.text = text;
    this.#dicFunc =
      !!options.dicFuncQuickHack &&
      !!options.expression &&
      (text[0] === '[' || text.startsWith('%['));
  }

  next(): Token {
    if (this.#first) {
      this.#first = false;
      if (this.options.expression && this.options.resultNeeded) return this.#make(Tok.Return, 0, 0);
    }
    for (;;) {
      const queued = this.#queue.shift();
      if (queued) {
        this.#prevToken = queued.type;
        return {
          type: queued.type,
          start: queued.start,
          end: queued.start,
          value: queued.value,
          state: this.#state(),
        };
      }
      const token = this.#produce();
      if (token) {
        if (token.type === Tok.Eof && this.#ifLevel !== 0)
          throw new LexError('TJSPPError', this.#pos);
        this.#prevToken = token.type;
        return token;
      }
    }
  }

  /**
   * Re-reads the `/` or `/=` token `slash` as the start of a regular expression
   * (`SetStartOfRegExp`). Tokens read after `slash` are discarded.
   */
  rescanRegExp(slash: Token): Token {
    const state = slash.state;
    if (!state) throw new Error('Token cannot be rescanned');
    this.#nestLevel = state.nestLevel;
    this.#embeds = state.embeds.map((e) => ({...e}));
    this.#queue.length = 0;
    try {
      const r = scanRegExp(this.text, slash.start + 1);
      this.#pos = r.end;
      return {
        type: Tok.RegExp,
        start: slash.start,
        end: r.end,
        regexp: {pattern: r.pattern, flags: r.flags},
        state: this.#state(),
      };
    } catch (e) {
      throw this.#literalError(e);
    }
  }

  /** One step of `GetNext`; returns null when only queued tokens were produced. */
  #produce(): Token | null {
    const embed = this.#embeds.at(-1);
    let token: Token | null;
    if (!embed) {
      this.#pos = skipSpaceAt(this.text, this.#pos);
      token = this.#token();
      if (token && this.#dicFunc && this.#dicFuncHack(token)) return null;
      return token;
    }
    switch (embed.state) {
      case 'start':
        this.#queue.push({type: Tok.LParen, start: this.#pos});
        embed.state = 'string';
        return null;
      case 'string': {
        const at = this.#pos;
        let r;
        try {
          r = scanString(this.text, this.#pos, embed.delimiter, true);
        } catch (e) {
          throw this.#literalError(e);
        }
        this.#pos = r.end;
        const str: Constant = {type: 'string', value: r.value};
        if (r.stop === 'delimiter') {
          if (r.value && embed.needPlus) this.#queue.push({type: Tok.Plus, start: at});
          if (r.value || !embed.needPlus)
            this.#queue.push({type: Tok.ConstVal, value: str, start: at});
          this.#queue.push({type: Tok.RParen, start: this.#pos});
          this.#embeds.pop();
          return null;
        }
        if (r.value) {
          if (embed.needPlus) this.#queue.push({type: Tok.Plus, start: at});
          this.#queue.push({type: Tok.ConstVal, value: str, start: at});
          embed.needPlus = true;
        }
        if (embed.needPlus) this.#queue.push({type: Tok.Plus, start: this.#pos});
        this.#queue.push(
          {type: Tok.String, start: this.#pos},
          {type: Tok.LParen, start: this.#pos},
        );
        embed.state = 'expression';
        if (r.stop === 'ampersand') embed.waitingToken = Tok.Semicolon;
        else {
          embed.waitingToken = Tok.RBrace;
          this.#nestLevel++;
        }
        return null;
      }
      case 'expression':
        this.#pos = skipSpaceAt(this.text, this.#pos);
        token = this.#token();
        if (
          token &&
          token.type === embed.waitingToken &&
          this.#nestLevel === embed.waitingNestLevel
        ) {
          this.#queue.push({type: Tok.RParen, start: token.start});
          embed.needPlus = true;
          embed.state = 'string';
          return null;
        }
        return token;
    }
  }

  #dicFuncHack(token: Token): boolean {
    const at = token.start;
    const push = (...types: number[]) => {
      for (const type of types) this.#queue.push({type, start: at});
    };
    if (token.type === Tok.Percent) push(Tok.Function, Tok.LBrace, Tok.Return, Tok.Percent);
    else if (token.type === Tok.LBracket && this.#prevToken !== Tok.Percent)
      push(Tok.Function, Tok.LBrace, Tok.Return, Tok.LBracket);
    else if (token.type === Tok.RBracket)
      push(Tok.RBracket, Tok.Semicolon, Tok.RBrace, Tok.LParen, Tok.RParen);
    else return false;
    return true;
  }

  #state(): LexerState {
    return {
      pos: this.#pos,
      nestLevel: this.#nestLevel,
      embeds: this.#embeds.length ? this.#embeds.map((e) => ({...e})) : NO_EMBEDS,
    };
  }

  #make(
    type: number,
    start: number,
    end: number,
    extra?: {value?: Constant; word?: string},
  ): Token {
    return {
      type,
      start,
      end,
      ...extra,
      state: type === Tok.Slash || type === Tok.SlashEqual ? this.#state() : undefined,
    };
  }

  /** `GetToken`; null when the token starts an embeddable string (`@"`). */
  #token(): Token | null {
    const t = this.text;
    for (;;) {
      const start = this.#pos;
      if (start >= t.length) return this.#make(Tok.Eof, start, start);
      const ch = t[start]!;
      const op = (s: string, type: number): Token | null => {
        if (!t.startsWith(s, start)) return null;
        this.#pos = start + s.length;
        return this.#make(type, start, this.#pos);
      };
      const one = (type: number): Token => {
        this.#pos = start + 1;
        return this.#make(type, start, this.#pos);
      };
      switch (ch) {
        case '>':
          return (
            op('>>>=', Tok.RBitShiftEqual) ??
            op('>>>', Tok.RBitShift) ??
            op('>>=', Tok.RArithShiftEqual) ??
            op('>>', Tok.RArithShift) ??
            op('>=', Tok.GtOrEqual) ??
            one(Tok.Gt)
          );
        case '<': {
          const r =
            op('<<=', Tok.LArithShiftEqual) ??
            op('<->', Tok.Swap) ??
            op('<=', Tok.LtOrEqual) ??
            op('<<', Tok.LArithShift);
          if (r) return r;
          if (t[start + 1] === '%') {
            try {
              const o = scanOctet(t, start);
              this.#pos = o.end;
              return this.#make(Tok.ConstVal, start, o.end, {
                value: {type: 'octet', value: o.value},
              });
            } catch (e) {
              throw this.#literalError(e);
            }
          }
          return one(Tok.Lt);
        }
        case '=':
          return (
            op('===', Tok.DiscEqual) ??
            op('==', Tok.EqualEqual) ??
            op('=>', Tok.Comma) ??
            one(Tok.Equal)
          );
        case '!':
          return op('!==', Tok.DiscNotEqual) ?? op('!=', Tok.NotEqual) ?? one(Tok.Exclamation);
        case '&':
          return (
            op('&&=', Tok.LogicalAndEqual) ??
            op('&&', Tok.LogicalAnd) ??
            op('&=', Tok.AmpersandEqual) ??
            one(Tok.Ampersand)
          );
        case '|':
          return (
            op('||=', Tok.LogicalOrEqual) ??
            op('||', Tok.LogicalOr) ??
            op('|=', Tok.VertLineEqual) ??
            one(Tok.VertLine)
          );
        case '.':
          if (isTjsDigit(t.charCodeAt(start + 1))) return this.#number(start);
          return op('...', Tok.Omit) ?? one(Tok.Dot);
        case '+':
          return op('++', Tok.Increment) ?? op('+=', Tok.PlusEqual) ?? one(Tok.Plus);
        case '-':
          return op('-=', Tok.MinusEqual) ?? op('--', Tok.Decrement) ?? one(Tok.Minus);
        case '*':
          return op('*=', Tok.AsteriskEqual) ?? one(Tok.Asterisk);
        case '/': {
          let skipped: number;
          try {
            skipped = skipComment(t, start);
          } catch (e) {
            throw this.#literalError(e);
          }
          if (skipped >= 0) {
            this.#pos = skipped;
            continue;
          }
          return op('/=', Tok.SlashEqual) ?? one(Tok.Slash);
        }
        case '\\':
          return op('\\=', Tok.BackslashEqual) ?? one(Tok.Backslash);
        case '%':
          return op('%=', Tok.PercentEqual) ?? one(Tok.Percent);
        case '^':
          return op('^=', Tok.ChevronEqual) ?? one(Tok.Chevron);
        case '[':
          this.#nestLevel++;
          return one(Tok.LBracket);
        case ']':
          this.#nestLevel--;
          return one(Tok.RBracket);
        case '(':
          this.#nestLevel++;
          return one(Tok.LParen);
        case ')':
          this.#nestLevel--;
          return one(Tok.RParen);
        case '{':
          this.#nestLevel++;
          return one(Tok.LBrace);
        case '}':
          this.#nestLevel--;
          return one(Tok.RBrace);
        case '~':
          return one(Tok.Tilde);
        case '?':
          return one(Tok.Question);
        case ':':
          return one(Tok.Colon);
        case ',':
          return one(Tok.Comma);
        case ';':
          return one(Tok.Semicolon);
        case '#':
          return one(Tok.Sharp);
        case '$':
          return one(Tok.Dollar);
        case "'":
        case '"': {
          let r;
          try {
            r = scanString(t, start + 1, ch, false);
          } catch (e) {
            throw this.#literalError(e);
          }
          this.#pos = r.end;
          return this.#make(Tok.ConstVal, start, r.end, {value: {type: 'string', value: r.value}});
        }
        case '@': {
          const q = skipSpaceAt(t, start + 1);
          if (q < t.length && (t[q] === "'" || t[q] === '"')) {
            this.#embeds.push({
              state: 'start',
              waitingNestLevel: this.#nestLevel,
              delimiter: t[q]!,
              needPlus: false,
              waitingToken: 0,
            });
            this.#pos = q + 1;
            return null;
          }
          if (q >= t.length) return this.#make(Tok.Eof, start, start);
          const r = this.#preprocessor(start);
          if (r === 'continue') continue;
          if (r === 'ended') return this.#make(Tok.Eof, this.#pos, this.#pos);
          break;
        }
      }
      if (isTjsDigit(t.charCodeAt(start))) return this.#number(start);
      return this.#word(start);
    }
  }

  #number(start: number): Token {
    const r = parseNumber(this.text, start);
    if (!r) throw new LexError('TJSNumberError', start);
    this.#pos = r.end;
    return this.#make(Tok.ConstVal, start, r.end, {value: r.value});
  }

  #word(start: number): Token {
    const t = this.text;
    const c = t.charCodeAt(start);
    if (!isTjsAlpha(c) && c !== 0x5f)
      throw new LexError('TJSInvalidChar', start, escapeC(t[start]!));
    let i = start;
    while (i < t.length) {
      const d = t.charCodeAt(i);
      if (isTjsDigit(d) || isTjsAlpha(d) || d === 0x5f || d > 0x100) i++;
      else break;
    }
    this.#pos = i;
    const word = t.slice(start, i);
    const reserved = RESERVED_WORDS.get(word);
    if (reserved !== undefined) return this.#make(reserved, start, i, {word});
    switch (word) {
      case 'false':
        return this.#make(Tok.ConstVal, start, i, {word, value: {type: 'int', value: 0n}});
      case 'true':
        return this.#make(Tok.ConstVal, start, i, {word, value: {type: 'int', value: 1n}});
      case 'null':
        return this.#make(Tok.ConstVal, start, i, {word, value: {type: 'null'}});
      case 'NaN':
        return this.#make(Tok.ConstVal, start, i, {word, value: {type: 'real', value: NaN}});
      case 'Infinity':
        return this.#make(Tok.ConstVal, start, i, {word, value: {type: 'real', value: Infinity}});
    }
    return this.#make(Tok.Symbol, start, i, {word});
  }

  /**
   * `ProcessPPStatement` at `@`: `@set (…)`, `@if (…)`, `@endif`. Returns 'none' when the text
   * is not a preprocessor statement.
   */
  #preprocessor(at: number): 'continue' | 'ended' | 'none' {
    const t = this.text;
    let i = at + 1;
    const ppError = (): never => {
      throw new LexError('TJSPPError', i);
    };
    const condition = (): number => {
      i = skipSpaceAt(t, i);
      if (i >= t.length || t[i] !== '(') ppError();
      i++;
      const s = i;
      let level = 0;
      while (i < t.length && (level || t[i] !== ')')) {
        if (t[i] === '(') level++;
        else if (t[i] === ')') level--;
        i++;
      }
      const e = i;
      i++;
      try {
        return evaluatePreprocessorExpression(t.slice(s, e), this.pp);
      } catch (err) {
        if (err instanceof PreprocessorError) ppError();
        throw err;
      }
    };
    const resume = (): 'continue' | 'ended' => {
      this.#pos = skipSpaceAt(t, i);
      return this.#pos >= t.length ? 'ended' : 'continue';
    };
    if (t.startsWith('set', i)) {
      this.usedPreprocessor = true;
      i += 3;
      condition();
      return resume();
    }
    if (t.startsWith('if', i)) {
      this.usedPreprocessor = true;
      i += 2;
      if (!condition()) {
        this.#pos = i;
        return this.#skipUntilEndif();
      }
      this.#ifLevel++;
      return resume();
    }
    if (t.startsWith('endif', i)) {
      i += 5;
      if (--this.#ifLevel < 0) ppError();
      return resume();
    }
    return 'none';
  }

  /** `SkipUntil_endif`: skips text, honouring comments and nested `@if`, not strings. */
  #skipUntilEndif(): 'continue' | 'ended' {
    const t = this.text;
    const outer = this.#ifLevel;
    this.#ifLevel++;
    let i = this.#pos;
    const ppError = (): never => {
      throw new LexError('TJSPPError', i);
    };
    for (;;) {
      if (i >= t.length) ppError();
      if (t[i] === '/') {
        let skipped: number;
        try {
          skipped = skipComment(t, i);
        } catch (e) {
          throw this.#literalError(e);
        }
        if (skipped >= t.length) ppError();
        i = skipped >= 0 ? skipped : i + 1;
      } else if (t[i] === '@') {
        i++;
        let parens = false;
        if (t.startsWith('if', i)) {
          this.#ifLevel++;
          i += 2;
          parens = true;
        } else if (t.startsWith('set', i)) {
          i += 3;
          parens = true;
        } else if (t.startsWith('endif', i)) {
          i += 5;
          this.#ifLevel--;
          if (this.#ifLevel === outer) {
            this.#pos = skipSpaceAt(t, i);
            return this.#pos >= t.length ? 'ended' : 'continue';
          }
        }
        if (parens) {
          i = skipSpaceAt(t, i);
          if (i >= t.length || t[i] !== '(') ppError();
          i++;
          let level = 0;
          while (i < t.length && (level || t[i] !== ')')) {
            if (t[i] === '(') level++;
            else if (t[i] === ')') level--;
            i++;
          }
          if (i >= t.length) ppError();
          i++;
          if (i >= t.length) ppError();
        }
      } else {
        i++;
      }
    }
  }

  #literalError(e: unknown): unknown {
    return e instanceof LiteralError ? new LexError(e.code, e.offset) : e;
  }
}

const NO_EMBEDS: readonly Embed[] = [];

function skipSpaceAt(text: string, i: number): number {
  while (i < text.length && isTjsSpace(text.charCodeAt(i))) i++;
  return i;
}

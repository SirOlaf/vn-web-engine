import {Diagnostics, type Diagnostic} from '../../../compiler/diagnostics.js';
import {NifBuffer} from '../../../compiler/nif/buffer.js';
import {NifPool} from '../../../compiler/nif/pool.js';
import {SourceText, normalizeLineBreaks} from '../../../compiler/source.js';
import {TJS2_TAGS} from './dialect.js';
import {Lexer} from './lexer.js';
import {defaultTjs2Messages, type Tjs2MessageName, type Tjs2Messages} from './messages.js';
import {Parser, Tjs2SyntaxError, type CodegenPoints} from './parser.js';
import {PreprocessorValues, tjsVersionHex} from './preprocessor.js';
import {analyze} from './sema.js';
import type {CodeBlock} from './code-block.js';
import {generateCode} from './codegen.js';
import {lowerScriptBlock} from './lower.js';

/** One unit of compilation (`tTJSScriptBlock`): a script text with its name. */
export interface ScriptBlockSource {
  readonly text: string;
  /** Storage name, used for positions and messages; empty for unnamed blocks. */
  readonly name: string;
  /** Line number of the first line minus one (`SetName(name, lineofs)`). */
  readonly lineOffset?: number;
  /** `expression` compiles as `Scripts.eval` does: a `;` is appended. */
  readonly mode: 'statements' | 'expression';
  /** Expression mode only: the value of the expression is the result (`return` is prepended). */
  readonly resultNeeded?: boolean;
}

export interface Tjs2CompilerOptions {
  /** Engine-wide preprocessor values; `@set` changes them. */
  readonly preprocessor: PreprocessorValues;
  /** `tjsEnableDicFuncQuickHack` of the core build. */
  readonly dicFuncQuickHack?: boolean;
  /** Message texts in the user's language; English by default. */
  readonly messages?: Tjs2Messages;
  /** `-unaryaster=compat` (`TJSUnaryAsteriskIgnoresPropAccess`). */
  readonly unaryAsteriskIgnoresPropAccess?: boolean;
  /** `-evalcontext=global` (`TJSEvalOperatorIsOnGlobal`); also enables its warning. */
  readonly evalOperatorIsOnGlobal?: boolean;
  /** Pool shared with other trees of the same engine; a new one by default. */
  readonly pool?: NifPool;
}

/** Preprocessor values the core defines before the first script (`version`, `kirikiriz`). */
export function corePreprocessorValues(
  version: readonly [number, number, number],
  extra: Iterable<readonly [string, number]> = [],
): PreprocessorValues {
  const values = new PreprocessorValues([['version', tjsVersionHex(...version)]]);
  for (const [name, value] of extra) values.set(name, value);
  return values;
}

/** A report before conversion to a `Diagnostic`. */
interface Report {
  readonly severity: 'error' | 'warning';
  readonly code: Tjs2MessageName;
  readonly offset: number;
  /** Lexer offset when the native compiler made the report; reports are made in this order. */
  readonly order: number;
  readonly argument?: string;
}

export interface ParsedScriptBlock {
  readonly source: SourceText;
  /**
   * Parsed-stage tree, `(stmts …)` at `root`. After an error it holds what the native compiler
   * had compiled when it stopped (see `complete`).
   */
  readonly tree: NifBuffer;
  readonly root: number;
  /** False when the parser stopped at an error. */
  readonly complete: boolean;
  readonly diagnostics: Diagnostics;
  readonly usedPreprocessor: boolean;
  /** Where the native generator compiles each unit; used by the analysis. */
  readonly points: CodegenPoints;
  /** Loops cut off by the error, whose step was never compiled. */
  readonly truncatedLoops: ReadonlySet<number>;
}

/** Parses a script block; parse errors are in `diagnostics`. */
export function parseScriptBlock(
  input: ScriptBlockSource,
  options: Tjs2CompilerOptions,
): ParsedScriptBlock {
  const parsed = parse(input, options);
  const diagnostics = new Diagnostics();
  for (const r of parsed.reports)
    diagnostics.report(toDiagnostic(r, parsed.source, input, options));
  return {...parsed, diagnostics};
}

function parse(input: ScriptBlockSource, options: Tjs2CompilerOptions) {
  const text = normalizeLineBreaks(input.text);
  const source = new SourceText(input.name, text, input.lineOffset ?? 0);
  const pool = options.pool ?? new NifPool();
  const tree = new NifBuffer(pool, TJS2_TAGS, Math.max(64, text.length >> 1));
  const lexer = new Lexer(text, options.preprocessor, {
    expression: input.mode === 'expression',
    resultNeeded: input.mode === 'expression' && !!input.resultNeeded,
    dicFuncQuickHack: options.dicFuncQuickHack,
  });
  const file = pool.file(input.name || '(no-named script block)');
  const reports: Report[] = [];
  let truncatedLoops: ReadonlySet<number> = new Set();
  let complete = true;
  let parser: Parser | null = null;
  try {
    parser = new Parser(lexer, tree, source, file);
    parser.parseProgram();
  } catch (e) {
    if (!(e instanceof Tjs2SyntaxError)) throw e;
    complete = false;
    const order = e.offset;
    reports.push({severity: 'error', code: e.code, offset: e.offset, order, argument: e.argument});
    // After a lexical error the lexer returns end of script, which bison rejects unless a
    // statement may end there.
    if (e.code !== 'TJSSyntaxError' && !(parser?.atStatementBoundary() ?? true))
      reports.push({
        severity: 'error',
        code: 'TJSSyntaxError',
        offset: e.offset,
        order,
        argument: 'syntax error',
      });
    if (parser) truncatedLoops = parser.recover();
    else tree.close(tree.open(TJS2_TAGS.id.stmts));
  }
  return {
    source,
    tree,
    root: 0,
    complete,
    reports,
    usedPreprocessor: lexer.usedPreprocessor,
    points: parser?.points ?? {units: new Map(), assignments: new Map()},
    truncatedLoops,
  };
}

export interface CompiledScriptBlock extends ParsedScriptBlock {
  /** Analysed-stage tree, `(script …)` at `analyzedRoot`; absent when there are errors. */
  readonly analyzed: NifBuffer | null;
  readonly analyzedRoot: number;
}

/**
 * Parses and analyses a script block. The result is usable only if `diagnostics.errorCount`
 * is 0. Diagnostics are those the native compiler reports, in its order: errors from code
 * compiled before a syntax error come before it. The first error is the message of the
 * exception that `Scripts.exec` and friends throw.
 */
export function compileScriptBlock(
  input: ScriptBlockSource,
  options: Tjs2CompilerOptions,
): CompiledScriptBlock {
  const parsed = parse(input, options);
  const analyzed = analyze(parsed.tree, parsed.root, {
    points: parsed.points,
    truncatedLoops: parsed.truncatedLoops,
    unaryAsteriskIgnoresPropAccess: options.unaryAsteriskIgnoresPropAccess,
    evalOperatorIsOnGlobal: options.evalOperatorIsOnGlobal,
  });
  // Parse errors end the compilation, so they follow every report made at the same offset.
  const reports = [...analyzed.diagnostics, ...parsed.reports]
    .map((r, i) => ({r, i, last: i >= analyzed.diagnostics.length}))
    .sort((a, b) => a.r.order - b.r.order || Number(a.last) - Number(b.last) || a.i - b.i)
    .map((x) => x.r);
  const diagnostics = new Diagnostics();
  for (const r of reports) diagnostics.report(toDiagnostic(r, parsed.source, input, options));
  const usable = parsed.complete && diagnostics.errorCount === 0;
  return {
    ...parsed,
    diagnostics,
    analyzed: usable ? analyzed.tree : null,
    analyzedRoot: usable ? analyzed.root : -1,
  };
}

function toDiagnostic(
  r: Report,
  source: SourceText,
  input: ScriptBlockSource,
  options: Tjs2CompilerOptions,
): Diagnostic {
  const messages = options.messages ?? defaultTjs2Messages(0x0409);
  // `SrcPosToLine` knows the lines that have text or end in a line break, so offsets at or past
  // the end (also the `;` of expression mode) are on the last of them.
  const text = source.text;
  let offset = Math.min(r.offset, text.length);
  if (offset === text.length && text.endsWith('\n')) offset--;
  return {
    severity: r.severity,
    code: r.code,
    message: messages[r.code].replace('%1', r.argument ?? ''),
    file: input.name,
    line: source.line(offset),
    column: source.column(offset),
  };
}

/** The line the native compiler writes to the console for a diagnostic. */
export function tjs2ConsoleLine(
  d: Diagnostic,
  messages: Tjs2Messages = defaultTjs2Messages(0x0409),
): string {
  return d.severity === 'warning'
    ? `${messages.TJSWarning}${d.message} at ${d.file} line ${d.line}`
    : `${d.message} at line ${d.line}`;
}

export interface GeneratedScriptBlock extends CompiledScriptBlock {
  /** The lowered stage (`lower.ts`), `(module …)` at `loweredRoot`; absent when there are errors. */
  readonly lowered: NifBuffer | null;
  readonly loweredRoot: number;
  /** The VM code of every context; absent when there are errors. */
  readonly code: CodeBlock | null;
}

/**
 * Compiles a script block to VM code: parse, analysis, lowering (`lower.ts`) and code
 * generation (`codegen.ts`). Diagnostics are those of `compileScriptBlock`; code is produced
 * only when there are no errors.
 */
export function generateScriptBlock(
  input: ScriptBlockSource,
  options: Tjs2CompilerOptions,
): GeneratedScriptBlock {
  const compiled = compileScriptBlock(input, options);
  if (!compiled.analyzed) return {...compiled, lowered: null, loweredRoot: -1, code: null};
  const lowered = lowerScriptBlock(compiled.analyzed, compiled.analyzedRoot, {
    unaryAsteriskIgnoresPropAccess: options.unaryAsteriskIgnoresPropAccess,
  });
  const code = generateCode(lowered.tree, lowered.root, {
    name: input.name,
    lineOffset: input.lineOffset ?? 0,
  });
  return {...compiled, lowered: lowered.tree, loweredRoot: lowered.root, code};
}

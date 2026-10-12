# TJS2 compiler

TypeScript compiler for TJS2, the script language of the Kirikiri core, following the TJS 2.4
sources (krkrz `tjs2/`: `tjsLex.cpp`, `tjs.y`, `tjspp.y`, `tjsInterCodeGen.cpp`). It turns a
script block into three NIF trees (see `src/compiler/README.md`) — the parsed, analysed and
lowered stages — and then into VM code, the native instruction set in a `CodeBlock`. The VM
that runs it is in `vm/` (`vm/README.md`); the object model both target is in `runtime/`
(`runtime/README.md`).

```
source → parsed → analysed → lowered → CodeBlock → VM
         (NIF)     (NIF)      (NIF)     (code)
                                          ↑
                         TJS2 bytecode (TJS2100)
```

| File              | Contents                                                                         |
| ----------------- | -------------------------------------------------------------------------------- |
| `compiler.ts`     | Entry points: `parseScriptBlock`, `compileScriptBlock`, `corePreprocessorValues` |
| `tokens.ts`       | Token types and reserved words                                                   |
| `literals.ts`     | Number, string, octet, regexp and comment scanning (`TJSParseNumber`, …)         |
| `preprocessor.ts` | `PreprocessorValues` and the `@set`/`@if` expression evaluator                   |
| `lexer.ts`        | Tokens, preprocessor statements, embeddable strings, regexp rescanning           |
| `parser.ts`       | Recursive-descent parser for `tjs.y`; writes the parsed stage                    |
| `sema.ts`         | Name resolution and checks; writes the analysed stage                            |
| `messages.ts`     | Native message names and texts; reading the core's string tables                 |
| `dialect.ts`      | Tag table of the `tjs2` NIF dialect                                              |
| `lower.ts`        | Lowering of the analysed stage to VM instructions (`GenNodeCode`)                |
| `lowered.ts`      | Tag table of the `tjs2vm` NIF dialect (the lowered stage)                        |
| `opcodes.ts`      | The VM instruction set: opcodes, operand layouts                                 |
| `codegen.ts`      | Code generation: lowered stage → `CodeBlock`                                     |
| `code-block.ts`   | `CodeBlock`, `ContextCode`, `DataItem`: compiled code as plain data              |
| `bytecode.ts`     | TJS2 bytecode (`TJS2100`) reader and writer                                      |
| `disassembler.ts` | The native disassembler's listing of VM code                                     |
| `vm/`             | The VM; see `vm/README.md`                                                       |

Build options of a core (TJS version, preprocessor values, the dicfunc quick-hack flag) are
in `../revision.ts`, keyed by the executable's SHA-256. `tjs2CompilerOptions(revision,
environment)` combines them with how the core runs: the UI language that selects the message
table, the executable to read it from, and the `-unaryaster=compat` and `-evalcontext=global`
options, which change how unary `&`/`*` compile and enable the post-`!` warning.

## Compiling

```ts
const options = tjs2CompilerOptions(revision, {uiLanguage, executable}); // per engine
const result = generateScriptBlock(
  {text, name: 'system/Initialize.tjs', mode: 'statements'},
  options,
);
if (result.diagnostics.errorCount === 0) run(result.code!);
```

`compileScriptBlock` stops after the analysed stage; `generateScriptBlock` also lowers and
generates code. Script blocks are normally compiled by the VM's executor (`vm/executor.ts`),
which prints the diagnostics and throws the first error.

- A script block is one source text: a storage file (`Scripts.execStorage`), or a string
  (`Scripts.eval`, `eval`, the `!` operator, KAG `exp=`). `mode: 'expression'` compiles as
  `Scripts.eval`/`evalStorage` do: `;` is appended and, with `resultNeeded`, `return` is
  prepended, so the full statement grammar applies and the first expression is the result.
- `options.preprocessor` is engine state: `@set` in one block is visible to every block
  compiled after it. `kirikiriz` and `version` are defined by the core.
- Text is expected without a byte-order mark. CR LF and lone CR become LF; line numbers are
  unchanged. `lineOffset` shifts line numbers for scripts embedded in other files.
- Errors are reported as the native compiler reports them; see Diagnostics.

## Lexical behaviour

The lexer reproduces native quirks that change meaning:

- `true`/`false` are the integers 1/0; `null`, `NaN`, `Infinity` are constants. After `.`,
  any word, reserved or not, is a member name.
- Numbers: `0x`, `0b`, leading-zero octal (`09` is `0` then `9`), reals with `p` exponents in
  non-decimal bases, spaces allowed after an exponent mark, `1.foo` is the real `1.` then
  `foo`. Integers wrap to 64 bits.
- Adjacent string literals with the same delimiter join. `\x` takes up to four hex digits,
  `\0` an octal number of any length; other escapes are C's, unknown ones yield the letter.
- `=>` is a comma. `<% … %>` is an octet literal. Block comments nest.
- `@"…"` / `@'…'` with `${expr}` or `&expr;` produces the tokens of
  `("text" + string(expr) + …)`.
- `@set (…)`, `@if (…)`, `@endif` (no `@else`). A false `@if` skips to its `@endif`,
  honouring comments and nested `@if`, but not strings.
- A `/` or `/=` where a primary expression is expected is rescanned as a regular expression;
  the pattern is kept verbatim with its flags.

## Parsed stage

Root: `(stmts S…)`. Names are identifiers (`a`), member names and literals are strings.
Parentheses leave no node.

| Statement   | Shape                                                                                 |
| ----------- | ------------------------------------------------------------------------------------- |
| block       | `(block S…)`                                                                          |
| var / const | `(var (vdef name init\|.)…)`, `(const …)`                                             |
| if          | `(if cond then else\|.)`                                                              |
| loops       | `(while cond body)`, `(dowhile body cond)`, `(for init\|. cond\|. step\|. body)`      |
| jumps       | `(brk)`, `(cont)`, `(ret e\|.)`, `(throw e)`, `(debugger)`                            |
| function    | `(func name (params P…) (block …))`; P is `(param name default\|.)`, `(rest name\|.)` |
| property    | `(prop name (getter (block …)) (setter v (block …)))`, handlers in source order       |
| class       | `(class name (extends e…) (block …))`                                                 |
| switch      | `(switch e (block …))` with `(case e)` and `(default)` statements inside              |
| with        | `(with e body)`                                                                       |
| try         | `(try body (catch name\|.) handler)`                                                  |
| expression  | the expression itself                                                                 |

An empty statement as a body is `.`.

| Expression | Shape                                                                                                                                                                                   |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| literals   | integer, float (`1.0` stays a float), string atoms; `(void)`, `(null)`, `(nan)`, `(inf)`, `(octet "hex")`, `(regexp "pattern" "flags")`                                                 |
| names      | identifier; `(this)`, `(super)`, `(global)`, `(wdot "m")` for `.m`                                                                                                                      |
| members    | `(dot e "m")`, `(at e index)`                                                                                                                                                           |
| calls      | `(call f A…)`, `(new f A…)`; A is an expression, `.` (omitted), `(expand e)` (`e*`), `(expand)` (`*`), or the single `(omit)` (`...`)                                                   |
| containers | `(arr e\|.…)`, `(dict (kv k v)…)`, `(carr c…)`, `(cdict (kv k c)…)`                                                                                                                     |
| functions  | `(fn (params …) (block …))`                                                                                                                                                             |
| binary     | `add sub mul div idiv mod shl sar shr bitand bitor bitxor and or eq neq deq dneq lt gt le ge instanceof incontextof comma`                                                              |
| assignment | `asgn`, `addasgn subasgn mulasgn divasgn idivasgn modasgn shlasgn sarasgn shrasgn bitandasgn bitorasgn bitxorasgn andasgn orasgn`, `swap`                                               |
| other      | `(cond c a b)`, `(postif e cond)` (`e if cond`)                                                                                                                                         |
| unary      | `not bitnot neg pos preinc predec postinc postdec typeof delete isvalid invalidate eval` (postfix `!`) `chr` (`$`) `asc` (`#`) `toint toreal tostr ignoreprop` (`&`) `propaccess` (`*`) |

`[]` is `(arr)` and `f()` is `(call f)`: a single empty element or argument is none.
`new` applies to the last call of a member chain (`new a.b(1).c(2)` constructs `….c`).

## Analysed stage

Root: `(script (hoist sym…) S…)`. The analysis follows the native code generator's order and
scoping rules:

- **Contexts.** `func`, `fn`, `prop`, `getter`, `setter` and `class` nodes are contexts and
  define a symbol: `(func :f.N "f" reg (params …) (block …))`, `(fn :anon.N (params …)
(block …))`, `(prop :p.N "p" reg (getter :getter.N (block …)) (setter :setter.N (param
:v.N .) (block …)))`, `(class :C.N "C" reg (extends e…) (block …))`.
- **Registration** (`reg`): `hoist` — set on `this` before the top level runs, listed in
  `(hoist …)` in declaration order (functions and properties bound to `this`); `member` — a
  member of the enclosing function or class object; `local` — a function in a function: a
  member of the enclosing function and a local variable, initialised by the `(local …)` that
  follows the definition; `none` — unreachable by name (inside an expression function, a
  getter or a setter).
- **Locals.** Each context has its own namespace; there are no closures. A local is
  `(local :x.N init|.)` at its declaration (`(local x.N …)` when an existing local of the same
  level is redeclared) and the symbol `x.N` at its uses. `var` at namespace depth 0 (top
  level) or 1 in a class (the class body) is `(member "x" init|.)`, a member of `this`.
  Parameters, `catch` variables and `for` initialisers are locals.
- **Unresolved names** are `(proxy "x")`: looked up on `this`, then `global`, at run time.
  Inside the base-class expression that `super` stands for they are `(gproxy "x")`
  (`global` only).
- **Order.** A name refers to the declaration compiled before it: `var x = x` reads the old
  `x`; `delete x` of a local is `(dellocal x.N)` and removes it; a `for` step is compiled after
  the body, so the analysed form is `(for init cond body step)`.
- **with** declares the symbol of its value: `(with :with.N e body)`; `.m` inside is
  `(wdot with.N "m")`, outside any `with` `(wdot . "m")` (global).
- **super** is `(super e)`, where `e` is the class's only base-class expression, compiled
  again in global mode. A class with several bases has no `super`.
- **switch** becomes `(switch e (block pre…) (case e (block …)) (default (block …)))`. Each
  section is its own scope, and a case expression is compiled outside the previous section.
- `try` is `(try body (catch :e.N|.) handler)`.
- Forms that the generator treats differently stay distinct: a call of `(dot …)`, `(at …)`
  or `(proxy …)` is a member call on the object; a call of anything else, including a local,
  `(wdot …)` and `(super …)`, calls the function value with its own context. Arguments are
  evaluated before the callee in both cases. `typeof` of `dot`, `at` or `wdot` is a member
  test.

Checks, as natively: assignment or modification of a non-lvalue (`TJSCannotModifyLHS`), the
value of `<->` or a postfix `if` (`TJSCannotGetResult`), `super` without a single base
(`TJSCannotGetSuper`), `break`/`continue` outside a loop (`TJSMisplacedBreakContinue`), `case`
not directly in a switch (`TJSMisplacedCase`), `...` outside a function (`TJSCannotOmit`), and
the warning for `=` in a condition (`TJSSubstitutionInBooleanContext`).

## Lowered stage

Root: `(module (context …)…)`, one context per function, expression function, property,
accessor, class, super-class getter and the top level, in the order the native compiler
creates them. The lowering ports `GenNodeCode` and the statement generators that `tjs.y`
calls, so the register numbers, the evaluation order, the order of property handler calls and
conversion errors, and the code size are those of the native compiler:

- Register 0 is void, -1 is `this`, -2 the this-proxy (`this`, then `global`), -3, -4, … the
  arguments and locals as the native local namespace numbers them (removed names leave holes
  that later declarations reuse). Temporaries count up from the frame base (1, plus one per
  enclosing `switch` and `with`, which hold their value there) and are reused per statement.
- Constant subexpressions are folded as `MakeNP1`/`MakeNP2` fold them while parsing.
- A name that is not a local is a member of the this-proxy: read with `GPD`, assigned with
  `SPD` (no member is created), called with `CALLD`. Members of other objects are assigned with
  `SPDE`, which creates them.
- Top-level functions, properties and classes are registered on `this` by code inserted at the
  start of the top level (`CONST`, `CHGTHIS`, `SPDS`); a class's `REGMEMBER` is inserted after
  its base-class calls.

```
(context :c.N "name"|. kind parent|.
  (layout maxVariables reserve maxFrame argCount unnamedBase collapseBase)
  (handlers getter|. setter|. superGetter|.)
  (members (m "name" c.K)…)     # registered on this context when instantiated
  (supers L…)                    # super-class getter: one entry label per base class
  (code instruction…))
```

`kind` is `toplevel`, `function`, `exprfunction`, `property`, `getter`, `setter`, `class` or
`supergetter`. An instruction is `(OPCODE operand…)` with the operands `opcodes.ts` lists for
it: registers as integers, a data operand as a constant, a jump target as a label symbol, and
call arguments as `(args r…)`, `(omit)` (`...`) or `(xargs (n r) (x r) (u)…)` (normal,
`array*`, `*`). `(label :L.N)` marks a position. Constants are integer, float and string atoms,
`(void)`, `(null)`, `(nan)`, `(inf)`, `(neginf)`, `(octet "hex")`, `(ctx c.N)` (a context),
`(array c…)` and `(dict (kv "name" c)…)` (`(const)` literals).

## Code

`codegen.ts` encodes each context as `Int32Array` words: an opcode and its operands, register
and data operands as indices, jumps as word offsets from the jump instruction. This is the
layout of TJS2 bytecode, which stores the same words in 16 bits, so `bytecode.ts` reads
`TJS2100` files into the same `CodeBlock` and the VM runs both alike (bytecode keeps no source
lines and no constant arrays). Code generation reuses a data entry equal to one of the last 20
(`PutData`), threads jumps to jumps (`FixCode`) and records the source line of each
instruction. `disassembleBlock` prints code as the native disassembler does
(`00000003 gpd %1, %-2.*0	// *0 = (string)"x"`).

## Diagnostics

The native compiler generates code while it parses, reports through `_yyerror` and throws
the first error as the script exception. The compiler reproduces what it reports:

- **Text.** Messages come from the core's RT_STRING tables (string 10000 + n in the order of
  krkrz `MsgLoad.cpp`), in the UI language: exact LANGID, same primary language, English.
  `messages.ts` holds the texts of the reference build as defaults. Bison reports only
  `syntax error`, so a syntax error reads `Syntax error (syntax error)`.
- **Line.** The reported line is where the native lexer stood (`LEX_POS`), not where the
  construct starts: after the `;` of a statement, the `)` of an `if`/`while`/`switch`/`with`
  header, the `:` of a `case`, the token after a variable's initialiser, a default value or a
  base class; after the offending token for a syntax error; at the end of the script for an
  unterminated literal or comment. The parser records these points (`CodegenPoints`); the
  analysis reports with them. The `=`-in-condition warning uses the assignment node's
  position, the lexer offset when the parser built it.
- **Order and recovery.** Reports are ordered by that lexer offset. After a syntax or lexical
  error the parser keeps exactly what the native generator had compiled — finished
  statements, headers past their point, expression-function bodies — and the analysis runs
  on that, so errors in earlier code come before the syntax error, as natively. A lexical
  error is followed by a `syntax error` at the same place unless the script could end there.
  Native error recovery (`def_list error ";"`) continues after the first syntax error and can
  print more errors to the console; those later errors are not reported.
- **Console.** `tjs2ConsoleLine` gives the native console text: `<message> at line <n>` for
  errors, `<Warning: ><message> at <storage> line <n>` for warnings.
- Code the generator skips reports nothing: the operands of an `incontextof` whose value is
  unused, the step of a loop cut off by a syntax error.

## Verification

- `tests/kirikiri-tjs2-compiler.test.mjs`, `tests/kirikiri-tjs2-vm.test.mjs` (code
  generation, bytecode) and `tests/nif.test.mjs`.
- `tools/probe-kirikiri-tjs2.mjs <core.exe> <plugin.tpm> <archive.xp3>…` compiles every
  `.tjs` member of the given archives to code, retries data files as expressions, checks that
  each analysed and lowered tree survives the NIF text form and that the code survives TJS2
  bytecode, and prints counts and timings. `--out <dir> --stage parsed|analyzed|lowered|code`
  writes the trees as `.p.nif`/`.s.nif`/`.l.nif` or the disassembly as `.dis` (game-derived;
  keep them out of the repository).

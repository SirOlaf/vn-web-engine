import test from 'node:test';
import assert from 'node:assert/strict';
import {writeNifTree} from '../dist/compiler/nif/text.js';
import {
  compileScriptBlock,
  corePreprocessorValues,
  parseScriptBlock,
  tjs2ConsoleLine,
} from '../dist/engines/kirikiri/tjs2/compiler.js';
import {parseNumber} from '../dist/engines/kirikiri/tjs2/literals.js';
import {defaultTjs2Messages} from '../dist/engines/kirikiri/tjs2/messages.js';

const pp = () => corePreprocessorValues([2, 4, 28], [['kirikiriz', 1]]);
const compact = (text) => text.replace(/\s+/g, ' ').trim();

/** Parsed stage of `text`, without the `(stmts …)` wrapper, as compact NIF text. */
function parse(text, {mode = 'statements', preprocessor = pp()} = {}) {
  const r = parseScriptBlock({text, name: 't.tjs', mode, resultNeeded: true}, {preprocessor});
  assert.deepEqual(r.diagnostics.list, [], text);
  return compact(writeNifTree(r.tree, r.root, {positions: false})).replace(/^\(stmts ?|\)$/g, '');
}

/** Analysed stage of `text` as compact NIF text, plus diagnostics with their native lines. */
function analyze(text, options = {}) {
  const r = compileScriptBlock(
    {text, name: 't.tjs', mode: 'statements'},
    {preprocessor: pp(), ...options},
  );
  const tree = r.analyzed
    ? compact(writeNifTree(r.analyzed, r.analyzedRoot, {positions: false}))
    : null;
  return {
    tree,
    diagnostics: r.diagnostics.list.map((d) => `${d.severity} ${d.code} ${d.line}`),
  };
}

function analyzed(text) {
  const r = analyze(text);
  assert.deepEqual(r.diagnostics, [], text);
  return r.tree;
}

test('TJS2 numbers follow TJSParseNumber: prefixes, octal, reals, hexadecimal exponents', () => {
  const n = (s) => {
    const r = parseNumber(s, 0);
    return r && [r.value.type, r.value.value, r.end];
  };
  assert.deepEqual(n('0x1F'), ['int', 31n, 4]);
  assert.deepEqual(n('0b101'), ['int', 5n, 5]);
  assert.deepEqual(n('017'), ['int', 15n, 3]);
  assert.deepEqual(n('09'), ['int', 0n, 1]);
  assert.deepEqual(n('1.foo'), ['real', 1, 2]);
  assert.deepEqual(n('1e 3'), ['real', 1000, 4]);
  assert.deepEqual(n('0x1.8p1'), ['real', 3, 7]);
  assert.deepEqual(n(' - 5'.trim()), ['int', -5n, 3]);
  assert.deepEqual(n('9223372036854775808'), ['int', -(1n << 63n), 19]);
  assert.deepEqual(n('true'), ['int', 1n, 4]);
  assert.equal(n('0p'), null);
});

test('TJS2 lexer: string escapes, adjacent literals, octets, comments, => and regular expressions', () => {
  assert.equal(
    parse(
      String.raw`a = "x\x41\0101\n" "z"; b = <% 0a f, 1 /* c /* d */ */ %>; c = %["k" => 1]; d = /a\/b/g;`,
    ),
    '(asgn a "xAA\\nz") (asgn b (octet "0a0f01")) (asgn c (dict (kv "k" 1))) (asgn d (regexp "a\\|/b" "g"))',
  );
  assert.equal(parse("x = 'a'  'b';"), '(asgn x "ab")');
  const mixed = parseScriptBlock(
    {text: `x = 'a' "b";`, name: 't', mode: 'statements'},
    {preprocessor: pp()},
  );
  assert.equal(mixed.complete, false, 'literals with different delimiters do not join');
  assert.equal(
    parse('x = a /= b; y = (c / d) / e;'),
    '(asgn x (divasgn a b)) (asgn y (div (div c d) e))',
  );
  assert.equal(parse('#! shebang line\nx;'), 'x');
});

test('TJS2 embeddable strings expand to concatenations of string() conversions', () => {
  assert.equal(
    parse('x = @"a${b}c&d;e";'),
    '(asgn x (add (add (add (add "a" (tostr b)) "c") (tostr d)) "e"))',
  );
  assert.equal(parse('x = @"${b}";'), '(asgn x (tostr b))');
  assert.equal(parse('x = @"";'), '(asgn x "")');
  assert.equal(parse('x = @"${ %[a: 1] }";'), '(asgn x (tostr (dict (kv "a" 1))))');
  assert.equal(
    parse('x = @"p${f(@"q${r}")}";'),
    '(asgn x (add "p" (tostr (call f (add "q" (tostr r))))))',
  );
});

test('TJS2 preprocessor values are shared by the engine and @if skips text up to @endif', () => {
  const preprocessor = pp();
  assert.equal(
    parse('@set (A = 2, B = A * 3)\n@if (B == 6)\nyes;\n@endif\n', {preprocessor}),
    'yes',
  );
  assert.equal(preprocessor.get('B'), 6);
  assert.equal(
    // Comments are honoured while skipping, strings are not: the `@endif` in the string ends the skip.
    parse('@if (A > 5)\n no; /* @endif */ @if (1) nested; @endif a = "@endif""; after;', {
      preprocessor,
    }),
    '"" after',
  );
  assert.equal(parse('@if (kirikiriz && version >= 0x2041c) z; @endif', {preprocessor}), 'z');
  const bad = parseScriptBlock(
    {text: '@if (1) x;', name: 't.tjs', mode: 'statements'},
    {preprocessor},
  );
  assert.equal(bad.diagnostics.list[0].code, 'TJSPPError');
});

test('TJS2 parser follows the grammar: precedence, new, call arguments, postfix operators', () => {
  assert.equal(
    parse('a = b || c && d | e ^ f & g == h < i << j + k * l;'),
    '(asgn a (or b (and c (bitor d (bitxor e (bitand f (eq g (lt h (shl i (add j (mul k l)))))))))))',
  );
  assert.equal(parse('a = b = c ? d : e ? f : g;'), '(asgn a (asgn b (cond c d (cond e f g))))');
  assert.equal(parse('new A.B(1).c(2);'), '(new (dot (call (dot A "B") 1) "c") 2)');
  assert.equal(
    parse('f(a*, *, , b*c*); g(); h(,); k(...);'),
    '(call f (expand a) (expand) . (expand (mul b c))) (call g) (call h . .) (call k (omit))',
  );
  assert.equal(
    parse('x++ if y; a = !b!; c = d isvalid; e = f instanceof "Array";'),
    '(postif (postinc x) y) (asgn a (not (eval b))) (asgn c (isvalid d)) (asgn e (instanceof f "Array"))',
  );
  assert.equal(
    parse('a = (int)b + int c + (string)d + -e; f <-> g.h;'),
    '(asgn a (add (add (add (toint b) (toint c)) (tostr d)) (neg e))) (swap f (dot g "h"))',
  );
  assert.equal(
    parse('a = f incontextof g incontextof h; o.if = .class;'),
    '(asgn a (incontextof f (incontextof g h))) (asgn (dot o "if") (wdot "class"))',
  );
  assert.equal(
    parse('a = [], b = [1,], c = %[,], d = %[k: 1, "j", 2,];'),
    '(comma (comma (comma (asgn a (arr)) (asgn b (arr 1 .))) (asgn c (dict))) (asgn d (dict (kv "k" 1) (kv "j" 2))))',
  );
  assert.equal(
    parse('a = (const) %["k", -1, "l", (const) [void, "s"]];'),
    '(asgn a (cdict (kv "k" (neg 1)) (kv "l" (carr (void) "s"))))',
  );
  assert.equal(
    parse('a = true + false + null + NaN + Infinity;'),
    '(asgn a (add (add (add (add 1 0) (null)) (nan)) (inf)))',
  );
});

test('TJS2 parser: declarations and statements', () => {
  assert.equal(
    parse('function f(a, b = 1, c*) { } function g(*) { } function h { }'),
    '(func f (params (param a .) (param b 1) (rest c)) (block)) (func g (params (rest .)) (block)) (func h (params) (block))',
  );
  assert.equal(
    parse('function(x) { return x; }(1);'),
    '(call (fn (params (param x .)) (block (ret x))) 1)',
  );
  assert.equal(
    parse('property p { setter(v) { } getter { return 1; } }'),
    '(prop p (setter v (block)) (getter (block (ret 1))))',
  );
  assert.equal(
    parse('class C extends A, B { var x : int = 1; }'),
    '(class C (extends A B) (block (var (vdef x 1))))',
  );
  assert.equal(
    parse('try a(); catch { } try { } catch() ; try { } catch(e) b(e);'),
    '(try (call a) (catch .) (block)) (try (block) (catch .) .) (try (block) (catch e) (call b e))',
  );
  assert.equal(
    parse('for (var i = 0, j; i < 2; i++) ; for (;;) { } while (x) ; do y(); while (z);'),
    '(for (var (vdef i 0) (vdef j .)) (lt i 2) (postinc i) .) (for . . . (block)) (while x .) (dowhile (call y) z)',
  );
  assert.equal(
    parse('switch (x) { case 1: case 2: a(); break; default: b(); }'),
    '(switch x (block (case 1) (case 2) (call a) (brk) (default) (call b)))',
  );
  assert.equal(parse('%[a: 1]', {mode: 'expression'}), '(ret (dict (kv "a" 1)))');
});

test('TJS2 parser reports syntax errors as bison does, after the offending token', () => {
  const r = parseScriptBlock(
    {text: 'a = 1;\nb = (2;', name: 't.tjs', mode: 'statements'},
    {preprocessor: pp()},
  );
  assert.deepEqual(
    r.diagnostics.list.map((d) => [d.code, d.message, d.line, d.column]),
    [['TJSSyntaxError', 'Syntax error (syntax error)', 2, 7]],
  );
  for (const text of ['var if;', 'f(a, ...);', 'x = (const) [ [1] ];', 'new A;', 'a.b = c d;'])
    assert.equal(
      parseScriptBlock({text, name: 't', mode: 'statements'}, {preprocessor: pp()}).complete,
      false,
      text,
    );
});

test('TJS2 analysis: locals, members and registration follow namespace depth and context', () => {
  assert.equal(
    analyzed('var g = 1; { var l = g; } for (var i;;) ; if (1) var m;'),
    '(script (hoist) (member "g" 1) (block (local :l.0 (proxy "g"))) (for (stmts (local :i.1 .)) . . .) (if 1 (member "m" .) .))',
  );
  assert.equal(
    analyzed('class C { var x; function f() { var y; } }'),
    '(script (hoist C.0) (class :C.0 "C" hoist (extends) (block (member "x" .) (func :f.1 "f" member (params) (block (local :y.2 .))))))',
  );
  assert.equal(
    analyzed('function o() { inner(); function inner() { inner(); } inner(); }'),
    '(script (hoist o.0) (func :o.0 "o" hoist (params) (block (call (proxy "inner")) (func :inner.1 "inner" local (params) (block (call (proxy "inner")))) (local :inner.2 inner.1) (call inner.2))))',
  );
  assert.equal(
    analyzed('x = function { function g() {} g(); };'),
    '(script (hoist) (asgn (proxy "x") (fn :anon.0 (params) (block (func :g.1 "g" none (params) (block)) (call (proxy "g"))))))',
  );
});

test('TJS2 analysis resolves names in compilation order', () => {
  assert.equal(
    analyzed('function f(a = a) { var b = b; var b; delete b; return b; }'),
    '(script (hoist f.0) (func :f.0 "f" hoist (params (param :a.1 a.1)) (block (local :b.2 (proxy "b")) (local b.2 .) (dellocal b.2) (ret (proxy "b")))))',
  );
  assert.equal(
    analyzed('function f() { for (var i = 0; i < 1; k) var k = i; }'),
    '(script (hoist f.0) (func :f.0 "f" hoist (params) (block (for (stmts (local :i.1 0)) (lt i.1 1) (local :k.2 i.1) k.2))))',
  );
  assert.equal(
    analyzed('function f(x) { switch (x) { case 1: var s; case s: s; default: s; } }'),
    '(script (hoist f.0) (func :f.0 "f" hoist (params (param :x.1 .)) (block (switch x.1 (block) (case 1 (block (local :s.2 .))) (case (proxy "s") (block (proxy "s"))) (default (block (proxy "s")))))))',
  );
  assert.equal(
    analyzed('function f() { try { } catch (e) { e; } e; }'),
    '(script (hoist f.0) (func :f.0 "f" hoist (params) (block (try (block) (catch :e.1) (block e.1)) (proxy "e"))))',
  );
});

test('TJS2 analysis: with, super and calls keep the forms the code generator distinguishes', () => {
  assert.equal(
    analyzed('with (o) { .a = .b(); } .c;'),
    '(script (hoist) (with :with.0 (proxy "o") (block (asgn (wdot with.0 "a") (call (wdot with.0 "b"))))) (wdot . "c"))',
  );
  assert.equal(
    analyzed(
      'class C extends B { function C() { super.C(); } property p { getter { return super.p; } } }',
    ),
    '(script (hoist C.0) (class :C.0 "C" hoist (extends (proxy "B")) (block (func :C.1 "C" member (params) (block (call (dot (super (gproxy "B")) "C")))) (prop :p.2 "p" member (getter :getter.3 (block (ret (dot (super (gproxy "B")) "p"))))))))',
  );
  assert.deepEqual(
    analyze('class C extends A, B {\n function f() {\n  super.f();\n }\n}').diagnostics,
    ['error TJSCannotGetSuper 3'],
  );
  assert.deepEqual(analyze('function f() {\n super.f(); }').diagnostics, [
    'error TJSCannotGetSuper 2',
  ]);
});

test('TJS2 analysis reports what the native generator rejects, at the line it compiles', () => {
  const errors = (text, options) => analyze(text, options).diagnostics;
  assert.deepEqual(errors('1 = 2;\nthis = 1;\nf() = 1;\n(a + b)++;\n&1;\ndelete this;'), [
    'error TJSCannotModifyLHS 1',
    'error TJSCannotModifyLHS 2',
    'error TJSCannotModifyLHS 4',
    'error TJSCannotModifyLHS 5',
    'error TJSCannotModifyLHS 6',
  ]);
  // A statement is compiled at its `;`, so a multi-line statement reports its last line.
  assert.deepEqual(errors('x = (a <-> b);\ny = (c\n if d)\n;\na <-> b; c if d;'), [
    'error TJSCannotGetResult 1',
    'error TJSCannotGetResult 4',
  ]);
  assert.deepEqual(
    errors('break;\nwhile (1) { continue; }\nswitch (1) { default: {\n case 2: } continue; }'),
    [
      'error TJSMisplacedBreakContinue 1',
      'error TJSMisplacedCase 4',
      'error TJSMisplacedBreakContinue 4',
    ],
  );
  // The warning is at the node: where the lexer stood when `=` was reduced.
  assert.deepEqual(errors('function f() { var l; &l = 1; }\nif (a = b)\n ;'), [
    'error TJSCannotModifyLHS 1',
    'warning TJSSubstitutionInBooleanContext 2',
  ]);
  // An `incontextof` whose value is unused generates no code, so no errors either.
  assert.deepEqual(errors('(this = 1) incontextof o;\nv = ((this = 1) incontextof o);'), [
    'error TJSCannotModifyLHS 2',
  ]);
  // `-unaryaster=compat` swaps unary `&` and `*`.
  const swap = {unaryAsteriskIgnoresPropAccess: true};
  assert.deepEqual(errors('function f() { var l; *l = 1; &l = 1; }', swap), [
    'error TJSCannotModifyLHS 1',
  ]);
  assert.deepEqual(errors('function f() { x!; }\nx!;', {evalOperatorIsOnGlobal: true}), [
    'warning TJSWarnEvalOperator 1',
  ]);
});

test('TJS2 diagnostics come in the native order and survive syntax errors', () => {
  const errors = (text) => analyze(text).diagnostics;
  // Code compiled before the syntax error reports first, including function bodies.
  assert.deepEqual(errors('x = 1 = 2;\ny = ;'), [
    'error TJSCannotModifyLHS 1',
    'error TJSSyntaxError 2',
  ]);
  assert.deepEqual(errors('function f() {\n 1 = 2;\n'), [
    'error TJSCannotModifyLHS 2',
    'error TJSSyntaxError 2',
  ]);
  assert.deepEqual(errors('if (a = b) {\n c = (function { 1 = 2; }) + ;\n}'), [
    'warning TJSSubstitutionInBooleanContext 1',
    'error TJSCannotModifyLHS 2',
    'error TJSSyntaxError 2',
  ]);
  // The statement with the error and the step of a loop cut off by it are not compiled.
  assert.deepEqual(errors('for (;; 1 = 2) {\n 3 = 4 5;\n}'), ['error TJSSyntaxError 2']);
  // Inside a function body each statement compiles before the enclosing one.
  assert.deepEqual(errors('x = function { 1 = 2; } = 3;'), [
    'error TJSCannotModifyLHS 1',
    'error TJSCannotModifyLHS 1',
  ]);
});

test('TJS2 lexical errors report where the lexer stopped, then end of script', () => {
  const r = (text) =>
    compileScriptBlock({text, name: 't.tjs', mode: 'statements'}, {preprocessor: pp()}).diagnostics
      .list;
  assert.deepEqual(
    r('x = "abc;\ny = 1;\n').map((d) => [d.code, d.message, d.line]),
    [
      ['TJSStringParseError', 'Un-terminated string/regexp/octet literal', 2],
      ['TJSSyntaxError', 'Syntax error (syntax error)', 2],
    ],
  );
  assert.deepEqual(
    r('x = 1;\ny = `;').map((d) => [d.code, d.message, d.line]),
    [
      ['TJSInvalidChar', "Invalid character '`'", 2],
      ['TJSSyntaxError', 'Syntax error (syntax error)', 2],
    ],
  );
  // At a statement boundary the end of script is accepted.
  assert.deepEqual(
    r('if (a) x = 1;\n\x01').map((d) => [d.code, d.message, d.line]),
    [['TJSInvalidChar', "Invalid character '\\x01'", 2]],
  );
  assert.deepEqual(
    r('/* a\n /* b */').map((d) => d.code),
    ['TJSUnclosedComment'],
  );
});

test('TJS2 messages use the native string tables and console format', () => {
  const ja = defaultTjs2Messages(0x0411);
  const r = compileScriptBlock(
    {text: 'if (a = b) ;\nx = ;', name: 'data/t.tjs', mode: 'statements'},
    {preprocessor: pp(), messages: ja},
  );
  assert.deepEqual(
    r.diagnostics.list.map((d) => tjs2ConsoleLine(d, ja)),
    [
      '警告: 論理値が求められている場所で = 演算子が使用されています(== 演算子の間違いですか？代入した上でゼロと値を比較したい場合は、(A=B) != 0 の形式を使うことをお勧めします) at data/t.tjs line 1',
      '文法エラーです(syntax error) at line 2',
    ],
  );
  assert.equal(
    defaultTjs2Messages(0x0809).TJSCannotModifyLHS,
    'This expression cannot be used as a lvalue',
  );
});

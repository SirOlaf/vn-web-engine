import assert from 'node:assert/strict';
import test from 'node:test';
import {readNif, writeNif} from '../dist/compiler/nif/text.js';
import {
  corePreprocessorValues,
  generateScriptBlock,
} from '../dist/engines/kirikiri/tjs2/compiler.js';
import {
  isTjs2ByteCode,
  readTjs2ByteCode,
  writeTjs2ByteCode,
} from '../dist/engines/kirikiri/tjs2/bytecode.js';
import {disassembleContext} from '../dist/engines/kirikiri/tjs2/disassembler.js';
import {TjsEngine} from '../dist/engines/kirikiri/tjs2/runtime/engine.js';
import {TjsCompileError, TjsScriptError} from '../dist/engines/kirikiri/tjs2/runtime/errors.js';
import {NativeFunction} from '../dist/engines/kirikiri/tjs2/runtime/native.js';
import {VariantSlot} from '../dist/engines/kirikiri/tjs2/runtime/slot.js';
import * as V from '../dist/engines/kirikiri/tjs2/runtime/variant.js';
import {TjsVm} from '../dist/engines/kirikiri/tjs2/vm/executor.js';

const compilerOptions = () => ({preprocessor: corePreprocessorValues([2, 4, 28])});

/**
 * An engine with the VM and three globals: `log(…)` records its arguments joined by spaces,
 * `wait(v)` suspends and then returns `v`, `waitFail()` suspends and then throws.
 */
function setup() {
  const logs = [];
  const engine = new TjsEngine({
    readText: () => '',
    openTextWrite: () => ({write() {}, close() {}}),
    print: (line) => logs.push(`console: ${line}`),
    time: () => 0,
  });
  const vm = new TjsVm(engine, {compiler: compilerOptions()});
  engine.executor = vm;
  const fn = (name, body) => engine.registerGlobal(name, new NativeFunction(body));
  fn('log', (_r, args) => (logs.push(args.map((a) => V.asString(a)).join(' ')), 0));
  fn('wait', (r, args) =>
    engine.suspender.suspend(Promise.resolve(args[0] ?? V.VOID), (v) => (r?.set(v), 0)),
  );
  fn('waitFail', () =>
    engine.suspender.suspend(Promise.reject(new TjsScriptError('async failure', null)), () => 0),
  );
  return {engine, vm, logs};
}

/** Runs `text` as a top-level call; resolves to the logs and the result as readable text. */
async function run(text, {mode = 'statements', env = setup()} = {}) {
  const result = new VariantSlot();
  await env.engine.suspender.run(() =>
    env.engine.runScript({text, name: 'test.tjs', lineOffset: 0, mode}, result, null),
  );
  return {logs: env.logs, result: V.readableString(result.value), env};
}

async function logs(text) {
  return (await run(text)).logs;
}

function disassemble(text, context = 0) {
  const r = generateScriptBlock({text, name: 'test.tjs', mode: 'statements'}, compilerOptions());
  assert.equal(r.diagnostics.errorCount, 0, text);
  return disassembleContext(r.code.contexts[context]).map((l) => l.replace(/^0+(?=\d)/, ''));
}

test('code generation allocates registers as the native generator does', () => {
  // Top level: `var` makes a member of `this`; unknown names go through the this-proxy (%-2).
  assert.deepEqual(disassemble('var a = b + 1;'), [
    '0 gpd %1, %-2.*0\t// *0 = (string)"b"',
    '4 const %2, *1\t// *1 = (int)1',
    '7 add %1, %2',
    '10 spds %-1.*2, %1\t// *2 = (string)"a"',
    '14 srv %0',
    '16 ret',
  ]);
  // Arguments are locals -3, -4, …; a default value replaces a void argument; folding of 2*3.
  assert.deepEqual(disassemble('function f(x, y = 2 * 3) { var z = x; z += y; return z; }', 1), [
    '0 cdeq %-4, %0',
    '3 jnf 000000011',
    '5 const %1, *0\t// *0 = (int)6',
    '8 cp %-4, %1',
    '11 cp %-5, %-3',
    '14 add %-5, %-4',
    '17 srv %-5',
    '19 ret',
    '20 srv %0',
    '22 ret',
  ]);
  // A call of a member or of an unknown name is direct; a local function value is called.
  assert.deepEqual(disassemble('function g(h) { o.m(1); h(); x = 2; }', 1), [
    '0 const %1, *0\t// *0 = (int)1',
    '3 gpd %2, %-2.*1\t// *1 = (string)"o"',
    '7 calld %0, %2.*2(%1)\t// *2 = (string)"m"',
    '13 call %0, %-3()',
    '17 const %1, *3\t// *3 = (int)2',
    '20 spd %-2.*4, %1\t// *4 = (string)"x"',
    '24 srv %0',
    '26 ret',
  ]);
  // Declarations are registered on `this` before the top level runs; functions bound to it.
  assert.deepEqual(disassemble('function f() {} class C {}').slice(0, 7), [
    '0 const %1, *0\t// *0 = (object)(context #1)',
    '3 chgthis %1, %-1',
    '6 spds %-1.*1, %1\t// *1 = (string)"f"',
    '10 const %1, *2\t// *2 = (object)(context #2)',
    '13 spds %-1.*3, %1\t// *3 = (string)"C"',
    '17 cl %1',
    '19 srv %0',
  ]);
  // A class adds its name, calls its base on the new object, then copies its members.
  assert.deepEqual(disassemble('class C extends B { var v = 1; }', 1), [
    '0 const %1, *0\t// *0 = (string)"C"',
    '3 addci %-1, %1',
    '6 cl %1',
    '8 gpd %1, %-2.*1\t// *1 = (string)"B"',
    '12 chgthis %1, %-1',
    '15 call %0, %1()',
    '19 regmember',
    '20 const %1, *2\t// *2 = (int)1',
    '23 spds %-1.*3, %1\t// *3 = (string)"v"',
    '27 srv %0',
    '29 ret',
  ]);
  // Jumps to jumps are threaded; `if` conditions use the flag directly.
  assert.deepEqual(disassemble('function f(a) { while (a < 3) { if (a == 1) break; a++; } }', 1), [
    '0 const %1, *0\t// *0 = (int)3',
    '3 clt %-3, %1',
    '6 jnf 000000022',
    '8 const %1, *1\t// *1 = (int)1',
    '11 ceq %-3, %1',
    '14 jnf 000000018',
    '16 jmp 000000022',
    '18 inc %-3',
    '20 jmp 000000000',
    '22 srv %0',
    '24 ret',
  ]);
});

test('expressions follow the native conversions, folding and operators', async () => {
  assert.deepEqual(
    await logs(`
      log(1 + 2 * 3, 7 \\ 2, 7 % 3, 7 / 2, "a" + 1, 1 + "2", "3" * "4");
      log(#"A", $66, int "12" + 1, real 3, string 4 + 1, +"0x10", -"3");
      log(1 < 2, 2 <= 1, "a" < "b", void == 0, 0 === 0.0, null == null);
      log(1 && 0, 0 || 3, !5, ~0, 1 << 3, -16 >> 2, -16 >>> 60);
      log(typeof 1, typeof 1.0, typeof "", typeof void, typeof null, typeof %[]);
      var x = 5; log(x++, x, ++x, x--, x);
      log(1 ? "y" : "n", 0 ? "y" : "n", (1, 2));
    `),
    [
      '7 3 1 3.5 a1 12 12',
      '65 B 13 3 41 16 -3',
      '1 0 1 1 0 1',
      '0 1 0 -1 8 -4 15',
      'Integer Real String void Object Object',
      '5 6 7 7 6',
      'y n 2',
    ],
  );
});

test('classes: base classes, super, properties and instances', async () => {
  assert.deepEqual(
    await logs(`
      class B { var b = 1; function B(x) { b = x; } function hello() { return "B " + b; } }
      class C extends B {
        var c = 2;
        function C(x) { super.B(x * 10); }
        function hello() { return "C+" + super.hello(); }
        property p { getter { return c * 100; } setter(v) { c = v; } }
      }
      var o = new C(3);
      log(o.hello(), o.p, o instanceof "B", o instanceof "C", o instanceof "Array");
      o.p = 7; o.p += 1; log(o.c, *(&o.p), typeof o.missing, typeof o.c);
      log(C instanceof "Class", o.hello instanceof "Function", (&o.p) instanceof "Property");
      class L extends B, Array { function L() { (global.B.B incontextof this)(4); } }
      // Elements of an instance that is not an Array object are reachable only through methods.
      var l = new L(); l.add(5); l.add(6); log(l.count, l.join("+"), l.hello(), l instanceof "Array");
    `),
    ['C+B 30 200 1 1 0', '701 70100 undefined Integer', '1 1 1', '2 5+6 B 4 1'],
  );
});

test('exceptions: thrown values, native errors and traces', async () => {
  const env = setup();
  const {logs: out} = await run(
    `
    try { throw new Exception("boom"); } catch (e) { log("caught", e.message); }
    try { throw 42; } catch (e) { log("value", e); }
    try { var z = null; z.foo(); } catch (e) { log("native", e.message, "[" + e.trace + "]"); }
    function f() { undefinedName.x = 1; }
    try { f(); } catch (e) { log("member", e.message, e.trace); }
    try { try { throw "inner"; } catch { throw "outer"; } } catch (e) { log(e); }
    function g(n) { if (n > 0) return g(n - 1); throw new Exception("deep"); }
    g(2);
    `,
    {env},
  ).catch((e) => ({error: e, logs: env.logs}));
  assert.deepEqual(out, [
    'caught boom',
    'value 42',
    'native Accessing to null object []',
    'member Member "undefinedName" does not exist test.tjs(6)[(top level script) global]',
    'outer',
  ]);
  await assert.rejects(
    run('function g(n) { if (n > 0) return g(n - 1); throw new Exception("deep"); }\ng(2);'),
    (e) =>
      e instanceof TjsScriptError &&
      e.message === 'script exception : deep' &&
      e.trace ===
        'test.tjs(1)[(function) g] <-- test.tjs(1)[(function) g] <-- ' +
          'test.tjs(1)[(function) g] <-- test.tjs(2)[(top level script) global]',
  );
});

test('with, switch, incontextof, delete and the property operators', async () => {
  assert.deepEqual(
    await logs(`
      var o = %[a: 1, b: %[c: 2]];
      with (o.b) { .c += 5; log(.c); }
      function sw(x) { switch (x) { case 1: return "one"; case "2": return "two"; default: return "d"; case 3: return "three"; } }
      log(sw(1), sw(2), sw(3), sw(4));
      function who() { return this.name; }
      var p = %[name: "p"]; log((who incontextof p)());
      log(delete o.a, delete o.a, typeof o.a);
      var arr = [1, 2, , "x"]; log(arr.count, arr[2] === void, arr[3]);
      var d = %["k" => 2, l: 3]; log(d.k + d["l"]);
      var c = (const) [1, -2, (const) %["k", "v"]]; log(c[1], c[2].k);
    `),
    ['7', 'one two three d', 'p', '1 0 undefined', '4 1 x', '5', '-2 v'],
  );
});

test('string members and sprintf', async () => {
  assert.deepEqual(
    await logs(`
      var s = "Hello, World";
      log(s.length, s[1], s.charAt(4), s.indexOf("o"), s.indexOf("o", 5), s.substring(7), s.substr(0, 5));
      log(s.toUpperCase(), s.toLowerCase(), " x ".trim() + "|", "abc".reverse(), "ab".repeat(3));
      log("%05d|%-4s|%x|%X|%+d|%5.2f|%e|%g|%%".sprintf(42, "ab", 255, 255, 3, 3.14159, 12345.678, 0.0001));
      log("a\\tb".escape(), "a,b,c".split(",").count);
    `),
    [
      '12 e o 4 8 World Hello',
      'HELLO, WORLD hello, world x| cba ababab',
      '00042|ab  |ff|FF|+3| 3.14|1.234568e+004|0.0001|%',
      'a\\tb 3',
    ],
  );
});

test('arguments: defaults, collapsed rest, unnamed expansion and omission', async () => {
  assert.deepEqual(
    await logs(`
      function d(a, b = a * 2) { return a + b; }
      function rest(a, r*) { return r.count; }
      function pass(*) { return rest(*); }
      function omit(a, b) { return d(...); }
      var ex = [5, 6];
      log(d(1), d(1, 1), rest(1, 2, 3, 4), pass(1, 2, 3), rest(0, ex*), omit(10, 1), omit(10));
    `),
    ['3 2 3 2 2 11 30'],
  );
});

test('suspension resumes frames: nested calls, getters, constructors, try and eval', async () => {
  const {logs: out, result} = await run(`
    function inner(x) { return wait(x) + 1; }
    function outer() { var r = 0; for (var i = 0; i < 3; i++) r += inner(i); return r; }
    log("outer", outer());
    class K { var v = 5; property p { getter { return wait(v) * 3; } } function K() { v = wait(9); } }
    var k = new K(); log("k", k.v, k.p);
    try { log(wait("t")); throw new Exception("after"); } catch (e) { log("caught", e.message); }
    try { waitFail(); } catch (e) { log("async", e.message); }
    log("array", [3, wait(4), 5][1], "eval", "wait(11) + 1"!);
    return wait("done");
  `);
  assert.deepEqual(out, [
    'outer 6',
    'k 9 27',
    't',
    'caught after',
    'async async failure',
    'array 4 eval 12',
  ]);
  assert.equal(result, '(string)"done"');
});

test('stale registers keep objects alive until the register stack is compacted', async () => {
  const env = setup();
  await run(
    `
    class Foo { var n; function Foo(x) { n = x; } function finalize() { log("finalize", n); } }
    new Array();
    function f() { var o = new Foo(1); }
    f(); log("after f");
    var g = new Foo(2); invalidate g; log("after invalidate");
    `,
    {env},
  );
  assert.deepEqual(env.logs, ['after f', 'finalize 2', 'after invalidate']);
  env.vm.vm.stack.compact();
  assert.deepEqual(env.logs.slice(3), ['finalize 1']);
});

test('TJS2 bytecode holds the generated code and runs the same', async () => {
  const text = `
    class A { var v = 3; function A() {} function get(x = 4) { return v * x; } }
    function main(items*) { var s = 0; for (var i = 0; i < items.count; i++) s += items[i]; return s; }
    return main(1, 2, 3) + (new A()).get() + "!";
  `;
  const r = generateScriptBlock({text, name: 'b.tjs', mode: 'statements'}, compilerOptions());
  const bytes = writeTjs2ByteCode(r.code);
  assert.ok(isTjs2ByteCode(bytes));
  const back = readTjs2ByteCode(bytes, 'b.tjs');
  assert.deepEqual(
    back.contexts.map((c) => [...c.code]),
    r.code.contexts.map((c) => [...c.code]),
  );
  const env = setup();
  const result = new VariantSlot();
  await env.engine.suspender.run(() => env.vm.runByteCode(bytes, 'b.tjs', result, null));
  assert.equal(V.readableString(result.value), '(string)"18!"');
  assert.equal(env.vm.runByteCode(new Uint8Array(8), 'x', null, null), null);
});

test('compile errors are printed and thrown with the native message', async () => {
  const env = setup();
  await assert.rejects(
    run('var a = 1;\nvar b = ;', {env}),
    (e) =>
      e instanceof TjsCompileError &&
      e.message === 'Syntax error (syntax error)' &&
      e.source.line === 2,
  );
  assert.deepEqual(env.logs, ['console: Syntax error (syntax error) at line 2']);
});

test('the lowered stage survives the NIF text form', () => {
  const r = generateScriptBlock(
    {
      text: 'class C { function f(a, *) { return a ? [1, , 2] : %[k: 1.5, n: NaN]; } } var x = <% 01 ff %>;',
      name: 't.tjs',
      mode: 'statements',
    },
    compilerOptions(),
  );
  const text = writeNif(r.lowered, [r.loweredRoot]);
  const back = readNif(text, r.lowered.pool, r.lowered.tags);
  assert.ok(back.buffer.sameTree(back.roots[0], r.lowered, r.loweredRoot));
});

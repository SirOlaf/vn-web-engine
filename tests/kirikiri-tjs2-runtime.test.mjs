import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CustomObject,
  tjsHash,
  tjsDoRehash,
} from '../dist/engines/kirikiri/tjs2/runtime/custom-object.js';
import {
  TJS_E_ACCESSDENYED,
  TJS_E_INVALIDOBJECT,
  TJS_E_MEMBERNOTFOUND,
  TJS_E_SUSPENDED,
  TJS_IGNOREPROP,
  TJS_MEMBERENSURE,
  TJS_OP_ADD,
  TJS_OP_INC,
  TJS_S_FALSE,
  TJS_S_OK,
  TJS_S_TRUE,
  TJS_CII_SET_MISSING,
} from '../dist/engines/kirikiri/tjs2/runtime/interface.js';
import {
  NativeClass,
  NativeFunction,
  NativeInstanceBase,
  constructNativeInstance,
} from '../dist/engines/kirikiri/tjs2/runtime/native.js';
import {VariantSlot} from '../dist/engines/kirikiri/tjs2/runtime/slot.js';
import {Suspender} from '../dist/engines/kirikiri/tjs2/runtime/suspension.js';
import {
  TjsError,
  TjsSuspensionError,
  TjsVariantError,
} from '../dist/engines/kirikiri/tjs2/runtime/errors.js';
import * as V from '../dist/engines/kirikiri/tjs2/runtime/variant.js';

const S = (s) => V.str(s);
const I = (n) => V.int(n);

function get(o, name, flag = 0) {
  const r = new VariantSlot();
  const hr = o.propGet(flag, name, r, o);
  return {hr, value: r.value};
}

function keys(o) {
  const names = [];
  const cb = new NativeFunction((result, args) => {
    names.push(V.asString(args[0]));
    result?.set(V.int(1));
    return TJS_S_OK;
  });
  o.enumMembers(TJS_IGNOREPROP, V.obj(cb), o);
  return names;
}

test('variant conversions follow tTJSVariant', () => {
  assert.equal(V.asInteger(S('0x10')), 16n);
  assert.equal(V.asInteger(S('  12')), 0n, 'TJSParseNumber does not skip leading spaces');
  assert.equal(V.asInteger(S('-3.9')), -3n);
  assert.equal(V.asInteger(V.real(NaN)), -(1n << 63n));
  assert.equal(V.asBoolean(S('abc')), false);
  assert.equal(V.asBoolean(S('0')), false);
  assert.equal(V.asBoolean(S('2')), true);
  assert.equal(V.asString(V.VOID), '');
  assert.equal(V.asInt32(V.integer(0x1_0000_0005n)), 5);
  assert.throws(() => V.asString(V.octet(new Uint8Array([1]))), TjsVariantError);
});

test('reals print as %.15lg of the old MSVC CRT', () => {
  const cases = [
    [1, '1'],
    [0.1, '0.1'],
    [1 / 3, '0.333333333333333'],
    [1e20, '1e+020'],
    [1.5e-7, '1.5e-007'],
    [123456789012345, '123456789012345'],
    [1234567890123456, '1.23456789012346e+015'],
    [0.0001, '0.0001'],
    [-2.5, '-2.5'],
  ];
  for (const [r, s] of cases) assert.equal(V.realToString(r), s, String(r));
  assert.equal(V.realToString(0), '+0.0');
  assert.equal(V.realToString(-0), '-0.0');
  assert.equal(V.realToString(-Infinity), '-Infinity');
  assert.equal(V.realToHexString(1), '0x1.0000000000000p0');
  assert.equal(V.readableString(S('a\nb')), '(string)"a\\nb"');
});

test('operators keep Integer and Real apart', () => {
  assert.deepEqual(V.add(I(1), I(2)), I(3));
  assert.equal(V.add(I(1), V.real(2)).type, V.VariantType.Real);
  assert.deepEqual(V.add(S('a'), I(1)), S('a1'));
  assert.deepEqual(V.add(V.VOID, I(4)), I(4));
  assert.equal(V.div(I(4), I(2)).type, V.VariantType.Real);
  assert.deepEqual(V.idiv(I(-7), I(2)), I(-3));
  assert.throws(() => V.mod(I(1), I(0)), TjsVariantError);
  assert.deepEqual(V.add(V.integer((1n << 63n) - 1n), I(1)), V.integer(-(1n << 63n)));
  assert.deepEqual(V.shiftRight(I(-8), I(64)), I(-1));
  assert.deepEqual(V.shiftRightUnsigned(I(-1), I(60)), I(15));
  assert.ok(V.normalCompare(S('1'), I(1)));
  assert.ok(V.normalCompare(V.VOID, S('')));
  assert.ok(V.normalCompare(V.VOID, I(0)));
  assert.ok(!V.discernCompare(I(1), V.real(1)));
  assert.ok(V.greaterThan(I(1), I(2)), 'GreaterThan is a < b');
  assert.deepEqual(V.increment(S('5')), I(6));
});

test('members enumerate in native hash-table order', () => {
  // Five names in bucket 0 of the 8-bucket table, three in bucket 1.
  const byBucket = new Map();
  for (let i = 0; byBucket.size < 2 || [...byBucket.values()].some((v) => v.length < 5); i++) {
    const name = 'm' + i;
    const b = tjsHash(name) & 7;
    if (b > 1) continue;
    if (!byBucket.has(b)) byBucket.set(b, []);
    if (byBucket.get(b).length < 5) byBucket.get(b).push(name);
  }
  const b0 = byBucket.get(0),
    b1 = byBucket.get(1);
  const o = new CustomObject();
  for (const n of [...b1.slice(0, 3), ...b0]) o.propSet(TJS_MEMBERENSURE, n, S(n), o);
  // Bucket 0: chain holds later inserts, each inserted right after the head; head last.
  const expected0 = [b0[4], b0[3], b0[2], b0[1], b0[0]];
  const expected1 = [b1[2], b1[1], b1[0]];
  assert.deepEqual(keys(o), [...expected0, ...expected1]);
  // A lookup more than two links deep moves the entry to the chain front.
  assert.equal(get(o, b0[1]).value.value, b0[1]);
  assert.deepEqual(keys(o).slice(0, 5), [b0[1], b0[4], b0[3], b0[2], b0[0]]);
  // A deleted head leaves its bucket slot unused; the chain keeps its order.
  assert.equal(o.deleteMember(0, b0[0], o), TJS_S_OK);
  assert.deepEqual(keys(o).slice(0, 4), [b0[1], b0[4], b0[3], b0[2]]);
  assert.equal(o.count, 7);
  // Rehash rebuilds the table for the member count.
  tjsDoRehash();
  get(o, b1[0]);
  assert.equal(keys(o).length, 7);
});

test('properties, operations and missing members', () => {
  const o = new CustomObject();
  assert.equal(o.propSet(0, 'x', I(1), o), TJS_E_MEMBERNOTFOUND);
  o.propSet(TJS_MEMBERENSURE, 'x', I(1), o);
  const r = new VariantSlot();
  assert.equal(o.operation(TJS_OP_ADD, 'x', r, I(2), o), TJS_S_OK);
  assert.deepEqual(r.value, I(3));
  o.operation(TJS_OP_INC, 'x', null, null, o);
  assert.deepEqual(get(o, 'x').value, I(4));

  const seen = [];
  const missing = new NativeFunction((result, args) => {
    seen.push([V.asInteger(args[0]), V.asString(args[1])]);
    if (V.asInteger(args[0]) === 0n) args[2].object.propSet(0, null, S('found'), null);
    result?.set(V.int(1));
    return TJS_S_OK;
  });
  o.propSet(TJS_MEMBERENSURE, 'missing', V.obj(missing), o);
  o.classInstanceInfo(TJS_CII_SET_MISSING, 0, new VariantSlot(S('missing')));
  assert.deepEqual(get(o, 'nothing').value, S('found'));
  assert.equal(o.propSet(0, 'other', I(9), o), TJS_S_OK);
  assert.deepEqual(seen, [
    [0n, 'nothing'],
    [1n, 'other'],
  ]);
});

class CounterInstance extends NativeInstanceBase {
  value = 0;
  invalidated = false;
  construct(args) {
    this.value = args.length ? Number(V.asInteger(args[0])) : 0;
    return TJS_S_OK;
  }
  invalidate() {
    this.invalidated = true;
  }
}

function counterClass() {
  const cls = new NativeClass('Counter', () => new CounterInstance());
  cls
    .constructorMethod((_result, args, objthis) => {
      const ni = constructNativeInstance(cls, args, objthis);
      return typeof ni === 'number' ? ni : TJS_S_OK;
    })
    .method('add', (result, args, objthis) => {
      const ni = cls.instanceOf(objthis);
      ni.value += Number(V.asInteger(args[0]));
      result?.set(V.int(ni.value));
      return TJS_S_OK;
    })
    .property('value', {
      get: (result, objthis) => (result.set(V.int(cls.instanceOf(objthis).value)), TJS_S_OK),
    })
    .staticMethod('make', () => TJS_S_OK);
  return cls;
}

test('native classes create instances with bound members', () => {
  const cls = counterClass();
  const out = {value: null};
  assert.equal(cls.createNew(0, null, out, [I(5)], null), TJS_S_OK);
  const inst = out.value;
  const r = new VariantSlot();
  assert.equal(inst.funcCall(0, 'add', r, [I(3)], inst), TJS_S_OK);
  assert.deepEqual(r.value, I(8));
  assert.deepEqual(get(inst, 'value').value, I(8));
  assert.equal(inst.propSet(0, 'value', I(1), inst), TJS_E_ACCESSDENYED);
  assert.equal(get(inst, 'make').hr, TJS_E_MEMBERNOTFOUND, 'static members stay on the class');
  assert.equal(inst.isInstanceOf(0, null, 'Counter', null), TJS_S_TRUE);
  assert.equal(inst.isInstanceOf(0, null, 'Layer', null), TJS_S_FALSE);
  assert.equal(cls.isInstanceOf(0, null, 'Class', null), TJS_S_TRUE);
  // Methods copied into the instance are bound to it without holding a reference.
  const m = new VariantSlot();
  inst.propGet(TJS_IGNOREPROP, 'add', m, inst);
  assert.equal(m.value.objthis, inst);
  m.clear(); // the slot held a reference on the instance
  const ni = cls.instanceOf(inst);
  assert.equal(inst.release(), 0);
  assert.ok(ni.invalidated);
  assert.equal(inst.funcCall(0, 'add', null, [I(1)], inst), TJS_E_INVALIDOBJECT);
});

test('invalidate runs finalize once', () => {
  const o = new CustomObject();
  let calls = 0;
  const fin = new NativeFunction(() => (calls++, TJS_S_OK));
  o.propSet(TJS_MEMBERENSURE, 'finalize', V.obj(fin), o);
  assert.equal(o.invalidate(0, null, o), TJS_S_TRUE);
  assert.equal(o.invalidate(0, null, o), TJS_E_INVALIDOBJECT);
  assert.equal(o.isValid(0, null, o), TJS_S_FALSE);
  o.release();
  assert.equal(calls, 1);
});

test('suspended calls resume innermost first', async () => {
  const s = new Suspender();
  const log = [];
  const slot = new VariantSlot();
  // leaf: waits, then writes into the caller's slot
  const leaf = (out) =>
    s.suspend(Promise.resolve('text'), (v) => {
      log.push('leaf ' + v);
      out.set(S(v));
      return TJS_S_OK;
    });
  // middle: has work after the leaf, then suspends a second time
  const middle = () => {
    const hr = leaf(slot);
    const after = () => {
      log.push('middle after ' + V.asString(slot.value));
      return s.suspend(Promise.resolve(2), (n) => (log.push('again ' + n), TJS_S_OK));
    };
    if (hr === TJS_E_SUSPENDED) return s.defer(after);
    return after();
  };
  const top = () => {
    const hr = middle();
    if (hr === TJS_E_SUSPENDED) return s.defer(() => (log.push('top'), 7));
    return 7;
  };
  assert.equal(await s.run(top), 7);
  assert.deepEqual(log, ['leaf text', 'middle after text', 'again 2', 'top']);

  // Rejections are thrown into the chain; nonSuspending regions refuse to wait.
  await assert.rejects(
    s.run(() => s.suspend(Promise.reject(new TjsError('io')), () => 0)),
    TjsError,
  );
  await assert.rejects(
    s.run(() => s.nonSuspending(() => s.suspend(Promise.resolve(1), () => 0))),
    TjsSuspensionError,
  );
  // A swallowed suspension is reported.
  await assert.rejects(
    s.run(() => (s.suspend(Promise.resolve(1), () => 0), TJS_S_OK)),
    TjsSuspensionError,
  );
});

// --- built-in classes ---------------------------------------------------------------------

const {TjsEngine} = await import('../dist/engines/kirikiri/tjs2/runtime/engine.js');
const {MersenneTwister, MsvcRand} =
  await import('../dist/engines/kirikiri/tjs2/runtime/builtins/math.js');
const {msvcSort} = await import('../dist/engines/kirikiri/tjs2/runtime/msvc-sort.js');

function testEngine(files = {}) {
  const written = {};
  const host = {
    readText: (name) => (name in files ? files[name] : Promise.resolve(files['async:' + name])),
    openTextWrite: (name) => {
      written[name] = '';
      return {write: (t) => (written[name] += t), close() {}};
    },
    print() {},
    time: () => 1,
  };
  return {engine: new TjsEngine(host), written};
}

function call(target, name, args = [], objthis = target) {
  const r = new VariantSlot();
  const hr = target.funcCall(0, name, r, args, objthis);
  assert.ok(hr >= 0, `${name} failed with ${hr}`);
  return r.take();
}

test('Array elements, methods and std::sort order', () => {
  const {engine} = testEngine();
  const a = engine.createArray();
  call(a, 'push', [I(3), I(1), I(2)]);
  assert.deepEqual(get(a, '1').value, I(1));
  assert.deepEqual(get(a, '-1').value, I(2), 'negative indices count from the end');
  assert.deepEqual(get(a, '10').value, V.VOID);
  a.propSetByNum(0, 5, S('x'), a);
  assert.deepEqual(call(a, 'join', [S(',')]), S('3,1,2,,,x'));
  a.propSet(0, 'count', I(3), a);
  call(a, 'sort');
  assert.deepEqual(call(a, 'join', [S(',')]), S('1,2,3'));
  call(a, 'sort', [S('-')]);
  assert.deepEqual(call(a, 'join', [S(',')]), S('3,2,1'));
  assert.deepEqual(call(a, 'find', [I(2)]), I(1));
  assert.deepEqual(call(a, 'pop'), I(1));
  call(a, 'split', [S(',;'), S('a,b;;c')]);
  assert.deepEqual(call(a, 'join', [S('|')]), S('a|b||c'));
  call(a, 'split', [S(','), S(',a,'), V.VOID, I(1)]);
  assert.deepEqual(call(a, 'join', [S('|')]), S('a'));
  assert.throws(() => call(a, 'erase', [I(5)]), TjsError);

  // Equal keys: the unstable sort's order is the VC++ introsort's.
  const items = Array.from({length: 40}, (_, i) => ({k: i % 3, i}));
  msvcSort(items, (x, y) => x.k < y.k);
  assert.deepEqual(
    items.map((x) => x.k),
    Array.from({length: 40}, (_, i) => (i < 14 ? 0 : i < 27 ? 1 : 2)),
  );
  assert.ok(items.some((x, n) => n > 0 && x.k === items[n - 1].k && x.i < items[n - 1].i));
});

test('Array.load suspends on asynchronous storage', async () => {
  const {engine} = testEngine({'sync.txt': 'a\r\nb\nc', 'async:late.txt': 'x\ny\n'});
  const a = engine.createArray();
  call(a, 'load', [S('sync.txt')]);
  assert.deepEqual(call(a, 'join', [S(',')]), S('a,b,c'));
  const r = new VariantSlot();
  assert.equal(
    await engine.suspender.run(() => a.funcCall(0, 'load', r, [S('late.txt')], a)),
    TJS_S_OK,
  );
  assert.deepEqual(call(a, 'join', [S(',')]), S('x,y'));
  r.clear();
  // Outside a top-level run there is nothing to resume; the call refuses to wait.
  assert.throws(() => a.funcCall(0, 'load', null, [S('late.txt')], a), TjsSuspensionError);
});

test('Dictionary reads missing members as void; methods are static', () => {
  const {engine, written} = testEngine();
  const d = engine.createDictionary();
  assert.deepEqual(get(d, 'missing'), {hr: TJS_S_OK, value: V.VOID});
  assert.equal(get(d, 'assign').value.type, V.VariantType.Void);
  const cls = engine.dictionaryClass;
  const src = engine.createArray();
  call(src, 'push', [S('b'), I(2), S('a'), S('x"y')]);
  const assign = new VariantSlot();
  cls.propGet(0, 'assign', assign, cls);
  assert.equal(assign.value.object.funcCall(0, null, null, [V.obj(src)], d), TJS_S_OK);
  assert.deepEqual(get(d, 'b').value, I(2));
  const inc = new VariantSlot();
  d.operation(TJS_OP_INC, 'n', inc, null, d);
  assert.deepEqual(inc.value, I(1), 'operations on a missing member start from void');
  const save = new VariantSlot();
  cls.propGet(0, 'saveStruct', save, cls);
  save.value.object.funcCall(0, null, null, [S('out.txt')], d);
  const text = written['out.txt'];
  assert.ok(text.startsWith('(const) %[\r\n'));
  assert.ok(text.includes(' "a" => "x\\"y"'));
  assert.ok(text.includes(' "n" => 1'));
  assert.ok(text.endsWith('\r\n]'));
  // Deep copy keeps nesting and breaks recursion.
  const inner = engine.createArray();
  call(inner, 'push', [I(7)]);
  d.propSet(TJS_MEMBERENSURE, 'list', V.obj(inner, inner), d);
  d.propSet(TJS_MEMBERENSURE, 'self', V.obj(d, d), d);
  const copy = engine.createDictionary();
  const assignStruct = new VariantSlot();
  cls.propGet(0, 'assignStruct', assignStruct, cls);
  assignStruct.value.object.funcCall(0, null, null, [V.obj(d)], copy);
  const list = get(copy, 'list').value;
  assert.notEqual(list.object, inner);
  assert.deepEqual(call(list.object, 'join', [S(',')]), S('7'));
  assert.equal(get(copy, 'self').value.object, null);
});

test('Math.random is the CRT rand; RandomGenerator is MT19937', () => {
  const r = new MsvcRand();
  r.srand(1);
  assert.deepEqual([r.rand(), r.rand(), r.rand()], [41, 18467, 6334]);
  const {engine} = testEngine();
  const math = get(engine.global, 'Math').value.object;
  assert.deepEqual(call(math, 'random', [], math), V.real(41 / 32767));
  assert.deepEqual(call(math, 'round', [V.real(-2.5)], math), V.real(-2));
  assert.deepEqual(call(math, 'max', [I(1), V.real(3.5), I(2)], math), V.real(3.5));
  assert.equal(MersenneTwister.fromSeed(5489).int32(), 3499211612);
  assert.equal(MersenneTwister.fromKey([0x123, 0x234, 0x345, 0x456]).int32(), 1067595299);
  const RG = get(math, 'RandomGenerator').value.object;
  const out = {value: null};
  assert.equal(RG.createNew(0, null, out, [I(42)], RG), TJS_S_OK);
  const g = out.value;
  const first = call(g, 'random32');
  const state = call(g, 'serialize');
  const second = call(g, 'random32');
  const out2 = {value: null};
  RG.createNew(0, null, out2, [state], RG);
  assert.deepEqual(call(out2.value, 'random32'), second);
  assert.notDeepEqual(first, second);
});

test('Exception objects carry message and trace', () => {
  const {engine} = testEngine();
  const e = engine.exceptionObject('boom', 'here');
  assert.deepEqual(get(e.object, 'message').value, S('boom'));
  assert.deepEqual(get(e.object, 'trace').value, S('here'));
  assert.equal(e.object.isInstanceOf(0, null, 'Exception', null), TJS_S_TRUE);
});

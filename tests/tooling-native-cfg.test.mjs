import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {emitCfgTypeScript, validateCfgModule} from '../tools/native-lift/cfg.mjs';
import {loadDatabase} from '../tools/native-lift/database.mjs';
import {
  createDatabase,
  createModule,
  createLoopModule,
  ref,
} from '../tools/native-lift/examples/cfg/fixtures.mjs';

// Reviewed ordinary synthetic CFGs and JavaScript adapters only. Generated code
// runs on in-memory values; no executable, engine, game, media or native probe.
async function compile(t, module = createModule(), database = createDatabase()) {
  const directory = await mkdtemp(path.join(tmpdir(), 'native-cfg-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const file = path.join(directory, 'generated.ts');
  const generated = emitCfgTypeScript(module, database, {fromFile: file});
  await writeFile(file, generated.source);
  return {...generated, runtime: await import(pathToFileURL(file).href)};
}

test('CFG diamond uses database parameter types and imports the real mapped reference implementation', async (t) => {
  const generated = await compile(t);
  const left = {count: 0},
    right = {count: 0};
  assert.equal(generated.runtime.lifted(left, 4, false, 'abc'), 39);
  assert.equal(generated.runtime.lifted(right, 4, true, 'abc'), 42);
  assert.equal(left.count, 1);
  assert.equal(right.count, 1);
  assert.match(generated.source, /import \{bump as mapped_/);
  assert.match(generated.source, /context: mapping_CounterState_/);
  assert.match(generated.source, /opaqueValue: unknown/);
  assert.doesNotMatch(generated.source, /\bany\b|implementations\[/);
  assert.deepEqual(generated.report.functions[0].dominators.join, ['entry', 'join']);
});

test('CFG loops preserve simultaneous predecessor phis and report backedges and SCCs', async (t) => {
  const generated = await compile(t, createLoopModule());
  for (const [count, expected] of [
    [0, 10],
    [1, 20],
    [2, 10],
    [7, 20],
  ])
    assert.equal(generated.runtime.lifted(count), expected);
  assert.deepEqual(generated.report.functions[0].backedges, [{from: 'body', to: 'loop'}]);
  assert.deepEqual(generated.report.functions[0].loopComponents, [['body', 'loop']]);
  const database = createDatabase();
  database.types.push({
    id: 'BigCounter',
    kind: 'integer',
    bits: 32,
    signed: false,
    representation: 'bigint',
  });
  database.implementations.find((item) => item.id === 'swapLoop').signature.parameters[0].type = {
    named: 'BigCounter',
  };
  database.functions.find((item) => item.implementation === 'swapLoop').abi.parameters[0].type = {
    named: 'BigCounter',
  };
  const represented = await compile(t, createLoopModule(), database);
  assert.equal(represented.runtime.lifted(3n), 20);
  assert.match(represented.source, /lifted\(count: bigint\)/);
  for (const parameterName of ['createExecution', 'cfgExecutionFactory']) {
    const renamed = createDatabase(),
      module = createLoopModule();
    renamed.implementations.find((item) => item.id === 'swapLoop').signature.parameters[0].name =
      parameterName;
    const native = renamed.functions.find((item) => item.implementation === 'swapLoop');
    native.abi.parameters[0].name = parameterName;
    native.abi.arguments[0] = {
      parameter: parameterName,
      source: {kind: 'parameter', name: parameterName},
    };
    module.functions[0].parameterValues = {[parameterName]: 'limit'};
    const safe = await compile(t, module, renamed);
    assert.equal(safe.runtime.lifted(3), 20);
  }
});

test('CFG finite code variants dispatch from active stack frames and restore nested previous bodies', async (t) => {
  const generated = await compile(t);
  const execution = generated.runtime.createExecution();
  assert.equal(execution.invoke({count: 0}, 4, false, 'abc'), 39);
  const calls = execution
    .getTrace()
    .filter((event) => event.event === 'call' && event.family === 'math');
  assert.deepEqual(
    calls.map((event) => event.selectorValue),
    [1, 0, 1],
  );
  assert.deepEqual(
    calls.map((event) => event.scopeId),
    ['outerMath', 'innerMath', 'outerMath'],
  );
  assert.deepEqual(execution.getActiveDepths(), {math: 1, shape: 0});
  assert.match(generated.source, /top_0\(\)\.target\["call"\]/);
  assert.match(generated.source, /function generated_2/);
  assert.equal(generated.report.functions[2].variant.kind, 'decoded-body');
  assert.equal(
    generated.report.functions[1].provenance.entryAddress,
    generated.report.functions[2].provenance.entryAddress,
  );
  assert.notEqual(
    generated.report.functions[1].provenance.bodySha256,
    generated.report.functions[2].provenance.bodySha256,
  );
  const ordinaryCalls = createModule();
  const target = {
    binarySha256: ordinaryCalls.functions[0].provenance.binary.executableSha256,
    rva: '0x2000',
  };
  ordinaryCalls.functions[0].blocks[3].operations =
    ordinaryCalls.functions[0].blocks[3].operations.map((op) =>
      op.opcode === 'VARIANT_CALL' && op.family === 'math'
        ? {id: op.id, opcode: 'CALL', target, arguments: op.arguments, source: op.source}
        : op,
    );
  const routed = await compile(t, ordinaryCalls);
  assert.equal(routed.runtime.lifted({count: 0}, 4, false, 'abc'), 39);
  const routes = routed.report.functions[0].calls.filter(
    (call) => call.nativeTarget?.rva === '0x2000',
  );
  assert.equal(routes.length, 3);
  assert.ok(
    routes.every(
      (call) =>
        call.route === 'variant-stack' && call.family === 'math' && call.operation === 'call',
    ),
  );
  const ambiguous = createDatabase();
  ambiguous.variantFamilies.push({
    ...structuredClone(ambiguous.variantFamilies[0]),
    id: 'otherMath',
  });
  assert.throws(
    () => validateCfgModule(ordinaryCalls, ambiguous),
    (error) => error.code === 'CFG_VARIANT_ROUTE',
  );
});

test('CFG type adapters remain unknown until selected and finally restores stacks after exceptions', async (t) => {
  const generated = await compile(t),
    execution = generated.runtime.createExecution();
  assert.throws(
    () => execution.invoke({count: 0}, 4, false, []),
    /explicitly selected text representation/,
  );
  assert.deepEqual(execution.getActiveDepths(), {math: 1, shape: 0});
  assert.ok(
    execution.getTrace().some((event) => event.event === 'unwind' && event.family === 'shape'),
  );
  assert.deepEqual(
    execution
      .getTrace()
      .filter((event) => event.event === 'unwind')
      .map((event) => event.family),
    ['shape', 'math'],
  );
  assert.equal(execution.invoke({count: 0}, 4, false, 'abc'), 39);
  const selected = createModule();
  selected.functions[0].blocks[3].operations.find(
    (op) => op.scopeId === 'textShape' && op.opcode === 'PUSH_VARIANT',
  ).selectorValue = 1;
  const list = await compile(t, selected);
  assert.equal(list.runtime.lifted({count: 0}, 4, false, [1, 2]), 38);
  const unknown = createModule();
  unknown.functions[0].blocks[3].operations = unknown.functions[0].blocks[3].operations.filter(
    (op) => op.scopeId !== 'textShape',
  );
  const noSelection = await compile(t, unknown);
  assert.throws(
    () => noSelection.runtime.lifted({count: 0}, 4, false, 'abc'),
    /No active variant for shape/,
  );
});

test('CFG validation rejects missing phis, non-dominating values, unsupported ops and implicit coercion', () => {
  const database = createDatabase();
  const missing = createModule();
  delete missing.functions[0].blocks[3].phis[0].incoming.basePath;
  assert.throws(
    () => validateCfgModule(missing, database),
    (error) => error.code === 'CFG_PHI',
  );
  const dominance = createModule();
  dominance.functions[0].blocks[3].operations.find((op) => op.id === 'outer').arguments.value =
    ref('adjusted');
  assert.throws(
    () => validateCfgModule(dominance, database),
    (error) => error.code === 'CFG_DOMINANCE',
  );
  const unsupported = createModule();
  unsupported.functions[1].blocks[0].operations[0].opcode = 'CALLOTHER';
  assert.throws(
    () => emitCfgTypeScript(unsupported, database),
    (error) => error.code === 'CFG_UNSUPPORTED',
  );
  const coercion = createModule();
  coercion.functions[0].blocks[3].operations.find((op) => op.id === 'signedLength').inputs[0] =
    ref('opaque');
  assert.throws(
    () => validateCfgModule(coercion, database),
    (error) => error.code === 'CFG_TYPE',
  );
  const wrongCall = createModule();
  wrongCall.functions[0].blocks[0].operations[0].arguments.context = ref('input');
  assert.throws(
    () => validateCfgModule(wrongCall, database),
    (error) => error.code === 'CFG_TYPE',
  );
});

test('CFG validation rejects leaked variant scopes, mismatched joins and unreviewed variant bodies', () => {
  const database = createDatabase();
  const leaked = createModule();
  leaked.functions[0].blocks[3].operations = leaked.functions[0].blocks[3].operations.filter(
    (op) => !(op.opcode === 'POP_VARIANT' && op.scopeId === 'outerMath'),
  );
  assert.throws(
    () => validateCfgModule(leaked, database),
    (error) => error.code === 'CFG_VARIANT_STACK',
  );
  const join = createModule(),
    original = join.functions[0].blocks[3].operations.find((op) => op.opcode === 'PUSH_VARIANT');
  join.functions[0].blocks[1].operations.push({
    ...structuredClone(original),
    scopeId: 'unbalancedPath',
    source: {...original.source, loweringIndex: 1},
  });
  assert.throws(
    () => validateCfgModule(join, database),
    (error) => error.code === 'CFG_VARIANT_STACK',
  );
  const wrongBody = createModule();
  wrongBody.functions[2].provenance.bodySha256 = 'a'.repeat(64);
  assert.throws(
    () => validateCfgModule(wrongBody, database),
    (error) => error.code === 'CFG_VARIANT',
  );
  const wrongBaseBody = createModule();
  wrongBaseBody.functions[1].provenance.bodySha256 = 'b'.repeat(64);
  assert.throws(
    () => validateCfgModule(wrongBaseBody, database),
    (error) => error.code === 'CFG_VARIANT',
  );
  const patched = createModule();
  patched.functions[2].variant = {
    kind: 'reviewed-patch',
    family: 'math',
    selectorValue: 1,
    reviewReference: 'Synthetic patch provenance only; no native execution',
    baseBodySha256: patched.functions[1].provenance.bodySha256,
    patches: [
      {
        address: patched.functions[2].provenance.entryAddress,
        originalHex: '01',
        replacementHex: '02',
      },
    ],
  };
  assert.equal(validateCfgModule(patched, database).report.status, 'reviewed-cfg-prototype');
  for (const baseHash of [
    'c'.repeat(64),
    patched.functions[0].provenance.bodySha256,
    patched.functions[2].provenance.bodySha256,
  ]) {
    const invalidPatch = structuredClone(patched);
    invalidPatch.functions[2].variant.baseBodySha256 = baseHash;
    assert.throws(
      () => validateCfgModule(invalidPatch, database),
      (error) => error.code === 'CFG_VARIANT',
    );
  }
  // A registered same-slot base remains valid when its implementation is imported.
  patched.functions.splice(1, 1);
  assert.equal(validateCfgModule(patched, database).report.status, 'reviewed-cfg-prototype');
});

test('checked-in CFG examples load from source-pinned JSON and preserve native sequence expansion', async () => {
  const database = await loadDatabase(
    new URL('../tools/native-lift/examples/cfg/database.json', import.meta.url),
  );
  const module = JSON.parse(
    await readFile(
      new URL('../tools/native-lift/examples/cfg/module.json', import.meta.url),
      'utf8',
    ),
  );
  assert.equal(validateCfgModule(module, database).report.functions.length, 3);
  const adapted = createModule();
  const op = adapted.functions[0].blocks[3].operations.find((op) => op.id === 'signedLength');
  op.source = {...adapted.functions[0].blocks[3].terminator.source, loweringIndex: 1};
  assert.equal(validateCfgModule(adapted, database).report.status, 'reviewed-cfg-prototype');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {runInNewContext} from 'node:vm';
import {
  emitTypeScript,
  inspectMcpPcode,
  resolveRoute,
  sha256,
  slotKey,
  validateLeaf,
} from '../tools/native-lift/index.mjs';

// All fixtures and arithmetic below are synthetic in-memory values. No native
// execution, game loading, media, lifetime reproduction, or suite discovery.
const example = JSON.parse(
  readFileSync(new URL('../tools/native-lift/examples/leaf.json', import.meta.url), 'utf8'),
);
const clone = (value) => structuredClone(value);
const ref = (name) => ({ref: name});
const constant = (value, bits) => ({constant: `0x${value.toString(16)}`, bits});

function leafFor(opcode, inputBits, outputBits) {
  const leaf = clone(example);
  leaf.inputs = inputBits.map((bits, index) => ({id: `arg${index}`, bits}));
  leaf.operations = [
    {
      id: 'result',
      bits: outputBits,
      opcode,
      inputs: leaf.inputs.map((input) => ref(input.id)),
      source: {address: '0x140001000', sequence: 0},
    },
  ];
  leaf.result = ref('result');
  return leaf;
}

function compile(leaf, registry, sources) {
  const {source, receipt} = emitTypeScript(leaf, registry, sources);
  const js = stripTypeScriptTypes(source).replaceAll('export ', '');
  return {call: runInNewContext(`${js}\nlifted;`, {BigInt}), receipt, source};
}

function call(opcode, inputBits, outputBits, args) {
  return compile(leafFor(opcode, inputBits, outputBits)).call(
    Object.fromEntries(args.map((value, index) => [`arg${index}`, value])),
  );
}

const handText = 'export function hand(inputs) { return inputs.arg0; }\n';
const handRoute = {
  kind: 'hand',
  implementation: {
    id: 'synthetic-hand',
    sourcePath: 'synthetic/hand.mjs',
    sourceSha256: sha256(handText),
    exportName: 'hand',
  },
  reviewReference: 'synthetic test review',
};
const emptyRegistry = () => ({schemaVersion: 1, exact: [], patterns: []});
const target = (leaf) => ({
  binary: leaf.binary,
  entryAddress: leaf.entryAddress,
  bodySha256: leaf.bodySha256,
  irSha256: validateLeaf(leaf).irSha256,
});

test('native lift: 64-bit arithmetic preserves wraparound and precision beyond Number', () => {
  assert.equal(compile(example).call({left: (1n << 64n) - 1n, right: 2n}), 1n);
  assert.equal(call('INT_MULT', [64, 64], 64, [(1n << 53n) + 1n, 3n]), 27021597764222979n);
  assert.equal(call('INT_SUB', [8, 8], 8, [0n, 1n]), 255n);
  assert.equal(call('INT_2COMP', [32], 32, [1n]), 0xffffffffn);
  assert.equal(call('INT_NEGATE', [16], 16, [0n]), 65535n);
});

test('native lift: signed comparisons, extensions, and P-code shifts are width-aware', () => {
  assert.equal(call('INT_SLESS', [32, 32], 8, [0xffffffffn, 0n]), 1n);
  assert.equal(call('INT_LESS', [32, 32], 8, [0xffffffffn, 0n]), 0n);
  assert.equal(call('INT_SEXT', [8], 64, [0x80n]), 0xffffffffffffff80n);
  assert.equal(call('INT_ZEXT', [8], 64, [0xffn]), 0xffn);
  assert.equal(call('INT_LEFT', [32, 64], 32, [1n, 32n]), 0n);
  assert.equal(call('INT_RIGHT', [64, 64], 64, [0xffffffffffffffffn, 64n]), 0n);
  assert.equal(call('INT_SRIGHT', [32, 64], 32, [0x80000000n, 0xffffffffffffffffn]), 0xffffffffn);
  assert.equal(call('INT_SRIGHT', [32, 8], 32, [0x7fffffffn, 32n]), 0n);
});

test('native lift: byte-piece operations preserve significance and source provenance', () => {
  assert.equal(call('PIECE', [16, 16], 32, [0x1234n, 0x5678n]), 0x12345678n);
  const leaf = leafFor('SUBPIECE', [64], 16);
  leaf.operations[0].inputs.push(constant(3n, 8));
  const built = compile(leaf);
  assert.equal(built.call({arg0: 0x1122334455667788n}), 0x4455n);
  assert.match(built.source, /0x140001000:0 SUBPIECE/);
  assert.equal(built.receipt.provenance.sourceKind, 'synthetic');
  assert.match(built.receipt.slotKey, /:rva:0x1000$/);
});

test('native lift: unsupported operations and incomplete SSA refuse code generation', () => {
  const unsupported = leafFor('FLOAT_ADD', [64, 64], 64);
  assert.throws(
    () => emitTypeScript(unsupported),
    (error) => error.code === 'UNSUPPORTED' && error.details.operations[0].opcode === 'FLOAT_ADD',
  );
  const missing = clone(example);
  missing.operations[0].inputs[0] = ref('future');
  assert.throws(
    () => emitTypeScript(missing),
    (error) => error.code === 'SSA',
  );
  const unknownField = clone(example);
  unknownField.hiddenStore = true;
  assert.throws(
    () => emitTypeScript(unknownField),
    (error) => error.code === 'SCHEMA',
  );
  assert.throws(
    () => emitTypeScript(leafFor('INT_ADD', [32, 64], 64)),
    (error) => error.code === 'WIDTH',
  );
  assert.throws(
    () => emitTypeScript(leafFor('INT_ZEXT', [32], 32)),
    (error) => error.code === 'WIDTH',
  );
  assert.throws(
    () => slotKey(example.binary, 0x140001000),
    (error) => error.code === 'ADDRESS',
  );
});

test('native lift: exact manual routes pin source, IR, binary and body before binding', () => {
  const leaf = leafFor('UNSUPPORTED_REVIEWED_LEAF', [32], 32);
  const registry = emptyRegistry();
  registry.exact.push({...target(leaf), route: handRoute});
  assert.throws(
    () => emitTypeScript(leaf, registry),
    (error) => error.code === 'IMPLEMENTATION_HASH',
  );
  const built = compile(leaf, registry, new Map([['synthetic-hand', handText]]));
  assert.equal(built.receipt.routeKind, 'exact');
  assert.throws(() => built.call({arg0: 2n}), /Missing explicit implementation binding/);
  assert.equal(
    built.call({arg0: 0x100000002n}, {'synthetic-hand': (inputs) => inputs.arg0 + 5n}),
    7n,
  );
  const staleBody = clone(leaf);
  staleBody.bodySha256 = sha256('different body');
  assert.throws(
    () => emitTypeScript(staleBody, registry),
    (error) => error.code === 'STALE_ROUTE',
  );
  const staleIR = clone(leaf);
  staleIR.operations[0].opcode = 'COPY';
  assert.throws(
    () => emitTypeScript(staleIR, registry),
    (error) => error.code === 'STALE_ROUTE',
  );
  const duplicate = clone(registry);
  duplicate.exact.push(clone(duplicate.exact[0]));
  assert.throws(
    () => emitTypeScript(leaf, duplicate),
    (error) => error.code === 'AMBIGUOUS_ROUTE',
  );
});

test('native lift: structural matches are suggestions until exact version approval', () => {
  const leaf = leafFor('COPY', [32], 32),
    registry = emptyRegistry();
  registry.patterns.push({
    id: 'copy-leaf-v1',
    shapeSha256: validateLeaf(leaf).shapeSha256,
    approvedTargets: [],
    route: handRoute,
  });
  assert.equal(resolveRoute(leaf, registry).routeKind, 'integer-ir');
  assert.deepEqual(resolveRoute(leaf, registry).candidates, ['copy-leaf-v1']);
  registry.patterns[0].approvedTargets.push(target(leaf));
  assert.equal(resolveRoute(leaf, registry).routeKind, 'reviewed-pattern');
  const otherVersion = clone(leaf);
  otherVersion.binary.executableSha256 = sha256('another executable version');
  assert.equal(resolveRoute(otherVersion, registry).routeKind, 'integer-ir');
  const ambiguous = clone(registry);
  ambiguous.patterns.push({...clone(ambiguous.patterns[0]), id: 'other-copy-rule'});
  assert.throws(
    () => resolveRoute(leaf, ambiguous),
    (error) => error.code === 'AMBIGUOUS_ROUTE',
  );
  registry.exact.push({
    ...target(leaf),
    route: {kind: 'blocked', reason: 'Needs a new independent review'},
  });
  assert.throws(
    () => resolveRoute(leaf, registry),
    (error) => error.code === 'BLOCKED_ROUTE',
  );
});

test('native lift: current MCP dumps remain inspection-only even when opcodes look supported', () => {
  const report = inspectMcpPcode({
    name: 'synthetic',
    address: '140001000',
    basic_blocks: [{pcodes: [{mnemonic: 'CAST'}, {mnemonic: 'LOAD'}, {mnemonic: 'RETURN'}]}],
  });
  assert.equal(report.automaticImportAllowed, false);
  assert.deepEqual(report.analysisOnlyOperations, ['CAST']);
  assert.deepEqual(report.unsupportedByIntegerLeaf, ['LOAD', 'RETURN']);
  assert.equal(report.blockers.length, 6);
});

test('native lift: checked-in example route and source evidence stay current', () => {
  const registry = JSON.parse(
    readFileSync(new URL('../tools/native-lift/examples/registry.json', import.meta.url), 'utf8'),
  );
  const source = readFileSync(
    new URL('../tools/native-lift/examples/hand-add.mjs', import.meta.url),
    'utf8',
  );
  const generated = emitTypeScript(example, registry, new Map([['synthetic-add-v1', source]]));
  assert.equal(generated.receipt.routeKind, 'reviewed-pattern');
  assert.equal(generated.receipt.status, 'prototype-only');
});

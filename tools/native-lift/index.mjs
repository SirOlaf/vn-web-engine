import {createHash} from 'node:crypto';

const widths = new Set([8, 16, 32, 64]);
const binaryFields = ['programPath', 'executableSha256', 'languageId', 'imageBase'];
const unary = new Set(['COPY', 'CAST', 'INT_2COMP', 'INT_NEGATE', 'INT_ZEXT', 'INT_SEXT']);
const binary = new Set(['INT_ADD', 'INT_SUB', 'INT_MULT', 'INT_AND', 'INT_OR', 'INT_XOR']);
const compare = new Set([
  'INT_EQUAL',
  'INT_NOTEQUAL',
  'INT_LESS',
  'INT_LESSEQUAL',
  'INT_SLESS',
  'INT_SLESSEQUAL',
]);
const shifts = new Set(['INT_LEFT', 'INT_RIGHT', 'INT_SRIGHT']);
const supported = new Set([...unary, ...binary, ...compare, ...shifts, 'PIECE', 'SUBPIECE']);
const fail = (code, message, details = {}) => {
  throw new LiftError(code, message, details);
};

export class LiftError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'LiftError';
    this.code = code;
    this.details = details;
  }
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

function record(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('SCHEMA', `${label} must be an object`);
  const actual = Object.keys(value);
  if (actual.length !== fields.length || actual.some((field) => !fields.includes(field)))
    fail('SCHEMA', `${label} requires exactly: ${fields.join(', ')}`);
}

function string(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail('SCHEMA', `${label} must be nonempty text`);
}

function hash(value, label) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value))
    fail('SCHEMA', `${label} must be a lowercase SHA-256`);
}

export function address(value) {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value))
    fail('ADDRESS', 'Addresses must be canonical lowercase hexadecimal strings with a 0x prefix');
  return BigInt(value);
}

function identity(value) {
  record(value, binaryFields, 'binary');
  string(value.programPath, 'binary.programPath');
  hash(value.executableSha256, 'binary.executableSha256');
  if (!['x86:LE:32:default', 'x86:LE:64:default'].includes(value.languageId))
    fail('LANGUAGE', 'Only x86 little-endian 32/64-bit identities are accepted');
  const limit = value.languageId === 'x86:LE:32:default' ? 32 : 64;
  if (address(value.imageBase) >= 1n << BigInt(limit))
    fail('ADDRESS', 'Image base exceeds address width');
}

function width(bits) {
  if (!widths.has(bits)) fail('WIDTH', `Unsupported integer width ${bits}`);
}

/** Stable slot identity. Names never participate; the exact executable does. */
export function slotKey(binaryIdentity, entryAddress) {
  identity(binaryIdentity);
  const entry = address(entryAddress),
    base = address(binaryIdentity.imageBase);
  const limit = binaryIdentity.languageId === 'x86:LE:32:default' ? 32 : 64;
  if (entry < base || entry >= 1n << BigInt(limit))
    fail('ADDRESS', 'Entry is outside the executable address width/base');
  return `${binaryIdentity.executableSha256}:${binaryIdentity.languageId}:rva:0x${(entry - base).toString(16)}`;
}

/** Validate the whole leaf before emitting any source or taking any route. */
export function validateLeaf(leaf) {
  record(
    leaf,
    [
      'schemaVersion',
      'kind',
      'symbol',
      'binary',
      'entryAddress',
      'bodyRanges',
      'bodySha256',
      'provenance',
      'inputs',
      'operations',
      'result',
    ],
    'leaf',
  );
  if (leaf.schemaVersion !== 1 || leaf.kind !== 'reviewed-integer-leaf')
    fail('SCHEMA', 'Expected reviewed-integer-leaf schema version 1');
  string(leaf.symbol, 'symbol');
  const key = slotKey(leaf.binary, leaf.entryAddress);
  hash(leaf.bodySha256, 'bodySha256');
  record(
    leaf.provenance,
    ['sourceKind', 'sourceSha256', 'exporter', 'reviewReference', 'assumptions'],
    'provenance',
  );
  if (!['synthetic', 'reviewed-pcode'].includes(leaf.provenance.sourceKind))
    fail('SCHEMA', 'Unknown provenance source kind');
  hash(leaf.provenance.sourceSha256, 'provenance.sourceSha256');
  for (const field of ['exporter', 'reviewReference'])
    string(leaf.provenance[field], `provenance.${field}`);
  if (!Array.isArray(leaf.provenance.assumptions)) fail('SCHEMA', 'assumptions must be an array');
  leaf.provenance.assumptions.forEach((value) => string(value, 'assumption'));
  if (!Array.isArray(leaf.bodyRanges) || leaf.bodyRanges.length === 0)
    fail('SCHEMA', 'Full body ranges are required');
  let previous = -1n;
  for (const range of leaf.bodyRanges) {
    record(range, ['start', 'end'], 'body range');
    const start = address(range.start),
      end = address(range.end);
    if (start <= previous || end < start) fail('BODY', 'Body ranges must be disjoint and ordered');
    slotKey(leaf.binary, range.start);
    slotKey(leaf.binary, range.end);
    previous = end;
  }
  const inBody = (value) =>
    leaf.bodyRanges.some(
      (range) => address(value) >= address(range.start) && address(value) <= address(range.end),
    );
  if (!inBody(leaf.entryAddress)) fail('BODY', 'Exact entry must be in the recorded body');
  if (!Array.isArray(leaf.inputs) || !Array.isArray(leaf.operations))
    fail('SCHEMA', 'inputs and operations must be arrays');
  const values = new Map(),
    sequences = new Set();
  const define = (value) => {
    if (
      typeof value.id !== 'string' ||
      !/^[A-Za-z][A-Za-z0-9_]*$/.test(value.id) ||
      values.has(value.id)
    )
      fail('SSA', 'Value IDs must be unique simple names');
    width(value.bits);
    values.set(value.id, value.bits);
  };
  for (const input of leaf.inputs) {
    record(input, ['id', 'bits'], 'input');
    define(input);
  }
  const operandWidth = (operand) => {
    if (Object.hasOwn(operand ?? {}, 'ref')) {
      record(operand, ['ref'], 'reference');
      if (!values.has(operand.ref)) fail('SSA', `Undefined or forward reference ${operand.ref}`);
      return values.get(operand.ref);
    }
    record(operand, ['constant', 'bits'], 'constant');
    width(operand.bits);
    if (address(operand.constant) >= 1n << BigInt(operand.bits))
      fail('CONSTANT', 'Constant exceeds its unsigned bit width');
    return operand.bits;
  };
  const unsupported = [];
  for (const op of leaf.operations) {
    record(op, ['id', 'bits', 'opcode', 'inputs', 'source'], 'operation');
    record(op.source, ['address', 'sequence'], 'operation.source');
    if (
      !inBody(op.source.address) ||
      !Number.isSafeInteger(op.source.sequence) ||
      op.source.sequence < 0
    )
      fail('PROVENANCE', 'Every operation needs an in-body address and nonnegative sequence');
    const sequenceKey = `${op.source.address}:${op.source.sequence}`;
    if (sequences.has(sequenceKey)) fail('PROVENANCE', 'Duplicate operation source sequence');
    sequences.add(sequenceKey);
    if (!Array.isArray(op.inputs)) fail('SCHEMA', 'Operation inputs must be an array');
    const sizes = op.inputs.map(operandWidth);
    string(op.opcode, 'opcode');
    if (!supported.has(op.opcode)) unsupported.push({opcode: op.opcode, ...op.source});
    else {
      const count = unary.has(op.opcode) ? 1 : 2;
      if (sizes.length !== count) fail('ARITY', `${op.opcode} requires ${count} inputs`);
      let valid;
      if (['INT_ZEXT', 'INT_SEXT'].includes(op.opcode)) valid = op.bits > sizes[0];
      else if (compare.has(op.opcode)) valid = sizes[0] === sizes[1] && op.bits === 8;
      else if (shifts.has(op.opcode)) valid = sizes[0] === op.bits;
      else if (op.opcode === 'PIECE') valid = sizes[0] + sizes[1] === op.bits;
      else if (op.opcode === 'SUBPIECE')
        valid =
          Object.hasOwn(op.inputs[1], 'constant') &&
          BigInt(op.inputs[1].constant) * 8n + BigInt(op.bits) <= BigInt(sizes[0]);
      else valid = sizes.every((bits) => bits === op.bits);
      if (!valid) fail('WIDTH', `Invalid operand/output widths for ${op.opcode}`);
    }
    define(op);
  }
  const resultBits = operandWidth(leaf.result);
  const indices = new Map(leaf.inputs.map((input, index) => [input.id, index]));
  const normalizedOperand = (operand) =>
    Object.hasOwn(operand, 'ref') ? {ref: indices.get(operand.ref)} : operand;
  const operations = leaf.operations.map((op, index) => {
    const normalized = {opcode: op.opcode, bits: op.bits, inputs: op.inputs.map(normalizedOperand)};
    indices.set(op.id, leaf.inputs.length + index);
    return normalized;
  });
  const shapeSha256 = sha256(
    canonicalJson({
      inputs: leaf.inputs.map((input) => input.bits),
      operations,
      result: normalizedOperand(leaf.result),
    }),
  );
  return {key, values, resultBits, unsupported, shapeSha256, irSha256: sha256(canonicalJson(leaf))};
}

const targetFields = ['binary', 'entryAddress', 'bodySha256', 'irSha256'];
function validateTarget(target, extra = []) {
  record(target, [...targetFields, ...extra], 'route target');
  slotKey(target.binary, target.entryAddress);
  hash(target.bodySha256, 'route bodySha256');
  hash(target.irSha256, 'route irSha256');
}

function validateRoute(route, allowBlocked) {
  if (route?.kind === 'blocked' && allowBlocked) {
    record(route, ['kind', 'reason'], 'blocked route');
    string(route.reason, 'blocked reason');
    return;
  }
  record(route, ['kind', 'implementation', 'reviewReference'], 'hand route');
  if (route.kind !== 'hand') fail('ROUTE', 'Unknown route kind');
  string(route.reviewReference, 'route review reference');
  record(
    route.implementation,
    ['id', 'sourcePath', 'sourceSha256', 'exportName'],
    'implementation',
  );
  for (const field of ['id', 'sourcePath', 'exportName'])
    string(route.implementation[field], `implementation.${field}`);
  hash(route.implementation.sourceSha256, 'implementation.sourceSha256');
}

export function validateRegistry(registry) {
  record(registry, ['schemaVersion', 'exact', 'patterns'], 'registry');
  if (
    registry.schemaVersion !== 1 ||
    !Array.isArray(registry.exact) ||
    !Array.isArray(registry.patterns)
  )
    fail('SCHEMA', 'Invalid mapping registry');
  const exactKeys = new Set(),
    patternIds = new Set();
  for (const target of registry.exact) {
    validateTarget(target, ['route']);
    validateRoute(target.route, true);
    const key = slotKey(target.binary, target.entryAddress);
    if (exactKeys.has(key)) fail('AMBIGUOUS_ROUTE', `Duplicate exact route ${key}`);
    exactKeys.add(key);
  }
  for (const pattern of registry.patterns) {
    record(pattern, ['id', 'shapeSha256', 'approvedTargets', 'route'], 'pattern');
    string(pattern.id, 'pattern id');
    hash(pattern.shapeSha256, 'shapeSha256');
    if (patternIds.has(pattern.id)) fail('AMBIGUOUS_ROUTE', `Duplicate pattern ID ${pattern.id}`);
    patternIds.add(pattern.id);
    if (!Array.isArray(pattern.approvedTargets)) fail('SCHEMA', 'approvedTargets must be an array');
    const targetKeys = new Set();
    for (const target of pattern.approvedTargets) {
      validateTarget(target);
      const key = slotKey(target.binary, target.entryAddress);
      if (targetKeys.has(key)) fail('AMBIGUOUS_ROUTE', `Duplicate approved target ${key}`);
      targetKeys.add(key);
    }
    validateRoute(pattern.route, false);
  }
}

export function resolveRoute(leaf, registry = {schemaVersion: 1, exact: [], patterns: []}) {
  const analysis = validateLeaf(leaf);
  validateRegistry(registry);
  const sameSlot = (target) => slotKey(target.binary, target.entryAddress) === analysis.key;
  const assertFresh = (target) => {
    if (
      canonicalJson(target.binary) !== canonicalJson(leaf.binary) ||
      target.entryAddress !== leaf.entryAddress ||
      target.bodySha256 !== leaf.bodySha256 ||
      target.irSha256 !== analysis.irSha256
    )
      fail('STALE_ROUTE', 'A recorded route has changed identity, body, or IR; review is required');
  };
  const exact = registry.exact.find(sameSlot);
  if (exact) {
    assertFresh(exact);
    if (exact.route.kind === 'blocked') fail('BLOCKED_ROUTE', exact.route.reason);
    return {...analysis, route: exact.route, routeKind: 'exact', candidates: []};
  }
  const matches = [],
    candidates = [];
  for (const pattern of registry.patterns) {
    const approved = pattern.approvedTargets.find(sameSlot);
    if (approved) {
      assertFresh(approved);
      if (pattern.shapeSha256 !== analysis.shapeSha256)
        fail('STALE_ROUTE', 'Approved pattern shape changed');
      matches.push(pattern);
    } else if (pattern.shapeSha256 === analysis.shapeSha256) candidates.push(pattern.id);
  }
  if (matches.length > 1)
    fail('AMBIGUOUS_ROUTE', 'Multiple reviewed patterns match this exact target');
  if (matches.length === 1)
    return {...analysis, route: matches[0].route, routeKind: 'reviewed-pattern', candidates};
  return {...analysis, route: null, routeKind: 'integer-ir', candidates};
}

function expression(op, names, values) {
  const read = (operand) =>
    Object.hasOwn(operand, 'ref') ? names.get(operand.ref) : `${operand.constant}n`;
  const bits = (operand) =>
    Object.hasOwn(operand, 'ref') ? values.get(operand.ref) : operand.bits;
  const [a, b] = op.inputs.map(read),
    inputBits = bits(op.inputs[0]);
  const signedA = `BigInt.asIntN(${inputBits}, ${a})`,
    signedB = `BigInt.asIntN(${inputBits}, ${b})`;
  const infix = {
    INT_ADD: '+',
    INT_SUB: '-',
    INT_MULT: '*',
    INT_AND: '&',
    INT_OR: '|',
    INT_XOR: '^',
  };
  if (binary.has(op.opcode)) return `${a} ${infix[op.opcode]} ${b}`;
  if (op.opcode === 'INT_2COMP') return `-${a}`;
  if (op.opcode === 'INT_NEGATE') return `~${a}`;
  if (op.opcode === 'INT_SEXT') return signedA;
  if (unary.has(op.opcode)) return a;
  if (compare.has(op.opcode)) {
    const operators = {
      INT_EQUAL: '===',
      INT_NOTEQUAL: '!==',
      INT_LESS: '<',
      INT_LESSEQUAL: '<=',
      INT_SLESS: '<',
      INT_SLESSEQUAL: '<=',
    };
    const signed = ['INT_SLESS', 'INT_SLESSEQUAL'].includes(op.opcode);
    return `(${signed ? signedA : a} ${operators[op.opcode]} ${signed ? signedB : b} ? 1n : 0n)`;
  }
  if (shifts.has(op.opcode)) {
    const fill = op.opcode === 'INT_SRIGHT' ? `(${signedA} < 0n ? -1n : 0n)` : '0n';
    const source = op.opcode === 'INT_SRIGHT' ? signedA : a;
    return `(${b} >= ${op.bits}n ? ${fill} : ${source} ${op.opcode === 'INT_LEFT' ? '<<' : '>>'} ${b})`;
  }
  if (op.opcode === 'PIECE') return `(${a} << ${bits(op.inputs[1])}n) | ${b}`;
  if (op.opcode === 'SUBPIECE') return `${a} >> ${BigInt(op.inputs[1].constant) * 8n}n`;
  fail('UNSUPPORTED', 'Internal error: unsupported expression reached emitter');
}

/** No generated imports or automatic bindings: the host explicitly injects reviewed implementations. */
export function emitTypeScript(leaf, registry, implementationSources = new Map()) {
  const selected = resolveRoute(leaf, registry);
  if (!selected.route && selected.unsupported.length)
    fail('UNSUPPORTED', 'Leaf contains unsupported operations; no code was emitted', {
      operations: selected.unsupported,
      candidates: selected.candidates,
    });
  if (selected.route) {
    const implementation = selected.route.implementation;
    const source = implementationSources.get(implementation.id);
    if (typeof source !== 'string' || sha256(source) !== implementation.sourceSha256)
      fail('IMPLEMENTATION_HASH', `Missing or stale source for ${implementation.id}`);
  }
  const receipt = {
    schemaVersion: 1,
    status: 'prototype-only',
    slotKey: selected.key,
    binary: leaf.binary,
    entryAddress: leaf.entryAddress,
    bodyRanges: leaf.bodyRanges,
    bodySha256: leaf.bodySha256,
    irSha256: selected.irSha256,
    shapeSha256: selected.shapeSha256,
    provenance: leaf.provenance,
    routeKind: selected.routeKind,
    route: selected.route,
    unapprovedPatternCandidates: selected.candidates,
    limits: [
      'Pure integer leaf only',
      'Evidence hashes are assertions unless separately verified',
      'No native equivalence or aggregate integration claim',
    ],
  };
  const lines = [
    '// Generated by tools/native-lift. Prototype: independently review before runtime integration.',
    `export const liftReceipt = ${JSON.stringify(receipt, null, 2)} as const;`,
    'type Inputs = Readonly<Record<string, bigint>>;',
    'type Implementations = Readonly<Record<string, (inputs: Inputs) => bigint>>;',
    'export function lifted(inputs: Inputs, implementations: Implementations = {}): bigint {',
  ];
  const names = new Map();
  leaf.inputs.forEach((input, index) => {
    const name = `v${index}`,
      access = `inputs[${JSON.stringify(input.id)}]`;
    names.set(input.id, name);
    lines.push(
      `  if (typeof ${access} !== 'bigint') throw new TypeError(${JSON.stringify(`Missing bigint input ${input.id}`)});`,
    );
    lines.push(`  const ${name} = BigInt.asUintN(${input.bits}, ${access}!);`);
  });
  if (selected.route) {
    const id = selected.route.implementation.id;
    lines.push(`  const implementation = implementations[${JSON.stringify(id)}];`);
    lines.push(
      `  if (typeof implementation !== 'function') throw new Error(${JSON.stringify(`Missing explicit implementation binding ${id}`)});`,
    );
    lines.push(
      `  const result = implementation({${leaf.inputs.map((input) => `${JSON.stringify(input.id)}: ${names.get(input.id)}`).join(', ')}});`,
    );
    lines.push(
      `  if (typeof result !== 'bigint') throw new TypeError('Hand implementation must return bigint');`,
    );
    lines.push(`  return BigInt.asUintN(${selected.resultBits}, result);`);
  } else {
    leaf.operations.forEach((op, index) => {
      const name = `v${leaf.inputs.length + index}`;
      lines.push(`  // ${op.source.address}:${op.source.sequence} ${op.opcode}`);
      lines.push(
        `  const ${name} = BigInt.asUintN(${op.bits}, ${expression(op, names, selected.values)});`,
      );
      names.set(op.id, name);
    });
    const result = Object.hasOwn(leaf.result, 'ref')
      ? names.get(leaf.result.ref)
      : `${leaf.result.constant}n`;
    lines.push(`  return ${result};`);
  }
  lines.push('}', '');
  return {source: lines.join('\n'), receipt};
}

/** Inventory only. Deliberately never converts an unversioned MCP dump into executable IR. */
export function inspectMcpPcode(dump) {
  if (!dump || typeof dump !== 'object' || !Array.isArray(dump.basic_blocks))
    fail('SCHEMA', 'Expected parsed get_function_pcode result');
  const counts = new Map(),
    analysisOnly = new Set([
      'MULTIEQUAL',
      'INDIRECT',
      'PTRADD',
      'PTRSUB',
      'CAST',
      'INSERT',
      'EXTRACT',
    ]);
  const annotations = new Set();
  for (const block of dump.basic_blocks) {
    if (!Array.isArray(block.pcodes)) fail('SCHEMA', 'Missing block pcodes');
    for (const op of block.pcodes) {
      if (typeof op.mnemonic !== 'string') fail('SCHEMA', 'Missing opcode mnemonic');
      counts.set(op.mnemonic, (counts.get(op.mnemonic) ?? 0) + 1);
      if (analysisOnly.has(op.mnemonic)) annotations.add(op.mnemonic);
    }
  }
  return {
    status: 'inspection-only',
    name: dump.name,
    address: dump.address,
    basicBlockCount: dump.basic_blocks.length,
    operationCounts: Object.fromEntries([...counts].sort()),
    analysisOnlyOperations: [...annotations].sort(),
    unsupportedByIntegerLeaf: [...counts.keys()].filter((op) => !supported.has(op)).sort(),
    automaticImportAllowed: false,
    blockers: [
      'Unversioned dump is not an authenticated raw/HighFunction export',
      'Require executable identity, full-body ranges/hash and exporter/settings version',
      'Require SSA varnode IDs, input markers and sequence time/order; storage offsets are not SSA IDs',
      'Require ordered live block operations, predecessor/successor edges and phi-edge order',
      'Require address-space ID table, register aliases and a reviewed ABI/input/output contract',
      'Do not treat high_pcodes iteration order as execution order or basic_blocks as raw P-code',
    ],
  };
}

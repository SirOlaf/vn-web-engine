import {address, canonicalJson, sha256, slotKey} from './index.mjs';
import {
  validateDatabase,
  resolveFunction,
  resolveImplementation,
  resolveType,
} from './database.mjs';
import {validateCfgModule} from './cfg.mjs';
import {applyPcodeLifters} from './lifters.mjs';

const integerOps = new Set([
  'INT_ADD',
  'INT_SUB',
  'INT_MULT',
  'INT_AND',
  'INT_OR',
  'INT_XOR',
  'INT_2COMP',
  'INT_NEGATE',
  'INT_ZEXT',
  'INT_SEXT',
  'INT_EQUAL',
  'INT_NOTEQUAL',
  'INT_LESS',
  'INT_LESSEQUAL',
  'INT_SLESS',
  'INT_SLESSEQUAL',
  'INT_LEFT',
  'INT_RIGHT',
  'INT_SRIGHT',
  'PIECE',
  'SUBPIECE',
]);
const controlOps = new Set(['BRANCH', 'CBRANCH', 'RETURN']);
const booleanOps = new Set(['BOOL_NEGATE', 'BOOL_AND', 'BOOL_OR', 'BOOL_XOR']);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const equal = (left, right) => canonicalJson(left) === canonicalJson(right);
const hash = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
const simple = (value) => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]*$/u.test(value);
export class GhidraImportError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}
function check(condition, code, message, details) {
  if (!condition) throw new GhidraImportError(code, message, details);
}
function list(value, label) {
  check(Array.isArray(value), 'EXPORT_SCHEMA', `${label} must be an array`);
  return value;
}
function uniqueMap(values, key, label) {
  const map = new Map();
  for (const value of list(values, label)) {
    check(
      object(value) && typeof value[key] === 'string' && !map.has(value[key]),
      'EXPORT_SCHEMA',
      `${label} has an absent or duplicate ${key}`,
    );
    map.set(value[key], value);
  }
  return map;
}

/** Validate the ordered graph independently of the emitter's SSA/dominance checks. */
export function validateGhidraExport(exported) {
  check(
    exported?.schema === 'ghidra-function-export/v1' && exported.status === 'complete',
    'EXPORT_SCHEMA',
    'A complete dedicated bridge export is required',
  );
  const fn = exported.function,
    high = exported.high;
  check(object(fn) && hash(fn.bodySha256), 'EXPORT_SCHEMA', 'Full function evidence is required');
  slotKey(exported.binary, fn.entryAddress);
  check(
    exported.state?.stable === true && exported.state.savedState === 'unverified',
    'EXPORT_STATE',
    'Stable live-state evidence is required; this frontend does not claim saved-state verification',
  );
  const {before, after} = exported.state;
  const validDomainFile = (file) =>
    object(file) &&
    file.programPath === exported.binary.programPath &&
    (file.fileId === null || typeof file.fileId === 'string') &&
    typeof file.lastModifiedMs === 'string' &&
    /^-?\d+$/u.test(file.lastModifiedMs) &&
    Number.isInteger(file.version);
  check(
    object(before) &&
      object(after) &&
      before.transactionOpen === false &&
      after.transactionOpen === false &&
      typeof before.changed === 'boolean' &&
      before.changed === after.changed &&
      typeof before.modificationNumber === 'string' &&
      /^-?\d+$/u.test(before.modificationNumber) &&
      before.modificationNumber === after.modificationNumber &&
      validDomainFile(before.domainFile) &&
      validDomainFile(after.domainFile) &&
      equal(before.domainFile, after.domainFile),
    'EXPORT_STATE',
    'Program changed during export or has an open transaction',
  );
  let last = -1n,
    total = 0;
  for (const range of list(fn.bodyRanges, 'bodyRanges')) {
    const start = address(range.start),
      end = address(range.end);
    check(
      start > last &&
        end >= start &&
        Number.isSafeInteger(range.byteLength) &&
        range.byteLength > 0 &&
        end - start + 1n === BigInt(range.byteLength) &&
        hash(range.bytesSha256),
      'EXPORT_BODY',
      'Body ranges must be full, ordered, disjoint and hash-pinned',
    );
    slotKey(exported.binary, range.start);
    slotKey(exported.binary, range.end);
    last = end;
    total += range.byteLength;
  }
  const inBody = (value) =>
    fn.bodyRanges.some(
      (range) => address(value) >= address(range.start) && address(value) <= address(range.end),
    );
  check(
    total > 0 && total === fn.bodyByteLength && inBody(fn.entryAddress),
    'EXPORT_BODY',
    'Body length/entry evidence disagrees',
  );
  check(
    high?.kind === 'high-pcode' &&
      high.source === 'DecompInterface.HighFunction' &&
      high.ssa === true &&
      high.simplificationStyle === 'normalize',
    'EXPORT_REPRESENTATION',
    'Ordered normalized HighFunction SSA is required; raw or legacy MCP p-code is inspection-only',
  );
  const blocks = uniqueMap(high.blocks, 'id', 'blocks'),
    ops = uniqueMap(high.ops, 'id', 'ops'),
    values = uniqueMap(high.varnodes, 'id', 'varnodes');
  check(
    blocks.size > 0 &&
      blocks.size <= 10000 &&
      blocks.has(high.entryBlockId) &&
      ops.size === high.opCount &&
      ops.size <= 100000,
    'EXPORT_GRAPH',
    'Invalid graph entry or operation count',
  );
  const spaces = new Map();
  for (const space of list(exported.addressSpaces, 'addressSpaces')) {
    check(
      Number.isInteger(space.id) &&
        !spaces.has(space.id) &&
        Number.isInteger(space.sizeBits) &&
        space.sizeBits > 0 &&
        space.sizeBits <= 64 &&
        space.addressableUnitSize === 1,
      'EXPORT_SPACE',
      'Address spaces must be unique byte-addressed spaces up to 64 bits',
    );
    spaces.set(space.id, space);
  }
  for (const value of values.values()) {
    check(
      simple(value.id) &&
        Number.isInteger(value.size) &&
        value.size > 0 &&
        value.size <= 16 &&
        spaces.get(value.spaceId)?.name === value.space &&
        typeof value.flags?.input === 'boolean' &&
        typeof value.flags.constant === 'boolean' &&
        value.flags.constant === (value.kind === 'constant'),
      'EXPORT_VARNODE',
      'Invalid varnode storage, flags or identity',
      {id: value.id},
    );
    address(value.offset);
    if (value.flags.constant)
      check(
        value.definitionOpId === null && !value.flags.input,
        'EXPORT_SSA',
        'Constants cannot have definitions or be parameters',
      );
    if (value.definitionOpId !== null)
      check(
        ops.get(value.definitionOpId)?.output === value.id && !value.flags.input,
        'EXPORT_SSA',
        'Varnode definition does not point back to its producing operation',
        {id: value.id},
      );
  }
  check(
    equal(
      [...high.inputVarnodeIds].sort(),
      [...values.values()]
        .filter((value) => value.flags.input)
        .map((value) => value.id)
        .sort(),
    ),
    'EXPORT_SSA',
    'Input varnode inventory disagrees with flags',
  );
  const visitedOps = [],
    indexes = new Set();
  for (const block of blocks.values()) {
    check(
      simple(block.id) && Number.isInteger(block.index) && !indexes.has(block.index),
      'EXPORT_GRAPH',
      'Block IDs and indexes must be unique',
    );
    indexes.add(block.index);
    list(block.predecessors, 'predecessors');
    list(block.successors, 'successors');
    list(block.opIds, 'opIds');
    check(
      new Set(block.predecessors.map((edge) => edge.blockId)).size === block.predecessors.length &&
        new Set(block.successors.map((edge) => edge.blockId)).size === block.successors.length,
      'EXPORT_MULTIEDGE',
      'Parallel CFG edges require an edge-keyed IR; they are not collapsed into predecessor names',
    );
    block.predecessors.forEach((edge, index) => {
      const back = blocks.get(edge.blockId)?.successors[edge.sourceSuccessorIndex];
      check(
        back?.blockId === block.id && back.targetPredecessorIndex === index,
        'EXPORT_EDGE',
        'Predecessor reverse edge does not match',
      );
    });
    block.successors.forEach((edge, index) => {
      const back = blocks.get(edge.blockId)?.predecessors[edge.targetPredecessorIndex];
      check(
        back?.blockId === block.id && back.sourceSuccessorIndex === index,
        'EXPORT_EDGE',
        'Successor reverse edge does not match',
      );
    });
    let pastPhi = false;
    block.opIds.forEach((id, index) => {
      const op = ops.get(id);
      visitedOps.push(id);
      check(
        op?.blockId === block.id &&
          op.index === index &&
          typeof op.opcode === 'string' &&
          Number.isInteger(op.sequence?.time) &&
          op.sequence.time >= 0 &&
          op.sequence.time <= 0xffffffff &&
          Number.isInteger(op.sequence.order) &&
          inBody(op.sequence.address),
        'EXPORT_ORDER',
        'Operation block/order/sequence does not match the live block iterator',
        {id},
      );
      list(op.inputs, 'operation inputs').forEach((input) =>
        check(values.has(input), 'EXPORT_SSA', 'Unknown input varnode', {id, input}),
      );
      if (op.output !== null)
        check(
          values.get(op.output)?.definitionOpId === id,
          'EXPORT_SSA',
          'Output does not point back to its defining operation',
          {id},
        );
      if (op.opcode === 'MULTIEQUAL') {
        check(
          !pastPhi &&
            op.output !== null &&
            Array.isArray(op.phiInputs) &&
            op.inputs.length === block.predecessors.length &&
            op.phiInputs.length === op.inputs.length,
          'EXPORT_PHI',
          'Phi nodes must precede ordinary ops and cover every predecessor',
        );
        op.phiInputs.forEach((input, slot) => {
          const edge = block.predecessors[slot];
          check(
            input.inputIndex === slot &&
              input.predecessorIndex === slot &&
              input.predecessorBlockId === edge.blockId &&
              input.predecessorSuccessorIndex === edge.sourceSuccessorIndex &&
              input.varnodeId === op.inputs[slot],
            'EXPORT_PHI',
            'Phi input edge/slot association disagrees',
          );
        });
      } else pastPhi = true;
      check(
        !controlOps.has(op.opcode) || index === block.opIds.length - 1,
        'EXPORT_CONTROL',
        'A control operation is not the final live operation',
      );
    });
    const tail = ops.get(block.opIds.at(-1));
    if (tail?.opcode === 'CBRANCH')
      check(
        block.successors.length === 2 &&
          object(block.conditionalTargets) &&
          block.conditionalTargets.trueBlockId !== block.conditionalTargets.falseBlockId &&
          equal(
            [block.conditionalTargets.trueBlockId, block.conditionalTargets.falseBlockId].sort(),
            block.successors.map((edge) => edge.blockId).sort(),
          ),
        'EXPORT_CONTROL',
        'Conditional edge roles must be explicit',
      );
    else
      check(
        block.conditionalTargets === null,
        'EXPORT_CONTROL',
        'Nonconditional block must not assert conditional edge roles',
      );
  }
  check(
    equal(
      visitedOps,
      high.ops.map((op) => op.id),
    ) && new Set(visitedOps).size === ops.size,
    'EXPORT_ORDER',
    'Flat operation list must exactly follow block order and live operation order',
  );
  return {blocks, ops, values, spaces};
}

/** Import only explicit, reviewed semantics. Unknown effects never disappear. */
export function importGhidraFunction(exported, db, plan) {
  validateDatabase(db);
  const graph = validateGhidraExport(exported),
    {blocks, ops, values, spaces} = graph;
  check(
    object(plan) &&
      plan.schema === 'ghidra-cfg-import/v1' &&
      Object.keys(plan).every((key) =>
        [
          'schema',
          'exportSha256',
          'sourceKind',
          'reviewReference',
          'assumptions',
          'callArguments',
        ].includes(key),
      ) &&
      plan.exportSha256 === sha256(canonicalJson(exported)) &&
      ['synthetic', 'reviewed-pcode'].includes(plan.sourceKind) &&
      typeof plan.reviewReference === 'string' &&
      plan.reviewReference.trim() &&
      Array.isArray(plan.assumptions) &&
      plan.assumptions.every((item) => typeof item === 'string' && item.trim()) &&
      object(plan.callArguments),
    'IMPORT_PLAN',
    'An exact export-hash-pinned review plan and explicit call bindings are required',
  );
  const identity = exported.binary,
    sha = identity.executableSha256,
    fn = exported.function;
  const dbBinary = db.binaries.find((binary) => binary.executableSha256 === sha);
  check(
    dbBinary && Object.entries(identity).every(([key, value]) => dbBinary[key] === value),
    'IMPORT_BINARY',
    'Export and database binary identities differ',
  );
  const rva = `0x${(address(fn.entryAddress) - address(identity.imageBase)).toString(16)}`;
  const mapping = resolveFunction(db, sha, rva),
    implementation = resolveImplementation(db, mapping.implementation);
  function evidence(mapped) {
    check(
      mapped.abi.convention !== 'unresolved' &&
        !mapped.abi.parameters.some((parameter) => parameter.location.kind === 'unresolved') &&
        mapped.abi.returnLocation.kind !== 'unresolved' &&
        (mapped.evidence.state === 'reviewed-contract' ||
          (plan.sourceKind === 'synthetic' && mapped.evidence.state === 'synthetic')),
      'IMPORT_ABI',
      'Native mapping needs an explicit ABI contract and reviewed (or synthetic fixture) evidence',
      {rva: mapped.rva},
    );
  }
  evidence(mapping);
  const typeCache = new Map();
  const resolved = (type) => {
    const key = canonicalJson(type);
    if (!typeCache.has(key)) typeCache.set(key, resolveType(db, type));
    return typeCache.get(key);
  };
  const bits = (type) => {
    const result = resolved(type);
    return result.bits ?? result.nativeBits ?? (result.kind === 'boolean' ? 8 : null);
  };
  function sizeMatches(value, type) {
    check(
      values.has(value) && bits(type) === values.get(value).size * 8,
      'IMPORT_TYPE',
      'Storage width differs from the explicit database type',
      {value, type},
    );
  }
  function locationMatches(value, location) {
    if (location.kind === 'register')
      return value.kind === 'register' && value.register?.toLowerCase() === location.name;
    if (location.kind === 'stack')
      return (
        value.kind === 'stack' &&
        spaces.has(value.spaceId) &&
        BigInt.asIntN(spaces.get(value.spaceId).sizeBits, address(value.offset)) ===
          BigInt(location.offsetBytes)
      );
    return false;
  }
  if (implementation.signature.returnType !== 'void') {
    const storage = fn.returnValue?.storage;
    if (storage?.valid === true && storage.unassigned === false)
      check(
        storage.pieces?.length === 1 &&
          locationMatches(storage.pieces[0], mapping.abi.returnLocation) &&
          storage.pieces[0].size * 8 === bits(implementation.signature.returnType),
        'IMPORT_RETURN_STORAGE',
        'Assigned function return storage differs from the database ABI; compound or hidden storage needs an explicit adapter',
      );
  }
  const valueTypes = new Map(),
    parameterValues = {},
    nativeInputs = new Map();
  for (const parameter of mapping.abi.parameters) {
    const matching = [...values.values()].filter((value) => {
      if (!value.flags.input) return false;
      return locationMatches(value, parameter.location);
    });
    check(
      matching.length === 1,
      'IMPORT_PARAMETER',
      'Native parameter must identify exactly one high input by explicit storage',
      {parameter: parameter.name, matching: matching.map((value) => value.id)},
    );
    sizeMatches(matching[0].id, parameter.type);
    nativeInputs.set(parameter.name, matching[0].id);
  }
  const representedInputs = new Set();
  for (const binding of mapping.abi.arguments) {
    check(
      binding.source.kind === 'parameter',
      'IMPORT_PARAMETER',
      'Generated entry signatures currently require a bijection to native parameters; constant entry bindings need a reviewed wrapper',
    );
    const id = nativeInputs.get(binding.source.name);
    check(
      id && !representedInputs.has(id),
      'IMPORT_PARAMETER',
      'Generated entry parameters must have distinct native inputs',
    );
    representedInputs.add(id);
    parameterValues[binding.parameter] = id;
    valueTypes.set(
      id,
      implementation.signature.parameters.find((parameter) => parameter.name === binding.parameter)
        .type,
    );
  }
  check(
    representedInputs.size === nativeInputs.size,
    'IMPORT_PARAMETER',
    'Native entry inputs cannot be dropped',
  );
  const lifted = applyPcodeLifters({
    exported,
    database: db,
    graph,
    nativeInputs,
  });
  for (const replacement of lifted.replacements.values())
    valueTypes.set(replacement.operation.id, replacement.outputType);
  const callTargets = new Map();
  for (const op of ops.values()) {
    if (op.output !== null) {
      const output = values.get(op.output);
      check(
        !['memory', 'stack'].includes(output.kind) && output.flags.persistent !== true,
        'IMPORT_MEMORY_EFFECT',
        'Address-tied memory/stack or persistent outputs are writes, not local SSA assignments',
        {opId: op.id, output: op.output},
      );
    }
    if (lifted.replacements.has(op.id) || lifted.consumed.has(op.id)) continue;
    if (op.opcode === 'CALL') {
      const target = values.get(op.inputs[0]);
      check(
        target?.kind === 'memory' && spaces.get(target.spaceId)?.isDefault,
        'IMPORT_CALL',
        'Direct call target must be an address in the default code space',
      );
      const callRva = address(target.offset) - address(identity.imageBase);
      check(callRva >= 0n, 'IMPORT_CALL', 'Call target is below the image base');
      const mapped = resolveFunction(db, sha, `0x${callRva.toString(16)}`);
      evidence(mapped);
      const targetImplementation = resolveImplementation(db, mapped.implementation);
      const binding = plan.callArguments[op.id];
      check(
        object(binding) &&
          equal(
            Object.keys(binding).sort(),
            mapped.abi.parameters.map((parameter) => parameter.name).sort(),
          ) &&
          equal(Object.values(binding).sort(), op.inputs.slice(1).sort()),
        'IMPORT_CALL',
        'Call bindings must explicitly account for every recovered native argument by name',
        {opId: op.id},
      );
      for (const parameter of mapped.abi.parameters)
        sizeMatches(binding[parameter.name], parameter.type);
      check(
        (targetImplementation.signature.returnType === 'void') === (op.output === null),
        'IMPORT_CALL',
        'Call result arity differs from mapped return contract',
      );
      if (op.output !== null) {
        sizeMatches(op.output, targetImplementation.signature.returnType);
        check(
          locationMatches(values.get(op.output), mapped.abi.returnLocation),
          'IMPORT_RETURN_STORAGE',
          'Recovered call result storage differs from the mapped return ABI',
          {opId: op.id},
        );
        valueTypes.set(op.output, targetImplementation.signature.returnType);
      }
      callTargets.set(op.id, {mapped, targetImplementation, binding});
    } else if (
      !controlOps.has(op.opcode) &&
      !['COPY', 'CAST', 'MULTIEQUAL'].includes(op.opcode) &&
      !integerOps.has(op.opcode) &&
      !booleanOps.has(op.opcode)
    )
      throw new GhidraImportError(
        'IMPORT_UNSUPPORTED',
        `Unsupported effect ${op.opcode}; the entire function was refused`,
        {opId: op.id, source: op.sequence},
      );
    if (integerOps.has(op.opcode) || booleanOps.has(op.opcode) || op.opcode === 'MULTIEQUAL') {
      check(
        op.output !== null && [1, 2, 4, 8].includes(values.get(op.output)?.size),
        'IMPORT_TYPE',
        'Integer operations need an explicit 8/16/32/64-bit output',
      );
      valueTypes.set(op.output, `u${values.get(op.output).size * 8}`);
    }
  }
  check(
    equal(Object.keys(plan.callArguments).sort(), [...callTargets.keys()].sort()),
    'IMPORT_CALL',
    'Review plan includes a call binding that is absent from this export',
  );
  function typeOf(id, visiting = new Set()) {
    if (valueTypes.has(id)) return valueTypes.get(id);
    const value = values.get(id);
    check(value, 'IMPORT_SSA', 'Unknown value');
    if (value.flags.constant) {
      check([1, 2, 4, 8].includes(value.size), 'IMPORT_TYPE', 'Unsupported constant width');
      return `u${value.size * 8}`;
    }
    const producer = ops.get(value.definitionOpId);
    check(
      !visiting.has(id) &&
        producer &&
        ['COPY', 'CAST'].includes(producer.opcode) &&
        producer.inputs.length === 1,
      'IMPORT_INPUT',
      'Unbound input, unknown type or unresolved copy cycle',
      {id},
    );
    const type = typeOf(producer.inputs[0], new Set([...visiting, id]));
    sizeMatches(id, type);
    valueTypes.set(id, type);
    return type;
  }
  const sourceCounts = new Map(),
    lowerings = [];
  function source(op, reason = null) {
    const key = `${op.sequence.address}:${op.sequence.time}`,
      loweringIndex = sourceCounts.get(key) ?? 0;
    sourceCounts.set(key, loweringIndex + 1);
    if (reason) lowerings.push({opId: op.id, loweringIndex, reason});
    return {address: op.sequence.address, sequence: op.sequence.time, loweringIndex};
  }
  function operand(id) {
    const type = typeOf(id),
      value = values.get(id);
    if (value.flags.constant)
      return {
        constant: `0x${BigInt.asUintN(value.size * 8, address(value.offset)).toString(16)}`,
        type,
      };
    return {ref: id};
  }
  let castIndex = 0;
  const generated = new Map(
    [...blocks.values()].map((block) => [
      block.id,
      {id: block.id, phis: [], operations: [], terminator: null},
    ]),
  );
  function coerce(id, type, targetBlock, op) {
    const actual = typeOf(id);
    if (equal(actual, type)) return operand(id);
    check(
      resolved(actual).kind === 'integer' &&
        resolved(type).kind === 'integer' &&
        bits(actual) === bits(type),
      'IMPORT_TYPE',
      'An explicit semantic adapter is required for this type change',
      {id, actual, expected: type},
    );
    const resultId = `adapter${castIndex++}`;
    check(!values.has(resultId), 'IMPORT_SSA', 'Generated adapter ID collides with native value');
    targetBlock.operations.push({
      id: resultId,
      type,
      opcode: 'CAST',
      inputs: [operand(id)],
      source: source(op, 'same-width database type adapter'),
    });
    return {ref: resultId};
  }
  for (const block of blocks.values()) {
    const targetBlock = generated.get(block.id);
    for (const id of block.opIds) {
      const op = ops.get(id);
      if (controlOps.has(op.opcode) || op.opcode === 'MULTIEQUAL') continue;
      const replacement = lifted.replacements.get(id);
      if (replacement) {
        targetBlock.operations.push({
          ...replacement.operation,
          source: source(replacement.source, replacement.reason),
        });
      } else if (lifted.consumed.has(id)) continue;
      else if (op.opcode === 'CALL') {
        const {mapped, targetImplementation, binding} = callTargets.get(id),
          args = {};
        for (const argument of mapped.abi.arguments) {
          const parameter = targetImplementation.signature.parameters.find(
            (value) => value.name === argument.parameter,
          );
          if (argument.source.kind === 'parameter')
            args[argument.parameter] = coerce(
              binding[argument.source.name],
              parameter.type,
              targetBlock,
              op,
            );
          else {
            check(
              typeof parameter.type === 'string' &&
                /^[ui](8|16|32|64)$/u.test(parameter.type) &&
                typeof argument.source.value === 'string',
              'IMPORT_TYPE',
              'Only scalar integer constant call bindings are currently imported',
            );
            args[argument.parameter] = {
              constant: `0x${BigInt.asUintN(bits(parameter.type), BigInt(argument.source.value)).toString(16)}`,
              type: parameter.type,
            };
          }
        }
        targetBlock.operations.push({
          id: op.output,
          opcode: 'CALL',
          target: {binarySha256: sha, rva: mapped.rva},
          arguments: args,
          source: source(op),
        });
      } else if (booleanOps.has(op.opcode)) {
        check(
          values.get(op.output).size === 1 &&
            op.inputs.length === (op.opcode === 'BOOL_NEGATE' ? 1 : 2) &&
            op.inputs.every(
              (input) => values.get(input).size === 1 && resolved(typeOf(input)).kind === 'integer',
            ),
          'IMPORT_TYPE',
          'P-code boolean operations require one-byte bit-vector operands',
        );
        if (op.opcode === 'BOOL_NEGATE')
          targetBlock.operations.push({
            id: op.output,
            type: 'u8',
            opcode: 'INT_EQUAL',
            inputs: [operand(op.inputs[0]), {constant: '0x0', type: 'u8'}],
            source: source(op, 'boolean negation as comparison with zero'),
          });
        else {
          const inputs = op.inputs.map((input) => {
            const id = `adapter${castIndex++}`;
            check(
              !values.has(id),
              'IMPORT_SSA',
              'Generated boolean adapter ID collides with native value',
            );
            targetBlock.operations.push({
              id,
              type: 'u8',
              opcode: 'INT_NOTEQUAL',
              inputs: [operand(input), {constant: '0x0', type: 'u8'}],
              source: source(op, 'normalize P-code boolean operand to zero or one'),
            });
            return {ref: id};
          });
          targetBlock.operations.push({
            id: op.output,
            type: 'u8',
            opcode: op.opcode.replace('BOOL_', 'INT_'),
            inputs,
            source: source(op, 'normalized boolean combination'),
          });
        }
      } else {
        check(op.output !== null, 'IMPORT_SSA', 'Value operation has no result');
        targetBlock.operations.push({
          id: op.output,
          type: typeOf(op.output),
          opcode: op.opcode,
          inputs: op.inputs.map(operand),
          source: source(op),
        });
      }
    }
  }
  // Phi adapters belong to predecessor edges, after ordinary producers and before
  // terminators. The emitter validates dominance and simultaneous phi assignment.
  for (const block of blocks.values())
    for (const id of block.opIds) {
      const op = ops.get(id);
      if (op.opcode !== 'MULTIEQUAL') continue;
      const type = typeOf(op.output),
        incoming = {};
      for (const input of op.phiInputs)
        incoming[input.predecessorBlockId] = coerce(
          input.varnodeId,
          type,
          generated.get(input.predecessorBlockId),
          op,
        );
      generated.get(block.id).phis.push({id: op.output, type, incoming, source: source(op)});
    }
  for (const block of blocks.values()) {
    const targetBlock = generated.get(block.id),
      tail = ops.get(block.opIds.at(-1));
    check(
      tail,
      'IMPORT_CONTROL',
      'Empty high blocks require an explicit source location before import',
    );
    if (tail.opcode === 'RETURN') {
      check(
        block.successors.length === 0 &&
          tail.output === null &&
          tail.inputs.length === (implementation.signature.returnType === 'void' ? 1 : 2),
        'IMPORT_CONTROL',
        'Return must match one mapped result and have no successors',
      );
      if (implementation.signature.returnType !== 'void')
        check(
          locationMatches(values.get(tail.inputs[1]), mapping.abi.returnLocation),
          'IMPORT_RETURN_STORAGE',
          'HighFunction return storage differs from the database ABI; normalized hidden storage needs an explicit adapter',
        );
      const value =
        implementation.signature.returnType === 'void'
          ? null
          : coerce(tail.inputs[1], implementation.signature.returnType, targetBlock, tail);
      targetBlock.terminator = {opcode: 'RETURN', value, source: source(tail)};
    } else if (tail.opcode === 'CBRANCH') {
      check(
        tail.inputs.length === 2 && tail.output === null,
        'IMPORT_CONTROL',
        'Conditional branch arity differs',
      );
      targetBlock.terminator = {
        opcode: 'BRANCH',
        condition: operand(tail.inputs[1]),
        trueTarget: block.conditionalTargets.trueBlockId,
        falseTarget: block.conditionalTargets.falseBlockId,
        source: source(tail),
      };
    } else {
      check(
        block.successors.length === 1 &&
          (tail.opcode !== 'BRANCH' || (tail.inputs.length === 1 && tail.output === null)),
        'IMPORT_CONTROL',
        'Unconditional/fallthrough block needs exactly one explicit successor',
      );
      targetBlock.terminator = {
        opcode: 'JUMP',
        target: block.successors[0].blockId,
        source: source(tail, tail.opcode === 'BRANCH' ? null : 'implicit high block fallthrough'),
      };
    }
  }
  const module = {
    schemaVersion: 2,
    kind: 'reviewed-cfg-module',
    entryImplementation: mapping.implementation,
    functions: [
      {
        implementation: mapping.implementation,
        provenance: {
          binary: identity,
          entryAddress: fn.entryAddress,
          bodyRanges: fn.bodyRanges.map(({start, end}) => ({start, end})),
          bodySha256: fn.bodySha256,
          sourceKind: plan.sourceKind,
          sourceSha256: plan.exportSha256,
          exporter: `${exported.exporter.name}/${exported.exporter.version} Ghidra/${exported.exporter.ghidraVersion}`,
          reviewReference: plan.reviewReference,
          assumptions: plan.assumptions,
        },
        variant: null,
        parameterValues,
        entryBlock: exported.high.entryBlockId,
        blocks: [...generated.values()],
      },
    ],
  };
  const validation = validateCfgModule(module, db);
  return {
    module,
    receipt: {
      schema: 'ghidra-cfg-import-receipt/v1',
      exportSha256: plan.exportSha256,
      planSha256: sha256(canonicalJson(plan)),
      irSha256: validation.report.irSha256,
      databaseSha256: validation.report.databaseSha256,
      sourceKind: plan.sourceKind,
      reviewReference: plan.reviewReference,
      lowerings,
      lifters: lifted.receipts,
      savedState: 'unverified',
    },
  };
}

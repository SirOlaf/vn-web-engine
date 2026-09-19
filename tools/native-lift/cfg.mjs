import path from 'node:path';
import {realpathSync} from 'node:fs';
import {canonicalJson, sha256, validateLeaf, address, slotKey, LiftError} from './index.mjs';
import {
  validateDatabase,
  resolveImplementation,
  resolveFunction,
  resolveVariantFamily,
  resolveType,
} from './database.mjs';

const integerTypes = new Map(
  ['u8', 'i8', 'u16', 'i16', 'u32', 'i32', 'u64', 'i64'].map((type) => [
    type,
    {bits: Number(type.slice(1)), signed: type[0] === 'i'},
  ]),
);
const primitiveTypes = new Set([...integerTypes.keys(), 'f32', 'f64', 'bool', 'void', 'unknown']);
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
const comparisons = new Set([
  'INT_EQUAL',
  'INT_NOTEQUAL',
  'INT_LESS',
  'INT_LESSEQUAL',
  'INT_SLESS',
  'INT_SLESSEQUAL',
]);
const unaryOps = new Set(['INT_2COMP', 'INT_NEGATE', 'INT_ZEXT', 'INT_SEXT']);
const shiftOps = new Set(['INT_LEFT', 'INT_RIGHT', 'INT_SRIGHT']);
const fail = (code, message, details = {}) => {
  throw new LiftError(code, message, details);
};
const equal = (a, b) => canonicalJson(a) === canonicalJson(b);
const simple = (value) => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]*$/.test(value);
function fields(value, names, label) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== names.length ||
    Object.keys(value).some((key) => !names.includes(key))
  )
    fail('CFG_SCHEMA', `${label} requires exactly ${names.join(', ')}`);
}
function text(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail('CFG_SCHEMA', `${label} requires text`);
}
function hash(value, label) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value))
    fail('CFG_SCHEMA', `${label} requires SHA-256`);
}
function dictionary(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('CFG_SCHEMA', `${label} must be an object`);
}

function checkType(db, type, allowVoid = false, seen = new Set()) {
  if (typeof type === 'string') {
    if (!primitiveTypes.has(type) || (!allowVoid && type === 'void'))
      fail('CFG_TYPE', `Invalid value type ${type}`);
    return;
  }
  fields(type, ['named'], 'named type');
  if (seen.has(type.named)) fail('CFG_TYPE', 'Recursive type alias');
  const definition = db.types.find((item) => item.id === type.named);
  if (!definition) fail('CFG_TYPE', `Unknown named type ${type.named}`);
  if (definition.kind === 'alias')
    checkType(db, definition.target, allowVoid, new Set([...seen, type.named]));
}

function integer(db, type) {
  const resolved = resolveType(db, type);
  return resolved.kind === 'integer' ? resolved : undefined;
}

function familyOperation(db, familyId, operationId) {
  const family = resolveVariantFamily(db, familyId);
  const operation = family.operations.find((item) => item.id === operationId);
  if (!operation) fail('CFG_VARIANT', `Unknown operation ${familyId}.${operationId}`);
  return {family, operation};
}

function nativeKey(provenance) {
  return {
    binarySha256: provenance.binary.executableSha256,
    rva: `0x${(address(provenance.entryAddress) - address(provenance.binary.imageBase)).toString(16)}`,
  };
}

function validateProvenance(provenance) {
  fields(
    provenance,
    [
      'binary',
      'entryAddress',
      'bodyRanges',
      'bodySha256',
      'sourceKind',
      'sourceSha256',
      'exporter',
      'reviewReference',
      'assumptions',
    ],
    'function provenance',
  );
  const {binary, entryAddress, bodyRanges, bodySha256, ...source} = provenance;
  validateLeaf({
    schemaVersion: 1,
    kind: 'reviewed-integer-leaf',
    symbol: 'cfg_provenance',
    binary,
    entryAddress,
    bodyRanges,
    bodySha256,
    provenance: source,
    inputs: [],
    operations: [],
    result: {constant: '0x0', bits: 8},
  });
}

function validateVariant(fn, db) {
  const variant = fn.variant;
  if (variant === null) {
    const key = nativeKey(fn.provenance);
    if (resolveFunction(db, key.binarySha256, key.rva).implementation !== fn.implementation)
      fail('CFG_MAPPING', 'Function body does not match its exact database address mapping');
    const targets = db.variantFamilies
      .filter((family) => family.kind === 'code')
      .flatMap((family) => family.operations.flatMap((operation) => operation.targets))
      .filter((target) => target.implementation === fn.implementation);
    if (
      targets.some(
        (target) =>
          !target.applicability.some(
            (item) =>
              item.binarySha256 === key.binarySha256 &&
              item.rva === key.rva &&
              item.body.sha256 === fn.provenance.bodySha256,
          ),
      )
    )
      fail('CFG_VARIANT', 'Base implementation lacks exact binary/address/body applicability');
    return;
  }
  const common = ['kind', 'family', 'selectorValue', 'reviewReference'];
  if (variant.kind === 'decoded-body') fields(variant, common, 'decoded variant');
  else if (variant.kind === 'reviewed-patch') {
    fields(variant, [...common, 'baseBodySha256', 'patches'], 'patched variant');
    hash(variant.baseBodySha256, 'baseBodySha256');
    if (!Array.isArray(variant.patches) || variant.patches.length === 0)
      fail('CFG_VARIANT', 'Reviewed patches must be explicit');
    const spans = [];
    for (const patch of variant.patches) {
      fields(patch, ['address', 'originalHex', 'replacementHex'], 'patch');
      if (
        typeof patch.originalHex !== 'string' ||
        !/^(?:[0-9a-f]{2})+$/.test(patch.originalHex) ||
        typeof patch.replacementHex !== 'string' ||
        !/^(?:[0-9a-f]{2})+$/.test(patch.replacementHex) ||
        patch.originalHex.length !== patch.replacementHex.length
      )
        fail('CFG_VARIANT', 'Patches require equally sized, nonempty exact byte strings');
      const start = address(patch.address),
        end = start + BigInt(patch.originalHex.length / 2) - 1n;
      if (
        !fn.provenance.bodyRanges.some(
          (range) => start >= address(range.start) && end <= address(range.end),
        ) ||
        spans.some((span) => start <= span.end && end >= span.start)
      )
        fail('CFG_VARIANT', 'Patch spans must be disjoint and lie in the recorded body');
      spans.push({start, end});
    }
  } else fail('CFG_VARIANT', 'Unknown variant provenance kind');
  text(variant.reviewReference, 'variant review');
  const family = resolveVariantFamily(db, variant.family),
    key = nativeKey(fn.provenance);
  if (family.kind !== 'code' || !family.selector.values.includes(variant.selectorValue))
    fail('CFG_VARIANT', 'Decoded code variant must select an explicit code-family target');
  const targets = family.operations
    .flatMap((operation) => operation.targets)
    .filter(
      (target) =>
        target.selectorValue === variant.selectorValue &&
        target.implementation === fn.implementation,
    );
  if (
    !targets.some((target) =>
      target.applicability.some(
        (item) =>
          item.binarySha256 === key.binarySha256 &&
          item.rva === key.rva &&
          item.body?.sha256 === fn.provenance.bodySha256,
      ),
    )
  )
    fail('CFG_VARIANT', 'Variant implementation lacks exact binary/address/body applicability');
}

function graph(blocks, entry) {
  const byId = new Map(blocks.map((block) => [block.id, block]));
  const successors = new Map(),
    predecessors = new Map(blocks.map((block) => [block.id, []]));
  for (const block of blocks) {
    const term = block.terminator;
    let edges;
    if (term.opcode === 'JUMP') {
      fields(term, ['opcode', 'target', 'source'], 'jump');
      edges = [term.target];
    } else if (term.opcode === 'BRANCH') {
      fields(term, ['opcode', 'condition', 'trueTarget', 'falseTarget', 'source'], 'branch');
      edges = [...new Set([term.trueTarget, term.falseTarget])];
    } else if (term.opcode === 'RETURN') {
      fields(term, ['opcode', 'value', 'source'], 'return');
      edges = [];
    } else fail('CFG_UNSUPPORTED', `Unsupported terminator ${term.opcode}`);
    for (const target of edges) {
      if (!byId.has(target)) fail('CFG_EDGE', `Unknown edge ${block.id} -> ${target}`);
      predecessors.get(target).push(block.id);
    }
    successors.set(block.id, edges);
  }
  const reachable = new Set(),
    visit = (id) => {
      if (reachable.has(id)) return;
      reachable.add(id);
      successors.get(id).forEach(visit);
    };
  visit(entry);
  if (reachable.size !== blocks.length)
    fail('CFG_UNREACHABLE', 'Remove or separately review unreachable blocks', {
      blocks: blocks.filter((block) => !reachable.has(block.id)).map((block) => block.id),
    });
  const dominators = new Map(
    blocks.map((block) => [block.id, new Set(block.id === entry ? [entry] : byId.keys())]),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const block of blocks) {
      if (block.id === entry) continue;
      const preds = predecessors.get(block.id);
      const next = new Set(
        [...dominators.get(preds[0])].filter((id) =>
          preds.every((pred) => dominators.get(pred).has(id)),
        ),
      );
      next.add(block.id);
      if (!equal([...next].sort(), [...dominators.get(block.id)].sort())) {
        dominators.set(block.id, next);
        changed = true;
      }
    }
  }
  let nextIndex = 0;
  const indices = new Map(),
    lows = new Map(),
    pending = [],
    onStack = new Set(),
    components = [];
  function connect(id) {
    indices.set(id, nextIndex);
    lows.set(id, nextIndex++);
    pending.push(id);
    onStack.add(id);
    for (const target of successors.get(id)) {
      if (!indices.has(target)) {
        connect(target);
        lows.set(id, Math.min(lows.get(id), lows.get(target)));
      } else if (onStack.has(target)) lows.set(id, Math.min(lows.get(id), indices.get(target)));
    }
    if (lows.get(id) === indices.get(id)) {
      const component = [];
      let value;
      do {
        value = pending.pop();
        onStack.delete(value);
        component.push(value);
      } while (value !== id);
      components.push(component.sort());
    }
  }
  connect(entry);
  const backedges = blocks.flatMap((block) =>
    successors
      .get(block.id)
      .filter((target) => dominators.get(block.id).has(target))
      .map((target) => ({from: block.id, to: target})),
  );
  return {
    byId,
    successors,
    predecessors,
    dominators,
    report: {
      entry,
      reachable: [...reachable],
      predecessors: Object.fromEntries(predecessors),
      successors: Object.fromEntries(successors),
      dominators: Object.fromEntries(
        [...dominators].map(([id, values]) => [id, [...values].sort()]),
      ),
      stronglyConnectedComponents: components,
      loopComponents: components.filter(
        (component) => component.length > 1 || successors.get(component[0]).includes(component[0]),
      ),
      backedges,
    },
  };
}

function operationShape(op, db) {
  if (op.opcode === 'CALL_IMPLEMENTATION') {
    fields(op, ['id', 'opcode', 'implementation', 'arguments', 'source'], 'implementation call');
    const implementation = resolveImplementation(db, op.implementation);
    return {
      type: implementation.signature.returnType,
      signature: implementation.signature,
      implementation,
      directImport: true,
    };
  }
  if (op.opcode === 'CALL') {
    fields(op, ['id', 'opcode', 'target', 'arguments', 'source'], 'call');
    fields(op.target, ['binarySha256', 'rva'], 'direct call target');
    const mapped = resolveFunction(db, op.target.binarySha256, op.target.rva);
    const implementation = resolveImplementation(db, mapped.implementation);
    const applies = (target) =>
      target.applicability.some(
        (item) => item.binarySha256 === op.target.binarySha256 && item.rva === op.target.rva,
      );
    const variants = db.variantFamilies
      .filter((family) => family.kind === 'code')
      .flatMap((family) =>
        family.operations
          .filter((operation) => operation.targets.some(applies))
          .map((operation) => ({family, operation})),
      );
    if (variants.length > 1)
      fail(
        'CFG_VARIANT_ROUTE',
        'A native call target belongs to more than one code-family operation',
      );
    if (variants.length === 1) {
      const selected = variants[0];
      if (
        !selected.operation.targets.every(applies) ||
        !equal(selected.operation.signature, implementation.signature)
      )
        fail(
          'CFG_VARIANT_ROUTE',
          'Native call variant targets require complete exact-slot applicability and the mapped signature',
        );
      return {
        type: selected.operation.signature.returnType,
        signature: selected.operation.signature,
        implementation,
        ...selected,
      };
    }
    return {
      type: implementation.signature.returnType,
      signature: implementation.signature,
      implementation,
    };
  }
  if (op.opcode === 'VARIANT_CALL') {
    fields(op, ['id', 'opcode', 'family', 'operation', 'arguments', 'source'], 'variant call');
    const selected = familyOperation(db, op.family, op.operation);
    return {
      type: selected.operation.signature.returnType,
      signature: selected.operation.signature,
      ...selected,
    };
  }
  if (op.opcode === 'PUSH_VARIANT') {
    fields(
      op,
      ['opcode', 'scopeId', 'family', 'selectorValue', 'reviewReference', 'source'],
      'variant push',
    );
    const family = resolveVariantFamily(db, op.family);
    if (!simple(op.scopeId) || !family.selector.values.includes(op.selectorValue))
      fail('CFG_VARIANT', 'Push requires an explicit scope ID and known finite selector value');
    text(op.reviewReference, 'push reviewReference');
    return {type: 'void', family};
  }
  if (op.opcode === 'POP_VARIANT') {
    fields(op, ['opcode', 'scopeId', 'source'], 'variant pop');
    if (!simple(op.scopeId)) fail('CFG_VARIANT', 'Pop requires an explicit scope ID');
    return {type: 'void'};
  }
  fields(op, ['id', 'type', 'opcode', 'inputs', 'source'], 'integer/copy operation');
  if (!['COPY', 'CAST'].includes(op.opcode) && !integerOps.has(op.opcode))
    fail('CFG_UNSUPPORTED', `Unsupported operation ${op.opcode}`, {source: op.source});
  if (!Array.isArray(op.inputs)) fail('CFG_SCHEMA', 'Operation inputs must be an array');
  checkType(db, op.type);
  return {type: op.type};
}

function validateFunction(fn, db) {
  fields(
    fn,
    ['implementation', 'provenance', 'variant', 'parameterValues', 'entryBlock', 'blocks'],
    'CFG function',
  );
  const implementation = resolveImplementation(db, fn.implementation);
  validateProvenance(fn.provenance);
  const binaryIdentity = db.binaries.find(
    (binary) => binary.executableSha256 === fn.provenance.binary.executableSha256,
  );
  if (
    !binaryIdentity ||
    !equal(
      Object.fromEntries(
        Object.keys(fn.provenance.binary).map((key) => [key, binaryIdentity[key]]),
      ),
      fn.provenance.binary,
    )
  )
    fail('CFG_MAPPING', 'Body provenance differs from the mapping database binary identity');
  validateVariant(fn, db);
  dictionary(fn.parameterValues, 'parameterValues');
  const parameters = implementation.signature.parameters;
  if (
    !equal(
      Object.keys(fn.parameterValues).sort(),
      parameters.map((parameter) => parameter.name).sort(),
    )
  )
    fail('CFG_SIGNATURE', 'Parameter bindings must exactly match the mapping database signature');
  if (!Array.isArray(fn.blocks) || fn.blocks.length === 0 || fn.blocks.length > 10000)
    fail('CFG_SCHEMA', 'Expected 1..10000 blocks');
  const blockIds = new Set(),
    defs = new Map(),
    opMetadata = new Map(),
    sources = new Set(),
    usedFamilies = new Set();
  const define = (id, type, block, index) => {
    if (!simple(id) || defs.has(id)) fail('CFG_SSA', `Duplicate or invalid value ID ${id}`);
    checkType(db, type);
    defs.set(id, {type, block, index});
  };
  for (const parameter of parameters)
    define(fn.parameterValues[parameter.name], parameter.type, null, -1);
  function source(value) {
    fields(
      value,
      Object.hasOwn(value ?? {}, 'loweringIndex')
        ? ['address', 'sequence', 'loweringIndex']
        : ['address', 'sequence'],
      'source location',
    );
    if (
      !Number.isSafeInteger(value.sequence) ||
      value.sequence < 0 ||
      !fn.provenance.bodyRanges.some(
        (range) =>
          address(value.address) >= address(range.start) &&
          address(value.address) <= address(range.end),
      )
    )
      fail(
        'CFG_PROVENANCE',
        'Source locations require an in-body address and nonnegative sequence',
      );
    if (!Number.isSafeInteger(value.loweringIndex ?? 0) || (value.loweringIndex ?? 0) < 0)
      fail('CFG_PROVENANCE', 'Lowering index must be a nonnegative integer');
    const key = `${value.address}:${value.sequence}:${value.loweringIndex ?? 0}`;
    if (sources.has(key)) fail('CFG_PROVENANCE', `Duplicate source sequence ${key}`);
    sources.add(key);
  }
  for (const block of fn.blocks) {
    fields(block, ['id', 'phis', 'operations', 'terminator'], 'block');
    if (!simple(block.id) || blockIds.has(block.id))
      fail('CFG_BLOCK', `Duplicate or invalid block ${block.id}`);
    blockIds.add(block.id);
    if (!Array.isArray(block.phis) || !Array.isArray(block.operations))
      fail('CFG_SCHEMA', 'Block phis and operations must be arrays');
    for (const phi of block.phis) {
      fields(phi, ['id', 'type', 'incoming', 'source'], 'phi');
      dictionary(phi.incoming, 'phi incoming');
      source(phi.source);
      define(phi.id, phi.type, block.id, -1);
    }
    block.operations.forEach((op, index) => {
      source(op.source);
      const metadata = operationShape(op, db);
      opMetadata.set(op, metadata);
      if (metadata.family) usedFamilies.add(metadata.family.id);
      if (metadata.type !== 'void') define(op.id, metadata.type, block.id, index);
      else if (Object.hasOwn(op, 'id') && op.id !== null)
        fail('CFG_TYPE', 'Void calls require id:null');
    });
    source(block.terminator.source);
  }
  if (!blockIds.has(fn.entryBlock)) fail('CFG_ENTRY', 'Entry block is absent');
  const cfg = graph(fn.blocks, fn.entryBlock);
  if (cfg.predecessors.get(fn.entryBlock).length)
    fail('CFG_ENTRY', 'Use a separate loop header; entry block cannot have incoming edges');
  function operandType(operand, useBlock, useIndex, predecessor = null) {
    if (operand && Object.hasOwn(operand, 'ref')) {
      fields(operand, ['ref'], 'value reference');
      const definition = defs.get(operand.ref);
      if (!definition) fail('CFG_SSA', `Undefined value ${operand.ref}`);
      const targetBlock = predecessor ?? useBlock;
      if (
        definition.block !== null &&
        (!cfg.dominators.get(targetBlock).has(definition.block) ||
          (predecessor === null && definition.block === useBlock && definition.index >= useIndex))
      )
        fail('CFG_DOMINANCE', `Value ${operand.ref} does not dominate its use in ${useBlock}`, {
          predecessor,
        });
      return definition.type;
    }
    if (operand && Object.hasOwn(operand, 'boolean')) {
      fields(operand, ['boolean'], 'boolean');
      if (typeof operand.boolean !== 'boolean')
        fail('CFG_TYPE', 'Boolean constants require boolean values');
      return 'bool';
    }
    fields(operand, ['constant', 'type'], 'integer constant');
    const type = integerTypes.get(operand.type);
    if (!type || address(operand.constant) >= 1n << BigInt(type.bits))
      fail(
        'CFG_TYPE',
        'Integer constants require an explicit scalar type and in-width unsigned encoding',
      );
    return operand.type;
  }
  for (const block of fn.blocks) {
    const predecessors = cfg.predecessors.get(block.id);
    if (block.id === fn.entryBlock && block.phis.length)
      fail('CFG_PHI', 'Entry block cannot contain phi nodes');
    for (const phi of block.phis) {
      if (!equal(Object.keys(phi.incoming).sort(), [...predecessors].sort()))
        fail('CFG_PHI', `Phi ${phi.id} requires exactly one incoming value per predecessor`);
      for (const [pred, value] of Object.entries(phi.incoming))
        if (!equal(operandType(value, block.id, -1, pred), phi.type))
          fail('CFG_TYPE', `Phi ${phi.id} changes its input type`);
    }
    block.operations.forEach((op, index) => {
      const metadata = opMetadata.get(op);
      if (metadata.signature) {
        dictionary(op.arguments, 'call arguments');
        if (
          !equal(
            Object.keys(op.arguments).sort(),
            metadata.signature.parameters.map((parameter) => parameter.name).sort(),
          )
        )
          fail(
            'CFG_SIGNATURE',
            'Call arguments must exactly match explicit implementation parameters',
          );
        for (const parameter of metadata.signature.parameters)
          if (!equal(operandType(op.arguments[parameter.name], block.id, index), parameter.type))
            fail(
              'CFG_TYPE',
              `Call argument ${parameter.name} has a different type from the database signature`,
            );
        return;
      }
      if (['PUSH_VARIANT', 'POP_VARIANT'].includes(op.opcode)) return;
      const types = op.inputs.map((input) => operandType(input, block.id, index));
      if (['COPY', 'CAST'].includes(op.opcode)) {
        const sameInteger =
          op.opcode === 'CAST' &&
          types.length === 1 &&
          integer(db, types[0]) &&
          integer(db, types[0]).bits === integer(db, op.type)?.bits;
        if (types.length !== 1 || (!equal(types[0], op.type) && !sameInteger))
          fail(
            'CFG_TYPE',
            'Copy/cast requires identical types or an explicit same-width integer cast; unknown data is never coerced',
          );
        return;
      }
      const args = types.map((type) => integer(db, type)),
        output = integer(db, op.type);
      const arity = unaryOps.has(op.opcode) ? 1 : 2;
      if (types.length !== arity || args.some((type) => !type))
        fail('CFG_TYPE', `${op.opcode} requires ${arity} integer inputs`);
      let valid;
      if (comparisons.has(op.opcode))
        valid = args[0].bits === args[1].bits && (op.type === 'bool' || output?.bits === 8);
      else if (!output) valid = false;
      else if (['INT_ZEXT', 'INT_SEXT'].includes(op.opcode)) valid = output.bits > args[0].bits;
      else if (shiftOps.has(op.opcode)) valid = output.bits === args[0].bits;
      else if (op.opcode === 'PIECE') valid = output.bits === args[0].bits + args[1].bits;
      else if (op.opcode === 'SUBPIECE')
        valid =
          Object.hasOwn(op.inputs[1], 'constant') &&
          BigInt(op.inputs[1].constant) * 8n + BigInt(output.bits) <= BigInt(args[0].bits);
      else valid = args.every((type) => type.bits === output.bits);
      if (!valid) fail('CFG_TYPE', `Invalid width relationship for ${op.opcode}`);
    });
    const term = block.terminator;
    if (term.opcode === 'BRANCH') {
      const type = operandType(term.condition, block.id, block.operations.length);
      if (type !== 'bool' && !integer(db, type))
        fail('CFG_TYPE', 'Branches require an explicit boolean or integer condition');
    }
    if (term.opcode === 'RETURN') {
      if (implementation.signature.returnType === 'void') {
        if (term.value !== null) fail('CFG_TYPE', 'Void return requires value:null');
      } else if (
        !equal(
          operandType(term.value, block.id, block.operations.length),
          implementation.signature.returnType,
        )
      )
        fail('CFG_TYPE', 'Return type differs from implementation signature');
    }
  }
  // A function owns its pushes. Every edge must preserve one exact scope stack;
  // calls cannot consume a caller frame and loops cannot leak frames per iteration.
  const scopeIds = new Set(),
    pushes = new Map();
  for (const block of fn.blocks)
    for (const op of block.operations)
      if (op.opcode === 'PUSH_VARIANT') {
        if (scopeIds.has(op.scopeId)) fail('CFG_VARIANT_STACK', `Duplicate scope ID ${op.scopeId}`);
        scopeIds.add(op.scopeId);
        pushes.set(op.scopeId, op);
      }
  const stacks = new Map([[fn.entryBlock, []]]),
    queue = [fn.entryBlock];
  while (queue.length) {
    const id = queue.shift(),
      block = cfg.byId.get(id),
      stack = [...stacks.get(id)];
    for (const op of block.operations) {
      if (op.opcode === 'PUSH_VARIANT') stack.push(op.scopeId);
      if (op.opcode === 'POP_VARIANT' && stack.pop() !== op.scopeId)
        fail('CFG_VARIANT_STACK', `Unbalanced variant pop ${op.scopeId} in ${id}`);
    }
    if (block.terminator.opcode === 'RETURN' && stack.length)
      fail('CFG_VARIANT_STACK', `Return from ${id} leaks variant scopes`);
    for (const target of cfg.successors.get(id)) {
      if (stacks.has(target)) {
        if (!equal(stacks.get(target), stack))
          fail('CFG_VARIANT_STACK', `Incompatible variant stacks at ${target}`);
      } else {
        stacks.set(target, [...stack]);
        queue.push(target);
      }
    }
  }
  return {fn, implementation, parameters, defs, opMetadata, usedFamilies, pushes, cfg, operandType};
}

export function validateCfgModule(module, db) {
  validateDatabase(db);
  fields(module, ['schemaVersion', 'kind', 'entryImplementation', 'functions'], 'CFG module');
  if (
    module.schemaVersion !== 2 ||
    module.kind !== 'reviewed-cfg-module' ||
    !Array.isArray(module.functions) ||
    module.functions.length === 0
  )
    fail('CFG_SCHEMA', 'Expected reviewed-cfg-module version 2');
  const functions = new Map();
  for (const fn of module.functions) {
    if (functions.has(fn.implementation))
      fail('CFG_MAPPING', `Duplicate generated implementation ${fn.implementation}`);
    functions.set(fn.implementation, validateFunction(fn, db));
  }
  for (const {fn} of functions.values()) {
    if (fn.variant?.kind !== 'reviewed-patch') continue;
    const key = nativeKey(fn.provenance),
      baseHash = fn.variant.baseBodySha256;
    const localBase = [...functions.values()].some(({fn: candidate}) => {
      const candidateKey = nativeKey(candidate.provenance);
      return (
        candidateKey.binarySha256 === key.binarySha256 &&
        candidateKey.rva === key.rva &&
        candidate.provenance.bodySha256 === baseHash
      );
    });
    const registeredBase = db.variantFamilies
      .filter((family) => family.kind === 'code')
      .some((family) =>
        family.operations.some((operation) =>
          operation.targets.some((target) =>
            target.applicability.some(
              (item) =>
                item.binarySha256 === key.binarySha256 &&
                item.rva === key.rva &&
                item.body.sha256 === baseHash,
            ),
          ),
        ),
      );
    if (baseHash === fn.provenance.bodySha256 || (!localBase && !registeredBase))
      fail('CFG_VARIANT', 'Patch base must identify a distinct known body at the same native slot');
  }
  if (!functions.has(module.entryImplementation))
    fail('CFG_ENTRY', 'Entry implementation has no generated body');
  const report = {
    schemaVersion: 2,
    status: 'reviewed-cfg-prototype',
    irSha256: sha256(canonicalJson(module)),
    databaseSha256: sha256(canonicalJson(db)),
    entryImplementation: module.entryImplementation,
    functions: [...functions.values()].map((item) => ({
      implementation: item.fn.implementation,
      slotKey: slotKey(item.fn.provenance.binary, item.fn.provenance.entryAddress),
      provenance: item.fn.provenance,
      variant: item.fn.variant,
      calls: item.fn.blocks.flatMap((block) =>
        block.operations
          .filter((op) => ['CALL', 'CALL_IMPLEMENTATION', 'VARIANT_CALL'].includes(op.opcode))
          .map((op) => {
            const metadata = item.opMetadata.get(op);
            return {
              block: block.id,
              source: op.source,
              nativeTarget: op.opcode === 'CALL' ? op.target : null,
              route: metadata.family
                ? 'variant-stack'
                : metadata.directImport
                  ? 'direct-import'
                  : functions.has(metadata.implementation.id)
                    ? 'generated-function'
                    : 'direct-import',
              family: metadata.family?.id ?? null,
              operation: metadata.operation?.id ?? null,
              implementation: metadata.implementation?.id ?? null,
              signature: metadata.signature,
            };
          }),
      ),
      ...item.cfg.report,
    })),
    limits: [
      'Integer CFG subset and explicit mapped calls only',
      'Variant bytes are provenance; already decoded reviewed bodies are required',
      'No automatic unknown datatype coercion',
      'No native equivalence or runtime integration claim',
    ],
  };
  return {functions, report};
}

function moduleSpecifier(root, fromFile, module) {
  let relative = path
    .relative(path.dirname(fromFile), path.resolve(root, module))
    .split(path.sep)
    .join('/');
  if (!relative.startsWith('.')) relative = './' + relative;
  return relative;
}

/** Emit explicit parameter signatures and imports solely from the mapping database. */
export function emitCfgTypeScript(
  module,
  db,
  {root = process.cwd(), fromFile = path.resolve(root, 'native-cfg-output.ts')} = {},
) {
  root = realpathSync(root);
  fromFile = path.resolve(root, fromFile);
  fromFile = path.join(realpathSync(path.dirname(fromFile)), path.basename(fromFile));
  const validated = validateCfgModule(module, db),
    imports = new Map(),
    typeImports = new Map(),
    localNames = new Map(
      [...validated.functions.keys()].map((id, index) => [id, `generated_${index}`]),
    );
  const typeName = (type) => {
    const resolved = resolveType(db, type);
    for (const imported of resolved.imports)
      typeImports.set(`${imported.module}#${imported.export}`, imported);
    return resolved.typeScript;
  };
  const signatureText = (signature) =>
    `(${signature.parameters.map((parameter, index) => `arg${index}: ${typeName(parameter.type)}`).join(', ')}) => ${typeName(signature.returnType)}`;
  const importedImplementationName = (id) => {
    if (!imports.has(id))
      imports.set(id, {name: `mapped_${imports.size}`, definition: resolveImplementation(db, id)});
    return imports.get(id).name;
  };
  const implementationName = (id) => {
    if (localNames.has(id)) return localNames.get(id);
    return importedImplementationName(id);
  };
  const families = new Map();
  for (const fn of validated.functions.values())
    for (const id of fn.usedFamilies)
      if (!families.has(id))
        families.set(id, {family: resolveVariantFamily(db, id), index: families.size});
  const statements = [],
    emit = (indent, value) => statements.push('  '.repeat(indent) + value);
  emit(0, 'export function createExecution() {');
  emit(1, 'let nextScopeOrder = 0n;');
  emit(
    1,
    'const trace: {event: string; family: string; scopeId: string; selectorValue: number; implementation: string; block: string; address: string; sequence: number}[] = [];',
  );
  for (const {family, index} of families.values()) {
    const operationType = `{${family.operations.map((operation) => `${JSON.stringify(operation.id)}: ${signatureText(operation.signature)}`).join('; ')}}`;
    emit(1, `type Variant_${index} = ${operationType};`);
    const table = family.kind === 'code' ? 'unstable_functions' : 'unstable_types';
    const targets = family.selector.values.map(
      (selector) =>
        `{${family.operations
          .map((operation) => {
            const target = operation.targets.find((item) => item.selectorValue === selector);
            if (!target) fail('CFG_VARIANT', 'A family operation is missing a finite target');
            return `${JSON.stringify(operation.id)}: ${implementationName(target.implementation)}`;
          })
          .join(', ')}}`,
    );
    emit(1, `const ${table}_${index}: readonly Variant_${index}[] = [${targets.join(', ')}];`);
    emit(
      1,
      `type Frame_${index} = {target: Variant_${index}; order: bigint; family: string; scopeId: string; selectorValue: number; implementation: string; block: string; address: string; sequence: number};`,
    );
    const initialIndex = family.selector.values.indexOf(family.selector.initial);
    const initialImplementations = family.operations
      .map(
        (operation) =>
          operation.targets.find((target) => target.selectorValue === family.selector.initial)
            ?.implementation,
      )
      .filter(Boolean)
      .join(',');
    const initial =
      initialIndex < 0
        ? ''
        : `{target: ${table}_${index}[${initialIndex}]!, order: 0n, family: ${JSON.stringify(family.id)}, scopeId: 'initial', selectorValue: ${family.selector.initial}, implementation: ${JSON.stringify(initialImplementations)}, block: 'initial', address: 'initial', sequence: 0}`;
    emit(1, `const active_${index}: Frame_${index}[] = [${initial}];`);
    emit(1, `function top_${index}(): Frame_${index} {`);
    emit(2, `const frame = active_${index}[active_${index}.length - 1];`);
    emit(
      2,
      `if (!frame) throw new Error(${JSON.stringify(`No active variant for ${family.id}; the code/type remains unknown`)});`,
    );
    emit(2, 'return frame;');
    emit(1, '}');
  }
  for (const item of validated.functions.values()) {
    const {fn, implementation, parameters, defs, opMetadata} = item;
    const names = new Map([...defs.keys()].map((id, index) => [id, `v${index}`]));
    const read = (operand) => {
      if (Object.hasOwn(operand, 'ref')) return names.get(operand.ref);
      if (Object.hasOwn(operand, 'boolean')) return String(operand.boolean);
      const description = integerTypes.get(operand.type),
        bigint = `${operand.constant}n`;
      return description.bits === 64
        ? `BigInt.as${description.signed ? 'Int' : 'Uint'}N(${description.bits}, ${bigint})`
        : `Number(BigInt.as${description.signed ? 'Int' : 'Uint'}N(${description.bits}, ${bigint}))`;
    };
    const operandDescription = (operand) =>
      Object.hasOwn(operand, 'ref')
        ? defs.get(operand.ref).type
        : Object.hasOwn(operand, 'boolean')
          ? 'bool'
          : operand.type;
    const asBits = (operand) => {
      const description = integer(db, operandDescription(operand));
      return `BigInt.asUintN(${description.bits}, ${description.representation === 'bigint' ? read(operand) : `BigInt(${read(operand)})`})`;
    };
    const expression = (op) => {
      if (op.opcode === 'COPY' || (op.opcode === 'CAST' && !integer(db, op.type)))
        return read(op.inputs[0]);
      if (op.opcode === 'CAST') {
        const output = integer(db, op.type),
          normalized = `BigInt.as${output.signed ? 'Int' : 'Uint'}N(${output.bits}, ${asBits(op.inputs[0])})`;
        return output.representation === 'bigint' ? normalized : `Number(${normalized})`;
      }
      const [a, b] = op.inputs.map(asBits),
        description = integer(db, operandDescription(op.inputs[0]));
      const signedA = `BigInt.asIntN(${description.bits}, ${a})`,
        signedB = `BigInt.asIntN(${description.bits}, ${b})`;
      let value;
      const infix = {
        INT_ADD: '+',
        INT_SUB: '-',
        INT_MULT: '*',
        INT_AND: '&',
        INT_OR: '|',
        INT_XOR: '^',
      };
      if (op.opcode in infix) value = `${a} ${infix[op.opcode]} ${b}`;
      else if (op.opcode === 'INT_2COMP') value = `-${a}`;
      else if (op.opcode === 'INT_NEGATE') value = `~${a}`;
      else if (op.opcode === 'INT_SEXT') value = signedA;
      else if (op.opcode === 'INT_ZEXT') value = a;
      else if (comparisons.has(op.opcode)) {
        const operators = {
            INT_EQUAL: '===',
            INT_NOTEQUAL: '!==',
            INT_LESS: '<',
            INT_LESSEQUAL: '<=',
            INT_SLESS: '<',
            INT_SLESSEQUAL: '<=',
          },
          signed = ['INT_SLESS', 'INT_SLESSEQUAL'].includes(op.opcode);
        const comparison = `${signed ? signedA : a} ${operators[op.opcode]} ${signed ? signedB : b}`;
        if (op.type === 'bool') return `(${comparison})`;
        value = `(${comparison} ? 1n : 0n)`;
      } else if (shiftOps.has(op.opcode))
        value = `(${b} >= ${description.bits}n ? ${op.opcode === 'INT_SRIGHT' ? `(${signedA} < 0n ? -1n : 0n)` : '0n'} : ${op.opcode === 'INT_SRIGHT' ? signedA : a} ${op.opcode === 'INT_LEFT' ? '<<' : '>>'} ${b})`;
      else if (op.opcode === 'PIECE')
        value = `(${a} << ${integer(db, operandDescription(op.inputs[1])).bits}n) | ${b}`;
      else if (op.opcode === 'SUBPIECE') value = `${a} >> ${BigInt(op.inputs[1].constant) * 8n}n`;
      else fail('CFG_UNSUPPORTED', 'Unsupported expression reached emitter');
      const output = integer(db, op.type),
        normalized = `BigInt.as${output.signed ? 'Int' : 'Uint'}N(${output.bits}, ${value})`;
      return output.representation === 'bigint' ? normalized : `Number(${normalized})`;
    };
    const params = parameters
      .map((parameter, index) => `arg${index}: ${typeName(parameter.type)}`)
      .join(', ');
    emit(
      1,
      `function ${localNames.get(fn.implementation)}(${params}): ${typeName(implementation.signature.returnType)} {`,
    );
    for (const {index} of families.values())
      emit(2, `const inheritedDepth_${index} = active_${index}.length;`);
    parameters.forEach((parameter, index) =>
      emit(
        2,
        `const ${names.get(fn.parameterValues[parameter.name])}: ${typeName(parameter.type)} = arg${index};`,
      ),
    );
    for (const [id, definition] of defs)
      if (definition.block !== null)
        emit(2, `let ${names.get(id)}!: ${typeName(definition.type)};`);
    emit(2, `let block: string = ${JSON.stringify(fn.entryBlock)};`);
    emit(2, 'let predecessor: string | null = null;');
    emit(2, 'try {');
    emit(3, 'while (true) {');
    emit(4, 'switch (block) {');
    for (const block of fn.blocks) {
      emit(5, `case ${JSON.stringify(block.id)}: {`);
      emit(6, `// ${fn.provenance.entryAddress} block ${block.id}`);
      if (block.phis.length) {
        emit(6, 'switch (predecessor) {');
        for (const pred of item.cfg.predecessors.get(block.id)) {
          emit(7, `case ${JSON.stringify(pred)}: {`);
          block.phis.forEach((phi, index) =>
            emit(8, `const phi_${index} = ${read(phi.incoming[pred])};`),
          );
          block.phis.forEach((phi, index) => emit(8, `${names.get(phi.id)} = phi_${index};`));
          emit(8, 'break;');
          emit(7, '}');
        }
        emit(
          7,
          `default: throw new Error(${JSON.stringify(`Invalid predecessor for ${block.id}`)});`,
        );
        emit(6, '}');
      }
      for (const op of block.operations) {
        emit(6, `// ${op.source.address}:${op.source.sequence} ${op.opcode}`);
        const metadata = opMetadata.get(op);
        if (op.opcode === 'PUSH_VARIANT') {
          const {family, index} = families.get(op.family),
            valueIndex = family.selector.values.indexOf(op.selectorValue),
            table = family.kind === 'code' ? 'unstable_functions' : 'unstable_types';
          const targets = family.operations
            .map(
              (operation) =>
                operation.targets.find((target) => target.selectorValue === op.selectorValue)
                  .implementation,
            )
            .join(',');
          const debug = `family: ${JSON.stringify(op.family)}, scopeId: ${JSON.stringify(op.scopeId)}, selectorValue: ${op.selectorValue}, implementation: ${JSON.stringify(targets)}, block: ${JSON.stringify(block.id)}, address: ${JSON.stringify(op.source.address)}, sequence: ${op.source.sequence}`;
          emit(
            6,
            `active_${index}.push({target: ${table}_${index}[${valueIndex}]!, order: ++nextScopeOrder, ${debug}});`,
          );
          emit(6, `trace.push({event: 'push', ${debug}});`);
        } else if (op.opcode === 'POP_VARIANT') {
          const push = item.pushes.get(op.scopeId),
            {index} = families.get(push.family);
          emit(
            6,
            `if (top_${index}().scopeId !== ${JSON.stringify(op.scopeId)}) throw new Error('Variant scope stack mismatch');`,
          );
          emit(
            6,
            `trace.push({event: 'pop', ...top_${index}(), block: ${JSON.stringify(block.id)}, address: ${JSON.stringify(op.source.address)}, sequence: ${op.source.sequence}});`,
          );
          emit(6, `active_${index}.pop();`);
        } else if (metadata.signature) {
          const args = metadata.signature.parameters
            .map((parameter) => read(op.arguments[parameter.name]))
            .join(', ');
          let callee;
          if (metadata.family) {
            const {index} = families.get(metadata.family.id);
            emit(
              6,
              `trace.push({event: 'call', ...top_${index}(), block: ${JSON.stringify(block.id)}, address: ${JSON.stringify(op.source.address)}, sequence: ${op.source.sequence}});`,
            );
            callee = `top_${index}().target[${JSON.stringify(metadata.operation.id)}]`;
          } else
            callee = metadata.directImport
              ? importedImplementationName(metadata.implementation.id)
              : implementationName(metadata.implementation.id);
          emit(6, `${metadata.type === 'void' ? '' : names.get(op.id) + ' = '}${callee}(${args});`);
        } else emit(6, `${names.get(op.id)} = ${expression(op)};`);
      }
      const term = block.terminator;
      emit(6, `// ${term.source.address}:${term.source.sequence} ${term.opcode}`);
      if (term.opcode === 'RETURN')
        emit(6, `return${term.value === null ? '' : ' ' + read(term.value)};`);
      else {
        emit(6, `predecessor = ${JSON.stringify(block.id)};`);
        if (term.opcode === 'JUMP') emit(6, `block = ${JSON.stringify(term.target)};`);
        else {
          const type = operandDescription(term.condition),
            condition =
              type === 'bool'
                ? read(term.condition)
                : `${read(term.condition)} !== ${integer(db, type).representation === 'bigint' ? '0n' : '0'}`;
          emit(
            6,
            `block = ${condition} ? ${JSON.stringify(term.trueTarget)} : ${JSON.stringify(term.falseTarget)};`,
          );
        }
        emit(6, 'continue;');
      }
      emit(5, '}');
    }
    emit(5, "default: throw new Error('Invalid CFG block');");
    emit(4, '}');
    emit(3, '}');
    emit(2, '} finally {');
    if (families.size) {
      emit(3, 'while (true) {');
      emit(4, 'let unwindFamily = -1;');
      emit(4, 'let unwindOrder = -1n;');
      for (const {index} of families.values()) {
        emit(
          4,
          `if (active_${index}.length > inheritedDepth_${index} && top_${index}().order > unwindOrder) {`,
        );
        emit(5, `unwindFamily = ${index}; unwindOrder = top_${index}().order;`);
        emit(4, '}');
      }
      emit(4, 'if (unwindFamily < 0) break;');
      emit(4, 'switch (unwindFamily) {');
      for (const {index} of families.values())
        emit(
          5,
          `case ${index}: trace.push({event: 'unwind', ...top_${index}()}); active_${index}.pop(); break;`,
        );
      emit(4, '}');
      emit(3, '}');
    }
    emit(2, '}');
    emit(1, '}');
  }
  emit(
    1,
    `return {invoke: ${localNames.get(module.entryImplementation)}, getTrace: () => trace.map(({event, family, scopeId, selectorValue, implementation, block, address, sequence}) => ({event, family, scopeId, selectorValue, implementation, block, address, sequence})), getActiveDepths: () => ({${[...families].map(([id, {index}]) => `${JSON.stringify(id)}: active_${index}.length`).join(', ')}})};`,
  );
  emit(0, '}');
  const entry = validated.functions.get(module.entryImplementation).implementation;
  const parameterNames = new Set(entry.signature.parameters.map((parameter) => parameter.name));
  let executionFactoryName = 'cfgExecutionFactory';
  while (parameterNames.has(executionFactoryName)) executionFactoryName += '_';
  emit(0, `const ${executionFactoryName} = createExecution;`);
  emit(
    0,
    `export function lifted(${entry.signature.parameters.map((parameter, index) => `${parameter.name}: ${typeName(parameter.type)}`).join(', ')}): ${typeName(entry.signature.returnType)} {`,
  );
  emit(
    1,
    `return ${executionFactoryName}().invoke(${entry.signature.parameters.map((parameter) => parameter.name).join(', ')});`,
  );
  emit(0, '}');
  const header = [
    '// Generated CFG prototype: exact imports/signatures come from the local mapping database.',
  ];
  for (const imported of typeImports.values())
    header.push(
      `import type {${imported.export} as ${imported.localName}} from ${JSON.stringify(moduleSpecifier(root, fromFile, imported.module))};`,
    );
  for (const {name, definition} of imports.values())
    header.push(
      `import {${definition.export} as ${name}} from ${JSON.stringify(moduleSpecifier(root, fromFile, definition.module))};`,
    );
  header.push(`export const cfgReceipt = ${JSON.stringify(validated.report, null, 2)} as const;`);
  return {source: [...header, ...statements, ''].join('\n'), report: validated.report};
}

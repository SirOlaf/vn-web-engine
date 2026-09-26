import {canonicalJson, sha256} from './index.mjs';
import {databaseSha256, resolveType, validateDatabase} from './database.mjs';
import {validateGhidraExport} from './ghidra-import.mjs';

const BOOLEAN_OPS = new Set([
  'BOOL_AND',
  'BOOL_NEGATE',
  'BOOL_OR',
  'BOOL_XOR',
  'FLOAT_EQUAL',
  'FLOAT_LESS',
  'FLOAT_LESSEQUAL',
  'FLOAT_NAN',
  'INT_CARRY',
  'INT_EQUAL',
  'INT_LESS',
  'INT_LESSEQUAL',
  'INT_NOTEQUAL',
  'INT_SBORROW',
  'INT_SCARRY',
  'INT_SLESS',
  'INT_SLESSEQUAL',
]);
const POINTER_PASSTHROUGH = new Set(['CAST', 'COPY', 'INT_SEXT', 'INT_ZEXT']);
const POINTER_ARITHMETIC = new Set(['INT_ADD', 'PTRADD', 'PTRSUB']);

function hex(value) {
  const bigint = BigInt(value);
  return bigint < 0n ? `-0x${(-bigint).toString(16)}` : `0x${bigint.toString(16)}`;
}

function signedConstant(value) {
  return BigInt.asIntN(value.size * 8, BigInt(value.offset));
}

function typeEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function namedType(type) {
  return type && typeof type === 'object' ? type.named : null;
}

function cloneProjection(projection) {
  return projection === null ? null : structuredClone(projection);
}

function same(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function sorted(values) {
  return [...new Set(values)].sort();
}

function bitvector(bits) {
  return {kind: 'bitvector', bits, safeResetAndRetype: true};
}

function unknown(bits) {
  return {kind: 'unknown', bits, safeResetAndRetype: false};
}

function addressType(bits) {
  return {kind: 'address', bits, safeResetAndRetype: false};
}

function inferOutputType(op, value, addressExpression) {
  if (addressExpression) return addressType(value.size * 8);
  if (BOOLEAN_OPS.has(op.opcode)) return {kind: 'boolean', bits: 8, safeResetAndRetype: true};
  if (op.opcode.startsWith('FLOAT_'))
    return {kind: 'float', bits: value.size * 8, safeResetAndRetype: true};
  if (op.opcode === 'LOAD') return unknown(value.size * 8);
  return bitvector(value.size * 8);
}

function safeMerge(type, inputTypes) {
  return (
    type.safeResetAndRetype === true &&
    inputTypes.length > 0 &&
    inputTypes.every(
      (input) =>
        input.safeResetAndRetype === true && input.kind === type.kind && input.bits === type.bits,
    )
  );
}

function mapEqual(left, right) {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    const other = right.get(key);
    if (
      !other ||
      value.length !== other.length ||
      value.some((item, index) => item !== other[index])
    )
      return false;
  }
  return true;
}

/**
 * Lift a normalized Ghidra HighFunction into address slots and write generations.
 * A generation represents a static write site. A loop can execute that generation
 * repeatedly; the CFG merge records the loop-carried alternatives.
 */
export function analyzeGenerationalSlots(exported, database = null) {
  const graph = validateGhidraExport(exported);
  if (database !== null) validateDatabase(database);
  const {blocks, ops, values, spaces} = graph;
  let nextAnonymous = 0;
  let nextAddress = 0;
  const slots = [];
  const slotById = new Map();
  const anonymousByStorage = new Map();
  const addressByKey = new Map();
  const bindings = {};
  const addressExpressionByVarnode = new Map();
  const addressConsumers = new Set();
  const pointerRelevant = new Set();
  const unresolvedAddresses = [];
  const accesses = [];
  const merges = [];
  const generationById = new Map();
  const generationForStore = new Map();
  const generationForMemoryOutput = new Map();
  const mergeGenerationByKey = new Map();
  const consumersByVarnode = new Map();
  const expressionByKey = new Map();
  const parameterByVarnode = new Map();

  const binary = database?.binaries.find(
    (candidate) => candidate.executableSha256 === exported.binary.executableSha256,
  );
  const rva = binary
    ? hex(BigInt(exported.function.entryAddress) - BigInt(binary.imageBase))
    : null;
  const functionMapping = binary
    ? (database.functions.find(
        (candidate) => candidate.binarySha256 === binary.executableSha256 && candidate.rva === rva,
      ) ?? null)
    : null;

  function locationMatches(value, location) {
    if (location.kind === 'register')
      return value.kind === 'register' && value.register?.toLowerCase() === location.name;
    if (location.kind === 'stack') {
      const space = spaces.get(value.spaceId);
      return (
        value.kind === 'stack' &&
        space &&
        BigInt.asIntN(space.sizeBits, BigInt(value.offset)) === BigInt(location.offsetBytes)
      );
    }
    return false;
  }

  if (functionMapping) {
    for (const parameter of functionMapping.abi.parameters) {
      const matches = [...values.values()].filter(
        (value) => value.flags.input && locationMatches(value, parameter.location),
      );
      if (matches.length === 1) parameterByVarnode.set(matches[0].id, parameter);
    }
  }

  function machineTypeForSemantic(semanticType, bits) {
    if (!database || semanticType === null) return null;
    const resolved = resolveType(database, semanticType);
    if (resolved.kind === 'integer') return bitvector(resolved.bits);
    if (resolved.kind === 'float')
      return {kind: 'float', bits: resolved.bits, safeResetAndRetype: true};
    if (resolved.kind === 'boolean') return {kind: 'boolean', bits: 8, safeResetAndRetype: true};
    if (resolved.kind === 'reference') return addressType(resolved.nativeBits);
    if (resolved.kind === 'unknown' || resolved.kind === 'opaque') return unknown(bits);
    return null;
  }

  function layoutFor(type) {
    const id = namedType(type);
    return id ? ((database?.layouts ?? []).find((layout) => layout.type === id) ?? null) : null;
  }

  function addProjectionOffset(projection, offset, dynamicIndex = null, materializeZero = false) {
    if (!projection) return null;
    const result = cloneProjection(projection);
    result.byteOffset = hex(BigInt(result.byteOffset) + offset);
    if (offset === 0n && dynamicIndex === null && !materializeZero) return result;
    let remaining = offset;
    let currentType = result.type;
    let layout = layoutFor(currentType);
    if (dynamicIndex !== null && layout?.kind === 'array') {
      result.steps.push({
        kind: 'element',
        layoutId: layout.id,
        ownerType: layout.type,
        index: dynamicIndex,
        elementSizeBytes: layout.elementSizeBytes,
        type: layout.elementType,
      });
      result.type = layout.elementType;
      return result;
    }
    while (remaining >= 0n && layout) {
      if (layout.kind === 'array') {
        const elementSize = BigInt(layout.elementSizeBytes);
        const index = remaining / elementSize;
        if (index >= BigInt(layout.count)) break;
        result.steps.push({
          kind: 'element',
          layoutId: layout.id,
          ownerType: layout.type,
          index: hex(index),
          elementSizeBytes: layout.elementSizeBytes,
          type: layout.elementType,
        });
        remaining %= elementSize;
        currentType = layout.elementType;
      } else {
        const field = layout.fields.find(
          (candidate) =>
            remaining >= BigInt(candidate.offsetBytes) &&
            remaining < BigInt(candidate.offsetBytes + candidate.sizeBytes),
        );
        if (!field) break;
        result.steps.push({
          kind: 'field',
          layoutId: layout.id,
          ownerType: layout.type,
          name: field.name,
          offsetBytes: field.offsetBytes,
          sizeBytes: field.sizeBytes,
          storage: field.storage,
          type: field.type,
        });
        remaining -= BigInt(field.offsetBytes);
        currentType = field.type;
      }
      if (remaining === 0n) {
        result.type = currentType;
        return result;
      }
      layout = layoutFor(currentType);
    }
    if (remaining !== 0n) result.steps.push({kind: 'offset', offsetBytes: hex(remaining)});
    result.type = remaining === 0n ? currentType : null;
    return result;
  }

  function globalProjection(expression) {
    if (!database || expression.kind !== 'program') return null;
    const address = BigInt(expression.address);
    const candidates = (database.globals ?? [])
      .filter((global) => global.binarySha256 === exported.binary.executableSha256)
      .map((global) => ({global, layout: layoutFor(global.type)}))
      .filter(({global, layout}) => {
        const start = BigInt(global.address);
        return layout
          ? address >= start && address < start + BigInt(layout.size.bytes)
          : address === start;
      })
      .sort((left, right) => {
        const a = BigInt(left.global.address);
        const b = BigInt(right.global.address);
        return a === b ? 0 : a > b ? -1 : 1;
      });
    if (candidates.length === 0) return null;
    const {global} = candidates[0];
    const projection = {
      root: {
        kind: 'global',
        name: global.name,
        address: global.address,
        type: global.type,
        implementation: global.implementation,
      },
      steps: [],
      type: global.type,
      byteOffset: '0x0',
    };
    return addProjectionOffset(projection, address - BigInt(global.address));
  }

  function mappingForExpression(expression, visiting = new Set()) {
    if (!database || !expression) return null;
    const key = addressKey(expression);
    if (visiting.has(key)) return null;
    visiting.add(key);
    let projection = null;
    if (expression.kind === 'program') projection = globalProjection(expression);
    else if (expression.kind === 'relative') {
      if (expression.base.startsWith('parameter:')) {
        const name = expression.base.slice('parameter:'.length);
        const parameter = [...parameterByVarnode.values()].find((item) => item.name === name);
        if (parameter) {
          projection = {
            root: {kind: 'parameter', name, type: parameter.type},
            steps: [],
            type: parameter.type,
            byteOffset: '0x0',
          };
        }
      } else {
        const base = expressionByKey.get(expression.base);
        if (base) projection = mappingForExpression(base, visiting);
      }
      projection = addProjectionOffset(projection, BigInt(expression.offsetBytes));
    } else if (expression.kind === 'indirect') {
      const source = expressionByKey.get(expression.source);
      projection = source ? mappingForExpression(source, visiting) : null;
      if (projection?.type !== null) {
        projection.steps.push({kind: 'dereference', type: projection.type});
        projection.byteOffset = '0x0';
      }
    }
    visiting.delete(key);
    return projection;
  }

  function mappingForAccess(expression, sizeBytes) {
    const projection = mappingForExpression(expression);
    const layout = layoutFor(projection?.type ?? null);
    if (!layout) return projection;
    if (layout.kind === 'struct') {
      const first = layout.fields.find(
        (field) => field.offsetBytes === 0 && field.sizeBytes >= sizeBytes,
      );
      if (!first) return projection;
      const mapped = addProjectionOffset(projection, 0n, null, true);
      if (first.sizeBytes !== sizeBytes) mapped.type = null;
      return mapped;
    }
    if (sizeBytes > layout.elementSizeBytes) return projection;
    const mapped = addProjectionOffset(projection, 0n, null, true);
    if (sizeBytes !== layout.elementSizeBytes) mapped.type = null;
    return mapped;
  }

  for (const op of ops.values()) {
    for (const input of op.inputs) {
      if (!consumersByVarnode.has(input)) consumersByVarnode.set(input, []);
      consumersByVarnode.get(input).push(op);
    }
    if (op.opcode === 'LOAD' || op.opcode === 'STORE') {
      if (op.inputs[1]) addressConsumers.add(op.inputs[1]);
    }
  }

  function markPointerRelevant(id) {
    if (!id || pointerRelevant.has(id)) return;
    pointerRelevant.add(id);
    const value = values.get(id);
    const producer = value?.definitionOpId ? ops.get(value.definitionOpId) : null;
    if (!producer) return;
    if (POINTER_PASSTHROUGH.has(producer.opcode)) markPointerRelevant(producer.inputs[0]);
    else if (POINTER_ARITHMETIC.has(producer.opcode)) {
      const addressInputs =
        producer.opcode === 'INT_ADD' ? producer.inputs.slice(0, 2) : [producer.inputs[0]];
      for (const input of addressInputs)
        if (values.get(input)?.kind !== 'constant') markPointerRelevant(input);
    } else if (producer.opcode === 'MULTIEQUAL') {
      for (const input of producer.inputs) markPointerRelevant(input);
    }
  }
  for (const id of addressConsumers) markPointerRelevant(id);

  function allocateSlot(kind, identity, fields) {
    const id = kind === 'address' ? `m${nextAddress++}` : `a${nextAnonymous++}`;
    const slot = {
      id,
      kind,
      storage: fields.storage ?? null,
      address: fields.address ?? null,
      type: fields.type,
      semanticType: fields.semanticType ?? null,
      semanticTypeKeys: new Map(),
      mapping: fields.mapping ?? null,
      generations: [],
      aliases: [],
      identity,
    };
    slots.push(slot);
    slotById.set(id, slot);
    return slot;
  }

  function updateSlotSemantic(slot, semanticType) {
    if (semanticType === null) return;
    slot.semanticTypeKeys.set(canonicalJson(semanticType), semanticType);
    slot.semanticType = slot.semanticTypeKeys.size === 1 ? semanticType : null;
  }

  function addGeneration(
    slot,
    kind,
    type,
    sourceOpId,
    inputs = [],
    pointsTo = null,
    semanticType = null,
    derivation = null,
  ) {
    const generation = {
      id: `${slot.id}:g${slot.generations.length}`,
      index: slot.generations.length,
      kind,
      type,
      semanticType,
      sourceOpId,
      inputs: sorted(inputs),
      pointsTo,
      derivation,
    };
    slot.generations.push(generation);
    updateSlotSemantic(slot, semanticType);
    generationById.set(generation.id, generation);
    if (pointsTo) {
      const target = slotById.get(pointsTo);
      if (target && !target.aliases.includes(generation.id)) target.aliases.push(generation.id);
    }
    return generation;
  }

  function addressKey(expression) {
    switch (expression.kind) {
      case 'program':
        return `program:${expression.space}:${expression.address}`;
      case 'relative':
        return `relative:${expression.base}:${expression.offsetBytes}`;
      case 'indirect':
        return `indirect:${expression.source}`;
      case 'anonymous':
        return `anonymous:${expression.identity}`;
      default:
        throw new Error(`Unknown address expression ${expression.kind}`);
    }
  }

  function addressSlot(expression, bits = 64, type = unknown(bits), mappingOverride = null) {
    if (!expression) expression = {kind: 'anonymous', identity: 'missing-expression'};
    const key = addressKey(expression);
    expressionByKey.set(key, expression);
    if (!addressByKey.has(key)) {
      const mapping = mappingOverride ?? mappingForExpression(expression);
      const semanticType = mapping?.type ?? null;
      const mappedType = machineTypeForSemantic(semanticType, type.bits);
      addressByKey.set(
        key,
        allocateSlot('address', key, {
          address: expression,
          type: mappedType ?? type,
          semanticType,
          mapping,
        }),
      );
    }
    const slot = addressByKey.get(key);
    if (slot.type.kind === 'unknown' && type.kind !== 'unknown') slot.type = type;
    else if (
      slot.type.bits === type.bits &&
      slot.type.kind === 'bitvector' &&
      type.kind === 'float'
    )
      slot.type = type;
    else if (
      type.kind !== 'unknown' &&
      slot.type.kind !== type.kind &&
      !(slot.type.kind === 'float' && type.kind === 'bitvector')
    )
      slot.type = unknown(Math.max(slot.type.bits, type.bits));
    const mapping = mappingOverride ?? mappingForExpression(expression);
    if (mapping && (slot.mapping === null || mappingOverride !== null)) slot.mapping = mapping;
    updateSlotSemantic(slot, slot.mapping?.type ?? null);
    return slot;
  }

  function inferredValueType(value) {
    if (pointerRelevant.has(value.id)) return addressType(value.size * 8);
    const producer = value.definitionOpId ? ops.get(value.definitionOpId) : null;
    if (producer && BOOLEAN_OPS.has(producer.opcode))
      return {kind: 'boolean', bits: 8, safeResetAndRetype: true};
    if (
      producer?.opcode.startsWith('FLOAT_') ||
      (consumersByVarnode.get(value.id) ?? []).some((op) => op.opcode.startsWith('FLOAT_'))
    )
      return {kind: 'float', bits: value.size * 8, safeResetAndRetype: true};
    return bitvector(value.size * 8);
  }

  function parameterStorage(value) {
    const parameter = parameterByVarnode.get(value.id);
    return parameter
      ? `parameter:${parameter.name}:${value.space}:${value.offset}:${value.size}`
      : `parameter:${value.id}:${value.space}:${value.offset}:${value.size}`;
  }

  function localStorage(value, pointerExpression) {
    const base = `${value.space}:${value.offset}:${value.size}`;
    // An address-holding register is rebound to a new anonymous slot when its
    // symbolic address changes. Identical expressions still share the pointee.
    return pointerExpression ? `${base}->${addressKey(pointerExpression)}` : base;
  }

  function anonymousSlot(storage, type, semanticType = null) {
    if (!anonymousByStorage.has(storage)) {
      anonymousByStorage.set(
        storage,
        allocateSlot('anonymous', storage, {storage, type, semanticType}),
      );
    }
    const slot = anonymousByStorage.get(storage);
    if (slot.type.kind === 'unknown' && type.kind !== 'unknown') slot.type = type;
    updateSlotSemantic(slot, semanticType);
    return slot;
  }

  // Inputs receive anonymous slots first, preserving Ghidra's explicit order.
  for (const id of exported.high.inputVarnodeIds) {
    const value = values.get(id);
    if (value.kind === 'memory') continue;
    const semanticType = parameterByVarnode.get(id)?.type ?? null;
    const type = machineTypeForSemantic(semanticType, value.size * 8) ?? inferredValueType(value);
    const slot = anonymousSlot(parameterStorage(value), type, semanticType);
    const generation = addGeneration(slot, 'input', type, null, [], null, semanticType);
    bindings[id] = {slotId: slot.id, generationId: generation.id, pointsTo: null};
  }

  function pointerExpression(id, visiting = new Set()) {
    if (addressExpressionByVarnode.has(id)) return addressExpressionByVarnode.get(id);
    if (visiting.has(id)) return null;
    const value = values.get(id);
    if (!value) return null;
    visiting.add(id);
    let expression = null;
    if (value.kind === 'memory') {
      expression = {kind: 'program', space: value.space, address: hex(value.offset)};
    } else if (value.kind === 'constant' && pointerRelevant.has(id)) {
      const defaultSpace = [...spaces.values()].find((space) => space.isDefault)?.name ?? 'ram';
      expression = {kind: 'program', space: defaultSpace, address: hex(value.offset)};
    } else if (value.flags.input) {
      const parameter = parameterByVarnode.get(id);
      expression = {
        kind: 'relative',
        base: `parameter:${parameter?.name ?? id}`,
        offsetBytes: '0x0',
      };
    } else if (value.definitionOpId) {
      const producer = ops.get(value.definitionOpId);
      if (POINTER_PASSTHROUGH.has(producer.opcode)) {
        expression = pointerExpression(producer.inputs[0], visiting);
      } else if (POINTER_ARITHMETIC.has(producer.opcode)) {
        const candidatePairs = [
          [producer.inputs[0], producer.inputs[1]],
          [producer.inputs[1], producer.inputs[0]],
        ];
        for (const [baseId, offsetId] of candidatePairs) {
          const offset = values.get(offsetId);
          const base = pointerExpression(baseId, visiting);
          if (base && offset?.kind === 'constant') {
            let extra = signedConstant(offset);
            if (producer.opcode === 'PTRSUB') extra = -extra;
            if (producer.opcode === 'PTRADD' && producer.inputs.length >= 3) {
              const scale = values.get(producer.inputs[2]);
              if (scale?.kind !== 'constant') continue;
              extra *= signedConstant(scale);
            }
            const baseOffset = base.kind === 'relative' ? BigInt(base.offsetBytes) : 0n;
            if (base.kind === 'program')
              expression = {...base, address: hex(BigInt(base.address) + extra)};
            else
              expression = {
                kind: 'relative',
                base: base.kind === 'relative' ? base.base : addressKey(base),
                offsetBytes: hex(baseOffset + extra),
              };
            break;
          }
        }
      } else if (producer.opcode === 'LOAD') {
        const source = pointerExpression(producer.inputs[1], visiting);
        if (source) expression = {kind: 'indirect', source: addressKey(source)};
      } else if (producer.opcode === 'MULTIEQUAL') {
        const incoming = producer.inputs.map((input) =>
          pointerExpression(input, new Set(visiting)),
        );
        if (incoming.length && incoming.every((item) => item && same(item, incoming[0])))
          expression = incoming[0];
      }
    }
    visiting.delete(id);
    if (!expression && addressConsumers.has(id)) {
      expression = {kind: 'anonymous', identity: `varnode:${id}`};
    }
    if (expression) {
      addressExpressionByVarnode.set(id, expression);
      expressionByKey.set(addressKey(expression), expression);
    }
    return expression;
  }

  // Resolve and type every memory target before creating its incoming generation.
  // A LOAD result later used as an address makes the memory contents an address;
  // ordinary loads and all current stores infer fixed-width bitvectors.
  const unresolvedIds = new Set();
  for (const op of ops.values()) {
    if (op.opcode !== 'LOAD' && op.opcode !== 'STORE') continue;
    const id = op.inputs[1];
    const expression = pointerExpression(id);
    const value = values.get(op.opcode === 'LOAD' ? op.output : op.inputs[2]);
    const type =
      op.opcode === 'LOAD' && pointerRelevant.has(op.output)
        ? addressType(value.size * 8)
        : bitvector(value.size * 8);
    const slot = addressSlot(
      expression,
      values.get(id).size * 8,
      type,
      mappingForAccess(expression, value.size),
    );
    const producer = values.get(id)?.definitionOpId ? ops.get(values.get(id).definitionOpId) : null;
    if (
      expression.kind === 'anonymous' &&
      !POINTER_ARITHMETIC.has(producer?.opcode) &&
      !unresolvedIds.has(id)
    ) {
      unresolvedIds.add(id);
      unresolvedAddresses.push({
        varnodeId: id,
        addressSlotId: slot.id,
        reason: 'No constant, parameter-relative, or loaded-pointer expression was recoverable',
      });
    }
  }

  // High P-code represents address-tied globals as memory-space SSA values.
  // Allocate their absolute program address once, regardless of which SSA name
  // or operation refers to it.
  const programMemoryValues = [...values.values()].filter(
    (value) => value.kind === 'memory' && (value.flags.input || value.definitionOpId !== null),
  );
  for (const value of programMemoryValues) {
    addressSlot(
      {kind: 'program', space: value.space, address: hex(value.offset)},
      value.size * 8,
      inferredValueType(value),
      mappingForAccess(
        {kind: 'program', space: value.space, address: hex(value.offset)},
        value.size,
      ),
    );
  }

  for (const id of exported.high.inputVarnodeIds) {
    if (!pointerRelevant.has(id)) continue;
    const value = values.get(id);
    addressSlot(pointerExpression(id), value.size * 8);
  }

  // Each memory address starts with the generation observed before this
  // function writes it. Later generations therefore follow source order.
  for (const slot of slots.filter((candidate) => candidate.kind === 'address')) {
    const initial = addGeneration(
      slot,
      'initial-memory',
      slot.type,
      null,
      [],
      null,
      slot.semanticType,
    );
    slot.initialGeneration = initial.id;
  }

  for (const value of programMemoryValues.filter((candidate) => candidate.flags.input)) {
    const slot = addressSlot({kind: 'program', space: value.space, address: hex(value.offset)});
    bindings[value.id] = {
      slotId: slot.id,
      generationId: slot.initialGeneration,
      pointsTo: null,
    };
  }

  function generationType(id) {
    return generationById.get(id)?.type ?? unknown(0);
  }

  function semanticForOutput(op, expression) {
    if (op.opcode === 'LOAD') return addressSlot(pointerExpression(op.inputs[1])).semanticType;
    if (expression) return mappingForExpression(expression)?.type ?? null;
    if (POINTER_PASSTHROUGH.has(op.opcode)) {
      const input = bindings[op.inputs[0]];
      return input ? (generationById.get(input.generationId)?.semanticType ?? null) : null;
    }
    if (op.opcode === 'MULTIEQUAL') {
      const types = op.inputs
        .map((input) => bindings[input])
        .filter(Boolean)
        .map((binding) => generationById.get(binding.generationId)?.semanticType ?? null)
        .filter((type) => type !== null);
      return types.length > 0 && types.every((type) => typeEqual(type, types[0])) ? types[0] : null;
    }
    return null;
  }

  // Assign a slot generation to every SSA write. Constants remain literals.
  for (const op of ops.values()) {
    if (op.output !== null) {
      const value = values.get(op.output);
      if (value.kind === 'memory') {
        const slot = addressSlot(
          {kind: 'program', space: value.space, address: hex(value.offset)},
          value.size * 8,
          inferredValueType(value),
        );
        const inputs = op.inputs.map((input) => bindings[input]?.generationId).filter(Boolean);
        const generation = addGeneration(
          slot,
          'write',
          slot.type,
          op.id,
          inputs,
          null,
          slot.semanticType,
        );
        bindings[op.output] = {slotId: slot.id, generationId: generation.id, pointsTo: null};
        generationForMemoryOutput.set(op.id, generation.id);
      } else {
        const expression = pointerRelevant.has(op.output) ? pointerExpression(op.output) : null;
        const semanticType = semanticForOutput(op, expression);
        const type =
          op.opcode === 'LOAD'
            ? addressSlot(pointerExpression(op.inputs[1])).type
            : expression
              ? addressType(value.size * 8)
              : (machineTypeForSemantic(semanticType, value.size * 8) ??
                inferOutputType(op, value, expression));
        const slot = anonymousSlot(localStorage(value, expression), type, semanticType);
        const inputs = op.inputs.map((input) => bindings[input]?.generationId).filter(Boolean);
        const pointsTo = expression ? addressSlot(expression, value.size * 8).id : null;
        const generation = addGeneration(
          slot,
          'write',
          type,
          op.id,
          inputs,
          pointsTo,
          semanticType,
        );
        bindings[op.output] = {slotId: slot.id, generationId: generation.id, pointsTo};
      }
    }
    if (op.opcode === 'STORE') {
      const expression = pointerExpression(op.inputs[1]);
      const value = values.get(op.inputs[2]);
      const type = value ? inferredValueType(value) : unknown(0);
      const slot = addressSlot(expression, value?.size * 8 ?? 0, type);
      const input = bindings[op.inputs[2]]?.generationId;
      const semanticType = input
        ? (generationById.get(input)?.semanticType ?? slot.semanticType)
        : slot.semanticType;
      const generation = addGeneration(
        slot,
        'write',
        type,
        op.id,
        input ? [input] : [],
        null,
        semanticType,
      );
      generationForStore.set(op.id, generation.id);
    }
  }

  // Loop phis can name definitions that appear later in the flat block order.
  // Fill all value dependencies only after every SSA output has a binding.
  for (const op of ops.values()) {
    if (op.output === null) continue;
    const binding = bindings[op.output];
    const generation = generationById.get(binding.generationId);
    const inputs = op.inputs.map((input) => bindings[input]?.generationId).filter(Boolean);
    generation.inputs = sorted(inputs);
    if (op.opcode !== 'MULTIEQUAL') continue;
    const inputTypes = inputs.map(generationType);
    const allowed = safeMerge(generation.type, inputTypes);
    if (allowed && values.get(op.output).kind === 'memory') generation.kind = 'merge';
    merges.push({
      id: `phi:${op.id}`,
      blockId: op.blockId,
      opId: op.id,
      slotId: binding.slotId,
      inputs: sorted(inputs),
      result: allowed ? generation.id : null,
      safeResetAndRetype: allowed,
      reason: allowed
        ? 'All incoming generations have the same resettable scalar type'
        : 'Incoming type is an address, unknown, or not safely resettable to one common type',
    });
  }

  // Address-valued inputs can only be linked after their relative target slots exist.
  for (const id of exported.high.inputVarnodeIds) {
    if (!pointerRelevant.has(id)) continue;
    const expression = pointerExpression(id);
    const target = addressSlot(expression, values.get(id).size * 8);
    const binding = bindings[id];
    binding.pointsTo = target.id;
    generationById.get(binding.generationId).pointsTo = target.id;
    if (!target.aliases.includes(binding.generationId)) target.aliases.push(binding.generationId);
  }

  function pointerArithmetic(op) {
    if (!POINTER_ARITHMETIC.has(op.opcode) || op.output === null || !pointerRelevant.has(op.output))
      return null;
    if (op.opcode === 'PTRADD') {
      const base = bindings[op.inputs[0]];
      const scale = values.get(op.inputs[2]);
      const indexValue = values.get(op.inputs[1]);
      if (!base || scale?.kind !== 'constant' || !indexValue) return null;
      const elementSizeBytes = Number(signedConstant(scale));
      if (!Number.isSafeInteger(elementSizeBytes) || elementSizeBytes <= 0) return null;
      if (indexValue.kind === 'constant') {
        const index = signedConstant(indexValue);
        return {
          kind: 'element-offset',
          parent: base,
          index: {kind: 'constant', value: hex(index)},
          elementSizeBytes,
          offsetBytes: hex(index * BigInt(elementSizeBytes)),
        };
      }
      const index = bindings[indexValue.id];
      if (!index) return null;
      return {
        kind: 'element-offset',
        parent: base,
        index: {
          kind: 'generation',
          value: {slotId: index.slotId, generationId: index.generationId},
        },
        elementSizeBytes,
        offsetBytes: null,
      };
    }
    const pairs =
      op.opcode === 'PTRSUB'
        ? [[op.inputs[0], op.inputs[1]]]
        : [
            [op.inputs[0], op.inputs[1]],
            [op.inputs[1], op.inputs[0]],
          ];
    for (const [baseId, offsetId] of pairs) {
      const parent = bindings[baseId];
      const offset = values.get(offsetId);
      if (!parent || offset?.kind !== 'constant') continue;
      const amount = op.opcode === 'PTRSUB' ? -signedConstant(offset) : signedConstant(offset);
      return {kind: 'byte-offset', parent, offsetBytes: hex(amount)};
    }
    return null;
  }

  // Retain the exact source generation for every derived pointer. The target
  // address can still canonicalize with another alias; derivation history does
  // not collapse with address identity.
  for (const op of ops.values()) {
    const parts = pointerArithmetic(op);
    if (!parts) continue;
    const output = bindings[op.output];
    if (!output) continue;
    const slot = slotById.get(output.slotId);
    const generation = generationById.get(output.generationId);
    const parent = {slotId: parts.parent.slotId, generationId: parts.parent.generationId};
    const parentGeneration = generationById.get(parent.generationId);
    const parentProjection = parentGeneration?.pointsTo
      ? (slotById.get(parentGeneration.pointsTo)?.mapping ?? null)
      : null;
    let mapping = output.pointsTo ? (slotById.get(output.pointsTo)?.mapping ?? null) : null;
    if (!mapping && parts.kind === 'element-offset' && parts.offsetBytes === null) {
      const layout = layoutFor(parentProjection?.type ?? null);
      if (layout?.kind === 'array' && layout.elementSizeBytes === parts.elementSizeBytes)
        mapping = addProjectionOffset(parentProjection, 0n, parts.index.value);
    }
    generation.derivation = {...parts, opId: op.id, parent, mapping};
    if (slot.kind === 'anonymous') slot.kind = 'derived';
    if (mapping) {
      slot.mapping = mapping;
      generation.semanticType = mapping.type;
      updateSlotSemantic(slot, mapping.type);
      if (output.pointsTo) {
        const target = slotById.get(output.pointsTo);
        target.mapping = mapping;
        updateSlotSemantic(target, mapping.type);
        const mappedType = machineTypeForSemantic(mapping.type, target.type.bits);
        if (mappedType) target.type = mappedType;
        for (const targetGeneration of target.generations) {
          targetGeneration.semanticType = mapping.type;
          if (mappedType) targetGeneration.type = mappedType;
        }
      }
    }
  }

  const blockList = [...blocks.values()].sort((left, right) => left.index - right.index);
  const inState = new Map();
  const outState = new Map();

  function initialState() {
    return new Map(
      slots
        .filter((slot) => slot.kind === 'address')
        .map((slot) => [slot.id, [slot.initialGeneration]]),
    );
  }

  function stateForBlock(block) {
    if (block.id === exported.high.entryBlockId || block.predecessors.length === 0)
      return initialState();
    const keys = slots.filter((slot) => slot.kind === 'address').map((slot) => slot.id);
    const state = new Map();
    for (const slotId of keys) {
      const candidates = sorted(
        block.predecessors.flatMap(
          // An unseen backedge contributes no state. Seeding it with the entry
          // generation would permanently invent a path that bypasses an
          // unconditional write before the loop.
          (edge) => outState.get(edge.blockId)?.get(slotId) ?? [],
        ),
      );
      state.set(slotId, candidates);
    }
    return state;
  }

  const limit = Math.max(8, blockList.length * 8);
  for (let pass = 0; pass < limit; pass += 1) {
    let changed = false;
    for (const block of blockList) {
      const incoming = stateForBlock(block);
      const state = new Map([...incoming].map(([key, value]) => [key, [...value]]));
      for (const opId of block.opIds) {
        const op = ops.get(opId);
        if (op.opcode === 'STORE') {
          const expression = pointerExpression(op.inputs[1]);
          const slot = addressSlot(expression);
          const generationId = generationForStore.get(op.id);
          state.set(slot.id, [generationId]);
        } else if (op.output && values.get(op.output).kind === 'memory') {
          const value = values.get(op.output);
          const slot = addressSlot({
            kind: 'program',
            space: value.space,
            address: hex(value.offset),
          });
          state.set(slot.id, [generationForMemoryOutput.get(op.id)]);
        }
      }
      const previousIn = inState.get(block.id);
      const previousOut = outState.get(block.id);
      if (!previousIn || !mapEqual(previousIn, incoming)) {
        inState.set(block.id, incoming);
        changed = true;
      }
      if (!previousOut || !mapEqual(previousOut, state)) {
        outState.set(block.id, state);
        changed = true;
      }
    }
    if (!changed) break;
    if (pass === limit - 1) throw new Error('Generational memory-state analysis did not converge');
  }

  // Materialize a merge only after reaching-generation sets converge. This
  // prevents temporary first-pass states from becoming permanent generations.
  for (const block of blockList) {
    const state = inState.get(block.id);
    if (block.predecessors.length <= 1) continue;
    for (const [slotId, candidates] of state) {
      if (candidates.length <= 1) continue;
      const predecessorStates = block.predecessors.map(
        (edge) => outState.get(edge.blockId)?.get(slotId) ?? [],
      );
      if (new Set(predecessorStates.map((stateValue) => JSON.stringify(stateValue))).size <= 1)
        continue;
      const slot = slotById.get(slotId);
      const explicitMemoryPhi = block.opIds.some((opId) => {
        const op = ops.get(opId);
        if (op.opcode !== 'MULTIEQUAL' || op.output === null) return false;
        const value = values.get(op.output);
        return (
          value.kind === 'memory' &&
          addressKey({kind: 'program', space: value.space, address: hex(value.offset)}) ===
            slot.identity
        );
      });
      if (explicitMemoryPhi) continue;
      const allowed = safeMerge(slot.type, candidates.map(generationType));
      const key = `${block.id}:${slotId}`;
      let result = null;
      if (allowed) {
        const generation = addGeneration(
          slot,
          'merge',
          slot.type,
          null,
          candidates,
          null,
          slot.semanticType,
        );
        mergeGenerationByKey.set(key, generation.id);
        result = generation.id;
      }
      merges.push({
        id: `cfg:${key}`,
        blockId: block.id,
        opId: null,
        slotId,
        inputs: candidates,
        result,
        safeResetAndRetype: allowed,
        reason: allowed
          ? 'Address contents use one resettable scalar type across predecessor states'
          : 'Address identity is preserved with multiple reaching generations because reset and retype is unsafe',
      });
    }
  }

  // Replay once with the final entry merges to attach exact reaching
  // generations to each read and write.
  for (const block of blockList) {
    const state = new Map(
      [...inState.get(block.id)].map(([slotId, candidates]) => {
        const merged = mergeGenerationByKey.get(`${block.id}:${slotId}`);
        return [slotId, merged ? [merged] : [...candidates]];
      }),
    );
    for (const opId of block.opIds) {
      const op = ops.get(opId);
      if (op.opcode === 'LOAD') {
        const slot = addressSlot(pointerExpression(op.inputs[1]));
        const candidates = state.get(slot.id) ?? [slot.initialGeneration];
        accesses.push({
          opId: op.id,
          blockId: block.id,
          kind: 'read',
          slotId: slot.id,
          generations: sorted(candidates),
          viaVarnodeId: op.inputs[1],
          mapping: slot.mapping,
        });
        generationById.get(bindings[op.output].generationId).inputs = sorted(candidates);
      } else if (op.opcode === 'STORE') {
        const slot = addressSlot(pointerExpression(op.inputs[1]));
        const generationId = generationForStore.get(op.id);
        state.set(slot.id, [generationId]);
        accesses.push({
          opId: op.id,
          blockId: block.id,
          kind: 'write',
          slotId: slot.id,
          generations: [generationId],
          viaVarnodeId: op.inputs[1],
          mapping: slot.mapping,
        });
      } else if (op.output && values.get(op.output).kind === 'memory') {
        const value = values.get(op.output);
        const slot = addressSlot({kind: 'program', space: value.space, address: hex(value.offset)});
        const generationId = generationForMemoryOutput.get(op.id);
        state.set(slot.id, [generationId]);
        if (op.opcode !== 'MULTIEQUAL') {
          accesses.push({
            opId: op.id,
            blockId: block.id,
            kind: 'write',
            slotId: slot.id,
            generations: [generationId],
            viaVarnodeId: op.output,
            mapping: slot.mapping,
          });
        }
      }
    }
  }

  accesses.sort((left, right) => {
    const a = ops.get(left.opId);
    const b = ops.get(right.opId);
    return blocks.get(a.blockId).index - blocks.get(b.blockId).index || a.index - b.index;
  });

  for (const slot of slots) {
    delete slot.identity;
    delete slot.initialGeneration;
    delete slot.semanticTypeKeys;
    slot.aliases.sort();
  }
  merges.sort((left, right) => left.id.localeCompare(right.id));
  unresolvedAddresses.sort((left, right) => left.varnodeId.localeCompare(right.varnodeId));
  const unmappedGlobals = slots
    .filter((slot) => slot.address?.kind === 'program' && slot.mapping === null)
    .map((slot) => ({
      slotId: slot.id,
      address: slot.address.address,
      space: slot.address.space,
    }))
    .sort((left, right) => left.address.localeCompare(right.address));

  return {
    schema: 'generational-address-slots/v2',
    source: {
      exportSha256: sha256(canonicalJson(exported)),
      executableSha256: exported.binary.executableSha256,
      entryAddress: exported.function.entryAddress,
      bodySha256: exported.function.bodySha256,
      databaseSha256: database ? databaseSha256(database) : null,
    },
    allocator: {strategy: 'incrementing', nextAnonymous, nextAddress},
    controlFlow: {
      entryBlockId: exported.high.entryBlockId,
      blocks: blockList.map((block) => ({
        id: block.id,
        index: block.index,
        predecessors: block.predecessors,
        successors: block.successors,
        conditionalTargets: block.conditionalTargets,
        opIds: block.opIds,
      })),
    },
    slots,
    bindings,
    accesses,
    merges,
    unresolvedAddresses,
    unmappedGlobals,
  };
}

export function slotAnalysisReceipt(ir) {
  const addressSlots = ir.slots.filter((slot) => slot.kind === 'address');
  const derivedSlots = ir.slots.filter((slot) => slot.kind === 'derived');
  return {
    schema: 'generational-address-slots-receipt/v2',
    status: 'complete',
    sourceSha256: ir.source.exportSha256,
    outputSha256: sha256(canonicalJson(ir)),
    databaseSha256: ir.source.databaseSha256,
    entryAddress: ir.source.entryAddress,
    bodySha256: ir.source.bodySha256,
    slotCount: ir.slots.length,
    anonymousSlotCount: ir.slots.length - addressSlots.length - derivedSlots.length,
    derivedSlotCount: derivedSlots.length,
    addressSlotCount: addressSlots.length,
    mappedSlotCount: ir.slots.filter((slot) => slot.mapping !== null).length,
    mappedAccessCount: ir.accesses.filter((access) => access.mapping !== null).length,
    generationCount: ir.slots.reduce((sum, slot) => sum + slot.generations.length, 0),
    memoryWriteCount: ir.accesses.filter((access) => access.kind === 'write').length,
    mergeCount: ir.merges.length,
    unsafeMergeCount: ir.merges.filter((merge) => !merge.safeResetAndRetype).length,
    unresolvedAddressCount: ir.unresolvedAddresses.length,
    unmappedGlobalCount: ir.unmappedGlobals.length,
  };
}

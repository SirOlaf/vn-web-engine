import {address, canonicalJson, sha256} from './index.mjs';
import {
  resolveFunction,
  resolveImplementation,
  resolveType,
  validateDatabase,
} from './database.mjs';
import {validateCfgModule} from './cfg.mjs';
import {validateGhidraExport} from './ghidra-import.mjs';
import {analyzeGenerationalSlots, slotAnalysisReceipt} from './generational-slots.mjs';

class RouteError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function check(condition, code, message, details) {
  if (!condition) throw new RouteError(code, message, details);
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactFields(value, fields) {
  return (
    object(value) &&
    Object.keys(value).length === fields.length &&
    Object.keys(value).every((key) => fields.includes(key))
  );
}

function bits(database, type) {
  const resolved = resolveType(database, type);
  if (Number.isInteger(resolved.bits)) return resolved.bits;
  if (Number.isInteger(resolved.nativeBits)) return resolved.nativeBits;
  if (resolved.kind === 'boolean') return 8;
  throw new RouteError('ROUTE_TYPE', 'Mapped type lacks a native storage width', {type});
}

function locationMatches(value, location, spaces) {
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

/**
 * Route one exact, reviewed native body to an existing implementation. The full
 * native CFG and generational slot graph remain in the companion slot artifact;
 * the executable CFG intentionally contains one forced direct implementation call.
 */
export function routeReviewedFunction(exported, database, plan) {
  validateDatabase(database);
  const graph = validateGhidraExport(exported);
  check(
    exactFields(plan, [
      'schema',
      'exportSha256',
      'slotIrSha256',
      'sourceKind',
      'reviewReference',
      'assumptions',
    ]) &&
      plan.schema === 'reviewed-generational-route/v1' &&
      /^[0-9a-f]{64}$/u.test(plan.exportSha256) &&
      /^[0-9a-f]{64}$/u.test(plan.slotIrSha256) &&
      ['synthetic', 'reviewed-pcode'].includes(plan.sourceKind) &&
      typeof plan.reviewReference === 'string' &&
      plan.reviewReference.trim() &&
      Array.isArray(plan.assumptions) &&
      plan.assumptions.every((item) => typeof item === 'string' && item.trim()),
    'ROUTE_PLAN',
    'An exact export/slot-hash-pinned reviewed route plan is required',
  );
  const exportSha256 = sha256(canonicalJson(exported));
  check(plan.exportSha256 === exportSha256, 'ROUTE_EXPORT', 'Route plan export hash differs');
  const slots = analyzeGenerationalSlots(exported, database);
  const slotReceipt = slotAnalysisReceipt(slots);
  check(
    plan.slotIrSha256 === slotReceipt.outputSha256,
    'ROUTE_SLOTS',
    'Route plan slot IR hash differs from fresh analysis',
  );

  const binary = database.binaries.find(
    (candidate) => candidate.executableSha256 === exported.binary.executableSha256,
  );
  check(
    binary && Object.entries(exported.binary).every(([key, value]) => binary[key] === value),
    'ROUTE_BINARY',
    'Export and mapping database binary identities differ',
  );
  const rva = `0x${(address(exported.function.entryAddress) - address(binary.imageBase)).toString(16)}`;
  const mapping = resolveFunction(database, binary.executableSha256, rva);
  const implementation = resolveImplementation(database, mapping.implementation);
  check(
    mapping.evidence.state === 'reviewed-contract' ||
      (plan.sourceKind === 'synthetic' && mapping.evidence.state === 'synthetic'),
    'ROUTE_EVIDENCE',
    'Whole-function routing requires a reviewed contract (or synthetic fixture contract)',
  );
  check(
    implementation.evidence.state === 'reviewed-contract' ||
      (plan.sourceKind === 'synthetic' && implementation.evidence.state === 'synthetic'),
    'ROUTE_EVIDENCE',
    'Routed implementation requires a reviewed contract (or synthetic fixture contract)',
  );
  check(
    mapping.abi.convention !== 'unresolved' &&
      !mapping.abi.parameters.some((parameter) => parameter.location.kind === 'unresolved') &&
      mapping.abi.returnLocation.kind !== 'unresolved',
    'ROUTE_ABI',
    'Whole-function routing requires an explicit native ABI',
  );

  const nativeInputs = new Map();
  for (const parameter of mapping.abi.parameters) {
    const matches = [...graph.values.values()].filter(
      (value) => value.flags.input && locationMatches(value, parameter.location, graph.spaces),
    );
    check(
      matches.length === 1 && matches[0].size * 8 === bits(database, parameter.type),
      'ROUTE_PARAMETER',
      'Native parameter must match one HighFunction input with the mapped width',
      {parameter: parameter.name, matches: matches.map((value) => value.id)},
    );
    nativeInputs.set(parameter.name, matches[0].id);
  }
  const represented = new Set();
  const parameterValues = {};
  const argumentsByName = {};
  for (const binding of mapping.abi.arguments) {
    check(
      binding.source.kind === 'parameter',
      'ROUTE_PARAMETER',
      'Generated entry routes require a bijection to native parameters',
    );
    const value = nativeInputs.get(binding.source.name);
    check(value && !represented.has(value), 'ROUTE_PARAMETER', 'Native input is absent or reused');
    represented.add(value);
    parameterValues[binding.parameter] = value;
    argumentsByName[binding.parameter] = {ref: value};
  }
  const meaningfulInputs = [...graph.values.values()].filter(
    (value) => value.flags.input && value.kind !== 'memory' && !value.flags.unaffected,
  );
  check(
    represented.size === nativeInputs.size &&
      meaningfulInputs.every((value) => represented.has(value.id)),
    'ROUTE_PARAMETER',
    'Reviewed route cannot omit a recovered native input',
  );

  const returns = [...graph.ops.values()].filter((op) => op.opcode === 'RETURN');
  check(returns.length === 1, 'ROUTE_RETURN', 'Reviewed route currently requires one RETURN');
  const returnOp = returns[0];
  let resultId = null;
  if (implementation.signature.returnType !== 'void') {
    check(
      returnOp.inputs.length >= 2,
      'ROUTE_RETURN',
      'Non-void mapped implementation needs a recovered return value',
    );
    const returned = graph.values.get(returnOp.inputs[1]);
    check(
      returned &&
        locationMatches(returned, mapping.abi.returnLocation, graph.spaces) &&
        returned.size * 8 === bits(database, implementation.signature.returnType),
      'ROUTE_RETURN',
      'Recovered return storage differs from the mapped ABI',
    );
    resultId = 'mappedResult';
  }

  const source = {address: exported.function.entryAddress, sequence: 0, loweringIndex: 0};
  const call = {
    id: resultId,
    opcode: 'CALL_IMPLEMENTATION',
    implementation: implementation.id,
    arguments: argumentsByName,
    source,
  };
  const module = {
    schemaVersion: 2,
    kind: 'reviewed-cfg-module',
    entryImplementation: implementation.id,
    functions: [
      {
        implementation: implementation.id,
        provenance: {
          binary: exported.binary,
          entryAddress: exported.function.entryAddress,
          bodyRanges: exported.function.bodyRanges.map(({start, end}) => ({start, end})),
          bodySha256: exported.function.bodySha256,
          sourceKind: plan.sourceKind,
          sourceSha256: exportSha256,
          exporter: `${exported.exporter.name}/${exported.exporter.version} Ghidra/${exported.exporter.ghidraVersion}`,
          reviewReference: plan.reviewReference,
          assumptions: plan.assumptions,
        },
        variant: null,
        parameterValues,
        entryBlock: 'mappedEntry',
        blocks: [
          {
            id: 'mappedEntry',
            phis: [],
            operations: [call],
            terminator: {
              opcode: 'RETURN',
              value: resultId === null ? null : {ref: resultId},
              source: {...source, loweringIndex: 1},
            },
          },
        ],
      },
    ],
  };
  const validation = validateCfgModule(module, database);
  return {
    module,
    slots,
    receipt: {
      schema: 'reviewed-generational-route-receipt/v1',
      status: 'complete',
      exportSha256,
      slotIr: slotReceipt,
      planSha256: sha256(canonicalJson(plan)),
      irSha256: validation.report.irSha256,
      databaseSha256: validation.report.databaseSha256,
      implementation: implementation.id,
      nativeInputBindings: Object.fromEntries(nativeInputs),
      savedState: 'unverified',
    },
  };
}

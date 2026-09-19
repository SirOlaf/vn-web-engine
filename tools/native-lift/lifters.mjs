import {address} from './index.mjs';
import {resolveImplementation, resolveLifters, resolveType} from './database.mjs';

export class PcodeLifterError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PcodeLifterError';
    this.code = code;
    this.details = details;
  }
}

const fail = (code, message, details = {}) => {
  throw new PcodeLifterError(code, message, details);
};

/**
 * Match evidence-backed P-code patterns before the generic importer classifies
 * unsupported effects. A rule must consume every setup operation that would
 * otherwise pretend a native pointer is an ordinary integer.
 */
export function applyPcodeLifters({exported, database, graph, nativeInputs}) {
  const {ops, values, spaces} = graph;
  const rva = `0x${(
    address(exported.function.entryAddress) - address(exported.binary.imageBase)
  ).toString(16)}`;
  const sameSlot = (database.lifters ?? []).filter(
    (lifter) =>
      lifter.target.binarySha256 === exported.binary.executableSha256 && lifter.target.rva === rva,
  );
  const rules = resolveLifters(
    database,
    exported.binary.executableSha256,
    rva,
    exported.function.bodySha256,
  );
  if (sameSlot.length && !rules.length)
    fail('IMPORT_LIFTER_BODY', 'Lifter rules exist for this address but not this exact body', {
      rva,
      bodySha256: exported.function.bodySha256,
      expected: sameSlot.map((lifter) => lifter.target.bodySha256),
    });

  const replacements = new Map();
  const consumed = new Set();
  const receipts = [];
  const uses = new Map([...values.keys()].map((id) => [id, []]));
  for (const op of ops.values()) for (const input of op.inputs) uses.get(input)?.push(op.id);

  for (const rule of rules) {
    if (rule.kind !== 'owner-load-call')
      fail('IMPORT_LIFTER', `No matcher is registered for ${rule.kind}`, {lifter: rule.id});
    const candidates = [...ops.values()].filter(
      (op) =>
        op.opcode === 'LOAD' &&
        op.sequence.address === rule.operation.address &&
        op.sequence.time === rule.operation.sequence,
    );
    if (candidates.length !== 1)
      fail('IMPORT_LIFTER', 'Owner-load rule did not identify exactly one LOAD', {
        lifter: rule.id,
        candidates: candidates.map((op) => op.id),
      });
    const load = candidates[0];
    if (consumed.has(load.id) || load.inputs.length !== 2 || load.output === null)
      fail('IMPORT_LIFTER', 'Owner-load rule overlaps another rule or has invalid LOAD arity', {
        lifter: rule.id,
        opId: load.id,
      });
    const spaceValue = values.get(load.inputs[0]);
    const selectedSpace =
      spaceValue?.flags.constant && address(spaceValue.offset) <= BigInt(Number.MAX_SAFE_INTEGER)
        ? spaces.get(Number(address(spaceValue.offset)))
        : null;
    if (selectedSpace?.name !== rule.operation.addressSpace)
      fail('IMPORT_LIFTER', 'Owner-load address space differs from the rule', {
        lifter: rule.id,
        actual: selectedSpace?.name ?? null,
        expected: rule.operation.addressSpace,
      });
    const pointer = values.get(load.inputs[1]);
    const producer = ops.get(pointer?.definitionOpId);
    const receiverId = nativeInputs.get(rule.receiverParameter);
    if (
      !pointer ||
      !producer ||
      producer.opcode !== 'INT_ADD' ||
      producer.output !== pointer.id ||
      producer.inputs.length !== 2 ||
      producer.blockId !== load.blockId ||
      producer.index >= load.index ||
      uses.get(pointer.id)?.length !== 1 ||
      uses.get(pointer.id)?.[0] !== load.id ||
      !receiverId
    )
      fail('IMPORT_LIFTER', 'Owner-load pointer is not a single-use base-plus-offset value', {
        lifter: rule.id,
        opId: load.id,
      });
    const offsetId = producer.inputs.find((id) => id !== receiverId);
    const offset = values.get(offsetId);
    if (
      !producer.inputs.includes(receiverId) ||
      !offset ||
      !offset.flags.constant ||
      address(offset.offset) !== BigInt(rule.operation.offsetBytes) ||
      values.get(load.output)?.size * 8 !== rule.operation.widthBits
    )
      fail('IMPORT_LIFTER', 'Owner-load receiver, offset, or width differs from the rule', {
        lifter: rule.id,
        opId: load.id,
      });
    if (consumed.has(producer.id))
      fail('IMPORT_LIFTER', 'Owner-load address setup overlaps another lifter', {
        lifter: rule.id,
        opId: producer.id,
      });
    const implementation = resolveImplementation(database, rule.implementation);
    const result = resolveType(database, implementation.signature.returnType);
    const argumentsByName = Object.fromEntries(
      rule.arguments.map((argument) => {
        const id = nativeInputs.get(argument.source.name);
        if (!id)
          fail('IMPORT_LIFTER', 'Lifter argument is absent from recovered native inputs', {
            lifter: rule.id,
            parameter: argument.source.name,
          });
        return [argument.parameter, {ref: id}];
      }),
    );
    consumed.add(producer.id);
    consumed.add(load.id);
    replacements.set(load.id, {
      operation: {
        id: load.output,
        opcode: 'CALL_IMPLEMENTATION',
        implementation: implementation.id,
        arguments: argumentsByName,
      },
      outputType: implementation.signature.returnType,
      source: load,
      reason: `database lifter ${rule.id}: ${rule.operation.addressSpace}+${rule.operation.offsetBytes} ${rule.operation.widthBits}-bit owner load -> ${implementation.id}`,
    });
    receipts.push({
      id: rule.id,
      kind: rule.kind,
      matchedOpId: load.id,
      consumedOpIds: [producer.id, load.id],
      implementation: implementation.id,
      resultType: result.type,
    });
  }
  return {replacements, consumed, receipts};
}

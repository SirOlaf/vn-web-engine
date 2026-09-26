#!/usr/bin/env node
/** Explicit native-to-source mapping database. No TypeScript parser, imports, eval, or factories. */
import {createHash, randomUUID} from 'node:crypto';
import {link, lstat, open, readFile, realpath, unlink} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const HASH = /^[0-9a-f]{64}$/;
const HEX = /^0x(?:0|[1-9a-f][0-9a-f]*)$/;
const ID = /^[A-Za-z][A-Za-z0-9_.:-]*$/;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
// Generated modules use strict mode, where eval and arguments are invalid bindings.
const RESERVED = new Set(
  'arguments await break case catch class const continue debugger default delete do else enum eval export extends false finally for function if implements import in instanceof interface let new null package private protected public return static super switch this throw true try typeof var void while with yield'.split(
    ' ',
  ),
);
const SCALARS = new Set([
  'u8',
  'i8',
  'u16',
  'i16',
  'u32',
  'i32',
  'u64',
  'i64',
  'f32',
  'f64',
  'bool',
  'void',
  'unknown',
]);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const fail = (code, message, details = {}) => {
  throw new DatabaseError(code, message, details);
};
const check = (condition, code, message, details) => {
  if (!condition) fail(code, message, details);
};

export class DatabaseError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DatabaseError';
    this.code = code;
    this.details = details;
  }
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
export const databaseSha256 = (database) => hash(canonicalJson(database));

function record(value, required, optional = [], label = 'record') {
  check(
    value && typeof value === 'object' && !Array.isArray(value),
    'SCHEMA',
    `${label} must be an object`,
  );
  check(
    required.every((key) => Object.hasOwn(value, key)) &&
      Object.keys(value).every((key) => [...required, ...optional].includes(key)),
    'SCHEMA',
    `${label} requires ${required.join(', ')}; optional ${optional.join(', ')}`,
  );
}
function text(value, label) {
  check(
    typeof value === 'string' && value.trim().length > 0 && !/[\u0000-\u001f]/.test(value),
    'SCHEMA',
    `${label} must be nonempty text without control characters`,
  );
}
function sha(value, label) {
  check(
    typeof value === 'string' && HASH.test(value),
    'HASH',
    `${label} must be a lowercase SHA-256`,
  );
}
function id(value, label) {
  check(
    typeof value === 'string' && ID.test(value),
    'SCHEMA',
    `${label} must be a stable identifier`,
  );
}
function identifier(value, label) {
  check(
    typeof value === 'string' && IDENTIFIER.test(value) && !RESERVED.has(value),
    'SCHEMA',
    `${label} must be a non-reserved TypeScript identifier`,
  );
}
function relative(value, label) {
  text(value, label);
  check(
    !path.posix.isAbsolute(value) &&
      !value.includes('\\') &&
      !value.includes(':') &&
      path.posix.normalize(value) === value &&
      !value.split('/').some((part) => part === '.' || part === '..' || !part),
    'PATH',
    `${label} must be a canonical repository-relative path`,
  );
}
function pin(source) {
  record(source, ['path', 'sha256'], [], 'source pin');
  relative(source.path, 'source.path');
  sha(source.sha256, 'source.sha256');
}
function imported(value) {
  relative(value.module, 'import.module');
  check(
    /\.(?:js|mjs|cjs)$/.test(value.module),
    'PATH',
    'Import module must name an explicit JavaScript output path',
  );
  identifier(value.export, 'import.export');
  pin(value.source);
  const expectedModule = value.source.path
    .replace(/\.mts$/, '.mjs')
    .replace(/\.cts$/, '.cjs')
    .replace(/\.ts$/, '.js');
  check(
    value.module === expectedModule,
    'PATH',
    'Import module must correspond to its pinned source path (.ts/.mts/.cts use .js/.mjs/.cjs)',
  );
}
function evidence(value) {
  record(value, ['state', 'references', 'notes'], [], 'evidence');
  check(
    ['synthetic', 'source-assertion', 'reviewed-contract'].includes(value.state),
    'EVIDENCE',
    'Unknown evidence state',
  );
  check(
    Array.isArray(value.references) && Array.isArray(value.notes),
    'SCHEMA',
    'Evidence references and notes must be arrays',
  );
  for (const reference of value.references) {
    record(reference, ['path', 'sha256', 'section']);
    relative(reference.path, 'evidence.path');
    sha(reference.sha256, 'evidence.sha256');
    text(reference.section, 'evidence.section');
  }
  for (const note of value.notes) text(note, 'evidence.note');
  check(
    value.state === 'synthetic' || value.references.length > 0,
    'EVIDENCE',
    'Non-synthetic assertions require a pinned evidence reference',
  );
}
function typeRef(value, database, allowVoid = false) {
  if (typeof value === 'string') {
    check(
      SCALARS.has(value) && (allowVoid || value !== 'void'),
      'TYPE',
      `Unknown or invalid scalar type ${value}`,
    );
    return;
  }
  record(value, ['named'], [], 'type reference');
  check(
    database.types.some((type) => type.id === value.named),
    'TYPE',
    `Unknown named type ${value.named}`,
  );
}
function signature(value, database) {
  record(value, ['parameters', 'returnType'], [], 'signature');
  check(Array.isArray(value.parameters), 'SCHEMA', 'Signature parameters must be an ordered array');
  const names = new Set();
  for (const parameter of value.parameters) {
    record(parameter, ['name', 'type']);
    identifier(parameter.name, 'parameter.name');
    check(!names.has(parameter.name), 'SIGNATURE', `Duplicate parameter ${parameter.name}`);
    names.add(parameter.name);
    typeRef(parameter.type, database);
  }
  typeRef(value.returnType, database, true);
}
const signatureShape = (value) =>
  canonicalJson({
    parameters: value.parameters.map((parameter) => parameter.type),
    returnType: value.returnType,
  });
function location(value, allowVoid = false) {
  if (value?.kind === 'register') {
    record(value, ['kind', 'name']);
    check(
      /^[a-z][a-z0-9]*$/.test(value.name),
      'ABI',
      'Register names must be explicit lowercase identifiers',
    );
  } else if (value?.kind === 'stack') {
    record(value, ['kind', 'offsetBytes']);
    check(
      Number.isSafeInteger(value.offsetBytes) && value.offsetBytes >= 0,
      'ABI',
      'Stack offsets are nonnegative byte offsets from native function entry SP',
    );
  } else if (value?.kind === 'unresolved') {
    record(value, ['kind', 'reason']);
    text(value.reason, 'unresolved ABI reason');
  } else if (value?.kind === 'void' && allowVoid) record(value, ['kind']);
  else fail('ABI', 'Unsupported native ABI location');
}
function exactTarget(database, binarySha256, rva) {
  sha(binarySha256, 'target.binarySha256');
  check(
    typeof rva === 'string' && HEX.test(rva),
    'ADDRESS',
    'RVA must be canonical lowercase hexadecimal',
  );
  const binary = database.binaries.find((candidate) => candidate.executableSha256 === binarySha256);
  check(binary, 'BINARY', `Unknown executable ${binarySha256}`);
  const bits = binary.languageId.includes(':32:') ? 32 : 64;
  check(
    BigInt(binary.imageBase) + BigInt(rva) < 1n << BigInt(bits),
    'ADDRESS',
    'RVA exceeds the binary address width',
  );
  return binary;
}

export function validateDatabase(database) {
  record(
    database,
    [
      'schemaVersion',
      'kind',
      'binaries',
      'types',
      'implementations',
      'functions',
      'variantFamilies',
    ],
    ['lifters', 'layouts', 'globals'],
    'mapping database',
  );
  check(
    database.schemaVersion === 1 && database.kind === 'native-mapping-database',
    'SCHEMA',
    'Expected native-mapping-database schemaVersion 1',
  );
  for (const key of ['binaries', 'types', 'implementations', 'functions', 'variantFamilies'])
    check(Array.isArray(database[key]), 'SCHEMA', `${key} must be an array`);
  check(
    database.lifters === undefined || Array.isArray(database.lifters),
    'SCHEMA',
    'lifters must be an array when present',
  );
  check(
    database.layouts === undefined || Array.isArray(database.layouts),
    'SCHEMA',
    'layouts must be an array when present',
  );
  check(
    database.globals === undefined || Array.isArray(database.globals),
    'SCHEMA',
    'globals must be an array when present',
  );
  for (const key of ['binaries', 'types', 'implementations', 'variantFamilies']) {
    const ids = new Set();
    for (const entry of database[key]) {
      id(entry?.id, `${key}.id`);
      check(!ids.has(entry.id), 'DUPLICATE', `Duplicate ${key} ID ${entry.id}`);
      ids.add(entry.id);
    }
  }
  const binaries = new Set();
  for (const binary of database.binaries) {
    record(binary, ['id', 'programPath', 'executableSha256', 'languageId', 'imageBase']);
    text(binary.programPath, 'binary.programPath');
    sha(binary.executableSha256, 'binary.executableSha256');
    check(
      !binaries.has(binary.executableSha256),
      'DUPLICATE',
      'An executable hash has more than one binary identity',
    );
    binaries.add(binary.executableSha256);
    check(
      ['x86:LE:32:default', 'x86:LE:64:default'].includes(binary.languageId),
      'BINARY',
      'Unsupported binary language',
    );
    check(HEX.test(binary.imageBase), 'ADDRESS', 'Image base must be canonical hexadecimal');
    exactTarget(database, binary.executableSha256, '0x0');
  }
  for (const type of database.types) {
    if (type.kind === 'integer') {
      record(type, ['id', 'kind', 'bits', 'signed', 'representation']);
      check(
        [8, 16, 32, 64].includes(type.bits) &&
          typeof type.signed === 'boolean' &&
          ['number', 'bigint'].includes(type.representation),
        'TYPE',
        'Invalid integer type representation',
      );
      check(
        type.bits !== 64 || type.representation === 'bigint',
        'TYPE',
        'Full-width 64-bit integers require bigint',
      );
    } else if (type.kind === 'alias') {
      record(type, ['id', 'kind', 'target']);
      typeRef(type.target, database);
    } else if (type.kind === 'reference') {
      record(type, ['id', 'kind', 'import', 'nativeBits', 'nullable', 'mutability']);
      record(type.import, ['module', 'export', 'source']);
      imported(type.import);
      check(
        [32, 64].includes(type.nativeBits) &&
          typeof type.nullable === 'boolean' &&
          ['mutable', 'readonly'].includes(type.mutability),
        'TYPE',
        'Invalid reference type',
      );
    } else if (type.kind === 'opaque') {
      record(type, ['id', 'kind', 'import', 'nullable']);
      if (type.import !== null) {
        record(type.import, ['module', 'export', 'source']);
        imported(type.import);
      }
      check(typeof type.nullable === 'boolean', 'TYPE', 'Opaque nullable flag must be explicit');
    } else fail('TYPE', `Unsupported named type kind ${type.kind}`);
  }
  // Resolve every alias now, including otherwise-unused cycles.
  for (const type of database.types) resolveTypeInternal(database, {named: type.id}, {}, new Set());
  const layoutTypes = new Set();
  for (const layout of database.layouts ?? []) {
    if (layout?.kind === 'struct')
      record(layout, ['id', 'kind', 'type', 'size', 'fields', 'evidence'], [], 'struct layout');
    else if (layout?.kind === 'array')
      record(
        layout,
        ['id', 'kind', 'type', 'size', 'elementType', 'elementSizeBytes', 'count', 'evidence'],
        [],
        'array layout',
      );
    else fail('LAYOUT', 'Unknown native layout kind');
    id(layout.id, 'layout.id');
    id(layout.type, 'layout.type');
    check(
      database.types.some((type) => type.id === layout.type),
      'LAYOUT',
      `Layout refers to unknown type ${layout.type}`,
    );
    check(!layoutTypes.has(layout.type), 'DUPLICATE', `Duplicate layout for ${layout.type}`);
    layoutTypes.add(layout.type);
    record(layout.size, ['bytes', 'kind'], [], 'layout size');
    check(
      Number.isSafeInteger(layout.size.bytes) &&
        layout.size.bytes > 0 &&
        ['exact', 'minimum'].includes(layout.size.kind),
      'LAYOUT',
      'Layout size must be a positive exact or minimum byte count',
    );
    evidence(layout.evidence);
    if (layout.kind === 'struct') {
      check(Array.isArray(layout.fields), 'LAYOUT', 'Struct fields must be an array');
      const names = new Set();
      const spans = [];
      for (const field of layout.fields) {
        record(field, ['name', 'offsetBytes', 'sizeBytes', 'storage', 'type'], [], 'native field');
        identifier(field.name, 'field.name');
        check(!names.has(field.name), 'DUPLICATE', `Duplicate field ${layout.type}.${field.name}`);
        names.add(field.name);
        typeRef(field.type, database);
        check(
          Number.isSafeInteger(field.offsetBytes) &&
            field.offsetBytes >= 0 &&
            Number.isSafeInteger(field.sizeBytes) &&
            field.sizeBytes > 0 &&
            ['inline', 'pointer'].includes(field.storage),
          'LAYOUT',
          'Native fields require nonnegative offsets, positive sizes and explicit storage',
        );
        const end = field.offsetBytes + field.sizeBytes;
        check(end <= layout.size.bytes, 'LAYOUT', 'Native field exceeds its layout size');
        check(
          !spans.some((span) => field.offsetBytes < span.end && end > span.start),
          'LAYOUT',
          'Native fields overlap',
        );
        spans.push({start: field.offsetBytes, end});
        const resolved = resolveTypeInternal(database, field.type, {}, new Set());
        const storageBits = resolved.bits ?? resolved.nativeBits;
        if (field.storage === 'pointer')
          check(
            ['reference', 'opaque'].includes(resolved.kind) &&
              (storageBits === undefined || storageBits === field.sizeBytes * 8),
            'LAYOUT',
            'Pointer fields require a reference/opaque type and matching native width',
          );
        else if (storageBits !== undefined)
          check(
            storageBits === field.sizeBytes * 8,
            'LAYOUT',
            'Inline scalar field size differs from its mapped type',
          );
      }
    } else {
      check(layout.size.kind === 'exact', 'LAYOUT', 'Array layouts require an exact size');
      typeRef(layout.elementType, database);
      check(
        Number.isSafeInteger(layout.elementSizeBytes) &&
          layout.elementSizeBytes > 0 &&
          Number.isSafeInteger(layout.count) &&
          layout.count > 0 &&
          layout.elementSizeBytes * layout.count === layout.size.bytes,
        'LAYOUT',
        'Array size must equal elementSizeBytes * count',
      );
    }
  }
  const globalKeys = new Set();
  for (const global of database.globals ?? []) {
    record(
      global,
      ['binarySha256', 'address', 'name', 'type', 'implementation', 'evidence'],
      [],
      'native global',
    );
    const binary = database.binaries.find(
      (candidate) => candidate.executableSha256 === global.binarySha256,
    );
    check(binary, 'BINARY', `Unknown executable ${global.binarySha256}`);
    check(HEX.test(global.address), 'ADDRESS', 'Global address must be canonical hexadecimal');
    const width = binary.languageId.includes(':32:') ? 32 : 64;
    check(
      BigInt(global.address) >= BigInt(binary.imageBase) &&
        BigInt(global.address) < 1n << BigInt(width),
      'ADDRESS',
      'Global address lies outside the binary image address domain',
    );
    const key = `${global.binarySha256}:${global.address}`;
    check(!globalKeys.has(key), 'DUPLICATE', `Duplicate native global ${key}`);
    globalKeys.add(key);
    identifier(global.name, 'global.name');
    typeRef(global.type, database);
    record(global.implementation, ['rootType', 'path'], [], 'global implementation mapping');
    typeRef(global.implementation.rootType, database);
    check(
      Array.isArray(global.implementation.path) &&
        global.implementation.path.length > 0 &&
        global.implementation.path.every(
          (part) => typeof part === 'string' && IDENTIFIER.test(part) && !RESERVED.has(part),
        ),
      'GLOBAL',
      'Global implementation path requires one or more identifiers',
    );
    evidence(global.evidence);
  }
  const sourcePins = new Map();
  const registerPin = (source) => {
    const previous = sourcePins.get(source.path);
    check(!previous || previous === source.sha256, 'HASH', `Conflicting hashes for ${source.path}`);
    sourcePins.set(source.path, source.sha256);
  };
  for (const type of database.types) if (type.import) registerPin(type.import.source);
  for (const implementation of database.implementations) {
    record(implementation, ['id', 'module', 'export', 'source', 'signature', 'evidence']);
    imported(implementation);
    signature(implementation.signature, database);
    evidence(implementation.evidence);
    registerPin(implementation.source);
  }
  const functionKeys = new Set();
  for (const fn of database.functions) {
    record(fn, ['binarySha256', 'rva', 'implementation', 'abi', 'evidence']);
    exactTarget(database, fn.binarySha256, fn.rva);
    const key = `${fn.binarySha256}:${fn.rva}`;
    check(!functionKeys.has(key), 'DUPLICATE', `Duplicate native function ${key}`);
    functionKeys.add(key);
    const implementation = database.implementations.find(
      (candidate) => candidate.id === fn.implementation,
    );
    check(implementation, 'IMPLEMENTATION', `Unknown implementation ${fn.implementation}`);
    evidence(fn.evidence);
    record(fn.abi, ['convention', 'parameters', 'arguments', 'returnLocation'], [], 'native ABI');
    check(
      ['win64', 'cdecl', 'stdcall', 'fastcall', 'custom', 'unresolved'].includes(fn.abi.convention),
      'ABI',
      'Unknown ABI convention',
    );
    check(
      Array.isArray(fn.abi.parameters) && Array.isArray(fn.abi.arguments),
      'ABI',
      'ABI parameters and arguments must be ordered arrays',
    );
    const nativeNames = new Set(),
      locations = new Set();
    for (const parameter of fn.abi.parameters) {
      record(parameter, ['name', 'type', 'location']);
      identifier(parameter.name, 'native parameter');
      typeRef(parameter.type, database);
      location(parameter.location);
      check(
        !nativeNames.has(parameter.name),
        'ABI',
        `Duplicate native parameter ${parameter.name}`,
      );
      nativeNames.add(parameter.name);
      const key = canonicalJson(parameter.location);
      check(
        parameter.location.kind === 'unresolved' || !locations.has(key),
        'ABI',
        'Native parameters overlap the same declared location',
      );
      locations.add(key);
    }
    check(
      fn.abi.arguments.length === implementation.signature.parameters.length,
      'ABI',
      'Bindings must cover every implementation parameter exactly once in implementation order',
    );
    fn.abi.arguments.forEach((argument, index) => {
      record(argument, ['parameter', 'source']);
      const parameter = implementation.signature.parameters[index];
      check(
        argument.parameter === parameter.name,
        'ABI',
        'Implementation argument bindings are in the wrong order',
      );
      if (argument.source?.kind === 'parameter') {
        record(argument.source, ['kind', 'name']);
        const source = fn.abi.parameters.find(
          (candidate) => candidate.name === argument.source.name,
        );
        check(source, 'ABI', 'Argument refers to an unknown native parameter');
        check(
          canonicalJson(source.type) === canonicalJson(parameter.type),
          'ABI',
          'Native binding type differs; declare an explicit adapter implementation',
        );
      } else if (argument.source?.kind === 'constant') {
        record(argument.source, ['kind', 'type', 'value']);
        typeRef(argument.source.type, database);
        check(
          canonicalJson(argument.source.type) === canonicalJson(parameter.type),
          'ABI',
          'Constant binding type mismatch',
        );
        validateConstant(database, argument.source.type, argument.source.value);
      } else fail('ABI', 'Unsupported argument binding');
    });
    location(fn.abi.returnLocation, true);
    check(
      (implementation.signature.returnType === 'void') === (fn.abi.returnLocation.kind === 'void'),
      'ABI',
      'Void return and native return location disagree',
    );
    if (fn.evidence.state === 'reviewed-contract')
      check(
        fn.abi.convention !== 'unresolved' &&
          !fn.abi.parameters.some((parameter) => parameter.location.kind === 'unresolved') &&
          fn.abi.returnLocation.kind !== 'unresolved',
        'EVIDENCE',
        'Reviewed ABI contracts cannot contain unresolved locations',
      );
  }
  const lifterIds = new Set();
  for (const lifter of database.lifters ?? []) {
    record(
      lifter,
      [
        'id',
        'kind',
        'target',
        'operation',
        'receiverParameter',
        'implementation',
        'arguments',
        'evidence',
      ],
      [],
      'lifter',
    );
    id(lifter.id, 'lifter.id');
    check(!lifterIds.has(lifter.id), 'DUPLICATE', `Duplicate lifter ${lifter.id}`);
    lifterIds.add(lifter.id);
    check(lifter.kind === 'owner-load-call', 'LIFTER', 'Unknown lifter kind');
    record(lifter.target, ['binarySha256', 'rva', 'bodySha256'], [], 'lifter target');
    exactTarget(database, lifter.target.binarySha256, lifter.target.rva);
    sha(lifter.target.bodySha256, 'lifter.target.bodySha256');
    const mapped = database.functions.find(
      (fn) => fn.binarySha256 === lifter.target.binarySha256 && fn.rva === lifter.target.rva,
    );
    check(mapped, 'LIFTER', 'Lifter target requires an explicit native function mapping');
    record(
      lifter.operation,
      ['address', 'sequence', 'addressSpace', 'offsetBytes', 'widthBits'],
      [],
      'lifter operation',
    );
    check(HEX.test(lifter.operation.address), 'ADDRESS', 'Lifter operation address is invalid');
    const binary = database.binaries.find(
      (candidate) => candidate.executableSha256 === lifter.target.binarySha256,
    );
    check(
      BigInt(lifter.operation.address) >= BigInt(binary.imageBase),
      'ADDRESS',
      'Lifter operation address is below the image base',
    );
    check(
      Number.isSafeInteger(lifter.operation.sequence) && lifter.operation.sequence >= 0,
      'LIFTER',
      'Lifter operation sequence must be a nonnegative safe integer',
    );
    text(lifter.operation.addressSpace, 'lifter.operation.addressSpace');
    check(
      Number.isSafeInteger(lifter.operation.offsetBytes) && lifter.operation.offsetBytes >= 0,
      'LIFTER',
      'Owner-load offsets must be nonnegative byte offsets',
    );
    check(
      [8, 16, 32, 64].includes(lifter.operation.widthBits),
      'LIFTER',
      'Owner-load widths must be 8, 16, 32 or 64 bits',
    );
    identifier(lifter.receiverParameter, 'lifter.receiverParameter');
    const receiver = mapped.abi.parameters.find(
      (parameter) => parameter.name === lifter.receiverParameter,
    );
    check(receiver, 'LIFTER', 'Owner-load receiver must name a native parameter');
    const implementation = database.implementations.find(
      (candidate) => candidate.id === lifter.implementation,
    );
    check(
      implementation,
      'IMPLEMENTATION',
      `Unknown lifter implementation ${lifter.implementation}`,
    );
    const result = resolveTypeInternal(
      database,
      implementation.signature.returnType,
      {},
      new Set(),
    );
    check(
      result.kind === 'integer' && result.bits === lifter.operation.widthBits,
      'LIFTER',
      'Owner-load implementation return width must match the native load',
    );
    check(
      Array.isArray(lifter.arguments) &&
        lifter.arguments.length === implementation.signature.parameters.length,
      'LIFTER',
      'Lifter bindings must cover the implementation signature',
    );
    lifter.arguments.forEach((argument, index) => {
      record(argument, ['parameter', 'source'], [], 'lifter argument');
      const parameter = implementation.signature.parameters[index];
      check(
        argument.parameter === parameter.name,
        'LIFTER',
        'Lifter bindings must follow implementation parameter order',
      );
      record(argument.source, ['kind', 'name'], [], 'lifter argument source');
      check(
        argument.source.kind === 'native-parameter',
        'LIFTER',
        'Unsupported lifter argument source',
      );
      const source = mapped.abi.parameters.find(
        (candidate) => candidate.name === argument.source.name,
      );
      check(
        source && canonicalJson(source.type) === canonicalJson(parameter.type),
        'LIFTER',
        'Lifter argument type differs from the native parameter contract',
      );
    });
    evidence(lifter.evidence);
    check(
      lifter.evidence.state !== 'source-assertion',
      'EVIDENCE',
      'Executable lifter rules require synthetic or reviewed-contract evidence',
    );
  }
  for (const family of database.variantFamilies) {
    record(
      family,
      ['id', 'kind', 'selector', 'operations'],
      family.kind === 'type' ? ['types'] : [],
      'variant family',
    );
    check(['code', 'type'].includes(family.kind), 'VARIANT', 'Variant kind must be code or type');
    record(family.selector, ['type', 'values'], ['initial'], 'selector');
    check(
      ['u8', 'u16', 'u32', 'i8', 'i16', 'i32'].includes(family.selector.type),
      'VARIANT',
      'Selectors use explicit number-represented integer scalar types',
    );
    check(
      Array.isArray(family.selector.values) && family.selector.values.length > 0,
      'VARIANT',
      'Selectors require finite nonempty values',
    );
    const values = new Set();
    for (const value of family.selector.values) {
      check(Number.isSafeInteger(value), 'VARIANT', 'Selector values must be integers');
      validateConstant(database, family.selector.type, String(value));
      check(!values.has(value), 'VARIANT', 'Duplicate selector value');
      values.add(value);
    }
    if (Object.hasOwn(family.selector, 'initial'))
      check(
        values.has(family.selector.initial),
        'VARIANT',
        'Initial selector is outside the finite target set',
      );
    check(
      Array.isArray(family.operations) && family.operations.length > 0,
      'VARIANT',
      'A family requires explicit operation signatures and targets',
    );
    const operationIds = new Set();
    for (const operation of family.operations) {
      record(operation, ['id', 'signature', 'targets']);
      id(operation.id, 'operation.id');
      check(!operationIds.has(operation.id), 'VARIANT', 'Duplicate operation ID');
      operationIds.add(operation.id);
      signature(operation.signature, database);
      check(Array.isArray(operation.targets), 'VARIANT', 'Targets must be an array');
      const covered = new Set();
      for (const target of operation.targets) {
        record(target, ['selectorValue', 'implementation', 'applicability', 'evidence']);
        check(
          values.has(target.selectorValue) && !covered.has(target.selectorValue),
          'VARIANT',
          'Target selector missing, repeated or outside finite set',
        );
        covered.add(target.selectorValue);
        const implementation = database.implementations.find(
          (candidate) => candidate.id === target.implementation,
        );
        check(
          implementation,
          'IMPLEMENTATION',
          `Unknown variant implementation ${target.implementation}`,
        );
        check(
          signatureShape(operation.signature) === signatureShape(implementation.signature),
          'SIGNATURE',
          'Variant targets require an exactly matching ordered type signature; use explicit adapters',
        );
        evidence(target.evidence);
        check(
          target.evidence.state !== 'source-assertion',
          'EVIDENCE',
          'Finite variant targets require synthetic or reviewed-contract evidence',
        );
        check(
          Array.isArray(target.applicability) && target.applicability.length > 0,
          'VARIANT',
          'Variant target applicability must enumerate exact binary/RVA pairs',
        );
        const applicability = new Set();
        for (const address of target.applicability) {
          record(address, ['binarySha256', 'rva', 'body']);
          exactTarget(database, address.binarySha256, address.rva);
          record(address.body, ['kind', 'sha256', 'provenance'], [], 'variant body');
          check(
            [
              'synthetic',
              'reviewed-patch',
              'reviewed-decoded-body',
              'reviewed-original-body',
            ].includes(address.body.kind),
            'VARIANT',
            'Variant bodies require an explicit reviewed or synthetic origin',
          );
          sha(address.body.sha256, 'variant.body.sha256');
          record(
            address.body.provenance,
            ['path', 'sha256', 'section'],
            [],
            'variant body provenance',
          );
          relative(address.body.provenance.path, 'variant.body.provenance.path');
          sha(address.body.provenance.sha256, 'variant.body.provenance.sha256');
          text(address.body.provenance.section, 'variant.body.provenance.section');
          check(
            (target.evidence.state === 'synthetic') === (address.body.kind === 'synthetic'),
            'EVIDENCE',
            'Synthetic and reviewed variant body evidence must not be conflated',
          );
          const key = `${address.binarySha256}:${address.rva}`;
          check(!applicability.has(key), 'DUPLICATE', 'Duplicate variant applicability target');
          applicability.add(key);
          const mapped = database.functions.find(
            (fn) => fn.binarySha256 === address.binarySha256 && fn.rva === address.rva,
          );
          check(
            mapped,
            'VARIANT',
            'Variant applicability must name an explicit native function mapping',
          );
          check(
            mapped.implementation === target.implementation ||
              address.body.kind !== 'reviewed-original-body',
            'VARIANT',
            'Alternate implementations at one entry require reviewed patch/decoded-body provenance',
          );
        }
      }
      check(covered.size === values.size, 'VARIANT', 'Operation omits one or more selector values');
    }
    if (family.kind === 'type') {
      check(
        Array.isArray(family.types),
        'VARIANT',
        'Type families require explicit selected types',
      );
      const covered = new Set();
      for (const target of family.types) {
        record(target, ['selectorValue', 'type', 'evidence']);
        check(
          values.has(target.selectorValue) && !covered.has(target.selectorValue),
          'VARIANT',
          'Invalid type selector target',
        );
        covered.add(target.selectorValue);
        typeRef(target.type, database);
        evidence(target.evidence);
        check(
          target.evidence.state !== 'source-assertion',
          'EVIDENCE',
          'Type variant targets require review',
        );
      }
      check(covered.size === values.size, 'VARIANT', 'Type family omits selected types');
    }
  }
  return database;
}

function generatedImport(descriptor, typeOnly, options) {
  const localName = `mapping_${descriptor.export}_${hash(`${descriptor.module}#${descriptor.export}`).slice(0, 10)}`;
  let moduleSpecifier = descriptor.module;
  if (options.fromFile) {
    relative(options.fromFile, 'generated source path');
    moduleSpecifier = path.posix.relative(path.posix.dirname(options.fromFile), descriptor.module);
    if (!moduleSpecifier.startsWith('.')) moduleSpecifier = `./${moduleSpecifier}`;
  }
  return {...descriptor, moduleSpecifier, localName, typeOnly};
}
function resolveTypeInternal(database, type, options, visited) {
  if (typeof type === 'string') {
    const integer = /^([ui])(8|16|32|64)$/.exec(type);
    if (integer) {
      const bits = Number(integer[2]),
        representation = bits === 64 ? 'bigint' : 'number';
      return {
        type,
        kind: 'integer',
        representation,
        typeScript: representation,
        bits,
        signed: integer[1] === 'i',
        imports: [],
      };
    }
    if (type === 'f32' || type === 'f64')
      return {
        type,
        kind: 'float',
        representation: 'number',
        typeScript: 'number',
        bits: Number(type.slice(1)),
        imports: [],
      };
    if (type === 'bool')
      return {type, kind: 'boolean', representation: 'boolean', typeScript: 'boolean', imports: []};
    check(type === 'void' || type === 'unknown', 'TYPE', `Unknown type ${type}`);
    return {type, kind: type, representation: type, typeScript: type, imports: []};
  }
  check(type && typeof type.named === 'string', 'TYPE', 'Expected scalar or named type');
  check(!visited.has(type.named), 'TYPE_CYCLE', `Cyclic type alias ${type.named}`);
  const definition = database.types.find((candidate) => candidate.id === type.named);
  check(definition, 'TYPE', `Unknown named type ${type.named}`);
  visited = new Set(visited).add(type.named);
  if (definition.kind === 'alias')
    return {...resolveTypeInternal(database, definition.target, options, visited), type};
  if (definition.kind === 'integer')
    return {
      type,
      kind: 'integer',
      representation: definition.representation,
      typeScript: definition.representation,
      bits: definition.bits,
      signed: definition.signed,
      imports: [],
    };
  const imported = definition.import ? generatedImport(definition.import, true, options) : null;
  let typeScript = imported ? imported.localName : 'unknown';
  if (definition.kind === 'reference' && definition.mutability === 'readonly')
    typeScript = `Readonly<${typeScript}>`;
  if (definition.nullable && imported) typeScript += ' | null';
  return {
    type,
    kind: definition.kind,
    representation: imported ? 'object' : 'unknown',
    typeScript,
    ...(definition.nativeBits ? {nativeBits: definition.nativeBits} : {}),
    nullable: definition.nullable,
    imports: imported ? [imported] : [],
  };
}
export function resolveType(database, type, options = {}) {
  validateDatabase(database);
  typeRef(type, database, true);
  return resolveTypeInternal(database, type, options, new Set());
}
function validateConstant(database, type, value) {
  const resolved = resolveTypeInternal(database, type, {}, new Set());
  if (resolved.kind === 'boolean') {
    check(typeof value === 'boolean', 'CONSTANT', 'Boolean constants must be JSON booleans');
    return;
  }
  if (resolved.kind === 'integer') {
    check(
      typeof value === 'string' && /^(?:0|-?[1-9][0-9]*)$/.test(value),
      'CONSTANT',
      'Integer constants must be canonical decimal strings',
    );
    const number = BigInt(value),
      width = BigInt(resolved.bits),
      min = resolved.signed ? -(1n << (width - 1n)) : 0n,
      max = resolved.signed ? (1n << (width - 1n)) - 1n : (1n << width) - 1n;
    check(number >= min && number <= max, 'CONSTANT', 'Integer constant exceeds its declared type');
    return;
  }
  check(
    resolved.kind === 'float' &&
      typeof value === 'string' &&
      value.trim() === value &&
      value.length > 0 &&
      Number.isFinite(Number(value)),
    'CONSTANT',
    'Only finite explicitly written numeric/boolean constants are supported',
  );
}
export function resolveFunction(database, binarySha256, rva) {
  validateDatabase(database);
  exactTarget(database, binarySha256, rva);
  const value = database.functions.find((fn) => fn.binarySha256 === binarySha256 && fn.rva === rva);
  check(value, 'UNMAPPED_FUNCTION', `Unmapped native function ${binarySha256}:${rva}`);
  return value;
}
export function resolveImplementation(database, implementationId) {
  validateDatabase(database);
  const value = database.implementations.find(
    (implementation) => implementation.id === implementationId,
  );
  check(value, 'IMPLEMENTATION', `Unknown implementation ${implementationId}`);
  return value;
}
export function resolveVariantFamily(database, familyId) {
  validateDatabase(database);
  const value = database.variantFamilies.find((family) => family.id === familyId);
  check(value, 'VARIANT', `Unknown variant family ${familyId}`);
  return value;
}
export function resolveVariantTarget(database, familyId, operationId, selectorValue) {
  const family = resolveVariantFamily(database, familyId);
  const operation = family.operations.find((candidate) => candidate.id === operationId);
  const target = operation?.targets.find((candidate) => candidate.selectorValue === selectorValue);
  check(target, 'VARIANT', 'Unregistered operation or selector value');
  return target;
}
export function resolveLifters(database, binarySha256, rva, bodySha256) {
  validateDatabase(database);
  exactTarget(database, binarySha256, rva);
  sha(bodySha256, 'bodySha256');
  return (database.lifters ?? []).filter(
    (lifter) =>
      lifter.target.binarySha256 === binarySha256 &&
      lifter.target.rva === rva &&
      lifter.target.bodySha256 === bodySha256,
  );
}
export function resolveLayout(database, type) {
  validateDatabase(database);
  id(type, 'layout type');
  const value = (database.layouts ?? []).find((layout) => layout.type === type);
  check(value, 'UNMAPPED_LAYOUT', `Unmapped native layout ${type}`);
  return value;
}
export function resolveGlobal(database, binarySha256, globalAddress) {
  validateDatabase(database);
  const binary = database.binaries.find((candidate) => candidate.executableSha256 === binarySha256);
  check(binary, 'BINARY', `Unknown executable ${binarySha256}`);
  check(HEX.test(globalAddress), 'ADDRESS', 'Global address must be canonical hexadecimal');
  const value = (database.globals ?? []).find(
    (global) => global.binarySha256 === binarySha256 && global.address === globalAddress,
  );
  check(value, 'UNMAPPED_GLOBAL', `Unmapped native global ${binarySha256}:${globalAddress}`);
  return value;
}
export function describeImplementation(database, implementationId, options = {}) {
  const implementation = resolveImplementation(database, implementationId);
  const parameters = implementation.signature.parameters.map((parameter) => ({
    name: parameter.name,
    type: resolveTypeInternal(database, parameter.type, options, new Set()),
  }));
  const returnType = resolveTypeInternal(
    database,
    implementation.signature.returnType,
    options,
    new Set(),
  );
  const valueImport = generatedImport(implementation, false, options);
  // The public import descriptor contains only import/source data, never signatures or evidence.
  const importDescriptor = {
    module: valueImport.module,
    moduleSpecifier: valueImport.moduleSpecifier,
    export: valueImport.export,
    localName: valueImport.localName,
    typeOnly: false,
    source: valueImport.source,
  };
  const imports = [
    importDescriptor,
    ...parameters.flatMap((parameter) => parameter.type.imports),
    ...returnType.imports,
  ];
  const unique = [
    ...new Map(
      imports.map((entry) => [`${entry.typeOnly}:${entry.module}:${entry.export}`, entry]),
    ).values(),
  ].sort(
    (a, b) =>
      a.module.localeCompare(b.module) ||
      a.export.localeCompare(b.export) ||
      Number(a.typeOnly) - Number(b.typeOnly),
  );
  return {
    id: implementation.id,
    import: importDescriptor,
    signature: implementation.signature,
    parameters,
    returnType,
    imports: unique,
  };
}

async function safeSource(root, sourcePath) {
  relative(sourcePath, 'source path');
  let current = root;
  for (const segment of sourcePath.split('/')) {
    current = path.join(current, segment);
    check(
      !(await lstat(current)).isSymbolicLink(),
      'PATH',
      `Symlinked mapping input: ${sourcePath}`,
    );
  }
  check(
    (await lstat(current)).isFile() && (await realpath(current)).startsWith(`${root}${path.sep}`),
    'PATH',
    'Mapping source must be a regular file inside the canonical repository',
  );
  return readFile(current);
}
export async function verifyDatabaseSources(database, root) {
  validateDatabase(database);
  root = await realpath(root);
  const pins = [
    ...database.implementations.map((implementation) => implementation.source),
    ...database.types.filter((type) => type.import).map((type) => type.import.source),
  ];
  const unique = [...new Map(pins.map((pin) => [pin.path, pin])).values()].sort((a, b) =>
    a.path.localeCompare(b.path),
  );
  for (const source of unique) {
    const actual = hash(await safeSource(root, source.path));
    check(actual === source.sha256, 'SOURCE_DRIFT', `Mapping source hash changed: ${source.path}`, {
      path: source.path,
      expected: source.sha256,
      actual,
    });
  }
  return {
    schemaVersion: 1,
    kind: 'mapping-source-receipt',
    databaseSha256: databaseSha256(database),
    ok: true,
    sources: unique,
  };
}
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export async function loadDatabase(file, {root = process.cwd(), verifySources = true} = {}) {
  const database = validateDatabase(JSON.parse(await readFile(file, 'utf8')));
  if (verifySources) await verifyDatabaseSources(database, root);
  return freeze(database);
}
export async function publishDatabase(database, destination, {root = process.cwd()} = {}) {
  await verifyDatabaseSources(database, root);
  const output = path.join(
    await realpath(path.dirname(path.resolve(destination))),
    path.basename(destination),
  );
  const temporary = path.join(
    path.dirname(output),
    `.${path.basename(output)}.${randomUUID()}.tmp`,
  );
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(`${JSON.stringify(database, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(temporary, output);
  } finally {
    await unlink(temporary);
  }
  return {path: output, databaseSha256: databaseSha256(database)};
}

async function main(argv) {
  const [command, file, ...rest] = argv;
  if (!['validate', 'query', 'publish'].includes(command) || !file) {
    console.log(
      'Usage: node tools/native-lift/database.mjs validate DB [--root DIR]\n       node tools/native-lift/database.mjs query DB --binary SHA256 --rva 0xRVA [--from FILE] [--root DIR]\n       node tools/native-lift/database.mjs publish DB --out NEW.json [--root DIR]\nAll commands verify explicit source hashes. Publish atomically creates a new file and never overwrites an existing path.',
    );
    process.exitCode = command ? 1 : 0;
    return;
  }
  const options = {};
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index];
    check(
      ['--root', '--binary', '--rva', '--from', '--out'].includes(flag) &&
        rest[index + 1] &&
        !rest[index + 1].startsWith('--'),
      'CLI',
      `Unknown flag or missing value ${flag}`,
    );
    check(!Object.hasOwn(options, flag), 'CLI', `Repeated option ${flag}`);
    options[flag] = rest[++index];
  }
  const root = options['--root'] ?? process.cwd(),
    database = await loadDatabase(file, {root});
  let result;
  if (command === 'validate') result = await verifyDatabaseSources(database, root);
  if (command === 'query') {
    const mapping = resolveFunction(database, options['--binary'], options['--rva']);
    result = {
      mapping,
      implementation: describeImplementation(database, mapping.implementation, {
        fromFile: options['--from'],
      }),
    };
  }
  if (command === 'publish') {
    check(options['--out'], 'CLI', 'publish requires --out');
    result = await publishDatabase(database, options['--out'], {root});
  }
  console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).catch((error) => {
    console.error(`native mappings: ${error.code ?? 'ERROR'}: ${error.message}`);
    process.exitCode = 1;
  });

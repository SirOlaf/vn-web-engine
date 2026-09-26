/** Ordinary deterministic metadata/source-pin tests only. No native/runtime source is imported. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {
  canonicalJson,
  databaseSha256,
  describeImplementation,
  loadDatabase,
  publishDatabase,
  resolveFunction,
  resolveGlobal,
  resolveImplementation,
  resolveLayout,
  resolveType,
  resolveVariantFamily,
  resolveVariantTarget,
  validateDatabase,
  verifyDatabaseSources,
} from '../tools/native-lift/database.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const digest = (value) => createHash('sha256').update(value).digest('hex');
const binarySha256 = 'a'.repeat(64);
const otherBinary = 'b'.repeat(64);
const sourceText = `throw new Error('Metadata tools must not execute this file');\nexport function first(x: number, y: number): number {return x + y;}\nexport function second(x: number, y: number): number {return x - y;}\nexport interface RecordValue {value: number}\n`;
const pin = {path: 'src/helpers.ts', sha256: digest(sourceText)};
const synthetic = () => ({
  state: 'synthetic',
  references: [],
  notes: ['Synthetic metadata, never a native equivalence claim.'],
});
const signature = () => ({
  parameters: [
    {name: 'x', type: 'i32'},
    {name: 'y', type: 'i32'},
  ],
  returnType: 'i32',
});
const binding = (name, register) => ({
  name,
  type: 'i32',
  location: {kind: 'register', name: register},
});
const body = (label) => ({
  kind: 'synthetic',
  sha256: digest(label),
  provenance: {...pin, section: `Synthetic body identity: ${label}`},
});

function fixture() {
  const implementation = (id, exported) => ({
    id,
    module: 'src/helpers.js',
    export: exported,
    source: {...pin},
    signature: signature(),
    evidence: synthetic(),
  });
  const fn = (rva, implementation) => ({
    binarySha256,
    rva,
    implementation,
    abi: {
      convention: 'win64',
      parameters: [binding('nativeY', 'ecx'), binding('nativeX', 'edx')],
      arguments: [
        {parameter: 'x', source: {kind: 'parameter', name: 'nativeX'}},
        {parameter: 'y', source: {kind: 'parameter', name: 'nativeY'}},
      ],
      returnLocation: {kind: 'register', name: 'eax'},
    },
    evidence: synthetic(),
  });
  const targets = () => [
    {
      selectorValue: 0,
      implementation: 'first',
      applicability: [{binarySha256, rva: '0x10', body: body('base')}],
      evidence: synthetic(),
    },
    {
      selectorValue: 2,
      implementation: 'second',
      applicability: [{binarySha256, rva: '0x20', body: body('alternate')}],
      evidence: synthetic(),
    },
  ];
  return {
    schemaVersion: 1,
    kind: 'native-mapping-database',
    binaries: [
      {
        id: 'synthetic-a',
        programPath: '/a.exe',
        executableSha256: binarySha256,
        languageId: 'x86:LE:64:default',
        imageBase: '0x140000000',
      },
    ],
    types: [
      {id: 'WideCounter', kind: 'integer', bits: 32, signed: false, representation: 'bigint'},
      {
        id: 'Record',
        kind: 'reference',
        import: {module: 'src/helpers.js', export: 'RecordValue', source: {...pin}},
        nativeBits: 64,
        nullable: true,
        mutability: 'readonly',
      },
      {id: 'RecordAlias', kind: 'alias', target: {named: 'Record'}},
      {id: 'UnknownPointer', kind: 'opaque', import: null, nullable: true},
    ],
    implementations: [implementation('first', 'first'), implementation('second', 'second')],
    functions: [fn('0x10', 'first'), fn('0x20', 'second')],
    variantFamilies: [
      {
        id: 'arithmetic',
        kind: 'code',
        selector: {type: 'u8', values: [0, 2], initial: 0},
        operations: [{id: 'call', signature: signature(), targets: targets()}],
      },
      {
        id: 'record-version',
        kind: 'type',
        selector: {type: 'u8', values: [0, 2]},
        operations: [{id: 'value', signature: signature(), targets: targets()}],
        types: [
          {selectorValue: 0, type: {named: 'Record'}, evidence: synthetic()},
          {selectorValue: 2, type: {named: 'UnknownPointer'}, evidence: synthetic()},
        ],
      },
    ],
  };
}

async function temporaryProject(callback) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'native-mapping-tooling-'));
  try {
    await mkdir(path.join(temporary, 'src'));
    await writeFile(path.join(temporary, pin.path), sourceText);
    return await callback(temporary);
  } finally {
    await rm(temporary, {recursive: true, force: true});
  }
}

test('native addresses resolve by executable hash and RVA, independently of names or other versions', () => {
  const database = fixture();
  database.binaries.push({
    ...database.binaries[0],
    id: 'synthetic-b',
    executableSha256: otherBinary,
  });
  database.functions.push({
    ...structuredClone(database.functions[0]),
    binarySha256: otherBinary,
    implementation: 'second',
  });
  assert.equal(resolveFunction(database, binarySha256, '0x10').implementation, 'first');
  assert.equal(resolveFunction(database, otherBinary, '0x10').implementation, 'second');
  assert.throws(() => resolveFunction(database, binarySha256, '0x30'), /Unmapped/);
  assert.throws(() => resolveFunction(database, binarySha256, '0x010'), /canonical/);
  assert.throws(() => resolveFunction(database, 'c'.repeat(64), '0x10'), /Unknown executable/);
});

test('implementation signatures and ABI argument reordering are explicit database contracts', () => {
  const database = validateDatabase(fixture());
  assert.deepEqual(resolveImplementation(database, 'first').signature, signature());
  assert.deepEqual(
    database.functions[0].abi.arguments.map((binding) => binding.source.name),
    ['nativeX', 'nativeY'],
  );
  for (const change of [
    (db) => db.functions[0].abi.arguments.reverse(),
    (db) => {
      db.functions[0].abi.parameters[0].type = 'u32';
    },
    (db) => {
      db.functions[0].abi.arguments[0].source.name = 'absent';
    },
    (db) => {
      db.functions[0].abi.parameters[1].location = {kind: 'register', name: 'ecx'};
    },
    (db) => {
      db.functions[0].abi.returnLocation = {kind: 'void'};
    },
  ]) {
    const changed = structuredClone(database);
    change(changed);
    assert.throws(() => validateDatabase(changed));
  }
  for (const name of ['eval', 'arguments']) {
    for (const change of [
      (db) => {
        db.implementations[0].signature.parameters[0].name = name;
      },
      (db) => {
        db.implementations[0].export = name;
      },
      (db) => {
        db.functions[0].abi.parameters[0].name = name;
      },
    ]) {
      const changed = structuredClone(database);
      change(changed);
      assert.throws(() => validateDatabase(changed), /non-reserved TypeScript identifier/);
    }
  }
});

test('rich type descriptors preserve integer representation and direct named type imports', () => {
  const database = fixture();
  assert.equal(resolveType(database, 'u64').typeScript, 'bigint');
  assert.equal(resolveType(database, 'i32').typeScript, 'number');
  assert.equal(resolveType(database, {named: 'WideCounter'}).representation, 'bigint');
  const alias = resolveType(database, {named: 'RecordAlias'}, {fromFile: 'src/generated/call.ts'});
  assert.equal(alias.kind, 'reference');
  assert.match(alias.typeScript, /^Readonly<mapping_RecordValue_[a-f0-9]+> \| null$/);
  assert.equal(alias.imports[0].moduleSpecifier, '../helpers.js');
  assert.equal(alias.imports[0].typeOnly, true);
  assert.equal(resolveType(database, {named: 'UnknownPointer'}).typeScript, 'unknown');
  assert.equal(resolveType(database, 'unknown').typeScript, 'unknown');
  const changed = fixture();
  changed.types[0].bits = 64;
  changed.types[0].representation = 'number';
  assert.throws(() => validateDatabase(changed), /64-bit integers require bigint/);
});

test('native layouts and globals retain field widths, array strides and implementation roots', () => {
  const database = fixture();
  database.types.push({id: 'RecordTable', kind: 'opaque', import: null, nullable: false});
  database.layouts = [
    {
      id: 'record.layout',
      kind: 'struct',
      type: 'Record',
      size: {bytes: 16, kind: 'minimum'},
      fields: [
        {name: 'value', offsetBytes: 0, sizeBytes: 4, storage: 'inline', type: 'i32'},
        {name: 'next', offsetBytes: 8, sizeBytes: 8, storage: 'pointer', type: {named: 'Record'}},
      ],
      evidence: synthetic(),
    },
    {
      id: 'record-table.layout',
      kind: 'array',
      type: 'RecordTable',
      size: {bytes: 64, kind: 'exact'},
      elementType: {named: 'Record'},
      elementSizeBytes: 16,
      count: 4,
      evidence: synthetic(),
    },
  ];
  database.globals = [
    {
      binarySha256,
      address: '0x140000100',
      name: 'records',
      type: {named: 'RecordTable'},
      implementation: {rootType: {named: 'Record'}, path: ['value']},
      evidence: synthetic(),
    },
  ];
  validateDatabase(database);
  assert.equal(resolveLayout(database, 'Record').fields[1].offsetBytes, 8);
  assert.equal(resolveLayout(database, 'RecordTable').elementSizeBytes, 16);
  assert.deepEqual(resolveGlobal(database, binarySha256, '0x140000100').implementation.path, [
    'value',
  ]);

  const overlap = structuredClone(database);
  overlap.layouts[0].fields[1].offsetBytes = 2;
  assert.throws(() => validateDatabase(overlap), /overlap/);
  const badStride = structuredClone(database);
  badStride.layouts[1].elementSizeBytes = 8;
  assert.throws(() => validateDatabase(badStride), /elementSizeBytes/);
  const duplicateGlobal = structuredClone(database);
  duplicateGlobal.globals.push(structuredClone(duplicateGlobal.globals[0]));
  assert.throws(() => validateDatabase(duplicateGlobal), /Duplicate native global/);
});

test('unknown types and cyclic aliases fail without falling back to any', () => {
  const database = fixture();
  assert.throws(() => resolveType(database, {named: 'missing'}), /Unknown named type/);
  database.types.push({id: 'Loop', kind: 'alias', target: {named: 'Loop'}});
  assert.throws(() => validateDatabase(database), /Cyclic type alias/);
  const changed = fixture();
  changed.implementations[0].signature.returnType = 'any';
  assert.throws(() => validateDatabase(changed), /Unknown or invalid scalar/);
});

test('finite variant arrays carry metadata only, with an absent initial value for an empty active stack', () => {
  const database = fixture();
  const family = resolveVariantFamily(database, 'record-version');
  assert.equal(Object.hasOwn(family.selector, 'initial'), false);
  assert.deepEqual(family.selector.values, [0, 2]);
  assert.equal(resolveVariantTarget(database, 'arithmetic', 'call', 2).implementation, 'second');
  assert.equal(resolveVariantTarget(database, 'arithmetic', 'call', 0).implementation, 'first');
  assert.equal(Object.hasOwn(family, 'active'), false);
  assert.throws(() => resolveVariantTarget(database, 'arithmetic', 'call', 1), /Unregistered/);
  database.variantFamilies[0].operations[0].targets[1].applicability[0].rva = '0x10';
  assert.doesNotThrow(() => validateDatabase(database));
  const sameEntry = resolveVariantTarget(database, 'arithmetic', 'call', 2);
  assert.equal(sameEntry.applicability[0].rva, database.functions[0].rva);
  assert.notEqual(sameEntry.implementation, database.functions[0].implementation);
  assert.notEqual(
    sameEntry.applicability[0].body.sha256,
    resolveVariantTarget(database, 'arithmetic', 'call', 0).applicability[0].body.sha256,
  );
});

test('variant contracts reject omitted, duplicated, mismatched, unreviewed or wrongly attributed targets', () => {
  for (const change of [
    (db) => db.variantFamilies[0].operations[0].targets.pop(),
    (db) => {
      db.variantFamilies[0].operations[0].targets[1].selectorValue = 0;
    },
    (db) => {
      db.variantFamilies[0].selector.initial = 1;
    },
    (db) => {
      db.variantFamilies[0].operations[0].signature.returnType = 'u32';
    },
    (db) => {
      db.variantFamilies[0].operations[0].targets[0].applicability[0].rva = '0x30';
    },
    (db) => {
      delete db.variantFamilies[0].operations[0].targets[0].applicability[0].body;
    },
    (db) => {
      db.variantFamilies[0].operations[0].targets[0].evidence = {
        state: 'source-assertion',
        references: [{...pin, section: 'assertion'}],
        notes: [],
      };
    },
    (db) => db.variantFamilies[1].types.pop(),
  ]) {
    const changed = fixture();
    change(changed);
    assert.throws(() => validateDatabase(changed));
  }
});

test('constant ABI bindings retain fixed-width values and reject overflow or untyped coercions', () => {
  const database = fixture();
  database.functions[0].abi.arguments[0].source = {
    kind: 'constant',
    type: 'i32',
    value: '-2147483648',
  };
  assert.doesNotThrow(() => validateDatabase(database));
  database.functions[0].abi.arguments[0].source.value = '2147483648';
  assert.throws(() => validateDatabase(database), /exceeds/);
  database.functions[0].abi.arguments[0].source.value = -1;
  assert.throws(() => validateDatabase(database), /decimal strings/);
});

test('import descriptors are deterministic, source-pinned and relative to the generated file', () => {
  const database = fixture();
  const description = describeImplementation(database, 'first', {
    fromFile: 'src/generated/call.ts',
  });
  assert.equal(description.import.moduleSpecifier, '../helpers.js');
  assert.equal(description.import.export, 'first');
  assert.equal(description.import.source.sha256, pin.sha256);
  assert.deepEqual(
    description,
    describeImplementation(database, 'first', {fromFile: 'src/generated/call.ts'}),
  );
  assert.deepEqual(
    description.parameters.map((parameter) => parameter.type.typeScript),
    ['number', 'number'],
  );
  assert.equal(description.imports.length, 1);
  const changed = fixture();
  changed.implementations[0].module = 'src/unpinned.js';
  assert.throws(() => validateDatabase(changed), /correspond to its pinned source/);
});

test('source verification reads hashes without parsing or executing source and rejects drift and symlinks', async () => {
  await temporaryProject(async (temporary) => {
    const database = fixture();
    assert.equal((await verifyDatabaseSources(database, temporary)).ok, true);
    await writeFile(path.join(temporary, pin.path), 'This is deliberately not valid TypeScript.');
    await assert.rejects(verifyDatabaseSources(database, temporary), /source hash changed/);
    const changed = fixture();
    const next = digest('This is deliberately not valid TypeScript.');
    for (const implementation of changed.implementations) implementation.source.sha256 = next;
    changed.types.find((type) => type.id === 'Record').import.source.sha256 = next;
    assert.equal((await verifyDatabaseSources(changed, temporary)).ok, true);
    await writeFile(path.join(temporary, 'outside.ts'), sourceText);
    await rm(path.join(temporary, pin.path));
    await symlink(path.join(temporary, 'outside.ts'), path.join(temporary, pin.path));
    await assert.rejects(verifyDatabaseSources(database, temporary), /Symlinked mapping input/);
  });
});

test('atomic publication preserves existing files and load verifies and freezes the database', async () => {
  await temporaryProject(async (temporary) => {
    const database = fixture(),
      destination = path.join(temporary, 'mapping.json');
    const result = await publishDatabase(database, destination, {root: temporary});
    assert.equal(result.databaseSha256, databaseSha256(database));
    const original = await readFile(destination, 'utf8');
    await assert.rejects(publishDatabase(database, destination, {root: temporary}), /EEXIST/);
    assert.equal(await readFile(destination, 'utf8'), original);
    assert.equal(
      (await readdir(temporary)).some((file) => file.endsWith('.tmp')),
      false,
    );
    const loaded = await loadDatabase(destination, {root: temporary});
    assert.equal(Object.isFrozen(loaded.variantFamilies[0].operations[0].targets), true);
    assert.equal(canonicalJson(loaded), canonicalJson(database));
  });
});

test('mapping CLI validates and queries explicit signatures with source verification', async () => {
  await temporaryProject(async (temporary) => {
    const databaseFile = path.join(temporary, 'mapping.json');
    await writeFile(databaseFile, JSON.stringify(fixture()));
    const run = (...args) =>
      spawnSync(
        process.execPath,
        [path.join(root, 'tools/native-lift/database.mjs'), ...args, '--root', temporary],
        {encoding: 'utf8', timeout: 15000},
      );
    let result = run('validate', databaseFile);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).kind, 'mapping-source-receipt');
    result = run(
      'query',
      databaseFile,
      '--binary',
      binarySha256,
      '--rva',
      '0x10',
      '--from',
      'src/generated/call.ts',
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).implementation.import.moduleSpecifier, '../helpers.js');
    result = run('publish', databaseFile, '--out', databaseFile);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /EEXIST/);
  });
});

test('real Buriko mappings retain unresolved seeds and reviewed particle routes', async () => {
  const database = await loadDatabase(path.join(root, 'tools/native-lift/mappings/aokana.json'), {
    root,
  });
  const binary = database.binaries[0].executableSha256;
  assert.equal(binary, 'f585e28f79923b8aa487d8690165e45ce3377c7e1b8381d3b75c659c7e933d7a');
  assert.deepEqual(
    database.functions.map((fn) => fn.rva),
    ['0x315f0', '0xa0f60', '0xef720', '0x95bb0', '0x95be0'],
  );
  const vector = describeImplementation(
    database,
    resolveFunction(database, binary, '0x315f0').implementation,
    {fromFile: 'src/generated/aokana.ts'},
  );
  assert.equal(vector.import.export, 'nativeVectorAngle');
  assert.deepEqual(vector.signature.parameters, [
    {name: 'x', type: 'i32'},
    {name: 'y', type: 'i32'},
  ]);
  assert.deepEqual(
    resolveImplementation(database, 'aokana.nativeCursorInterpolation').signature.parameters.map(
      (parameter) => parameter.name,
    ),
    ['delta', 'easing', 'progress', 'steps'],
  );
  assert.equal(
    database.functions
      .filter((fn) => !['0x95bb0', '0x95be0'].includes(fn.rva))
      .every(
        (fn) => fn.evidence.state === 'source-assertion' && fn.abi.convention === 'unresolved',
      ),
    true,
  );
  const frame = resolveFunction(database, binary, '0x95bb0');
  assert.equal(frame.evidence.state, 'reviewed-contract');
  assert.equal(frame.abi.convention, 'win64');
  assert.equal(frame.abi.parameters[0].location.name, 'rcx');
  assert.equal(frame.abi.returnLocation.name, 'ax');
  const advance = resolveFunction(database, binary, '0x95be0');
  assert.equal(advance.implementation, 'aokana.advanceParticle');
  assert.equal(advance.evidence.state, 'reviewed-contract');
  assert.equal(advance.abi.parameters[0].location.name, 'rcx');
  assert.equal(advance.abi.returnLocation.name, 'eax');
  assert.equal(resolveImplementation(database, advance.implementation).export, 'advanceParticle');
  assert.deepEqual(
    database.lifters.map((lifter) => lifter.id),
    ['aokana.particle.primary-frame-owner-load'],
  );
  assert.equal(resolveLayout(database, 'aokana.Particle').size.kind, 'minimum');
  assert.equal(resolveLayout(database, 'aokana.ParticleImages').fields[0].name, 'count');
  assert.deepEqual(resolveGlobal(database, binary, '0x1401e08e0').implementation.path, [
    'snowParameters',
  ]);
  assert.deepEqual(database.variantFamilies, []);
});

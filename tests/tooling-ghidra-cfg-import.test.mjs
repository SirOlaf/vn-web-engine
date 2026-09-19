import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {stripTypeScriptTypes} from 'node:module';
import {runInNewContext} from 'node:vm';
import {importGhidraFunction, validateGhidraExport} from '../tools/native-lift/ghidra-import.mjs';
import {canonicalJson, sha256} from '../tools/native-lift/index.mjs';
import {emitCfgTypeScript} from '../tools/native-lift/cfg.mjs';
import {verifyDatabaseSources} from '../tools/native-lift/database.mjs';
import * as reference from '../tools/native-lift/examples/ghidra/reference.mjs';

// Actual Ghidra decoding/decompilation of invented bytes is captured in fixtures.
// This suite only runs generated JavaScript, independent scalar references and a
// strict TypeScript check. The final call test imports one pure existing helper;
// it never constructs a game, VM, native service factory, media or host controller.
const root = fileURLToPath(new URL('../', import.meta.url));
const sourcePath = 'tools/native-lift/examples/ghidra/reference.mjs';
const sourceHash = sha256(readFileSync(path.join(root, sourcePath)));
const evidence = {
  state: 'synthetic',
  references: [{path: sourcePath, sha256: sourceHash, section: 'Invented integer functions'}],
  notes: ['Synthetic decoded fixtures, not a game equivalence claim.'],
};
function fixture(name) {
  return JSON.parse(
    readFileSync(
      new URL(`../tools/ghidra-bridge/fixtures/synthetic-${name}.json`, import.meta.url),
      'utf8',
    ),
  );
}
function database(exported, name = 'add') {
  const implementation = {
    id: `synthetic.${name}`,
    module: sourcePath,
    export: name,
    source: {path: sourcePath, sha256: sourceHash},
    signature: {parameters: [{name: 'value', type: 'i32'}], returnType: 'i32'},
    evidence,
  };
  return {
    schemaVersion: 1,
    kind: 'native-mapping-database',
    binaries: [{id: `synthetic-${name}`, ...exported.binary}],
    types: [],
    implementations: [implementation],
    functions: [
      {
        binarySha256: exported.binary.executableSha256,
        rva: '0x1000',
        implementation: implementation.id,
        abi: {
          convention: 'win64',
          parameters: [
            {name: 'nativeValue', type: 'i32', location: {kind: 'register', name: 'ecx'}},
          ],
          arguments: [{parameter: 'value', source: {kind: 'parameter', name: 'nativeValue'}}],
          returnLocation: {kind: 'register', name: 'eax'},
        },
        evidence,
      },
    ],
    variantFamilies: [],
  };
}
const plan = (exported, callArguments = {}) => ({
  schema: 'ghidra-cfg-import/v1',
  exportSha256: sha256(canonicalJson(exported)),
  sourceKind: 'synthetic',
  reviewReference: 'tests/tooling-ghidra-cfg-import.test.mjs synthetic review',
  assumptions: [],
  callArguments,
});
function compile(exported, db) {
  const imported = importGhidraFunction(exported, db, plan(exported));
  const emitted = emitCfgTypeScript(imported.module, db);
  const lifted = runInNewContext(
    `${stripTypeScriptTypes(emitted.source).replaceAll('export ', '')}\nlifted;`,
    {BigInt},
  );
  return {...imported, ...emitted, lifted};
}

test('Ghidra CFG import: actual decoded add uses database parameters and signed return adaptation', () => {
  const exported = fixture('add'),
    built = compile(exported, database(exported));
  assert.deepEqual(built.module.functions[0].parameterValues, {value: 'v1'});
  for (const value of [-2147483648, -6, -1, 0, 1, 10, 2147483647])
    assert.equal(built.lifted(value), reference.add(value));
  assert.equal(built.receipt.exportSha256, sha256(canonicalJson(exported)));
  assert.ok(built.receipt.lowerings.some((item) => item.reason.includes('database type adapter')));
  assert.equal(built.receipt.savedState, 'unverified');
});

test('Ghidra CFG import: actual branch preserves explicit edge roles and merge phi', () => {
  const exported = fixture('branch'),
    built = compile(exported, database(exported, 'branch'));
  const first = built.module.functions[0].blocks[0].terminator;
  assert.equal(first.trueTarget, exported.high.blocks[0].conditionalTargets.trueBlockId);
  for (const value of [-2147483648, -100, -1, 0, 1, 10, 2147483647])
    assert.equal(built.lifted(value), reference.branch(value));
  assert.equal(built.module.functions[0].blocks.flatMap((block) => block.phis).length, 1);
  assert.ok(built.receipt.lowerings.some((item) => item.reason.includes('fallthrough')));
});

test('Ghidra CFG import: actual loop preserves cyclic phis and boolean normalization', () => {
  const exported = fixture('loop'),
    built = compile(exported, database(exported, 'loop'));
  for (const value of [-100, -1, 0, 1, 2, 10, 100, 1000])
    assert.equal(built.lifted(value), reference.loop(value));
  assert.equal(built.module.functions[0].blocks.flatMap((block) => block.phis).length, 3);
  assert.deepEqual(built.report.functions[0].backedges, [{from: 'b1', to: 'b1'}]);
  assert.ok(built.receipt.lowerings.some((item) => item.reason.includes('boolean')));
});

test('Ghidra CFG import: broken live ordering, SSA and phi associations fail closed', () => {
  for (const mutate of [
    (value) => value.high.ops.reverse(),
    (value) => {
      value.high.ops[0].index = 99;
    },
    (value) => {
      value.high.varnodes[0].definitionOpId = null;
    },
    (value) => {
      value.high.ops.find((op) => op.opcode === 'MULTIEQUAL').phiInputs[0].predecessorIndex = 1;
    },
    (value) => {
      value.high.blocks[0].successors[0].targetPredecessorIndex = 9;
    },
    (value) => {
      value.high.blocks[0].conditionalTargets = null;
    },
  ]) {
    const exported = fixture('branch');
    mutate(exported);
    assert.throws(() => validateGhidraExport(exported));
  }
});

test('Ghidra CFG import: input/storage contracts, identity and review hashes are mandatory', () => {
  const exported = fixture('add'),
    db = database(exported);
  assert.throws(
    () => importGhidraFunction(exported, db, {...plan(exported), exportSha256: 'b'.repeat(64)}),
    {code: 'IMPORT_PLAN'},
  );
  const unresolved = structuredClone(db);
  unresolved.functions[0].abi.convention = 'unresolved';
  assert.throws(() => importGhidraFunction(exported, unresolved, plan(exported)), {
    code: 'IMPORT_ABI',
  });
  const wrongRegister = structuredClone(db);
  wrongRegister.functions[0].abi.parameters[0].location.name = 'edx';
  assert.throws(() => importGhidraFunction(exported, wrongRegister, plan(exported)), {
    code: 'IMPORT_PARAMETER',
  });
  const wrongReturn = structuredClone(db);
  wrongReturn.functions[0].abi.returnLocation.name = 'edx';
  assert.throws(() => importGhidraFunction(exported, wrongReturn, plan(exported)), {
    code: 'IMPORT_RETURN_STORAGE',
  });
  const wrongVersion = structuredClone(db);
  wrongVersion.binaries[0].programPath = '/different-build.exe';
  assert.throws(() => importGhidraFunction(exported, wrongVersion, plan(exported)), {
    code: 'IMPORT_BINARY',
  });
  assert.throws(
    () => importGhidraFunction(exported, db, {...plan(exported), sourceKind: 'reviewed-pcode'}),
    {code: 'IMPORT_ABI'},
  );
});

test('Ghidra CFG import: unsupported effects and unstable live state never produce partial code', () => {
  for (const opcode of ['LOAD', 'STORE', 'CALLIND', 'FLOAT_ADD', 'INDIRECT']) {
    const exported = fixture('add');
    exported.high.ops[0].opcode = opcode;
    assert.throws(() => importGhidraFunction(exported, database(exported), plan(exported)), {
      code: 'IMPORT_UNSUPPORTED',
    });
  }
  const hiddenWrite = fixture('add'),
    memory = hiddenWrite.addressSpaces.find((space) => space.isDefault);
  Object.assign(hiddenWrite.high.varnodes[0], {
    kind: 'memory',
    space: memory.name,
    spaceId: memory.id,
    register: null,
    offset: '0x140002000',
  });
  hiddenWrite.high.varnodes[0].flags.persistent = true;
  hiddenWrite.high.varnodes[0].flags.addressTied = true;
  assert.throws(() => importGhidraFunction(hiddenWrite, database(hiddenWrite), plan(hiddenWrite)), {
    code: 'IMPORT_MEMORY_EFFECT',
  });
  const exported = fixture('add');
  exported.state.after.modificationNumber = '123456789';
  assert.throws(() => importGhidraFunction(exported, database(exported), plan(exported)), {
    code: 'EXPORT_STATE',
  });
  const missingFile = fixture('add');
  delete missingFile.state.before.domainFile;
  delete missingFile.state.after.domainFile;
  assert.throws(() => validateGhidraExport(missingFile), {code: 'EXPORT_STATE'});
});

test('Ghidra CFG import: reviewed direct call binds native names to a real imported implementation', async (t) => {
  // This graph is deliberately authored synthetic CALL evidence, separate from the
  // three untouched decoder captures. It is not claimed to decode Aokana bytes.
  const exported = fixture('add');
  delete exported.raw;
  const syntheticHash = sha256('invented call graph to a source scalar helper');
  exported.binary = {
    ...exported.binary,
    programPath: '/synthetic-call-graph',
    executableSha256: syntheticHash,
  };
  exported.exporter = {name: 'SyntheticWireFixture', version: '1', ghidraVersion: 'synthetic'};
  exported.state.before.domainFile.programPath = exported.binary.programPath;
  exported.state.after.domainFile.programPath = exported.binary.programPath;
  exported.function.bodySha256 = syntheticHash;
  exported.function.bodyRanges[0].bytesSha256 = syntheticHash;
  const db = database(exported);
  const seed = JSON.parse(
    readFileSync(new URL('../tools/native-lift/mappings/aokana.json', import.meta.url), 'utf8'),
  );
  const realImplementation = seed.implementations.find(
    (implementation) => implementation.id === 'aokana.nativeVectorAngle',
  );
  db.implementations.push(realImplementation);
  db.functions.push({
    binarySha256: syntheticHash,
    rva: '0x2000',
    implementation: realImplementation.id,
    abi: {
      convention: 'win64',
      parameters: [
        {name: 'nativeX', type: 'i32', location: {kind: 'register', name: 'ecx'}},
        {name: 'nativeY', type: 'i32', location: {kind: 'register', name: 'edx'}},
      ],
      arguments: [
        {parameter: 'x', source: {kind: 'parameter', name: 'nativeX'}},
        {parameter: 'y', source: {kind: 'parameter', name: 'nativeY'}},
      ],
      returnLocation: {kind: 'register', name: 'eax'},
    },
    evidence,
  });
  const target = structuredClone(exported.high.varnodes.find((value) => value.id === 'v4'));
  const memory = exported.addressSpaces.find((space) => space.isDefault);
  Object.assign(target, {
    id: 'v5',
    spaceId: memory.id,
    space: memory.name,
    offset: '0x140002000',
    kind: 'memory',
    flags: {...target.flags, constant: false},
  });
  exported.high.varnodes.push(target);
  Object.assign(exported.high.ops[0], {opcode: 'CALL', inputs: ['v5', 'v1', 'v2']});
  const reviewed = plan(exported, {'b0:o0': {nativeY: 'v2', nativeX: 'v1'}});
  assert.throws(() => importGhidraFunction(exported, db, plan(exported)), {code: 'IMPORT_CALL'});
  await verifyDatabaseSources(db, root);
  const imported = importGhidraFunction(exported, db, reviewed);
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'vn-ghidra-import-')));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const generatedFile = path.join(directory, 'generated.mts');
  const emitted = emitCfgTypeScript(imported.module, db, {root, fromFile: generatedFile});
  assert.match(emitted.source, /import \{nativeVectorAngle as mapped_\d+\} from/);
  assert.ok(emitted.source.includes('src/engines/buriko/games/aokana/bp/opcodes/native-math.js'));
  await writeFile(generatedFile, emitted.source);
  const compiledDir = path.join(directory, 'compiled');
  const checked = spawnSync(
    process.execPath,
    [
      path.join(root, 'node_modules/typescript/bin/tsc'),
      '--ignoreConfig',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--strict',
      '--noUncheckedIndexedAccess',
      '--skipLibCheck',
      '--outDir',
      compiledDir,
      '--rootDir',
      '/',
      generatedFile,
    ],
    {cwd: directory, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024},
  );
  assert.equal(checked.status, 0, `${checked.stdout}\n${checked.stderr}`);
  // NodeNext emits project sources as ESM; mark the temporary output tree so its
  // .js modules keep the original package's module mode.
  await writeFile(path.join(compiledDir, 'package.json'), '{"type":"module"}\n');
  const module = await import(
    pathToFileURL(path.join(compiledDir, generatedFile.slice(1).replace(/\.mts$/u, '.mjs')))
  );
  assert.equal(module.lifted(0), 0x5a0000); // vector (0,5), straight upward
  assert.equal(module.lifted(5), 0x2d0000); // vector (5,5), 45 degrees
});

test('Ghidra CFG import: exact owner-load lifter routes to a forced implementation import', () => {
  const exported = fixture('add');
  const ram = exported.addressSpaces.find((space) => space.name === 'ram');
  exported.high.varnodes.push({
    spaceId: 48,
    space: 'const',
    offset: `0x${ram.id.toString(16)}`,
    size: 4,
    register: null,
    kind: 'constant',
    id: 'v5',
    ssaUniqueId: 1000,
    flags: {
      input: false,
      constant: true,
      addressTied: false,
      persistent: false,
      unaffected: false,
    },
    definitionOpId: null,
    typeHint: null,
    high: null,
  });
  Object.assign(exported.high.ops[1], {opcode: 'LOAD', inputs: ['v5', 'v0']});
  const db = database(exported);
  db.lifters = [
    {
      id: 'synthetic.owner-load',
      kind: 'owner-load-call',
      target: {
        binarySha256: exported.binary.executableSha256,
        rva: '0x1000',
        bodySha256: exported.function.bodySha256,
      },
      operation: {
        address: exported.high.ops[1].sequence.address,
        sequence: exported.high.ops[1].sequence.time,
        addressSpace: 'ram',
        offsetBytes: 5,
        widthBits: 32,
      },
      receiverParameter: 'nativeValue',
      implementation: 'synthetic.add',
      arguments: [
        {
          parameter: 'value',
          source: {kind: 'native-parameter', name: 'nativeValue'},
        },
      ],
      evidence,
    },
  ];
  const imported = importGhidraFunction(exported, db, plan(exported));
  assert.deepEqual(imported.receipt.lifters, [
    {
      id: 'synthetic.owner-load',
      kind: 'owner-load-call',
      matchedOpId: 'b0:o1',
      consumedOpIds: ['b0:o0', 'b0:o1'],
      implementation: 'synthetic.add',
      resultType: 'i32',
    },
  ]);
  assert.deepEqual(imported.module.functions[0].blocks[0].operations[0], {
    id: 'v3',
    opcode: 'CALL_IMPLEMENTATION',
    implementation: 'synthetic.add',
    arguments: {value: {ref: 'v1'}},
    source: {
      address: exported.high.ops[1].sequence.address,
      sequence: exported.high.ops[1].sequence.time,
      loweringIndex: 0,
    },
  });
  const emitted = emitCfgTypeScript(imported.module, db);
  assert.match(emitted.source, /import \{add as mapped_0\} from/);
  assert.match(emitted.source, /= mapped_0\(v0\);/);
  assert.doesNotMatch(emitted.source, /= generated_0\(v0\);/);
  assert.equal(emitted.report.functions[0].calls[0].route, 'direct-import');

  const wrongOffset = structuredClone(db);
  wrongOffset.lifters[0].operation.offsetBytes = 6;
  assert.throws(() => importGhidraFunction(exported, wrongOffset, plan(exported)), {
    code: 'IMPORT_LIFTER',
  });
  const wrongBody = structuredClone(db);
  wrongBody.lifters[0].target.bodySha256 = 'a'.repeat(64);
  assert.throws(() => importGhidraFunction(exported, wrongBody, plan(exported)), {
    code: 'IMPORT_LIFTER_BODY',
  });
});

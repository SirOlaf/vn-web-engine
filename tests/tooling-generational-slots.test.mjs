import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {
  analyzeGenerationalSlots,
  slotAnalysisReceipt,
} from '../tools/native-lift/generational-slots.mjs';
import {routeReviewedFunction} from '../tools/native-lift/reviewed-route.mjs';
import {emitCfgTypeScript} from '../tools/native-lift/cfg.mjs';
import {canonicalJson, sha256} from '../tools/native-lift/index.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

function fixture(name) {
  return JSON.parse(
    readFileSync(
      new URL(`../tools/ghidra-bridge/fixtures/synthetic-${name}.json`, import.meta.url),
      'utf8',
    ),
  );
}

function memoryFixture() {
  const exported = fixture('add');
  delete exported.raw;
  const flags = (input = false, constant = false) => ({
    input,
    constant,
    addressTied: false,
    persistent: false,
    unaffected: false,
  });
  const value = (id, overrides) => ({
    spaceId: 291,
    space: 'unique',
    offset: `0x${(0x1000 + Number(id.slice(1)) * 0x100).toString(16)}`,
    size: 4,
    register: null,
    kind: 'unique',
    id,
    ssaUniqueId: 1000 + Number(id.slice(1)),
    flags: flags(),
    definitionOpId: null,
    typeHint: null,
    high: null,
    ...overrides,
  });
  const constant = (id, offset, size = 8) =>
    value(id, {
      spaceId: 48,
      space: 'const',
      offset,
      size,
      kind: 'constant',
      flags: flags(false, true),
    });
  const varnodes = [
    value('v0', {
      spaceId: 548,
      space: 'register',
      offset: '0x8',
      size: 8,
      register: 'RCX',
      kind: 'register',
      flags: flags(true),
    }),
    constant('v1', '0x24'),
    value('v2', {
      spaceId: 548,
      space: 'register',
      offset: '0x0',
      size: 8,
      register: 'RAX',
      kind: 'register',
      definitionOpId: 'b0:o0',
    }),
    value('v3', {
      spaceId: 548,
      space: 'register',
      offset: '0x10',
      size: 8,
      register: 'RDX',
      kind: 'register',
      definitionOpId: 'b0:o1',
    }),
    constant('v4', '0x1b1'),
    value('v5', {
      spaceId: 548,
      space: 'register',
      offset: '0x0',
      register: 'EAX',
      kind: 'register',
      definitionOpId: 'b0:o2',
    }),
    constant('v6', '0x1', 4),
    value('v7', {
      spaceId: 548,
      space: 'register',
      offset: '0x0',
      register: 'EAX',
      kind: 'register',
      definitionOpId: 'b0:o3',
    }),
    constant('v8', '0x28'),
    value('v9', {
      spaceId: 548,
      space: 'register',
      offset: '0x0',
      size: 8,
      register: 'RAX',
      kind: 'register',
      definitionOpId: 'b0:o5',
    }),
    value('v10', {
      spaceId: 433,
      space: 'ram',
      offset: '0x140020000',
      kind: 'memory',
      flags: flags(true),
    }),
    constant('v11', '0x7', 4),
    value('v12', {
      spaceId: 433,
      space: 'ram',
      offset: '0x140020000',
      kind: 'memory',
      definitionOpId: 'b0:o8',
    }),
    constant('v13', '0x0'),
  ];
  const spec = [
    ['INT_ADD', 'v2', ['v0', 'v1']],
    ['COPY', 'v3', ['v2']],
    ['LOAD', 'v5', ['v4', 'v2']],
    ['INT_ADD', 'v7', ['v5', 'v6']],
    ['STORE', null, ['v4', 'v3', 'v7']],
    ['INT_ADD', 'v9', ['v0', 'v8']],
    ['STORE', null, ['v4', 'v9', 'v5']],
    ['STORE', null, ['v4', 'v2', 'v5']],
    ['COPY', 'v12', ['v11']],
    ['RETURN', null, ['v13', 'v7']],
  ];
  const ops = spec.map(([opcode, output, inputs], index) => ({
    id: `b0:o${index}`,
    blockId: 'b0',
    index,
    opcode,
    sequence: {
      address: index === spec.length - 1 ? '0x140001003' : '0x140001000',
      addressSpace: 'ram',
      time: index,
      order: index,
    },
    output,
    inputs,
  }));
  exported.high = {
    ...exported.high,
    entryBlockId: 'b0',
    blocks: [
      {
        id: 'b0',
        index: 0,
        start: '0x140001000',
        stop: '0x140001003',
        predecessors: [],
        successors: [],
        conditionalTargets: null,
        opIds: ops.map((op) => op.id),
      },
    ],
    ops,
    varnodes,
    inputVarnodeIds: ['v0', 'v10'],
    opCount: ops.length,
  };
  return exported;
}

function typedMemoryDatabase() {
  const source = {
    path: 'tools/native-lift/examples/ghidra/reference.mjs',
    sha256: 'c6faff0ab0fb8a1839dcfa28880e9af6d10f8062f5db667f0d45eb960ef950de',
  };
  const evidence = {state: 'synthetic', references: [], notes: ['Invented typed memory fixture.']};
  const record = {named: 'synthetic.Record'};
  return {
    schemaVersion: 1,
    kind: 'native-mapping-database',
    binaries: [
      {
        id: 'synthetic-memory',
        programPath: '/synthetic-memory.exe',
        executableSha256: '8836c9e6e5400f67833045a79179a374b03115396be643dcdb6bd48c5901010e',
        languageId: 'x86:LE:64:default',
        imageBase: '0x140000000',
      },
    ],
    types: [
      {
        id: 'synthetic.Record',
        kind: 'reference',
        import: {module: source.path, export: 'NativeRecord', source},
        nativeBits: 64,
        nullable: false,
        mutability: 'mutable',
      },
    ],
    implementations: [
      {
        id: 'synthetic.memory',
        module: source.path,
        export: 'loop',
        source,
        signature: {parameters: [{name: 'record', type: record}], returnType: 'i32'},
        evidence,
      },
    ],
    functions: [
      {
        binarySha256: '8836c9e6e5400f67833045a79179a374b03115396be643dcdb6bd48c5901010e',
        rva: '0x1000',
        implementation: 'synthetic.memory',
        abi: {
          convention: 'win64',
          parameters: [{name: 'record', type: record, location: {kind: 'register', name: 'rcx'}}],
          arguments: [{parameter: 'record', source: {kind: 'parameter', name: 'record'}}],
          returnLocation: {kind: 'register', name: 'eax'},
        },
        evidence,
      },
    ],
    variantFamilies: [],
    layouts: [
      {
        id: 'synthetic.record.layout',
        kind: 'struct',
        type: 'synthetic.Record',
        size: {bytes: 48, kind: 'minimum'},
        fields: [
          {name: 'globalValue', offsetBytes: 0, sizeBytes: 4, storage: 'inline', type: 'i32'},
          {name: 'framePosition', offsetBytes: 36, sizeBytes: 4, storage: 'inline', type: 'u32'},
          {
            name: 'specialFramePosition',
            offsetBytes: 40,
            sizeBytes: 4,
            storage: 'inline',
            type: 'u32',
          },
        ],
        evidence,
      },
    ],
    globals: [
      {
        binarySha256: '8836c9e6e5400f67833045a79179a374b03115396be643dcdb6bd48c5901010e',
        address: '0x140020000',
        name: 'globalRecord',
        type: record,
        implementation: {rootType: record, path: ['globalValue']},
        evidence,
      },
    ],
  };
}

test('typed slots retain parent generations and project fields and globals', () => {
  const ir = analyzeGenerationalSlots(memoryFixture(), typedMemoryDatabase());
  const derived24 = ir.slots.find((slot) => slot.id === ir.bindings.v2.slotId);
  const generation24 = derived24.generations.find(
    (generation) => generation.id === ir.bindings.v2.generationId,
  );
  assert.equal(derived24.kind, 'derived');
  assert.deepEqual(generation24.derivation.parent, {
    slotId: ir.bindings.v0.slotId,
    generationId: ir.bindings.v0.generationId,
  });
  assert.equal(generation24.derivation.offsetBytes, '0x24');
  assert.equal(generation24.semanticType, 'u32');
  assert.equal(generation24.derivation.mapping.steps.at(-1).name, 'framePosition');

  const global = ir.slots.find(
    (slot) => slot.address?.kind === 'program' && slot.address.address === '0x140020000',
  );
  assert.equal(global.mapping.root.kind, 'global');
  assert.deepEqual(global.mapping.root.implementation.path, ['globalValue']);
  assert.equal(global.mapping.steps.at(-1).name, 'globalValue');
  assert.equal(ir.unmappedGlobals.length, 0);
  assert.ok(ir.accesses.some((access) => access.mapping?.steps.at(-1)?.name === 'framePosition'));
});

test('PTRADD retains a generation-backed iterator index and array element stride', () => {
  const exported = memoryFixture();
  const baseInput = exported.high.varnodes.find((value) => value.id === 'v0');
  const constant = exported.high.varnodes.find((value) => value.id === 'v1');
  exported.high.varnodes.push(
    {
      ...structuredClone(baseInput),
      id: 'v14',
      offset: '0x10',
      size: 4,
      register: 'EDX',
      ssaUniqueId: 1014,
    },
    {
      ...structuredClone(constant),
      id: 'v15',
      offset: '0x4',
      size: 8,
      ssaUniqueId: 1015,
    },
  );
  exported.high.inputVarnodeIds.splice(1, 0, 'v14');
  const pointerAdd = exported.high.ops.find((op) => op.id === 'b0:o0');
  pointerAdd.opcode = 'PTRADD';
  pointerAdd.inputs = ['v0', 'v14', 'v15'];

  const database = typedMemoryDatabase();
  database.implementations[0].signature.parameters.push({name: 'index', type: 'i32'});
  database.functions[0].abi.parameters.push({
    name: 'index',
    type: 'i32',
    location: {kind: 'register', name: 'edx'},
  });
  database.functions[0].abi.arguments.push({
    parameter: 'index',
    source: {kind: 'parameter', name: 'index'},
  });
  database.layouts[0] = {
    id: 'synthetic.record-array.layout',
    kind: 'array',
    type: 'synthetic.Record',
    size: {bytes: 64, kind: 'exact'},
    elementType: 'u32',
    elementSizeBytes: 4,
    count: 16,
    evidence: database.layouts[0].evidence,
  };

  const ir = analyzeGenerationalSlots(exported, database);
  const generation = ir.slots
    .find((slot) => slot.id === ir.bindings.v2.slotId)
    .generations.find((candidate) => candidate.id === ir.bindings.v2.generationId);
  assert.equal(generation.derivation.kind, 'element-offset');
  assert.equal(generation.derivation.elementSizeBytes, 4);
  assert.equal(generation.derivation.offsetBytes, null);
  assert.deepEqual(generation.derivation.index, {
    kind: 'generation',
    value: {slotId: ir.bindings.v14.slotId, generationId: ir.bindings.v14.generationId},
  });
  assert.equal(generation.derivation.mapping.steps.at(-1).kind, 'element');
  assert.deepEqual(generation.derivation.mapping.steps.at(-1).index, {
    slotId: ir.bindings.v14.slotId,
    generationId: ir.bindings.v14.generationId,
  });
  assert.equal(
    ir.accesses.find((access) => access.opId === 'b0:o2').mapping.steps.at(-1).kind,
    'element',
  );
  assert.equal(
    ir.unresolvedAddresses.some((entry) => entry.varnodeId === 'v2'),
    false,
  );
});

test('generational slots allocate every write and canonicalize pointer aliases', () => {
  const ir = analyzeGenerationalSlots(memoryFixture());
  const byOffset = new Map(
    ir.slots
      .filter((slot) => slot.address?.kind === 'relative')
      .map((slot) => [slot.address.offsetBytes, slot]),
  );
  const field24 = byOffset.get('0x24');
  const field28 = byOffset.get('0x28');
  assert.ok(field24);
  assert.equal(field24.generations.filter((generation) => generation.kind === 'write').length, 2);
  assert.equal(field24.aliases.length, 2, 'RAX and RDX point to the same field slot');
  assert.equal(field28.generations.filter((generation) => generation.kind === 'write').length, 1);
  assert.notEqual(
    ir.bindings.v2.slotId,
    ir.bindings.v9.slotId,
    'rebinding RAX from +0x24 to +0x28 allocates another anonymous slot',
  );
  assert.equal(ir.bindings.v2.pointsTo, ir.bindings.v3.pointsTo);
  assert.notEqual(ir.bindings.v2.pointsTo, ir.bindings.v9.pointsTo);

  const eax = ir.slots.find((slot) => slot.storage === 'register:0x0:4');
  assert.deepEqual(
    eax.generations.map((generation) => generation.sourceOpId),
    ['b0:o2', 'b0:o3'],
  );
  for (const op of memoryFixture().high.ops.filter((candidate) => candidate.output !== null)) {
    const binding = ir.bindings[op.output];
    assert.ok(binding, `${op.id} output has a slot binding`);
    assert.equal(
      ir.slots
        .find((slot) => slot.id === binding.slotId)
        .generations.find((generation) => generation.id === binding.generationId).sourceOpId,
      op.id,
    );
  }
});

test('program-space globals use the same address slot and generation sequence', () => {
  const ir = analyzeGenerationalSlots(memoryFixture());
  const global = ir.slots.find(
    (slot) => slot.address?.kind === 'program' && slot.address.address === '0x140020000',
  );
  assert.ok(global);
  assert.equal(ir.bindings.v10.slotId, global.id);
  assert.equal(ir.bindings.v12.slotId, global.id);
  assert.deepEqual(
    global.generations.map((generation) => generation.kind),
    ['initial-memory', 'write'],
  );
  assert.equal(global.generations[1].sourceOpId, 'b0:o8');
});

test('loop phis merge only resettable inferred scalar generations', () => {
  const scalar = analyzeGenerationalSlots(fixture('loop'));
  assert.equal(scalar.controlFlow.entryBlockId, 'b0');
  assert.deepEqual(
    scalar.controlFlow.blocks
      .find((block) => block.id === 'b1')
      .predecessors.map((edge) => edge.blockId),
    ['b0', 'b1'],
  );
  assert.equal(scalar.merges.filter((merge) => merge.opId !== null).length, 3);
  assert.ok(scalar.merges.every((merge) => merge.safeResetAndRetype));

  const pointer = fixture('loop');
  delete pointer.raw;
  const block = pointer.high.blocks.find((candidate) => candidate.id === 'b2');
  const returnOp = pointer.high.ops.find((op) => op.id === 'b2:o1');
  returnOp.index = 2;
  returnOp.inputs[1] = 'v19';
  const load = {
    id: 'b2:o1-load',
    blockId: 'b2',
    index: 1,
    opcode: 'LOAD',
    sequence: {address: '0x14000100d', addressSpace: 'ram', time: 47, order: 1},
    output: 'v19',
    inputs: ['v20', 'v17'],
  };
  pointer.high.ops.splice(pointer.high.ops.indexOf(returnOp), 0, load);
  block.opIds = ['b2:o0', 'b2:o1-load', 'b2:o1'];
  pointer.high.varnodes.push(
    {
      ...pointer.high.varnodes.find((value) => value.id === 'v17'),
      id: 'v19',
      ssaUniqueId: 10019,
      definitionOpId: 'b2:o1-load',
    },
    {
      ...pointer.high.varnodes.find((value) => value.id === 'v18'),
      id: 'v20',
      ssaUniqueId: 10020,
      offset: '0x1b1',
    },
  );
  pointer.high.opCount += 1;
  const pointerIr = analyzeGenerationalSlots(pointer);
  const pointerPhi = pointerIr.merges.find((merge) => merge.id === 'phi:b2:o0');
  assert.equal(pointerPhi.safeResetAndRetype, false);
  assert.equal(pointerPhi.result, null);
});

test('slot CLI writes a new file and returns only a compact receipt', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'generational-slots-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const output = path.join(directory, 'loop.slots.json');
  const args = [
    'tools/native-lift/generational-slots-cli.mjs',
    'analyze',
    'tools/ghidra-bridge/fixtures/synthetic-loop.json',
    output,
  ];
  const first = spawnSync(process.execPath, args, {cwd: root, encoding: 'utf8'});
  assert.equal(first.status, 0, first.stderr);
  assert.ok(first.stdout.length < 1000);
  const receipt = JSON.parse(first.stdout);
  const written = JSON.parse(await readFile(output, 'utf8'));
  assert.deepEqual(receipt, slotAnalysisReceipt(written));

  const before = await readFile(output, 'utf8');
  const second = spawnSync(process.execPath, args, {cwd: root, encoding: 'utf8'});
  assert.equal(second.status, 1);
  assert.equal(await readFile(output, 'utf8'), before);
});

test('reviewed route keeps full slot CFG evidence and directly imports an existing implementation', () => {
  const exported = fixture('loop');
  const database = JSON.parse(
    readFileSync(
      new URL('../tools/native-lift/examples/ghidra/loop.database.json', import.meta.url),
      'utf8',
    ),
  );
  const slots = analyzeGenerationalSlots(exported, database);
  const plan = {
    schema: 'reviewed-generational-route/v1',
    exportSha256: sha256(canonicalJson(exported)),
    slotIrSha256: slotAnalysisReceipt(slots).outputSha256,
    sourceKind: 'synthetic',
    reviewReference: 'tests/tooling-generational-slots.test.mjs synthetic route',
    assumptions: ['Invented decoded instructions only.'],
  };
  const routed = routeReviewedFunction(exported, database, plan);
  assert.equal(routed.slots.controlFlow.blocks.length, 3);
  assert.equal(routed.module.functions[0].blocks.length, 1);
  assert.equal(routed.module.functions[0].blocks[0].operations[0].opcode, 'CALL_IMPLEMENTATION');
  const emitted = emitCfgTypeScript(routed.module, database);
  assert.match(emitted.source, /import \{loop as mapped_0\}/u);
  assert.equal(emitted.report.functions[0].calls[0].route, 'direct-import');
  assert.throws(
    () => routeReviewedFunction(exported, database, {...plan, slotIrSha256: '0'.repeat(64)}),
    {code: 'ROUTE_SLOTS'},
  );
});

test('reviewed route CLI writes the CFG to a new file and keeps stdout compact', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'reviewed-route-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const exported = fixture('loop');
  const database = JSON.parse(
    readFileSync(
      new URL('../tools/native-lift/examples/ghidra/loop.database.json', import.meta.url),
      'utf8',
    ),
  );
  const slots = analyzeGenerationalSlots(exported, database);
  const plan = path.join(directory, 'plan.json');
  const output = path.join(directory, 'route.cfg.json');
  await writeFile(
    plan,
    JSON.stringify({
      schema: 'reviewed-generational-route/v1',
      exportSha256: sha256(canonicalJson(exported)),
      slotIrSha256: slotAnalysisReceipt(slots).outputSha256,
      sourceKind: 'synthetic',
      reviewReference: 'tests/tooling-generational-slots.test.mjs CLI route',
      assumptions: ['Invented decoded instructions only.'],
    }),
  );
  const args = [
    'tools/native-lift/reviewed-route-cli.mjs',
    'import',
    'tools/ghidra-bridge/fixtures/synthetic-loop.json',
    'tools/native-lift/examples/ghidra/loop.database.json',
    plan,
    output,
  ];
  const first = spawnSync(process.execPath, args, {cwd: root, encoding: 'utf8'});
  assert.equal(first.status, 0, first.stderr);
  assert.ok(first.stdout.length < 2000);
  assert.equal(JSON.parse(await readFile(output, 'utf8')).kind, 'reviewed-cfg-module');
  const second = spawnSync(process.execPath, args, {cwd: root, encoding: 'utf8'});
  assert.equal(second.status, 1);
});

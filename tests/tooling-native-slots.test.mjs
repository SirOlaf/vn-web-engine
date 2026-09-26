/** Safety: ordinary deterministic parser/accounting tests. Source strings are never executed.
 * Only temporary text/JSON files, synthetic pointer metadata, and the checked-in inventory are read.
 * No game, media, native probe, allocation/lifetime reproducer, or runtime factory is launched. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {
  attachReferences,
  auditObservations,
  auditPartialAggregation,
  discoverFactories,
  extractInventory,
  inspectSources,
  parseSources,
  refreshObservations,
  renderCounts,
  sha256,
  validateManifest,
} from '../tools/native-audit/slots.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imageBase = '0x140000000';
const binarySha256 = 'a'.repeat(64);
const config = {
  definitionRoots: ['src'],
  referenceRoots: ['src', 'tests'],
  testRoots: ['tests'],
  pathAliases: [{from: 'dist', to: 'src'}],
  slotType: 'SlotDefinition',
  aggregateSymbols: [{file: 'src/registry.ts', export: 'NativeBank'}],
};
const syntheticFiles = {
  'src/inventory.ts': 'export const INVENTORY = {0x80: {0x00: 0x140000010, 0x02: 0x140000030}};',
  'src/factory.ts': `
    // The auditor must not run even this top-level statement.
    throw new Error('Do not execute source');
    export function createServices(): SlotDefinition[] {
      return [
        {primary: 0x80, secondary: 0, nativeAddress: 0x140000010, name: 'first', execute: () => {throw new Error('Do not execute handlers');}},
        {primary: 0x80, secondary: 2, nativeAddress: 0x140000030, name: 'second', execute: () => 0},
      ];
    }
  `,
  'src/registry.ts': 'export class NativeBank {}',
  'tests/focused.test.mjs':
    "import {createServices as alias} from '../dist/factory.js';\n// A lexical import is not a test acceptance receipt.",
};

function observationFor(files = syntheticFiles) {
  const parsed = parseSources(files);
  const inventory = extractInventory(parsed.get('src/inventory.ts'), 'INVENTORY', imageBase);
  const factories = discoverFactories(parsed, files, config, imageBase);
  const aggregateCandidates = attachReferences(factories, parsed, files, config);
  return {
    inventory,
    inventorySha256: sha256(files['src/inventory.ts']),
    factories,
    aggregateCandidates,
  };
}

function fixture(files = syntheticFiles) {
  const observation = observationFor(files);
  const manifest = {
    schemaVersion: 1,
    title: 'synthetic',
    binary: {sha256: binarySha256, imageBase},
    universe: {
      path: 'src/inventory.ts',
      export: 'INVENTORY',
      sha256: observation.inventorySha256,
      expectedCount: 2,
      canonicalSha256: observation.inventory.canonicalSha256,
      banks: observation.inventory.banks,
    },
    owners: ['runtime', 'storage'],
    ownershipEvidence: [
      {id: 'synthetic-policy', sha256: 'b'.repeat(64), expectedCounts: {runtime: 2, storage: 0}},
    ],
    ownershipPolicy: [
      {bank: '80', owner: 'runtime', slots: ['00', '02'], evidence: 'synthetic-policy'},
    ],
    discovery: config,
    factories: [],
    aggregateCandidates: [],
    slots: observation.inventory.rows.map((row) => ({
      ...row,
      ownership: {state: 'assigned', owner: 'runtime', evidence: 'synthetic-policy'},
      nativeEvidence: {state: 'table-attested-body-unreviewed', bank: '80'},
      source: {state: 'not-observed', factories: []},
      focusedTests: {state: 'unreviewed', factoryReferences: []},
      aggregateIntegration: {state: 'no-aggregate-observed'},
    })),
  };
  return {manifest: refreshObservations(manifest, observation), observation};
}

function completePlan(manifest) {
  return {
    schemaVersion: 1,
    binarySha256,
    entries: manifest.slots.map((row) => ({
      slot: row.id,
      rva: row.rva,
      owner: row.ownership.owner,
      factory: row.source.factories[0],
    })),
  };
}

test('inventory preserves holes and reconstructs all 256 little-endian pointers', () => {
  const {inventory} = observationFor();
  assert.deepEqual(inventory.rows, [
    {id: '80:00', rva: '0x10'},
    {id: '80:02', rva: '0x30'},
  ]);
  const bytes = Buffer.alloc(2048);
  bytes.writeBigUInt64LE(0x140000010n, 0);
  bytes.writeBigUInt64LE(0x140000030n, 16);
  assert.equal(inventory.banks[0].tableSha256, sha256(bytes));
  const source = parseSources({'bad.ts': 'const INVENTORY = {0x80: {0: 1, 0x00: 2}};'}).get(
    'bad.ts',
  );
  assert.throws(() => extractInventory(source, 'INVENTORY', '0x0'), /literal|Invalid/);
});

test('factory metadata projection handles direct objects, tuple maps, and structurally proven local helpers', () => {
  const files = {
    'src/metadata.ts': `
    export function make(): readonly SlotDefinition[] {
      const slots: SlotDefinition[] = [];
      const add = (secondary: number, nativeAddress: number, name: string, execute: unknown) => {
        slots.push({primary: 0x80, secondary, nativeAddress, name, execute});
      };
      add(0x01, 0x140000010, 'helper', () => 0);
      const unary = (secondary: number, nativeAddress: number) => ({primary: 0x80, secondary, nativeAddress, name: 'unary', execute: () => 0});
      const tuples = [[0x02, 0x140000020]] as const;
      return [...slots, ...tuples.map(([secondary, nativeAddress]) => ({primary: 0x80, secondary, nativeAddress, name: 'map', execute: () => 0})), unary(0x03, 0x140000030)];
    }
    // add(0xff, 0x140001000, 'comment', () => 0);
    const ignoredString = "nativeAddress: 0x140001000";
    function unexported(): SlotDefinition[] { return [{primary: 0x80, secondary: 0xfe, nativeAddress: 0x140001000, execute: () => 0}]; }
  `,
  };
  const factories = discoverFactories(parseSources(files), files, config, imageBase);
  assert.equal(factories.length, 1);
  assert.deepEqual(
    factories[0].entries.map((entry) => entry.slot),
    ['80:01', '80:02', '80:03'],
  );
  assert.deepEqual(factories[0].unresolved, []);
});

test('dynamic and nested factory syntax stays unresolved without executing code', () => {
  const files = {
    'src/unknown.ts': `
    export function dynamic(flag: boolean): SlotDefinition[] {
      if (flag) return [{primary: 0x80, secondary: 0, nativeAddress: 0x140000010, execute: () => 0}];
      return loadAtRuntime();
    }
    export function nested(): SlotDefinition[] {
      const unrelated = () => [{primary: 0x80, secondary: 2, nativeAddress: 0x140000030, execute: () => 0}];
      return [];
    }
  `,
  };
  const factories = discoverFactories(parseSources(files), files, config, imageBase);
  assert.deepEqual(
    factories.map((factory) => factory.entries.length),
    [0, 0],
  );
  assert.equal(factories[0].unresolved.length, 2);
  assert.deepEqual(factories[1].unresolved, []);
});

test('unknown spread leaves adjacent literal slots observable and records the gap', () => {
  const files = {
    'src/partial.ts': `
      export function partial(): SlotDefinition[] {
        return [
          {primary: 0x80, secondary: 0, nativeAddress: 0x140000010, execute: () => 0},
          ...loadAtRuntime(),
          {primary: 0x80, secondary: 2, nativeAddress: 0x140000030, execute: () => 0},
        ];
      }
    `,
  };
  const factories = discoverFactories(parseSources(files), files, config, imageBase);
  assert.deepEqual(
    factories[0].entries.map((entry) => entry.slot),
    ['80:00', '80:02'],
  );
  assert.equal(factories[0].unresolved.length, 1);
});

test('simple slot ordering preserves direct metadata beside a dynamic factory spread', () => {
  const files = {
    'src/sorted.ts': `
      export function sorted(): SlotDefinition[] {
        const definitions: SlotDefinition[] = [];
        const add = (secondary: number, nativeAddress: number, execute: unknown) => {
          definitions.push({primary: 0x80, secondary, nativeAddress, execute});
        };
        add(0x02, 0x140000030, () => 0);
        return [...definitions, ...otherFactory()].sort((left, right) => left.secondary - right.secondary);
      }
    `,
  };
  const [factory] = discoverFactories(parseSources(files), files, config, imageBase);
  assert.deepEqual(factory.entries.map((entry) => entry.slot), ['80:02']);
  assert.deepEqual(factory.unresolved.map((entry) => entry.reason), [
    'Unresolved returned slot metadata',
  ]);
});

test('exported static arrays and single slots retain provider kinds separate from factories', () => {
  const files = {
    ...syntheticFiles,
    'src/static.ts': `
      export const one: SlotDefinition = {primary: 0x80, secondary: 0, nativeAddress: 0x140000010, name: 'one', execute: () => 0};
      export const many: readonly SlotDefinition[] = [[2, 0x140000030]].map(([secondary, nativeAddress]) => ({primary: 0x80, secondary: secondary!, nativeAddress: nativeAddress!, name: 'two', execute: () => 0}));
      const hidden: SlotDefinition[] = [];
    `,
    'tests/static.test.mjs': "import {one, many} from '../dist/static.js';",
  };
  const {manifest, observation} = fixture(files);
  const providers = observation.factories.filter((provider) => provider.file === 'src/static.ts');
  assert.deepEqual(
    providers.map((provider) => [provider.export, provider.kind, provider.entries[0].slot]),
    [
      ['many', 'constant-array', '80:02'],
      ['one', 'constant-slot', '80:00'],
    ],
  );
  const report = auditObservations(manifest, observation);
  assert.equal(report.counts.factories, 1);
  assert.equal(report.counts.staticProviders, 2);
  assert.equal(report.counts.providers, 3);
  assert.equal(report.counts.testOnlyFactories, 1);
  assert.equal(report.counts.testOnlyProviders, 3);
  assert.equal(report.counts.aggregateVerified, 0);
});

test('references distinguish test aliases, source namespaces, re-exports and constructor candidates', () => {
  const files = {
    ...syntheticFiles,
    'src/barrel.ts': "export {createServices as published} from './factory.js';",
    'src/assembly.ts':
      "import * as bank from './registry.js'; import * as services from './factory.js'; new bank.NativeBank(services.createServices());",
    'src/alias-assembly.ts': "import {NativeBank as Bank} from './registry.js'; new Bank([]);",
    'src/comments.ts': "// import {createServices} from './factory.js';\n// new NativeBank([]);",
  };
  const {manifest, observation} = fixture(files);
  const references = observation.factories[0].references;
  assert.deepEqual(
    references.map((reference) => [reference.file, reference.kind]),
    [
      ['src/assembly.ts', 'source'],
      ['src/barrel.ts', 'source'],
      ['tests/focused.test.mjs', 'test'],
    ],
  );
  assert.equal(observation.aggregateCandidates.length, 2);
  const audit = auditObservations(manifest, observation);
  assert.equal(audit.counts.testOnlyFactories, 0);
  assert.equal(audit.counts.aggregateVerified, 0);
  assert.equal(audit.complete, false);
});

test('an unused test import is an observation, never coverage or acceptance', () => {
  const {manifest, observation} = fixture();
  const report = auditObservations(manifest, observation);
  assert.equal(report.ok, true);
  assert.equal(report.counts.factoryTestReferences, 2);
  assert.equal(report.counts.testOnlyFactories, 1);
  assert.equal(report.counts.focusedTestsAccepted, 0);
  assert.equal(report.counts.nativeBodiesReviewed, 0);
  assert.equal(report.counts.aggregateVerified, 0);
  assert.equal(report.aggregate.state, 'no-aggregate-supplied');
  assert.deepEqual(report.aggregate.missing, ['80:00', '80:02']);
});

test('source and test-reference drift invalidate observations even when slot metadata is unchanged', () => {
  const {manifest} = fixture();
  const changedSource = observationFor({
    ...syntheticFiles,
    'src/factory.ts': syntheticFiles['src/factory.ts'].replace('second', 'revised'),
  });
  assert.equal(
    auditObservations(manifest, changedSource).errors.some(
      (error) => error.code === 'factory-source-or-reference-drift',
    ),
    true,
  );
  const changedTest = observationFor({
    ...syntheticFiles,
    'tests/focused.test.mjs': '// No factory import remains.\n',
  });
  const audit = auditObservations(manifest, changedTest);
  assert.equal(audit.ok, false);
  assert.equal(
    audit.errors.some((error) => error.code === 'slot-observation-drift'),
    true,
  );
  assert.equal(audit.counts.factoryTestReferences, 0);
  assert.equal(audit.counts.testOnlyFactories, 0);
});

test('inventory address drift fails the exact universe and native table hash checks', () => {
  const {manifest} = fixture();
  const changed = observationFor({
    ...syntheticFiles,
    'src/inventory.ts': syntheticFiles['src/inventory.ts'].replace('0x140000030', '0x140000040'),
  });
  const audit = auditObservations(manifest, changed);
  assert.equal(audit.ok, false);
  assert.deepEqual(
    audit.errors.map((error) => error.code),
    ['inventory-source-drift', 'slot-universe-mismatch', 'native-table-hash-mismatch'],
  );
});

test('missing, duplicated, mislabeled ownership and fabricated acceptance are rejected', () => {
  const {manifest} = fixture();
  for (const mutate of [
    (value) => value.slots.pop(),
    (value) => {
      value.slots[1] = structuredClone(value.slots[0]);
    },
    (value) => {
      value.slots[0].ownership.owner = 'storage';
    },
    (value) => {
      value.ownershipPolicy[0].slots.pop();
    },
    (value) => {
      value.slots[0].rva = 16;
    },
    (value) => {
      value.slots[0].focusedTests.state = 'passed';
    },
    (value) => {
      value.slots[0].aggregateIntegration.state = 'complete';
    },
  ]) {
    const changed = structuredClone(manifest);
    mutate(changed);
    assert.throws(() => validateManifest(changed));
  }
});

test('partial plans report duplicates, wrong owners, wrong addresses, unknown slots and factories independently', () => {
  const {manifest} = fixture();
  const plan = completePlan(manifest);
  plan.entries[1].owner = 'storage';
  plan.entries[1].rva = '0x40';
  plan.entries[1].factory = 'wrong#factory';
  plan.entries.push({...plan.entries[0]});
  plan.entries.push({...plan.entries[0], slot: '81:ff'});
  const result = auditPartialAggregation(manifest, plan);
  assert.equal(result.state, 'invalid-partial-plan');
  assert.deepEqual(result.missing, ['80:02']);
  assert.equal(result.duplicates.length, 1);
  assert.equal(result.wrongOwners.length, 1);
  assert.equal(result.wrongAddresses.length, 1);
  assert.equal(result.wrongFactories.length, 1);
  assert.deepEqual(result.unknownSlots, ['81:ff']);
  assert.throws(
    () => auditPartialAggregation(manifest, {...plan, binarySha256: 'c'.repeat(64)}),
    /matching binarySha256/,
  );
});

test('empty and complete plans cannot be confused with complete runtime integration', () => {
  const {manifest} = fixture();
  assert.equal(auditPartialAggregation(manifest).state, 'no-aggregate-supplied');
  assert.equal(
    auditPartialAggregation(manifest, {schemaVersion: 1, binarySha256, entries: []}).state,
    'partial-plan',
  );
  const result = auditPartialAggregation(manifest, completePlan(manifest));
  assert.equal(result.state, 'all-slots-declared-unverified');
  assert.equal(result.complete, false);
  assert.deepEqual(result.missing, []);
});

test('duplicate source declarations are reported without calling factories', () => {
  const files = {...syntheticFiles, 'src/duplicate.ts': syntheticFiles['src/factory.ts']};
  const {manifest, observation} = fixture(files);
  const report = auditObservations(manifest, observation);
  assert.deepEqual(
    report.duplicateDeclarations.map((entry) => entry.slot),
    ['80:00', '80:02'],
  );
  assert.equal(report.counts.sourceDeclarations, 2);
  assert.equal(report.counts.factories, 2);
  assert.equal(report.complete, false);
});

test('CLI produces receipts, refuses the integration gate, refreshes observations and renders deterministic docs', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'native-slot-tooling-'));
  try {
    const {manifest} = fixture();
    for (const [file, text] of Object.entries(syntheticFiles)) {
      await mkdir(path.dirname(path.join(temporary, file)), {recursive: true});
      await writeFile(path.join(temporary, file), text);
    }
    const manifestFile = path.join(temporary, 'slots.json'),
      receipt = path.join(temporary, 'receipt.json');
    await writeFile(manifestFile, JSON.stringify(manifest));
    const run = (...args) =>
      spawnSync(
        process.execPath,
        [path.join(root, 'tools/native-audit/slots.mjs'), ...args, '--root', temporary],
        {encoding: 'utf8', timeout: 15000},
      );
    let result = run('audit', manifestFile, '--out', receipt);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      JSON.parse(await readFile(receipt, 'utf8')).status,
      'observations-consistent-integration-unverified',
    );
    const originalManifest = await readFile(manifestFile, 'utf8');
    result = run('audit', manifestFile, '--out', manifestFile);
    assert.equal(result.status, 1);
    assert.equal(await readFile(manifestFile, 'utf8'), originalManifest);
    result = run('audit', manifestFile, '--out', receipt);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /EEXIST/);
    result = run('docs', manifestFile, '--out', manifestFile);
    assert.equal(result.status, 1);
    result = run('refresh', manifestFile, '--out', path.join(temporary, 'src/factory.ts'));
    assert.equal(result.status, 1);
    assert.equal(
      await readFile(path.join(temporary, 'src/factory.ts'), 'utf8'),
      syntheticFiles['src/factory.ts'],
    );
    result = run('audit', manifestFile, '--require-integrated');
    assert.equal(result.status, 2, result.stderr);
    await writeFile(
      path.join(temporary, 'src/factory.ts'),
      syntheticFiles['src/factory.ts'] + '\n// changed source\n',
    );
    result = run('audit', manifestFile);
    assert.equal(result.status, 1, result.stderr);
    result = run('refresh', manifestFile, '--out', manifestFile);
    assert.equal(result.status, 0, result.stderr);
    result = run('docs', manifestFile);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Accepted focused tests/);
    const current = observationFor({
      ...syntheticFiles,
      'src/factory.ts': syntheticFiles['src/factory.ts'] + '\n// changed source\n',
    });
    assert.equal(
      result.stdout,
      renderCounts(auditObservations(JSON.parse(await readFile(manifestFile, 'utf8')), current)),
    );
    const docs = path.join(temporary, 'counts.md');
    await writeFile(
      docs,
      'Keep this preface.\n<!-- BEGIN GENERATED NATIVE SLOT COUNTS -->\nold\n<!-- END GENERATED NATIVE SLOT COUNTS -->\nKeep this ending.\n',
    );
    result = run('docs', manifestFile, '--out', docs);
    assert.equal(result.status, 0, result.stderr);
    assert.match(await readFile(docs, 'utf8'), /^Keep this preface\.[\s\S]+Keep this ending\.\n$/);
    const unmarked = path.join(temporary, 'unmarked.md');
    await writeFile(unmarked, 'Unrelated document.');
    result = run('docs', manifestFile, '--out', unmarked);
    assert.equal(result.status, 1);
    assert.equal(await readFile(unmarked, 'utf8'), 'Unrelated document.');
    await symlink(manifestFile, path.join(temporary, 'manifest-alias.json'));
    result = run('audit', manifestFile, '--out', path.join(temporary, 'manifest-alias.json'));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /symlinked output/);
  } finally {
    await rm(temporary, {recursive: true, force: true});
  }
});

test('symlinked source entries and configured roots are rejected instead of silently omitted', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'native-slot-paths-'));
  try {
    const {manifest} = fixture();
    for (const [file, text] of Object.entries(syntheticFiles)) {
      await mkdir(path.dirname(path.join(temporary, file)), {recursive: true});
      await writeFile(path.join(temporary, file), text);
    }
    const linkedEntry = path.join(temporary, 'src/hidden.ts');
    await symlink(path.join(temporary, 'src/factory.ts'), linkedEntry);
    await assert.rejects(inspectSources(manifest, temporary), /Symlinked source entry/);
    await rm(linkedEntry);
    await symlink(path.join(temporary, 'src'), path.join(temporary, 'linked-src'));
    const changed = structuredClone(manifest);
    changed.discovery.definitionRoots = ['linked-src'];
    await assert.rejects(inspectSources(changed, temporary), /Symlinked source root/);
  } finally {
    await rm(temporary, {recursive: true, force: true});
  }
});

const localAokanaManifest = path.join(root, 'tools/native-audit/workspace/aokana-slots.json');
test(
  'local Aokana manifest proves all 840 slots against every native table hash and explicit owner partition',
  {skip: !existsSync(localAokanaManifest)},
  async () => {
    const manifest = validateManifest(JSON.parse(await readFile(localAokanaManifest, 'utf8')));
    const source = await readFile(path.join(root, manifest.universe.path), 'utf8');
    const inventory = extractInventory(
      parseSources({[manifest.universe.path]: source}).get(manifest.universe.path),
      manifest.universe.export,
      manifest.binary.imageBase,
    );
    assert.equal(
      manifest.binary.sha256,
      'f585e28f79923b8aa487d8690165e45ce3377c7e1b8381d3b75c659c7e933d7a',
    );
    assert.equal(inventory.rows.length, 840);
    assert.equal(inventory.banks.length, 11);
    assert.equal(inventory.canonicalSha256, manifest.universe.canonicalSha256);
    assert.equal(sha256(source), manifest.universe.sha256);
    assert.deepEqual(
      inventory.rows,
      manifest.slots.map(({id, rva}) => ({id, rva})),
    );
    for (const bank of inventory.banks)
      assert.equal(
        bank.tableSha256,
        manifest.universe.banks.find((expected) => expected.id === bank.id).tableSha256,
      );
    assert.deepEqual(
      Object.fromEntries(
        manifest.owners.map((owner) => [
          owner,
          manifest.slots.filter((row) => row.ownership.owner === owner).length,
        ]),
      ),
      {runtime: 208, storage: 321, opcodes: 311},
    );
  },
);

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {
  captureBoundary,
  checkBoundary,
  checkRecordedBuildOutputs,
  parseTestSummary,
  runBoundary,
  sha256,
  verifyBuildOutputs,
} from '../tools/native-audit/boundary.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'vn-boundary-')));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(path.join(root, 'tests'));
  await mkdir(path.join(root, 'tools'));
  for (const file of ['package.json', 'package-lock.json', 'tsconfig.json'])
    await writeFile(path.join(root, file), '{}\n');
  await writeFile(path.join(root, 'tools/helper.mjs'), 'export const value = 7;\n');
  await writeFile(path.join(root, 'tools/types.mts'), 'export interface Value { value: number }\n');
  await writeFile(path.join(root, 'tools/types.cts'), 'export interface Count { count: number }\n');
  await writeFile(
    path.join(root, 'tests/ordinary.test.mjs'),
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {value} from '../tools/helper.mjs';\ntest('ordinary integer equality', () => assert.equal(value, 7));\n",
  );
  const review = {
    schema: 'native-validation-boundary/v1',
    id: 'synthetic-tooling-review',
    safetyClass: 'ordinary-deterministic',
    reviewedBy: 'Tooling fixture',
    reviewNotes:
      'A deterministic integer equality; no native code, assets, media, or lifetime probes.',
    build: 'none',
    timeoutMs: 10000,
    sourceRoots: ['tools'],
    extraInputs: [],
    tests: [{path: 'tests/ordinary.test.mjs', expectedTests: 1}],
  };
  return {root, review};
}

test('capture pins reviewed inputs and a changed or newly added source prevents execution', async (t) => {
  const {root, review} = await fixture(t);
  const manifest = await captureBoundary(review, root);
  assert.equal(manifest.inputs.length, 7);
  assert.equal((await checkBoundary(manifest, root)).length, 7);
  let invoked = false;
  const neverRun = async () => {
    invoked = true;
    throw new Error('must not run');
  };
  await writeFile(path.join(root, 'tools/helper.mjs'), 'export const value = 8;\n');
  const changed = await runBoundary(manifest, {root, run: neverRun});
  assert.equal(changed.accepted, false);
  assert.match(changed.failure, /changed input: tools\/helper.mjs/u);
  assert.equal(invoked, false);
  await writeFile(path.join(root, 'tools/helper.mjs'), 'export const value = 7;\n');
  await writeFile(path.join(root, 'tools/types.mts'), 'export interface Value { value: bigint }\n');
  await assert.rejects(checkBoundary(manifest, root), /changed input: tools\/types\.mts/u);
  await writeFile(path.join(root, 'tools/types.mts'), 'export interface Value { value: number }\n');
  await writeFile(path.join(root, 'tools/new.mjs'), 'export const newValue = 9;\n');
  await assert.rejects(checkBoundary(manifest, root), /unreviewed input/u);
});

test('capture refuses broad selection, duplicate tests, unreviewed classes, and directory or symlink inputs', async (t) => {
  const {root, review} = await fixture(t);
  for (const file of [
    'tests/*.test.mjs',
    'tests',
    '../ordinary.test.mjs',
    '/tmp/ordinary.test.mjs',
  ]) {
    await assert.rejects(
      captureBoundary({...review, tests: [{path: file, expectedTests: 1}]}, root),
    );
  }
  await assert.rejects(captureBoundary({...review, tests: []}, root), /1\.\.20/u);
  await assert.rejects(
    captureBoundary({...review, tests: [...review.tests, ...review.tests]}, root),
    /Duplicate test/u,
  );
  await assert.rejects(
    captureBoundary({...review, safetyClass: 'native-probe'}, root),
    /ordinary deterministic/u,
  );
  await symlink(path.join(root, 'tools/helper.mjs'), path.join(root, 'tools/link.mjs'));
  await assert.rejects(captureBoundary(review, root), /Symlinked inputs/u);
  await writeFile(path.join(root, 'review.json'), JSON.stringify(review));
  await symlink(path.join(root, 'tools'), path.join(root, 'output-alias'));
  const cli = fileURLToPath(new URL('../tools/native-audit/boundary.mjs', import.meta.url));
  const child = spawnSync(
    process.execPath,
    [cli, 'capture', 'review.json', 'output-alias/manifest.json'],
    {cwd: root, encoding: 'utf8'},
  );
  assert.equal(child.status, 1);
  assert.match(child.stderr, /outside the pinned source roots/u);
});

test('the real runner executes only the reviewed synthetic file and records its exact count', async (t) => {
  const {root, review} = await fixture(t);
  const manifest = await captureBoundary(review, root);
  const manifestHash = sha256(JSON.stringify(manifest));
  const receipt = await runBoundary(manifest, {root, manifestHash});
  assert.equal(receipt.accepted, true, receipt.failure);
  assert.equal(receipt.manifestSha256, manifestHash);
  assert.equal(receipt.tests.length, 1);
  assert.equal(receipt.tests[0].pass, 1);
  assert.deepEqual(receipt.commands[0].args, [
    '--test',
    '--test-reporter=tap',
    '--test-concurrency=1',
    'tests/ordinary.test.mjs',
  ]);
  assert.equal(receipt.commands.length, 1);
});

test('a successful process with the wrong test count cannot produce an accepted receipt', async (t) => {
  const {root, review} = await fixture(t);
  const manifest = await captureBoundary(
    {...review, tests: [{...review.tests[0], expectedTests: 2}]},
    root,
  );
  const receipt = await runBoundary(manifest, {root});
  assert.equal(receipt.accepted, false);
  assert.match(receipt.failure, /Test count mismatch/u);
});

test('missing summaries, skipped tests, and input changes during a test all reject the receipt', async (t) => {
  const {root, review} = await fixture(t);
  const manifest = await captureBoundary(review, root);
  const ok = '# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
  assert.deepEqual(parseTestSummary(ok), {
    tests: 1,
    pass: 1,
    fail: 0,
    cancelled: 0,
    skipped: 0,
    todo: 0,
  });
  assert.throws(() => parseTestSummary('# tests 1\n'), /summary/u);
  assert.throws(() => parseTestSummary(`${ok}# tests 1\n`), /ambiguous/u);
  const result = (stdout) => ({code: 0, signal: null, reason: null, stdout, stderr: ''});
  const skipped = await runBoundary(manifest, {
    root,
    run: async () => result(ok.replace('# skipped 0', '# skipped 1')),
  });
  assert.equal(skipped.accepted, false);
  const changed = await runBoundary(manifest, {
    root,
    run: async () => {
      await writeFile(path.join(root, 'tools/helper.mjs'), 'export const value = 10;\n');
      return result(ok);
    },
  });
  assert.equal(changed.accepted, false);
  assert.match(changed.failure, /changed input/u);
});

test('tests using build output require a source-pinned TypeScript build', async (t) => {
  const {root, review} = await fixture(t);
  await writeFile(
    path.join(root, 'tests/ordinary.test.mjs'),
    'const syntheticSource = "import \\\'../dist/helper.js\\\';";\n',
  );
  await captureBoundary(review, root);
  await writeFile(path.join(root, 'tests/ordinary.test.mjs'), "import '../dist/helper.js';\n");
  await assert.rejects(captureBoundary(review, root), /fresh build/u);
  await assert.rejects(captureBoundary({...review, build: 'typescript'}, root), /entire src tree/u);
  await mkdir(path.join(root, 'src'));
  await mkdir(path.join(root, 'dist'));
  await writeFile(path.join(root, 'src/helper.ts'), 'export const value: number = 7;\n');
  await writeFile(path.join(root, 'dist/helper.js'), 'export const value = 7;\n');
  await writeFile(
    path.join(root, 'tsconfig.json'),
    JSON.stringify({compilerOptions: {rootDir: 'src', outDir: 'dist'}, include: ['src/**/*.ts']}),
  );
  const built = await captureBoundary(
    {...review, build: 'typescript', sourceRoots: ['tools', 'src']},
    root,
  );
  await assert.rejects(checkBoundary({...built, build: 'none'}, root), /fresh build/u);
  await assert.rejects(verifyBuildOutputs(built, root, ''), /emitted-output inventory/u);
  const emitted = `TSFILE: ${path.join(root, 'dist/helper.js')}\n`;
  const verified = await verifyBuildOutputs(built, root, emitted);
  assert.equal(verified.length, 1);
  assert.equal(verified[0].path, 'dist/helper.js');
  await checkRecordedBuildOutputs(root, verified);
  await writeFile(path.join(root, 'dist/helper.js'), 'export const value = 8;\n');
  await assert.rejects(checkRecordedBuildOutputs(root, verified), /changed since validation/u);
  await writeFile(path.join(root, 'dist/orphan.js'), 'export const stale = true;\n');
  await assert.rejects(verifyBuildOutputs(built, root, emitted), /orphaned/u);
  const original = await readFile(path.join(root, 'tests/ordinary.test.mjs'), 'utf8');
  assert.equal(original, "import '../dist/helper.js';\n");
});

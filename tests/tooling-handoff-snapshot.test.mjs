import test from 'node:test';
import assert from 'node:assert/strict';
import {sha256} from '../tools/native-audit/boundary.mjs';
import {parseDirtyStatus, validateReceipt} from '../tools/native-audit/snapshot.mjs';

test('handoff status keeps tracked changes, untracked paths, and rename pairs distinct', () => {
  const status = parseDirtyStatus(' M src/a.ts\0?? docs/new note.md\0R  src/new.ts\0src/old.ts\0');
  assert.equal(status.tracked, 2);
  assert.equal(status.untracked, 1);
  assert.deepEqual(status.files[2], {status: 'R ', path: 'src/new.ts', previousPath: 'src/old.ts'});
  assert.equal(status.files[1].path, 'docs/new note.md');
  assert.deepEqual(parseDirtyStatus(''), {tracked: 0, untracked: 0, files: []});
});

test('handoff accepts only a receipt tied to the exact manifest, inputs, commands, and test counts', () => {
  const manifest = {
    id: 'synthetic',
    safetyClass: 'ordinary-deterministic',
    build: 'none',
    inputs: [{path: 'tools/a.mjs', sha256: sha256('synthetic source')}],
    tests: [{path: 'tests/a.test.mjs', expectedTests: 2}],
  };
  const bytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  const receipt = {
    schema: 'native-validation-receipt/v1',
    accepted: true,
    failure: null,
    safetyClass: manifest.safetyClass,
    boundaryId: 'synthetic',
    manifestSha256: sha256(bytes),
    inputsSha256: sha256(JSON.stringify(manifest.inputs)),
    finished: '2026-09-19T00:00:00.000Z',
    tests: [
      {
        path: 'tests/a.test.mjs',
        expectedTests: 2,
        tests: 2,
        pass: 2,
        fail: 0,
        cancelled: 0,
        skipped: 0,
        todo: 0,
      },
    ],
    commands: [
      {
        args: ['--test', '--test-reporter=tap', '--test-concurrency=1', 'tests/a.test.mjs'],
        exitCode: 0,
        signal: null,
        reason: null,
      },
    ],
  };
  assert.deepEqual(validateReceipt(receipt, manifest, bytes), {
    id: 'synthetic',
    finished: receipt.finished,
    testsPassed: 2,
  });
  for (const patch of [
    {accepted: false},
    {manifestSha256: sha256('different manifest')},
    {inputsSha256: sha256('different inputs')},
    {tests: [{...receipt.tests[0], pass: 1}]},
    {commands: [{...receipt.commands[0], args: ['--test']}]},
    {commands: [{...receipt.commands[0], exitCode: 1}]},
    {safetyClass: 'unreviewed'},
  ])
    assert.throws(() => validateReceipt({...receipt, ...patch}, manifest, bytes));
});

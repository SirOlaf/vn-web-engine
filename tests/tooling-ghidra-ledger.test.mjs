import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {link, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {
  LEDGER_SCHEMA,
  SNAPSHOT_SCHEMA,
  SAVED_READ_METHOD,
  verifyLedger,
} from '../tools/native-audit/ledger.mjs';

// Ordinary synthetic metadata only: these bytes are invented and never executed.
const hash = (value) => createHash('sha256').update(value).digest('hex');
const fixedTime = '2026-09-19T12:00:00.000Z';
const clone = (value) => structuredClone(value);
const cli = fileURLToPath(new URL('../tools/native-audit/ledger.mjs', import.meta.url));

function fixture() {
  const identity = {
    programPath: '/synthetic-ledger.bin',
    executableSha256: hash('synthetic executable identity; never a game'),
    languageId: 'x86:LE:64:default',
    imageBase: '0xffff000000000000',
  };
  const body = {
    entryAddress: '0xffff000000001000',
    name: 'Synthetic::TwoRangeFunction',
    bodyRanges: [
      {
        start: '0xffff000000001000',
        end: '0xffff000000001003',
        byteLength: 4,
        bytesSha256: hash(Uint8Array.of(1, 2, 3, 4)),
      },
      {
        start: '0xffff000000001020',
        end: '0xffff000000001021',
        byteLength: 2,
        bytesSha256: hash(Uint8Array.of(5, 6)),
      },
    ],
    bodyByteLength: 6,
    bodySha256: hash(Uint8Array.of(1, 2, 3, 4, 5, 6)),
  };
  const domainFile = {
    programPath: identity.programPath,
    fileId: 'synthetic-file-id',
    exists: true,
    lastModifiedMs: '1790000000000',
    version: -1,
  };
  const state = {
    changed: false,
    transactionOpen: false,
    modificationNumber: '9007199254740993',
    domainFile,
  };
  const readback = [
    {address: body.entryAddress, lookup: 'FunctionManager.getFunctionAt', function: clone(body)},
  ];
  return {
    ledger: {
      schema: LEDGER_SCHEMA,
      identity: clone(identity),
      functions: [{address: body.entryAddress, ...clone(body)}],
    },
    snapshot: {
      schema: SNAPSHOT_SCHEMA,
      capturedAt: fixedTime,
      exporter: {name: 'NativeLedgerExport', version: 1},
      identity: clone(identity),
      errors: [],
      stateBefore: clone(state),
      readback: clone(readback),
      savedReadback: {
        method: SAVED_READ_METHOD,
        separateInstance: true,
        changeable: false,
        changed: false,
        sourceFile: clone(domainFile),
        identity: clone(identity),
        readback: clone(readback),
      },
      stateAfter: clone(state),
    },
  };
}

function rejected(ledger, snapshot, code) {
  const receipt = verifyLedger(ledger, snapshot, {verifiedAt: fixedTime});
  assert.equal(receipt.status, 'rejected');
  assert.ok(
    receipt.findings.some((finding) => finding.code === code),
    JSON.stringify(receipt.findings),
  );
}

test('verifies exact disjoint bodies and independent persisted readback without losing 64-bit addresses', () => {
  const {ledger, snapshot} = fixture();
  const receipt = verifyLedger(ledger, snapshot, {verifiedAt: fixedTime});
  assert.equal(receipt.status, 'verified');
  assert.deepEqual(receipt.summary, {
    expectedFunctions: 1,
    matchedLiveFunctions: 1,
    matchedSavedFunctions: 1,
    findings: 0,
  });
  assert.equal(receipt.scope, 'offline-snapshot-at-capture-time');
});

test('rejects a containing function, even when the requested byte lies inside its body', () => {
  const {ledger, snapshot} = fixture();
  ledger.functions[0].address = '0xffff000000001001';
  snapshot.readback[0].address = ledger.functions[0].address;
  snapshot.savedReadback.readback[0].address = ledger.functions[0].address;
  rejected(ledger, snapshot, 'not-exact-entry');
  const other = fixture();
  other.snapshot.readback[0].lookup = 'FunctionManager.getFunctionContaining';
  rejected(other.ledger, other.snapshot, 'invalid-evidence');
});

test('binds both observations to the executable hash, explicit program, language and base', () => {
  for (const observation of ['identity', 'savedReadback']) {
    for (const [key, value] of Object.entries({
      programPath: '/other.exe',
      executableSha256: 'a'.repeat(64),
      languageId: 'x86:LE:32:default',
      imageBase: '0x400000',
    })) {
      const {ledger, snapshot} = fixture();
      const target =
        observation === 'identity' ? snapshot.identity : snapshot.savedReadback.identity;
      target[key] = value;
      rejected(
        ledger,
        snapshot,
        observation === 'identity' ? 'identity-mismatch' : 'saved-identity-mismatch',
      );
    }
  }
});

test('rejects byte, range and fully qualified name drift independently in live and saved bodies', () => {
  for (const source of ['live', 'saved']) {
    for (const change of [
      (body) => {
        body.name = 'OtherNamespace::TwoRangeFunction';
      },
      (body) => {
        body.bodySha256 = 'b'.repeat(64);
      },
      (body) => {
        body.bodyRanges[1].bytesSha256 = 'c'.repeat(64);
      },
      (body) => {
        body.bodyRanges[1].start = '0xffff000000001030';
        body.bodyRanges[1].end = '0xffff000000001031';
      },
      (body) => {
        body.bodyRanges.pop();
        body.bodyByteLength = 4;
        body.bodySha256 = body.bodyRanges[0].bytesSha256;
      },
    ]) {
      const {ledger, snapshot} = fixture();
      change((source === 'live' ? snapshot.readback : snapshot.savedReadback.readback)[0].function);
      assert.equal(verifyLedger(ledger, snapshot).status, 'rejected');
    }
  }
});

test('rejects duplicate, missing and unexpected direct readbacks', () => {
  for (const source of ['live', 'saved']) {
    for (const condition of ['duplicate', 'missing', 'unexpected']) {
      const {ledger, snapshot} = fixture();
      const readback = source === 'live' ? snapshot.readback : snapshot.savedReadback.readback;
      if (condition === 'duplicate') readback.push(clone(readback[0]));
      if (condition === 'missing') readback.pop();
      if (condition === 'unexpected') readback[0].address = '0xffff000000002000';
      rejected(
        ledger,
        snapshot,
        {
          duplicate: 'ambiguous-readback',
          missing: 'missing-readback',
          unexpected: 'unexpected-readback',
        }[condition],
      );
    }
  }
  const {ledger, snapshot} = fixture();
  ledger.functions.push(clone(ledger.functions[0]));
  rejected(ledger, snapshot, 'duplicate-address');
});

test('requires complete save evidence; old prose and a clean flag cannot stand in for persisted readback', () => {
  for (const change of [
    (s) => {
      delete s.savedReadback;
    },
    (s) => {
      s.savedReadback = {saved: true, note: 'A prior agent saved the program.'};
    },
    (s) => {
      s.savedReadback.separateInstance = false;
    },
    (s) => {
      s.savedReadback.changeable = true;
    },
    (s) => {
      s.savedReadback.changed = true;
    },
    (s) => {
      s.savedReadback.method = 'DomainFile.getDomainObject';
    },
    (s) => {
      delete s.stateBefore.changed;
    },
    (s) => {
      s.stateAfter.changed = true;
    },
    (s) => {
      s.stateBefore.transactionOpen = true;
    },
    (s) => {
      s.stateAfter.transactionOpen = true;
    },
    (s) => {
      delete s.stateAfter.domainFile.fileId;
    },
    (s) => {
      s.stateBefore.domainFile.exists = false;
    },
  ]) {
    const {ledger, snapshot} = fixture();
    change(snapshot);
    rejected(ledger, snapshot, 'invalid-evidence');
  }
});

test('detects edits, saves and saved-file substitution during the capture', () => {
  for (const [change, code] of [
    [
      (s) => {
        s.stateAfter.modificationNumber = '9007199254740994';
      },
      'program-changed-during-capture',
    ],
    [
      (s) => {
        s.stateAfter.domainFile.lastModifiedMs = '1790000000001';
      },
      'saved-file-changed-during-capture',
    ],
    [
      (s) => {
        s.savedReadback.sourceFile.fileId = 'another-file-id';
      },
      'saved-source-mismatch',
    ],
  ]) {
    const {ledger, snapshot} = fixture();
    change(snapshot);
    rejected(ledger, snapshot, code);
  }
});

test('validates complete range accounting and explicit snapshot provenance', () => {
  for (const change of [
    (l, s) => {
      l.functions[0].bodyRanges.reverse();
    },
    (l, s) => {
      l.functions[0].bodyRanges[1].byteLength = 3;
    },
    (l, s) => {
      l.functions[0].bodyByteLength = 8;
    },
    (l, s) => {
      l.functions[0].bodySha256 = null;
    },
    (l, s) => {
      l.functions[0].entryAddress = 0x1400de050;
    },
    (l, s) => {
      s.errors.push('A range could not be read.');
    },
    (l, s) => {
      delete s.capturedAt;
    },
    (l, s) => {
      delete s.exporter;
    },
    (l, s) => {
      s.readback[0].error = 'No function starts at the exact requested address';
    },
  ]) {
    const {ledger, snapshot} = fixture();
    change(ledger, snapshot);
    assert.equal(verifyLedger(ledger, snapshot).status, 'rejected');
  }
});

test('CLI emits receipts with exact input hashes and returns success, rejection and input-error status', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ghidra-ledger-test-'));
  try {
    const {ledger, snapshot} = fixture();
    const ledgerPath = join(directory, 'ledger.json'),
      snapshotPath = join(directory, 'snapshot.json'),
      receiptPath = join(directory, 'receipt.json');
    await writeFile(ledgerPath, JSON.stringify(ledger));
    await writeFile(snapshotPath, JSON.stringify(snapshot));
    const run = (outputArgs = []) =>
      spawnSync(
        process.execPath,
        [cli, 'verify', '--ledger', ledgerPath, '--snapshot', snapshotPath, ...outputArgs],
        {encoding: 'utf8'},
      );
    const verified = run(['--receipt', receiptPath]);
    assert.equal(verified.status, 0, verified.stderr);
    const receipt = JSON.parse(verified.stdout);
    assert.equal(receipt.inputs.snapshot.sha256, hash(await readFile(snapshotPath)));
    assert.deepEqual(JSON.parse(await readFile(receiptPath, 'utf8')), receipt);
    const aliasPath = join(directory, 'input-alias.json');
    await link(snapshotPath, aliasPath);
    assert.equal(run(['--receipt', aliasPath]).status, 2);
    assert.deepEqual(JSON.parse(await readFile(snapshotPath, 'utf8')), snapshot);
    assert.equal(run(['--receipt', receiptPath]).status, 2);
    snapshot.stateAfter.changed = true;
    await writeFile(snapshotPath, JSON.stringify(snapshot));
    assert.equal(run().status, 1);
    await writeFile(snapshotPath, 'not json');
    const inputError = run();
    assert.equal(inputError.status, 2);
    assert.equal(JSON.parse(inputError.stdout).status, 'error');
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('CLI extracts exactly one marked Ghidra snapshot and refuses ambiguous logs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ghidra-ledger-capture-test-'));
  try {
    const {snapshot} = fixture(),
      capturePath = join(directory, 'capture.txt'),
      outputPath = join(directory, 'snapshot.json');
    const line = `NativeLedgerExport.java> NATIVE_LEDGER_SNAPSHOT_JSON=${JSON.stringify(snapshot)}\n`;
    const run = () =>
      spawnSync(
        process.execPath,
        [cli, 'extract', '--capture', capturePath, '--output', outputPath],
        {encoding: 'utf8'},
      );
    await writeFile(capturePath, `Running...\n${line}Finished!\n`);
    assert.equal(run().status, 0);
    assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')), snapshot);
    await writeFile(capturePath, line + line);
    assert.equal(run().status, 2);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

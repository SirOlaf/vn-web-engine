#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const LEDGER_SCHEMA = 'native-address-ledger/v1';
export const SNAPSHOT_SCHEMA = 'ghidra-ledger-snapshot/v1';
export const RECEIPT_SCHEMA = 'native-address-ledger-receipt/v1';
export const SAVED_READ_METHOD = 'DomainFile.getImmutableDomainObject(DEFAULT_VERSION)';

const hashPattern = /^[0-9a-f]{64}$/;
const addressPattern = /^0x(?:0|[1-9a-f][0-9a-f]*)$/;
const decimalPattern = /^(?:0|[1-9][0-9]*)$/;
const identityKeys = ['programPath', 'executableSha256', 'languageId', 'imageBase'];
const fileKeys = ['programPath', 'fileId', 'exists', 'lastModifiedMs', 'version'];
const functionKeys = ['entryAddress', 'name', 'bodyByteLength', 'bodySha256'];
const rangeKeys = ['start', 'end', 'byteLength', 'bytesSha256'];
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.length > 0 && value.trim() === value;
const isDecimal = (value) => typeof value === 'string' && decimalPattern.test(value);

export function isCanonicalAddress(value) {
  return (
    typeof value === 'string' && addressPattern.test(value) && BigInt(value) <= 0xffffffffffffffffn
  );
}

/** Verify supplied observations only; this function does not contact or mutate Ghidra. */
export function verifyLedger(ledger, snapshot, {verifiedAt = new Date().toISOString()} = {}) {
  const findings = [];
  const fail = (code, path, message) => findings.push({code, path, message});
  const requireValue = (valid, path, message) => {
    if (!valid) fail('invalid-evidence', path, message);
    return valid;
  };
  const object = (value, path) => requireValue(isObject(value), path, 'Expected an object.');
  const equalFields = (expected, actual, keys, path, code) => {
    for (const key of keys) {
      if (actual?.[key] !== expected?.[key])
        fail(
          code,
          `${path}.${key}`,
          `Expected ${JSON.stringify(expected?.[key])}; observed ${JSON.stringify(actual?.[key])}.`,
        );
    }
  };
  const identity = (value, path) => {
    if (!object(value, path)) return;
    requireValue(
      isText(value.programPath) &&
        value.programPath.startsWith('/') &&
        !value.programPath.endsWith('/'),
      `${path}.programPath`,
      'An explicit absolute Ghidra project program path is required.',
    );
    requireValue(
      typeof value.executableSha256 === 'string' && hashPattern.test(value.executableSha256),
      `${path}.executableSha256`,
      'A lowercase SHA-256 executable identity is required.',
    );
    requireValue(
      isText(value.languageId),
      `${path}.languageId`,
      'An explicit Ghidra language ID is required.',
    );
    requireValue(
      isCanonicalAddress(value.imageBase),
      `${path}.imageBase`,
      'Expected a canonical unsigned 64-bit hexadecimal address.',
    );
  };
  const body = (value, path, address) => {
    if (!object(value, path)) return;
    requireValue(
      isCanonicalAddress(value.entryAddress),
      `${path}.entryAddress`,
      'An exact canonical entry address is required.',
    );
    if (value.entryAddress !== address)
      fail(
        'not-exact-entry',
        `${path}.entryAddress`,
        'The requested address must equal the function entry; a containing function is not evidence.',
      );
    requireValue(
      isText(value.name),
      `${path}.name`,
      'A nonempty fully qualified function name is required.',
    );
    requireValue(
      Number.isSafeInteger(value.bodyByteLength) && value.bodyByteLength > 0,
      `${path}.bodyByteLength`,
      'A positive safe-integer full-body byte length is required.',
    );
    requireValue(
      typeof value.bodySha256 === 'string' && hashPattern.test(value.bodySha256),
      `${path}.bodySha256`,
      'A SHA-256 of all body bytes in range order is required.',
    );
    if (
      !requireValue(
        Array.isArray(value.bodyRanges) && value.bodyRanges.length > 0,
        `${path}.bodyRanges`,
        'All inclusive body ranges are required.',
      )
    )
      return;
    let previousEnd = null;
    let total = 0n;
    let containsEntry = false;
    for (const [index, range] of value.bodyRanges.entries()) {
      const rangePath = `${path}.bodyRanges[${index}]`;
      if (!object(range, rangePath)) continue;
      const startValid = requireValue(
        isCanonicalAddress(range.start),
        `${rangePath}.start`,
        'Expected a canonical address.',
      );
      const endValid = requireValue(
        isCanonicalAddress(range.end),
        `${rangePath}.end`,
        'Expected a canonical address.',
      );
      requireValue(
        Number.isSafeInteger(range.byteLength) && range.byteLength > 0,
        `${rangePath}.byteLength`,
        'A positive safe-integer range length is required.',
      );
      requireValue(
        typeof range.bytesSha256 === 'string' && hashPattern.test(range.bytesSha256),
        `${rangePath}.bytesSha256`,
        'A SHA-256 of this complete range is required.',
      );
      if (!startValid || !endValid) continue;
      const start = BigInt(range.start),
        end = BigInt(range.end);
      requireValue(end >= start, rangePath, 'Inclusive range end must not precede its start.');
      requireValue(
        previousEnd === null || start > previousEnd + 1n,
        rangePath,
        'Ranges must be ordered, disjoint, and maximally merged.',
      );
      requireValue(
        Number.isSafeInteger(range.byteLength) && BigInt(range.byteLength) === end - start + 1n,
        `${rangePath}.byteLength`,
        'Byte length must equal end - start + 1.',
      );
      if (
        isCanonicalAddress(value.entryAddress) &&
        BigInt(value.entryAddress) >= start &&
        BigInt(value.entryAddress) <= end
      )
        containsEntry = true;
      total += end - start + 1n;
      previousEnd = end;
    }
    requireValue(
      containsEntry,
      `${path}.bodyRanges`,
      'The full body must contain its exact entry address.',
    );
    requireValue(
      Number.isSafeInteger(value.bodyByteLength) && BigInt(value.bodyByteLength) === total,
      `${path}.bodyByteLength`,
      'Full-body length must equal the sum of all ranges.',
    );
    if (value.bodyRanges.length === 1 && value.bodySha256 !== value.bodyRanges[0]?.bytesSha256)
      fail(
        'inconsistent-body-hash',
        `${path}.bodySha256`,
        'A single-range body hash must equal its range hash.',
      );
  };
  const file = (value, path) => {
    if (!object(value, path)) return;
    requireValue(
      value.programPath === ledger?.identity?.programPath,
      `${path}.programPath`,
      'The saved source must be the explicitly attributed program.',
    );
    requireValue(
      isText(value.fileId),
      `${path}.fileId`,
      'A persistent Ghidra domain-file ID is required.',
    );
    requireValue(
      value.exists === true,
      `${path}.exists`,
      'The domain file must exist in the project.',
    );
    requireValue(
      isDecimal(value.lastModifiedMs) && BigInt(value.lastModifiedMs) > 0n,
      `${path}.lastModifiedMs`,
      'A positive persisted-file modification time is required.',
    );
    requireValue(
      Number.isSafeInteger(value.version) && value.version >= -1,
      `${path}.version`,
      'A domain-file version is required (-1 means unversioned).',
    );
  };
  const state = (value, path) => {
    if (!object(value, path)) return;
    requireValue(
      value.changed === false,
      `${path}.changed`,
      'The live program must explicitly report no unsaved changes.',
    );
    requireValue(
      value.transactionOpen === false,
      `${path}.transactionOpen`,
      'No transaction may be open during readback.',
    );
    requireValue(
      isDecimal(value.modificationNumber),
      `${path}.modificationNumber`,
      'A decimal-string program modification counter is required.',
    );
    file(value.domainFile, `${path}.domainFile`);
  };

  const expected = new Map();
  if (object(ledger, 'ledger')) {
    requireValue(ledger.schema === LEDGER_SCHEMA, 'ledger.schema', `Expected ${LEDGER_SCHEMA}.`);
    identity(ledger.identity, 'ledger.identity');
    if (
      requireValue(
        Array.isArray(ledger.functions) && ledger.functions.length > 0,
        'ledger.functions',
        'A nonempty exact-address expectation list is required.',
      )
    ) {
      for (const [index, entry] of ledger.functions.entries()) {
        const path = `ledger.functions[${index}]`;
        if (!object(entry, path)) continue;
        requireValue(
          isCanonicalAddress(entry.address),
          `${path}.address`,
          'A canonical explicit lookup address is required.',
        );
        if (expected.has(entry.address))
          fail(
            'duplicate-address',
            `${path}.address`,
            'The ledger contains this address more than once.',
          );
        expected.set(entry.address, entry);
        body(entry, path, entry.address);
      }
    }
  }

  let matchedLive = 0,
    matchedSaved = 0;
  const observations = (values, path) => {
    if (!requireValue(Array.isArray(values), path, 'A direct-address readback array is required.'))
      return 0;
    const seen = new Set();
    let matched = 0;
    for (const [index, entry] of values.entries()) {
      const entryPath = `${path}[${index}]`,
        before = findings.length;
      if (!object(entry, entryPath)) continue;
      requireValue(
        isCanonicalAddress(entry.address),
        `${entryPath}.address`,
        'A canonical explicit lookup address is required.',
      );
      if (seen.has(entry.address))
        fail(
          'ambiguous-readback',
          `${entryPath}.address`,
          'More than one readback exists for this requested address.',
        );
      seen.add(entry.address);
      if (!expected.has(entry.address))
        fail(
          'unexpected-readback',
          `${entryPath}.address`,
          'This address was not requested by the ledger.',
        );
      requireValue(
        entry.lookup === 'FunctionManager.getFunctionAt',
        `${entryPath}.lookup`,
        'Only a fresh exact-address getFunctionAt readback is accepted.',
      );
      if (entry.error !== undefined)
        fail('readback-error', `${entryPath}.error`, String(entry.error));
      body(entry.function, `${entryPath}.function`, entry.address);
      const wanted = expected.get(entry.address);
      if (wanted && isObject(entry.function)) {
        equalFields(
          wanted,
          entry.function,
          functionKeys,
          `${entryPath}.function`,
          'function-mismatch',
        );
        const wantedRanges = wanted.bodyRanges,
          actualRanges = entry.function.bodyRanges;
        if (Array.isArray(wantedRanges) && Array.isArray(actualRanges)) {
          if (wantedRanges.length !== actualRanges.length)
            fail(
              'body-range-mismatch',
              `${entryPath}.function.bodyRanges`,
              'The number of body ranges differs.',
            );
          for (const [i, wantedRange] of wantedRanges.entries())
            equalFields(
              wantedRange,
              actualRanges[i],
              rangeKeys,
              `${entryPath}.function.bodyRanges[${i}]`,
              'body-range-mismatch',
            );
        }
      }
      if (findings.length === before) matched++;
    }
    for (const address of expected.keys())
      if (!seen.has(address))
        fail('missing-readback', path, `No exact-address readback for ${address}.`);
    return matched;
  };

  if (object(snapshot, 'snapshot')) {
    requireValue(
      snapshot.schema === SNAPSHOT_SCHEMA,
      'snapshot.schema',
      `Expected ${SNAPSHOT_SCHEMA}.`,
    );
    requireValue(
      typeof snapshot.capturedAt === 'string' &&
        /^\d{4}-\d\d-\d\dT/.test(snapshot.capturedAt) &&
        Number.isFinite(Date.parse(snapshot.capturedAt)),
      'snapshot.capturedAt',
      'A capture timestamp is required.',
    );
    requireValue(
      snapshot.exporter?.name === 'NativeLedgerExport' && snapshot.exporter?.version === 1,
      'snapshot.exporter',
      'Expected NativeLedgerExport version 1 provenance.',
    );
    requireValue(
      Array.isArray(snapshot.errors) && snapshot.errors.length === 0,
      'snapshot.errors',
      'The export must explicitly report zero errors.',
    );
    identity(snapshot.identity, 'snapshot.identity');
    equalFields(
      ledger?.identity,
      snapshot.identity,
      identityKeys,
      'snapshot.identity',
      'identity-mismatch',
    );
    state(snapshot.stateBefore, 'snapshot.stateBefore');
    state(snapshot.stateAfter, 'snapshot.stateAfter');
    equalFields(
      snapshot.stateBefore,
      snapshot.stateAfter,
      ['modificationNumber'],
      'snapshot.stateAfter',
      'program-changed-during-capture',
    );
    equalFields(
      snapshot.stateBefore?.domainFile,
      snapshot.stateAfter?.domainFile,
      fileKeys,
      'snapshot.stateAfter.domainFile',
      'saved-file-changed-during-capture',
    );
    matchedLive = observations(snapshot.readback, 'snapshot.readback');
    const saved = snapshot.savedReadback;
    if (object(saved, 'snapshot.savedReadback')) {
      requireValue(
        saved.method === SAVED_READ_METHOD,
        'snapshot.savedReadback.method',
        'A separate immutable read of the saved database is required; save prose or a dirty flag alone is insufficient.',
      );
      requireValue(
        saved.separateInstance === true && saved.changeable === false && saved.changed === false,
        'snapshot.savedReadback',
        'The persisted readback must use a separate unchanged immutable program instance.',
      );
      identity(saved.identity, 'snapshot.savedReadback.identity');
      equalFields(
        ledger?.identity,
        saved.identity,
        identityKeys,
        'snapshot.savedReadback.identity',
        'saved-identity-mismatch',
      );
      file(saved.sourceFile, 'snapshot.savedReadback.sourceFile');
      equalFields(
        snapshot.stateBefore?.domainFile,
        saved.sourceFile,
        fileKeys,
        'snapshot.savedReadback.sourceFile',
        'saved-source-mismatch',
      );
      matchedSaved = observations(saved.readback, 'snapshot.savedReadback.readback');
    }
  }

  return {
    schema: RECEIPT_SCHEMA,
    status: findings.length === 0 ? 'verified' : 'rejected',
    verifiedAt,
    scope: 'offline-snapshot-at-capture-time',
    capturedAt: snapshot?.capturedAt ?? null,
    identity: ledger?.identity ?? null,
    summary: {
      expectedFunctions: expected.size,
      matchedLiveFunctions: matchedLive,
      matchedSavedFunctions: matchedSaved,
      findings: findings.length,
    },
    findings,
  };
}

const usage = `Usage: node tools/native-audit/ledger.mjs verify --ledger FILE --snapshot FILE [--receipt FILE]
       node tools/native-audit/ledger.mjs extract --capture FILE [--output FILE]

verify prints a JSON receipt; exits 0 verified, 1 rejected, 2 input/usage error.
extract accepts exactly one NATIVE_LEDGER_SNAPSHOT_JSON= line in a saved Ghidra log.
Neither command connects to, changes, or saves Ghidra.`;

async function main(args) {
  if (args.length === 0 || args.includes('--help')) {
    console.log(usage);
    return args.length ? 0 : 2;
  }
  const command = args.shift(),
    options = {};
  const allowed =
    command === 'verify'
      ? ['--ledger', '--snapshot', '--receipt']
      : command === 'extract'
        ? ['--capture', '--output']
        : [];
  try {
    while (args.length) {
      const flag = args.shift(),
        value = args.shift();
      if (!allowed.includes(flag) || !value || value.startsWith('--') || options[flag])
        throw new Error(`Unknown, missing, or repeated option: ${flag}`);
      options[flag] = resolve(value);
    }
    if (command === 'extract') {
      if (!options['--capture']) throw new Error('--capture is required.');
      if (options['--output'] === options['--capture'])
        throw new Error('Output must not overwrite the capture input.');
      const capture = await readFile(options['--capture'], 'utf8');
      const lines = capture
        .split(/\r?\n/)
        .filter((line) => line.includes('NATIVE_LEDGER_SNAPSHOT_JSON='));
      if (lines.length !== 1)
        throw new Error(`Expected one snapshot marker; found ${lines.length}.`);
      const snapshot = JSON.parse(
        lines[0].slice(
          lines[0].indexOf('NATIVE_LEDGER_SNAPSHOT_JSON=') + 'NATIVE_LEDGER_SNAPSHOT_JSON='.length,
        ),
      );
      if (snapshot?.schema !== SNAPSHOT_SCHEMA)
        throw new Error('The marker did not contain a Ghidra ledger snapshot.');
      const output = `${JSON.stringify(snapshot, null, 2)}\n`;
      if (options['--output']) await writeFile(options['--output'], output, {flag: 'wx'});
      process.stdout.write(output);
      return 0;
    }
    if (command !== 'verify' || !options['--ledger'] || !options['--snapshot'])
      throw new Error('verify requires --ledger and --snapshot.');
    if ([options['--ledger'], options['--snapshot']].includes(options['--receipt']))
      throw new Error('Receipt must not overwrite either input.');
    const [ledgerBytes, snapshotBytes] = await Promise.all([
      readFile(options['--ledger']),
      readFile(options['--snapshot']),
    ]);
    const ledger = JSON.parse(ledgerBytes.toString('utf8')),
      snapshot = JSON.parse(snapshotBytes.toString('utf8'));
    const receipt = verifyLedger(ledger, snapshot);
    receipt.inputs = {
      ledger: {path: options['--ledger'], sha256: sha256(ledgerBytes)},
      snapshot: {path: options['--snapshot'], sha256: sha256(snapshotBytes)},
    };
    const output = `${JSON.stringify(receipt, null, 2)}\n`;
    if (options['--receipt']) await writeFile(options['--receipt'], output, {flag: 'wx'});
    process.stdout.write(output);
    return receipt.status === 'verified' ? 0 : 1;
  } catch (error) {
    console.log(
      JSON.stringify({schema: RECEIPT_SCHEMA, status: 'error', error: error.message}, null, 2),
    );
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await main(process.argv.slice(2));

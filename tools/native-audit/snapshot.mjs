import {execFileSync} from 'node:child_process';
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  buildArguments,
  checkBoundary,
  checkOutputPath,
  checkRecordedBuildOutputs,
  sha256,
} from './boundary.mjs';

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: {...process.env, GIT_OPTIONAL_LOCKS: '0'},
    maxBuffer: 4 * 1024 * 1024,
  });
}

export function parseDirtyStatus(raw) {
  const records = raw.split('\0');
  const files = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    const status = record.slice(0, 2);
    const entry = {status, path: record.slice(3)};
    if (/[RC]/u.test(status)) entry.previousPath = records[++i];
    files.push(entry);
  }
  return {
    tracked: files.filter((entry) => entry.status !== '??').length,
    untracked: files.filter((entry) => entry.status === '??').length,
    files,
  };
}

export function validateReceipt(receipt, manifest, manifestBytes) {
  if (
    receipt?.schema !== 'native-validation-receipt/v1' ||
    receipt.accepted !== true ||
    receipt.failure !== null
  )
    throw new Error('No accepted validation receipt');
  if (receipt.manifestSha256 !== sha256(manifestBytes) || receipt.boundaryId !== manifest.id)
    throw new Error('Receipt belongs to a different manifest');
  if (
    receipt.safetyClass !== manifest.safetyClass ||
    typeof receipt.finished !== 'string' ||
    !Number.isFinite(Date.parse(receipt.finished))
  )
    throw new Error('Receipt review class or completion time is invalid');
  const orderedInputs = [...manifest.inputs].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  if (receipt.inputsSha256 !== sha256(JSON.stringify(orderedInputs)))
    throw new Error('Receipt input hashes do not match the manifest');
  if (!Array.isArray(receipt.tests) || receipt.tests.length !== manifest.tests.length)
    throw new Error('Receipt test selection differs');
  for (let i = 0; i < manifest.tests.length; i++) {
    const expected = manifest.tests[i],
      observed = receipt.tests[i];
    if (
      observed.path !== expected.path ||
      observed.expectedTests !== expected.expectedTests ||
      observed.tests !== expected.expectedTests ||
      observed.pass !== expected.expectedTests ||
      ['fail', 'cancelled', 'skipped', 'todo'].some((key) => observed[key] !== 0)
    )
      throw new Error(`Receipt test result differs: ${expected.path}`);
  }
  const commands = manifest.tests.map((test) => [
    '--test',
    '--test-reporter=tap',
    '--test-concurrency=1',
    test.path,
  ]);
  if (manifest.build === 'typescript') {
    commands.unshift(buildArguments);
    if (
      !Array.isArray(receipt.builtOutputs) ||
      receipt.builtOutputs.length === 0 ||
      receipt.builtOutputsSha256 !== sha256(JSON.stringify(receipt.builtOutputs))
    )
      throw new Error('Receipt is missing its compiled output inventory');
    const expected = manifest.inputs
      .filter(
        (input) =>
          input.path.startsWith('src/') &&
          input.path.endsWith('.ts') &&
          !input.path.endsWith('.d.ts'),
      )
      .map((input) => input.path.replace(/^src\//u, 'dist/').replace(/\.ts$/u, '.js'))
      .sort();
    if (
      JSON.stringify(receipt.builtOutputs.map((output) => output.path)) !==
        JSON.stringify(expected) ||
      receipt.builtOutputs.some((output) => !/^[a-f0-9]{64}$/u.test(output.sha256))
    )
      throw new Error('Receipt compiled outputs differ from source selection');
  }
  if (!Array.isArray(receipt.commands) || receipt.commands.length !== commands.length)
    throw new Error('Receipt command selection differs');
  for (let i = 0; i < commands.length; i++) {
    const observed = receipt.commands[i];
    if (
      JSON.stringify(observed.args) !== JSON.stringify(commands[i]) ||
      observed.exitCode !== 0 ||
      observed.signal ||
      observed.reason
    )
      throw new Error('Receipt contains a failed or different command');
  }
  return {
    id: manifest.id,
    finished: receipt.finished,
    testsPassed: manifest.tests.reduce((total, test) => total + test.expectedTests, 0),
  };
}

export async function handoffSnapshot({
  root = process.cwd(),
  manifestPath,
  receiptPath,
  slotManifestPath,
} = {}) {
  const ignored = git(root, [
    'ls-files',
    '--others',
    '--ignored',
    '--exclude-standard',
    '-z',
    '--',
    'docs/investigations',
  ])
    .split('\0')
    .filter(Boolean);
  const snapshot = {
    schema: 'native-handoff-snapshot/v1',
    generatedAt: new Date().toISOString(),
    branch: git(root, ['branch', '--show-current']).trim() || null,
    head: git(root, ['rev-parse', 'HEAD']).trim(),
    dirty: parseDirtyStatus(git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])),
    ignoredInvestigations: {
      count: ignored.length,
      warning: ignored.length
        ? 'Investigation documents are ignored; an ordinary commit or checkout does not preserve them.'
        : null,
    },
    lastAcceptedBoundary: null,
    validation: {state: 'not-provided', currentInputs: null, failure: null},
    integration: {
      state: 'not-assessed',
      note: 'Run the slot auditor for current source and aggregation gaps. Test receipts do not establish runtime integration.',
    },
  };
  if (slotManifestPath) {
    const {inspectSources, auditObservations, validateManifest} = await import('./slots.mjs');
    const slotBytes = await readFile(path.resolve(root, slotManifestPath));
    const slots = validateManifest(JSON.parse(slotBytes));
    const report = auditObservations(slots, await inspectSources(slots, root));
    snapshot.integration = {
      state: report.aggregate.state,
      complete: report.complete,
      auditOk: report.ok,
      manifestSha256: sha256(slotBytes),
      counts: report.counts,
      missingSourceSlots: report.missingSource,
      missingAggregateSlots: report.aggregate.missing,
      constructionCandidates: report.aggregateCandidates,
      errors: report.errors,
      warningCount: report.warnings.length,
    };
  }
  if (manifestPath) {
    const manifestBytes = await readFile(path.resolve(root, manifestPath));
    const manifest = JSON.parse(manifestBytes);
    snapshot.validation.manifestSha256 = sha256(manifestBytes);
    snapshot.validation.pendingTests = manifest.tests;
    try {
      await checkBoundary(manifest, root);
      snapshot.validation.currentInputs = true;
      snapshot.validation.state = 'pending';
    } catch (error) {
      snapshot.validation.currentInputs = false;
      snapshot.validation.state = 'stale';
      snapshot.validation.failure = error.message;
    }
    if (receiptPath) {
      const receiptBytes = await readFile(path.resolve(root, receiptPath));
      snapshot.validation.receiptSha256 = sha256(receiptBytes);
      try {
        const receipt = JSON.parse(receiptBytes);
        snapshot.lastAcceptedBoundary = validateReceipt(receipt, manifest, manifestBytes);
        if (manifest.build === 'typescript') {
          try {
            await checkRecordedBuildOutputs(root, receipt.builtOutputs);
            snapshot.validation.currentBuildOutputs = true;
          } catch (error) {
            snapshot.validation.currentBuildOutputs = false;
            snapshot.validation.state = 'stale';
            snapshot.validation.failure = error.message;
          }
        }
        if (
          snapshot.validation.currentInputs &&
          snapshot.validation.currentBuildOutputs !== false
        ) {
          snapshot.validation.state = 'accepted';
          snapshot.validation.pendingTests = [];
        }
      } catch (error) {
        snapshot.validation.state = 'receipt-rejected';
        snapshot.validation.failure = error.message;
      }
    }
  } else if (receiptPath) throw new Error('A receipt requires its exact manifest');
  return snapshot;
}

async function main(args) {
  let slotManifestPath;
  const option = args.indexOf('--slots');
  if (option !== -1) {
    if (option !== args.length - 2)
      throw new Error('--slots requires one manifest path as the final option');
    slotManifestPath = args[option + 1];
    args = args.slice(0, option);
  }
  if (args.length > 3)
    throw new Error(
      'Usage: node tools/native-audit/snapshot.mjs [manifest.json [receipt.json [output.json]]]',
    );
  const [manifestPath, receiptPath, output] = args;
  if (output) {
    const manifest = manifestPath ? JSON.parse(await readFile(manifestPath, 'utf8')) : {};
    await checkOutputPath(
      output,
      manifest,
      [manifestPath, receiptPath, slotManifestPath].filter(Boolean),
    );
  }
  const result = await handoffSnapshot({manifestPath, receiptPath, slotManifestPath});
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (output) await writeFile(output, text, {flag: 'wx'});
  else console.log(text.trimEnd());
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

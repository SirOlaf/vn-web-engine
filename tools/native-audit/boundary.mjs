import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {lstat, readFile, readdir, realpath, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import * as ts from 'typescript/unstable/ast';
import {parseSources} from './slots.mjs';

const SCHEMA = 'native-validation-boundary/v1';
const extensions = new Set([
  '.ts',
  '.mts',
  '.cts',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.java',
  '.py',
  '.lock',
]);
const forbidden = new Set(['.git', 'node_modules', 'targetgame', 'dist']);
export const buildArguments = [
  'node_modules/typescript/bin/tsc',
  '-p',
  'tsconfig.json',
  '--listEmittedFiles',
  '--pretty',
  'false',
  '--incremental',
  'false',
  '--noEmit',
  'false',
  '--emitDeclarationOnly',
  'false',
];
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function relativeFile(value) {
  requireValue(
    typeof value === 'string' && value.length > 0 && !/[\\*?\[\]{}\0\r\n]/u.test(value),
    `Expected a literal repository-relative path: ${value}`,
  );
  const parts = value.split('/');
  requireValue(
    !path.isAbsolute(value) &&
      parts.every((part) => part && part !== '.' && part !== '..' && !forbidden.has(part)),
    `Path is outside the permitted source tree: ${value}`,
  );
  return value;
}

async function localPath(root, relative, kind) {
  relativeFile(relative);
  const absolute = path.resolve(root, relative);
  const stat = await lstat(absolute);
  const resolved = await realpath(absolute);
  requireValue(resolved === absolute, `Symlinked inputs are not accepted: ${relative}`);
  requireValue(
    kind === 'directory' ? stat.isDirectory() : stat.isFile(),
    `Expected ${kind}: ${relative}`,
  );
  return absolute;
}

async function sourceFiles(root, directory) {
  await localPath(root, directory, 'directory');
  const files = [];
  for (const entry of await readdir(path.join(root, directory), {withFileTypes: true})) {
    const relative = `${directory}/${entry.name}`;
    requireValue(!entry.isSymbolicLink(), `Symlinked inputs are not accepted: ${relative}`);
    if (entry.isDirectory()) {
      requireValue(
        !forbidden.has(entry.name),
        `Generated/dependency tree in source root: ${relative}`,
      );
      files.push(...(await sourceFiles(root, relative)));
    } else if (entry.isFile() && extensions.has(path.extname(entry.name))) {
      files.push(relative);
    }
  }
  return files.sort();
}

function reviewFields(review) {
  requireValue(review?.schema === SCHEMA, `Expected schema ${SCHEMA}`);
  requireValue(
    typeof review.id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(review.id),
    'Invalid boundary id',
  );
  requireValue(
    review.safetyClass === 'ordinary-deterministic',
    'Only reviewed ordinary deterministic tests are accepted',
  );
  requireValue(
    typeof review.reviewedBy === 'string' && review.reviewedBy.trim(),
    'A review attribution is required',
  );
  requireValue(
    typeof review.reviewNotes === 'string' && review.reviewNotes.trim(),
    'Review notes are required',
  );
  requireValue(
    review.build === 'none' || review.build === 'typescript',
    'Build must be none or typescript',
  );
  requireValue(
    Number.isInteger(review.timeoutMs) && review.timeoutMs >= 1000 && review.timeoutMs <= 60000,
    'timeoutMs must be 1000..60000',
  );
  requireValue(
    Array.isArray(review.tests) && review.tests.length > 0 && review.tests.length <= 20,
    'Select 1..20 exact reviewed test files; broad suites are refused',
  );
  const names = new Set();
  for (const test of review.tests) {
    relativeFile(test.path);
    requireValue(
      /^tests\/[a-zA-Z0-9_./-]+\.test\.mjs$/u.test(test.path),
      `Expected an explicit tests/*.test.mjs file: ${test.path}`,
    );
    requireValue(!names.has(test.path), `Duplicate test: ${test.path}`);
    names.add(test.path);
    requireValue(
      Number.isInteger(test.expectedTests) && test.expectedTests > 0,
      `Expected a positive reviewed test count: ${test.path}`,
    );
  }
  requireValue(
    Array.isArray(review.sourceRoots) && review.sourceRoots.length > 0,
    'Explicit sourceRoots are required',
  );
  review.sourceRoots.forEach(relativeFile);
  requireValue(
    new Set(review.sourceRoots).size === review.sourceRoots.length,
    'Duplicate sourceRoots',
  );
  requireValue(
    Array.isArray(review.extraInputs),
    'Explicit extraInputs are required (may be empty)',
  );
  review.extraInputs.forEach(relativeFile);
  requireValue(
    new Set(review.extraInputs).size === review.extraInputs.length,
    'Duplicate extraInputs',
  );
  if (review.build === 'typescript')
    requireValue(
      review.sourceRoots.includes('src'),
      'TypeScript builds must pin the entire src tree',
    );
}

async function collectInputs(review, root) {
  const selected = new Set(['package.json', 'package-lock.json', 'tsconfig.json']);
  for (const directory of review.sourceRoots)
    for (const file of await sourceFiles(root, directory)) selected.add(file);
  for (const file of review.extraInputs) selected.add(file);
  for (const test of review.tests) selected.add(test.path);
  const inputs = [];
  for (const file of [...selected].sort()) {
    const bytes = await readFile(await localPath(root, file, 'file'));
    inputs.push({path: file, sha256: sha256(bytes)});
  }
  return inputs;
}

async function checkBuildPolicy(review, root) {
  if (review.build === 'none') {
    const sources = {};
    for (const test of review.tests)
      sources[test.path] = await readFile(await localPath(root, test.path, 'file'), 'utf8');
    for (const [file, source] of parseSources(sources)) {
      const visit = (node) => {
        let specifier;
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
          specifier = node.moduleSpecifier;
        else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
          specifier = node.arguments[0];
        else if (
          ts.isNewExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'URL'
        )
          specifier = node.arguments?.[0];
        if (
          specifier &&
          (ts.isStringLiteral(specifier) || ts.isNoSubstitutionTemplateLiteral(specifier))
        ) {
          const target = path.resolve(root, path.dirname(file), specifier.text);
          requireValue(
            !target.startsWith(`${path.resolve(root, 'dist')}${path.sep}`),
            `Test imports dist but no fresh build is selected: ${file}`,
          );
        }
        node.forEachChild((child) => {
          visit(child);
        });
      };
      visit(source);
    }
  }
  if (review.build === 'typescript') {
    const config = JSON.parse(await readFile(path.join(root, 'tsconfig.json'), 'utf8'));
    requireValue(
      !config.extends &&
        !config.references &&
        !config.files &&
        JSON.stringify(config.include) === '["src/**/*.ts"]' &&
        !config.exclude &&
        config.compilerOptions?.rootDir === 'src' &&
        config.compilerOptions?.outDir === 'dist' &&
        !config.compilerOptions?.outFile,
      'Reviewed builds currently require the explicit src/**/*.ts -> dist project profile without extends/references/files/exclude/outFile',
    );
  }
}

async function builtFiles(root, directory = 'dist') {
  const absolute = path.resolve(root, directory);
  requireValue((await realpath(absolute)) === absolute, `Symlinked build output: ${directory}`);
  const files = [];
  for (const entry of await readdir(absolute, {withFileTypes: true})) {
    const relative = `${directory}/${entry.name}`;
    requireValue(!entry.isSymbolicLink(), `Symlinked build output: ${relative}`);
    if (entry.isDirectory()) files.push(...(await builtFiles(root, relative)));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(relative);
  }
  return files.sort();
}

export async function verifyBuildOutputs(manifest, root, stdout) {
  const expected = manifest.inputs
    .filter(
      (input) =>
        input.path.startsWith('src/') &&
        input.path.endsWith('.ts') &&
        !input.path.endsWith('.d.ts'),
    )
    .map((input) => input.path.replace(/^src\//u, 'dist/').replace(/\.ts$/u, '.js'))
    .sort();
  requireValue(expected.length > 0, 'No source modules selected for the build');
  const emitted = [...stdout.matchAll(/^TSFILE: (.+)\r?$/gmu)]
    .map((match) =>
      path.relative(root, path.resolve(root, match[1].trim())).split(path.sep).join('/'),
    )
    .filter((file) => file.endsWith('.js'))
    .sort();
  requireValue(
    JSON.stringify(emitted) === JSON.stringify(expected),
    'Compiler emitted-output inventory differs from the pinned source modules',
  );
  const actual = await builtFiles(root);
  requireValue(
    JSON.stringify(actual) === JSON.stringify(expected),
    'Build output contains orphaned or missing JavaScript modules; review and remove stale output before this boundary',
  );
  const outputs = [];
  for (const file of actual)
    outputs.push({path: file, sha256: sha256(await readFile(path.join(root, file)))});
  return outputs;
}

export async function checkRecordedBuildOutputs(root, expected) {
  root = await realpath(root);
  const files = await builtFiles(root);
  requireValue(
    JSON.stringify(files) === JSON.stringify(expected.map((output) => output.path)),
    'Compiled output file selection changed since validation',
  );
  for (const output of expected)
    requireValue(
      sha256(await readFile(path.join(root, output.path))) === output.sha256,
      `Compiled output changed since validation: ${output.path}`,
    );
}

export async function checkOutputPath(output, manifest, inputs = [], root = process.cwd()) {
  root = await realpath(root);
  const target = path.join(
    await realpath(path.dirname(path.resolve(root, output))),
    path.basename(output),
  );
  requireValue(
    !inputs.some((input) => path.resolve(root, input) === target),
    'Output must not overwrite its input',
  );
  requireValue(
    !manifest.inputs?.some((entry) => path.resolve(root, entry.path) === target),
    'Output must not overwrite a pinned input',
  );
  requireValue(
    !manifest.sourceRoots?.some((directory) =>
      target.startsWith(`${path.resolve(root, directory)}${path.sep}`),
    ),
    'Keep manifests and receipts outside the pinned source roots',
  );
  const existing = await lstat(target).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  requireValue(!existing, `Output already exists: ${output}`);
  return target;
}

/** Capture only after reviewing the listed tests and their reachable dependencies. */
export async function captureBoundary(review, root = process.cwd()) {
  reviewFields(review);
  const canonicalRoot = await realpath(root);
  const inputs = await collectInputs(review, canonicalRoot);
  await checkBuildPolicy(review, canonicalRoot);
  return {
    schema: SCHEMA,
    id: review.id,
    safetyClass: review.safetyClass,
    reviewedBy: review.reviewedBy,
    reviewNotes: review.reviewNotes,
    build: review.build,
    timeoutMs: review.timeoutMs,
    tests: review.tests.map(({path: file, expectedTests}) => ({path: file, expectedTests})),
    sourceRoots: [...review.sourceRoots],
    extraInputs: [...review.extraInputs],
    inputs,
  };
}

export async function checkBoundary(manifest, root = process.cwd()) {
  reviewFields(manifest);
  requireValue(
    Array.isArray(manifest.inputs) && manifest.inputs.length > 0,
    'Manifest has no pinned inputs; capture it after review',
  );
  const expected = new Map();
  for (const input of manifest.inputs) {
    relativeFile(input.path);
    requireValue(
      typeof input.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(input.sha256),
      `Invalid hash: ${input.path}`,
    );
    requireValue(!expected.has(input.path), `Duplicate pinned input: ${input.path}`);
    expected.set(input.path, input.sha256);
  }
  const current = await collectInputs(manifest, await realpath(root));
  await checkBuildPolicy(manifest, await realpath(root));
  const changes = [];
  for (const input of current) {
    if (!expected.has(input.path)) changes.push(`unreviewed input: ${input.path}`);
    else if (expected.get(input.path) !== input.sha256)
      changes.push(`changed input: ${input.path}`);
    expected.delete(input.path);
  }
  for (const file of expected.keys()) changes.push(`removed input: ${file}`);
  requireValue(changes.length === 0, changes.join('\n'));
  return current;
}

export function parseTestSummary(output) {
  const summary = {};
  for (const field of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const matches = [...output.matchAll(new RegExp(`^# ${field} (\\d+)\\r?$`, 'gmu'))];
    requireValue(matches.length === 1, `Missing or ambiguous TAP summary field: ${field}`);
    summary[field] = Number(matches[0][1]);
  }
  return summary;
}

async function execute(command, args, {root, timeoutMs}) {
  const env = {...process.env};
  for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'NODE_V8_COVERAGE', 'NODE_TEST_CONTEXT'])
    delete env[key];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    let stdout = '',
      stderr = '',
      reason = null;
    const timeout = setTimeout(() => {
      reason = 'timeout';
      child.kill('SIGKILL');
    }, timeoutMs);
    const collect = (name, data) => {
      if (name === 'stdout') stdout += data;
      else stderr += data;
      if (stdout.length + stderr.length > 8 * 1024 * 1024) {
        reason = 'output-limit';
        child.kill('SIGKILL');
      }
    };
    child.stdout.setEncoding('utf8').on('data', (data) => collect('stdout', data));
    child.stderr.setEncoding('utf8').on('data', (data) => collect('stderr', data));
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      resolve({code, signal, reason, stdout, stderr});
    });
  });
}

/** This is a review/change-control guard, not a sandbox for untrusted tests. */
export async function runBoundary(
  manifest,
  {root = process.cwd(), manifestHash = null, run = execute} = {},
) {
  const started = new Date().toISOString();
  const receipt = {
    schema: 'native-validation-receipt/v1',
    boundaryId: manifest?.id ?? null,
    manifestSha256: manifestHash,
    safetyClass: manifest?.safetyClass ?? null,
    nodeVersion: process.version,
    started,
    accepted: false,
    commands: [],
    tests: [],
    failure: null,
  };
  try {
    root = await realpath(root);
    const before = await checkBoundary(manifest, root);
    receipt.inputsSha256 = sha256(JSON.stringify(before));
    const invoke = async (args) => {
      const result = await run(process.execPath, args, {root, timeoutMs: manifest.timeoutMs});
      receipt.commands.push({
        executable: process.execPath,
        args,
        exitCode: result.code,
        signal: result.signal,
        reason: result.reason,
        stdoutSha256: sha256(result.stdout),
        stderrSha256: sha256(result.stderr),
      });
      requireValue(
        result.code === 0 && !result.signal && !result.reason,
        `Command failed: ${args.join(' ')}\n${result.stderr.slice(-2000)}\n${result.stdout.slice(-2000)}`,
      );
      return result;
    };
    let buildOutput = null;
    const checkOutputs = async () => {
      if (buildOutput === null) return;
      const current = await verifyBuildOutputs(manifest, root, buildOutput);
      requireValue(
        JSON.stringify(current) === JSON.stringify(receipt.builtOutputs),
        'Built JavaScript changed after compilation',
      );
    };
    if (manifest.build === 'typescript') {
      buildOutput = (await invoke(buildArguments)).stdout;
      receipt.builtOutputs = await verifyBuildOutputs(manifest, root, buildOutput);
      receipt.builtOutputsSha256 = sha256(JSON.stringify(receipt.builtOutputs));
    }
    // Run each exact file separately so one file cannot compensate for missing tests in another.
    for (const test of manifest.tests) {
      await checkBoundary(manifest, root);
      await checkOutputs();
      const result = await invoke([
        '--test',
        '--test-reporter=tap',
        '--test-concurrency=1',
        test.path,
      ]);
      const summary = parseTestSummary(result.stdout);
      receipt.tests.push({path: test.path, expectedTests: test.expectedTests, ...summary});
      requireValue(
        summary.tests === test.expectedTests && summary.pass === test.expectedTests,
        `Test count mismatch for ${test.path}: expected ${test.expectedTests}, got ${summary.tests} total / ${summary.pass} passing`,
      );
      requireValue(
        summary.fail === 0 &&
          summary.cancelled === 0 &&
          summary.skipped === 0 &&
          summary.todo === 0,
        `Incomplete test execution: ${test.path}`,
      );
    }
    await checkBoundary(manifest, root);
    await checkOutputs();
    receipt.accepted = true;
  } catch (error) {
    receipt.failure = error.message;
  }
  receipt.finished = new Date().toISOString();
  return receipt;
}

async function main(args) {
  const [operation, input, output, ...extra] = args;
  requireValue(
    ['capture', 'check', 'run'].includes(operation) && input && extra.length === 0,
    'Usage: node tools/native-audit/boundary.mjs capture|check|run <review-or-manifest.json> [output.json]',
  );
  const bytes = await readFile(input);
  const value = JSON.parse(bytes);
  if (output) await checkOutputPath(output, value, [input]);
  let result;
  if (operation === 'capture') {
    requireValue(output, 'Capture requires an output manifest path');
    result = await captureBoundary(value);
  } else if (operation === 'check') {
    await checkBoundary(value);
    result = {
      schema: 'native-validation-preflight/v1',
      boundaryId: value.id,
      current: true,
      manifestSha256: sha256(bytes),
    };
  } else {
    requireValue(output, 'Run requires an output receipt path');
    result = await runBoundary(value, {manifestHash: sha256(bytes)});
    if (!result.accepted) process.exitCode = 1;
  }
  if (output) {
    await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, {flag: 'wx'});
    console.log(
      JSON.stringify({
        output,
        accepted: result.accepted ?? null,
        boundaryId: result.boundaryId ?? result.id,
      }),
    );
  } else console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

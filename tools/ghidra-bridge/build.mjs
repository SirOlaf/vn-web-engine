#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {cp, mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import {basename, delimiter, dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const SOURCE_ROOT = dirname(fileURLToPath(import.meta.url));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function filesUnder(directory, suffix) {
  const result = [];
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await filesUnder(path, suffix)));
    else if (entry.isFile() && entry.name.endsWith(suffix)) result.push(path);
  }
  return result.sort();
}

export async function buildBridge({
  ghidraInstall,
  outputDirectory,
  javaHome,
  includeHarness = false,
}) {
  const ghidra = resolve(ghidraInstall),
    output = resolve(outputDirectory);
  const properties = await readFile(join(ghidra, 'Ghidra', 'application.properties'), 'utf8');
  const ghidraVersion = properties.match(/^application\.version=(.+)$/m)?.[1].trim();
  if (!ghidraVersion) throw new Error('Could not identify installed Ghidra version.');
  const classpath = (await filesUnder(join(ghidra, 'Ghidra'), '.jar')).join(delimiter);
  if (!classpath) throw new Error('No Ghidra jars found.');
  await mkdir(output); // Fresh directory only; never replaces an existing build.
  const classes = join(output, 'classes'),
    stage = join(output, 'stage'),
    extension = join(stage, 'NativeExportBridge');
  await mkdir(classes);
  await mkdir(join(extension, 'lib'), {recursive: true});
  const executable = (name) =>
    javaHome
      ? join(resolve(javaHome), 'bin', process.platform === 'win32' ? `${name}.exe` : name)
      : name;
  const sources = await filesUnder(join(SOURCE_ROOT, 'java'), '.java');
  const allSources = includeHarness
    ? [...sources, ...(await filesUnder(join(SOURCE_ROOT, 'test'), '.java'))]
    : sources;
  execFileSync(
    executable('javac'),
    ['--release', '21', '-cp', classpath, '-d', classes, ...allSources],
    {stdio: 'pipe'},
  );
  // Keep the synthetic harness outside the shipped extension jar.
  const production = join(output, 'production');
  await mkdir(join(production, 'vn', 'bridge'), {recursive: true});
  for (const path of await filesUnder(join(classes, 'vn', 'bridge'), '.class')) {
    if (path.includes('SyntheticExportCheck')) continue;
    await cp(path, join(production, 'vn', 'bridge', basename(path)));
  }
  const fixedDate = '2026-09-19T00:00:00Z';
  execFileSync(
    executable('jar'),
    [
      '--create',
      '--file',
      join(extension, 'lib', 'NativeExportBridge.jar'),
      '--no-manifest',
      '--date',
      fixedDate,
      '-C',
      production,
      '.',
    ],
    {stdio: 'pipe'},
  );
  await writeFile(
    join(extension, 'extension.properties'),
    `name=NativeExportBridge\ndescription=Read-only exact instruction and HighFunction SSA export\nauthor=VN Web Engine contributors\ncreatedOn=2026-09-19\nversion=${ghidraVersion}\n`,
  );
  await writeFile(join(extension, 'Module.manifest'), '');
  const zip = join(output, 'NativeExportBridge-0.2.0.zip');
  execFileSync(
    executable('jar'),
    ['--create', '--file', zip, '--no-manifest', '--date', fixedDate, '-C', stage, '.'],
    {stdio: 'pipe'},
  );
  const sourceHashes = {};
  for (const source of [...sources, fileURLToPath(import.meta.url), join(SOURCE_ROOT, 'wire.d.ts')])
    sourceHashes[source.slice(SOURCE_ROOT.length + 1)] = hash(await readFile(source));
  const receipt = {
    schema: 'ghidra-bridge-build/v1',
    bridgeVersion: '0.2.0',
    ghidraVersion,
    javaRelease: 21,
    artifact: {path: zip, sha256: hash(await readFile(zip))},
    sourceHashes,
    harnessCompiled: includeHarness,
    deployment: 'not-installed',
  };
  await writeFile(join(output, 'build-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: 'wx',
  });
  return {receipt, classes, classpath, java: executable('java')};
}

async function main(args) {
  if (args.includes('--help')) {
    console.log(
      'Usage: node tools/ghidra-bridge/build.mjs --ghidra-install DIR --out NEW_DIR [--java-home DIR] [--with-harness]',
    );
    return 0;
  }
  const values = {};
  while (args.length) {
    const flag = args.shift();
    if (flag === '--with-harness' && values[flag] === undefined) {
      values[flag] = true;
      continue;
    }
    const value = args.shift();
    if (
      !['--ghidra-install', '--out', '--java-home'].includes(flag) ||
      !value ||
      value.startsWith('--') ||
      values[flag] !== undefined
    )
      throw new Error(`Unknown, missing, or duplicate option: ${flag}`);
    values[flag] = value;
  }
  if (!values['--ghidra-install'] || !values['--out'])
    throw new Error('--ghidra-install and --out are required.');
  const result = await buildBridge({
    ghidraInstall: values['--ghidra-install'],
    outputDirectory: values['--out'],
    javaHome: values['--java-home'],
    includeHarness: values['--with-harness'] === true,
  });
  console.log(JSON.stringify(result.receipt, null, 2));
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error.stderr?.toString() || error.message);
    process.exitCode = 2;
  }
}

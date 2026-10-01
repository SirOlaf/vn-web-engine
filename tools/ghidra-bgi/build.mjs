#!/usr/bin/env node
// Builds the BGI Ghidra extension: generates the native tables and SLEIGH derived from
// the engine sources, compiles the languages with the installed Ghidra's sleigh compiler,
// compiles the Java loader/analyzer, and packages an installable ZIP. Nothing is downloaded and the Ghidra installation is not modified.

import {execFileSync} from 'node:child_process';
import {cp, mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import {delimiter, dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {generate} from './generate-sleigh.mjs';

export const SOURCE_ROOT = dirname(fileURLToPath(import.meta.url));
export const EXTENSION_NAME = 'BGI';
const VERSION = '0.1.0';
const FIXED_DATE = '2026-10-01T00:00:00Z';

async function filesUnder(directory, suffix) {
  const result = [];
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await filesUnder(path, suffix)));
    else if (entry.isFile() && entry.name.endsWith(suffix)) result.push(path);
  }
  return result.sort();
}

export async function buildExtension({ghidraInstall, outputDirectory, javaHome}) {
  const ghidra = resolve(ghidraInstall),
    output = resolve(outputDirectory);
  const properties = await readFile(join(ghidra, 'Ghidra', 'application.properties'), 'utf8');
  const ghidraVersion = properties.match(/^application\.version=(.+)$/m)?.[1].trim();
  if (!ghidraVersion) throw new Error('Could not identify installed Ghidra version.');
  const classpath = (await filesUnder(join(ghidra, 'Ghidra'), '.jar')).join(delimiter);
  const executable = (name) =>
    javaHome
      ? join(resolve(javaHome), 'bin', process.platform === 'win32' ? `${name}.exe` : name)
      : name;

  await mkdir(dirname(output), {recursive: true});
  await mkdir(output); // Fresh directory only; never replaces an existing build.
  const stage = join(output, 'stage'),
    extension = join(stage, EXTENSION_NAME),
    classes = join(output, 'classes');
  await mkdir(join(extension, 'lib'), {recursive: true});
  await mkdir(classes);
  const languages = join(extension, 'data', 'languages');
  await cp(join(SOURCE_ROOT, 'languages'), languages, {
    recursive: true,
    filter: (path) => !path.endsWith('.sla'),
  });
  await cp(join(SOURCE_ROOT, 'ghidra_scripts'), join(extension, 'ghidra_scripts'), {
    recursive: true,
  });
  const generated = generate(languages);
  const sleigh = join(ghidra, 'support', process.platform === 'win32' ? 'sleigh.bat' : 'sleigh');
  for (const spec of await filesUnder(languages, '.slaspec')) {
    try {
      execFileSync(sleigh, [spec], {
        stdio: 'pipe',
        env: {...process.env, ...(javaHome ? {JAVA_HOME: javaHome} : {})},
      });
    } catch (error) {
      throw new Error(`SLEIGH compilation failed for ${spec}:\n${error.stdout}${error.stderr}`);
    }
  }

  execFileSync(
    executable('javac'),
    [
      '--release',
      '21',
      '-cp',
      classpath,
      '-d',
      classes,
      ...(await filesUnder(join(SOURCE_ROOT, 'java'), '.java')),
    ],
    {stdio: 'pipe'},
  );
  execFileSync(
    executable('jar'),
    [
      '--create',
      '--file',
      join(extension, 'lib', `${EXTENSION_NAME}.jar`),
      '--no-manifest',
      '--date',
      FIXED_DATE,
      '-C',
      classes,
      '.',
    ],
    {stdio: 'pipe'},
  );
  await writeFile(
    join(extension, 'extension.properties'),
    `name=${EXTENSION_NAME}\ndescription=BGI/Buriko ._bp bytecode: processor, loader and operand-stack analysis\nauthor=VN Web Engine contributors\ncreatedOn=2026-10-01\nversion=${ghidraVersion}\n`,
  );
  await writeFile(join(extension, 'Module.manifest'), '');
  const zip = join(output, `${EXTENSION_NAME}-${VERSION}.zip`);
  execFileSync(
    executable('jar'),
    ['--create', '--file', zip, '--no-manifest', '--date', FIXED_DATE, '-C', stage, '.'],
    {stdio: 'pipe'},
  );
  return {zip, extension, ghidraVersion, generated};
}

async function main(args) {
  if (args.includes('--help')) {
    console.log(
      'Usage: node tools/ghidra-bgi/build.mjs --ghidra-install DIR --out NEW_DIR [--java-home DIR]',
    );
    return 0;
  }
  const values = {};
  while (args.length) {
    const flag = args.shift(),
      value = args.shift();
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
  const result = await buildExtension({
    ghidraInstall: values['--ghidra-install'],
    outputDirectory: values['--out'],
    javaHome: values['--java-home'],
  });
  console.log(`Ghidra ${result.ghidraVersion}: ${result.zip}`);
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

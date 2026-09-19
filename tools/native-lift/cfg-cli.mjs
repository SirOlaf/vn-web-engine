#!/usr/bin/env node
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {loadDatabase} from './database.mjs';
import {emitCfgTypeScript, validateCfgModule} from './cfg.mjs';

try {
  const [command, input, databasePath, output, ...extra] = process.argv.slice(2);
  if (
    !['check', 'emit'].includes(command) ||
    !input ||
    !databasePath ||
    extra.length ||
    (command === 'emit' && !output) ||
    (command === 'check' && output)
  )
    throw new Error(
      'Usage: node tools/native-lift/cfg-cli.mjs check CFG.json DATABASE.json | emit CFG.json DATABASE.json NEW-OUTPUT.ts',
    );
  const database = await loadDatabase(databasePath, {root: process.cwd(), verifySources: true});
  const module = JSON.parse(await readFile(input, 'utf8'));
  if (command === 'check')
    process.stdout.write(
      JSON.stringify(validateCfgModule(module, database).report, null, 2) + '\n',
    );
  else {
    if (!output.endsWith('.ts')) throw new Error('Output must be an explicit new .ts file');
    const generated = emitCfgTypeScript(module, database, {fromFile: path.resolve(output)});
    await writeFile(output, generated.source, {flag: 'wx'});
    process.stdout.write(
      JSON.stringify({
        status: 'emitted-cfg-prototype',
        output: path.resolve(output),
        irSha256: generated.report.irSha256,
        databaseSha256: generated.report.databaseSha256,
      }) + '\n',
    );
  }
} catch (error) {
  process.stderr.write(
    JSON.stringify(
      {
        status: 'refused',
        code: error.code ?? 'INPUT',
        message: error.message,
        details: error.details ?? {},
      },
      null,
      2,
    ) + '\n',
  );
  process.exitCode = 1;
}

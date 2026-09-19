#!/usr/bin/env node
import {readFile, writeFile} from 'node:fs/promises';
import {loadDatabase} from './database.mjs';
import {routeReviewedFunction} from './reviewed-route.mjs';

const usage =
  'Usage: node tools/native-lift/reviewed-route-cli.mjs import EXPORT.json DATABASE.json PLAN.json NEW_MODULE.json';

try {
  const [command, exportPath, databasePath, planPath, outputPath, ...extra] =
    process.argv.slice(2);
  if (command !== 'import' || !exportPath || !databasePath || !planPath || !outputPath || extra.length)
    throw new Error(usage);
  const exported = JSON.parse(await readFile(exportPath, 'utf8'));
  const database = await loadDatabase(databasePath, {root: process.cwd(), verifySources: true});
  const plan = JSON.parse(await readFile(planPath, 'utf8'));
  const result = routeReviewedFunction(exported, database, plan);
  await writeFile(outputPath, `${JSON.stringify(result.module, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  process.stdout.write(`${JSON.stringify({...result.receipt, outputPath}, null, 2)}\n`);
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({status: 'refused', code: error.code ?? 'INPUT', message: error.message}, null, 2)}\n`,
  );
  process.exitCode = 1;
}

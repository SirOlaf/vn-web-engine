#!/usr/bin/env node
import {readFile, writeFile} from 'node:fs/promises';
import {canonicalJson} from './index.mjs';
import {loadDatabase} from './database.mjs';
import {analyzeGenerationalSlots, slotAnalysisReceipt} from './generational-slots.mjs';

const usage =
  'Usage: node tools/native-lift/generational-slots-cli.mjs analyze EXPORT.json [DATABASE.json] NEW_OUTPUT.json';

try {
  const [command, inputPath, ...paths] = process.argv.slice(2);
  if (command !== 'analyze' || !inputPath || ![1, 2].includes(paths.length)) throw new Error(usage);
  const [databasePath, outputPath] = paths.length === 2 ? paths : [null, paths[0]];
  const exported = JSON.parse(await readFile(inputPath, 'utf8'));
  const database = databasePath ? await loadDatabase(databasePath, {root: process.cwd()}) : null;
  const ir = analyzeGenerationalSlots(exported, database);
  await writeFile(outputPath, `${canonicalJson(ir)}\n`, {encoding: 'utf8', flag: 'wx'});
  process.stdout.write(`${JSON.stringify(slotAnalysisReceipt(ir), null, 2)}\n`);
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({status: 'refused', code: error.code ?? 'INPUT', message: error.message}, null, 2)}\n`,
  );
  process.exitCode = 1;
}

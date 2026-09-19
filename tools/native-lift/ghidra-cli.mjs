#!/usr/bin/env node
import {readFile, writeFile} from 'node:fs/promises';
import {canonicalJson, sha256} from './index.mjs';
import {loadDatabase} from './database.mjs';
import {importGhidraFunction, validateGhidraExport} from './ghidra-import.mjs';

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'inspect' && args.length === 1) {
    const exported = JSON.parse(await readFile(args[0], 'utf8'));
    const graph = validateGhidraExport(exported);
    process.stdout.write(
      `${JSON.stringify({schema: 'ghidra-cfg-inspection/v1', exportSha256: sha256(canonicalJson(exported)), binary: exported.binary, function: exported.function, blocks: graph.blocks.size, operations: graph.ops.size, opcodeCounts: Object.fromEntries([...new Set([...graph.ops.values()].map((op) => op.opcode))].sort().map((opcode) => [opcode, [...graph.ops.values()].filter((op) => op.opcode === opcode).length])), nativeInputs: [...graph.values.values()].filter((value) => value.flags.input), calls: [...graph.ops.values()].filter((op) => op.opcode === 'CALL'), savedState: 'unverified'}, null, 2)}\n`,
    );
  } else if (command === 'import' && args.length === 4) {
    const [exportFile, databaseFile, planFile, outputFile] = args;
    const exported = JSON.parse(await readFile(exportFile, 'utf8'));
    const db = await loadDatabase(databaseFile, {root: process.cwd(), verifySources: true});
    const plan = JSON.parse(await readFile(planFile, 'utf8'));
    const result = importGhidraFunction(exported, db, plan);
    await writeFile(outputFile, `${JSON.stringify(result.module, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    process.stdout.write(`${JSON.stringify({...result.receipt, outputFile}, null, 2)}\n`);
  } else
    throw new Error(
      'Usage: node tools/native-lift/ghidra-cli.mjs inspect export.json | import export.json database.json plan.json NEW-module.json',
    );
} catch (error) {
  process.stderr.write(`${error.code ?? 'ERROR'}: ${error.message}\n`);
  process.exitCode = 1;
}

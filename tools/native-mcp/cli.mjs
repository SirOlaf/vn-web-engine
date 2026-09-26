#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {createBridgeClient, DEFAULT_PORT, validateExportRequest, validatePort} from './client.mjs';
import {serveStdio} from './server.mjs';

try {
  const args = process.argv.slice(2);
  let port = DEFAULT_PORT;
  if (args[0] === '--port') {
    port = validatePort(Number(args[1]));
    args.splice(0, 2);
  }
  const [command = 'serve', ...rest] = args;
  const client = createBridgeClient({port});
  if (command === 'serve' && rest.length === 0) await serveStdio({client});
  else if (command === 'health' && rest.length === 0)
    process.stdout.write(`${JSON.stringify(await client.health(), null, 2)}\n`);
  else if (command === 'export' && [1, 2].includes(rest.length)) {
    let request = JSON.parse(await readFile(rest[0], 'utf8'));
    if (rest.length === 2) {
      validateExportRequest(request);
      request = {
        ...request,
        schema: 'ghidra-function-file-request/v1',
        outputPath: path.resolve(rest[1]),
      };
    }
    const receipt = await client.exportFunctionToFile(request);
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } else
    throw new Error(
      'Usage: node tools/native-mcp/cli.mjs [--port PORT] [serve | health | export file-request.json | export capture-request.json NEW-output.json]',
    );
} catch (error) {
  process.stderr.write(`${error.code ?? 'ERROR'}: ${error.message}\n`);
  process.exitCode = 1;
}

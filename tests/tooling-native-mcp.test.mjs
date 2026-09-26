import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp, readFile, realpath, rm, symlink, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {PassThrough, Writable} from 'node:stream';
import {
  createBridgeClient,
  validateExportRequest,
  validateFileExportRequest,
  validatePort,
} from '../tools/native-mcp/client.mjs';
import {createSession, PROTOCOL_VERSION, serveStdio} from '../tools/native-mcp/server.mjs';

// Ordinary synthetic protocol tests. The HTTP server below is a local fixture;
// no Ghidra/game process, script, executable or external service is invoked.
const binary = {
  programPath: '/synthetic.exe',
  executableSha256: 'a'.repeat(64),
  languageId: 'x86:LE:64:default',
  imageBase: '0x140000000',
};
const request = {
  schema: 'ghidra-function-request/v1',
  binary,
  entryAddress: '0x140001000',
  representation: 'both',
};
const fileRequest = {
  ...request,
  schema: 'ghidra-function-file-request/v1',
  outputPath: path.join(tmpdir(), 'synthetic-function.json'),
};
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fileReply = (request, bytes = Buffer.from('{}\n')) => ({
  schema: 'ghidra-function-file-receipt/v1',
  status: 'complete',
  file: {
    path: request.outputPath,
    byteLength: bytes.length,
    sha256: hash(bytes),
    contentSchema: 'ghidra-function-export/v1',
  },
  binary: request.binary,
  function: {
    entryAddress: request.entryAddress,
    name: 'Synthetic',
    bodySha256: 'b'.repeat(64),
    bodyByteLength: 4,
  },
  representation: request.representation ?? 'both',
  counts: {
    instructions: request.representation === 'high' ? null : 2,
    rawOps: request.representation === 'high' ? null : 3,
    highBlocks: request.representation === 'raw' ? null : 1,
    highOps: request.representation === 'raw' ? null : 3,
  },
  state: {stable: true, savedState: 'unverified', changed: false, modificationNumber: '1'},
  exporter: {name: 'NativeExportBridge', version: '0.2.0', ghidraVersion: 'synthetic'},
});
const health = {
  schema: 'ghidra-bridge-health/v1',
  bridgeVersion: '0.2.0',
  ghidraVersion: 'synthetic',
  capabilities: ['function-export', 'function-export-file'],
};
const state = {
  changed: false,
  transactionOpen: false,
  modificationNumber: '1',
  domainFile: {
    programPath: binary.programPath,
    fileId: 'synthetic',
    lastModifiedMs: '1',
    version: 1,
  },
};
const reply = () => ({
  schema: 'ghidra-function-export/v1',
  status: 'complete',
  binary,
  function: {entryAddress: request.entryAddress},
  raw: {kind: 'raw-pcode'},
  high: {kind: 'high-pcode'},
  state: {before: state, after: state, stable: true, savedState: 'unverified'},
});
const rpc = (id, method, params = {}) => ({jsonrpc: '2.0', id, method, params});
async function ready(session) {
  const initialized = await session.handle(
    rpc(1, 'initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {name: 'synthetic', version: '1'},
    }),
  );
  await session.handle({jsonrpc: '2.0', method: 'notifications/initialized'});
  return initialized;
}
async function fixture(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return Object.assign(createBridgeClient({port: server.address().port}), {
    testPort: server.address().port,
  });
}
async function temporary(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'vn-mcp-file-')));
  t.after(() => rm(directory, {recursive: true, force: true}));
  return directory;
}
function json(res, value, status = 200) {
  res.writeHead(status, {'Content-Type': 'application/json'});
  res.end(JSON.stringify(value));
}

test('native MCP: strict identity requests have no script or arbitrary endpoint surface', () => {
  assert.equal(validateExportRequest(request), request);
  for (const changed of [
    {...request, script: 'ignored'},
    {...request, entryAddress: 0x1000},
    {...request, entryAddress: '0x0140001000'},
    {...request, binary: {...binary, executableSha256: 'bad'}},
    {...request, limits: {maxPcodeOps: 100001}},
    {...request, representation: 'low'},
  ])
    assert.throws(() => validateExportRequest(changed));
  for (const port of [0, 80, 65536, NaN, 18493.5]) assert.throws(() => validatePort(port));
  assert.equal(validateFileExportRequest(fileRequest), fileRequest);
  for (const outputPath of [
    undefined,
    'relative.json',
    '/tmp/out.txt',
    '/tmp/../out.json',
    '/tmp/a\nb.json',
  ])
    assert.throws(() => validateFileExportRequest({...fileRequest, outputPath}));
  assert.throws(() => validateFileExportRequest(request));
  assert.throws(() => validateFileExportRequest({...fileRequest, overwrite: true}));
});

test('native MCP: initialize, ping, exact two-tool discovery and unsupported methods', async () => {
  const session = createSession({client: {health: async () => health}});
  assert.equal((await session.handle(rpc(0, 'tools/list'))).error.code, -32002);
  assert.equal((await ready(session)).result.protocolVersion, PROTOCOL_VERSION);
  assert.deepEqual((await session.handle(rpc(2, 'ping'))).result, {});
  const listed = (await session.handle(rpc(3, 'tools/list'))).result.tools;
  assert.deepEqual(
    listed.map((tool) => tool.name),
    ['native_bridge_health', 'native_export_function'],
  );
  assert.equal(listed[0].annotations.readOnlyHint, true);
  assert.equal(listed[1].annotations.readOnlyHint, false);
  assert.equal(listed[1].annotations.destructiveHint, false);
  assert.ok(listed[1].inputSchema.required.includes('outputPath'));
  assert.equal((await session.handle(rpc(4, 'resources/list'))).error.code, -32601);
  assert.equal(
    (await session.handle(rpc(5, 'tools/call', {name: 'run_script'}))).error.code,
    -32602,
  );
  assert.equal((await session.handle(rpc(6, 'initialize'))).error.code, -32600);
  assert.equal(await session.handle({jsonrpc: '2.0', method: 'notifications/unrecognized'}), null);
});

test('native MCP: tool content preserves structured evidence and reports operational errors', async () => {
  const session = createSession({
    client: {
      health: async () => health,
      exportFunctionToFile: async () => {
        throw Object.assign(new Error('Exact function entry required'), {code: 'NOT_ENTRY'});
      },
    },
  });
  await ready(session);
  const result = (await session.handle(rpc(2, 'tools/call', {name: 'native_bridge_health'})))
    .result;
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  assert.deepEqual(result.structuredContent, health);
  const failed = (
    await session.handle(
      rpc(3, 'tools/call', {name: 'native_export_function', arguments: fileRequest}),
    )
  ).result;
  assert.equal(failed.isError, true);
  assert.equal(failed.structuredContent.code, 'NOT_ENTRY');
  assert.equal(
    (
      await session.handle(
        rpc(4, 'tools/call', {name: 'native_bridge_health', arguments: {extra: true}}),
      )
    ).error.code,
    -32602,
  );
});

test('native MCP: concurrent export and cancellation preserve session availability', async () => {
  const session = createSession({
    client: {
      health: async () => health,
      exportFunctionToFile: async (_request, {signal}) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new Error('aborted')), {once: true}),
        ),
    },
  });
  await ready(session);
  const pending = session.handle(
    rpc('work', 'tools/call', {name: 'native_export_function', arguments: fileRequest}),
  );
  const busy = (
    await session.handle(
      rpc('second', 'tools/call', {name: 'native_export_function', arguments: fileRequest}),
    )
  ).result;
  assert.equal(busy.structuredContent.code, 'BUSY');
  assert.equal(
    (await session.handle(rpc('health', 'tools/call', {name: 'native_bridge_health'}))).result
      .isError,
    false,
  );
  await session.handle({
    jsonrpc: '2.0',
    method: 'notifications/cancelled',
    params: {requestId: 'work'},
  });
  assert.equal((await pending).result.structuredContent.code, 'CANCELLED');
  session.close();
});

test('native MCP: loopback HTTP carries exact scoped request and validates response identity', async (t) => {
  const received = [];
  const client = await fixture(t, async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    received.push({method: req.method, path: req.url, marker: req.headers['x-vn-bridge'], body});
    json(res, req.url === '/v1/health' ? health : reply());
  });
  assert.deepEqual(await client.health(), health);
  assert.deepEqual(await client.exportFunction(request), reply());
  assert.equal(received[0].path, '/v1/health');
  assert.equal(received[1].method, 'POST');
  assert.equal(received[1].path, '/v1/function');
  assert.equal(received[1].marker, '1');
  assert.deepEqual(JSON.parse(received[1].body), request);
});

test('native MCP: incomplete, stale, unstable and HTTP error exports never become success', async (t) => {
  let value = reply(),
    status = 200;
  const client = await fixture(t, (_req, res) => json(res, value, status));
  for (const invalid of [
    {...reply(), status: 'partial'},
    {...reply(), high: undefined},
    {...reply(), binary: {...binary, languageId: 'wrong'}},
    {...reply(), function: {entryAddress: '0x140001001'}},
    {...reply(), state: {...reply().state, after: {...state, modificationNumber: '2'}}},
    {
      ...reply(),
      state: {...reply().state, before: {transactionOpen: false}, after: {transactionOpen: false}},
    },
    {
      ...reply(),
      state: {...reply().state, after: {...state, domainFile: {...state.domainFile, version: 2}}},
    },
  ]) {
    value = invalid;
    await assert.rejects(client.exportFunction(request));
  }
  status = 409;
  value = {code: 'PROGRAM_BUSY', message: 'Open transaction'};
  await assert.rejects(client.exportFunction(request), {code: 'PROGRAM_BUSY'});
});

test('native MCP: byte limits reject oversized replies without returning truncated evidence', async (t) => {
  const client = await fixture(t, (_req, res) => json(res, {...health, extra: 'x'.repeat(400)}));
  // Same known fixture endpoint; a small local bound makes the limit deterministic.
  const server = http.createServer((_req, res) => json(res, {...health, extra: 'x'.repeat(400)}));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const limited = createBridgeClient({port: server.address().port, maxResponseBytes: 50});
  await assert.rejects(limited.health(), {code: 'RESPONSE_LIMIT'});
  assert.equal((await client.health()).schema, health.schema);
});

test('native MCP: stdio framing handles split UTF-8 lines and recovers at newline boundaries', async () => {
  const input = new PassThrough(),
    output = new PassThrough();
  const chunks = [];
  output.on('data', (chunk) => chunks.push(chunk));
  const running = serveStdio({
    input,
    output,
    client: {health: async () => health},
    maxLineBytes: 512,
  });
  const init = Buffer.from(
    `${JSON.stringify(rpc(1, 'initialize', {protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: {name: 'synthetic-雪', version: '1'}}))}\n`,
  );
  const unicode = init.indexOf(Buffer.from('雪'));
  input.write(init.subarray(0, unicode + 1));
  input.write(init.subarray(unicode + 1));
  input.write(`${JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'})}\n`);
  input.write('x'.repeat(600));
  input.write('\n');
  input.write('{broken json}\n');
  input.end(`${JSON.stringify(rpc(2, 'tools/list'))}\n`);
  await running;
  const messages = Buffer.concat(chunks).toString('utf8').trim().split('\n').map(JSON.parse);
  assert.equal(messages.length, 4);
  assert.equal(
    messages.find((message) => message.id === 1).result.protocolVersion,
    PROTOCOL_VERSION,
  );
  assert.equal(messages.find((message) => message.id === 2).result.tools.length, 2);
  assert.deepEqual(
    messages
      .filter((message) => message.error)
      .map((message) => message.error.code)
      .sort((a, b) => a - b),
    [-32700, -32600],
  );
});

test('native MCP: stdio disconnect aborts an outstanding bridge request before draining', async () => {
  const input = new PassThrough(),
    output = new PassThrough();
  const chunks = [];
  output.on('data', (chunk) => chunks.push(chunk));
  let started;
  const active = new Promise((resolve) => {
    started = resolve;
  });
  const running = serveStdio({
    input,
    output,
    client: {
      exportFunctionToFile: async (_request, {signal}) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('client disconnected')), {
            once: true,
          });
          started();
        }),
    },
  });
  input.write(
    `${JSON.stringify(rpc(1, 'initialize', {protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: {name: 'synthetic', version: '1'}}))}\n`,
  );
  input.write(`${JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'})}\n`);
  input.write(
    `${JSON.stringify(rpc(2, 'tools/call', {name: 'native_export_function', arguments: fileRequest}))}\n`,
  );
  await active;
  input.end();
  await running;
  const messages = Buffer.concat(chunks).toString('utf8').trim().split('\n').map(JSON.parse);
  assert.equal(
    messages.find((message) => message.id === 2).result.structuredContent.code,
    'CANCELLED',
  );
});

test('native MCP: a broken output pipe closes the transport without unhandled reply rejections', async () => {
  const input = new PassThrough();
  const broken = Object.assign(new Error('synthetic closed pipe'), {code: 'EPIPE'});
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      callback(broken);
    },
  });
  const running = serveStdio({input, output, client: {}});
  const refused = assert.rejects(running, {code: 'EPIPE'});
  input.write('{synthetic parse error}\n');
  await refused;
  assert.equal(input.destroyed, true);
});

test('native MCP: file route canonicalizes the parent and returns only exact receipts for each representation', async (t) => {
  const directory = await temporary(t);
  await symlink(directory, path.join(directory, 'alias'), 'dir');
  const received = [];
  const client = await fixture(t, async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    received.push({path: req.url, method: req.method, marker: req.headers['x-vn-bridge'], request});
    json(res, fileReply(request));
  });
  for (const representation of ['raw', 'high', 'both']) {
    const input = {
      ...fileRequest,
      representation,
      outputPath: path.join(directory, 'alias', 'capture.json'),
    };
    const canonical = {...input, outputPath: path.join(directory, 'capture.json')};
    assert.deepEqual(await client.exportFunctionToFile(input), fileReply(canonical));
    assert.deepEqual(received.at(-1), {
      path: '/v1/function/file',
      method: 'POST',
      marker: '1',
      request: canonical,
    });
  }
  await assert.rejects(
    client.exportFunctionToFile({
      ...fileRequest,
      outputPath: path.join(directory, 'missing', 'capture.json'),
    }),
    {code: 'ENOENT'},
  );
  assert.equal(received.length, 3, 'Invalid local destination must not reach Ghidra');
});

test('native MCP: file receipts reject leaked payloads, mismatched evidence and malformed counts', async (t) => {
  const directory = await temporary(t);
  const input = {...fileRequest, outputPath: path.join(directory, 'capture.json')};
  const valid = fileReply(input);
  let value;
  const client = await fixture(t, (_req, res) => json(res, value));
  for (const invalid of [
    {...valid, status: 'partial'},
    {...valid, raw: {instructions: ['LEAKED_ASSEMBLY']}},
    {...valid, file: {...valid.file, high: {blocks: []}}},
    {...valid, file: {...valid.file, path: path.join(directory, 'wrong.json')}},
    {...valid, file: {...valid.file, byteLength: -1}},
    {...valid, file: {...valid.file, sha256: 'bad'}},
    {...valid, binary: {...binary, executableSha256: 'f'.repeat(64)}},
    {...valid, function: {...valid.function, entryAddress: '0x140001001'}},
    {...valid, representation: 'raw'},
    {...valid, counts: {...valid.counts, highOps: null}},
    {...valid, counts: {...valid.counts, rawOps: 1.5}},
    {...valid, state: {...valid.state, stable: false}},
    {...valid, exporter: {...valid.exporter, name: 'unidentified'}},
  ]) {
    value = invalid;
    await assert.rejects(client.exportFunctionToFile(input), {code: 'INVALID_RECEIPT'});
  }
});

test('native MCP: file response limits and existing-file errors never return a successful receipt', async (t) => {
  const directory = await temporary(t);
  const input = {...fileRequest, outputPath: path.join(directory, 'capture.json')};
  let value = {...fileReply(input), raw: 'ASSEMBLY'.repeat(10000)},
    status = 200;
  const client = await fixture(t, (_req, res) => json(res, value, status));
  await assert.rejects(client.exportFunctionToFile(input), {code: 'RESPONSE_LIMIT'});
  value = {
    schema: 'ghidra-bridge-error/v1',
    status: 'error',
    code: 'file-exists',
    message: 'No artifact was replaced',
  };
  status = 409;
  await assert.rejects(client.exportFunctionToFile(input), {code: 'file-exists'});
});

test('native MCP: CLI and MCP stdout contain compact receipts while the bridge writes the artifact', async (t) => {
  const directory = await temporary(t);
  const sentinel = 'SYNTHETIC_ASSEMBLY_PAYLOAD_MUST_STAY_ON_DISK';
  const bytes = Buffer.from(
    `${JSON.stringify({...reply(), raw: {assembly: sentinel.repeat(5000)}})}\n`,
  );
  const received = [];
  const client = await fixture(t, async (req, res) => {
    try {
      assert.equal(req.url, '/v1/function/file');
      let body = '';
      for await (const chunk of req) body += chunk;
      const request = JSON.parse(body);
      received.push(request);
      await writeFile(request.outputPath, bytes, {flag: 'wx'});
      json(res, fileReply(request, bytes));
    } catch (error) {
      json(
        res,
        {code: error.code === 'EEXIST' ? 'file-exists' : 'fixture-error', message: error.message},
        409,
      );
    }
  });
  const cli = async (args) => {
    const child = spawn(
      process.execPath,
      ['tools/native-mcp/cli.mjs', '--port', String(client.testPort), ...args],
      {stdio: ['ignore', 'pipe', 'pipe']},
    );
    const stdout = [],
      stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    const [code] = await once(child, 'close');
    return {
      code,
      stdout: Buffer.concat(stdout).toString(),
      stderr: Buffer.concat(stderr).toString(),
    };
  };
  const captureRequestPath = path.join(directory, 'request.json');
  await writeFile(captureRequestPath, JSON.stringify(request));
  const first = path.join(directory, 'cli-capture.json');
  const fromCapture = await cli(['export', captureRequestPath, first]);
  assert.equal(fromCapture.code, 0, fromCapture.stderr);
  const fileRequestPath = path.join(directory, 'file-request.json');
  const second = path.join(directory, 'cli-file.json');
  await writeFile(fileRequestPath, JSON.stringify({...fileRequest, outputPath: second}));
  const fromFile = await cli(['export', fileRequestPath]);
  assert.equal(fromFile.code, 0, fromFile.stderr);
  for (const [result, outputPath] of [
    [fromCapture, first],
    [fromFile, second],
  ]) {
    assert.ok(result.stdout.length < 4096);
    assert.equal(result.stdout.includes(sentinel), false);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.file.path, outputPath);
    assert.equal(receipt.file.sha256, hash(await readFile(outputPath)));
    assert.equal(receipt.file.byteLength, bytes.length);
  }
  const duplicate = await cli(['export', captureRequestPath, first]);
  assert.equal(duplicate.code, 1);
  assert.equal(duplicate.stdout, '');
  assert.match(duplicate.stderr, /file-exists/);
  assert.deepEqual(await readFile(first), bytes);

  const input = new PassThrough(),
    output = new PassThrough(),
    chunks = [];
  let finishReply;
  const replied = new Promise((resolve) => {
    finishReply = resolve;
  });
  output.on('data', (chunk) => {
    chunks.push(chunk);
    const text = Buffer.concat(chunks).toString();
    if (
      text
        .trim()
        .split('\n')
        .some((line) => JSON.parse(line).id === 2)
    )
      finishReply();
  });
  const running = serveStdio({input, output, client});
  input.write(
    `${JSON.stringify(rpc(1, 'initialize', {protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: {name: 'synthetic', version: '1'}}))}\n`,
  );
  input.write(`${JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'})}\n`);
  const third = path.join(directory, 'mcp.json');
  input.write(
    `${JSON.stringify(rpc(2, 'tools/call', {name: 'native_export_function', arguments: {...fileRequest, outputPath: third}}))}\n`,
  );
  await replied;
  input.end();
  await running;
  const stdout = Buffer.concat(chunks).toString();
  assert.equal(stdout.includes(sentinel), false);
  assert.ok(stdout.length < 8192);
  const result = stdout
    .trim()
    .split('\n')
    .map(JSON.parse)
    .find((message) => message.id === 2).result;
  assert.equal(result.isError, false);
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  assert.equal(result.structuredContent.file.sha256, hash(await readFile(third)));
  assert.equal(received.length, 4);
});

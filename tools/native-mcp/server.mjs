import {createBridgeClient, exportFileInputSchema, validateFileExportRequest} from './client.mjs';

// Deliberately implements only the tools subset of the 2025-11-25 stdio protocol.
export const PROTOCOL_VERSION = '2025-11-25';
export const toolDefinitions = [
  {
    name: 'native_bridge_health',
    title: 'Native export bridge health',
    description: 'Read the dedicated local Ghidra export bridge version and capabilities.',
    inputSchema: {type: 'object', properties: {}, additionalProperties: false},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'native_export_function',
    title: 'Export one exact native function to a file',
    description:
      'Write one exact hash/base/language/address-scoped Ghidra function directly to a new JSON file, including decoded instructions and/or an ordered SSA control-flow graph. Returns only the file path, byte hash, counts and capture summary. Requires outputPath; existing files are never overwritten. Does not execute instructions, mutate/save the Ghidra program, or run scripts.',
    inputSchema: exportFileInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
];
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = (value) =>
  typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
const errorReply = (id, code, message) => ({jsonrpc: '2.0', id, error: {code, message}});

export function createSession({client = createBridgeClient()} = {}) {
  let phase = 'new';
  let exportBusy = false;
  const active = new Map();
  return {
    close() {
      for (const controller of active.values()) controller.abort();
      active.clear();
      phase = 'closed';
    },
    async handle(message) {
      if (
        !object(message) ||
        message.jsonrpc !== '2.0' ||
        typeof message.method !== 'string' ||
        (Object.hasOwn(message, 'id') && !validId(message.id)) ||
        (Object.hasOwn(message, 'params') && !object(message.params))
      )
        return errorReply(
          validId(message?.id) ? message.id : null,
          -32600,
          'Invalid JSON-RPC request',
        );
      const notification = !Object.hasOwn(message, 'id');
      const params = message.params ?? {};
      if (notification) {
        if (message.method === 'notifications/initialized' && phase === 'initializing')
          phase = 'ready';
        else if (message.method === 'notifications/cancelled' && validId(params.requestId))
          active.get(params.requestId)?.abort();
        return null;
      }
      const {id, method} = message;
      if (active.has(id)) return errorReply(id, -32600, 'Request ID is already active');
      const result = (value) => ({jsonrpc: '2.0', id, result: value});
      if (method === 'ping' && phase !== 'closed') return result({});
      if (method === 'initialize') {
        if (phase !== 'new') return errorReply(id, -32600, 'Session is already initialized');
        if (
          typeof params.protocolVersion !== 'string' ||
          !object(params.capabilities) ||
          !object(params.clientInfo) ||
          typeof params.clientInfo.name !== 'string' ||
          typeof params.clientInfo.version !== 'string'
        )
          return errorReply(
            id,
            -32602,
            'initialize requires protocolVersion, capabilities and clientInfo',
          );
        phase = 'initializing';
        return result({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {tools: {listChanged: false}},
          serverInfo: {name: 'vn-native-export', version: '0.2.0'},
          instructions:
            'The dedicated Ghidra bridge provides health and file exports. Exports require exact binary identity, entry address and an absolute new outputPath. The full decoded graph stays in that file; only compact receipts return here. Ghidra program state is read-only; saved state remains unverified.',
        });
      }
      if (phase !== 'ready')
        return errorReply(
          id,
          -32002,
          'Complete the initialize/notifications/initialized handshake first',
        );
      if (method === 'tools/list') {
        if (params.cursor !== undefined)
          return errorReply(id, -32602, 'This tool catalog has no further pages');
        return result({tools: toolDefinitions});
      }
      if (method !== 'tools/call') return errorReply(id, -32601, 'Method not supported');
      if (!toolDefinitions.some((tool) => tool.name === params.name))
        return errorReply(id, -32602, 'Unknown tool');
      const args = params.arguments ?? {};
      if (!object(args)) return errorReply(id, -32602, 'Tool arguments must be an object');
      if (params.name === 'native_bridge_health' && Object.keys(args).length)
        return errorReply(id, -32602, 'Health takes no arguments');
      const controller = new AbortController();
      active.set(id, controller);
      const exporting = params.name === 'native_export_function';
      let ownsExport = false;
      try {
        if (exporting && exportBusy)
          throw Object.assign(
            new Error('A function export is already in progress; retry after it completes'),
            {code: 'BUSY'},
          );
        if (exporting) {
          validateFileExportRequest(args);
          exportBusy = true;
          ownsExport = true;
        }
        const value = exporting
          ? await client.exportFunctionToFile(args, {signal: controller.signal})
          : await client.health({signal: controller.signal});
        return result({
          content: [{type: 'text', text: JSON.stringify(value)}],
          structuredContent: value,
          isError: false,
        });
      } catch (error) {
        const details = {
          schema: 'native-mcp-error/v1',
          code: controller.signal.aborted ? 'CANCELLED' : (error.code ?? 'BRIDGE_ERROR'),
          message: error.message,
        };
        return result({
          content: [{type: 'text', text: JSON.stringify(details)}],
          structuredContent: details,
          isError: true,
        });
      } finally {
        active.delete(id);
        if (ownsExport) exportBusy = false;
      }
    },
  };
}

/** Newline-delimited UTF-8 JSON-RPC; no non-protocol data is written to stdout. */
export async function serveStdio({
  input = process.stdin,
  output = process.stdout,
  client,
  maxLineBytes = 65536,
} = {}) {
  const session = createSession({client});
  const pending = new Set();
  let buffered = Buffer.alloc(0);
  let discarding = false;
  let writing = Promise.resolve();
  let transportError = null;
  function outputFailed(error) {
    transportError ??= error;
    session.close();
    input.destroy?.();
  }
  output.on('error', outputFailed);
  function send(value) {
    if (value === null || transportError) return;
    writing = writing.then(
      () =>
        new Promise((resolve, reject) => {
          output.write(`${JSON.stringify(value)}\n`, (error) =>
            error ? reject(error) : resolve(),
          );
        }),
    );
    // Observe immediately, including parse-error replies that have no RPC promise.
    writing = writing.catch(outputFailed);
    return writing;
  }
  function dispatch(line) {
    if (!line.length) return;
    let message;
    try {
      message = JSON.parse(line.toString('utf8'));
    } catch {
      send(errorReply(null, -32700, 'Parse error'));
      return;
    }
    const work = session.handle(message).then(send);
    pending.add(work);
    work.finally(() => pending.delete(work)).catch(() => {});
  }
  try {
    for await (const chunk of input) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      let start = 0;
      for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] !== 10) continue;
        const part = bytes.subarray(start, i);
        if (!discarding && buffered.length + part.length <= maxLineBytes)
          dispatch(Buffer.concat([buffered, part]));
        else if (!discarding) send(errorReply(null, -32600, 'Request line exceeds byte limit'));
        buffered = Buffer.alloc(0);
        discarding = false;
        start = i + 1;
      }
      const rest = bytes.subarray(start);
      if (!discarding) {
        if (buffered.length + rest.length > maxLineBytes) {
          send(errorReply(null, -32600, 'Request line exceeds byte limit'));
          buffered = Buffer.alloc(0);
          discarding = true;
        } else buffered = Buffer.concat([buffered, rest]);
      }
    }
    if (buffered.length) send(errorReply(null, -32700, 'Incomplete newline-delimited request'));
    // EOF is the stdio client's disconnect. Abort active bridge reads before
    // draining their replies, so shutdown does not wait for a decompile timeout.
    session.close();
    await Promise.allSettled(pending);
    await writing;
  } catch (error) {
    if (!transportError) throw error;
  } finally {
    session.close();
    await Promise.allSettled(pending);
    await writing;
    output.removeListener('error', outputFailed);
  }
  if (transportError) throw transportError;
}

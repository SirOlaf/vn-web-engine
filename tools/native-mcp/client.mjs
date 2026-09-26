import http from 'node:http';
import path from 'node:path';
import {realpath} from 'node:fs/promises';

export const DEFAULT_PORT = 18493;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 64 * 1024;
const addressPattern = /^0x(?:0|[1-9a-f][0-9a-f]*)$/u;
const hashPattern = /^[0-9a-f]{64}$/u;
const own = (value, key) => Object.hasOwn(value, key);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export class BridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function check(condition, message) {
  if (!condition) throw new BridgeError('INVALID_ARGUMENT', message);
}

function keys(value, permitted, label) {
  check(object(value), `${label} must be an object`);
  check(
    Object.keys(value).every((key) => permitted.includes(key)),
    `${label} has unknown fields`,
  );
}

export function validateExportRequest(request) {
  keys(request, ['schema', 'binary', 'entryAddress', 'representation', 'limits'], 'request');
  check(request.schema === 'ghidra-function-request/v1', 'Unsupported export request schema');
  keys(request.binary, ['programPath', 'executableSha256', 'languageId', 'imageBase'], 'binary');
  const binary = request.binary;
  check(
    typeof binary.programPath === 'string' && /^\/[^\0\r\n]+$/u.test(binary.programPath),
    'binary.programPath must be an exact Ghidra project path',
  );
  check(
    hashPattern.test(binary.executableSha256 ?? ''),
    'binary.executableSha256 must be a lowercase SHA-256',
  );
  check(
    typeof binary.languageId === 'string' && /^[a-zA-Z0-9_:.-]+$/u.test(binary.languageId),
    'binary.languageId is required',
  );
  for (const [label, value] of [
    ['imageBase', binary.imageBase],
    ['entryAddress', request.entryAddress],
  ]) {
    check(
      typeof value === 'string' &&
        addressPattern.test(value) &&
        BigInt(value) <= 0xffffffffffffffffn,
      `${label} must be a canonical 64-bit hexadecimal address`,
    );
  }
  check(
    BigInt(request.entryAddress) >= BigInt(binary.imageBase),
    'Function address is below the image base',
  );
  if (own(request, 'representation'))
    check(
      ['raw', 'high', 'both'].includes(request.representation),
      'representation must be raw, high, or both',
    );
  if (own(request, 'limits')) {
    const bounds = {
      decompileSeconds: 120,
      maxBodyBytes: 8388608,
      maxInstructions: 50000,
      maxPcodeOps: 100000,
    };
    keys(request.limits, Object.keys(bounds), 'limits');
    for (const [name, value] of Object.entries(request.limits))
      check(
        Number.isInteger(value) && value >= 1 && value <= bounds[name],
        `limits.${name} must be 1..${bounds[name]}`,
      );
  }
  return request;
}

export function validatePort(port) {
  check(
    Number.isInteger(port) && port >= 1024 && port <= 65535,
    'Bridge port must be an integer in 1024..65535',
  );
  return port;
}

export function validateFileExportRequest(request) {
  keys(
    request,
    ['schema', 'binary', 'entryAddress', 'representation', 'limits', 'outputPath'],
    'file export request',
  );
  check(
    request.schema === 'ghidra-function-file-request/v1',
    'Unsupported file export request schema',
  );
  const {outputPath, ...capture} = request;
  validateExportRequest({...capture, schema: 'ghidra-function-request/v1'});
  check(
    typeof outputPath === 'string' &&
      path.isAbsolute(outputPath) &&
      outputPath.endsWith('.json') &&
      !/[\u0000-\u001f]/u.test(outputPath) &&
      !outputPath.split(/[\\/]/u).includes('..'),
    'outputPath must be an absolute .json path without parent traversal or control characters',
  );
  return request;
}

function verifyFileReply(value, request) {
  const bad = (condition, message) => {
    if (!condition) throw new BridgeError('INVALID_RECEIPT', message);
  };
  bad(
    object(value) &&
      value.schema === 'ghidra-function-file-receipt/v1' &&
      value.status === 'complete',
    'Bridge did not return a complete file receipt',
  );
  // Reject unexpected fields so assembly/graphs cannot sneak back into stdio.
  const exact = (record, names) =>
    object(record) &&
    Object.keys(record).length === names.length &&
    names.every((name) => own(record, name));
  bad(
    exact(value, [
      'schema',
      'status',
      'file',
      'binary',
      'function',
      'representation',
      'counts',
      'state',
      'exporter',
    ]),
    'Unexpected file receipt fields',
  );
  bad(
    exact(value.binary, ['programPath', 'executableSha256', 'languageId', 'imageBase']) &&
      Object.keys(request.binary).every((key) => value.binary[key] === request.binary[key]),
    'File receipt binary identity differs from the request',
  );
  bad(
    exact(value.file, ['path', 'byteLength', 'sha256', 'contentSchema']) &&
      value.file.path === request.outputPath &&
      value.file.contentSchema === 'ghidra-function-export/v1' &&
      Number.isSafeInteger(value.file.byteLength) &&
      value.file.byteLength > 0 &&
      hashPattern.test(value.file.sha256 ?? ''),
    'File receipt destination, length, hash or content schema is invalid',
  );
  bad(
    exact(value.function, ['entryAddress', 'name', 'bodySha256', 'bodyByteLength']) &&
      value.function.entryAddress === request.entryAddress &&
      typeof value.function.name === 'string' &&
      value.function.name.length > 0 &&
      value.function.name.length <= 4096 &&
      hashPattern.test(value.function.bodySha256 ?? '') &&
      Number.isSafeInteger(value.function.bodyByteLength) &&
      value.function.bodyByteLength > 0,
    'File receipt function evidence is invalid',
  );
  bad(
    value.representation === (request.representation ?? 'both'),
    'File receipt representation differs from request',
  );
  bad(
    exact(value.counts, ['instructions', 'rawOps', 'highBlocks', 'highOps']),
    'File receipt counts are incomplete',
  );
  for (const [key, count] of Object.entries(value.counts)) {
    const absent =
      key === 'instructions' || key === 'rawOps'
        ? value.representation === 'high'
        : value.representation === 'raw';
    bad(
      absent ? count === null : Number.isSafeInteger(count) && count >= 0,
      `File receipt count ${key} is invalid`,
    );
  }
  bad(
    exact(value.state, ['stable', 'savedState', 'changed', 'modificationNumber']) &&
      value.state.stable === true &&
      value.state.savedState === 'unverified' &&
      typeof value.state.changed === 'boolean' &&
      typeof value.state.modificationNumber === 'string' &&
      /^-?\d+$/u.test(value.state.modificationNumber),
    'File receipt lacks stable capture evidence',
  );
  bad(
    exact(value.exporter, ['name', 'version', 'ghidraVersion']) &&
      value.exporter.name === 'NativeExportBridge' &&
      typeof value.exporter.version === 'string' &&
      value.exporter.version.length <= 64 &&
      typeof value.exporter.ghidraVersion === 'string' &&
      value.exporter.ghidraVersion.length <= 64,
    'File receipt exporter provenance is invalid',
  );
  return value;
}

function verifyReply(value, request) {
  if (!object(value))
    throw new BridgeError('INVALID_REPLY', 'Bridge returned a non-object response');
  if (!request) {
    if (
      value.schema !== 'ghidra-bridge-health/v1' ||
      !Array.isArray(value.capabilities) ||
      !value.capabilities.includes('function-export')
    )
      throw new BridgeError('INVALID_REPLY', 'Bridge health schema/capabilities do not match');
    return value;
  }
  if (value.schema !== 'ghidra-function-export/v1' || value.status !== 'complete')
    throw new BridgeError('INVALID_REPLY', 'Bridge did not return a complete function export');
  for (const key of Object.keys(request.binary))
    if (value.binary?.[key] !== request.binary[key])
      throw new BridgeError(
        'IDENTITY_MISMATCH',
        `Export binary.${key} does not match the exact request`,
      );
  if (value.function?.entryAddress !== request.entryAddress)
    throw new BridgeError(
      'IDENTITY_MISMATCH',
      'Export function entry does not match the exact request',
    );
  const before = value.state?.before,
    after = value.state?.after;
  const validState = (state) =>
    object(state) &&
    typeof state.changed === 'boolean' &&
    typeof state.modificationNumber === 'string' &&
    /^-?\d+$/u.test(state.modificationNumber) &&
    state.transactionOpen === false &&
    object(state.domainFile) &&
    state.domainFile.programPath === request.binary.programPath &&
    (state.domainFile.fileId === null || typeof state.domainFile.fileId === 'string') &&
    typeof state.domainFile.lastModifiedMs === 'string' &&
    /^-?\d+$/u.test(state.domainFile.lastModifiedMs) &&
    Number.isInteger(state.domainFile.version);
  if (
    value.state?.stable !== true ||
    value.state.savedState !== 'unverified' ||
    !validState(before) ||
    !validState(after) ||
    before.modificationNumber !== after.modificationNumber ||
    before.changed !== after.changed ||
    ['programPath', 'fileId', 'lastModifiedMs', 'version'].some(
      (field) => before.domainFile[field] !== after.domainFile[field],
    )
  )
    throw new BridgeError(
      'UNSTABLE_EXPORT',
      'Bridge export does not establish stable live program state',
    );
  const representation = request.representation ?? 'both';
  if ((representation !== 'high' && !value.raw) || (representation !== 'raw' && !value.high))
    throw new BridgeError('INVALID_REPLY', 'Export is missing a requested representation');
  return value;
}

/** Fixed loopback host and routes; no redirects, shell, proxy, scripts or arbitrary URLs. */
export function createBridgeClient({
  port = DEFAULT_PORT,
  maxResponseBytes = MAX_RESPONSE_BYTES,
} = {}) {
  validatePort(port);
  check(
    Number.isInteger(maxResponseBytes) &&
      maxResponseBytes >= 1 &&
      maxResponseBytes <= MAX_RESPONSE_BYTES,
    'Invalid response byte limit',
  );
  async function call(request, {signal} = {}, toFile = false) {
    if (request) {
      if (toFile) {
        validateFileExportRequest(request);
        request = {
          ...request,
          outputPath: path.join(
            await realpath(path.dirname(request.outputPath)),
            path.basename(request.outputPath),
          ),
        };
      } else validateExportRequest(request);
    }
    const body = request ? Buffer.from(JSON.stringify(request)) : null;
    const timeoutMs = request
      ? Math.min(125000, ((request.limits?.decompileSeconds ?? 30) + 5) * 1000)
      : 5000;
    const value = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: request ? (toFile ? '/v1/function/file' : '/v1/function') : '/v1/health',
          method: request ? 'POST' : 'GET',
          signal,
          headers: {
            'X-VN-Bridge': '1',
            Accept: 'application/json',
            ...(body ? {'Content-Type': 'application/json', 'Content-Length': body.length} : {}),
          },
        },
        (res) => {
          const chunks = [];
          let length = 0;
          if (!(res.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
            res.destroy(
              new BridgeError('INVALID_REPLY', 'Bridge response must be application/json'),
            );
          }
          res.on('data', (chunk) => {
            length += chunk.length;
            if (
              length > (toFile ? Math.min(maxResponseBytes, MAX_RECEIPT_BYTES) : maxResponseBytes)
            )
              res.destroy(
                new BridgeError(
                  'RESPONSE_LIMIT',
                  'Bridge response exceeds byte limit; response rejected without truncation',
                ),
              );
            else chunks.push(chunk);
          });
          res.on('error', reject);
          res.on('end', () => {
            let parsed;
            try {
              parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {
              reject(new BridgeError('INVALID_REPLY', 'Bridge response is not JSON'));
              return;
            }
            if (res.statusCode !== 200) {
              reject(
                new BridgeError(
                  parsed?.code ?? 'HTTP_ERROR',
                  parsed?.message ?? `Bridge returned HTTP ${res.statusCode}`,
                ),
              );
            } else resolve(parsed);
          });
        },
      );
      const timer = setTimeout(
        () => req.destroy(new BridgeError('TIMEOUT', `Bridge request exceeded ${timeoutMs}ms`)),
        timeoutMs,
      );
      req.on('close', () => clearTimeout(timer));
      req.on('error', reject);
      req.end(body);
    });
    return toFile ? verifyFileReply(value, request) : verifyReply(value, request);
  }
  return {
    health: (options) => call(null, options),
    // Kept as an explicit HTTP inspection API; never used by MCP/CLI export.
    exportFunction: (request, options) => call(request, options),
    exportFunctionToFile: (request, options) => call(request, options, true),
  };
}

export const exportInputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['schema', 'binary', 'entryAddress'],
  properties: {
    schema: {const: 'ghidra-function-request/v1'},
    binary: {
      type: 'object',
      additionalProperties: false,
      required: ['programPath', 'executableSha256', 'languageId', 'imageBase'],
      properties: {
        programPath: {type: 'string'},
        executableSha256: {type: 'string', pattern: hashPattern.source},
        languageId: {type: 'string'},
        imageBase: {type: 'string', pattern: addressPattern.source},
      },
    },
    entryAddress: {type: 'string', pattern: addressPattern.source},
    representation: {enum: ['raw', 'high', 'both'], default: 'both'},
    limits: {
      type: 'object',
      additionalProperties: false,
      properties: {
        decompileSeconds: {type: 'integer', minimum: 1, maximum: 120},
        maxBodyBytes: {type: 'integer', minimum: 1, maximum: 8388608},
        maxInstructions: {type: 'integer', minimum: 1, maximum: 50000},
        maxPcodeOps: {type: 'integer', minimum: 1, maximum: 100000},
      },
    },
  },
};

export const exportFileInputSchema = {
  ...exportInputSchema,
  required: [...exportInputSchema.required, 'outputPath'],
  properties: {
    ...exportInputSchema.properties,
    schema: {const: 'ghidra-function-file-request/v1'},
    outputPath: {
      type: 'string',
      description:
        'Absolute path to a NEW .json file on the Ghidra host (same local filesystem). Its parent must exist. Existing files and symlinks are never replaced.',
    },
  },
};

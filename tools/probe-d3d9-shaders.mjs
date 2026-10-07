/**
 * Inventory the compiled Direct3D 9 shaders inside DLLs or other binaries, then parse,
 * disassemble and translate each one to GLSL ES 3.00. Shaders are code; nothing is
 * rendered or executed. Run after `npm run build:runtime`.
 *
 *   node tools/probe-d3d9-shaders.mjs [--disasm] [--glsl] [--json] <file...>
 *
 * Blobs come from PE RT_RCDATA resources that start with a shader version token and from a
 * scan of the whole file for embedded vs/ps 2.x/3.0 token streams with a valid end token.
 * A scanned blob inside an already reported resource is not listed twice.
 * Exit status is 1 when any blob fails to parse or translate.
 */
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {parsePeResources} from '../dist/formats/pe/resources.js';
import {
  parseD3D9Shader,
  parseVersionToken,
  opcodeName,
  versionName,
} from '../dist/graphics/d3d9-shader/bytecode.js';
import {findEmbeddedD3D9Shaders} from '../dist/graphics/d3d9-shader/scan.js';
import {disassembleD3D9Shader} from '../dist/graphics/d3d9-shader/disassemble.js';
import {describeConstantType, registerSetNames} from '../dist/graphics/d3d9-shader/ctab.js';
import {TRANSLATED_OPCODES, translateD3D9ShaderToGlsl} from '../dist/graphics/d3d9-shader/glsl.js';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const files = args.filter((a) => !a.startsWith('--'));
if (!files.length) {
  console.error('usage: node tools/probe-d3d9-shaders.mjs [--disasm] [--glsl] [--json] <file...>');
  process.exit(2);
}

const RT_RCDATA = 10;
const registerPrefix = ['b', 'i', 'c', 's'];
const opcodeUse = new Map();
const report = [];
let failures = 0;

function describeBlob(file, location, offset, bytes) {
  const entry = {
    file,
    location,
    fileOffset: offset,
    size: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  try {
    const shader = parseD3D9Shader(bytes);
    entry.version = versionName(shader.version);
    entry.instructions = shader.instructions.length;
    entry.tokens = shader.byteLength / 4;
    entry.creator = shader.constantTable?.creator;
    entry.constants = (shader.constantTable?.constants ?? []).map((c) => ({
      name: c.name,
      register: `${registerPrefix[c.registerSet] ?? '?'}${c.registerIndex}`,
      count: c.registerCount,
      set: registerSetNames[c.registerSet],
      type: describeConstantType(c.type),
    }));
    for (const ins of shader.instructions) {
      const name = opcodeName(ins.opcode);
      opcodeUse.set(name, (opcodeUse.get(name) ?? 0) + 1);
    }
    if (flags.has('--disasm')) entry.disassembly = disassembleD3D9Shader(shader);
    try {
      const glsl = translateD3D9ShaderToGlsl(shader);
      const again = translateD3D9ShaderToGlsl(parseD3D9Shader(bytes.slice()));
      if (again.source !== glsl.source) throw new Error('translation is not deterministic');
      entry.translated = true;
      entry.glslLines = glsl.source.split('\n').length - 1;
      entry.glslSha256 = createHash('sha256').update(glsl.source).digest('hex');
      if (flags.has('--glsl')) entry.glsl = glsl.source;
    } catch (error) {
      entry.translated = false;
      entry.error = String(error?.message ?? error);
      failures++;
    }
  } catch (error) {
    entry.parseError = String(error?.message ?? error);
    failures++;
  }
  return entry;
}

for (const file of files) {
  const bytes = new Uint8Array(await readFile(file));
  const covered = [];
  let resources = [];
  try {
    resources = parsePeResources(bytes, [RT_RCDATA]);
  } catch {
    resources = [];
  }
  for (const resource of resources) {
    const data = resource.bytes;
    if (data.byteLength < 8) continue;
    const version = parseVersionToken(
      new DataView(data.buffer, data.byteOffset).getUint32(0, true),
    );
    if (!version || version.major < 2) continue;
    const offset = data.byteOffset - bytes.byteOffset;
    covered.push([offset, offset + data.byteLength]);
    // Resources may carry alignment padding after the end token.
    const shaderLength = parseD3D9ShaderLength(data);
    report.push(
      describeBlob(
        file,
        `RCDATA/${resource.id}`,
        offset,
        data.subarray(0, shaderLength ?? data.byteLength),
      ),
    );
  }
  for (const embedded of findEmbeddedD3D9Shaders(bytes)) {
    if (covered.some(([start, end]) => embedded.offset >= start && embedded.offset < end)) continue;
    report.push(
      describeBlob(
        file,
        `offset 0x${embedded.offset.toString(16)}`,
        embedded.offset,
        embedded.bytes,
      ),
    );
  }
}

function parseD3D9ShaderLength(data) {
  try {
    return parseD3D9Shader(data).byteLength;
  } catch {
    return undefined;
  }
}

const untranslated = [...opcodeUse.keys()].filter(
  (name) => ![...TRANSLATED_OPCODES].some((op) => opcodeName(op) === name),
);
if (flags.has('--json')) {
  console.log(
    JSON.stringify({blobs: report, opcodes: Object.fromEntries(opcodeUse), untranslated}, null, 2),
  );
} else {
  for (const e of report) {
    const name = e.file.split('/').pop();
    if (e.parseError) {
      console.log(
        `${name} ${e.location} size=${e.size} sha256=${e.sha256} PARSE ERROR: ${e.parseError}`,
      );
      continue;
    }
    console.log(
      `${name} ${e.location} file@0x${e.fileOffset.toString(16)} size=${e.size} sha256=${e.sha256} ${e.version} instructions=${e.instructions} glsl=${e.translated ? 'ok' : `FAILED: ${e.error}`}`,
    );
    for (const c of e.constants) console.log(`    ${c.register}[${c.count}] ${c.type} ${c.name}`);
    if (e.disassembly) console.log(e.disassembly.replace(/^/gm, '    | '));
    if (e.glsl) console.log(e.glsl.replace(/^/gm, '    > '));
  }
  const byFile = new Map();
  for (const e of report) byFile.set(e.file, (byFile.get(e.file) ?? 0) + 1);
  console.log('');
  for (const [file, count] of byFile) console.log(`${file}: ${count} blobs`);
  console.log(
    `total ${report.length} blobs, ${report.filter((e) => e.translated).length} translated, ${failures} failed`,
  );
  console.log(
    `opcodes: ${[...opcodeUse]
      .sort((a, b) => b[1] - a[1])
      .map(([n, c]) => `${n}×${c}`)
      .join(' ')}`,
  );
  console.log(
    `opcodes without translation: ${untranslated.length ? untranslated.join(' ') : 'none'}`,
  );
}
process.exitCode = failures ? 1 : 0;

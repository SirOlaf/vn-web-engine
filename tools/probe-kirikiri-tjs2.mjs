import {createHash} from 'node:crypto';
import {mkdir, open, readFile, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {Xp3Archive} from '../dist/formats/kirikiri/xp3.js';
import {CX_TINY_FILTERS, CxArchive} from '../dist/formats/kirikiri/cx-archive.js';
import {NifPool} from '../dist/compiler/nif/pool.js';
import {readNif, writeNif} from '../dist/compiler/nif/text.js';
import {formatDiagnostic} from '../dist/compiler/diagnostics.js';
import {compileScriptBlock} from '../dist/engines/kirikiri/tjs2/compiler.js';
import {KIRIKIRI_CORE_REVISIONS, tjs2CompilerOptions} from '../dist/engines/kirikiri/revision.js';

/**
 * Compiles every `.tjs` member of the given archives with the TJS2 compiler (parse and
 * analysis, no code generation) and prints counts. A file that fails as statements is retried
 * as an expression (`Scripts.evalStorage` data files). Each analysed tree is also written as
 * NIF text and read back, which must give the same tree and positions. Non-visual.
 *
 *   npm run build:runtime
 *   node tools/probe-kirikiri-tjs2.mjs [--out <dir>] [--stage parsed|analyzed] <core.exe> <plugin.tpm> <archive.xp3>...
 *
 * Compiler options (TJS version, preprocessor values, build flags) come from the core revision.
 *
 * `--out` writes the NIF of each file below <dir> (game-derived: keep it out of the repository).
 */
class FileSource {
  constructor(handle, size) {
    this.handle = handle;
    this.size = size;
  }
  async read(offset, length) {
    const bytes = new Uint8Array(length);
    const {bytesRead} = await this.handle.read(bytes, 0, length, offset);
    if (bytesRead !== length) throw new Error('Short read');
    return bytes;
  }
}

function decodeText(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe)
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    return new TextDecoder().decode(bytes.subarray(3));
  return new TextDecoder('shift_jis').decode(bytes);
}

const args = process.argv.slice(2);
let outDir = null,
  stage = 'analyzed';
while (args[0]?.startsWith('--')) {
  const flag = args.shift();
  if (flag === '--out') outDir = args.shift();
  else if (flag === '--stage') stage = args.shift();
  else throw new Error(`Unknown flag ${flag}`);
}
const [core, plugin, ...archives] = args;
if (!core || !plugin || !archives.length) {
  console.error(
    'usage: probe-kirikiri-tjs2.mjs [--out <dir>] [--stage parsed|analyzed] <core.exe> <plugin.tpm> <archive.xp3>...',
  );
  process.exit(2);
}
const coreHash = createHash('sha256')
  .update(await readFile(core))
  .digest('hex');
const revision = KIRIKIRI_CORE_REVISIONS.get(coreHash);
if (!revision) throw new Error(`No Kirikiri core revision known for ${coreHash}`);
const pluginHash = createHash('sha256')
  .update(await readFile(plugin))
  .digest('hex');
const filter = CX_TINY_FILTERS.get(pluginHash);
if (!filter) throw new Error(`No tiny filter known for plugin ${pluginHash}`);

const pool = new NifPool();
const options = tjs2CompilerOptions(
  revision,
  {uiLanguage: 0x0409, executable: await readFile(core)},
  pool,
);
const totals = {
  files: 0,
  expressions: 0,
  ok: 0,
  failed: 0,
  warnings: 0,
  textRoundTrips: 0,
  lines: 0,
  chars: 0,
  tokens: 0,
  analyzedTokens: 0,
  ms: 0,
};
const failures = [];

function samePositions(a, pa, b, pb) {
  const n = a.end(pa) - pa,
    x = [0, 0, 0],
    y = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    a.pool.unpack(a.info(pa + i), x);
    b.pool.unpack(b.info(pb + i), y);
    if (x[0] !== y[0] || x[1] !== y[1] || x[2] !== y[2]) return false;
  }
  return true;
}
for (const path of archives) {
  const handle = await open(path),
    {size} = await handle.stat();
  try {
    const cx = new CxArchive(await Xp3Archive.open(new FileSource(handle, size)), filter);
    for (const record of cx.names) {
      if (!record.name.toLowerCase().endsWith('.tjs')) continue;
      const entry = cx.find(record.name);
      if (!entry) continue;
      const text = decodeText(await cx.readEntry(entry));
      const t0 = performance.now();
      // Data files are loaded with Scripts.evalStorage, i.e. compiled as expressions.
      let result = compileScriptBlock({text, name: record.name, mode: 'statements'}, options);
      if (result.diagnostics.errorCount) {
        const expression = compileScriptBlock(
          {text, name: record.name, mode: 'expression', resultNeeded: true},
          options,
        );
        if (!expression.diagnostics.errorCount) {
          result = expression;
          totals.expressions++;
        }
      }
      totals.ms += performance.now() - t0;
      totals.files++;
      totals.lines += result.source.lineCount;
      totals.chars += text.length;
      totals.tokens += result.tree.length;
      if (result.analyzed) totals.analyzedTokens += result.analyzed.length;
      totals.warnings += result.diagnostics.list.length - result.diagnostics.errorCount;
      // The analysed tree must survive the NIF text form unchanged.
      if (result.analyzed) {
        const back = readNif(
          writeNif(result.analyzed, [result.analyzedRoot]),
          pool,
          result.analyzed.tags,
        );
        const root = back.roots[0];
        if (
          back.buffer.sameTree(root, result.analyzed, result.analyzedRoot) &&
          samePositions(back.buffer, root, result.analyzed, result.analyzedRoot)
        )
          totals.textRoundTrips++;
        else failures.push(`${record.name}: NIF text round trip differs`);
      }
      if (result.diagnostics.errorCount) {
        totals.failed++;
        failures.push(...result.diagnostics.errors.map(formatDiagnostic));
      } else totals.ok++;
      if (outDir && result.root >= 0) {
        const tree = stage === 'parsed' ? result.tree : result.analyzed;
        const root = stage === 'parsed' ? result.root : result.analyzedRoot;
        if (tree && root >= 0) {
          const file = join(outDir, record.name + `.${stage === 'parsed' ? 'p' : 's'}.nif`);
          await mkdir(dirname(file), {recursive: true});
          await writeFile(file, writeNif(tree, [root]));
        }
      }
    }
  } finally {
    await handle.close();
  }
}
console.log(JSON.stringify({...totals, ms: Math.round(totals.ms)}));
for (const f of failures.slice(0, 40)) console.log(f);
if (failures.length > 40) console.log(`… ${failures.length - 40} more`);

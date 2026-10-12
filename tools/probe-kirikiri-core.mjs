import {readdirSync, statSync} from 'node:fs';
import {open, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {KirikiriCore} from '../dist/engines/kirikiri/core/kirikiri-core.js';
import {NEKOPARA_VOL1_TPM} from '../dist/native/nekopara_vol1.tpm/library.js';
import {compileScriptBlock} from '../dist/engines/kirikiri/tjs2/compiler.js';
import {tjs2CompilerOptions} from '../dist/engines/kirikiri/revision.js';
import {TjsCompileError} from '../dist/engines/kirikiri/tjs2/runtime/errors.js';

/**
 * Boots the Kirikiri core on an installation in Node: selects the project directory, links the
 * `.tpm` plugins, reads `startup.tjs` through the storage system and hands it to a stand-in
 * script executor that compiles each block and stops (there is no VM yet). Prints the core log
 * and what the executor received. Non-visual.
 *
 *   npm run build:runtime
 *   node tools/probe-kirikiri-core.mjs <game folder> [<executable name>]
 *
 * The installation is mounted as `c:\game\`.
 */
const [folder, exeName = 'nekopara_vol1.exe'] = process.argv.slice(2);
if (!folder) {
  console.error('usage: node tools/probe-kirikiri-core.mjs <game folder> [<executable name>]');
  process.exit(2);
}

const ROOT = 'c:\\game\\';

/** Local Windows names under c:\game\ → host paths, matched case-insensitively. */
function hostPath(local) {
  const lower = local.toLowerCase();
  if (!lower.startsWith(ROOT)) return null;
  let path = folder;
  for (const part of local.slice(ROOT.length).split('\\').filter(Boolean)) {
    let entries;
    try {
      entries = readdirSync(path);
    } catch {
      return null;
    }
    const found = entries.find((e) => e.toLowerCase() === part.toLowerCase());
    if (!found) return null;
    path = join(path, found);
  }
  return path;
}

const handles = new Map();
const files = {
  exists(local) {
    const p = hostPath(local);
    return p !== null && statSync(p).isFile();
  },
  list(dir) {
    const p = hostPath(dir);
    if (p === null) return [];
    try {
      return readdirSync(p).filter((e) => statSync(join(p, e)).isFile());
    } catch {
      return [];
    }
  },
  async open(local) {
    const p = hostPath(local);
    let handle = handles.get(p);
    if (!handle) handles.set(p, (handle = await open(p, 'r')));
    const {size} = await handle.stat();
    return {
      size,
      async read(offset, length) {
        const n = Math.max(0, Math.min(length, size - offset));
        const buf = Buffer.alloc(n);
        await handle.read(buf, 0, n, offset);
        return new Uint8Array(buf.buffer, buf.byteOffset, n);
      },
    };
  },
  write(local) {
    throw new Error(`write ${local}: the probe is read-only`);
  },
};

const executable = new Uint8Array(await readFile(join(folder, exeName)));
const start = performance.now();
const clock = {
  tickCount: () => Math.floor(performance.now()),
  time: () => Math.floor(Date.now() / 1000),
  localTime: (s) => {
    const d = new Date(s * 1000);
    return {hours: d.getHours(), minutes: d.getMinutes(), seconds: d.getSeconds()};
  },
};

const core = await KirikiriCore.create({
  executable,
  executablePath: ROOT + exeName,
  uiLanguage: 0x0411,
  files,
  libraries: [NEKOPARA_VOL1_TPM],
  clock,
  output: (line, important) => console.log(important ? `! ${line}` : `  ${line}`),
});

const revision = core.revision;
const options = tjs2CompilerOptions(revision, {uiLanguage: 0x0411, executable});
const blocks = [];
core.engine.executor = {
  runByteCode: () => false,
  run(block) {
    const compiled = compileScriptBlock(
      {text: block.text, name: block.name, mode: block.mode},
      options,
    );
    blocks.push({
      name: block.name,
      mode: block.mode,
      chars: block.text.length,
      errors: compiled.diagnostics.errorCount,
    });
    if (compiled.diagnostics.errorCount)
      throw new TjsCompileError(`compile error in ${block.name}`, null);
    throw new Error(`no TJS2 VM: stopped before running ${block.name}`);
  },
};

try {
  await core.start();
} catch (e) {
  console.log(`stopped: ${e.message}`);
}
console.log('');
console.log(`project directory: ${core.projectDir}`);
console.log(`plugins: ${core.plugins.names.join(', ') || '(none)'}`);
for (const b of blocks)
  console.log(`script block: ${b.name} (${b.mode}, ${b.chars} chars, ${b.errors} compile errors)`);
console.log(`time: ${(performance.now() - start).toFixed(0)} ms`);
core.shutdown();
for (const h of handles.values()) await h.close();

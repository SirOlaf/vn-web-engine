/**
 * Numerical format verification for a local codeX RScript installation. It decodes every
 * archive entry it recognizes and prints only counts and failures; it never writes or
 * renders game assets. Run after `npm run build:runtime`:
 *
 *   node tools/verify-rscript.mjs "/path/to/game"
 */
import {readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {openSource} from './file-source.mjs';
import {XflArchive} from '../dist/formats/rscript/xfl.js';
import {decodeWcg} from '../dist/formats/rscript/wcg.js';
import {LwgImage} from '../dist/formats/rscript/lwg.js';
import {decodeGscInstruction, parseGsc} from '../dist/formats/rscript/gsc.js';
import {parseFsc} from '../dist/formats/rscript/fsc.js';
import {parseWave, waveOggStream} from '../dist/formats/riff/wave.js';
import {RSCRIPT_1_11_LAYOUTS} from '../dist/engines/rscript/vm/layouts.js';

const root = resolve(process.argv[2] ?? 'targetgame/rscript');
const counts = {};
const failures = [];
const count = (kind) => (counts[kind] = (counts[kind] ?? 0) + 1);

async function inspect(archive, entry, path) {
  const extension = entry.name.slice(entry.name.lastIndexOf('.') + 1).toLowerCase();
  if (extension === 'xfl') {
    await walk(await XflArchive.open(archive.entrySource(entry)), `${path}/`);
    return;
  }
  const bytes = await archive.read(entry);
  if (extension === 'wcg') {
    const image = decodeWcg(bytes);
    if (image.pixels.length !== image.width * image.height * 4) throw new Error('size');
  } else if (extension === 'lwg') {
    const lwg = await LwgImage.open(archive.entrySource(entry));
    for (const layer of lwg.entries) {
      if (layer.format !== 8) throw new Error(`layer format ${layer.format}`);
      decodeWcg(await lwg.read(layer));
      count('lwg layer');
    }
  } else if (extension === 'gsc') {
    const program = parseGsc(bytes);
    for (let offset = 0; offset < program.code.length;) {
      const instruction = decodeGscInstruction(program.code, offset, RSCRIPT_1_11_LAYOUTS);
      offset = instruction.next;
      count('gsc instruction');
    }
  } else if (extension === 'fsc') {
    for (const instruction of parseFsc(bytes)) {
      if (instruction.op === 'frame') count('fsc frame');
    }
  } else if (extension === 'wav') {
    const wave = parseWave(bytes);
    count(wave.formatTag === 1 ? 'wav pcm' : waveOggStream(wave) ? 'wav vorbis' : 'wav other');
  }
  count(extension);
}

async function walk(archive, prefix) {
  for (const entry of archive.entries) {
    const path = prefix + entry.name;
    try {
      await inspect(archive, entry, path);
    } catch (error) {
      failures.push(`${path}: ${error instanceof Error ? error.message : error}`);
    }
  }
}

for (const name of (await readdir(root)).filter((n) => /\.xfl$/i.test(n)).sort()) {
  const source = await openSource(resolve(root, name));
  try {
    await walk(await XflArchive.open(source), `${name}/`);
  } finally {
    await source.close();
  }
}
console.log(JSON.stringify(counts, null, 2));
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
}

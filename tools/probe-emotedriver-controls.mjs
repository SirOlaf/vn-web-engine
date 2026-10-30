import {createHash} from 'node:crypto';
import {open, readFile} from 'node:fs/promises';
import {Xp3Archive} from '../dist/formats/kirikiri/xp3.js';
import {CX_TINY_FILTERS, CxArchive} from '../dist/formats/kirikiri/cx-archive.js';
import {EMOTE_PSB_KEYS, decryptPsbBody} from '../dist/formats/kirikiri/psb-filter.js';
import {readEmoteModel} from '../dist/formats/kirikiri/emote-model.js';
import {
  EmoteXorshift128,
  createEmoteControls,
} from '../dist/native/emotedriver/runtime/controls/index.js';

/**
 * Non-visual run of the E-mote controls on every model of the given archives: builds the
 * control set from each model's metadata, drives it with a fake host (no base-layer points,
 * fixed seed, a wind, a lip-sync ramp and eye/eyebrow requests) and prints per-file control
 * counts, NaN counts and the SHA-256 of the output variable sequence. Pixel data is never
 * decoded.
 *
 *   npm run build:runtime
 *   node tools/probe-emotedriver-controls.mjs <plugin.tpm> <emotedriver.dll> <archive.xp3>... [--frames N]
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

const sha256 = async (path) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');

const args = process.argv.slice(2);
const framesAt = args.indexOf('--frames');
const FRAMES = framesAt >= 0 ? Number(args.splice(framesAt, 2)[1]) : 600;
const [plugin, runtime, ...archives] = args;
if (!plugin || !runtime || !archives.length) {
  console.error('usage: probe-emotedriver-controls.mjs <plugin.tpm> <dll> <xp3>... [--frames N]');
  process.exit(2);
}
const filter = CX_TINY_FILTERS.get(await sha256(plugin));
if (!filter) throw new Error('No tiny filter known for the storage plugin');
const key = EMOTE_PSB_KEYS.get(await sha256(runtime));
if (key === undefined) throw new Error('No E-mote key known for the runtime');

function run(model) {
  const md = model.metadata;
  const random = new EmoteXorshift128(1);
  const controls = createEmoteControls(md, {random: () => random.next()});
  const cells = new Map();
  const host = {
    variable(label) {
      if (!cells.has(label)) cells.set(label, {label, value: 0});
      return cells.get(label);
    },
    clips: [],
    currentClip: 0,
    rootAngle: 5,
    hairScale: 1,
    partsScale: 1,
    bustScale: 1,
    random: () => random.next(),
    wind: null,
  };
  const scale = Math.fround(md.scale);
  controls.createWind(Math.fround(-500 / scale), Math.fround(500 / scale));
  controls.configureWind(1, 2, Math.fround(8 / scale));
  const bind = new Map();
  for (const type of [4, 5, 6, 8])
    controls.bindVariables(type, (label, index) => bind.set(label, [type, index]));
  const hash = createHash('sha256');
  let nans = 0;
  for (let frame = 0; frame < FRAMES; frame++) {
    if (frame % 120 === 0)
      for (const [label, [type, index]] of bind)
        if (type !== 6)
          controls.setVariable(type, index, label, (frame / 120) % 3 ? 10 : 0, 20, 1, false);
    for (const m of controls.mouths)
      if (frame % 6 === 0) {
        const [, index] = bind.get(m.talkLabel);
        controls.setVariable(6, index, m.talkLabel, (frame / 6) % 2, 3, 1, false);
      }
    controls.stepEyes(host, 1);
    controls.stepEyebrows(host, 1);
    controls.stepMouths(host, 1);
    controls.stepSelectors(host, 1);
    controls.stepLoops(host, 1);
    if (controls.windActive()) controls.stepWind(host, 1);
    controls.stepPhysics(host, 1);
    const values = new Float32Array([...cells.values()].map((c) => c.value));
    for (const v of values) if (Number.isNaN(v)) nans++;
    hash.update(new Uint8Array(values.buffer));
  }
  return {
    bust: controls.busts.length,
    hair: controls.hair.length,
    parts: controls.parts.length,
    eye: controls.eyes.length,
    eyebrow: controls.eyebrows.length,
    mouth: controls.mouths.length,
    selector: controls.selectors.length,
    loop: controls.loops.length,
    variables: cells.size,
    nans,
    sha256: hash.digest('hex').slice(0, 16),
  };
}

for (const path of archives) {
  const handle = await open(path),
    {size} = await handle.stat();
  try {
    const cx = new CxArchive(await Xp3Archive.open(new FileSource(handle, size)), filter);
    for (const record of cx.names) {
      if (!/\.psb$/i.test(record.name)) continue;
      const entry = cx.find(record.name);
      if (!entry) continue;
      let model;
      try {
        model = readEmoteModel(decryptPsbBody(await cx.readEntry(entry), key));
      } catch (error) {
        console.log(JSON.stringify({file: record.name, error: error.message}));
        continue;
      }
      console.log(JSON.stringify({file: record.name, ...run(model)}));
    }
  } finally {
    await handle.close();
  }
}

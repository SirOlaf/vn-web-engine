import {createHash} from 'node:crypto';
import {open, readFile} from 'node:fs/promises';
import {Xp3Archive} from '../dist/formats/kirikiri/xp3.js';
import {CX_TINY_FILTERS, CxArchive} from '../dist/formats/kirikiri/cx-archive.js';
import {EMOTE_PSB_KEYS, decryptPsbBody} from '../dist/formats/kirikiri/psb-filter.js';
import {readEmoteModel, walkEmoteLayers} from '../dist/formats/kirikiri/emote-model.js';
import {createEmoteClip} from '../dist/native/emotedriver/runtime/clip.js';
import {
  createEmoteMeshKernel,
  emoteMeshKernelJs,
} from '../dist/native/emotedriver/runtime/mesh/index.js';

/**
 * Non-visual probe of the emotedriver clip (MMotionPlayer) on real E-mote files. For every
 * motion of every model it plays the clip for N frames, sweeps each clip parameter, evaluates
 * the layer pass and prints counts, NaN checks, timings and SHA-256 digests of node state and
 * vertex arrays. It also prints the feature-flag and layer-type census the runtime's
 * unsupported paths are keyed by. Pixels are never decoded.
 *
 *   npm run build:runtime
 *   node tools/probe-emotedriver-clip.mjs <plugin.tpm> <emotedriver.dll> <archive.xp3>... \
 *     [--frames N] [--js] [--compare]
 *
 * `--js` uses the TypeScript mesh kernel; `--compare` also runs every motion with the other
 * kernel and reports digest mismatches.
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
const flag = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return null;
  args.splice(i, 1);
  return true;
};
const option = (name, fallback) => {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const frames = Number(option('--frames', 120));
const useJs = flag('--js'),
  compare = flag('--compare');
const [plugin, runtime, ...archives] = args;
if (!plugin || !runtime || !archives.length) {
  console.error('usage: probe-emotedriver-clip.mjs <plugin.tpm> <emotedriver.dll> <xp3>...');
  process.exit(2);
}
const filter = CX_TINY_FILTERS.get(await sha256(plugin));
const key = EMOTE_PSB_KEYS.get(await sha256(runtime));
if (!filter || key === undefined) throw new Error('Unknown storage plugin or E-mote runtime');

const wasmKernel = createEmoteMeshKernel();
const kernelA = useJs ? emoteMeshKernelJs : wasmKernel,
  kernelB = useJs ? wasmKernel : emoteMeshKernelJs;

class Tally {
  constructor() {
    this.map = new Map();
  }
  add(k, n = 1) {
    this.map.set(k, (this.map.get(k) ?? 0) + n);
  }
  toJSON() {
    return Object.fromEntries([...this.map].sort((a, b) => b[1] - a[1]));
  }
}

/** Runs one motion; returns digests and counters. */
function play(model, motion, kernel) {
  const clip = createEmoteClip(model, motion, {kernel});
  clip.rootVisible = true;
  const state = createHash('sha256'),
    vertices = createHash('sha256');
  const r = {nan: 0, grids: 0, vertices: 0, events: 0, nested: 0, ms: 0};
  const params = motion.parameters;
  const t0 = performance.now();
  for (let frame = 0; frame < frames; frame++) {
    // Sweep each parameter across its range over the run.
    for (const p of params) {
      const k = (frame % 60) / 59;
      clip.applyVariable(p.id, p.rangeBegin + (p.rangeEnd - p.rangeBegin) * k);
    }
    clip.advance(1);
    clip.evaluate();
    r.events += clip.events.length;
    clip.dispatchEvents({action() {}, sync() {}});
    const visit = (c) => {
      for (const n of c.nodes) {
        const s = new Float32Array([
          n.x,
          n.y,
          n.z,
          n.angle,
          n.zoomX,
          n.zoomY,
          n.slantX,
          n.slantY,
          n.opacity,
          n.visible ? 1 : 0,
          ...n.matrix,
        ]);
        for (const v of s) if (Number.isNaN(v)) r.nan++;
        state.update(new Uint8Array(s.buffer));
        state.update(new Uint8Array(new Uint32Array(n.colors).buffer));
        const g = n.grid;
        if (g && n.shown) {
          r.grids++;
          r.vertices += g.positions.length / 2;
          for (const v of g.positions) if (Number.isNaN(v)) r.nan++;
          vertices.update(new Uint8Array(g.positions.buffer, 0, g.positions.byteLength));
        }
        if (n.child) {
          r.nested++;
          visit(n.child);
        }
      }
    };
    visit(clip);
  }
  r.ms = performance.now() - t0;
  r.state = state.digest('hex');
  r.vertices = r.vertices;
  r.vertexHash = vertices.digest('hex');
  return r;
}

for (const path of archives) {
  const handle = await open(path),
    {size} = await handle.stat();
  const cx = new CxArchive(await Xp3Archive.open(new FileSource(handle, size)), filter);
  const census = {
    files: 0,
    motions: 0,
    features: new Tally(),
    layerTypes: new Tally(),
    inheritMask: new Tally(),
    meshSync: new Tally(),
    errors: new Tally(),
  };
  const totals = {nan: 0, grids: 0, vertices: 0, events: 0, nested: 0, ms: 0, mismatches: 0};
  const all = createHash('sha256');
  for (const record of cx.names) {
    if (!/\.psb$/i.test(record.name)) continue;
    const model = readEmoteModel(decryptPsbBody(await cx.readEntry(cx.find(record.name)), key));
    census.files++;
    for (const [objectName, object] of model.objects)
      for (const [motionName, motion] of object.motions) {
        census.motions++;
        let features = 0;
        for (const {layer} of walkEmoteLayers(motion.layers)) {
          features |= 1 << layer.type;
          census.layerTypes.add(layer.type);
          census.inheritMask.add('0x' + layer.inheritMask.toString(16));
          if (layer.mesh) census.meshSync.add(layer.mesh.syncChildMask);
        }
        census.features.add('0x' + features.toString(16));
        try {
          const a = play(model, motion, kernelA);
          for (const k of ['nan', 'grids', 'vertices', 'events', 'nested', 'ms']) totals[k] += a[k];
          all.update(`${record.name}/${objectName}/${motionName}:${a.state}:${a.vertexHash}\n`);
          if (compare) {
            const b = play(model, motion, kernelB);
            if (b.state !== a.state || b.vertexHash !== a.vertexHash) totals.mismatches++;
          }
        } catch (error) {
          census.errors.add(`${error.name}: ${error.message}`);
        }
      }
  }
  await handle.close();
  totals.ms = Math.round(totals.ms);
  console.log(
    JSON.stringify(
      {archive: path.split('/').pop(), frames, census, totals, digest: all.digest('hex')},
      null,
      2,
    ),
  );
}

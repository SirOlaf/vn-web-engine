import {createHash} from 'node:crypto';
import {open, readFile} from 'node:fs/promises';
import {basename} from 'node:path';
import {Xp3Archive} from '../dist/formats/kirikiri/xp3.js';
import {CX_TINY_FILTERS, CxArchive} from '../dist/formats/kirikiri/cx-archive.js';
import {NativeLibraryLoader} from '../dist/platform/native-libraries.js';
import {EMOTE_DRIVER} from '../dist/native/emotedriver/contract.js';
import {emoteDriverLibrary, extractEmoteShaderBlobs} from '../dist/native/emotedriver/library.js';

/**
 * End-to-end, non-visual probe of `emotedriver.dll` through its contract: the loader resolves
 * the library by the installation's SHA-256, `emoteCreate` runs on a counting D3D9 device, and
 * every E-mote file of the given archives is loaded as a player that plays each main timeline,
 * progresses and renders for N frames. Prints call counts, failures and SHA-256 digests of
 * the variable values and of the vertex streams handed to `DrawPrimitiveUP`. Texture bytes
 * are uploaded into the counting device and hashed only by length; nothing is decoded or shown.
 *
 *   npm run build:runtime
 *   node tools/probe-emotedriver.mjs <plugin.tpm> <emotedriver.dll> <archive.xp3>... \
 *     [--frames N] [--limit N] [--no-shaders]
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

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
};
const flag = (name) => {
  const i = args.indexOf(name);
  if (i >= 0) args.splice(i, 1);
  return i >= 0;
};
const frames = Number(option('--frames', 60));
const limit = Number(option('--limit', Infinity));
const noShaders = flag('--no-shaders');
const [plugin, runtime, ...archives] = args;
if (!plugin || !runtime || !archives.length) {
  console.error('usage: probe-emotedriver.mjs <plugin.tpm> <emotedriver.dll> <xp3>...');
  process.exit(2);
}
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const runtimeBytes = new Uint8Array(await readFile(runtime));
const filter = CX_TINY_FILTERS.get(sha256(await readFile(plugin)));
if (!filter) throw new Error('Unknown storage plugin');

/** Counting `IDirect3DDevice9`: plausible results, per-member call counts, vertex digest. */
function countingDevice() {
  const counts = new Map();
  const count = (name) => counts.set(name, (counts.get(name) ?? 0) + 1);
  const vertices = createHash('sha256');
  const ok = (value) => ({hr: 0, value});
  const unknown = () => ({addRef: () => 1, release: () => 0});
  const surface = (width, height) => ({
    ...unknown(),
    getDesc: () => ({format: 21, usage: 1, pool: 0, width, height}),
  });
  const states = new Map();
  const viewport = {x: 0, y: 0, width: 1280, height: 720, minZ: 0, maxZ: 1};
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  let uploaded = 0;
  const device = {
    counts,
    vertices,
    get uploaded() {
      return uploaded;
    },
    addRef: () => 2,
    release: () => 1,
    testCooperativeLevel: () => 0,
    getDirect3D: () =>
      ok({
        ...unknown(),
        getAdapterDisplayMode: () => ok({width: 1280, height: 720, refreshRate: 60, format: 22}),
        checkDeviceFormat: (_a, _t, _f, _u, _r, format) =>
          [21, 22, 23, 0x35545844].includes(format) ? 0 : -1,
      }),
    getDeviceCaps: () =>
      ok({
        maxTextureWidth: 8192,
        maxTextureHeight: 8192,
        textureCaps: 0x4000,
        vertexShaderVersion: noShaders ? 0xfffe0000 : 0xfffe0300,
        pixelShaderVersion: noShaders ? 0xffff0000 : 0xffff0300,
      }),
    getDisplayMode: () => ok({width: 1280, height: 720, refreshRate: 60, format: 22}),
    createTexture(width, height, levels, usage, format) {
      count('createTexture');
      return ok({
        ...unknown(),
        getLevelDesc: () => ok({format, usage, pool: 0, width, height}),
        getSurfaceLevel: () => ok(surface(width, height)),
        lockRect(level) {
          count('lockRect');
          const w = Math.max(1, width >> level),
            h = Math.max(1, height >> level),
            dxt = format === 0x35545844,
            pitch = dxt ? Math.ceil(w / 4) * 16 : w * 4,
            bits = new Uint8Array(pitch * (dxt ? Math.ceil(h / 4) : h));
          uploaded += bits.length;
          return ok({pitch, bits});
        },
        unlockRect: () => 0,
      });
    },
    setRenderTarget: () => (count('setRenderTarget'), 0),
    getRenderTarget: () => ok(surface(1280, 720)),
    clear: () => (count('clear'), 0),
    setTransform: () => 0,
    getTransform: () => ok(identity),
    setViewport: () => 0,
    getViewport: () => ok(viewport),
    setRenderState: (state, value) => (states.set(state, value), count('setRenderState'), 0),
    getRenderState: (state) => ok(states.get(state) ?? 0),
    getTexture: () => ok(null),
    setTexture: () => (count('setTexture'), 0),
    getTextureStageState: () => ok(0),
    setTextureStageState: () => 0,
    getSamplerState: () => ok(0),
    setSamplerState: () => 0,
    setScissorRect: () => 0,
    getScissorRect: () => ok({left: 0, top: 0, right: 1280, bottom: 720}),
    drawPrimitiveUP(type, primitives, bytes, stride) {
      count('drawPrimitiveUP');
      vertices.update(bytes);
      return 0;
    },
    setFVF: () => 0,
    getFVF: () => ok(0),
    createVertexShader: () => (count('createVertexShader'), ok(unknown())),
    setVertexShader: () => 0,
    getVertexShader: () => ok(null),
    setVertexShaderConstantF: () => 0,
    getVertexShaderConstantF: (_r, n) => ok(new Float32Array(4 * n)),
    createPixelShader: () => (count('createPixelShader'), ok(unknown())),
    setPixelShader: () => 0,
    getPixelShader: () => ok(null),
    setPixelShaderConstantF: () => 0,
  };
  return device;
}

const runtimeSha = sha256(runtimeBytes);
const loader = new NativeLibraryLoader(
  [emoteDriverLibrary({shaders: noShaders ? null : extractEmoteShaderBlobs(runtimeBytes)})],
  {
    locate: (fileName) =>
      fileName.toLowerCase() === 'emotedriver.dll' ? {kind: 'image', sha256: runtimeSha} : null,
  },
);
const loaded = loader.load('emotedriver.dll');
if (loaded.status !== 'loaded') throw new Error(`emotedriver.dll: ${loaded.status}`);
const driver = loaded.library.exports(EMOTE_DRIVER);
const d3d = countingDevice();
const emote = driver.emoteCreate({device: d3d});
emote.setAlphaMaskEnabled(1);

const failures = new Map();
let files = 0,
  players = 0,
  timelines = 0,
  rendered = 0;
const variables = createHash('sha256');
const started = performance.now();
for (const path of archives) {
  const handle = await open(path),
    {size} = await handle.stat();
  const cx = new CxArchive(await Xp3Archive.open(new FileSource(handle, size)), filter);
  let inArchive = 0;
  for (const record of cx.names) {
    if (!/\.psb$/i.test(record.name) || inArchive >= limit) continue;
    inArchive++;
    files++;
    const data = await cx.readEntry(cx.find(record.name));
    try {
      const player = emote.createPlayer(data);
      if (player === null) throw new Error('createPlayer returned null');
      players++;
      player.show();
      const mains = player.countMainTimelines();
      for (let t = 0; t < mains; t++) {
        const label = player.getMainTimelineLabelAt(t);
        player.playTimeline(label, 0);
        timelines++;
        for (let f = 0; f < frames; f++) {
          player.progress(1);
          player.render();
          rendered++;
        }
        player.stopTimeline(label);
      }
      const n = player.countVariables();
      const values = new Float32Array(n);
      for (let v = 0; v < n; v++) values[v] = player.getVariable(player.getVariableLabelAt(v));
      variables.update(new Uint8Array(values.buffer));
      player.release();
    } catch (error) {
      const key = `${error?.constructor?.name}: ${String(error?.message).slice(0, 120)}`;
      failures.set(key, [...(failures.get(key) ?? []), `${basename(path)}:${record.name}`]);
    }
  }
  await handle.close();
}
emote.release();
loader.dispose();

console.log(`shader level: ${noShaders ? 'fixed function' : 'blobs from emotedriver.dll'}`);
console.log(
  `files ${files}, players ${players}, main timelines ${timelines}, frames rendered ${rendered}, ` +
    `${((performance.now() - started) / 1000).toFixed(1)} s`,
);
console.log(`texture bytes uploaded ${d3d.uploaded}`);
console.log('calls', Object.fromEntries([...d3d.counts].sort()));
console.log(`vertex stream sha256 ${d3d.vertices.digest('hex')}`);
console.log(`variable values sha256 ${variables.digest('hex')}`);
console.log(`failures ${[...failures.values()].reduce((a, b) => a + b.length, 0)}`);
for (const [message, where] of failures)
  console.log(`  ${where.length}× ${message} (e.g. ${where[0]})`);

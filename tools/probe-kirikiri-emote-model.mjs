import {createHash} from 'node:crypto';
import {open, readFile} from 'node:fs/promises';
import {Xp3Archive} from '../dist/formats/kirikiri/xp3.js';
import {CX_TINY_FILTERS, CxArchive} from '../dist/formats/kirikiri/cx-archive.js';
import {EMOTE_PSB_KEYS, decryptPsbBody} from '../dist/formats/kirikiri/psb-filter.js';
import {
  EmoteContentMask,
  readEmoteModel,
  walkEmoteLayers,
} from '../dist/formats/kirikiri/emote-model.js';

/**
 * Non-visual census of E-mote files through the typed model reader. Prints counts of layers,
 * keyframes, content fields, enum values, controls, easing use, tolerated native aborts and
 * keys the runtime does not read. Pixel data is never decoded.
 *
 *   npm run build:runtime
 *   node tools/probe-kirikiri-emote-model.mjs <plugin.tpm> <emotedriver.dll> <archive.xp3>...
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

const [plugin, runtime, ...archives] = process.argv.slice(2);
if (!plugin || !runtime || !archives.length) {
  console.error('usage: probe-kirikiri-emote-model.mjs <plugin.tpm> <emote runtime dll> <xp3>...');
  process.exit(2);
}
const filter = CX_TINY_FILTERS.get(await sha256(plugin));
if (!filter) throw new Error('No tiny filter known for the storage plugin');
const key = EMOTE_PSB_KEYS.get(await sha256(runtime));
if (key === undefined) throw new Error('No E-mote key known for the runtime');

const MASK_NAMES = Object.entries(EmoteContentMask);
const CONTROLS = [
  'bustControl',
  'hairControl',
  'partsControl',
  'eyeControl',
  'eyebrowControl',
  'mouthControl',
  'transitionControl',
  'selectorControl',
  'clampControl',
  'loopControl',
];

class Tally {
  constructor() {
    this.map = new Map();
  }
  add(value, n = 1) {
    this.map.set(value, (this.map.get(value) ?? 0) + n);
  }
  toJSON() {
    return Object.fromEntries([...this.map].sort((a, b) => b[1] - a[1]));
  }
}

for (const path of archives) {
  const handle = await open(path),
    {size} = await handle.stat();
  const c = {
    archive: path.split('/').pop(),
    parsed: 0,
    failed: 0,
    spec: new Tally(),
    version: new Tally(),
    motions: 0,
    layers: 0,
    layerType: new Tally(),
    maxDepth: 0,
    inheritMask: new Tally(),
    stencilType: new Tally(),
    meshTransform: new Tally(),
    meshDivision: new Tally(),
    transformOrder: new Tally(),
    frames: 0,
    frameType: new Tally(),
    contentField: new Tally(),
    bpPatches: 0,
    bpNull: 0,
    blendMode: new Tally(),
    contentEasingRefs: 0,
    parametersPerMotion: new Tally(),
    variablesPerFile: new Tally(),
    timelinesPerFile: new Tally(),
    diffTimelines: 0,
    timelineFrames: 0,
    timelineEasing: new Tally(),
    easingTableSize: new Tally(),
    controls: new Tally(),
    disabledControls: new Tally(),
    textures: new Tally(),
    icons: 0,
    diagnostics: new Tally(),
    unread: new Tally(),
  };
  const unread = (scope, u) => {
    for (const k of Object.keys(u)) c.unread.add(`${scope}.${k}`);
  };
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
        c.failed++;
        console.error(`${record.name}: ${error.message}`);
        continue;
      }
      c.parsed++;
      c.spec.add(model.spec);
      c.version.add(model.version);
      c.easingTableSize.add(model.easing?.length ?? 'absent');
      unread('$', model.unread);
      for (const d of model.diagnostics) c.diagnostics.add(`${d.kind}: ${d.text}`);
      for (const source of model.sources.values()) {
        if (source.texture)
          c.textures.add(
            `${source.texture.type} ${source.texture.width}x${source.texture.height} mip${source.texture.mipMap.length}`,
          );
        c.icons += source.icons.size;
      }
      for (const object of model.objects.values())
        for (const motion of object.motions.values()) {
          c.motions++;
          c.parametersPerMotion.add(motion.parameters.length);
          unread('motion', motion.unread);
          for (const {layer, depth} of walkEmoteLayers(motion.layers)) {
            c.layers++;
            c.maxDepth = Math.max(c.maxDepth, depth);
            c.layerType.add(layer.type);
            c.inheritMask.add(layer.inheritMask);
            c.stencilType.add(layer.stencilType);
            c.meshTransform.add(layer.meshTransform);
            if (layer.mesh) c.meshDivision.add(layer.mesh.division);
            c.transformOrder.add(layer.transformOrder.join(','));
            unread(`layer${layer.type}`, layer.unread);
            for (const frame of layer.frames) {
              c.frames++;
              c.frameType.add(frame.type);
              const content = frame.content;
              if (!content) continue;
              for (const [name, bit] of MASK_NAMES)
                if (content.mask & bit) c.contentField.add(name);
              if (content.src !== null) c.contentField.add('src/icon');
              if (content.mesh) content.mesh.bp ? c.bpPatches++ : c.bpNull++;
              c.blendMode.add(content.bm);
              for (const k of ['ccc', 'acc', 'zcc', 'scc', 'occ'])
                if (content[k] !== null) c.contentEasingRefs++;
              if (content.mesh?.cc != null) c.contentEasingRefs++;
              unread('content', content.unread);
            }
          }
        }
      const m = model.metadata;
      unread('metadata', m.unread);
      c.variablesPerFile.add(m.variableList?.length ?? 'absent');
      c.timelinesPerFile.add(m.timelineControl.length);
      for (const t of m.timelineControl) {
        if (t.diff) c.diffTimelines++;
        for (const v of t.variables)
          for (const f of v.frames) {
            c.timelineFrames++;
            if (f.easing !== null) c.timelineEasing.add(f.easing);
          }
      }
      for (const name of CONTROLS) {
        const list = m[name];
        if (!list) continue;
        for (const e of list) {
          if (e.enabled === false) c.disabledControls.add(name);
          else {
            c.controls.add(name);
            unread(name, e.unread);
          }
        }
      }
      if (m.instantVariableList) c.controls.add('instantVariableList');
      if (m.stereovisionControl) c.controls.add('stereovisionControl');
      if (m.mirrorControl.variableMatchList.length) c.controls.add('mirrorControl');
    }
  } finally {
    await handle.close();
  }
  console.log(JSON.stringify(c, null, 1));
}

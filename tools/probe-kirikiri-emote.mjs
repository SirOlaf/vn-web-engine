import {createHash} from 'node:crypto';
import {open, readFile} from 'node:fs/promises';
import {Xp3Archive} from '../dist/formats/kirikiri/xp3.js';
import {CX_TINY_FILTERS, CxArchive} from '../dist/formats/kirikiri/cx-archive.js';
import {PsbFile} from '../dist/formats/kirikiri/psb.js';
import {EMOTE_PSB_KEYS, decryptPsbBody} from '../dist/formats/kirikiri/psb-filter.js';

/**
 * Non-visual E-mote check: removes the PSB body filter from every `.psb` member of each archive
 * and parses its tree. Prints counts and texture descriptors only; pixel data is never decoded.
 *
 *   npm run build:runtime
 *   node tools/probe-kirikiri-emote.mjs <plugin.tpm> <emotedriver.dll|emoteplayer.dll> <archive.xp3>...
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
  console.error(
    'usage: probe-kirikiri-emote.mjs <plugin.tpm> <emote runtime dll> <archive.xp3>...',
  );
  process.exit(2);
}
const filter = CX_TINY_FILTERS.get(await sha256(plugin));
if (!filter) throw new Error('No tiny filter known for the storage plugin');
const key = EMOTE_PSB_KEYS.get(await sha256(runtime));
if (key === undefined) throw new Error('No E-mote key known for the runtime');

for (const path of archives) {
  const handle = await open(path),
    {size} = await handle.stat();
  try {
    const cx = new CxArchive(await Xp3Archive.open(new FileSource(handle, size)), filter);
    let parsed = 0,
      failed = 0;
    const textures = new Map(),
      compress = new Map();
    const count = (map, value) => map.set(value, (map.get(value) ?? 0) + 1);
    for (const record of cx.names) {
      if (!/\.psb$/i.test(record.name)) continue;
      const entry = cx.find(record.name);
      if (!entry) continue;
      try {
        const root = new PsbFile(decryptPsbBody(await cx.readEntry(entry), key)).root;
        for (const source of Object.values(root.source ?? {})) {
          if (source?.texture) count(textures, String(source.texture.type));
          for (const icon of Object.values(source?.icon ?? {}))
            if (icon?.compress) count(compress, String(icon.compress));
        }
        parsed++;
      } catch (error) {
        failed++;
        console.error(`${record.name}: ${error.message}`);
      }
    }
    console.log(
      JSON.stringify({
        archive: path.split('/').pop(),
        parsed,
        failed,
        textureTypes: Object.fromEntries(textures),
        iconCompression: Object.fromEntries(compress),
      }),
    );
  } finally {
    await handle.close();
  }
}

import {createHash} from 'node:crypto';
import {open, readFile} from 'node:fs/promises';
import {adler32} from '../dist/core/inflate.js';
import {Xp3Archive} from '../dist/formats/kirikiri/xp3.js';
import {CX_TINY_FILTERS, CxArchive} from '../dist/formats/kirikiri/cx-archive.js';

/**
 * Non-visual XP3 check: opens each archive, resolves every `eliF` name through the CxDec
 * member-name hash and verifies the Adler-32 of each decrypted member. Prints counts only.
 *
 *   npm run build:runtime
 *   node tools/probe-kirikiri-xp3.mjs <plugin.tpm> <archive.xp3>...
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

const [plugin, ...archives] = process.argv.slice(2);
if (!plugin || !archives.length) {
  console.error('usage: probe-kirikiri-xp3.mjs <plugin.tpm> <archive.xp3>...');
  process.exit(2);
}
const pluginHash = createHash('sha256')
  .update(await readFile(plugin))
  .digest('hex');
const filter = CX_TINY_FILTERS.get(pluginHash);
if (!filter) throw new Error(`No tiny filter known for plugin ${pluginHash}`);
for (const path of archives) {
  const handle = await open(path),
    {size} = await handle.stat();
  try {
    const archive = await Xp3Archive.open(new FileSource(handle, size)),
      cx = new CxArchive(archive, filter);
    let resolved = 0,
      verified = 0,
      unresolved = 0,
      mismatched = 0,
      unreadable = 0,
      bytes = 0;
    for (const record of cx.names) {
      const entry = cx.find(record.name);
      if (!entry) {
        unresolved++;
        continue;
      }
      resolved++;
      let data;
      try {
        data = await cx.readEntry(entry);
      } catch {
        // The decoy notice member stores fewer bytes than its info size.
        unreadable++;
        continue;
      }
      if (adler32(data) === entry.adler32 && entry.adler32 === record.adler32) verified++;
      else mismatched++;
      bytes += data.length;
    }
    console.log(
      JSON.stringify({
        archive: path.split('/').pop(),
        entries: archive.entries.length,
        names: cx.names.length,
        resolved,
        verified,
        unresolved,
        mismatched,
        unreadable,
        bytes,
      }),
    );
  } finally {
    await handle.close();
  }
}

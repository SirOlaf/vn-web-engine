/** Numerical verification only: never renders or writes game assets. Run after npm run build. */
import {open, readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {Arc20Archive} from '../dist/formats/buriko/arc20.js';
import {BfMovie} from '../dist/formats/buriko/bf-movie.js';
import {signature} from '../dist/formats/buriko/binary.js';
import {inspectAsset} from '../dist/engines/buriko/assets.js';
const root = resolve(process.argv[2] ?? 'targetgame/aokana');
const counts = {},
  flags = {};
let entries = 0,
  frames = 0;
for (const name of (await readdir(root))
  .filter((n) => n.endsWith('.arc') || n === 'BGI.gdb')
  .sort()) {
  const file = await open(resolve(root, name));
  try {
    const {size} = await file.stat();
    const source = {
      size,
      async read(offset, length) {
        const bytes = new Uint8Array(length);
        let p = 0;
        while (p < length) {
          const result = await file.read(bytes, p, length - p, offset + p);
          if (!result.bytesRead) throw new Error('Unexpected EOF');
          p += result.bytesRead;
        }
        return bytes;
      },
    };
    if (!name.endsWith('.arc')) {
      const result = inspectAsset(await source.read(0, size), name);
      counts[result.kind] = (counts[result.kind] ?? 0) + 1;
      continue;
    }
    const archive = await Arc20Archive.open(source);
    for (const entry of archive.entries) {
      try {
        const bytes = await archive.read(entry.index);
        if (signature(bytes, 'BF_Movie')) {
          const movie = await BfMovie.open(archive.entrySource(entry.index));
          for (let i = 0; i < movie.frameCount; i++) {
            const pixels = await movie.frame(i);
            if (pixels.length !== movie.width * movie.height * 4)
              throw new Error('Invalid frame size');
            frames++;
          }
          counts.BF_Movie = (counts.BF_Movie ?? 0) + 1;
        } else {
          const result = inspectAsset(bytes, entry.name);
          counts[result.kind] = (counts[result.kind] ?? 0) + 1;
          if (result.image) {
            const key = `${result.image.bitDepth}/${result.image.flags}`;
            flags[key] = (flags[key] ?? 0) + 1;
          }
        }
        entries++;
      } catch (error) {
        throw new Error(`${name}[${entry.index}] ${entry.name}: ${error.message}`, {cause: error});
      }
    }
    console.log(`${name}: ${archive.entries.length} entries verified`);
  } finally {
    await file.close();
  }
}
console.log(JSON.stringify({entries, frames, counts, flags}, null, 2));

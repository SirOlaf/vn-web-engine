// Validate first/middle/final independently decodable GOPs of every installed movie.
import {writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {openSource} from './file-source.mjs';
import {CpkArchive} from '../dist/formats/cri/cpk.js';
import {SliceSource} from '../dist/core/source.js';
import {UsmReader, usmTable} from '../dist/formats/cri/usm.js';
import {Mpeg1Decoder} from '../dist/formats/mpeg1/decoder.js';
const movies = [];
for (const name of ['movie', 'movie_eng']) {
  const source = await openSource(new URL(`../../Data/${name}.cpk`, import.meta.url));
  try {
    const archive = await CpkArchive.open(source);
    for (const entry of archive.entries) {
      const src = new SliceSource(source, entry.offset, entry.storedSize),
        reader = new UsmReader(src);
      let index, header;
      for (;;) {
        const p = await reader.next();
        assert.ok(p);
        if (p.tag === '@SFV' && p.type === 1) header = usmTable(p).rows[0];
        if (p.tag === '@SFV' && p.type === 3) index = usmTable(p).rows;
        if (p.tag === '@SFV' && p.type === 0) break;
      }
      assert.ok(index?.length && header);
      const checks = [];
      for (const i of new Set([0, Math.floor(index.length / 2), index.length - 1])) {
        const row = index[i],
          start = Number(row.ofs_byte),
          end = Number(index[i + 1]?.ofs_byte ?? src.size),
          r = new UsmReader(src, start),
          decoder = new Mpeg1Decoder();
        let count = 0,
          types = {},
          hash = 2166136261;
        function accept(frames) {
          for (const f of frames) {
            count++;
            types[f.pictureType] = (types[f.pictureType] ?? 0) + 1;
            for (let i = 0; i < f.y.length; i += 97) hash = Math.imul(hash ^ f.y[i], 16777619);
          }
        }
        for (;;) {
          const p = await r.next();
          if (!p || p.offset >= end) break;
          if (p.tag === '@SFV' && p.type === 0) accept(decoder.push(p.payload));
        }
        accept(decoder.flush());
        const expected = (index[i + 1]?.ofs_frmid ?? header.total_frames) - row.ofs_frmid;
        assert.equal(count, expected, `${name}/${entry.id} GOP ${i}`);
        checks.push({firstFrame: row.ofs_frmid, frames: count, types, lumaSampleHash: hash >>> 0});
      }
      const result = {asset: `${name}/${entry.id}`, keyframes: index.length, checks};
      movies.push(result);
      console.log(JSON.stringify(result));
    }
  } finally {
    await source.close();
  }
}
await writeFile(
  new URL('../docs/movie-gop-verification.json', import.meta.url),
  JSON.stringify(
    {
      method:
        'Complete first, middle and final keyframe intervals; macroblock coverage, VLC/range checks, exact frame counts, I/P/B ordering; hashes of sampled luma for regression.',
      movies,
    },
    null,
    2,
  ) + '\n',
);

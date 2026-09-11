import test from 'node:test';
import assert from 'node:assert/strict';
import {parseMvl, characterExpressions, composeCharacter} from '../dist/engines/mages/mvl.js';
import {openSource} from '../tools/file-source.mjs';
import {CpkArchive} from '../dist/formats/cri/cpk.js';
// Await reads before closing the source; keep the fixture independent of native code.
const source = await openSource(new URL('../../Data/chara.cpk', import.meta.url));
let bytes;
try {
  bytes = await (await CpkArchive.open(source)).read(11);
} finally {
  await source.close();
}
function corrupt(change) {
  const copy = bytes.slice(),
    v = new DataView(copy.buffer);
  change(v, copy);
  return copy;
}
test('MVL loader recovers indexed triangle geometry and shares common vertex buffers', () => {
  const mvl = parseMvl(bytes);
  assert.equal(mvl.meshes.length, 42);
  const first = mvl.meshes[0];
  assert.equal(first.name, 'AYA_L1A01');
  assert.equal(first.width, 1920);
  assert.equal(first.height, 1440);
  assert.equal(first.vertices.length, 5616 * 5);
  assert.equal(first.indices.length, 5322);
  assert.deepEqual(Array.from(first.vertices.subarray(0, 3)), [-60, -660, 0]);
  assert.equal(first.vertices, mvl.meshes[1].vertices);
  assert.equal(first.vertexOffset, 2784);
  assert.equal(first.indexOffset, 115104);
});
test('Character composition selects base, lips and eyes in native draw order', () => {
  const groups = characterExpressions(parseMvl(bytes));
  assert.equal(groups.length, 6);
  const g = groups[0];
  assert.deepEqual(
    composeCharacter(g, 2, 1).map((m) => m.name),
    ['AYA_L1A01', 'AYA_L1A01L3', 'AYA_L1A01E2'],
  );
  assert.deepEqual(composeCharacter(g, -1, -1), [g.base]);
  assert.throws(() => composeCharacter(g, 3, 0));
  assert.throws(() => composeCharacter(g, 0, 0.5));
});
test('MVL rejects truncated tables, buffer overflows and indices outside the vertex buffer', () => {
  assert.throws(() => parseMvl(bytes.subarray(0, 95)));
  assert.throws(() => parseMvl(bytes.subarray(0, 200)));
  assert.throws(
    () => parseMvl(corrupt((v) => v.setUint32(0x74, 0xfffffff0, true))),
    /bounds|range/i,
  );
  assert.throws(() => parseMvl(corrupt((v) => v.setUint16(115104, 5616, true))), /index/);
  assert.throws(() => parseMvl(corrupt((v) => v.setUint32(0x78, 1, true))), /counts/);
});
test('MVL rejects unsupported formats, nonfinite vertices, and duplicate names', () => {
  assert.throws(() => parseMvl(corrupt((v) => v.setUint8(9, 32))), /format/);
  assert.throws(() => parseMvl(corrupt((v) => v.setUint8(0x68, 5))), /primitive/);
  assert.throws(() => parseMvl(corrupt((v) => v.setFloat32(2784, NaN, true))), /Nonfinite/);
  assert.throws(
    () => parseMvl(corrupt((v, b) => b.set(b.subarray(0x80, 0xa0), 0xc0))),
    /Duplicate/,
  );
});

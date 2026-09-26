// Metadata and compression only. Never render, play, or print save/asset contents.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {decodeBurikoSdc} from '../dist/engines/buriko/native/sdc.js';
import {decodeBurikoDcfs, encodeBurikoDcfs} from '../dist/engines/buriko/native/dcfs.js';
import {BurikoDataCodecWorkers} from '../dist/engines/buriko/native/data-codec-workers.js';
import {BurikoStructCodecScratch} from '../dist/engines/buriko/native/struct-codec-scratch.js';

if (!process.argv[2]) throw new Error('Usage: node tools/benchmark-buriko-save.mjs <export.SUD>');
const file = await readFile(process.argv[2]);
const offset = file.indexOf('SDC FORMAT 1.00\0');
if (offset < 0) throw new Error('Save has no embedded SDC table');
const header = new DataView(file.buffer, file.byteOffset + offset, file.length - offset);
// The codecs use Uint8Array.slice's copying semantics, unlike Node Buffer.slice.
const saved = new Uint8Array(file.subarray(offset, offset + 32 + header.getUint32(20, true)));
const dcfs = decodeBurikoSdc(saved);
assert.ok(dcfs, 'SDC table must pass its stored checksum');
assert.equal(new TextDecoder().decode(dcfs.subarray(0, 16)), 'DCFS FORMAT 1.00');
const tableHeader = new DataView(dcfs.buffer, dcfs.byteOffset, dcfs.byteLength);
const recordSize = tableHeader.getUint32(16, true),
  recordCount = tableHeader.getUint32(20, true);
const extent = recordSize * recordCount;
assert.ok(extent > 0 && extent <= 64 * 1024 * 1024, 'Table must fit native struct scratch');
const plain = new Uint8Array(extent);
assert.equal(decodeBurikoDcfs({bytes: plain, offset: 0}, {bytes: dcfs, offset: 0}), 0);

const compressed = new Uint8Array(Math.ceil((extent * 1.5 + 24) / 4096) * 4096);
const result = {value: 0},
  start = performance.now();
assert.equal(
  encodeBurikoDcfs(
    {bytes: compressed, offset: 0},
    result,
    {bytes: plain, offset: 0},
    recordSize,
    recordCount,
  ),
  0,
);
const dcfsMs = performance.now() - start;
assert.ok(
  result.value === dcfs.length && dcfs.every((byte, index) => compressed[index] === byte),
  'Recompressed DCFS bytes differ from the export',
);

const scratch = new BurikoStructCodecScratch();
const workers = new BurikoDataCodecWorkers(() => new Date(header.getUint32(16, true)));
const output = new Uint8Array(saved.length);
let last = performance.now(),
  maxTimerGapMs = 0,
  hostTicks = 0;
const heartbeat = setInterval(() => {
  const now = performance.now();
  maxTimerGapMs = Math.max(maxTimerGapMs, now - last);
  last = now;
  hostTicks++;
}, 1);
const workerStart = performance.now();
try {
  const worker = workers.startStructEncode(
    {bytes: output, offset: 0},
    {bytes: plain, offset: 0},
    recordSize,
    recordCount,
    scratch,
    {
      show() {
        throw new Error('Struct scratch allocation failed');
      },
    },
  );
  assert.ok(worker);
  await workers.closeAndJoin();
  const workerMs = performance.now() - workerStart;
  maxTimerGapMs = Math.max(maxTimerGapMs, performance.now() - last);
  assert.equal(worker.done, true);
  assert.equal(worker.result, saved.length);
  assert.ok(
    output.every((byte, index) => saved[index] === byte),
    'Recompressed SDC bytes differ from the export',
  );
  console.log(
    JSON.stringify(
      {
        fileBytes: file.length,
        recordSize,
        recordCount,
        expandedTableBytes: extent,
        dcfsBytes: dcfs.length,
        sdcBytes: saved.length,
        dcfsMs: +dcfsMs.toFixed(1),
        workerMs: +workerMs.toFixed(1),
        maxTimerGapMs: +maxTimerGapMs.toFixed(1),
        hostTicks,
        identicalSavedBytes: true,
      },
      null,
      2,
    ),
  );
} finally {
  clearInterval(heartbeat);
  await workers.closeAndJoin();
  await scratch.dispose();
}

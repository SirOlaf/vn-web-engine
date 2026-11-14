import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker as ThreadWorker} from 'node:worker_threads';
import {createArtemisImageLoader} from '../dist/engines/artemis/image-loader.js';
import {ARTEMIS_3179_EXECUTABLE_SHA256} from '../dist/engines/artemis/revision.js';
import {png} from './png-fixtures.mjs';
import {psd} from './artemis-image-fixtures.mjs';

const bootstrap = `
const {parentPort, workerData} = require('node:worker_threads');
let handler = null;
const queued = [];
Object.defineProperty(globalThis, 'onmessage', {get: () => handler, set(value) {
  handler = value; for (const data of queued.splice(0)) handler({data});
}});
globalThis.postMessage = (message, transfer) => parentPort.postMessage(message, transfer);
parentPort.on('message', data => handler ? handler({data}) : queued.push(data));
import(workerData);
`;

test(
  'Artemis PNG and merged PSD resources use the real shared worker without detaching archive bytes',
  {timeout: 15000},
  async () => {
    const workers = [];
    const originalWorker = globalThis.Worker;
    let applied = 0;
    class ModuleWorker {
      constructor(url) {
        this.thread = new ThreadWorker(bootstrap, {eval: true, workerData: url.href});
        workers.push(this.thread);
        this.thread.on('message', (data) => {
          if (data.response) applied++;
          this.onmessage?.({data});
          this.thread.unref();
        });
        this.thread.on('error', (error) => {
          this.onerror?.({error, preventDefault() {}});
          this.thread.unref();
        });
        this.thread.unref();
      }
      postMessage(message, transfer) {
        this.thread.ref();
        this.thread.postMessage(message, transfer);
      }
      terminate() {
        this.thread.terminate();
      }
    }
    globalThis.Worker = ModuleWorker;
    const original = png({
      width: 2,
      height: 1,
      raw: Buffer.from([0, 255, 0, 0, 0, 0, 255, 0, 128]),
    });
    const snapshot = original.slice();
    const loader = createArtemisImageLoader(ARTEMIS_3179_EXECUTABLE_SHA256, async (path) =>
      path === 'fixture.png' ? original : null,
    );
    try {
      const loaded = await loader.load('fixture');
      assert.equal(applied, 1);
      assert.equal(workers.length, 1);
      assert.equal(loaded.image.width, 2);
      assert.deepEqual([...loaded.image.pixels], [255, 0, 0, 0, 0, 255, 0, 128]);
      assert.deepEqual(original, snapshot);
      assert.equal(original.byteLength, snapshot.byteLength);
      const composite = psd({
          width: 2,
          height: 1,
          planes: [
            [255, 17],
            [191, 33],
            [127, 49],
            [128, 0],
          ],
          compression: 1,
        }),
        compositeSnapshot = composite.slice(),
        psdLoader = createArtemisImageLoader(ARTEMIS_3179_EXECUTABLE_SHA256, async (path) =>
          path === 'fixture.psd' ? composite : null,
        );
      const psdImage = await psdLoader.load('fixture.psd');
      assert.deepEqual([...psdImage.image.pixels], [255, 127, 0, 128, 17, 33, 49, 0]);
      assert.deepEqual(composite, compositeSnapshot);
      assert.equal(applied, 2);
      assert.equal(workers.length, 1);
      const corrupt = original.slice();
      corrupt[corrupt.length - 1] ^= 1;
      const failing = createArtemisImageLoader(ARTEMIS_3179_EXECUTABLE_SHA256, async (path) =>
        path === 'corrupt.png' ? corrupt : null,
      );
      await assert.rejects(() => failing.load('corrupt'), /CRC/);
      assert.deepEqual(original, snapshot);
    } finally {
      globalThis.Worker = originalWorker;
      await Promise.all(workers.map((worker) => worker.terminate()));
    }
  },
);

test(
  'Artemis Vorbis worker preserves real boundary frames and produces native PCM16 without detaching input',
  {timeout: 15000},
  async () => {
    const {readFile} = await import('node:fs/promises');
    const {createNodeBrowserWorker} = await import('../tools/node-browser-worker.mjs');
    const {ArtemisVorbisPcmDecoder} = await import('../dist/engines/artemis/vorbis-pcm-decoder.js');
    const encoded = new Uint8Array(
      await readFile(new URL('./fixtures/audio/vorbis-boundaries.ogg', import.meta.url)),
    );
    const original = globalThis.Worker,
      workers = [];
    globalThis.Worker = class {
      constructor(url) {
        const worker = createNodeBrowserWorker(url);
        workers.push(worker);
        return worker;
      }
    };
    const decoder = new ArtemisVorbisPcmDecoder(ARTEMIS_3179_EXECUTABLE_SHA256, 'nearest-even');
    try {
      const decoded = await decoder.decode(encoded);
      assert.equal(decoded.sampleRate, 48000);
      assert.equal(decoded.channels, 1);
      assert.equal(decoded.bytes.length, 4109 * 2);
      const golden = await readFile(
        new URL('./fixtures/audio/vorbis-boundaries.f32', import.meta.url),
      );
      const expected = new DataView(golden.buffer, golden.byteOffset, golden.byteLength),
        actual = new DataView(decoded.bytes.buffer);
      for (let i = 0; i < 256; i++) {
        const sample = expected.getFloat32(i * 4, true) * 32768,
          floor = Math.floor(sample),
          fraction = sample - floor;
        const integer = fraction > 0.5 || (fraction === 0.5 && floor % 2 !== 0) ? floor + 1 : floor;
        const at = i < 128 ? i : 4109 - 256 + i;
        assert.ok(
          Math.abs(actual.getInt16(at * 2, true) - Math.max(-32768, Math.min(32767, integer))) <= 1,
          `native PCM16 boundary ${i}`,
        );
      }
      assert.ok(encoded.length > 0);
      assert.equal(await decoder.decode(new Uint8Array([0, 1, 2])), null);
      assert.equal(workers.length, 1);
      decoder.close();
      await assert.rejects(() => decoder.decode(encoded), /closed/);
    } finally {
      decoder.close();
      globalThis.Worker = original;
      await Promise.all(workers.map((worker) => worker.terminate()));
    }
  },
);

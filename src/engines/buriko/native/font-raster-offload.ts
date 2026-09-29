import {beginRuntimeSpan, recordRuntimeMetric} from '../../../platform/runtime-performance.js';
import {WorkerPool} from '../../../platform/worker-pool.js';
import type {BurikoFontCanvasStyle} from './font-canvas.js';
import type {
  BurikoFontRasterWorkerRequest,
  BurikoFontRasterWorkerResponse,
} from './font-raster-worker.js';

/** How a worker reproduces a face: the resource's own bytes and descriptors, or a generic family. */
export type BurikoFontWorkerSource =
  | {
      readonly kind: 'bytes';
      readonly bytes: Uint8Array;
      readonly descriptors: {readonly weight: string; readonly style: string};
    }
  | {readonly kind: 'generic'};

let enabled = true;
let failed = false;
let pool: WorkerPool<BurikoFontRasterWorkerRequest, BurikoFontRasterWorkerResponse> | null = null;
const fontIds = new WeakMap<Uint8Array, number>();
let nextFontId = 1;

/** `?text-worker=0` keeps glyph rasterization on the main thread, for A/B captures. */
export function setBurikoTextWorkersEnabled(value: boolean): void {
  enabled = value;
}

function rasterPool() {
  return (pool ??= new WorkerPool(
    () => new Worker(new URL('./font-raster-worker.js', import.meta.url), {type: 'module'}),
  ));
}

async function rasterChunk(
  request: BurikoFontRasterWorkerRequest,
  source: BurikoFontWorkerSource,
): Promise<Uint8Array[] | null> {
  const workers = rasterPool();
  let response = await workers.run(request);
  // A worker loads a resource font once; the first job it sees for that font gets the bytes.
  if (response !== undefined && 'missingFont' in response && source.kind === 'bytes') {
    const bytes = source.bytes.slice();
    response = await workers.run({...request, font: {...request.font, bytes: bytes.buffer}}, [
      bytes.buffer,
    ]);
  }
  if (response === undefined || !('dibs' in response)) return null;
  const size = Math.ceil(request.width / 4) * 4 * request.height;
  if (response.dibs.length !== request.texts.length) return null;
  return response.dibs.every((dib) => dib.length === size) ? response.dibs : null;
}

/**
 * Rasterizes each text into the DIB `BurikoFontTextCanvas.raster` produces for the same style
 * and size, split across the pool. Returns null synchronously when workers are disabled or
 * unavailable; resolves null when any job failed, so callers rasterize in-thread.
 */
export function rasterBurikoFontTextOffThread(
  family: string,
  source: BurikoFontWorkerSource,
  style: BurikoFontCanvasStyle,
  texts: readonly string[],
  width: number,
  height: number,
): Promise<Uint8Array[] | null> | null {
  if (!enabled || failed || !rasterPool().available) return null;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
    return null;
  let id = 0;
  if (source.kind === 'bytes') {
    id = fontIds.get(source.bytes) ?? nextFontId++;
    fontIds.set(source.bytes, id);
  }
  const workers = rasterPool(),
    chunks = Math.min(workers.size, texts.length),
    per = Math.ceil(texts.length / chunks),
    finish = beginRuntimeSpan('buriko.text.raster.worker');
  const jobs: Promise<Uint8Array[] | null>[] = [];
  for (let start = 0; start < texts.length; start += per)
    jobs.push(
      rasterChunk(
        {
          font: {
            family,
            id,
            kind: source.kind,
            descriptors: source.kind === 'bytes' ? source.descriptors : null,
          },
          style,
          width,
          height,
          texts: texts.slice(start, start + per),
        },
        source,
      ),
    );
  return Promise.all(jobs).then((results) => {
    const applied = results.every((result) => result !== null);
    finish?.({glyphs: texts.length, pixels: width * height, success: applied});
    recordRuntimeMetric('buriko.text.raster.worker-applied', Number(applied));
    // A host whose workers cannot load fonts would otherwise pay a round trip per layout.
    if (!applied) failed = true;
    return applied ? (results as Uint8Array[][]).flat() : null;
  });
}

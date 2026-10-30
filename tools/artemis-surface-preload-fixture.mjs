/** Nonvisual real-pixel decode/queue diagnostic. No canvas, frame or asset display.
 * PNG/merged PSD use the shared worker; JPEG uses the diagnostic Pillow/libjpeg owner. */
import {createHash} from 'node:crypto';
import {createNodeBrowserWorker} from './node-browser-worker.mjs';
import {ArtemisSurfaceManager} from '../dist/engines/artemis/surface-manager.js';
import {ArtemisImageLoader} from '../dist/engines/artemis/image-loader.js';
import {artemisPngSurface, artemisPngDecodeOptions} from '../dist/engines/artemis/png-surface.js';
import {decodePng} from '../dist/formats/png/decode.js';
import {decodeNodeOpaqueJpeg} from './node-opaque-jpeg.mjs';
export function createArtemisSurfacePreloadFixture(
  hash,
  readFile,
  budgetBytes = 512n * 1024n * 1024n,
) {
  const worker = createNodeBrowserWorker(
      new URL('../dist/graphics/image-decode-worker.js', import.meta.url),
    ),
    jobs = new Map(),
    samples = [],
    prepared = new Set();
  let id = 0,
    decoded = 0,
    disposed = 0,
    closed = false;
  worker.onmessage = ({data}) => {
    const pending = jobs.get(data.id);
    if (!pending) return;
    jobs.delete(data.id);
    if (data.failed && pending.format === 'png')
      // Like the browser offload owner, rerun to retain the original codec diagnostic.
      decodePng(pending.input, artemisPngDecodeOptions).then(pending.resolve, pending.reject);
    else if (data.failed)
      pending.reject(Error('Unsupported or failed nonvisual image worker decode'));
    else pending.resolve(data.response);
  };
  const failed = (error) => {
    for (const job of jobs.values()) job.reject(error);
    jobs.clear();
  };
  worker.onerror = failed;
  worker.onmessageerror = failed;
  const decode = (format, input) => {
    if (closed) throw Error('Surface preload fixture closed');
    const bytes = Uint8Array.from(input),
      requestId = ++id;
    return new Promise((resolve, reject) => {
      jobs.set(requestId, {resolve, reject, format, input});
      try {
        worker.postMessage(
          {
            id: requestId,
            request: {format, bytes, ...(format === 'png' ? {png: artemisPngDecodeOptions} : {})},
          },
          [bytes.buffer],
        );
      } catch (error) {
        jobs.delete(requestId);
        reject(error);
      }
    });
  };
  const loader = new ArtemisImageLoader(readFile, [
    {
      extensions: ['png', 'PNG'],
      decode: async (bytes) => {
        if (![137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)) return null;
        // CPng 0x1401838e0: gray PNGs become format 0 surfaces, others format 2.
        return artemisPngSurface(await decode('png', bytes));
      },
    },
    {
      extensions: ['jpg', 'jpeg', 'JPG', 'JPEG'],
      decode: async (bytes) => {
        if (bytes[0] !== 255 || bytes[1] !== 216) return null;
        return decodeNodeOpaqueJpeg(bytes);
      },
    },
    {
      extensions: ['psd', 'PSD'],
      decode: async (bytes) => {
        if (![56, 66, 80, 83].every((v, i) => bytes[i] === v)) return null;
        return decode('artemis-psd', bytes);
      },
    },
  ]);
  const manager = new ArtemisSurfaceManager(hash, budgetBytes, {
    createSurface: () => {
      const surface = {};
      prepared.add(surface);
      return surface;
    },
    decodeSurface: async (surface, name) => {
      const resource = await loader.load(name);
      if (resource) {
        decoded++;
        if (samples.length < 128)
          samples.push({
            name,
            path: resource.path,
            width: resource.image.width,
            height: resource.image.height,
            format: resource.image.format ?? 2,
            pixelsSha256: createHash('sha256').update(resource.image.pixels).digest('hex'),
          });
      }
      return resource;
    },
    // 1649b0: format 0 stores one byte per pixel, nonzero formats four.
    storageBytes: (_, resource) =>
      resource.image.width * resource.image.height * (resource.image.format === 0 ? 1 : 4),
    disposeSurface: (surface) => {
      if (!prepared.delete(surface)) throw Error('Surface disposed twice');
      disposed++;
    },
  });
  return {
    manager,
    summary: () => ({
      surfacePreloads: 'actual-worker-pixels-nonvisual',
      sceneRendering: false,
      gameVisualAssetsDisplayed: false,
      rendererPreparation: false,
      surfaceFormat: 'native-png-format-0-or-2',
      budgetSource: 'diagnostic-host',
      decodedImages: decoded,
      disposedSurfaces: disposed,
      retainedSurfaces: prepared.size,
      bytesUsed: String(manager.bytesUsed),
      loading: manager.isLoadingSurface(),
      failures: manager.loadFailures.map((x) => ({name: x.name, error: String(x.error)})),
      samples,
    }),
    close: async () => {
      await manager.close();
      closed = true;
      failed(Error('Surface preload fixture closed'));
      await worker.terminate();
    },
  };
}

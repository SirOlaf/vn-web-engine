import {BlobSource, HttpSource, SliceSource, type ByteSource} from '../../core/source.js';
import {inspectAsset, imageRgba} from './assets.js';
import {BfMovie} from '../../formats/buriko/bf-movie.js';
export type ExplorerSource =
  | {kind: 'blob'; blob: Blob}
  | {kind: 'http'; url: string; size: number; offset: number; length: number};
export type ExplorerRequest =
  | {id: number; type: 'inspect'; source: ExplorerSource; name: string}
  | {id: number; type: 'movie'; source: ExplorerSource}
  | {id: number; type: 'frame'; index: number};
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<ExplorerRequest>) => void) | null;
  postMessage: (value: unknown, transfer?: Transferable[]) => void;
};
function source(descriptor: ExplorerSource): ByteSource {
  return descriptor.kind === 'blob'
    ? new BlobSource(descriptor.blob)
    : new SliceSource(
        new HttpSource(descriptor.url, descriptor.size),
        descriptor.offset,
        descriptor.length,
      );
}
let movie: BfMovie | undefined;
let queue = Promise.resolve();
scope.onmessage = (event) => {
  const request = event.data;
  queue = queue.then(async () => {
    try {
      if (request.type === 'inspect') {
        const input = source(request.source),
          result = inspectAsset(await input.read(0, input.size), request.name);
        scope.postMessage({id: request.id, result});
      } else if (request.type === 'movie') {
        movie = await BfMovie.open(source(request.source));
        scope.postMessage({
          id: request.id,
          result: {
            width: movie.width,
            height: movie.height,
            bitDepth: movie.bitDepth,
            surfaceType: movie.surfaceType,
            fps: movie.fps,
            frameCount: movie.frameCount,
          },
        });
      } else {
        if (!movie) throw new Error('No movie open');
        const pixels = await movie.frame(request.index);
        const rgba = imageRgba({
          width: movie.width,
          height: movie.height,
          bitDepth: 32,
          flags: movie.bitDepth === 24 ? 7 : 0,
          header: new Uint8Array(16),
          pixels,
        });
        scope.postMessage({id: request.id, result: rgba}, [rgba.buffer]);
      }
    } catch (error) {
      scope.postMessage({
        id: request.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
};

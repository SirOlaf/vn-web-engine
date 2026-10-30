import {openWorkerSource} from '../core/worker-source.js';
import {openMovieStream} from './movie.js';
import {readMovieBatch} from './movie-batch.js';
import type {MovieStream} from './movie-types.js';
import type {MovieRequest, MovieResponse} from './worker-protocol.js';
const worker = globalThis as unknown as {
  onmessage: ((event: MessageEvent<MovieRequest>) => void) | null;
  postMessage(message: MovieResponse, transfer?: Transferable[]): void;
};
let movie: MovieStream | undefined,
  busy = false,
  seek = 0,
  done = false;
worker.onmessage = async (event) => {
  if (busy) {
    worker.postMessage({type: 'error', message: 'Overlapping movie worker requests'});
    return;
  }
  busy = true;
  try {
    if (event.data.type === 'open') {
      if (movie) throw new Error('Movie already open');
      movie = await openMovieStream(openWorkerSource(event.data.source));
      seek = event.data.seek;
    }
    if (!movie || done) throw new Error('Movie worker is not open');
    const start = performance.now(),
      batch = await readMovieBatch(movie, seek, (progress) =>
        worker.postMessage({type: 'seeking', progress}),
      ),
      {frames, audio} = batch;
    done = batch.done;
    if (!movie.info) throw new Error('Missing movie metadata');
    worker.postMessage(
      {type: 'batch', frames, audio, info: movie.info, done, decodeMs: performance.now() - start},
      [
        ...frames.flatMap((f) => [f.y.buffer, f.cb.buffer, f.cr.buffer]),
        ...audio.flatMap((a) => a.channels.map((c) => c.buffer)),
      ] as ArrayBuffer[],
    );
  } catch (error) {
    done = true;
    worker.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    busy = false;
  }
};

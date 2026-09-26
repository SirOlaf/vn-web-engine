import {openWorkerSource} from '../core/worker-source.js';
import {openMovieStream} from './movie.js';
import type {MoviePcm, MovieFrame, MovieStream} from './movie-types.js';
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
    const frames: MovieFrame[] = [],
      audio: MoviePcm[] = [],
      start = performance.now();
    let update = start,
      packets = 0;
    while (frames.length < 4 && !done) {
      const b = await movie.next();
      done = b.done;
      if (b.info) {
        for (const f of b.frames)
          if (
            (f.timestamp ?? f.index / b.info.frameRate) + (f.duration ?? 1 / b.info.frameRate) >
            seek
          ) {
            // Reference planes stay owned by the decoder; transfer separate display copies.
            frames.push({...f, y: f.y.slice(), cb: f.cb.slice(), cr: f.cr.slice()});
          }
        for (const a of b.audio) {
          const at = a.timestamp ?? a.start / b.info.sampleRate;
          const trim = Math.max(
            0,
            a.timestamp === undefined
              ? Math.floor(seek * b.info.sampleRate) - a.start
              : Math.floor((seek - at) * b.info.sampleRate),
          );
          if (trim < a.channels[0]!.length)
            audio.push({
              start: a.start + trim,
              channels: a.channels.map((c) => c.slice(trim)),
              ...(a.timestamp === undefined ? {} : {timestamp: at + trim / b.info.sampleRate}),
            });
        }
      }
      if (++packets > 100000 || audio.reduce((n, a) => n + a.channels[0]!.length, 0) > 48000 * 10)
        throw new Error('Movie interleave exceeds buffering limit');
      if (performance.now() - update > 250) {
        worker.postMessage({
          type: 'seeking',
          progress: movie.info
            ? Math.min(1, (b.frames.at(-1)?.index ?? 0) / (seek * movie.info.frameRate || 1))
            : 0,
        });
        update = performance.now();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
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

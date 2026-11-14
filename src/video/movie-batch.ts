import type {MoviePcm, MovieFrame, MovieStream} from './movie-types.js';

/** One decode-worker batch: `next()` until 4 frames past `seek` or the end, with the audio
 * past `seek`. The buffering limit applies only while frames are still missing: interleaving
 * may carry many seconds of audio in the packet that also completes the batch (an ending
 * movie's last 12 s of WMA beside its frames), which is not a stream without video. */
export async function readMovieBatch(
  movie: MovieStream,
  seek: number,
  seeking: (progress: number) => void,
): Promise<{frames: MovieFrame[]; audio: MoviePcm[]; done: boolean}> {
  const frames: MovieFrame[] = [],
    audio: MoviePcm[] = [];
  let update = performance.now(),
    packets = 0,
    done = false;
  while (frames.length < 4 && !done) {
    const b = await movie.next();
    done = b.done;
    if (b.info) {
      for (const f of b.frames)
        if (
          (f.timestamp ?? f.index / b.info.frameRate) + (f.duration ?? 1 / b.info.frameRate) >
          seek
        ) {
          // Decoders return pictures the caller owns, so their planes transfer directly.
          frames.push(f);
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
    if (
      ++packets > 100000 ||
      (frames.length < 4 &&
        !done &&
        audio.reduce((n, a) => n + a.channels[0]!.length, 0) > 48000 * 10)
    )
      throw new Error('Movie interleave exceeds buffering limit');
    if (performance.now() - update > 250) {
      seeking(
        movie.info
          ? Math.min(1, (b.frames.at(-1)?.index ?? 0) / (seek * movie.info.frameRate || 1))
          : 0,
      );
      update = performance.now();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  return {frames, audio, done};
}

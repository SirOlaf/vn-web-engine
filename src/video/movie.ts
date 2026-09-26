import type {ByteSource} from '../core/source.js';
import {CriMovie} from '../formats/cri/movie.js';
import {MpegPsMovie} from '../formats/mpeg-ps/movie.js';
import type {MovieStream} from './movie-types.js';
export type {MovieStream, MovieInfo, MovieFrame, MoviePcm, MovieBatch} from './movie-types.js';

/** Container selection belongs to the shared movie layer, independent of titles. */
export async function openMovieStream(
  source: ByteSource,
  signal?: AbortSignal,
): Promise<MovieStream> {
  if (source.size < 4) throw new Error('Truncated movie signature');
  const bytes = await source.read(0, 4, signal);
  if (bytes.length !== 4) throw new Error('Truncated movie signature read');
  if (bytes[0] === 67 && bytes[1] === 82 && bytes[2] === 73 && bytes[3] === 68)
    return new CriMovie(source);
  if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0xba)
    return MpegPsMovie.open(source, signal);
  throw new Error('Unsupported movie container');
}

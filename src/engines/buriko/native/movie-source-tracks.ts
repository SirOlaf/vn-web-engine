import {
  burikoIsoAacConfiguration,
  burikoIsoAvcConfiguration,
  type BurikoAacDecoderConfiguration,
} from './movie-iso-codecs.js';
import {
  burikoIsoSampleBytes,
  BurikoIsoSampleError,
  type BurikoIsoMovie,
  type BurikoIsoTrack,
} from './movie-iso-samples.js';
import {createBurikoIsoTimeline, type BurikoIsoTimeline} from './movie-iso-timeline.js';
import {BurikoMovieSourceDocument} from './movie-source-document.js';

export interface BurikoMovieBoundTrack<Configuration> {
  readonly track: BurikoIsoTrack;
  readonly timeline: BurikoIsoTimeline;
  /** Keys are the one-based sample-description numbers used by this track's samples. */
  readonly configurations: ReadonlyMap<number, Configuration>;
  /** A borrowed view into the selected physical document; no sample copy or decoding. */
  sampleBytes(index: number): Uint8Array;
}

function bindTrack<Configuration>(
  movie: BurikoIsoMovie,
  track: BurikoIsoTrack,
  configuration: (description: BurikoIsoTrack['descriptions'][number]) => Configuration,
): BurikoMovieBoundTrack<Configuration> {
  const timeline = createBurikoIsoTimeline(movie, track);
  const configurations = new Map<number, Configuration>();
  for (const sample of track.samples) {
    const number = sample.description;
    if (!configurations.has(number)) {
      const description = track.descriptions[number - 1];
      if (description === undefined)
        throw new BurikoIsoSampleError('Selected movie sample has no description');
      configurations.set(number, configuration(description));
    }
    // The current source owner supplies one physical ISO document, so every selected
    // sample must have a local data reference and a byte span inside that document.
    burikoIsoSampleBytes(movie, track, sample);
  }
  return {
    track,
    timeline,
    configurations,
    sampleBytes(index) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= track.samples.length)
        throw new RangeError('Selected movie sample index is outside its track');
      return burikoIsoSampleBytes(movie, track, track.samples[index]!);
    },
  };
}

/** Browser ISO profile over explicitly chosen tracks from one selected physical source. */
export class BurikoMovieSourceTracks {
  private constructor(
    readonly document: BurikoMovieSourceDocument,
    readonly movie: BurikoIsoMovie,
    readonly video: BurikoMovieBoundTrack<VideoDecoderConfig>,
    readonly audio: BurikoMovieBoundTrack<BurikoAacDecoderConfiguration> | null,
  ) {}

  /** Track IDs are supplied by the caller; DirectShow RenderFile selection is not inferred here. */
  static prepare(
    document: BurikoMovieSourceDocument,
    videoTrackId: number,
    audioTrackId: number | null,
  ): BurikoMovieSourceTracks {
    if (!(document instanceof BurikoMovieSourceDocument))
      throw new TypeError('Movie tracks require the actual selected source document');
    const movie = document.movie;
    const select = (id: number, handler: string): BurikoIsoTrack => {
      if (!Number.isSafeInteger(id) || id <= 0 || id > 0xffffffff)
        throw new RangeError('Selected movie track ID must be a positive DWORD');
      const track = movie.tracks.find((candidate) => candidate.id === id);
      if (track === undefined || track.handler !== handler)
        throw new BurikoIsoSampleError(`Selected movie has no ${handler} track with ID ${id}`);
      return track;
    };
    const video = bindTrack(movie, select(videoTrackId, 'vide'), burikoIsoAvcConfiguration);
    const audio =
      audioTrackId === null
        ? null
        : bindTrack(movie, select(audioTrackId, 'soun'), burikoIsoAacConfiguration);
    return new BurikoMovieSourceTracks(document, movie, video, audio);
  }
}

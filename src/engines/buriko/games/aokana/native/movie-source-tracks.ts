import {
  aokanaIsoAacConfiguration,
  aokanaIsoAvcConfiguration,
  type AokanaAacDecoderConfiguration,
} from './movie-iso-codecs.js';
import {
  aokanaIsoSampleBytes,
  AokanaIsoSampleError,
  type AokanaIsoMovie,
  type AokanaIsoTrack,
} from './movie-iso-samples.js';
import {createAokanaIsoTimeline, type AokanaIsoTimeline} from './movie-iso-timeline.js';
import {AokanaMovieSourceDocument} from './movie-source-document.js';

export interface AokanaMovieBoundTrack<Configuration> {
  readonly track: AokanaIsoTrack;
  readonly timeline: AokanaIsoTimeline;
  /** Keys are the one-based sample-description numbers used by this track's samples. */
  readonly configurations: ReadonlyMap<number, Configuration>;
  /** A borrowed view into the selected physical document; no sample copy or decoding. */
  sampleBytes(index: number): Uint8Array;
}

function bindTrack<Configuration>(
  movie: AokanaIsoMovie,
  track: AokanaIsoTrack,
  configuration: (description: AokanaIsoTrack['descriptions'][number]) => Configuration,
): AokanaMovieBoundTrack<Configuration> {
  const timeline = createAokanaIsoTimeline(movie, track);
  const configurations = new Map<number, Configuration>();
  for (const sample of track.samples) {
    const number = sample.description;
    if (!configurations.has(number)) {
      const description = track.descriptions[number - 1];
      if (description === undefined)
        throw new AokanaIsoSampleError('Selected movie sample has no description');
      configurations.set(number, configuration(description));
    }
    // The current source owner supplies one physical ISO document, so every selected
    // sample must have a local data reference and a byte span inside that document.
    aokanaIsoSampleBytes(movie, track, sample);
  }
  return {
    track,
    timeline,
    configurations,
    sampleBytes(index) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= track.samples.length)
        throw new RangeError('Selected movie sample index is outside its track');
      return aokanaIsoSampleBytes(movie, track, track.samples[index]!);
    },
  };
}

/** Browser ISO profile over explicitly chosen tracks from one selected physical source. */
export class AokanaMovieSourceTracks {
  private constructor(
    readonly document: AokanaMovieSourceDocument,
    readonly movie: AokanaIsoMovie,
    readonly video: AokanaMovieBoundTrack<VideoDecoderConfig>,
    readonly audio: AokanaMovieBoundTrack<AokanaAacDecoderConfiguration> | null,
  ) {}

  /** Track IDs are supplied by the caller; DirectShow RenderFile selection is not inferred here. */
  static prepare(
    document: AokanaMovieSourceDocument,
    videoTrackId: number,
    audioTrackId: number | null,
  ): AokanaMovieSourceTracks {
    if (!(document instanceof AokanaMovieSourceDocument))
      throw new TypeError('Movie tracks require the actual selected source document');
    const movie = document.movie;
    const select = (id: number, handler: string): AokanaIsoTrack => {
      if (!Number.isSafeInteger(id) || id <= 0 || id > 0xffffffff)
        throw new RangeError('Selected movie track ID must be a positive DWORD');
      const track = movie.tracks.find((candidate) => candidate.id === id);
      if (track === undefined || track.handler !== handler)
        throw new AokanaIsoSampleError(`Selected movie has no ${handler} track with ID ${id}`);
      return track;
    };
    const video = bindTrack(movie, select(videoTrackId, 'vide'), aokanaIsoAvcConfiguration);
    const audio =
      audioTrackId === null
        ? null
        : bindTrack(movie, select(audioTrackId, 'soun'), aokanaIsoAacConfiguration);
    return new AokanaMovieSourceTracks(document, movie, video, audio);
  }
}

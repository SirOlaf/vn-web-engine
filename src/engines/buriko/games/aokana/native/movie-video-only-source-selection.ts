import type {AokanaBpPointer} from '../bp/memory.js';
import {AokanaMovieReferenceClock} from './movie-render-events.js';
import {AokanaMovieSourceDocument} from './movie-source-document.js';
import {AokanaMovieSourceTracks} from './movie-source-tracks.js';
import {AokanaMovieVideoOnlyTimeline} from './movie-video-only-timeline.js';
import type {AokanaProductionDisplayResourceGraph} from './production-display-resource-graph.js';

/** One explicitly selected physical video-only source, before decoder or renderer creation. */
export class AokanaMovieVideoOnlySourceSelection {
  readonly tracks: AokanaMovieSourceTracks;
  readonly clock: AokanaMovieReferenceClock;
  readonly timeline: AokanaMovieVideoOnlyTimeline;

  private constructor(
    readonly graph: AokanaProductionDisplayResourceGraph,
    readonly document: AokanaMovieSourceDocument,
    videoTrackId: number,
    clock: AokanaMovieReferenceClock,
  ) {
    if (document.movie.tracks.some((track) => track.handler === 'soun'))
      throw new Error('Aokana video-only selection cannot discard a source audio track');
    this.tracks = AokanaMovieSourceTracks.prepare(document, videoTrackId, null);
    this.clock = clock;
    this.timeline = new AokanaMovieVideoOnlyTimeline(this.tracks, this.clock);
  }

  /** Selection always starts at the graph's real F04B0 physical document boundary. */
  static async open(
    graph: AokanaProductionDisplayResourceGraph,
    archive: AokanaBpPointer | null,
    name: AokanaBpPointer,
    maxDocumentBytes: number,
    videoTrackId: number,
  ): Promise<AokanaMovieVideoOnlySourceSelection | null> {
    const document = await graph.prepareMovieDocument(archive, name, maxDocumentBytes);
    return document === null
      ? null
      : new AokanaMovieVideoOnlySourceSelection(
          graph,
          document,
          videoTrackId,
          graph.createMovieReferenceClock(),
        );
  }

  dispose(): void {
    this.timeline.dispose();
  }
}

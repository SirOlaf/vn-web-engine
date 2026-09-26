import type {BurikoBpPointer} from '../bp/memory.js';
import {BurikoMovieReferenceClock} from './movie-render-events.js';
import {BurikoMovieSourceDocument} from './movie-source-document.js';
import {BurikoMovieSourceTracks} from './movie-source-tracks.js';
import {BurikoMovieVideoOnlyTimeline} from './movie-video-only-timeline.js';
import type {BurikoProductionDisplayResourceGraph} from './production-display-resource-graph.js';

/** One explicitly selected physical video-only source, before decoder or renderer creation. */
export class BurikoMovieVideoOnlySourceSelection {
  readonly tracks: BurikoMovieSourceTracks;
  readonly clock: BurikoMovieReferenceClock;
  readonly timeline: BurikoMovieVideoOnlyTimeline;

  private constructor(
    readonly graph: BurikoProductionDisplayResourceGraph,
    readonly document: BurikoMovieSourceDocument,
    videoTrackId: number,
    clock: BurikoMovieReferenceClock,
  ) {
    if (document.movie.tracks.some((track) => track.handler === 'soun'))
      throw new Error('Buriko video-only selection cannot discard a source audio track');
    this.tracks = BurikoMovieSourceTracks.prepare(document, videoTrackId, null);
    this.clock = clock;
    this.timeline = new BurikoMovieVideoOnlyTimeline(this.tracks, this.clock);
  }

  /** Selection always starts at the graph's real F04B0 physical document boundary. */
  static async open(
    graph: BurikoProductionDisplayResourceGraph,
    archive: BurikoBpPointer | null,
    name: BurikoBpPointer,
    maxDocumentBytes: number,
    videoTrackId: number,
  ): Promise<BurikoMovieVideoOnlySourceSelection | null> {
    const document = await graph.prepareMovieDocument(archive, name, maxDocumentBytes);
    return document === null
      ? null
      : new BurikoMovieVideoOnlySourceSelection(
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

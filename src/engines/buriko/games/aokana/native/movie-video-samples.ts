import {AokanaBitmapStorage} from './bitmap.js';
import type {AokanaMovieMediaType} from './movie-image.js';
import type {AokanaMovieTimedSample} from './movie-receive.js';
import {AokanaMovieVideoDecoder} from './movie-video-decoder.js';
import {
  createAokanaIsoTimeline,
  type AokanaIsoPresentation,
  type AokanaIsoTimeline,
} from './movie-iso-timeline.js';
import type {AokanaIsoMovie, AokanaIsoTrack} from './movie-iso-samples.js';

/** The installed decoder negotiates an unscaled, bottom-up VIDEOINFOHEADER/RGB32 pin. */
export function aokanaMovieRgb32Type(
  width: number,
  height: number,
  averageFrameTime: bigint,
): AokanaMovieMediaType {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > 0x7fffffff ||
    height > 0x7fffffff ||
    !Number.isSafeInteger(width * height * 4)
  )
    throw new DOMException(
      'Decoded movie geometry cannot form an RGB32 media type',
      'NotSupportedError',
    );
  const format = new Uint8Array(88),
    view = new DataView(format.buffer);
  view.setBigInt64(40, averageFrameTime, true);
  view.setUint32(48, 40, true);
  view.setInt32(52, width, true);
  view.setInt32(56, height, true);
  view.setUint16(60, 1, true);
  view.setUint16(62, 32, true);
  view.setUint32(68, width * height * 4, true);
  return {
    majorType: '73646976-0000-0010-8000-00aa00389b71',
    subtype: 'e436eb7e-524f-11ce-9f53-0020af0ba770',
    formatType: '05589f80-c356-11ce-bf01-00aa0055595a',
    format,
  };
}

export interface AokanaMovieVideoSample {
  readonly sample: AokanaMovieTimedSample;
  readonly type: AokanaMovieMediaType;
  /** Release after Receive returns, including all abort/error paths. */
  release(): void;
}

/** Converts one actual decoded picture; no canvas presentation or display timing participates. */
export async function aokanaCopyMoviePicture(
  frame: VideoFrame,
  presentation: AokanaIsoPresentation,
  averageFrameTime: bigint,
  discontinuity: boolean,
): Promise<AokanaMovieVideoSample> {
  const rectangle = frame.visibleRect;
  if (rectangle === null)
    throw new DOMException('Decoded movie has no visible rectangle', 'InvalidStateError');
  const width = rectangle.width,
    height = rectangle.height;
  const type = aokanaMovieRgb32Type(width, height, averageFrameTime);
  const bytes = new Uint8Array(width * height * 4);
  await frame.copyTo(bytes, {
    format: 'BGRA',
    rect: rectangle,
    layout: [{offset: 0, stride: width * 4}],
    colorSpace: 'srgb',
  });
  // Positive biHeight is also preserved by this title's dimensionMode=1 path.
  // WebCodecs supplies top-down planes, whereas the negotiated DIB stores bottom-up rows.
  const stride = width * 4;
  const row = new Uint8Array(stride);
  for (let y = 0; y < Math.floor(height / 2); y++) {
    const first = y * stride,
      last = (height - 1 - y) * stride;
    row.set(bytes.subarray(first, first + stride));
    bytes.copyWithin(first, last, last + stride);
    bytes.set(row, last);
  }
  const storage = new AokanaBitmapStorage(bytes, true);
  let released = false;
  return {
    type,
    sample: {
      storage,
      offset: 0,
      time: {start: presentation.start, end: presentation.end},
      discontinuity,
    },
    release() {
      if (!released) {
        released = true;
        storage.release();
      }
    },
  };
}

interface EditPlan {
  readonly index: number;
  readonly presentations: readonly AokanaIsoPresentation[];
}

/**
 * Concrete splitter output: positive edits preserve the codec's output order;
 * dwell/reverse edits seek through real decoder preroll for each selected picture.
 * Segment bounds flush delayed codec output and never synthesize missing pictures.
 */
export class AokanaMovieVideoSamples {
  readonly timeline: AokanaIsoTimeline;
  readonly averageFrameTime: bigint;
  private edits: EditPlan[] = [];
  private editCursor = 0;
  private reverseCursor = 0;
  private selection = new Map<number, AokanaIsoPresentation>();
  private editInitialized = false;
  private firstSample = true;
  private generation = 0;
  private disposed = false;
  private reading: number | null = null;

  private constructor(readonly decoder: AokanaMovieVideoDecoder) {
    const {track, movie} = decoder;
    this.timeline = createAokanaIsoTimeline(movie, track);
    const total = track.samples.reduce((sum, sample) => sum + BigInt(sample.duration), 0n);
    this.averageFrameTime =
      track.samples.length === 0
        ? 0n
        : (total * 10000000n) / (BigInt(track.samples.length) * BigInt(track.timescale));
    this.select(0n);
  }
  static async create(
    movie: AokanaIsoMovie,
    track: AokanaIsoTrack,
  ): Promise<AokanaMovieVideoSamples> {
    const decoder = await AokanaMovieVideoDecoder.create(movie, track);
    try {
      return new AokanaMovieVideoSamples(decoder);
    } catch (error) {
      decoder.dispose();
      throw error;
    }
  }
  private select(position: bigint): void {
    const edits = new Map<number, AokanaIsoPresentation[]>();
    for (const presentation of this.timeline.presentations) {
      if (
        presentation.end < position ||
        (presentation.end === position && presentation.start !== presentation.end)
      )
        continue;
      let entries = edits.get(presentation.editIndex);
      if (entries === undefined) {
        entries = [];
        edits.set(presentation.editIndex, entries);
      }
      // DirectShow segment timestamps are relative to the seek start, including preroll starts below zero.
      entries.push({
        ...presentation,
        start: presentation.start - position,
        end: presentation.end - position,
      });
    }
    this.edits = [...edits]
      .sort(([a], [b]) => a - b)
      .map(([index, presentations]) => ({index, presentations}));
    this.editCursor = 0;
    this.reverseCursor = 0;
    this.editInitialized = false;
    this.selection.clear();
    this.firstSample = true;
  }
  seek(position: bigint): void {
    if (this.disposed) throw new DOMException('Movie source is closed', 'InvalidStateError');
    this.generation++;
    this.select(position);
    // Reset immediately so a native flush can cancel a pending read, even for a seek beyond EOS.
    if (this.decoder.track.samples.length !== 0) this.decoder.seek(0);
  }
  private check(generation: number): void {
    if (this.disposed || generation !== this.generation)
      throw new DOMException('Movie sample read was cancelled', 'AbortError');
  }
  async next(): Promise<AokanaMovieVideoSample | null> {
    const generation = this.generation;
    this.check(generation);
    if (this.reading === generation) throw new Error('Concurrent Aokana movie splitter reads');
    this.reading = generation;
    try {
      for (;;) {
        this.check(generation);
        const edit = this.edits[this.editCursor];
        if (edit === undefined) return null;
        if (!this.editInitialized) {
          this.selection = new Map(edit.presentations.map((entry) => [entry.sampleIndex, entry]));
          this.reverseCursor = 0;
          if (edit.presentations[0]!.rate > 0) {
            let first = Infinity,
              last = -1;
            for (const entry of edit.presentations) {
              first = Math.min(first, entry.sampleIndex);
              last = Math.max(last, entry.sampleIndex);
            }
            this.decoder.seek(first, last + 1);
          }
          this.editInitialized = true;
          this.firstSample = true;
        }
        let selected: AokanaIsoPresentation | undefined;
        if (edit.presentations[0]!.rate <= 0) {
          selected = edit.presentations[this.reverseCursor++];
          if (selected === undefined) {
            this.editCursor++;
            this.editInitialized = false;
            continue;
          }
          this.decoder.seek(selected.sampleIndex, selected.sampleIndex + 1);
        }
        for (;;) {
          const picture = await this.decoder.next();
          try {
            this.check(generation);
          } catch (error) {
            picture?.frame.close();
            throw error;
          }
          if (picture === null) {
            if (selected === undefined) {
              this.editCursor++;
              this.editInitialized = false;
            }
            break;
          }
          const presentation =
            selected === undefined
              ? this.selection.get(picture.sampleIndex)
              : selected.sampleIndex === picture.sampleIndex
                ? selected
                : undefined;
          if (presentation === undefined) {
            picture.frame.close();
            continue;
          }
          this.selection.delete(picture.sampleIndex);
          try {
            const output = await aokanaCopyMoviePicture(
              picture.frame,
              presentation,
              this.averageFrameTime,
              this.firstSample,
            );
            try {
              this.check(generation);
            } catch (error) {
              output.release();
              throw error;
            }
            this.firstSample = false;
            return output;
          } finally {
            picture.frame.close();
          }
        }
      }
    } finally {
      if (this.reading === generation) this.reading = null;
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    this.decoder.dispose();
    this.edits.length = 0;
    this.selection.clear();
  }
}

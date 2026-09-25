import type {AokanaBpPointer} from '../bp/memory.js';
import type {AokanaLockActors} from './exclusion-locks.js';
import {AokanaMovieFileStream} from './movie-file-stream.js';
import {readAokanaIsoMovie, type AokanaIsoMovie} from './movie-iso-samples.js';
import {AokanaMovieSources, type AokanaMovieSourceLocation} from './movie-sources.js';

export interface AokanaMovieDocumentSource {
  readonly encodedPath: Uint8Array;
  readonly widePath: string;
  readonly offset: number;
  readonly length: number;
}

/** A selected browser ISO document over the actual F04B0 physical source. */
export class AokanaMovieSourceDocument {
  private constructor(
    readonly source: AokanaMovieDocumentSource,
    readonly movie: AokanaIsoMovie,
    readonly actor: object,
  ) {}

  /** The byte limit is an explicit browser materialization budget, not a native file limit. */
  static async open(
    sources: AokanaMovieSources,
    archive: AokanaBpPointer | null,
    name: AokanaBpPointer,
    actors: AokanaLockActors,
    rawMilliseconds: () => number,
    maxBytes: number,
  ): Promise<AokanaMovieSourceDocument | null> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 0xffffffff)
      throw new RangeError('Invalid Aokana browser movie document byte budget');
    const actor = actors.currentActor;
    const location = await sources.locate(archive, name);
    if (location === null) return null;
    const selected: AokanaMovieSourceLocation = {
      path: location.path.slice(),
      offset: location.offset >>> 0,
      length: location.length >>> 0,
    };
    const files = sources.resources.files;
    const widePath = files.path(selected.path);
    const bytes = await this.readSelectedRegion(
      selected,
      widePath,
      sources,
      actor,
      rawMilliseconds,
      maxBytes,
    );
    return new AokanaMovieSourceDocument(
      {
        encodedPath: selected.path,
        widePath,
        offset: selected.offset,
        length: selected.length,
      },
      readAokanaIsoMovie(bytes),
      actor,
    );
  }

  private static async readSelectedRegion(
    location: AokanaMovieSourceLocation,
    widePath: string,
    sources: AokanaMovieSources,
    actor: object,
    rawMilliseconds: () => number,
    maxBytes: number,
  ): Promise<Uint8Array> {
    const files = sources.resources.files;
    if (location.length === 0) {
      const opened = await files.openWide(widePath);
      const input = opened.source;
      if (input === null) throw new Error('Aokana movie source disappeared after selection');
      if (!Number.isSafeInteger(input.size) || input.size < 0 || input.size > maxBytes)
        throw new RangeError('Aokana direct movie exceeds browser document byte budget');
      const bytes = new Uint8Array(input.size);
      for (let at = 0; at < bytes.length;) {
        const chunk = await files.read(input, at, Math.min(0x20000, bytes.length - at));
        if (chunk.length === 0)
          throw new Error('Aokana direct movie read ended before the selected file size');
        bytes.set(chunk, at);
        at += chunk.length;
      }
      return bytes;
    }

    const length = location.length >>> 0;
    if (length > maxBytes)
      throw new RangeError('Aokana archive movie exceeds browser document byte budget');
    const input = new AokanaMovieFileStream(files, rawMilliseconds);
    try {
      if ((await input.initialize(widePath, length, location.offset)) !== 0)
        throw new Error('Aokana archive movie region could not be opened');
      const physicalSize = input.physicalSize;
      if (
        physicalSize === null ||
        !Number.isSafeInteger(physicalSize) ||
        BigInt(location.offset >>> 0) + BigInt(length) > BigInt(physicalSize)
      )
        throw new Error('Aokana archive movie region exceeds its physical file');
      const bytes = new Uint8Array(length);
      for (let at = 0; at < length;) {
        const count = Math.min(0x20000, length - at);
        const result = await input.read(bytes, at, count, actor);
        if (result.status !== 0 || result.count !== count || input.physicalReadCount !== count)
          throw new Error('Aokana archive movie region read did not fill its selected span');
        at += count;
      }
      return bytes;
    } finally {
      input.dispose();
    }
  }
}

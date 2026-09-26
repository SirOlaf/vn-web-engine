import type {BurikoBpPointer} from '../bp/memory.js';
import type {BurikoLockActors} from './exclusion-locks.js';
import {BurikoMovieFileStream} from './movie-file-stream.js';
import {readBurikoIsoMovie, type BurikoIsoMovie} from './movie-iso-samples.js';
import {BurikoMovieSources, type BurikoMovieSourceLocation} from './movie-sources.js';

export interface BurikoMovieDocumentSource {
  readonly encodedPath: Uint8Array;
  readonly widePath: string;
  readonly offset: number;
  readonly length: number;
}

/** A selected browser ISO document over the actual F04B0 physical source. */
export class BurikoMovieSourceDocument {
  private constructor(
    readonly source: BurikoMovieDocumentSource,
    readonly movie: BurikoIsoMovie,
    readonly actor: object,
  ) {}

  /** The byte limit is an explicit browser materialization budget, not a native file limit. */
  static async open(
    sources: BurikoMovieSources,
    archive: BurikoBpPointer | null,
    name: BurikoBpPointer,
    actors: BurikoLockActors,
    rawMilliseconds: () => number,
    maxBytes: number,
  ): Promise<BurikoMovieSourceDocument | null> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 0xffffffff)
      throw new RangeError('Invalid Buriko browser movie document byte budget');
    const actor = actors.currentActor;
    const location = await sources.locate(archive, name);
    if (location === null) return null;
    return this.openSelected(location, sources, actor, rawMilliseconds, maxBytes);
  }

  /** Continue from a physically selected F04B0 source after 040430 releases the old slot. */
  static async openSelected(
    location: BurikoMovieSourceLocation,
    sources: BurikoMovieSources,
    actor: object,
    rawMilliseconds: () => number,
    maxBytes: number,
  ): Promise<BurikoMovieSourceDocument> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 0xffffffff)
      throw new RangeError('Invalid Buriko browser movie document byte budget');
    const selected: BurikoMovieSourceLocation = {
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
    return new BurikoMovieSourceDocument(
      {
        encodedPath: selected.path,
        widePath,
        offset: selected.offset,
        length: selected.length,
      },
      readBurikoIsoMovie(bytes),
      actor,
    );
  }

  private static async readSelectedRegion(
    location: BurikoMovieSourceLocation,
    widePath: string,
    sources: BurikoMovieSources,
    actor: object,
    rawMilliseconds: () => number,
    maxBytes: number,
  ): Promise<Uint8Array> {
    const files = sources.resources.files;
    if (location.length === 0) {
      const opened = await files.openWide(widePath);
      const input = opened.source;
      if (input === null) throw new Error('Buriko movie source disappeared after selection');
      if (!Number.isSafeInteger(input.size) || input.size < 0 || input.size > maxBytes)
        throw new RangeError('Buriko direct movie exceeds browser document byte budget');
      const bytes = new Uint8Array(input.size);
      for (let at = 0; at < bytes.length;) {
        const chunk = await files.read(input, at, Math.min(0x20000, bytes.length - at));
        if (chunk.length === 0)
          throw new Error('Buriko direct movie read ended before the selected file size');
        bytes.set(chunk, at);
        at += chunk.length;
      }
      return bytes;
    }

    const length = location.length >>> 0;
    if (length > maxBytes)
      throw new RangeError('Buriko archive movie exceeds browser document byte budget');
    const input = new BurikoMovieFileStream(files, rawMilliseconds);
    try {
      if ((await input.initialize(widePath, length, location.offset)) !== 0)
        throw new Error('Buriko archive movie region could not be opened');
      const physicalSize = input.physicalSize;
      if (
        physicalSize === null ||
        !Number.isSafeInteger(physicalSize) ||
        BigInt(location.offset >>> 0) + BigInt(length) > BigInt(physicalSize)
      )
        throw new Error('Buriko archive movie region exceeds its physical file');
      const bytes = new Uint8Array(length);
      for (let at = 0; at < length;) {
        const count = Math.min(0x20000, length - at);
        const result = await input.read(bytes, at, count, actor);
        if (result.status !== 0 || result.count !== count || input.physicalReadCount !== count)
          throw new Error('Buriko archive movie region read did not fill its selected span');
        at += count;
      }
      return bytes;
    } finally {
      input.dispose();
    }
  }
}

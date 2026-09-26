import type {AokanaBpPointer} from '../bp/memory.js';
import {sourceBlob} from '../../../../../core/source.js';
import type {AokanaProgramFiles} from './program-files.js';
import {
  AokanaMfMovieSourceCandidates,
  type AokanaMfArchiveSourceCandidate,
  type AokanaMfDirectSourceCandidate,
} from './movie-mf-source-candidates.js';

/** The exact physical MF region, retaining its local file backing when available. */
export interface AokanaMfMovieDocument {
  readonly blob: Blob;
  readonly kind: 'direct' | 'archive';
}

export class AokanaMfMovieDocuments {
  constructor(
    readonly candidates: AokanaMfMovieSourceCandidates,
    readonly files: AokanaProgramFiles,
    readonly byteBudget: number,
  ) {
    if (candidates.resources.files !== files)
      throw new Error('Aokana MF source candidates require the selected file owner');
    if (!Number.isSafeInteger(byteBudget) || byteBudget < 1 || byteBudget > 0xffffffff)
      throw new RangeError('Invalid Aokana MF browser document byte budget');
  }

  direct(name: AokanaBpPointer): Promise<AokanaMfDirectSourceCandidate | null> {
    return this.candidates.direct(name);
  }

  archive(
    archive: AokanaBpPointer | null,
    name: AokanaBpPointer,
  ): Promise<AokanaMfArchiveSourceCandidate | null> {
    return this.candidates.archive(archive, name);
  }

  async read(
    candidate: AokanaMfDirectSourceCandidate | AokanaMfArchiveSourceCandidate,
    signal: AbortSignal,
  ): Promise<AokanaMfMovieDocument> {
    const opened = await this.files.open(candidate.path);
    if (signal.aborted) throw new DOMException('MF movie source was retired', 'AbortError');
    const source = opened.source;
    if (source === null) throw new Error('Aokana MF selected physical source cannot be opened');
    const start = candidate.kind === 'archive' ? candidate.offset >>> 0 : 0;
    const length = candidate.kind === 'archive' ? candidate.length >>> 0 : source.size;
    if (
      !Number.isSafeInteger(source.size) ||
      source.size < 0 ||
      BigInt(start) + BigInt(length) > BigInt(source.size) ||
      length > this.byteBudget
    )
      throw new RangeError('Aokana MF source exceeds its physical region or browser byte budget');
    const local = sourceBlob(source, start, length);
    if (local !== null) return {kind: candidate.kind, blob: local};
    const bytes = new Uint8Array(length);
    for (let at = 0; at < length;) {
      if (signal.aborted) throw new DOMException('MF movie source was retired', 'AbortError');
      const chunk = await this.files.read(source, start + at, Math.min(0x20000, length - at));
      if (chunk.length === 0 || chunk.length > length - at)
        throw new Error('Aokana MF source read did not fill its selected region');
      bytes.set(chunk, at);
      at += chunk.length;
    }
    if (signal.aborted) throw new DOMException('MF movie source was retired', 'AbortError');
    return {kind: candidate.kind, blob: new Blob([bytes.buffer])};
  }
}

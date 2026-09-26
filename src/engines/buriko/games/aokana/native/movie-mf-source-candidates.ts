import type {AokanaBpPointer} from '../bp/memory.js';
import {assertAokanaPathDomain} from './path-domain.js';
import type {AokanaProgramResources} from './program-resources.js';
import {textBytes} from './text.js';

export interface AokanaMfDirectSourceCandidate {
  readonly kind: 'direct';
  /** F0AF0's encoded path, passed to the direct 10FC70 source attempt. */
  readonly path: Uint8Array;
}

export interface AokanaMfArchiveSourceCandidate {
  readonly kind: 'archive';
  /** BA330's independently resolved physical archive path. */
  readonly path: Uint8Array;
  readonly member: Uint8Array;
  readonly offset: number;
  readonly length: number;
}

/** F0AF0's source candidates, separate from F04B0's surface-movie selector.
 * The caller tries an archive candidate only after its direct MF source attempt fails. */
export class AokanaMfMovieSourceCandidates {
  constructor(readonly resources: AokanaProgramResources) {}

  async direct(name: AokanaBpPointer): Promise<AokanaMfDirectSourceCandidate | null> {
    const {files, configuration} = this.resources;
    const decoded = files.text.decodeAuto(name);
    assertAokanaPathDomain(decoded);
    const primary = configuration.nativeFileRoot;
    const secondary = configuration.secondaryMediaPath;
    assertAokanaPathDomain(primary);

    // BB2A0 uses GetFileAttributesW, accepting either a file or a directory.
    // Its primary check does not require the media-availability gate in BB3C0.
    for (const [index, root] of [primary, secondary].entries()) {
      if (index === 1 && !files.media.isAvailable(secondary)) continue;
      if (index === 1) assertAokanaPathDomain(secondary);
      const wide = root + decoded;
      if (wide.length >= 784)
        throw new RangeError('Aokana MF direct path exceeds native wide scratch');
      if (await files.hasPathWide(wide)) return {kind: 'direct', path: this.boundedPath(wide)};
    }

    // Only a BB2A0 miss reaches the primary BB3C0 search-directory lookup.
    const path = await this.resources.findRelativeFile(primary, name);
    return path === null ? null : {kind: 'direct', path: this.boundedBytes(path)};
  }

  async archive(
    archive: AokanaBpPointer | null,
    name: AokanaBpPointer,
  ): Promise<AokanaMfArchiveSourceCandidate | null> {
    if (archive === null) return null;
    const member = Uint8Array.from(textBytes(name, true));
    const found = await this.resources.locateArchiveEntry(textBytes(archive, true), member);
    if (found === null) return null;
    const record = new DataView(
      found.record.buffer,
      found.record.byteOffset,
      found.record.byteLength,
    );
    return {
      kind: 'archive',
      path: this.boundedBytes(found.path),
      member,
      offset: record.getUint32(96, true),
      length: record.getUint32(100, true),
    };
  }

  private boundedPath(path: string): Uint8Array {
    return this.boundedBytes(this.resources.files.text.encodeWide(path, 1));
  }

  private boundedBytes(path: Uint8Array): Uint8Array {
    if (path.length > 784)
      throw new RangeError('Aokana MF path exceeds native caller output storage');
    return path;
  }
}

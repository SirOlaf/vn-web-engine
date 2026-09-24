import type {AokanaBpPointer} from '../bp/memory.js';
import type {AokanaProgramResources} from './program-resources.js';
import {textBytes} from './text.js';

export interface AokanaMovieSourceLocation {
  readonly path: Uint8Array;
  readonly offset: number;
  /** Zero selects the ordinary whole-file graph source, as in F04B0. */
  readonly length: number;
}

/** Real F04B0 resource selection, preceding renderer construction and status handling. */
export class AokanaMovieSources {
  constructor(readonly resources: AokanaProgramResources) {}
  async locate(
    archive: AokanaBpPointer | null,
    name: AokanaBpPointer,
  ): Promise<AokanaMovieSourceLocation | null> {
    const configuration = this.resources.configuration;
    let path = await this.resources.findRelativeFile(configuration.nativeFileRoot, name);
    if (path === null)
      path = await this.resources.findRelativeFile(configuration.secondaryMediaPath, name);
    if (path !== null) {
      if (path.length > 784)
        throw new RangeError('Aokana movie path exceeds native caller output storage');
      return {path, offset: 0, length: 0};
    }
    if (archive === null) return null;
    const found = await this.resources.locateArchiveEntry(
      textBytes(archive, true),
      textBytes(name, true),
    );
    if (found === null) return null;
    if (found.path.length > 784)
      throw new RangeError('Aokana movie path exceeds native caller output storage');
    const record = new DataView(
      found.record.buffer,
      found.record.byteOffset,
      found.record.byteLength,
    );
    return {
      path: found.path,
      offset: record.getUint32(96, true),
      length: record.getUint32(100, true),
    };
  }
}

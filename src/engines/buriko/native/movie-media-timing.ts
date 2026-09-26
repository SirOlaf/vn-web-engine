export class BurikoMovieTimingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BurikoMovieTimingError';
  }
}
export interface BurikoIsoMovieTrack {
  readonly id: number;
  readonly enabled: boolean;
  readonly timescale: number;
  readonly sampleCount: bigint;
  readonly sampleDuration: bigint;
  readonly averageFrameTime: bigint;
}
interface Atom {
  readonly type: string;
  readonly start: number;
  readonly body: number;
  readonly end: number;
}
interface MutableTrack {
  id: number;
  enabled: boolean;
  timescale: number;
  sampleCount: bigint;
  sampleDuration: bigint;
}
function requireBytes(bytes: Uint8Array, at: number, length: number, end = bytes.length): void {
  if (
    !Number.isSafeInteger(at) ||
    !Number.isSafeInteger(length) ||
    at < 0 ||
    length < 0 ||
    at + length > end
  )
    throw new BurikoMovieTimingError('Buriko movie timing reads beyond its encoded atom');
}
function typeAt(bytes: Uint8Array, at: number): string {
  requireBytes(bytes, at, 4);
  return String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
}
/** ISO/QuickTime metadata only. Compressed samples are left to the actual platform decoder. */
export function readBurikoIsoMovieTracks(bytes: Uint8Array): BurikoIsoMovieTrack[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const atoms = (start: number, end: number): Atom[] => {
    const output: Atom[] = [];
    for (let at = start; at < end;) {
      requireBytes(bytes, at, 8, end);
      const type = typeAt(bytes, at + 4),
        short = view.getUint32(at),
        header = short === 1 ? 16 : 8;
      requireBytes(bytes, at, header, end);
      const size =
        short === 0 ? BigInt(end - at) : short === 1 ? view.getBigUint64(at + 8) : BigInt(short);
      if (size < BigInt(header) || size > BigInt(end - at))
        throw new BurikoMovieTimingError('Buriko movie atom has an invalid size');
      const body = at + header + (type === 'uuid' ? 16 : 0),
        next = at + Number(size);
      requireBytes(bytes, body, 0, next);
      output.push({type, start: at, body, end: next});
      at = next;
    }
    return output;
  };
  const child = (parent: Atom, type: string): Atom | undefined =>
    atoms(parent.body, parent.end).find((atom) => atom.type === type);
  const fullBox = (atom: Atom, bytesNeeded: number): number => {
    requireBytes(bytes, atom.body, bytesNeeded, atom.end);
    return view.getUint32(atom.body);
  };
  const top = atoms(0, bytes.length),
    movie = top.find((atom) => atom.type === 'moov');
  if (movie === undefined) throw new BurikoMovieTimingError('Buriko movie has no ISO media header');
  const tracks: MutableTrack[] = [];
  for (const track of atoms(movie.body, movie.end).filter((atom) => atom.type === 'trak')) {
    const media = child(track, 'mdia');
    if (media === undefined) continue;
    const handler = child(media, 'hdlr');
    if (handler === undefined || (fullBox(handler, 12), typeAt(bytes, handler.body + 8)) !== 'vide')
      continue;
    const trackHeader = child(track, 'tkhd'),
      mediaHeader = child(media, 'mdhd');
    if (trackHeader === undefined || mediaHeader === undefined)
      throw new BurikoMovieTimingError('Buriko video track has incomplete timing headers');
    const trackFlags = fullBox(trackHeader, 4),
      trackVersion = trackFlags >>> 24;
    const mediaVersion = fullBox(mediaHeader, 4) >>> 24;
    if (trackVersion > 1 || mediaVersion > 1)
      throw new BurikoMovieTimingError('Buriko movie has an unknown timing-header version');
    requireBytes(bytes, trackHeader.body, trackVersion === 1 ? 24 : 16, trackHeader.end);
    requireBytes(bytes, mediaHeader.body, mediaVersion === 1 ? 24 : 16, mediaHeader.end);
    const entry: MutableTrack = {
      id: view.getUint32(trackHeader.body + (trackVersion === 1 ? 20 : 12)),
      enabled: (trackFlags & 1) !== 0,
      timescale: view.getUint32(mediaHeader.body + (mediaVersion === 1 ? 20 : 12)),
      sampleCount: 0n,
      sampleDuration: 0n,
    };
    if (entry.timescale === 0)
      throw new BurikoMovieTimingError('Buriko movie timing has a zero media timescale');
    const information = child(media, 'minf'),
      table = information === undefined ? undefined : child(information, 'stbl');
    const timing = table === undefined ? undefined : child(table, 'stts');
    if (timing !== undefined) {
      if (fullBox(timing, 8) >>> 24 !== 0)
        throw new BurikoMovieTimingError('Buriko movie has an unknown sample-timing version');
      const count = view.getUint32(timing.body + 4);
      requireBytes(bytes, timing.body + 8, count * 8, timing.end);
      for (let index = 0; index < count; index++) {
        const at = timing.body + 8 + index * 8,
          samples = BigInt(view.getUint32(at)),
          duration = BigInt(view.getUint32(at + 4));
        entry.sampleCount += samples;
        entry.sampleDuration += samples * duration;
      }
    }
    tracks.push(entry);
  }
  const defaultDurations = new Map<number, number>();
  const extensions = child(movie, 'mvex');
  if (extensions !== undefined)
    for (const extension of atoms(extensions.body, extensions.end))
      if (extension.type === 'trex') {
        fullBox(extension, 24);
        defaultDurations.set(
          view.getUint32(extension.body + 4),
          view.getUint32(extension.body + 12),
        );
      }
  for (const fragment of top.filter((atom) => atom.type === 'moof'))
    for (const traf of atoms(fragment.body, fragment.end).filter((atom) => atom.type === 'traf')) {
      const header = child(traf, 'tfhd');
      if (header === undefined)
        throw new BurikoMovieTimingError('Buriko movie fragment lacks its track header');
      const flags = fullBox(header, 8) & 0xffffff,
        id = view.getUint32(header.body + 4);
      const track = tracks.find((entry) => entry.id === id);
      if (track === undefined) continue;
      let cursor = header.body + 8;
      if (flags & 1) cursor += 8;
      if (flags & 2) cursor += 4;
      let defaultDuration = defaultDurations.get(id);
      if (flags & 8) {
        requireBytes(bytes, cursor, 4, header.end);
        defaultDuration = view.getUint32(cursor);
        cursor += 4;
      }
      if (flags & 16) cursor += 4;
      if (flags & 32) cursor += 4;
      requireBytes(bytes, cursor, 0, header.end);
      for (const run of atoms(traf.body, traf.end).filter((atom) => atom.type === 'trun')) {
        const runFlags = fullBox(run, 8),
          count = view.getUint32(run.body + 4);
        if (runFlags >>> 24 > 1)
          throw new BurikoMovieTimingError('Buriko movie fragment has an unknown timing version');
        cursor = run.body + 8;
        if (runFlags & 1) cursor += 4;
        if (runFlags & 4) cursor += 4;
        const fields =
          Number((runFlags & 0x100) !== 0) +
          Number((runFlags & 0x200) !== 0) +
          Number((runFlags & 0x400) !== 0) +
          Number((runFlags & 0x800) !== 0);
        requireBytes(bytes, cursor, fields * 4 * count, run.end);
        if ((flags & 0x10000) !== 0 && count !== 0)
          throw new BurikoMovieTimingError('Buriko empty movie fragment contains samples');
        if ((runFlags & 0x100) === 0) {
          if (defaultDuration === undefined && count !== 0)
            throw new BurikoMovieTimingError('Buriko movie fragment has no sample durations');
          track.sampleCount += BigInt(count);
          track.sampleDuration += BigInt(count) * BigInt(defaultDuration ?? 0);
        } else
          for (let sample = 0; sample < count; sample++, cursor += fields * 4) {
            track.sampleCount++;
            track.sampleDuration += BigInt(view.getUint32(cursor));
          }
      }
    }
  return tracks.map((track) => ({
    ...track,
    averageFrameTime:
      track.sampleCount === 0n
        ? 0n
        : (track.sampleDuration * 10000000n) / (track.sampleCount * BigInt(track.timescale)),
  }));
}

/** ISO/QuickTime sample tables at the browser media boundary, independent of VM timing. */
export class BurikoIsoSampleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BurikoIsoSampleError';
  }
}
export interface BurikoIsoBox {
  readonly type: string;
  readonly start: number;
  readonly body: number;
  readonly end: number;
}
export interface BurikoIsoDescription {
  readonly type: string;
  readonly dataReference: number;
  /** Complete sample entry, including its size and four-character code. */
  readonly bytes: Uint8Array;
  readonly headerSize: number;
}
export interface BurikoIsoDataReference {
  readonly type: string;
  readonly flags: number;
  readonly bytes: Uint8Array;
}
export interface BurikoIsoEdit {
  readonly duration: bigint;
  readonly mediaTime: bigint;
  /** Signed 16.16 value. Zero denotes a dwell edit; negative values retain reverse playback. */
  readonly rate: number;
}
export interface BurikoIsoSample {
  readonly offset: bigint;
  readonly size: number;
  readonly description: number;
  readonly decodeTime: bigint;
  readonly compositionTime: bigint;
  readonly duration: number;
  readonly sync: boolean;
  /** ISO sample flags, retaining dependency/redundancy/padding/degradation information. */
  readonly flags: number;
}
export interface BurikoIsoTrack {
  readonly id: number;
  readonly enabled: boolean;
  readonly handler: string;
  readonly timescale: number;
  readonly duration: bigint;
  /** tkhd duration in the movie timescale, distinct from mdhd's media duration. */
  readonly movieDuration: bigint;
  readonly matrix: readonly number[];
  readonly width: number;
  readonly height: number;
  readonly descriptions: readonly BurikoIsoDescription[];
  readonly dataReferences: readonly BurikoIsoDataReference[];
  readonly edits: readonly BurikoIsoEdit[];
  readonly samples: BurikoIsoSample[];
}
export interface BurikoIsoMovie {
  readonly bytes: Uint8Array;
  readonly timescale: number;
  readonly duration: bigint;
  readonly tracks: readonly BurikoIsoTrack[];
}

class Reader {
  readonly view: DataView;
  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  require(at: number, length: number, end = this.bytes.length): void {
    if (
      !Number.isSafeInteger(at) ||
      !Number.isSafeInteger(length) ||
      at < 0 ||
      length < 0 ||
      at + length > end
    )
      throw new BurikoIsoSampleError('ISO sample metadata reads beyond its encoded box');
  }
  u32(at: number, end?: number): number {
    this.require(at, 4, end);
    return this.view.getUint32(at);
  }
  i32(at: number, end?: number): number {
    return this.u32(at, end) | 0;
  }
  u64(at: number, end?: number): bigint {
    this.require(at, 8, end);
    return this.view.getBigUint64(at);
  }
  i64(at: number, end?: number): bigint {
    return BigInt.asIntN(64, this.u64(at, end));
  }
  type(at: number): string {
    this.require(at, 4);
    return String.fromCharCode(...this.bytes.subarray(at, at + 4));
  }
  boxes(start: number, end: number): BurikoIsoBox[] {
    const result: BurikoIsoBox[] = [];
    for (let at = start; at < end;) {
      this.require(at, 8, end);
      const short = this.u32(at),
        type = this.type(at + 4),
        header = short === 1 ? 16 : 8;
      this.require(at, header, end);
      const size = short === 0 ? BigInt(end - at) : short === 1 ? this.u64(at + 8) : BigInt(short);
      if (size < BigInt(header) || size > BigInt(end - at))
        throw new BurikoIsoSampleError('Invalid ISO box size');
      const next = at + Number(size),
        body = at + header + (type === 'uuid' ? 16 : 0);
      this.require(body, 0, next);
      result.push({type, start: at, body, end: next});
      at = next;
    }
    return result;
  }
  children(box: BurikoIsoBox): BurikoIsoBox[] {
    return this.boxes(box.body, box.end);
  }
  child(box: BurikoIsoBox, type: string): BurikoIsoBox | undefined {
    return this.children(box).find((entry) => entry.type === type);
  }
  required(box: BurikoIsoBox, type: string): BurikoIsoBox {
    const found = this.child(box, type);
    if (found === undefined) throw new BurikoIsoSampleError(`Missing ISO ${type} box`);
    return found;
  }
  full(box: BurikoIsoBox, maxVersion = 0): number {
    const flags = this.u32(box.body, box.end);
    if (flags >>> 24 > maxVersion)
      throw new BurikoIsoSampleError(`Unknown ISO ${box.type} version`);
    return flags;
  }
  rows(
    box: BurikoIsoBox,
    stride: number,
    maxVersion = 0,
  ): {count: number; at: number; version: number} {
    const version = this.full(box, maxVersion) >>> 24,
      count = this.u32(box.body + 4, box.end),
      at = box.body + 8;
    this.require(at, count * stride, box.end);
    return {count, at, version};
  }
}
interface Run {
  count: number;
  value: number;
}
class Runs {
  private index = 0;
  private used = 0;
  constructor(readonly runs: readonly Run[]) {}
  take(): number {
    while (this.index < this.runs.length && this.used === this.runs[this.index]!.count) {
      this.index++;
      this.used = 0;
    }
    const run = this.runs[this.index];
    if (run === undefined)
      throw new BurikoIsoSampleError('ISO timing table contains fewer samples than its size table');
    this.used++;
    return run.value;
  }
  finish(): void {
    while (this.index < this.runs.length && this.used === this.runs[this.index]!.count) {
      this.index++;
      this.used = 0;
    }
    if (this.index !== this.runs.length)
      throw new BurikoIsoSampleError('ISO timing table contains extra samples');
  }
}
function readRuns(reader: Reader, box: BurikoIsoBox, composition = false): Runs {
  const {count, at, version} = reader.rows(box, 8, composition ? 1 : 0),
    runs: Run[] = [];
  for (let index = 0; index < count; index++)
    runs.push({
      count: reader.u32(at + index * 8),
      value:
        composition && version === 1
          ? reader.i32(at + index * 8 + 4)
          : reader.u32(at + index * 8 + 4),
    });
  return new Runs(runs);
}
function readEdits(reader: Reader, track: BurikoIsoBox): BurikoIsoEdit[] {
  const edit = reader.child(track, 'edts'),
    list = edit === undefined ? undefined : reader.child(edit, 'elst');
  if (list === undefined) return [];
  const version = reader.full(list, 1) >>> 24,
    stride = version === 1 ? 20 : 12;
  const {count, at} = reader.rows(list, stride, 1),
    output: BurikoIsoEdit[] = [];
  for (let index = 0; index < count; index++) {
    const p = at + index * stride;
    output.push({
      duration: version === 1 ? reader.u64(p) : BigInt(reader.u32(p)),
      mediaTime: version === 1 ? reader.i64(p + 8) : BigInt(reader.i32(p + 4)),
      rate: reader.i32(p + stride - 4),
    });
  }
  return output;
}
function readDescriptions(reader: Reader, table: BurikoIsoBox): BurikoIsoDescription[] {
  const box = reader.required(table, 'stsd');
  reader.full(box);
  const count = reader.u32(box.body + 4, box.end),
    descriptions = reader.boxes(box.body + 8, box.end);
  if (descriptions.length !== count)
    throw new BurikoIsoSampleError('ISO sample-description count differs from its entries');
  return descriptions.map((entry) => {
    reader.require(entry.body, 8, entry.end);
    return {
      type: entry.type,
      dataReference: reader.view.getUint16(entry.body + 6),
      bytes: reader.bytes.subarray(entry.start, entry.end),
      headerSize: entry.body - entry.start,
    };
  });
}
function readDataReferences(reader: Reader, information: BurikoIsoBox): BurikoIsoDataReference[] {
  const container = reader.child(information, 'dinf'),
    box = container === undefined ? undefined : reader.child(container, 'dref');
  if (box === undefined) return [];
  reader.full(box);
  const count = reader.u32(box.body + 4, box.end),
    entries = reader.boxes(box.body + 8, box.end);
  if (entries.length !== count)
    throw new BurikoIsoSampleError('ISO data-reference count differs from its entries');
  return entries.map((entry) => ({
    type: entry.type,
    flags: reader.full(entry) & 0xffffff,
    bytes: reader.bytes.subarray(entry.body + 4, entry.end),
  }));
}
function readSizes(reader: Reader, table: BurikoIsoBox): number[] {
  const normal = reader.child(table, 'stsz'),
    compact = reader.child(table, 'stz2');
  if (normal !== undefined && compact !== undefined)
    throw new BurikoIsoSampleError('ISO track has two sample-size tables');
  const box = normal ?? compact;
  if (box === undefined) throw new BurikoIsoSampleError('ISO track lacks a sample-size table');
  reader.full(box);
  const count = reader.u32(box.body + 8, box.end),
    output: number[] = [];
  if (normal !== undefined) {
    const constant = reader.u32(box.body + 4, box.end);
    if (constant === 0) reader.require(box.body + 12, count * 4, box.end);
    for (let index = 0; index < count; index++)
      output.push(constant || reader.u32(box.body + 12 + index * 4));
  } else {
    const bits = reader.u32(box.body + 4, box.end) & 255;
    if (bits !== 4 && bits !== 8 && bits !== 16)
      throw new BurikoIsoSampleError('Invalid ISO compact sample-size width');
    reader.require(box.body + 12, Math.ceil((count * bits) / 8), box.end);
    for (let index = 0; index < count; index++) {
      const at = box.body + 12 + Math.floor((index * bits) / 8);
      output.push(
        bits === 16
          ? reader.view.getUint16(at)
          : bits === 8
            ? reader.bytes[at]!
            : (reader.bytes[at]! >>> ((index & 1) === 0 ? 4 : 0)) & 15,
      );
    }
  }
  return output;
}
function readOrdinarySamples(reader: Reader, table: BurikoIsoBox, track: BurikoIsoTrack): void {
  const sizes = readSizes(reader, table),
    duration = readRuns(reader, reader.required(table, 'stts'));
  const compositionBox = reader.child(table, 'ctts'),
    composition = compositionBox === undefined ? undefined : readRuns(reader, compositionBox, true);
  const chunkMap = reader.required(table, 'stsc'),
    mapping = reader.rows(chunkMap, 12),
    chunks: Array<{first: number; count: number; description: number}> = [];
  for (let index = 0; index < mapping.count; index++) {
    const p = mapping.at + index * 12,
      first = reader.u32(p),
      count = reader.u32(p + 4),
      description = reader.u32(p + 8);
    if (
      (index === 0 && first !== 1) ||
      (index !== 0 && first <= chunks[index - 1]!.first) ||
      count === 0 ||
      description === 0 ||
      description > track.descriptions.length
    )
      throw new BurikoIsoSampleError('Invalid ISO sample-to-chunk mapping');
    chunks.push({first, count, description});
  }
  const narrow = reader.child(table, 'stco'),
    wide = reader.child(table, 'co64');
  if (narrow !== undefined && wide !== undefined)
    throw new BurikoIsoSampleError('ISO track has two chunk-offset tables');
  const offsets = narrow ?? wide;
  if (offsets === undefined) throw new BurikoIsoSampleError('ISO track lacks chunk offsets');
  const offsetRows = reader.rows(offsets, wide === undefined ? 4 : 8);
  const syncBox = reader.child(table, 'stss'),
    sync = syncBox === undefined ? undefined : new Set<number>();
  if (syncBox !== undefined) {
    const rows = reader.rows(syncBox, 4);
    for (let index = 0; index < rows.count; index++) {
      const sample = reader.u32(rows.at + index * 4);
      if (sample === 0 || sample > sizes.length)
        throw new BurikoIsoSampleError('Invalid ISO sync-sample number');
      sync!.add(sample);
    }
  }
  const dependency = reader.child(table, 'sdtp');
  if (dependency !== undefined) {
    reader.full(dependency);
    reader.require(dependency.body + 4, sizes.length, dependency.end);
  }
  let sample = 0,
    map = 0,
    decodeTime = 0n;
  for (let chunk = 1; chunk <= offsetRows.count; chunk++) {
    while (map + 1 < chunks.length && chunks[map + 1]!.first <= chunk) map++;
    const entry = chunks[map];
    if (entry === undefined) throw new BurikoIsoSampleError('ISO chunk has no sample mapping');
    const p = offsetRows.at + (chunk - 1) * (wide === undefined ? 4 : 8);
    let offset = wide === undefined ? BigInt(reader.u32(p)) : reader.u64(p);
    for (let index = 0; index < entry.count; index++) {
      const size = sizes[sample];
      if (size === undefined)
        throw new BurikoIsoSampleError('ISO chunk map contains extra samples');
      const delta = duration.take(),
        cto = composition?.take() ?? 0,
        isSync = sync?.has(sample + 1) ?? true;
      const dependencies =
        dependency === undefined ? 0 : reader.bytes[dependency.body + 4 + sample]!;
      track.samples.push({
        offset,
        size,
        description: entry.description,
        decodeTime,
        compositionTime: decodeTime + BigInt(cto),
        duration: delta,
        sync: isSync,
        flags: ((dependencies << 20) | (isSync ? 0 : 0x10000)) >>> 0,
      });
      sample++;
      offset += BigInt(size);
      decodeTime += BigInt(delta);
    }
  }
  if (sample !== sizes.length)
    throw new BurikoIsoSampleError('ISO chunk map contains fewer samples than its size table');
  if (chunks.length !== 0 && chunks[chunks.length - 1]!.first > offsetRows.count)
    throw new BurikoIsoSampleError('ISO sample mapping refers to a missing chunk');
  duration.finish();
  composition?.finish();
}
interface FragmentDefaults {
  description: number;
  duration: number;
  size: number;
  flags: number;
}
function readFragments(
  reader: Reader,
  movie: BurikoIsoBox,
  top: readonly BurikoIsoBox[],
  tracks: readonly BurikoIsoTrack[],
): void {
  const extensions = reader.child(movie, 'mvex'),
    defaults = new Map<number, FragmentDefaults>();
  if (extensions !== undefined)
    for (const box of reader.children(extensions))
      if (box.type === 'trex') {
        reader.full(box);
        reader.require(box.body, 24, box.end);
        const id = reader.u32(box.body + 4);
        if (defaults.has(id))
          throw new BurikoIsoSampleError('ISO movie repeats track fragment defaults');
        defaults.set(id, {
          description: reader.u32(box.body + 8),
          duration: reader.u32(box.body + 12),
          size: reader.u32(box.body + 16),
          flags: reader.u32(box.body + 20),
        });
      }
  const ends = new Map<number, bigint>();
  for (const track of tracks) {
    const last = track.samples.at(-1);
    ends.set(track.id, last === undefined ? 0n : last.decodeTime + BigInt(last.duration));
  }
  for (const fragment of top.filter((box) => box.type === 'moof')) {
    let priorDataEnd = BigInt(fragment.start);
    for (const traf of reader.children(fragment).filter((box) => box.type === 'traf')) {
      const header = reader.required(traf, 'tfhd'),
        flags = reader.full(header) & 0xffffff;
      const id = reader.u32(header.body + 4, header.end),
        track = tracks.find((entry) => entry.id === id),
        values = defaults.get(id);
      if (track === undefined || values === undefined)
        throw new BurikoIsoSampleError('ISO fragment references an undeclared track');
      let p = header.body + 8;
      const take = (): number => {
        const value = reader.u32(p, header.end);
        p += 4;
        return value;
      };
      let base = (flags & 0x20000) !== 0 ? BigInt(fragment.start) : priorDataEnd;
      if ((flags & 1) !== 0) {
        base = reader.u64(p, header.end);
        p += 8;
      }
      const description = (flags & 2) !== 0 ? take() : values.description;
      const defaultDuration = (flags & 8) !== 0 ? take() : values.duration;
      const defaultSize = (flags & 16) !== 0 ? take() : values.size;
      const defaultFlags = (flags & 32) !== 0 ? take() : values.flags;
      if (description === 0 || description > track.descriptions.length)
        throw new BurikoIsoSampleError('ISO fragment has an invalid sample description');
      const decode = reader.child(traf, 'tfdt');
      let decodeTime = ends.get(id)!;
      if (decode !== undefined)
        decodeTime =
          reader.full(decode, 1) >>> 24
            ? reader.u64(decode.body + 4, decode.end)
            : BigInt(reader.u32(decode.body + 4, decode.end));
      let dataEnd = base;
      for (const run of reader.children(traf).filter((box) => box.type === 'trun')) {
        const runFlags = reader.full(run, 1),
          count = reader.u32(run.body + 4, run.end);
        if ((flags & 0x10000) !== 0 && count !== 0)
          throw new BurikoIsoSampleError('ISO empty fragment contains samples');
        if ((runFlags & 0x404) === 0x404)
          throw new BurikoIsoSampleError('ISO run has both first-sample and per-sample flags');
        p = run.body + 8;
        const read = (): number => {
          const value = reader.u32(p, run.end);
          p += 4;
          return value;
        };
        let offset = (runFlags & 1) !== 0 ? base + BigInt(read() | 0) : dataEnd;
        const firstFlags = (runFlags & 4) !== 0 ? read() : defaultFlags;
        const fieldCount =
          Number((runFlags & 0x100) !== 0) +
          Number((runFlags & 0x200) !== 0) +
          Number((runFlags & 0x400) !== 0) +
          Number((runFlags & 0x800) !== 0);
        reader.require(p, count * fieldCount * 4, run.end);
        for (let index = 0; index < count; index++) {
          const duration = (runFlags & 0x100) !== 0 ? read() : defaultDuration;
          const size = (runFlags & 0x200) !== 0 ? read() : defaultSize;
          const sampleFlags =
            (runFlags & 0x400) !== 0 ? read() : index === 0 ? firstFlags : defaultFlags;
          const rawOffset = (runFlags & 0x800) !== 0 ? read() : 0;
          const compositionOffset = runFlags >>> 24 === 1 ? rawOffset | 0 : rawOffset;
          if (offset < 0n)
            throw new BurikoIsoSampleError('ISO fragment sample has a negative byte offset');
          track.samples.push({
            offset,
            size,
            description,
            decodeTime,
            compositionTime: decodeTime + BigInt(compositionOffset),
            duration,
            flags: sampleFlags,
            sync: (sampleFlags & 0x10000) === 0,
          });
          offset += BigInt(size);
          decodeTime += BigInt(duration);
        }
        dataEnd = offset;
      }
      priorDataEnd = dataEnd;
      ends.set(id, decodeTime);
    }
  }
}

/** Keeps samples in decode order and edits in movie timescale; no frame skipping or timing flattening. */
export function readBurikoIsoMovie(bytes: Uint8Array): BurikoIsoMovie {
  const reader = new Reader(bytes),
    top = reader.boxes(0, bytes.length),
    movie = top.find((box) => box.type === 'moov');
  if (movie === undefined) throw new BurikoIsoSampleError('Movie has no ISO header');
  const header = reader.required(movie, 'mvhd'),
    movieVersion = reader.full(header, 1) >>> 24;
  const timeAt = header.body + (movieVersion === 1 ? 20 : 12),
    timescale = reader.u32(timeAt, header.end);
  const duration =
    movieVersion === 1
      ? reader.u64(timeAt + 4, header.end)
      : BigInt(reader.u32(timeAt + 4, header.end));
  if (timescale === 0) throw new BurikoIsoSampleError('ISO movie has a zero timescale');
  const tracks: BurikoIsoTrack[] = [];
  for (const box of reader.children(movie).filter((entry) => entry.type === 'trak')) {
    const tkhd = reader.required(box, 'tkhd'),
      trackFlags = reader.full(tkhd, 1),
      version = trackFlags >>> 24;
    const id = reader.u32(tkhd.body + (version === 1 ? 20 : 12), tkhd.end);
    if (id === 0 || tracks.some((track) => track.id === id))
      throw new BurikoIsoSampleError('ISO track ID is zero or repeated');
    const matrixAt = tkhd.body + (version === 1 ? 52 : 40);
    reader.require(matrixAt, 44, tkhd.end);
    const media = reader.required(box, 'mdia'),
      mdhd = reader.required(media, 'mdhd'),
      mediaVersion = reader.full(mdhd, 1) >>> 24;
    const mediaTimeAt = mdhd.body + (mediaVersion === 1 ? 20 : 12),
      mediaScale = reader.u32(mediaTimeAt, mdhd.end);
    if (mediaScale === 0) throw new BurikoIsoSampleError('ISO track has a zero timescale');
    const hdlr = reader.required(media, 'hdlr');
    reader.full(hdlr);
    reader.require(hdlr.body, 12, hdlr.end);
    const information = reader.required(media, 'minf'),
      table = reader.required(information, 'stbl');
    const track: BurikoIsoTrack = {
      id,
      enabled: (trackFlags & 1) !== 0,
      handler: reader.type(hdlr.body + 8),
      timescale: mediaScale,
      duration:
        mediaVersion === 1
          ? reader.u64(mediaTimeAt + 4, mdhd.end)
          : BigInt(reader.u32(mediaTimeAt + 4, mdhd.end)),
      movieDuration:
        version === 1
          ? reader.u64(tkhd.body + 28, tkhd.end)
          : BigInt(reader.u32(tkhd.body + 20, tkhd.end)),
      matrix: Array.from({length: 9}, (_, index) => reader.i32(matrixAt + index * 4)),
      width: reader.u32(matrixAt + 36),
      height: reader.u32(matrixAt + 40),
      descriptions: readDescriptions(reader, table),
      dataReferences: readDataReferences(reader, information),
      edits: readEdits(reader, box),
      samples: [],
    };
    readOrdinarySamples(reader, table, track);
    tracks.push(track);
  }
  readFragments(reader, movie, top, tracks);
  return {bytes, timescale, duration, tracks};
}

/** External data references remain explicit; this helper only resolves the encoded file itself. */
export function burikoIsoSampleBytes(
  movie: BurikoIsoMovie,
  track: BurikoIsoTrack,
  sample: BurikoIsoSample,
): Uint8Array {
  const description = track.descriptions[sample.description - 1];
  if (description === undefined) throw new BurikoIsoSampleError('ISO sample has no description');
  const reference = track.dataReferences[description.dataReference - 1];
  if (reference === undefined || (reference.flags & 1) === 0)
    throw new BurikoIsoSampleError('ISO sample belongs to an external or missing data reference');
  if (sample.offset < 0n || sample.offset + BigInt(sample.size) > BigInt(movie.bytes.length))
    throw new BurikoIsoSampleError('ISO sample reads beyond the encoded file');
  return movie.bytes.subarray(Number(sample.offset), Number(sample.offset) + sample.size);
}

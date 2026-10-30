import {
  isOggPageStart,
  OGG_CONTINUED,
  OGG_LAST_PAGE,
  OGG_PAGE_HEADER_SIZE,
  oggPageChecksumValid,
  OggPacketAssembler,
  readOggPage,
} from '../formats/ogg/page.js';

export interface VorbisPcm {
  readonly sampleRate: number;
  /** Encoded Vorbis channel order. The engine owns speaker mapping and PCM quantization. */
  readonly planes: readonly Float32Array[];
  readonly frames: number;
}
export class VorbisDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VorbisDecodeError';
  }
}
interface PacketDecoder {
  readonly ready: Promise<void>;
  sendSetupHeader(packet: Uint8Array): void;
  initDsp(): void;
  decodePackets(packets: Uint8Array[]): {
    channelData: Float32Array[];
    samplesDecoded: number;
    sampleRate: number;
    errors: {message: string}[];
  };
  free(): void;
}
type DecoderModule = {VorbisPacketDecoder: new () => PacketDecoder};
let module: Promise<DecoderModule> | undefined;

/**
 * Assembles one logical Ogg Vorbis stream from bytes that arrive in order. Engines own
 * multiplexing, chaining and damaged-page policy.
 */
class VorbisPacketReader {
  private tail = new Uint8Array(0);
  private readonly assembler = new OggPacketAssembler();
  private serial: number | undefined;
  private granule: number | null = null;
  private count = 0;
  /** The EOS page was read; no further pages may follow. */
  ended = false;

  /** The EOS granule, the bound of the decoded length, once the last page was read. */
  get finalGranule(): number | null {
    return this.ended ? this.granule : null;
  }

  /** Reads the complete pages that `bytes` finishes and returns the packets they complete. */
  push(bytes: Uint8Array): Uint8Array[] {
    let data = bytes;
    if (this.tail.length) {
      data = new Uint8Array(this.tail.length + bytes.length);
      data.set(this.tail);
      data.set(bytes, this.tail.length);
    }
    const packets: Uint8Array[] = [];
    // The pinned packet decoder has a fixed 128 KiB input allocation.
    // Comments are not passed to libvorbis and may legally exceed that size.
    const limit = (index: number, size: number): void => {
      if (index !== 1 && size > 128 * 1024)
        fail('Vorbis packet exceeds the decoder input allocation');
    };
    let cursor = 0;
    while (cursor < data.length) {
      if (this.ended) fail('Incomplete or chained Ogg stream');
      if (cursor + OGG_PAGE_HEADER_SIZE > data.length) break;
      if (!isOggPageStart(data, cursor)) fail('Invalid Ogg page header');
      const page = readOggPage(data, cursor);
      if (page === null) break;
      if (!oggPageChecksumValid(page)) fail('Invalid Ogg page checksum');
      this.serial ??= page.serial;
      if (this.serial !== page.serial) fail('Multiplexed Ogg streams must be separated');
      if (Boolean(page.flags & OGG_CONTINUED) !== this.assembler.pending)
        fail('Incomplete Ogg packet continuation');
      packets.push(...this.assembler.push(page, limit));
      if (page.granule >= 0) {
        if (page.granule > BigInt(Number.MAX_SAFE_INTEGER))
          fail('Ogg sample position is too large');
        this.granule = Number(page.granule);
      }
      this.ended = Boolean(page.flags & OGG_LAST_PAGE);
      cursor += page.bytes.length;
    }
    // Pending packet parts refer to `data`, which is never modified.
    this.tail = data.slice(cursor);
    for (let index = this.count; index < Math.min(3, this.count + packets.length); index++) {
      const packet = packets[index - this.count]!;
      if (
        packet[0] !== [1, 3, 5][index] ||
        ![118, 111, 114, 98, 105, 115].every((byte, at) => packet[at + 1] === byte)
      )
        fail('Invalid Vorbis header sequence');
    }
    this.count += packets.length;
    return packets;
  }

  /** Checks that the bytes ended on a page and packet boundary after the headers. */
  finish(): void {
    const tail = this.tail;
    if (tail.length) {
      if (tail.length < OGG_PAGE_HEADER_SIZE) fail('Incomplete or chained Ogg stream');
      fail(
        OGG_PAGE_HEADER_SIZE + tail[26]! > tail.length
          ? 'Incomplete Ogg segment table'
          : 'Incomplete Ogg page',
      );
    }
    if (this.assembler.pending || this.count < 3) fail('Incomplete Vorbis headers or packet');
  }
}
const fail = (message: string): never => {
  throw new VorbisDecodeError(message);
};

function vorbisPackets(bytes: Uint8Array): {packets: Uint8Array[]; finalGranule: number | null} {
  const reader = new VorbisPacketReader(),
    packets = reader.push(bytes);
  reader.finish();
  // Only an EOS granule describes a tail trim.
  return {packets, finalGranule: reader.finalGranule};
}

interface PrimedVorbis {
  readonly decoder: PacketDecoder;
  readonly channels: number;
  readonly sampleRate: number;
}
interface OpenedVorbis extends PrimedVorbis {
  readonly packets: Uint8Array[];
  readonly finalGranule: number | null;
}
export interface VorbisDecodeOptions {
  /** libogg-style synchronization before the first page only. The first page's start
   * must be below this exclusive boundary. Omitted: reject bytes before the first page. */
  readonly firstPageSearchBoundary?: number;
}

/** ogg_sync_pageseek: garbage and bad-CRC candidates advance to the next capture
 * pattern, while an incomplete candidate waits for EOF and cannot be skipped.
 * Subsequent stream damage/multiplexing policies remain owned by the packet reader.
 */
function firstPageBytes(bytes: Uint8Array, boundary: number): Uint8Array {
  if (!Number.isSafeInteger(boundary) || boundary < 1)
    throw Error('Invalid Vorbis first-page search boundary');
  for (let offset = 0; offset < Math.min(boundary, bytes.length); offset++) {
    if (
      bytes[offset] !== 0x4f ||
      bytes[offset + 1] !== 0x67 ||
      bytes[offset + 2] !== 0x67 ||
      bytes[offset + 3] !== 0x53
    )
      continue;
    if (offset + OGG_PAGE_HEADER_SIZE > bytes.length) fail('Incomplete Ogg sync header');
    const page = readOggPage(bytes, offset);
    if (!page) return fail('Incomplete Ogg sync page');
    if (oggPageChecksumValid(page)) return bytes.subarray(offset);
  }
  return fail('Ogg first-page search boundary or EOF');
}

/** Validates the identification header and primes libvorbis; the caller frees the decoder. */
async function openVorbis(
  bytes: Uint8Array,
  options: VorbisDecodeOptions = {},
): Promise<OpenedVorbis> {
  if (options.firstPageSearchBoundary !== undefined)
    bytes = firstPageBytes(bytes, options.firstPageSearchBoundary);
  const {packets, finalGranule} = vorbisPackets(bytes);
  return {...(await primeVorbis(packets)), packets, finalGranule};
}

/** Loads and instantiates the packet decoder, so a worker's first stream does not wait for it. */
export async function loadVorbisDecoder(): Promise<void> {
  const library = await (module ??= import(
    new URL('../vendor/ogg-vorbis.js', import.meta.url).href
  ) as Promise<DecoderModule>);
  const decoder = new library.VorbisPacketDecoder();
  try {
    await decoder.ready;
  } finally {
    decoder.free();
  }
}

/** Primes libvorbis from the identification and setup headers; the caller frees the decoder. */
async function primeVorbis(packets: readonly Uint8Array[]): Promise<PrimedVorbis> {
  const identification = packets[0]!;
  if (identification.length < 30) throw new VorbisDecodeError('Incomplete Vorbis identification');
  const header = new DataView(
    identification.buffer,
    identification.byteOffset,
    identification.length,
  );
  const channels = identification[11]!,
    sampleRate = header.getUint32(12, true);
  const shortBlock = identification[28]! & 15,
    longBlock = identification[28]! >>> 4;
  if (
    header.getUint32(7, true) !== 0 ||
    channels === 0 ||
    sampleRate === 0 ||
    shortBlock < 6 ||
    longBlock < shortBlock ||
    longBlock > 13 ||
    !(identification[29]! & 1)
  )
    throw new VorbisDecodeError('Invalid Vorbis identification');
  const library = await (module ??= import(
    new URL('../vendor/ogg-vorbis.js', import.meta.url).href
  ) as Promise<DecoderModule>);
  const decoder = new library.VorbisPacketDecoder();
  await decoder.ready;
  try {
    decoder.sendSetupHeader(identification);
    // libvorbis receives an empty comment packet internally; comments do not affect PCM.
    decoder.sendSetupHeader(packets[2]!);
    decoder.initDsp();
  } catch (error) {
    decoder.free();
    throw error;
  }
  return {decoder, channels, sampleRate};
}

function decodeBatch(opened: PrimedVorbis, packets: Uint8Array[]) {
  const result = opened.decoder.decodePackets(packets);
  if (result.errors.length)
    throw new VorbisDecodeError(result.errors.map((error) => error.message).join('; '));
  if (
    result.sampleRate !== opened.sampleRate ||
    result.channelData.length !== opened.channels ||
    !Number.isSafeInteger(result.samplesDecoded) ||
    result.samplesDecoded < 0 ||
    result.channelData.some((plane) => plane.length !== result.samplesDecoded)
  )
    throw new VorbisDecodeError('Vorbis decoder returned invalid PCM dimensions');
  return result;
}

/** libvorbis supplies actual PCM; browser decodeAudioData may discard boundary samples. */
export async function decodeVorbisFile(
  bytes: Uint8Array,
  options: VorbisDecodeOptions = {},
): Promise<VorbisPcm> {
  const opened = await openVorbis(bytes, options);
  try {
    const result = decodeBatch(opened, opened.packets.slice(3));
    // Ogg's EOS granule removes the encoder's final overlap; it never creates samples.
    const finalGranule = opened.finalGranule,
      frames =
        finalGranule === null
          ? result.samplesDecoded
          : Math.min(finalGranule, result.samplesDecoded);
    return {
      sampleRate: opened.sampleRate,
      frames,
      planes: result.channelData.map((plane) => plane.subarray(0, frames)),
    };
  } finally {
    opened.decoder.free();
  }
}

/** Completion of `decodeVorbisChunks`: untrimmed output count and the EOS-trimmed length. */
export interface VorbisStreamSummary {
  readonly sampleRate: number;
  readonly channels: number;
  readonly samplesDecoded: number;
  readonly frames: number;
}

/** Header facts known before any PCM; `finalGranule` is the EOS trim bound, if any. */
export interface VorbisStreamOpen {
  readonly sampleRate: number;
  readonly channels: number;
  readonly finalGranule: number | null;
}
export interface VorbisStreamCallbacks {
  onOpen?(open: VorbisStreamOpen): void;
  onChunk(planes: Float32Array[], frames: number): void;
}

/**
 * Decodes like `decodeVorbisFile`, but reports consecutive untrimmed PCM batches as they are
 * decoded. libvorbis keeps its synthesis state between batches, so their concatenation equals
 * the single-call output. The first batch holds at least `firstFrames` frames when the stream
 * has them; later batches hold at least `chunkFrames`. A packet error ends decoding with the
 * error after the batches before it were reported.
 */
export async function decodeVorbisChunks(
  bytes: Uint8Array,
  firstFrames: number,
  chunkFrames: number,
  callbacks: VorbisStreamCallbacks,
  packetsPerBatch = 8,
): Promise<VorbisStreamSummary> {
  // Small packet batches keep chunks close to their targets; libvorbis still decodes one
  // packet at a time, and a block is at most 4,096 frames.
  const decoder = new VorbisChunkDecoder(firstFrames, chunkFrames, callbacks, packetsPerBatch);
  try {
    await decoder.push(bytes, true);
    return decoder.finish();
  } finally {
    decoder.free();
  }
}

/**
 * `decodeVorbisChunks` for encoded bytes that arrive in order, such as consecutive file reads.
 * Each `push` reads the pages its bytes complete and decodes their packets; batches are
 * reported as in `decodeVorbisChunks`. The push marked `last` first checks that the stream
 * ends on a page and packet boundary, and `finish` then reports the remaining batch. `onOpen`
 * follows the first push that completes the headers; its `finalGranule` is set only when that
 * push also read the last page. A packet error rejects the push; batches reported before it
 * stay valid. The caller frees the decoder.
 */
export class VorbisChunkDecoder {
  private readonly reader = new VorbisPacketReader();
  private opened: PrimedVorbis | undefined;
  private headers: Uint8Array[] = [];
  private samplesDecoded = 0;
  private target: number;
  private pending: Float32Array[][] = [];
  private pendingFrames = 0;
  private ended = false;
  private freed = false;
  constructor(
    firstFrames: number,
    private readonly chunkFrames: number,
    private readonly callbacks: VorbisStreamCallbacks,
    private readonly packetsPerBatch = 8,
  ) {
    this.target = firstFrames;
  }
  /** The EOS granule once the last page was read: frames past it are encoder overlap. */
  get finalGranule(): number | null {
    return this.reader.finalGranule;
  }
  async push(bytes: Uint8Array, last = false): Promise<void> {
    if (this.freed) throw Error('Vorbis chunk decoder was freed');
    if (this.ended) throw Error('Vorbis chunk decoder input already ended');
    const packets = this.reader.push(bytes);
    if (last) {
      this.reader.finish();
      this.ended = true;
    }
    if (!this.opened) {
      this.headers.push(...packets.splice(0, 3 - this.headers.length));
      if (this.headers.length < 3) return;
      this.opened = await primeVorbis(this.headers);
      if (this.freed) {
        this.opened.decoder.free();
        throw Error('Vorbis chunk decoder was freed');
      }
      this.callbacks.onOpen?.({
        sampleRate: this.opened.sampleRate,
        channels: this.opened.channels,
        finalGranule: this.reader.finalGranule,
      });
    }
    for (let index = 0; index < packets.length; index += this.packetsPerBatch) {
      const result = decodeBatch(this.opened, packets.slice(index, index + this.packetsPerBatch));
      this.samplesDecoded += result.samplesDecoded;
      if (result.samplesDecoded !== 0) {
        this.pending.push(result.channelData);
        this.pendingFrames += result.samplesDecoded;
      }
      if (this.pendingFrames >= this.target) this.flush();
    }
  }
  finish(): VorbisStreamSummary {
    if (!this.ended) throw Error('Vorbis chunk decoder input has not ended');
    const opened = this.opened!;
    this.flush();
    const finalGranule = this.reader.finalGranule;
    return {
      sampleRate: opened.sampleRate,
      channels: opened.channels,
      samplesDecoded: this.samplesDecoded,
      frames:
        finalGranule === null ? this.samplesDecoded : Math.min(finalGranule, this.samplesDecoded),
    };
  }
  free(): void {
    if (this.freed) return;
    this.freed = true;
    this.opened?.decoder.free();
  }
  private flush(): void {
    if (this.pendingFrames === 0) return;
    const pending = this.pending,
      frames = this.pendingFrames;
    const planes = Array.from({length: this.opened!.channels}, (_, channel) => {
      if (pending.length === 1) return pending[0]![channel]!;
      const plane = new Float32Array(frames);
      let at = 0;
      for (const batch of pending) {
        plane.set(batch[channel]!, at);
        at += batch[channel]!.length;
      }
      return plane;
    });
    this.pending = [];
    this.pendingFrames = 0;
    this.target = this.chunkFrames;
    this.callbacks.onChunk(planes, frames);
  }
}

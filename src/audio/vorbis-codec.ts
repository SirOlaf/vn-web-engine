import {oggPageChecksum} from '../formats/ogg/checksum.js';

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

/** Assemble one logical Ogg stream. Engines own multiplexing, chaining and damaged-page policy. */
function vorbisPackets(bytes: Uint8Array): {packets: Uint8Array[]; finalGranule: number | null} {
  const packets: Uint8Array[] = [];
  let parts: Uint8Array[] = [],
    packetSize = 0,
    serial: number | undefined;
  let cursor = 0,
    finalGranule: number | null = null,
    ended = false;
  const fail = (message: string): never => {
    throw new VorbisDecodeError(message);
  };
  while (cursor < bytes.length) {
    if (ended || cursor + 27 > bytes.length) fail('Incomplete or chained Ogg stream');
    const view = new DataView(bytes.buffer, bytes.byteOffset + cursor, bytes.length - cursor);
    if (view.getUint32(0, false) !== 0x4f676753 || view.getUint8(4) !== 0)
      fail('Invalid Ogg page header');
    const flags = view.getUint8(5),
      segments = view.getUint8(26),
      headerSize = 27 + segments;
    if (cursor + headerSize > bytes.length) fail('Incomplete Ogg segment table');
    let pageSize = headerSize;
    for (let index = 0; index < segments; index++) pageSize += view.getUint8(27 + index);
    if (cursor + pageSize > bytes.length) fail('Incomplete Ogg page');
    const page = bytes.subarray(cursor, cursor + pageSize);
    if (oggPageChecksum(page) !== view.getUint32(22, true)) fail('Invalid Ogg page checksum');
    serial ??= view.getUint32(14, true);
    if (serial !== view.getUint32(14, true)) fail('Multiplexed Ogg streams must be separated');
    if (Boolean(flags & 1) !== parts.length > 0) fail('Incomplete Ogg packet continuation');
    let read = headerSize;
    for (let index = 0; index < segments; index++) {
      const length = view.getUint8(27 + index);
      parts.push(page.subarray(read, read + length));
      packetSize += length;
      read += length;
      // The pinned packet decoder has a fixed 128 KiB input allocation.
      // Comments are not passed to libvorbis and may legally exceed that size.
      if (packets.length !== 1 && packetSize > 128 * 1024)
        fail('Vorbis packet exceeds the decoder input allocation');
      if (length < 255) {
        const packet = new Uint8Array(packetSize);
        let at = 0;
        for (const part of parts) {
          packet.set(part, at);
          at += part.length;
        }
        packets.push(packet);
        parts = [];
        packetSize = 0;
      }
    }
    const granule = view.getBigInt64(6, true);
    if (granule >= 0) {
      if (granule > BigInt(Number.MAX_SAFE_INTEGER)) fail('Ogg sample position is too large');
      finalGranule = Number(granule);
    }
    ended = Boolean(flags & 4);
    cursor += pageSize;
  }
  if (parts.length || packets.length < 3) fail('Incomplete Vorbis headers or packet');
  for (let index = 0; index < 3; index++) {
    const packet = packets[index]!;
    if (
      packet[0] !== [1, 3, 5][index] ||
      ![118, 111, 114, 98, 105, 115].every((byte, at) => packet[at + 1] === byte)
    )
      fail('Invalid Vorbis header sequence');
  }
  // Only an EOS granule describes a tail trim.
  return {packets, finalGranule: ended ? finalGranule : null};
}

interface OpenedVorbis {
  readonly decoder: PacketDecoder;
  readonly packets: Uint8Array[];
  readonly finalGranule: number | null;
  readonly channels: number;
  readonly sampleRate: number;
}

/** Validates the identification header and primes libvorbis; the caller frees the decoder. */
async function openVorbis(bytes: Uint8Array): Promise<OpenedVorbis> {
  const {packets, finalGranule} = vorbisPackets(bytes);
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
  return {decoder, packets, finalGranule, channels, sampleRate};
}

function decodeBatch(opened: OpenedVorbis, packets: Uint8Array[]) {
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
export async function decodeVorbisFile(bytes: Uint8Array): Promise<VorbisPcm> {
  const opened = await openVorbis(bytes);
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
  const opened = await openVorbis(bytes);
  try {
    callbacks.onOpen?.({
      sampleRate: opened.sampleRate,
      channels: opened.channels,
      finalGranule: opened.finalGranule,
    });
    let samplesDecoded = 0,
      target = firstFrames,
      pending: Float32Array[][] = [],
      pendingFrames = 0;
    const flush = (): void => {
      if (pendingFrames === 0) return;
      const planes = Array.from({length: opened.channels}, (_, channel) => {
        if (pending.length === 1) return pending[0]![channel]!;
        const plane = new Float32Array(pendingFrames);
        let at = 0;
        for (const batch of pending) {
          plane.set(batch[channel]!, at);
          at += batch[channel]!.length;
        }
        return plane;
      });
      callbacks.onChunk(planes, pendingFrames);
      pending = [];
      pendingFrames = 0;
      target = chunkFrames;
    };
    // Small packet batches keep chunks close to their targets; libvorbis still decodes one
    // packet at a time, and a block is at most 4,096 frames.
    const packets = opened.packets;
    for (let index = 3; index < packets.length; index += packetsPerBatch) {
      const result = decodeBatch(opened, packets.slice(index, index + packetsPerBatch));
      samplesDecoded += result.samplesDecoded;
      if (result.samplesDecoded !== 0) {
        pending.push(result.channelData);
        pendingFrames += result.samplesDecoded;
      }
      if (pendingFrames >= target) flush();
    }
    flush();
    const finalGranule = opened.finalGranule;
    return {
      sampleRate: opened.sampleRate,
      channels: opened.channels,
      samplesDecoded,
      frames: finalGranule === null ? samplesDecoded : Math.min(finalGranule, samplesDecoded),
    };
  } finally {
    opened.decoder.free();
  }
}

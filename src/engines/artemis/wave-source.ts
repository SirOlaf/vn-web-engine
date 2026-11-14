import {artemisRevision} from './revision.js';
import {artemisPairedSoundPath} from './paired-sound-path.js';
import type {ArtemisPcmResource} from './pcm-resource.js';

export interface ArtemisWaveFormat {
  readonly sampleRate: number;
  readonly channels: number;
  readonly bitsPerSample: number;
  readonly blockAlign: number;
}
interface WaveHeader {
  readonly format: ArtemisWaveFormat;
  readonly dataOffset: number;
  readonly dataSize: number;
}
/** Native19d570 ignores RIFF's declared end and does not pad skipped odd chunks.
 * This is the encoded resource owner, not a PCM decoder or device voice. */
function header(bytes: Uint8Array): WaveHeader | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number, text: string) =>
    offset >= 0 &&
    offset + 4 <= bytes.length &&
    [...text].every((value, i) => bytes[offset + i] === value.charCodeAt(0));
  if (!tag(0, 'RIFF') || !tag(8, 'WAVE')) return null;
  const find = (cursor: number, name: string): {offset: number; size: number} | null => {
    while (cursor >= 0 && cursor + 8 <= bytes.length) {
      const size = view.getInt32(cursor + 4, true);
      if (size < 0) throw Error('Unsupported Artemis backward WAVE chunk seek');
      if (tag(cursor, name)) return {offset: cursor + 8, size};
      cursor += 8 + size;
    }
    return null;
  };
  const fmt = find(12, 'fmt ');
  // Native reads the fixed16 bytes even when the fmt chunk advertises fewer.
  if (!fmt || fmt.offset + 16 > bytes.length) return null;
  const formatTag = view.getUint16(fmt.offset, true),
    channels = view.getUint16(fmt.offset + 2, true),
    sampleRate = view.getUint32(fmt.offset + 4, true),
    byteRate = view.getUint32(fmt.offset + 8, true),
    blockAlign = view.getUint16(fmt.offset + 12, true),
    bitsPerSample = view.getUint16(fmt.offset + 14, true),
    frameBytes = (bitsPerSample >> 3) * channels;
  if (
    formatTag !== 1 ||
    (channels !== 1 && channels !== 2) ||
    blockAlign !== frameBytes ||
    byteRate !== Math.imul(frameBytes, sampleRate) >>> 0
  )
    return null;
  const data = find(fmt.offset + fmt.size, 'data');
  return (
    data && {
      format: {sampleRate, channels, bitsPerSample, blockAlign},
      dataOffset: data.offset,
      dataSize: data.size,
    }
  );
}

/** Native CWave read19e170/reset19e120, including sticky transition into _b.
 * Bytes remain encoded integer PCM. The device/decoder owner interprets them.
 */
export class ArtemisWaveSource {
  private position = 0;
  private pairedActive = false;
  private paired: ArtemisWaveSource | null = null;
  private constructor(
    readonly path: string,
    private readonly bytes: Uint8Array,
    private readonly metadata: WaveHeader,
  ) {}
  get format(): ArtemisWaveFormat {
    return this.metadata.format;
  }
  get dataSize(): number {
    return this.metadata.dataSize;
  }
  get totalDataSize(): number {
    return this.dataSize + (this.paired?.totalDataSize ?? 0);
  }
  get loopStartBytes(): number {
    return this.paired ? this.dataSize : 0;
  }
  snapshot(): ArtemisPcmResource {
    return {
      kind: 'wave',
      format: {...this.format},
      declaredSize: this.dataSize,
      bytes: this.bytes.slice(this.metadata.dataOffset, this.metadata.dataOffset + this.dataSize),
      paired: this.paired?.snapshot(),
    };
  }
  static async load(
    hash: string,
    path: string,
    readFile: (path: string) => Promise<Uint8Array | null>,
  ): Promise<ArtemisWaveSource | null> {
    artemisRevision(hash);
    path = path.split('\0', 1)[0]!;
    const bytes = await readFile(path);
    if (bytes === null) return null;
    return ArtemisWaveSource.fromBytes(hash, path, bytes, readFile);
  }
  /** Consume the already-opened codec input; only paired files require another open. */
  static async fromBytes(
    hash: string,
    path: string,
    bytes: Uint8Array,
    readFile: (path: string) => Promise<Uint8Array | null>,
  ): Promise<ArtemisWaveSource | null> {
    artemisRevision(hash);
    path = path.split('\0', 1)[0]!;
    const metadata = header(bytes);
    if (!metadata) return null;
    const source = new ArtemisWaveSource(path, Uint8Array.from(bytes), metadata);
    const pairedPath = artemisPairedSoundPath(path);
    if (pairedPath !== null)
      source.paired = await ArtemisWaveSource.load(hash, pairedPath, readFile);
    return source;
  }
  read(maxBytes: number): Uint8Array {
    if (!Number.isInteger(maxBytes) || maxBytes < 0 || maxBytes > 0xffffffff)
      throw Error('Invalid Artemis WAVE read length');
    if (this.pairedActive) return this.paired!.read(maxBytes);
    const wanted = Math.min(maxBytes, this.metadata.dataSize - this.position),
      start = this.metadata.dataOffset + this.position,
      data = this.bytes.slice(start, start + wanted);
    this.position += data.length;
    if (this.position < this.metadata.dataSize || !this.paired) return data;
    this.pairedActive = true;
    const next = this.paired.read(maxBytes - data.length),
      result = new Uint8Array(data.length + next.length);
    result.set(data);
    result.set(next, data.length);
    return result;
  }
  reset(): void {
    if (this.pairedActive) this.paired!.reset();
    else this.position = 0;
  }
}

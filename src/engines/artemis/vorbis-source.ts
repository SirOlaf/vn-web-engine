import {artemisRevision} from './revision.js';
import {artemisPairedSoundPath} from './paired-sound-path.js';
import type {ArtemisWaveFormat} from './wave-source.js';
import type {ArtemisPcmResource} from './pcm-resource.js';

export interface ArtemisVorbisBytes {
  readonly sampleRate: number;
  readonly channels: number;
  /** Owned, little-endian interleaved PCM16 from the actual codec. */
  readonly bytes: Uint8Array;
}
export type ArtemisVorbisByteDecoder = (bytes: Uint8Array) => Promise<ArtemisVorbisBytes | null>;

/** Native19cb30/19d390/19d2f0 resource semantics on an actual decoded PCM16 owner.
 * Eager decoding is the buffered adaptation; progressive native decoder/error
 * timing belongs to the streaming owner. Sub-frame reads are explicitly refused.
 */
export class ArtemisVorbisSource {
  private position = 0;
  private pairedActive = false;
  private paired: ArtemisVorbisSource | null = null;
  readonly format: ArtemisWaveFormat;
  private constructor(
    readonly path: string,
    private readonly pcm: ArtemisVorbisBytes,
  ) {
    if (
      !Number.isInteger(pcm.sampleRate) ||
      pcm.sampleRate <= 0 ||
      pcm.sampleRate > 0xffffffff ||
      !Number.isInteger(pcm.channels) ||
      pcm.channels < 1 ||
      pcm.channels > 65535 ||
      pcm.bytes.length % (pcm.channels * 2) !== 0
    )
      throw Error('Invalid Artemis decoded Vorbis storage');
    this.format = {
      sampleRate: pcm.sampleRate,
      channels: pcm.channels,
      bitsPerSample: 16,
      blockAlign: pcm.channels * 2,
    };
  }
  get dataSize(): number {
    return this.pcm.bytes.length;
  }
  get totalDataSize(): number {
    return this.dataSize + (this.paired?.totalDataSize ?? 0);
  }
  get loopStartBytes(): number {
    return this.paired ? this.dataSize : 0;
  }
  snapshot(): ArtemisPcmResource {
    return {
      kind: 'vorbis',
      format: {...this.format},
      declaredSize: this.dataSize,
      bytes: this.pcm.bytes.slice(),
      paired: this.paired?.snapshot(),
    };
  }
  static async load(
    hash: string,
    path: string,
    readFile: (path: string) => Promise<Uint8Array | null>,
    decode: ArtemisVorbisByteDecoder,
  ): Promise<ArtemisVorbisSource | null> {
    artemisRevision(hash);
    path = path.split('\0', 1)[0]!;
    const bytes = await readFile(path);
    return bytes === null
      ? null
      : ArtemisVorbisSource.fromBytes(hash, path, bytes, readFile, decode);
  }
  static async fromBytes(
    hash: string,
    path: string,
    bytes: Uint8Array,
    readFile: (path: string) => Promise<Uint8Array | null>,
    decode: ArtemisVorbisByteDecoder,
  ): Promise<ArtemisVorbisSource | null> {
    artemisRevision(hash);
    path = path.split('\0', 1)[0]!;
    const pcm = await decode(bytes);
    if (!pcm) return null;
    const source = new ArtemisVorbisSource(path, pcm),
      pairedPath = artemisPairedSoundPath(path);
    if (pairedPath !== null)
      source.paired = await ArtemisVorbisSource.load(hash, pairedPath, readFile, decode);
    return source;
  }
  read(maxBytes: number): Uint8Array {
    if (
      !Number.isInteger(maxBytes) ||
      maxBytes < 0 ||
      maxBytes > 0x7fffffff ||
      maxBytes % this.format.blockAlign !== 0
    )
      throw Error('Unsupported Artemis sub-frame Vorbis read');
    if (maxBytes === 0) return new Uint8Array();
    if (this.pairedActive) return this.paired!.read(maxBytes);
    const data = this.pcm.bytes.slice(this.position, this.position + maxBytes);
    this.position += data.length;
    // Native observes decoder EOF only after it asks for more bytes. An exact
    // final read leaves A active until the next nonzero request.
    if (data.length === maxBytes || !this.paired) return data;
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

import type {ArtemisWaveFormat} from './wave-source.js';
import type {ArtemisPcmByteSource} from './rolling-sound-buffer.js';

export interface ArtemisPcmResource {
  readonly kind: 'wave' | 'vorbis';
  readonly format: ArtemisWaveFormat;
  readonly bytes: Uint8Array;
  readonly declaredSize: number;
  readonly paired?: ArtemisPcmResource;
  /** False while a progressive Vorbis owner still appends decoded PCM (see `append`). */
  readonly complete?: boolean;
}

/** Owns a transferred resource in the PCM worklet; follows encoded-source cursors. */
export class ArtemisPcmCursor implements ArtemisPcmByteSource {
  private position = 0;
  private pairedActive = false;
  private readonly paired: ArtemisPcmCursor | undefined;
  private storage: Uint8Array;
  private length: number;
  private complete: boolean;
  constructor(private readonly resource: ArtemisPcmResource) {
    if (
      !Number.isInteger(resource.declaredSize) ||
      resource.declaredSize < 0 ||
      resource.declaredSize > 0x7fffffff ||
      resource.bytes.length > resource.declaredSize ||
      (resource.kind !== 'wave' && resource.kind !== 'vorbis') ||
      (resource.complete === false && (resource.kind !== 'vorbis' || resource.paired))
    )
      throw Error('Invalid Artemis PCM resource snapshot');
    this.paired = resource.paired ? new ArtemisPcmCursor(resource.paired) : undefined;
    this.storage = resource.bytes;
    this.length = resource.bytes.length;
    this.complete = resource.complete !== false;
  }
  /** Adds decoded PCM after the bytes so far; `end` marks the decoder's end of stream. */
  append(bytes: Uint8Array): void {
    if (this.complete || bytes.length % this.format.blockAlign !== 0)
      throw Error('Invalid Artemis progressive PCM append');
    if (this.length + bytes.length > this.storage.length) {
      const grown = new Uint8Array(Math.max(this.length + bytes.length, this.storage.length * 2));
      grown.set(this.storage.subarray(0, this.length));
      this.storage = grown;
    }
    this.storage.set(bytes, this.length);
    this.length += bytes.length;
  }
  end(): void {
    this.complete = true;
  }
  /**
   * Whether a read of `bytes` returns what the complete source would. A progressive source
   * whose decoder is behind is not ready; its reader waits instead of seeing an early end.
   */
  ready(bytes: number): boolean {
    if (this.pairedActive) return this.paired!.ready(bytes);
    return this.complete || this.length - this.position >= bytes;
  }
  get format(): ArtemisWaveFormat {
    return this.resource.format;
  }
  read(maxBytes: number): Uint8Array {
    if (!Number.isInteger(maxBytes) || maxBytes < 0 || maxBytes > 0x7fffffff)
      throw Error('Invalid Artemis PCM cursor request');
    if (this.resource.kind === 'vorbis' && maxBytes % this.format.blockAlign !== 0)
      throw Error('Unsupported Artemis sub-frame Vorbis cursor read');
    if (maxBytes === 0 && this.resource.kind === 'vorbis') return new Uint8Array();
    if (this.pairedActive) return this.paired!.read(maxBytes);
    const end = this.resource.kind === 'wave' ? this.resource.declaredSize : this.length,
      count = Math.min(maxBytes, end - this.position),
      bytes = this.storage.slice(this.position, Math.min(this.position + count, this.length));
    this.position += bytes.length;
    const atEnd =
      this.resource.kind === 'wave'
        ? this.position >= this.resource.declaredSize
        : bytes.length < maxBytes;
    if (!atEnd || !this.paired) return bytes;
    this.pairedActive = true;
    const next = this.paired.read(maxBytes - bytes.length),
      output = new Uint8Array(bytes.length + next.length);
    output.set(bytes);
    output.set(next, bytes.length);
    return output;
  }
  reset(): void {
    if (this.pairedActive) this.paired!.reset();
    else this.position = 0;
  }
}

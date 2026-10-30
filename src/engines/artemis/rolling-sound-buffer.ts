import {artemisRevision} from './revision.js';
import type {ArtemisWaveFormat} from './wave-source.js';

export interface ArtemisPcmByteSource {
  readonly format: ArtemisWaveFormat;
  read(bytes: number): Uint8Array;
  reset(): void;
}
export interface ArtemisSoundBufferUpdate {
  readonly half: 0 | 1;
  readonly bytes: Uint8Array;
  readonly stopped: boolean;
}

/** Native 163a80 half size in bytes: two seconds below one millisecond, else the mode's
 * milliseconds of PCM. Throws for a format or size the ring cannot hold. */
export function artemisRollingHalfSize(
  format: ArtemisWaveFormat,
  bufferMilliseconds: number,
): number {
  if (
    !Number.isInteger(format.sampleRate) ||
    format.sampleRate <= 0 ||
    !Number.isInteger(format.channels) ||
    format.channels < 1 ||
    !Number.isInteger(format.bitsPerSample) ||
    format.bitsPerSample < 1 ||
    format.blockAlign !== (format.bitsPerSample >> 3) * format.channels
  )
    throw Error('Invalid Artemis progressive PCM format');
  const byteRate = Math.imul(format.blockAlign, format.sampleRate) >>> 0;
  const halfSize =
    bufferMilliseconds < 1
      ? Math.imul(byteRate, 2) >>> 0
      : Math.floor((Math.imul(byteRate, bufferMilliseconds) >>> 0) / 1000);
  if (!halfSize || halfSize > 0x3fffffff || halfSize % format.blockAlign !== 0)
    throw Error('Unsupported Artemis progressive buffer size/alignment');
  return halfSize;
}

/** Native163a80/164410/1640c0 two-half PCM storage. The host supplies actual
 * device cursors and plays these bytes; this owner never simulates a voice.
 * Decoder errors and restored/lost DirectSound buffers remain host services.
 */
export class ArtemisRollingSoundBuffer {
  readonly halfSize: number;
  private readonly storage: Uint8Array;
  private nextHalf: 0 | 1 = 1;
  private trailing = 0;
  private looping = false;
  private active = false;
  constructor(
    hash: string,
    readonly source: ArtemisPcmByteSource,
    bufferMilliseconds: number,
  ) {
    artemisRevision(hash);
    if (
      !Number.isInteger(bufferMilliseconds) ||
      bufferMilliseconds < -0x80000000 ||
      bufferMilliseconds > 0x7fffffff ||
      bufferMilliseconds === -1
    )
      throw Error('Invalid Artemis progressive sound buffer mode');
    this.halfSize = artemisRollingHalfSize(source.format, bufferMilliseconds);
    this.storage = new Uint8Array(this.halfSize * 2);
  }
  get playing(): boolean {
    return this.active;
  }
  snapshot(): Uint8Array {
    return this.storage.slice();
  }
  private readInto(half: 0 | 1, starting: boolean): boolean {
    let offset = 0;
    while (offset < this.halfSize) {
      const data = this.source.read(this.halfSize - offset);
      if (data.length > this.halfSize - offset) throw Error('Invalid Artemis PCM read result');
      this.storage.set(data, half * this.halfSize + offset);
      offset += data.length;
      if (offset === this.halfSize) return true;
      if (!this.looping) {
        if (starting && offset === 0) return false;
        const silence = this.source.format.bitsPerSample === 8 ? 0x80 : 0;
        this.storage.fill(silence, half * this.halfSize + offset, (half + 1) * this.halfSize);
        if (starting || this.trailing === 0) this.trailing = 2;
        else if (--this.trailing === 0) this.active = false;
        return true;
      }
      this.source.reset();
      if (data.length === 0) {
        const retry = this.source.read(this.halfSize - offset);
        if (retry.length === 0) {
          if (starting) return false;
          throw Error('Unsupported Artemis looping source without PCM progress');
        }
        if (retry.length > this.halfSize - offset) throw Error('Invalid Artemis PCM read result');
        this.storage.set(retry, half * this.halfSize + offset);
        offset += retry.length;
      }
    }
    return true;
  }
  start(loop: boolean): boolean {
    if (typeof loop !== 'boolean') throw Error('Invalid Artemis rolling loop flag');
    this.active = false;
    this.looping = loop;
    this.trailing = 0;
    this.nextHalf = 1;
    this.source.reset();
    if (!this.readInto(0, true)) return false;
    this.active = true;
    return true;
  }
  tick(cursor: number): ArtemisSoundBufferUpdate | null {
    if (!Number.isInteger(cursor) || cursor < 0 || cursor >= this.storage.length)
      throw Error('Invalid Artemis device byte cursor');
    if (!this.active) return null;
    if (this.nextHalf === 1 ? cursor >= this.halfSize : cursor <= this.halfSize) return null;
    const half = this.nextHalf;
    this.readInto(half, false);
    this.nextHalf = half === 1 ? 0 : 1;
    return {
      half,
      bytes: this.storage.slice(half * this.halfSize, (half + 1) * this.halfSize),
      stopped: !this.active,
    };
  }
  stop(): void {
    this.active = false;
  }
}

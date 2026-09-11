import {NoahState} from './noah-state.js';
import {NoahTextures, prepareTexture} from './textures.js';
import type {DecodedPng} from '../../../../../formats/png/decode.js';
export interface TextureAssets {
  decode?(bytes: Uint8Array): Promise<DecodedPng>;
  size(bank: number, id: number): number;
  read(bank: number, id: number): Promise<Uint8Array>;
}
const SHARED = 0x500000000,
  CAPACITY = 0x3000000;
/** Native job 15 and shared scratch. Promise completion never changes VM-visible fields. */
export class TextureLoader {
  private job:
    | {
        promise: Promise<void>;
        done?: boolean;
        bytes?: Uint8Array;
        image?: DecodedPng;
        readError?: unknown;
        decodeError?: unknown;
      }
    | undefined;
  private current: {bytes: Uint8Array; image?: DecodedPng; decodeError?: unknown} | undefined;
  private startError: unknown;
  constructor(
    readonly state: NoahState,
    readonly textures: NoahTextures,
    readonly assets: TextureAssets | undefined,
    readonly channel = 15,
  ) {
    state.put(0x17ac1c8, SHARED, 8);
    state.put(0x5872b0, SHARED, 8);
    state.put(0x586a3c, CAPACITY);
  }
  start(bank: number, asset: number): number {
    const s = this.state;
    if (s.get(0x587270 + this.channel * 4) !== 0) return 0xf4236;
    let size: number;
    try {
      if (!this.assets) throw new Error('Texture archive provider is unavailable');
      size = this.assets.size(bank >>> 0, asset);
      if (!Number.isSafeInteger(size) || size < 1 || size > CAPACITY)
        throw new Error('Texture asset exceeds native shared buffer');
    } catch (error) {
      this.startError = error;
      return 0xf4237;
    }
    this.startError = undefined;
    const job: NonNullable<TextureLoader['job']> = {promise: Promise.resolve()};
    this.job = job;
    job.promise = Promise.resolve()
      .then(() => this.assets!.read(bank >>> 0, asset))
      .then(async (bytes) => {
        if (bytes.length !== size) throw new Error('Texture transport size mismatch');
        job.bytes = Uint8Array.from(bytes);
        try {
          job.image = await (this.assets!.decode ?? prepareTexture)(job.bytes);
        } catch (error) {
          job.decodeError = error ?? new Error('Texture decoder rejected without an error');
        }
      })
      .catch((error) => {
        job.readError = error ?? new Error('Texture transport rejected without an error');
      })
      .finally(() => {
        job.done = true;
      });
    s.put(0x5872c0 + this.channel * 8, SHARED, 8);
    s.put(0x587230 + this.channel * 4, 0);
    s.put(0x587270 + this.channel * 4, 1);
    return this.channel;
  }
  async settle(): Promise<void> {
    await this.job?.promise;
  }
  publish(): void {
    const job = this.job,
      s = this.state;
    if (!job || !job.done || s.get(0x587270 + this.channel * 4) !== 1) return;
    if (job.readError !== undefined) {
      s.put(0x587230 + this.channel * 4, 0);
      s.put(0x587270 + this.channel * 4, 2);
      return;
    }
    if (!job.bytes) return;
    this.current = {bytes: job.bytes, image: job.image, decodeError: job.decodeError};
    s.put(0x587230 + this.channel * 4, job.bytes.length);
    s.put(0x587270 + this.channel * 4, 0);
    this.job = undefined;
  }
  upload(target: number, pointer: number, size: number): void {
    // Native invalid positive IDs report a graphics error without touching image memory.
    if (target >= 512) {
      this.textures.diagnostics.push(`GSLcreateLoadSurfaceEx: target ${target} out of range`);
      return;
    }
    if (pointer !== SHARED || !this.current || size !== this.current.bytes.length)
      throw new Error(`Invalid texture transfer pointer/size 0x${pointer.toString(16)}/${size}`, {
        cause: this.startError,
      });
    if (this.current.decodeError !== undefined)
      throw new Error('Texture codec failed', {cause: this.current.decodeError});
    if (!this.current.image) throw new Error('Missing prepared texture');
    this.textures.load(target, this.current.image);
  }
  release(target: number): void {
    this.textures.release(target);
  }
  get errors(): readonly unknown[] {
    return this.job?.readError === undefined ? [] : [this.job.readError];
  }
}

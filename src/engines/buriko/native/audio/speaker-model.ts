import type {BurikoWaveStatic} from './wave-static.js';
import {BurikoWaveStream} from './wave-stream.js';
import type {BurikoPcmStorage} from './static-pcm.js';

/** A real WaveBox producer, shared with the channel that owns its lifetime. */
export class BurikoSpeakerModel {
  constructor(readonly wave: BurikoWaveStatic | BurikoWaveStream) {}
  get sampleRate(): number {
    return this.wave.sampleRate;
  }
  get channels(): number {
    return this.wave.channels;
  }
  get bits(): 16 | 24 {
    return this.wave.outputBits;
  }
  get frames(): number {
    return this.wave.sourceFrameCount;
  }
  get frameBytes(): number {
    return this.wave.bytesPerFrame;
  }
  read(storage: BurikoPcmStorage, offset: number, frames: number): number | Promise<number> {
    return this.wave.readInto(storage.bytes, offset, frames, storage.initialized);
  }
  captureActor(): object | undefined {
    return this.wave instanceof BurikoWaveStream ? this.wave.captureActor() : undefined;
  }
  reset(actor?: object): void | Promise<void> {
    return this.wave instanceof BurikoWaveStream ? this.wave.reset(actor) : this.wave.reset();
  }
  dispose(): void | Promise<void> {
    return this.wave.dispose();
  }
}

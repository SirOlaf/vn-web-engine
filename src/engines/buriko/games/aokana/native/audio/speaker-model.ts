import type {AokanaWaveStatic} from './wave-static.js';
import {AokanaWaveStream} from './wave-stream.js';
import type {AokanaPcmStorage} from './static-pcm.js';

/** A real WaveBox producer, shared with the channel that owns its lifetime. */
export class AokanaSpeakerModel {
  constructor(readonly wave: AokanaWaveStatic | AokanaWaveStream) {}
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
  read(storage: AokanaPcmStorage, offset: number, frames: number): number | Promise<number> {
    return this.wave.readInto(storage.bytes, offset, frames, storage.initialized);
  }
  captureActor(): object | undefined {
    return this.wave instanceof AokanaWaveStream ? this.wave.captureActor() : undefined;
  }
  reset(actor?: object): void | Promise<void> {
    return this.wave instanceof AokanaWaveStream ? this.wave.reset(actor) : this.wave.reset();
  }
  dispose(): void | Promise<void> {
    return this.wave.dispose();
  }
}

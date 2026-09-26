import {BurikoBrowserSpeakerBuffer} from './browser-speaker-backend.js';
import {BurikoAudioBufferRenderCore} from './buffer-render-core.js';
import type {
  BurikoAudioBufferCommand,
  BurikoAudioBufferFormat,
  BurikoAudioBufferNotification,
  BurikoAudioBufferStatus,
} from './buffer-protocol.js';

export interface BurikoSpeakerBuffer {
  command(command: BurikoAudioBufferCommand): Promise<BurikoAudioBufferStatus>;
  onNotification(listener: (event: BurikoAudioBufferNotification) => void): () => void;
  dispose(): Promise<void>;
}
export interface BurikoSpeakerBackend {
  create(format: BurikoAudioBufferFormat): Promise<BurikoSpeakerBuffer>;
}
/** The caller owns activation/resume of this actual shared audio context. */
export class BurikoBrowserSpeakerBackend implements BurikoSpeakerBackend {
  constructor(
    readonly context: BaseAudioContext,
    readonly destination: AudioNode = context.destination,
  ) {}
  create(format: BurikoAudioBufferFormat): Promise<BurikoSpeakerBuffer> {
    return BurikoBrowserSpeakerBuffer.create(this.context, format, this.destination);
  }
}
/** Actual memory output consumer of the same production render core. No wall-clock cursor. */
export class BurikoMemorySpeakerBuffer implements BurikoSpeakerBuffer {
  readonly core: BurikoAudioBufferRenderCore;
  private readonly listeners = new Set<(event: BurikoAudioBufferNotification) => void>();
  constructor(
    readonly format: BurikoAudioBufferFormat,
    outputRate: number,
  ) {
    this.core = new BurikoAudioBufferRenderCore(format, outputRate);
  }
  private events(): void {
    for (const event of this.core.takeNotifications())
      for (const listener of this.listeners) listener(event);
  }
  async command(command: BurikoAudioBufferCommand): Promise<BurikoAudioBufferStatus> {
    const result = this.core.command(command);
    this.events();
    return result;
  }
  onNotification(listener: (event: BurikoAudioBufferNotification) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  render(frames: number): Float32Array[] {
    const output = Array.from({length: this.core.outputChannels}, () => new Float32Array(frames));
    this.core.render(output);
    this.events();
    return output;
  }
  async dispose(): Promise<void> {
    await this.command({kind: 'dispose'});
    this.listeners.clear();
  }
}
export class BurikoMemorySpeakerBackend implements BurikoSpeakerBackend {
  readonly buffers: BurikoMemorySpeakerBuffer[] = [];
  constructor(readonly outputRate: number) {}
  async create(format: BurikoAudioBufferFormat): Promise<BurikoMemorySpeakerBuffer> {
    const buffer = new BurikoMemorySpeakerBuffer({...format}, this.outputRate);
    this.buffers.push(buffer);
    return buffer;
  }
}

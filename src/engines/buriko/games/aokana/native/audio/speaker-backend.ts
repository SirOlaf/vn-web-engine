import {AokanaBrowserSpeakerBuffer} from './browser-speaker-backend.js';
import {AokanaAudioBufferRenderCore} from './buffer-render-core.js';
import type {
  AokanaAudioBufferCommand,
  AokanaAudioBufferFormat,
  AokanaAudioBufferNotification,
  AokanaAudioBufferStatus,
} from './buffer-protocol.js';

export interface AokanaSpeakerBuffer {
  command(command: AokanaAudioBufferCommand): Promise<AokanaAudioBufferStatus>;
  onNotification(listener: (event: AokanaAudioBufferNotification) => void): () => void;
  dispose(): Promise<void>;
}
export interface AokanaSpeakerBackend {
  create(format: AokanaAudioBufferFormat): Promise<AokanaSpeakerBuffer>;
}
/** The caller owns activation/resume of this actual shared audio context. */
export class AokanaBrowserSpeakerBackend implements AokanaSpeakerBackend {
  constructor(
    readonly context: BaseAudioContext,
    readonly destination: AudioNode = context.destination,
  ) {}
  create(format: AokanaAudioBufferFormat): Promise<AokanaSpeakerBuffer> {
    return AokanaBrowserSpeakerBuffer.create(this.context, format, this.destination);
  }
}
/** Actual memory output consumer of the same production render core. No wall-clock cursor. */
export class AokanaMemorySpeakerBuffer implements AokanaSpeakerBuffer {
  readonly core: AokanaAudioBufferRenderCore;
  private readonly listeners = new Set<(event: AokanaAudioBufferNotification) => void>();
  constructor(
    readonly format: AokanaAudioBufferFormat,
    outputRate: number,
  ) {
    this.core = new AokanaAudioBufferRenderCore(format, outputRate);
  }
  private events(): void {
    for (const event of this.core.takeNotifications())
      for (const listener of this.listeners) listener(event);
  }
  async command(command: AokanaAudioBufferCommand): Promise<AokanaAudioBufferStatus> {
    const result = this.core.command(command);
    this.events();
    return result;
  }
  onNotification(listener: (event: AokanaAudioBufferNotification) => void): () => void {
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
export class AokanaMemorySpeakerBackend implements AokanaSpeakerBackend {
  readonly buffers: AokanaMemorySpeakerBuffer[] = [];
  constructor(readonly outputRate: number) {}
  async create(format: AokanaAudioBufferFormat): Promise<AokanaMemorySpeakerBuffer> {
    const buffer = new AokanaMemorySpeakerBuffer({...format}, this.outputRate);
    this.buffers.push(buffer);
    return buffer;
  }
}

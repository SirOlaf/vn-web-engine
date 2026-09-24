import {AokanaAudioBufferRenderCore} from './buffer-render-core.js';
import type {
  AokanaAudioBufferFormat,
  AokanaAudioBufferRequest,
  AokanaAudioBufferResponse,
} from './buffer-protocol.js';

// The DOM library describes the main-thread node; these declarations describe the worklet realm.
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}
declare function registerProcessor(name: string, constructor: typeof AokanaBufferProcessor): void;

class AokanaBufferProcessor extends AudioWorkletProcessor {
  private readonly core: AokanaAudioBufferRenderCore;
  private closed = false;
  private failure: string | null = null;
  constructor(options: {processorOptions: {format: AokanaAudioBufferFormat}}) {
    super(options);
    this.core = new AokanaAudioBufferRenderCore(options.processorOptions.format, sampleRate);
    this.port.onmessage = (event: MessageEvent<AokanaAudioBufferRequest>) => {
      const {id, command} = event.data;
      try {
        if (this.failure !== null) throw new Error(this.failure);
        const status = this.core.command(command);
        if (command.kind === 'dispose') this.closed = true;
        this.events();
        this.send({kind: 'reply', id, status});
      } catch (error) {
        this.send({
          kind: 'error',
          id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    };
  }
  private send(response: AokanaAudioBufferResponse): void {
    this.port.postMessage(response);
  }
  private events(): void {
    const events = this.core.takeNotifications();
    if (events.length !== 0) this.send({kind: 'events', events});
  }
  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    if (this.closed || this.failure !== null) return false;
    try {
      this.core.render(outputs[0]!);
      this.events();
      return true;
    } catch (error) {
      this.failure = error instanceof Error ? error.message : String(error);
      this.send({kind: 'failure', message: this.failure});
      return false;
    }
  }
}
registerProcessor('aokana-mutable-pcm', AokanaBufferProcessor);

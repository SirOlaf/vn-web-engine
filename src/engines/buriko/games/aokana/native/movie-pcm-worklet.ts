import {AokanaMoviePcmCore} from './movie-pcm-core.js';
import type {
  AokanaMoviePcmFormat,
  AokanaMoviePcmRequest,
  AokanaMoviePcmResponse,
} from './movie-pcm-protocol.js';
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}
declare function registerProcessor(name: string, constructor: typeof AokanaMoviePcmProcessor): void;
class AokanaMoviePcmProcessor extends AudioWorkletProcessor {
  private readonly core: AokanaMoviePcmCore;
  private closed = false;
  private failure: string | null = null;
  constructor(options: {processorOptions: {format: AokanaMoviePcmFormat}}) {
    super(options);
    this.core = new AokanaMoviePcmCore(options.processorOptions.format, sampleRate);
    this.port.onmessage = (event: MessageEvent<AokanaMoviePcmRequest>) => {
      const {id, command} = event.data;
      try {
        if (this.failure !== null) throw new Error(this.failure);
        const status = this.core.command(command);
        if (command.kind === 'dispose' && status.result === 'ok') this.closed = true;
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
  private send(response: AokanaMoviePcmResponse): void {
    this.port.postMessage(response);
  }
  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    if (this.closed || this.failure !== null) return false;
    try {
      const previous = this.core.status();
      const status = this.core.render(outputs[0]!);
      if (!previous.ended && status.ended) this.send({kind: 'complete', status});
      this.send({kind: 'progress', status});
      return true;
    } catch (error) {
      this.failure = error instanceof Error ? error.message : String(error);
      this.send({kind: 'failure', message: this.failure});
      return false;
    }
  }
}
registerProcessor('aokana-movie-pcm', AokanaMoviePcmProcessor);

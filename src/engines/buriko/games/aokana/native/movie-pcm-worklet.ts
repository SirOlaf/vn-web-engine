import {AokanaMoviePcmProcessor} from './movie-pcm-processor.js';
import type {AokanaMoviePcmFormat, AokanaMoviePcmRequest} from './movie-pcm-protocol.js';
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}
declare function registerProcessor(name: string, constructor: typeof AokanaMoviePcmWorklet): void;
class AokanaMoviePcmWorklet extends AudioWorkletProcessor {
  private readonly processor: AokanaMoviePcmProcessor;
  constructor(options: {processorOptions: {format: AokanaMoviePcmFormat}}) {
    super(options);
    this.processor = new AokanaMoviePcmProcessor(
      options.processorOptions.format,
      sampleRate,
      (response) => this.port.postMessage(response),
    );
    this.port.onmessage = (event: MessageEvent<AokanaMoviePcmRequest>) =>
      this.processor.receive(event.data);
  }
  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    return this.processor.render(outputs[0]!);
  }
}
registerProcessor('aokana-movie-pcm', AokanaMoviePcmWorklet);

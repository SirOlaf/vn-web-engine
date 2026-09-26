import {BurikoMoviePcmProcessor} from './movie-pcm-processor.js';
import type {BurikoMoviePcmFormat, BurikoMoviePcmRequest} from './movie-pcm-protocol.js';
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}
declare function registerProcessor(name: string, constructor: typeof BurikoMoviePcmWorklet): void;
class BurikoMoviePcmWorklet extends AudioWorkletProcessor {
  private readonly processor: BurikoMoviePcmProcessor;
  constructor(options: {processorOptions: {format: BurikoMoviePcmFormat}}) {
    super(options);
    this.processor = new BurikoMoviePcmProcessor(
      options.processorOptions.format,
      sampleRate,
      (response) => this.port.postMessage(response),
    );
    this.port.onmessage = (event: MessageEvent<BurikoMoviePcmRequest>) =>
      this.processor.receive(event.data);
  }
  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    return this.processor.render(outputs[0]!);
  }
}
registerProcessor('buriko-movie-pcm', BurikoMoviePcmWorklet);

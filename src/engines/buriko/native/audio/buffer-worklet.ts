import {BurikoBufferProcessor} from './buffer-processor.js';
import type {BurikoAudioBufferFormat, BurikoAudioBufferRequest} from './buffer-protocol.js';

// The DOM library describes the main-thread node; these declarations describe the worklet realm.
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}
declare function registerProcessor(name: string, constructor: typeof BurikoBufferWorklet): void;

class BurikoBufferWorklet extends AudioWorkletProcessor {
  private readonly processor: BurikoBufferProcessor;
  constructor(options: {processorOptions: {format: BurikoAudioBufferFormat}}) {
    super(options);
    this.processor = new BurikoBufferProcessor(
      options.processorOptions.format,
      sampleRate,
      (response) => this.port.postMessage(response),
    );
    this.port.onmessage = (event: MessageEvent<BurikoAudioBufferRequest>) =>
      this.processor.receive(event.data);
  }
  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    return this.processor.render(outputs[0]!);
  }
}
registerProcessor('buriko-mutable-pcm', BurikoBufferWorklet);

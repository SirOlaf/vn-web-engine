import {AokanaBufferProcessor} from './buffer-processor.js';
import type {AokanaAudioBufferFormat, AokanaAudioBufferRequest} from './buffer-protocol.js';

// The DOM library describes the main-thread node; these declarations describe the worklet realm.
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}
declare function registerProcessor(name: string, constructor: typeof AokanaBufferWorklet): void;

class AokanaBufferWorklet extends AudioWorkletProcessor {
  private readonly processor: AokanaBufferProcessor;
  constructor(options: {processorOptions: {format: AokanaAudioBufferFormat}}) {
    super(options);
    this.processor = new AokanaBufferProcessor(
      options.processorOptions.format,
      sampleRate,
      (response) => this.port.postMessage(response),
    );
    this.port.onmessage = (event: MessageEvent<AokanaAudioBufferRequest>) =>
      this.processor.receive(event.data);
  }
  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    return this.processor.render(outputs[0]!);
  }
}
registerProcessor('aokana-mutable-pcm', AokanaBufferWorklet);

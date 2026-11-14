import {
  ArtemisRollingAudioProcessor,
  type ArtemisRollingAudioOptions,
  type ArtemisRollingAudioRequest,
} from './rolling-audio-processor.js';

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}
declare function registerProcessor(
  name: string,
  constructor: typeof ArtemisRollingAudioWorklet,
): void;
class ArtemisRollingAudioWorklet extends AudioWorkletProcessor {
  private readonly processor: ArtemisRollingAudioProcessor;
  constructor(options: {processorOptions: ArtemisRollingAudioOptions}) {
    super(options);
    this.processor = new ArtemisRollingAudioProcessor(
      options.processorOptions,
      sampleRate,
      (response) => this.port.postMessage(response),
    );
    this.port.onmessage = (event: MessageEvent<ArtemisRollingAudioRequest>) =>
      this.processor.receive(event.data);
  }
  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    return this.processor.render(outputs[0]!);
  }
}
registerProcessor('artemis-rolling-pcm', ArtemisRollingAudioWorklet);

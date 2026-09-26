import {reportRuntimeAdvisory} from '../platform/runtime-advisories.js';

/** A processor owns command state and advances only when the audio device asks for samples. */
export interface BrowserPcmProcessor<Request> {
  receive(request: Request): void;
  render(output: Float32Array[]): boolean;
}

export interface BrowserPcmNode {
  readonly port: MessagePort;
  onprocessorerror: ((event: ErrorEvent) => void) | null;
  connect(destination: AudioNode): unknown;
  disconnect(): void;
}

const modules = new WeakMap<BaseAudioContext, Map<string, Promise<void>>>();

/** AudioWorklet is unavailable on ordinary LAN HTTP origins. The compatibility host uses
 * actual ScriptProcessor audio callbacks and the same processor, never a timer or silence
 * substitute. Its buffer size/latency is chosen by the browser; HTTPS keeps worklet output. */
export async function createBrowserPcmNode<Request, Response>(
  context: BaseAudioContext,
  options: {
    module: URL;
    name: string;
    channels: number;
    interpretation: ChannelInterpretation;
    processorOptions: unknown;
    createProcessor(send: (response: Response) => void): BrowserPcmProcessor<Request>;
  },
): Promise<BrowserPcmNode> {
  if (context.audioWorklet !== undefined && typeof AudioWorkletNode === 'function') {
    let loaded = modules.get(context);
    if (loaded === undefined) modules.set(context, (loaded = new Map()));
    const url = options.module.href;
    let module = loaded.get(url);
    if (module === undefined) {
      module = context.audioWorklet.addModule(options.module);
      loaded.set(url, module);
    }
    await module;
    return new AudioWorkletNode(context, options.name, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [options.channels],
      channelInterpretation: options.interpretation,
      processorOptions: options.processorOptions,
    });
  }
  if (typeof context.createScriptProcessor !== 'function')
    throw new Error(
      'This browser cannot provide PCM audio output. Open the game over HTTPS in a browser with AudioWorklet support.',
    );

  const node = context.createScriptProcessor(0, 0, options.channels);
  node.channelInterpretation = options.interpretation;
  const channel = new MessageChannel();
  let processor: BrowserPcmProcessor<Request>;
  try {
    processor = options.createProcessor((response) => channel.port2.postMessage(response));
  } catch (error) {
    node.disconnect();
    channel.port1.close();
    channel.port2.close();
    throw error;
  }
  let disconnected = false;
  const result: BrowserPcmNode = {
    port: channel.port1,
    onprocessorerror: null,
    connect: (destination) => node.connect(destination),
    disconnect: () => {
      if (disconnected) return;
      disconnected = true;
      node.onaudioprocess = null;
      node.disconnect();
      channel.port2.close();
    },
  };
  channel.port2.onmessage = (event: MessageEvent<Request>) => {
    try {
      processor.receive(event.data);
    } catch {
      node.onaudioprocess = null;
      result.onprocessorerror?.(new ErrorEvent('processorerror'));
    }
  };
  node.onaudioprocess = (event) => {
    const output = Array.from({length: event.outputBuffer.numberOfChannels}, (_, index) =>
      event.outputBuffer.getChannelData(index),
    );
    try {
      if (!processor.render(output)) node.onaudioprocess = null;
    } catch {
      for (const plane of output) plane.fill(0);
      node.onaudioprocess = null;
      result.onprocessorerror?.(new ErrorEvent('processorerror'));
    }
  };
  reportRuntimeAdvisory({
    id: 'audio-fallback',
    title: 'Audio compatibility mode',
    message:
      'AudioWorklet is unavailable, so audio is using ScriptProcessor on the main thread. Playback may stutter or fail. Use localhost or HTTPS with a browser that supports AudioWorklet.',
  });
  return result;
}

import {
  createBrowserPcmNode,
  type BrowserPcmNode,
} from '../../../../../../audio/browser-pcm-node.js';
import {AokanaBufferProcessor} from './buffer-processor.js';
import type {
  AokanaAudioBufferCommand,
  AokanaAudioBufferFormat,
  AokanaAudioBufferNotification,
  AokanaAudioBufferRequest,
  AokanaAudioBufferResponse,
  AokanaAudioBufferStatus,
} from './buffer-protocol.js';

/** Actual browser buffer primitive. Every command, including cursor queries, is acknowledged
 * by its audio processor owner. There is no synchronous cursor cache or wall-clock estimate. */
export class AokanaBrowserSpeakerBuffer {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {resolve(value: AokanaAudioBufferStatus): void; reject(reason: unknown): void}
  >();
  private readonly listeners = new Set<(event: AokanaAudioBufferNotification) => void>();
  private failure: Error | null = null;
  private disposed = false;
  private constructor(private readonly node: BrowserPcmNode) {
    node.port.onmessage = (event: MessageEvent<AokanaAudioBufferResponse>) => {
      const response = event.data;
      if (response.kind === 'failure') {
        this.fail(new Error(response.message));
        return;
      }
      if (response.kind === 'events') {
        for (const item of response.events) for (const listener of this.listeners) listener(item);
        return;
      }
      const pending = this.pending.get(response.id);
      if (pending === undefined) return;
      this.pending.delete(response.id);
      if (response.kind === 'reply') pending.resolve(response.status);
      else pending.reject(new Error(response.message));
    };
    node.onprocessorerror = () => this.fail(new Error('Aokana audio processor failed'));
  }
  static async create(
    context: BaseAudioContext,
    format: AokanaAudioBufferFormat,
    destination: AudioNode = context.destination,
  ): Promise<AokanaBrowserSpeakerBuffer> {
    if (destination.context !== context)
      throw new Error('Aokana audio destination belongs to a different context');
    const node = await createBrowserPcmNode<AokanaAudioBufferRequest, AokanaAudioBufferResponse>(
      context,
      {
        module: new URL('./buffer-worklet.js', import.meta.url),
        name: 'aokana-mutable-pcm',
        channels: Math.max(2, format.channels),
        interpretation: 'speakers',
        processorOptions: {format: {...format}},
        createProcessor: (send) => new AokanaBufferProcessor(format, context.sampleRate, send),
      },
    );
    const buffer = new AokanaBrowserSpeakerBuffer(node);
    node.connect(destination);
    try {
      await buffer.command({kind: 'status'});
      return buffer;
    } catch (error) {
      node.disconnect();
      node.port.close();
      throw error;
    }
  }
  private fail(error: Error): void {
    this.failure ??= error;
    for (const pending of this.pending.values()) pending.reject(this.failure);
    this.pending.clear();
  }
  command(command: AokanaAudioBufferCommand): Promise<AokanaAudioBufferStatus> {
    if (this.failure !== null) return Promise.reject(this.failure);
    if (this.disposed)
      return Promise.reject(new Error('Aokana browser speaker buffer is disposed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, {resolve, reject});
      const request: AokanaAudioBufferRequest = {id, command};
      try {
        this.node.port.postMessage(request);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  onNotification(listener: (event: AokanaAudioBufferNotification) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  async dispose(): Promise<void> {
    try {
      await this.command({kind: 'dispose'});
    } finally {
      this.disposed = true;
      this.node.disconnect();
      this.node.port.close();
      this.fail(new Error('Aokana browser speaker buffer is disposed'));
      this.listeners.clear();
    }
  }
}

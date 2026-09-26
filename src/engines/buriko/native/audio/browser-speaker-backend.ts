import {createBrowserPcmNode, type BrowserPcmNode} from '../../../../audio/browser-pcm-node.js';
import {BurikoBufferProcessor} from './buffer-processor.js';
import type {
  BurikoAudioBufferCommand,
  BurikoAudioBufferFormat,
  BurikoAudioBufferNotification,
  BurikoAudioBufferRequest,
  BurikoAudioBufferResponse,
  BurikoAudioBufferStatus,
} from './buffer-protocol.js';

/** Actual browser buffer primitive. Every command, including cursor queries, is acknowledged
 * by its audio processor owner. There is no synchronous cursor cache or wall-clock estimate. */
export class BurikoBrowserSpeakerBuffer {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {resolve(value: BurikoAudioBufferStatus): void; reject(reason: unknown): void}
  >();
  private readonly listeners = new Set<(event: BurikoAudioBufferNotification) => void>();
  private failure: Error | null = null;
  private disposed = false;
  private constructor(private readonly node: BrowserPcmNode) {
    node.port.onmessage = (event: MessageEvent<BurikoAudioBufferResponse>) => {
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
    node.onprocessorerror = () => this.fail(new Error('Buriko audio processor failed'));
  }
  static async create(
    context: BaseAudioContext,
    format: BurikoAudioBufferFormat,
    destination: AudioNode = context.destination,
  ): Promise<BurikoBrowserSpeakerBuffer> {
    if (destination.context !== context)
      throw new Error('Buriko audio destination belongs to a different context');
    const node = await createBrowserPcmNode<BurikoAudioBufferRequest, BurikoAudioBufferResponse>(
      context,
      {
        module: new URL('./buffer-worklet.js', import.meta.url),
        name: 'buriko-mutable-pcm',
        channels: Math.max(2, format.channels),
        interpretation: 'speakers',
        processorOptions: {format: {...format}},
        createProcessor: (send) => new BurikoBufferProcessor(format, context.sampleRate, send),
      },
    );
    const buffer = new BurikoBrowserSpeakerBuffer(node);
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
  command(command: BurikoAudioBufferCommand): Promise<BurikoAudioBufferStatus> {
    if (this.failure !== null) return Promise.reject(this.failure);
    if (this.disposed)
      return Promise.reject(new Error('Buriko browser speaker buffer is disposed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, {resolve, reject});
      const request: BurikoAudioBufferRequest = {id, command};
      try {
        this.node.port.postMessage(request);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  onNotification(listener: (event: BurikoAudioBufferNotification) => void): () => void {
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
      this.fail(new Error('Buriko browser speaker buffer is disposed'));
      this.listeners.clear();
    }
  }
}

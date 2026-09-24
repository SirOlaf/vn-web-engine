import {AokanaMoviePcmCore} from './movie-pcm-core.js';
import type {
  AokanaMoviePcmCommand,
  AokanaMoviePcmFormat,
  AokanaMoviePcmRequest,
  AokanaMoviePcmResponse,
  AokanaMoviePcmStatus,
} from './movie-pcm-protocol.js';
/** Observers cannot change owner results or prevent cleanup/other notifications. */
function notifyObserver<T>(listener: (value: T) => void, value: T): void {
  try {
    listener(value);
  } catch {
    /* External observation is not an owner failure. */
  }
}

export class AokanaMemoryMoviePcmOutput {
  readonly core: AokanaMoviePcmCore;
  private readonly listeners = new Set<(status: AokanaMoviePcmStatus) => void>();
  private readonly completions = new Set<(status: AokanaMoviePcmStatus) => void>();
  constructor(format: AokanaMoviePcmFormat, outputRate: number) {
    this.core = new AokanaMoviePcmCore(format, outputRate);
  }
  command(command: AokanaMoviePcmCommand): AokanaMoviePcmStatus {
    return this.core.command(command);
  }
  get acknowledgedStatus(): AokanaMoviePcmStatus {
    return this.core.status();
  }
  get outputFormat(): AokanaMoviePcmFormat {
    return {...this.core.format};
  }
  get outputSampleRate(): number {
    return this.core.outputRate;
  }
  onProgress(listener: (status: AokanaMoviePcmStatus) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  onComplete(listener: (status: AokanaMoviePcmStatus) => void): () => void {
    this.completions.add(listener);
    return () => {
      this.completions.delete(listener);
    };
  }
  render(frames: number): readonly Float32Array[] {
    const output = [new Float32Array(frames), new Float32Array(frames)];
    const previous = this.core.status();
    const status = this.core.render(output);
    if (!previous.ended && status.ended)
      for (const listener of [...this.completions]) notifyObserver(listener, status);
    for (const listener of [...this.listeners]) notifyObserver(listener, status);
    return output;
  }
}
const modules = new WeakMap<BaseAudioContext, Promise<void>>();
/** Actual output-thread acknowledgments; no automatic activation or extrapolated clock. */
export class AokanaBrowserMoviePcmOutput {
  private nextId = 1;
  private enqueuePending = false;
  private disposed = false;
  private failure: Error | null = null;
  private generation = 0;
  private latest: AokanaMoviePcmStatus | null = null;
  private readonly failures = new Set<(error: Error) => void>();
  private readonly pending = new Map<
    number,
    {resolve(status: AokanaMoviePcmStatus): void; reject(error: unknown): void}
  >();
  private readonly listeners = new Set<(status: AokanaMoviePcmStatus) => void>();
  private readonly completions = new Set<(status: AokanaMoviePcmStatus) => void>();
  private constructor(
    private readonly node: AudioWorkletNode,
    private readonly format: AokanaMoviePcmFormat,
    readonly outputSampleRate: number,
  ) {
    node.port.onmessage = (event: MessageEvent<AokanaMoviePcmResponse>) => {
      const response = event.data;
      if (response.kind === 'failure') {
        this.fail(new Error(response.message));
        return;
      }
      if (response.kind === 'progress' || response.kind === 'complete') {
        if (response.status.generation === this.generation) {
          this.latest = response.status;
          for (const listener of [
            ...(response.kind === 'complete' ? this.completions : this.listeners),
          ])
            notifyObserver(listener, response.status);
        }
        return;
      }
      const pending = this.pending.get(response.id);
      if (pending === undefined) return;
      this.pending.delete(response.id);
      if (response.kind === 'error') pending.reject(new Error(response.message));
      else {
        if (response.status.generation >= this.generation) {
          this.generation = response.status.generation;
          this.latest = response.status;
        }
        pending.resolve(response.status);
      }
    };
    node.onprocessorerror = () => this.fail(new Error('Movie PCM worklet failed'));
  }
  static async create(
    context: BaseAudioContext,
    format: AokanaMoviePcmFormat,
    destination: AudioNode = context.destination,
  ): Promise<AokanaBrowserMoviePcmOutput> {
    if (destination.context !== context)
      throw new Error('Movie output belongs to another audio context');
    // Validate the declared profile before creating the real node, without consuming audio.
    new AokanaMoviePcmCore(format, context.sampleRate);
    let module = modules.get(context);
    if (module === undefined) {
      module = context.audioWorklet.addModule(new URL('./movie-pcm-worklet.js', import.meta.url));
      modules.set(context, module);
    }
    await module;
    const node = new AudioWorkletNode(context, 'aokana-movie-pcm', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelInterpretation: 'discrete',
      processorOptions: {format: {...format}},
    });
    const output = new AokanaBrowserMoviePcmOutput(node, {...format}, context.sampleRate);
    node.connect(destination);
    try {
      await output.command({kind: 'status'});
      return output;
    } catch (error) {
      node.disconnect();
      node.port.close();
      throw error;
    }
  }
  private fail(error: Error): void {
    const first = this.failure === null;
    this.failure ??= error;
    for (const pending of this.pending.values()) pending.reject(this.failure);
    this.pending.clear();
    if (first) for (const listener of [...this.failures]) notifyObserver(listener, this.failure);
  }
  onFailure(listener: (error: Error) => void): () => void {
    this.failures.add(listener);
    if (this.failure !== null) notifyObserver(listener, this.failure);
    return () => {
      this.failures.delete(listener);
    };
  }
  onComplete(listener: (status: AokanaMoviePcmStatus) => void): () => void {
    this.completions.add(listener);
    return () => {
      this.completions.delete(listener);
    };
  }
  get acknowledgedStatus(): AokanaMoviePcmStatus | null {
    return this.latest;
  }
  get outputFormat(): AokanaMoviePcmFormat {
    return {...this.format};
  }
  onProgress(listener: (status: AokanaMoviePcmStatus) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  async command(command: AokanaMoviePcmCommand): Promise<AokanaMoviePcmStatus> {
    if (this.failure !== null) throw this.failure;
    if (this.disposed) throw new Error('Movie PCM output is disposed');
    const enqueue = command.kind === 'enqueue';
    if (command.kind === 'enqueue') {
      const span = command.span;
      if (
        !Number.isSafeInteger(span.frameCount) ||
        span.frameCount < 1 ||
        span.frameCount > this.format.capacityFrames ||
        span.planes.length !== this.format.channels ||
        span.planes.some(
          (plane) => !(plane instanceof Float32Array) || plane.length !== span.frameCount,
        )
      )
        throw new RangeError('Movie PCM publication exceeds its negotiated plane bounds');
    }
    if (enqueue && this.enqueuePending)
      throw new Error('Movie PCM permits one outstanding enqueue');
    if (enqueue) this.enqueuePending = true;
    try {
      const id = this.nextId++;
      return await new Promise<AokanaMoviePcmStatus>((resolve, reject) => {
        this.pending.set(id, {resolve, reject});
        try {
          const published =
            command.kind === 'enqueue'
              ? {
                  ...command,
                  span: {
                    ...command.span,
                    planes: command.span.planes.map((plane) => plane.slice()),
                  },
                }
              : command;
          const request: AokanaMoviePcmRequest = {id, command: published};
          this.node.port.postMessage(request);
        } catch (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
    } finally {
      if (enqueue) this.enqueuePending = false;
    }
  }
  async dispose(generation: number): Promise<void> {
    try {
      const status = await this.command({kind: 'dispose', generation});
      if (status.result !== 'ok') throw new Error('Movie PCM disposal was not applied');
    } finally {
      this.disposed = true;
      this.node.disconnect();
      this.node.port.close();
      this.fail(new Error('Movie PCM output is disposed'));
      this.listeners.clear();
      this.completions.clear();
      this.failures.clear();
    }
  }
}

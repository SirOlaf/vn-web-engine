import {createBrowserPcmNode} from '../../audio/browser-pcm-node.js';
import type {AudioVoice} from '../../audio/transport.js';
import {artemisRevision} from './revision.js';
import {
  ArtemisRollingAudioProcessor,
  type ArtemisRollingAudioOptions,
  type ArtemisRollingAudioCommand,
  type ArtemisRollingAudioRequest,
  type ArtemisRollingAudioResponse,
} from './rolling-audio-processor.js';
import type {ArtemisPcmResource} from './pcm-resource.js';

/** Progressive PCM owner: an incomplete snapshot, followed by its appends and its end. */
export interface ArtemisPcmStream {
  /** Returns the PCM so far; `listener` then receives each later chunk, and null at the end. */
  follow(listener: (bytes: Uint8Array | null) => void): ArtemisPcmResource;
  /** Stops decoding; the voice closes its stream when it is disposed. */
  close(): void;
}

export interface ArtemisRollingVoice extends AudioVoice {
  /** Fence commands for integration tests/owners that must observe worker completion. */
  synchronize(): Promise<void>;
  readonly failure: Error | null;
}
export async function createArtemisRollingVoice(
  context: BaseAudioContext,
  input:
    | ArtemisRollingAudioOptions
    | {readonly hash: string; readonly stream: ArtemisPcmStream; readonly bufferMode: number},
): Promise<ArtemisRollingVoice> {
  artemisRevision(input.hash);
  // Chunks decoded while the node is created wait here, in order.
  let queued: (Uint8Array | null)[] | null = [],
    deliver = (bytes: Uint8Array | null): void => void queued!.push(bytes);
  const stream = 'stream' in input ? input.stream : undefined,
    options: ArtemisRollingAudioOptions = stream
      ? {
          hash: input.hash,
          bufferMode: input.bufferMode,
          resource: stream.follow((bytes) => deliver(bytes)),
        }
      : (input as ArtemisRollingAudioOptions);
  let decodedBytes = options.resource.bytes.length;
  let node;
  try {
    node = await createBrowserPcmNode<ArtemisRollingAudioRequest, ArtemisRollingAudioResponse>(
      context,
      {
        module: new URL('./rolling-audio-worklet.js', import.meta.url),
        name: 'artemis-rolling-pcm',
        channels: 2,
        interpretation: 'discrete',
        processorOptions: options,
        createProcessor: (send) =>
          new ArtemisRollingAudioProcessor(options, context.sampleRate, send),
      },
    );
  } catch (error) {
    stream?.close();
    throw error;
  }
  const gain = context.createGain(),
    splitter = context.createChannelSplitter(2),
    left = context.createGain(),
    right = context.createGain(),
    merger = context.createChannelMerger(2);
  gain.gain.value = 0;
  left.gain.value = right.gain.value = 1;
  node.connect(gain);
  gain.connect(splitter);
  splitter.connect(left, 0);
  splitter.connect(right, 1);
  left.connect(merger, 0, 0);
  right.connect(merger, 0, 1);
  merger.connect(context.destination);
  let nextId = 0,
    loop = false,
    started = false,
    disposed = false,
    position = 0,
    finished = false,
    failure: Error | null = null;
  const pending = new Map<number, {resolve(): void; reject(error: Error): void}>();
  const fail = (error: Error) => {
    failure = error;
    finished = true;
    for (const job of pending.values()) job.reject(error);
    pending.clear();
  };
  node.port.onmessage = ({data}: MessageEvent<ArtemisRollingAudioResponse>) => {
    if (disposed) return;
    if (data.kind === 'error') {
      fail(Error(data.message));
      return;
    }
    position = data.position;
    finished = data.finished;
    if (data.id !== undefined) {
      pending.get(data.id)?.resolve();
      pending.delete(data.id);
    }
  };
  node.onprocessorerror = () => fail(Error('Artemis rolling PCM processor failed'));
  const send = (
    command: ArtemisRollingAudioCommand,
    fence = false,
    transfer: Transferable[] = [],
  ): Promise<void> | undefined => {
    if (disposed) {
      if (fence) return Promise.reject(Error('Artemis rolling voice disposed'));
      return;
    }
    if (failure) {
      if (fence) return Promise.reject(failure);
      throw failure;
    }
    const id = ++nextId;
    let done: Promise<void> | undefined;
    if (fence) done = new Promise((resolve, reject) => pending.set(id, {resolve, reject}));
    try {
      node.port.postMessage({id, command} satisfies ArtemisRollingAudioRequest, transfer);
    } catch (error) {
      fail(error instanceof Error ? error : Error(String(error)));
      if (!fence) throw failure;
    }
    return done;
  };
  const count = (resource: ArtemisRollingAudioOptions['resource']): number =>
    resource.declaredSize + (resource.paired ? count(resource.paired) : 0);
  const voice: ArtemisRollingVoice = {
    sampleRate: options.resource.format.sampleRate,
    /** Decoded so far while a progressive stream is still decoding. */
    get sampleCount() {
      return (stream ? decodedBytes : count(options.resource)) / options.resource.format.blockAlign;
    },
    loopStart: options.resource.paired
      ? options.resource.declaredSize / options.resource.format.blockAlign
      : 0,
    position: () => position,
    ended: () => finished,
    get failure() {
      return failure;
    },
    pause: (paused) => {
      if (disposed) return;
      if (!paused && !started) {
        send({kind: 'start', loop});
        started = true;
      } else send({kind: 'pause', paused});
    },
    setLoop: (value) => {
      if (typeof value !== 'boolean') throw Error('Invalid Artemis voice loop flag');
      if (started && value !== loop) throw Error('Unsupported live Artemis rolling loop change');
      loop = value;
    },
    stop: () => {
      if (!disposed) {
        send({kind: 'stop'});
        started = false;
        position = 0;
        finished = false;
      }
    },
    pump: () => {
      if (!disposed && started && !finished) send({kind: 'pump'});
    },
    synchronize: () => send({kind: 'status'}, true)!,
    volume: (value) => {
      if (!Number.isFinite(value)) throw Error('Invalid Artemis voice gain');
      if (!disposed) gain.gain.setValueAtTime(Math.max(0, Math.min(1, value)), context.currentTime);
    },
    stereoBalance: (a, b) => {
      if (![a, b].every((value) => Number.isFinite(value) && value >= 0 && value <= 1))
        throw Error('Invalid Artemis voice balance');
      if (!disposed) {
        left.gain.setValueAtTime(a, context.currentTime);
        right.gain.setValueAtTime(b, context.currentTime);
      }
    },
    dispose: () => {
      if (disposed) return;
      stream?.close();
      try {
        if (!failure) send({kind: 'dispose'});
      } finally {
        disposed = true;
        fail(Error('Artemis rolling voice disposed'));
        node.port.onmessage = null;
        node.onprocessorerror = null;
        node.disconnect();
        node.port.close();
        gain.disconnect();
        splitter.disconnect();
        left.disconnect();
        right.disconnect();
        merger.disconnect();
      }
    },
  };
  if (stream) {
    deliver = (bytes) => {
      if (disposed || failure) return;
      if (bytes === null) send({kind: 'end'});
      else {
        decodedBytes += bytes.length;
        send({kind: 'append', bytes}, false, [bytes.buffer as ArrayBuffer]);
      }
    };
    for (const bytes of queued!) deliver(bytes);
  }
  queued = null;
  try {
    await voice.synchronize();
    return voice;
  } catch (error) {
    voice.dispose();
    throw error;
  }
}

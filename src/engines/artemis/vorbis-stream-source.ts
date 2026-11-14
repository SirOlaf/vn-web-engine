import type {ByteSource} from '../../core/source.js';
import {sseInt32, type SseRounding} from '../../core/sse-integer.js';
import type {ArtemisPcmStream} from './browser-rolling-voice.js';
import type {ArtemisPcmResource} from './pcm-resource.js';
import {artemisRevision} from './revision.js';
import {
  ArtemisVorbisPcmChunks,
  type ArtemisVorbisStreamInput,
  type ArtemisVorbisStreamOptions,
  type ArtemisVorbisStreamOutput,
} from './vorbis-pcm-stream.js';
import type {ArtemisWaveFormat} from './wave-source.js';

/** The first read covers the headers and several seconds of a typical music file. */
const FIRST_READ_BYTES = 256 * 1024;
const NEXT_READ_BYTES = 1024 * 1024;
/** About a tenth of a second at 44.1 kHz, then about a second per decoded batch. */
const FIRST_FRAMES = 4096;
const CHUNK_FRAMES = 44100;

interface DecodeSession {
  push(bytes: Uint8Array, last: boolean): void;
  cancel(): void;
}

/**
 * Progressive Vorbis decoding sessions: reusable module workers, or in-thread without them.
 * One idle worker with a loaded codec is kept ready, so a sound that starts while another
 * stream still decodes does not wait for a worker and its codec to load.
 */
export class ArtemisVorbisStreamDecoder {
  private readonly idle: Worker[] = [];
  private closed = false;
  constructor(
    private readonly hash: string,
    private readonly rounding: SseRounding,
  ) {
    artemisRevision(hash);
    sseInt32(0, rounding);
    if (typeof Worker !== 'undefined') this.idle.push(this.spawn());
  }
  private spawn(): Worker {
    const worker = new Worker(new URL('./vorbis-pcm-stream-worker.js', import.meta.url), {
      type: 'module',
    });
    worker.postMessage({kind: 'warm'} satisfies ArtemisVorbisStreamInput);
    return worker;
  }
  open(receive: (output: ArtemisVorbisStreamOutput) => void): DecodeSession {
    if (this.closed) throw Error('Artemis Vorbis stream decoder closed');
    const options: ArtemisVorbisStreamOptions = {
      hash: this.hash,
      rounding: this.rounding,
      firstFrames: FIRST_FRAMES,
      chunkFrames: CHUNK_FRAMES,
    };
    if (typeof Worker === 'undefined') {
      let cancelled = false,
        queue = Promise.resolve();
      const chunks = new ArtemisVorbisPcmChunks(options, (output) => {
        if (!cancelled) receive(output);
      });
      return {
        push: (bytes, last) => {
          queue = queue.then(() => chunks.push(bytes, last));
        },
        cancel: () => {
          cancelled = true;
          void queue.then(() => chunks.close());
        },
      };
    }
    const worker = this.idle.pop() ?? this.spawn();
    if (!this.idle.length) this.idle.push(this.spawn());
    let finished = false;
    const finish = (reuse: boolean): void => {
      if (finished) return;
      finished = true;
      worker.onmessage = worker.onerror = worker.onmessageerror = null;
      if (reuse && !this.closed && this.idle.length < 2) this.idle.push(worker);
      else worker.terminate();
    };
    const fail = (message: string): void => {
      finish(false);
      receive({kind: 'error', message, encodedDataError: false});
    };
    worker.onerror = (event) => {
      event.preventDefault();
      fail(event.message || 'Artemis Vorbis stream worker failed');
    };
    worker.onmessageerror = () => fail('Artemis Vorbis stream result could not be transferred');
    worker.onmessage = ({data}: MessageEvent<ArtemisVorbisStreamOutput>) => {
      if (data.kind === 'done' || data.kind === 'error') finish(true);
      receive(data);
    };
    worker.postMessage({kind: 'open', options} satisfies ArtemisVorbisStreamInput);
    return {
      push: (bytes, last) => {
        if (finished) return;
        worker.postMessage({kind: 'bytes', bytes, last} satisfies ArtemisVorbisStreamInput, [
          bytes.buffer as ArrayBuffer,
        ]);
      },
      cancel: () => finish(false),
    };
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const worker of this.idle.splice(0)) worker.terminate();
  }
}

/**
 * A Vorbis file decoded while it is read: consecutive reads feed a decoding session, and
 * `open` settles once `startBytes(format)` of PCM16 exist or the stream ended. This is the
 * progressive form of `ArtemisVorbisSource` for files without a paired `_b` resource.
 * An encoded-data error before any PCM is a decode miss (null), as in the eager source;
 * after that, any read or decode failure ends the PCM where it stopped.
 */
export class ArtemisVorbisStream implements ArtemisPcmStream {
  private readonly chunks: Uint8Array[] = [];
  private size = 0;
  private complete = false;
  private closed = false;
  private listener: ((bytes: Uint8Array | null) => void) | undefined;
  private session: DecodeSession | undefined;
  private constructor(readonly format: ArtemisWaveFormat) {}
  get decodedBytes(): number {
    return this.size;
  }
  static open(
    hash: string,
    source: ByteSource,
    decoder: ArtemisVorbisStreamDecoder,
    startBytes: (format: ArtemisWaveFormat) => number,
  ): Promise<ArtemisVorbisStream | null> {
    artemisRevision(hash);
    return new Promise((resolve, reject) => {
      let stream: ArtemisVorbisStream | undefined,
        needed = Infinity,
        settled = false;
      const settle = (value: ArtemisVorbisStream | null, error?: unknown): void => {
        if (settled) return;
        settled = true;
        if (error !== undefined) reject(error);
        else resolve(value);
      };
      // A decode miss before any PCM settles null and stops the reads.
      const missed = (): boolean => settled && !stream;
      const fail = (error: unknown, encodedDataError: boolean): void => {
        session.cancel();
        if (!stream || (!settled && stream.size === 0)) {
          stream?.release();
          stream = undefined;
          if (encodedDataError) settle(null);
          else settle(null, error instanceof Error ? error : Error(String(error)));
          return;
        }
        stream.end();
        settle(stream);
      };
      const session = decoder.open((output) => {
        if (output.kind === 'error') {
          fail(Error(output.message), output.encodedDataError);
          return;
        }
        if (output.kind === 'open') {
          const format = {
            sampleRate: output.sampleRate,
            channels: output.channels,
            bitsPerSample: 16,
            blockAlign: output.channels * 2,
          };
          if (
            !Number.isInteger(format.sampleRate) ||
            format.sampleRate <= 0 ||
            format.sampleRate > 0xffffffff ||
            format.channels < 1 ||
            format.channels > 65535
          ) {
            fail(Error('Invalid Artemis decoded Vorbis storage'), false);
            return;
          }
          try {
            needed = startBytes(format);
          } catch (error) {
            fail(error, false);
            return;
          }
          stream = new ArtemisVorbisStream(format);
          stream.session = session;
          return;
        }
        if (!stream) {
          fail(Error('Artemis Vorbis stream reported PCM before its format'), false);
          return;
        }
        if (output.kind === 'done') stream.end();
        else if (!stream.closed) stream.add(output.bytes);
        if (stream.complete || stream.size >= needed) settle(stream);
      });
      void (async () => {
        try {
          for (let offset = 0; offset < source.size && !stream?.closed && !missed();) {
            const length = Math.min(
              offset ? NEXT_READ_BYTES : FIRST_READ_BYTES,
              source.size - offset,
            );
            const bytes = await source.read(offset, length);
            offset += length;
            session.push(bytes, offset >= source.size);
          }
          if (source.size === 0) session.push(new Uint8Array(), true);
        } catch (error) {
          fail(error, false);
        }
      })();
    });
  }
  follow(listener: (bytes: Uint8Array | null) => void): ArtemisPcmResource {
    if (this.listener) throw Error('Artemis Vorbis stream already followed');
    this.listener = listener;
    const bytes = new Uint8Array(this.size);
    let at = 0;
    for (const chunk of this.chunks) {
      bytes.set(chunk, at);
      at += chunk.length;
    }
    // The follower owns the PCM from here on.
    this.chunks.length = 0;
    return {
      kind: 'vorbis',
      format: {...this.format},
      declaredSize: bytes.length,
      bytes,
      complete: this.complete,
    };
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.release();
  }
  private add(bytes: Uint8Array): void {
    if (bytes.length % this.format.blockAlign !== 0)
      throw Error('Invalid Artemis decoded Vorbis storage');
    this.size += bytes.length;
    if (this.listener) this.listener(bytes);
    else this.chunks.push(bytes);
  }
  private end(): void {
    if (this.complete) return;
    this.complete = true;
    this.session = undefined;
    this.listener?.(null);
  }
  private release(): void {
    this.session?.cancel();
    this.session = undefined;
    this.listener = undefined;
    this.chunks.length = 0;
  }
}

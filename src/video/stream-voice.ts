import type {WorkerSource} from '../core/worker-source.js';
import type {MovieInfo} from './movie-types.js';
import type {YuvFrame} from './frame.js';
import type {MovieResponse} from './worker-protocol.js';

/** Bounded worker decoding with a Web Audio clock. No VM state or game policy. */
export class StreamMovieVoice {
  private worker: Worker | undefined;
  private info: MovieInfo | undefined;
  private frames: {at: number; frame: YuvFrame}[] = [];
  private audio: {at: number; buffer: AudioBuffer; node?: AudioBufferSourceNode}[] = [];
  private readonly gain: GainNode;
  private epoch = 0;
  private offset = 0;
  private cycle = 0;
  private audioEnd = 0;
  private videoEnd = 0;
  private pulling = false;
  private done = false;
  private playing = false;
  private wanted = false;
  private looping = false;
  private disposed = false;
  private failure: unknown;
  private current: YuvFrame | undefined;
  constructor(
    private readonly context: AudioContext,
    private readonly source: WorkerSource,
  ) {
    this.gain = context.createGain();
    this.gain.connect(context.destination);
    this.open();
  }
  get metadata(): MovieInfo | undefined {
    return this.info;
  }
  private failWorker(worker: Worker, error: unknown): void {
    if (this.disposed || this.worker !== worker || this.failure !== undefined) return;
    this.failure = error;
    this.freeze();
    worker.terminate();
  }
  private availableAudio(info: MovieInfo): number {
    return Math.max(this.audioEnd, this.cycle + (info.audioStartTime ?? 0));
  }
  private open(): void {
    this.worker?.terminate();
    this.worker = new Worker(new URL('./decode-worker.js', import.meta.url), {type: 'module'});
    const worker = this.worker;
    worker.onerror = (e) => {
      e.preventDefault();
      this.failWorker(worker, new Error(e.message || 'Movie worker failed'));
    };
    worker.onmessageerror = () =>
      this.failWorker(worker, new Error('Movie worker result could not be transferred'));
    worker.onmessage = (event: MessageEvent<MovieResponse>) => {
      if (this.disposed || this.worker !== worker) return;
      try {
        const b = event.data;
        if (b.type === 'error') throw new Error(b.message);
        if (b.type === 'seeking') return;
        this.pulling = false;
        this.info = b.info;
        this.done = b.done;
        for (const frame of b.frames) {
          const at = this.cycle + (frame.timestamp ?? frame.index / b.info.frameRate);
          this.frames.push({at, frame});
          this.videoEnd = at + (frame.duration ?? 1 / b.info.frameRate);
        }
        for (let firstIndex = 0; firstIndex < b.audio.length;) {
          const first = b.audio[firstIndex]!,
            firstTime = first.timestamp ?? first.start / b.info.sampleRate;
          let end = firstIndex + 1,
            count = first.channels[0]!.length;
          while (end < b.audio.length) {
            const next = b.audio[end]!,
              nextTime = next.timestamp ?? next.start / b.info.sampleRate;
            if (
              next.start !== first.start + count ||
              Math.abs(nextTime - firstTime - count / b.info.sampleRate) > 0.5 / b.info.sampleRate
            )
              break;
            count += next.channels[0]!.length;
            end++;
          }
          const buffer = this.context.createBuffer(b.info.channels, count, b.info.sampleRate);
          let offset = 0;
          for (const a of b.audio.slice(firstIndex, end)) {
            for (let c = 0; c < b.info.channels; c++)
              buffer.getChannelData(c).set(a.channels[c]!, offset);
            offset += a.channels[0]!.length;
          }
          const at = this.cycle + firstTime;
          this.audio.push({at, buffer});
          this.audioEnd = at + count / b.info.sampleRate;
          firstIndex = end;
        }
        this.tick();
      } catch (error) {
        this.failWorker(worker, error);
      }
    };
    this.pulling = true;
    this.done = false;
    worker.postMessage({type: 'open', source: this.source, seek: 0});
  }
  private position(): number {
    return this.playing
      ? Math.max(this.offset, this.context.currentTime - this.epoch)
      : this.offset;
  }
  private freeze(): void {
    this.offset = this.position();
    this.playing = false;
    for (const chunk of this.audio)
      if (chunk.node) {
        chunk.node.onended = null;
        chunk.node.stop();
        chunk.node.disconnect();
        chunk.node = undefined;
      }
  }
  private schedule(): void {
    if (!this.playing) return;
    for (const chunk of this.audio) {
      if (chunk.node) continue;
      const trim = Math.max(0, this.offset - chunk.at);
      if (trim >= chunk.buffer.duration) continue;
      const node = this.context.createBufferSource();
      node.buffer = chunk.buffer;
      node.connect(this.gain);
      chunk.node = node;
      node.onended = () => {
        node.disconnect();
      };
      node.start(Math.max(this.context.currentTime, this.epoch + chunk.at + trim), trim);
    }
  }
  tick(): void {
    if (this.failure !== undefined) throw new Error('Movie decoding failed', {cause: this.failure});
    if (this.disposed) return;
    const info = this.info;
    let position = this.position();
    if (info && this.playing) {
      const videoFinished =
        this.videoEnd >=
        this.cycle + (info.videoEndTime ?? info.frameCount / info.frameRate) - 1e-6;
      const audioFinished =
        !info.channels ||
        this.audioEnd >=
          this.cycle + (info.audioEndTime ?? info.sampleCount / info.sampleRate) - 1e-6;
      const available = Math.min(
        videoFinished ? Infinity : this.videoEnd,
        audioFinished ? Infinity : this.availableAudio(info),
      );
      if (position >= available && !this.done) {
        this.offset = available;
        this.freeze();
        this.offset = available;
        position = available;
      } else if (this.done && !this.looping && position >= this.cycle + info.duration) {
        this.freeze();
        this.offset = this.cycle + info.duration;
        position = this.offset;
        this.wanted = false;
      }
    }
    while (this.frames.length && this.frames[0]!.at <= position)
      this.current = this.frames.shift()!.frame;
    while (this.audio.length && this.audio[0]!.at + this.audio[0]!.buffer.duration <= position) {
      const chunk = this.audio.shift()!;
      chunk.node?.disconnect();
    }
    if (this.done && this.looping && info && this.frames.length < 8) {
      this.cycle += info.duration;
      this.open();
    }
    if (!this.done && !this.pulling && this.frames.length < 8) {
      this.pulling = true;
      this.worker!.postMessage({type: 'pull'});
    }
    if (
      info &&
      this.wanted &&
      !this.playing &&
      (this.done ||
        this.videoEnd - position >= 0.1 ||
        this.videoEnd >=
          this.cycle + (info.videoEndTime ?? info.frameCount / info.frameRate) - 1e-6) &&
      (info.channels === 0 ||
        this.done ||
        this.availableAudio(info) - position >= 0.1 ||
        this.audioEnd >=
          this.cycle + (info.audioEndTime ?? info.sampleCount / info.sampleRate) - 1e-6)
    ) {
      this.epoch = this.context.currentTime - position + 0.02;
      this.playing = true;
    }
    this.schedule();
  }
  pause(paused: boolean): void {
    if (this.disposed) return;
    this.wanted = !paused;
    if (paused) this.freeze();
    else this.tick();
  }
  loop(enabled: boolean): void {
    this.looping = enabled;
  }
  volume(value: number): void {
    this.gain.gain.value = Math.max(0, Math.min(1, value));
  }
  snapshot(): {
    status: number;
    positionMs: number;
    durationMs: number;
    frameCount: number;
    frameRate: number;
    frame?: YuvFrame;
  } {
    this.tick();
    const duration = this.info?.duration ?? 0,
      p = this.position();
    const ended = this.done && !this.looping && duration > 0 && p >= this.cycle + duration;
    return {
      status: ended ? 6 : this.info ? 5 : 2,
      positionMs: Math.floor(
        (this.looping && duration ? p % duration : Math.min(p, duration)) * 1000,
      ),
      durationMs: Math.floor(duration * 1000),
      frameCount: this.info?.frameCount ?? 0,
      frameRate: this.info?.frameRate ?? 0,
      frame: this.current,
    };
  }
  dispose(): void {
    if (this.disposed) return;
    this.freeze();
    this.disposed = true;
    this.worker?.terminate();
    this.worker = undefined;
    this.gain.disconnect();
    this.audio = [];
    this.frames = [];
  }
}

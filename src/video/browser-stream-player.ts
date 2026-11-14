import {BrowserAudioContextHost} from '../audio/browser-audio-context-host.js';
import type {WorkerSource} from '../core/worker-source.js';
import type {YuvFrame} from './frame.js';
import type {MovieInfo} from './movie-types.js';
import {StreamMovieVoice} from './stream-voice.js';

/** Browser device/lifecycle owner for the shared software movie decoder. */
export class BrowserStreamMoviePlayer {
  private readonly voice: StreamMovieVoice;
  private readonly activation: BrowserAudioContextHost;
  /** Cancels the scheduled presentation poll. */
  private cancel: (() => void) | null = null;
  private delivery: Promise<void> = Promise.resolve();
  private previous: YuvFrame | undefined;
  private closed = false;
  private finished = false;
  private failure: unknown;
  private closing: Promise<void> | null = null;

  private constructor(
    private readonly context: AudioContext,
    source: WorkerSource,
    private readonly document: Document,
  ) {
    this.voice = new StreamMovieVoice(context, source);
    this.activation = new BrowserAudioContextHost(context, document);
  }

  static async open(
    source: WorkerSource,
    document: Document,
    signal: AbortSignal,
  ): Promise<BrowserStreamMoviePlayer> {
    const context = new AudioContext();
    let player: BrowserStreamMoviePlayer | undefined;
    try {
      player = new BrowserStreamMoviePlayer(context, source, document);
      while (true) {
        signal.throwIfAborted();
        player.voice.snapshot(); // Surface worker failures during preparation.
        if (player.voice.metadata !== undefined) return player;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            signal.removeEventListener('abort', abort);
            resolve();
          }, 16);
          const abort = () => {
            clearTimeout(timer);
            reject(signal.reason);
          };
          signal.addEventListener('abort', abort, {once: true});
          if (signal.aborted) abort();
        });
      }
    } catch (error) {
      if (player) await player.closeAndJoin();
      else await context.close();
      throw error;
    }
  }

  get info(): MovieInfo {
    const info = this.voice.metadata;
    if (!info) throw new Error('Movie metadata is not ready');
    return info;
  }
  get position(): number {
    if (this.failure !== undefined) throw this.failure;
    if (this.finished) return this.info.duration;
    const snapshot = this.voice.snapshot();
    return snapshot.status === 6 ? this.info.duration : snapshot.positionMs / 1000;
  }
  /** Diagnostic counters of the decoder and its clock. */
  get decoding(): StreamMovieVoice['decoding'] {
    return this.voice.decoding;
  }
  volume(value: number): void {
    this.voice.volume(value);
  }

  /** The callback borrows a decoded frame until it settles. Slow consumers skip
   * late presentations using the audio clock instead of building an unbounded queue.
   * Frames are polled in animation frames, so a picture is drawn in step with the
   * display; a hidden document has none and is polled every 16 ms. */
  start(receive: (frame: YuvFrame) => void | Promise<void>): void {
    if (this.closed) throw new Error('Movie player is closed');
    this.voice.pause(false);
    void this.activation.resume().catch(() => {}); // Host activation controls retain suspended playback.
    const next = (): void => {
      this.cancel = null;
      if (this.closed || this.finished) return;
      this.delivery = (async () => {
        const snapshot = this.voice.snapshot();
        if (snapshot.frame !== undefined && snapshot.frame !== this.previous) {
          this.previous = snapshot.frame;
          await receive(snapshot.frame);
        }
        if (!this.closed && !this.finished && snapshot.status !== 6) this.schedule(next);
      })().catch((error: unknown) => {
        this.failure = error;
        this.voice.pause(true);
      });
    };
    next();
  }

  private schedule(poll: () => void): void {
    const view = this.document.defaultView;
    if (view?.requestAnimationFrame && this.document.visibilityState !== 'hidden') {
      const frame = view.requestAnimationFrame(poll);
      this.cancel = () => view.cancelAnimationFrame(frame);
    } else {
      const timer = setTimeout(poll, 16);
      this.cancel = () => clearTimeout(timer);
    }
  }

  finishEarly(): void {
    if (this.closed || this.finished) return;
    this.finished = true;
    this.cancel?.();
    this.cancel = null;
    this.voice.pause(true);
  }

  closeAndJoin(): Promise<void> {
    if (this.closing !== null) return this.closing;
    this.closed = true;
    this.cancel?.();
    this.cancel = null;
    this.activation.dispose();
    this.voice.dispose();
    this.closing = this.delivery.then(() => this.context.close());
    return this.closing;
  }
}

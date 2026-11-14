import {sourceBlob, type ByteSource} from '../core/source.js';
import {workerSourceOf} from '../core/worker-source.js';
import {isAsf} from '../formats/asf/header.js';
import {playBrowserMediaWithActivation} from './browser-media-activation.js';
import {BrowserStreamMoviePlayer} from './browser-stream-player.js';
import {YuvRenderer} from './renderer.js';

/** A movie played over the whole game window by the operating system's media stack
 * (for example a DirectShow graph rendering a loose file), outside the engine renderer. */
export interface FullscreenMovieRequest {
  /** Loose file path as the engine passes it to the media stack. */
  readonly path: string;
  /** Output level in hundredths of a decibel (0 is full volume, -10000 is silence). */
  readonly attenuation: number;
  /** Engine-specific video renderer selector; hosts without a choice ignore it. */
  readonly renderer: number;
}

/** Device owner for fullscreen movies. The host decides how a movie the platform cannot
 * render is handled (play it, notify the user and complete, or wire to the OS); engines
 * only see whether playback started and whether it is still running. */
export interface FullscreenMoviePlayer {
  /** Opens and starts the movie. False is an open or render failure (missing file),
   * which the engine reports natively. */
  play(request: FullscreenMovieRequest): Promise<boolean>;
  /** Started and neither completed nor closed. */
  readonly playing: boolean;
  /** Stops and releases the movie; nothing happens when none is open. */
  close(): void;
}

export interface BrowserFullscreenMovieOptions {
  readonly document: Document;
  /** Element the video covers while it plays. */
  readonly container: HTMLElement;
  /** Loose file; null when the file does not exist. */
  open(path: string): Promise<ByteSource | null>;
  /** The browser cannot decode or play the movie: playback completes immediately. */
  unsupported(path: string, reason: string): void;
}

/** An error's message followed by its causes, so worker decode failures name their reason. */
function describe(error: unknown): string {
  let text = String(error);
  for (
    let cause = (error as {cause?: unknown})?.cause, depth = 0;
    cause !== undefined && depth < 4;
    depth++
  ) {
    text += `: ${cause instanceof Error ? cause.message : String(cause)}`;
    cause = (cause as {cause?: unknown})?.cause;
  }
  return text;
}

/** ASF movies (WMV3 with WMA, WMA Pro or WMA Lossless audio) are decoded in a worker by the
 * shared Windows Media decoder and drawn to a canvas over the container on the audio clock.
 * Other containers play through an HTMLVideoElement. A movie that cannot be decoded or played
 * is reported through `unsupported` and completes, so the engine continues as after the
 * movie's end. */
export class BrowserFullscreenMoviePlayer implements FullscreenMoviePlayer {
  private video: HTMLVideoElement | null = null;
  private stream: {
    player: BrowserStreamMoviePlayer;
    canvas: HTMLCanvasElement;
    renderer: YuvRenderer | null;
    timer: ReturnType<typeof setInterval>;
    frames: number;
  } | null = null;
  private url = '';
  private abort: AbortController | null = null;
  private generation = 0;
  constructor(private readonly options: BrowserFullscreenMovieOptions) {}
  get playing(): boolean {
    return this.video !== null || this.stream !== null;
  }
  /** Diagnostic: position and duration in seconds, pictures drawn and decoder counters of a
   * software movie. */
  get progress(): {
    position: number;
    duration: number;
    frames: number;
    decoding: BrowserStreamMoviePlayer['decoding'];
  } | null {
    const stream = this.stream;
    return stream
      ? {
          position: stream.player.position,
          duration: stream.player.info.duration,
          frames: stream.frames,
          decoding: stream.player.decoding,
        }
      : null;
  }
  async play(request: FullscreenMovieRequest): Promise<boolean> {
    this.close();
    const generation = ++this.generation;
    const source = await this.options.open(request.path);
    if (generation !== this.generation) return true;
    if (!source) return false;
    const signature = await source.read(0, Math.min(16, source.size));
    if (generation !== this.generation) return true;
    const abort = (this.abort = new AbortController());
    if (isAsf(signature)) {
      try {
        const player = await BrowserStreamMoviePlayer.open(
          await workerSourceOf(source),
          this.options.document,
          abort.signal,
        );
        if (generation !== this.generation) {
          void player.closeAndJoin();
          return true;
        }
        this.software(request, player);
      } catch (error) {
        if (generation === this.generation && !abort.signal.aborted)
          this.options.unsupported(request.path, describe(error));
      }
      return true;
    }
    const blob = sourceBlob(source) ?? new Blob([(await source.read(0, source.size)).slice()]);
    if (generation !== this.generation) return true;
    const {document, container} = this.options;
    const video = document.createElement('video');
    this.url = URL.createObjectURL(blob);
    video.src = this.url;
    video.volume = gain(request.attenuation);
    video.playsInline = true;
    Object.assign(video.style, cover);
    const finish = () => {
      if (this.video === video) this.close();
    };
    video.addEventListener('ended', finish);
    video.addEventListener('error', () => {
      if (this.video !== video) return;
      this.options.unsupported(request.path, video.error?.message || 'decode error');
      finish();
    });
    container.append(video);
    this.video = video;
    playBrowserMediaWithActivation(video, {document, signal: abort.signal}).catch(
      (error: unknown) => {
        if (this.video !== video) return;
        this.options.unsupported(request.path, describe(error));
        finish();
      },
    );
    return true;
  }
  private software(request: FullscreenMovieRequest, player: BrowserStreamMoviePlayer): void {
    const {document, container} = this.options;
    const canvas = document.createElement('canvas');
    canvas.width = player.info.width;
    canvas.height = player.info.height;
    Object.assign(canvas.style, cover);
    container.append(canvas);
    const stream = {
      player,
      canvas,
      renderer: null as YuvRenderer | null,
      timer: setInterval(() => {
        if (this.stream !== stream) return;
        try {
          if (player.position >= player.info.duration) this.close();
        } catch (error) {
          this.options.unsupported(request.path, describe(error));
          this.close();
        }
      }, 16),
      frames: 0,
    };
    this.stream = stream;
    player.volume(gain(request.attenuation));
    player.start((frame) => {
      if (this.stream !== stream) return;
      stream.renderer ??= new YuvRenderer(canvas);
      stream.renderer.draw(frame);
      stream.frames++;
    });
  }
  close(): void {
    this.generation++;
    const video = this.video,
      stream = this.stream;
    this.video = null;
    this.stream = null;
    this.abort?.abort();
    this.abort = null;
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
      video.remove();
    }
    if (stream) {
      clearInterval(stream.timer);
      void stream.player.closeAndJoin();
      stream.renderer?.dispose();
      stream.canvas.remove();
    }
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = '';
  }
}

/** Hundredths of a decibel (0 full, -10000 silence) to linear gain. */
const gain = (attenuation: number) => Math.min(1, 10 ** (attenuation / 2000));
const cover = {
  position: 'absolute',
  inset: '0',
  width: '100%',
  height: '100%',
  objectFit: 'contain',
  background: '#000',
};

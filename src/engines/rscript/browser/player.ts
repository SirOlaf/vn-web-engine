import {BrowserAudioContextHost} from '../../../audio/browser-audio-context-host.js';
import {HttpSource, sourceBlob, type ByteSource} from '../../../core/source.js';
import type {WorkerSource} from '../../../core/worker-source.js';
import type {YuvFrame} from '../../../video/frame.js';
import {StreamMovieVoice} from '../../../video/stream-voice.js';
import {YuvRenderer} from '../../../video/renderer.js';
import type {RScriptApini} from '../apini.js';
import type {RScriptFiles} from '../files.js';
import {RScriptGame, type RScriptSaveStorage} from '../runtime/game.js';
import {CanvasGlyphRasterizer, CanvasPresenter, rscriptFontFamilies} from './canvas.js';

export interface RScriptBrowserPlayerOptions {
  readonly files: RScriptFiles;
  readonly apini: RScriptApini;
  readonly saves: RScriptSaveStorage;
  readonly document: Document;
  diagnostic(message: string): void;
  /** The game closed (`error` unset) or stopped with an error. */
  exit(error?: unknown): void;
}

async function workerSource(source: ByteSource): Promise<WorkerSource> {
  const blob = sourceBlob(source);
  if (blob) return {kind: 'blob', blob};
  if (source instanceof HttpSource)
    return {kind: 'http', url: source.url, size: source.size, offset: 0, length: source.size};
  const bytes = await source.read(0, source.size);
  return {kind: 'blob', blob: new Blob([bytes.slice().buffer])};
}

/**
 * Browser panel for an RScript game: the game canvas, a movie layer above it, pointer and
 * keyboard input mapped to native coordinates, and Web Audio output.
 */
export class RScriptBrowserPlayer {
  readonly panel: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly movieCanvas: HTMLCanvasElement;
  private readonly audio = new AudioContext();
  private readonly audioHost: BrowserAudioContextHost;
  private readonly game: RScriptGame;
  private movieRenderer: YuvRenderer | null = null;
  private skipMovie: (() => void) | null = null;
  private readonly abort = new AbortController();
  private started = false;

  constructor(private readonly options: RScriptBrowserPlayerOptions) {
    const {document, apini} = options;
    this.panel = document.createElement('section');
    this.panel.className = 'live-player';
    this.panel.style.position = 'relative';
    this.canvas = document.createElement('canvas');
    this.canvas.width = apini.width;
    this.canvas.height = apini.height;
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('aria-label', `${apini.title} game screen`);
    this.canvas.style.cssText = 'touch-action:none;user-select:none;-webkit-touch-callout:none';
    this.movieCanvas = document.createElement('canvas');
    this.movieCanvas.setAttribute('aria-label', 'Movie');
    // Player styles display every canvas; the movie layer is shown only while it plays.
    this.movieCanvas.style.cssText = 'display:none;pointer-events:none';
    this.panel.append(this.canvas, this.movieCanvas);
    this.audioHost = new BrowserAudioContextHost(this.audio, document);
    this.game = new RScriptGame({
      files: options.files,
      apini,
      presenter: new CanvasPresenter(this.canvas),
      timer: {
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        now: () => performance.now(),
      },
      rasterizer: new CanvasGlyphRasterizer(rscriptFontFamilies(apini.fontName), document),
      audio: this.audio,
      saves: options.saves,
      playMovie: (path) => this.playMovie(path),
      diagnostic: options.diagnostic,
      exit: (error) => options.exit(error),
    });
    this.bindInput();
  }

  /** Call from the Play button handler so audio starts inside the user gesture. */
  start(): void {
    if (this.started) return;
    this.started = true;
    void this.audioHost.resume().catch(() => {});
    this.canvas.focus({preventScroll: true});
    void this.game.start().catch((error: unknown) => this.options.exit(error));
  }

  private point(event: MouseEvent): {x: number; y: number} {
    const rect = this.canvas.getBoundingClientRect();
    const scale = Math.min(rect.width / this.canvas.width, rect.height / this.canvas.height) || 1;
    const left = rect.left + (rect.width - this.canvas.width * scale) / 2,
      top = rect.top + (rect.height - this.canvas.height * scale) / 2;
    return {
      x: Math.floor((event.clientX - left) / scale),
      y: Math.floor((event.clientY - top) / scale),
    };
  }

  private bindInput(): void {
    const signal = this.abort.signal;
    const canvas = this.canvas;
    canvas.addEventListener(
      'pointermove',
      (event) => {
        const {x, y} = this.point(event);
        this.game.pointerMove(x, y);
      },
      {signal},
    );
    canvas.addEventListener(
      'pointerdown',
      (event) => {
        if (event.button !== 0) return;
        canvas.focus({preventScroll: true});
        const {x, y} = this.point(event);
        this.game.pointerDown(x, y);
      },
      {signal},
    );
    canvas.addEventListener(
      'pointerup',
      (event) => {
        if (event.button !== 0) return;
        if (this.skipMovie) return this.skipMovie();
        const {x, y} = this.point(event);
        this.game.pointerUp(x, y);
      },
      {signal},
    );
    canvas.addEventListener('contextmenu', (event) => event.preventDefault(), {signal});
    canvas.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Control') this.game.setSkip(true);
        else if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          if (this.skipMovie) this.skipMovie();
          else if (!event.repeat) this.game.keyClick();
        }
      },
      {signal},
    );
    canvas.addEventListener(
      'keyup',
      (event) => {
        if (event.key === 'Control') this.game.setSkip(false);
      },
      {signal},
    );
    canvas.addEventListener('blur', () => this.game.setSkip(false), {signal});
  }

  /**
   * Plays a movie above the game screen until it ends or a click skips it. Movie audio
   * shares the game's audio context, which the Play button already activated.
   */
  private async playMovie(path: string): Promise<void> {
    const source = await this.options.files.open(path);
    if (!source) {
      this.options.diagnostic(`Missing movie ${path}`);
      return;
    }
    const voice = new StreamMovieVoice(this.audio, await workerSource(source));
    try {
      voice.pause(false);
      await new Promise<void>((resolve, reject) => {
        let shown: YuvFrame | undefined;
        const finish = (): void => {
          clearInterval(timer);
          this.skipMovie = null;
          resolve();
        };
        const timer = setInterval(() => {
          try {
            if (this.abort.signal.aborted) return finish();
            const snapshot = voice.snapshot();
            const info = voice.metadata;
            if (info && snapshot.frame && snapshot.frame !== shown) {
              shown = snapshot.frame;
              if (
                this.movieCanvas.width !== info.width ||
                this.movieCanvas.height !== info.height
              ) {
                this.movieCanvas.width = info.width;
                this.movieCanvas.height = info.height;
              }
              this.movieRenderer ??= new YuvRenderer(this.movieCanvas);
              this.movieRenderer.draw(snapshot.frame);
              this.movieCanvas.style.display = '';
            }
            if (snapshot.status === 6) finish();
          } catch (error) {
            clearInterval(timer);
            this.skipMovie = null;
            reject(error);
          }
        }, 16);
        this.skipMovie = finish;
      });
    } catch (error) {
      this.options.diagnostic(`Movie ${path}: ${error instanceof Error ? error.message : error}`);
    } finally {
      voice.dispose();
      this.movieCanvas.style.display = 'none';
    }
  }

  dispose(): void {
    this.abort.abort();
    this.skipMovie?.();
    this.game.dispose();
    this.movieRenderer?.dispose();
    this.audioHost.dispose();
    void this.audio.close().catch(() => {});
  }
}

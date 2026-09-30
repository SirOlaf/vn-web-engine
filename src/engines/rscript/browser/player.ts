import {BrowserAudioContextHost} from '../../../audio/browser-audio-context-host.js';
import {HttpSource, sourceBlob, type ByteSource} from '../../../core/source.js';
import type {WorkerSource} from '../../../core/worker-source.js';
import type {YuvFrame} from '../../../video/frame.js';
import {StreamMovieVoice} from '../../../video/stream-voice.js';
import {YuvRenderer} from '../../../video/renderer.js';
import type {RScriptApini} from '../apini.js';
import type {RScriptFiles} from '../files.js';
import {RScriptGame, type RScriptSaveStorage} from '../runtime/game.js';
import {CanvasGlyphRasterizer, CanvasPresenter} from './canvas.js';
import {RScriptDomText} from './dom-text.js';
import {listRScriptFonts} from './fonts.js';

export interface RScriptBrowserPlayerOptions {
  readonly files: RScriptFiles;
  readonly apini: RScriptApini;
  readonly saves: RScriptSaveStorage;
  readonly document: Document;
  diagnostic(message: string): void;
  /** The game closed (`error` unset) or stopped with an error. */
  exit(error?: unknown): void;
}

/**
 * Every RScript music track is 44.1 kHz. At that context rate, streamed chunks join on exact
 * samples and the browser resamples the mixed output once instead of each buffer.
 */
function createAudioContext(): AudioContext {
  try {
    return new AudioContext({sampleRate: 44100});
  } catch {
    return new AudioContext();
  }
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
  private readonly audio = createAudioContext();
  private readonly audioHost: BrowserAudioContextHost;
  private readonly game: RScriptGame;
  private readonly domText: RScriptDomText;
  private textMode: 'native' | 'dom' = 'native';
  /** The left button went down on the canvas, so its release belongs to the game. */
  private pressedOnCanvas = false;
  private movieRenderer: YuvRenderer | null = null;
  private skipMovie: (() => void) | null = null;
  private readonly abort = new AbortController();
  private started = false;

  constructor(private readonly options: RScriptBrowserPlayerOptions) {
    const {document, apini} = options;
    this.panel = document.createElement('section');
    this.panel.className = 'live-player';
    this.panel.style.position = 'relative';
    // Focusable, so keys keep reaching the game after a click selects DOM text.
    this.panel.tabIndex = -1;
    this.panel.style.outline = 'none';
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
    const rasterizer = new CanvasGlyphRasterizer(document);
    this.domText = new RScriptDomText({
      document,
      parent: this.panel,
      canvas: this.canvas,
      width: apini.width,
      height: apini.height,
      families: (face) => rasterizer.families(face),
      hideText: (hidden) => {
        this.game.display.screen.hideText(hidden);
        this.game.display.update();
      },
      wheel: (up) => this.game.wheel(up),
      cancel: () => this.game.cancel(),
    });
    const canvasPresenter = new CanvasPresenter(this.canvas);
    this.game = new RScriptGame({
      files: options.files,
      apini,
      presenter: {
        present: (frame, rect, offsetX, offsetY) => {
          canvasPresenter.present(frame, rect, offsetX, offsetY);
          this.domText.schedule();
        },
        fill: (colorref) => canvasPresenter.fill(colorref),
      },
      timer: {
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        now: () => performance.now(),
      },
      rasterizer,
      audio: this.audio,
      saves: options.saves,
      playMovie: (path) => this.playMovie(path),
      stopMovie: () => this.skipMovie?.(),
      confirm: (caption, text) => this.confirm(caption, text),
      listFonts: () => listRScriptFonts(document),
      setFullscreen: (fullscreen) => this.setFullscreen(fullscreen),
      setCursorVisible: (visible) => {
        this.canvas.style.cursor = visible ? '' : 'none';
      },
      diagnostic: options.diagnostic,
      exit: (error) => options.exit(error),
    });
    this.bindInput();
  }

  /**
   * `dom` adds selectable text over the game text for copying and dictionary extensions;
   * the canvas keeps drawing the native glyphs either way.
   */
  setTextMode(mode: 'native' | 'dom'): void {
    this.textMode = mode;
    this.domText.setEnabled(mode === 'dom', this.game.display.screen);
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
        this.pressedOnCanvas = true;
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
        // A drag that selected DOM text ending over the canvas is not a click.
        const pressed = this.pressedOnCanvas;
        this.pressedOnCanvas = false;
        if (this.skipMovie) return this.skipMovie();
        if (!pressed) return;
        const {x, y} = this.point(event);
        this.game.pointerUp(x, y);
      },
      {signal},
    );
    canvas.addEventListener(
      'contextmenu',
      (event) => {
        event.preventDefault();
        if (!this.skipMovie) this.game.cancel();
      },
      {signal},
    );
    canvas.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        if (event.deltaY) this.game.wheel(event.deltaY < 0);
      },
      {signal, passive: false},
    );
    const keys: Partial<Record<string, 'tab' | 'shift' | 'up' | 'down'>> = {
      Tab: 'tab',
      Shift: 'shift',
      ArrowUp: 'up',
      ArrowDown: 'down',
    };
    // Keys reach the game from the canvas or the DOM text, not from dialogs in the panel.
    const forGame = (event: KeyboardEvent): boolean =>
      event.target === canvas ||
      event.target === this.panel ||
      this.domText.element.contains(event.target as Node);
    this.panel.addEventListener(
      'keydown',
      (event) => {
        if (!forGame(event)) return;
        const key = keys[event.key];
        // With DOM text, Shift is left to dictionary extensions (Yomichan scans with it)
        // and Control to copying a selection.
        if (this.textMode === 'dom' && event.key === 'Shift') return;
        if (event.key === 'Control') {
          if (!this.domText.selected) this.game.setSkip(true);
        } else if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          if (this.skipMovie) this.skipMovie();
          else if (!event.repeat) this.game.keyClick();
        } else if (event.key === 'Escape') {
          if (this.skipMovie) this.skipMovie();
          else if (!event.repeat) this.game.cancel();
        } else if (key) {
          event.preventDefault();
          // Tab and Shift act once per press, like the native key-repeat check.
          if (!event.repeat || key === 'up' || key === 'down') this.game.key(key);
        }
      },
      {signal},
    );
    this.panel.addEventListener(
      'keyup',
      (event) => {
        if (event.key === 'Control') this.game.setSkip(false);
      },
      {signal},
    );
    this.panel.addEventListener(
      'focusout',
      (event) => {
        if (!this.panel.contains(event.relatedTarget as Node | null)) this.game.setSkip(false);
      },
      {signal},
    );
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

  /** The configuration's screen mode; the click that chose it allows the request. */
  private setFullscreen(fullscreen: boolean): void {
    const document = this.options.document;
    const request = fullscreen
      ? document.fullscreenElement
        ? null
        : this.panel.requestFullscreen?.()
      : document.fullscreenElement
        ? document.exitFullscreen()
        : null;
    void request?.catch((error: unknown) =>
      this.options.diagnostic(`Fullscreen: ${error instanceof Error ? error.message : error}`),
    );
  }

  /** OK/Cancel confirmation over the game, standing in for the native MessageBox. */
  private confirm(caption: string, text: string): Promise<boolean> {
    const document = this.options.document;
    const dialog = document.createElement('dialog');
    dialog.setAttribute('aria-label', caption);
    dialog.style.cssText =
      'max-width:min(90%,28rem);padding:1.25rem 1.5rem;border:1px solid #39414c;border-radius:8px;background:#171c24;color:#e8ecf2';
    const heading = document.createElement('h2');
    heading.textContent = caption;
    heading.style.cssText = 'margin:0 0 .75rem;font-size:1rem';
    const message = document.createElement('p');
    // pre-line keeps the native CR LF line breaks.
    message.textContent = text;
    message.style.cssText = 'margin:0 0 1rem;white-space:pre-line';
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:.5rem;justify-content:flex-end';
    const button = (label: string): HTMLButtonElement => {
      const element = document.createElement('button');
      element.type = 'button';
      element.textContent = label;
      return element;
    };
    const ok = button('OK'),
      cancel = button('Cancel');
    actions.append(ok, cancel);
    dialog.append(heading, message, actions);
    this.panel.append(dialog);
    return new Promise((resolve) => {
      const finish = (confirmed: boolean): void => {
        dialog.close();
        dialog.remove();
        this.canvas.focus({preventScroll: true});
        resolve(confirmed);
      };
      ok.addEventListener('click', () => finish(true), {once: true});
      cancel.addEventListener('click', () => finish(false), {once: true});
      // Escape cancels, like closing the native message box.
      dialog.addEventListener(
        'cancel',
        (event) => {
          event.preventDefault();
          finish(false);
        },
        {once: true},
      );
      dialog.showModal();
      ok.focus();
    });
  }

  dispose(): void {
    this.abort.abort();
    this.domText.dispose();
    this.skipMovie?.();
    this.game.dispose();
    this.movieRenderer?.dispose();
    this.audioHost.dispose();
    void this.audio.close().catch(() => {});
  }
}

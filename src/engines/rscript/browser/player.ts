import {BrowserAudioContextHost} from '../../../audio/browser-audio-context-host.js';
import {objectFitPlacement} from '../../../graphics/object-fit.js';
import {
  TouchMouse,
  type TouchMouseFrame,
  type TouchMousePoint,
} from '../../../input/touch-mouse.js';
import {watchBrowserWindowActivation} from '../../../platform/browser-window-activation.js';
import {BrowserWindowsMessageBoxHost} from '../../../platform/windows-message-box.js';
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
import {listRScriptFonts} from './font-catalog.js';

export interface RScriptBrowserPlayerOptions {
  readonly files: RScriptFiles;
  readonly apini: RScriptApini;
  readonly saves: RScriptSaveStorage;
  readonly document: Document;
  /**
   * The configuration's window or fullscreen choice (sub_452990). The page's display host
   * decides what it does; without one the choice has no effect.
   */
  setFullscreen?(fullscreen: boolean): void;
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
  /**
   * Touch acts as the mouse through the shared gestures: a tap clicks, a moved finger drags,
   * and holding still or a second finger is the right button.
   */
  private readonly touch = new TouchMouse();
  private touchButtons = 0;
  /** Samples the gestures while a finger is down, so holding still becomes a right click. */
  private touchTimer: ReturnType<typeof setTimeout> | null = null;
  /** Browsers follow touches with compatibility events, such as a long-press contextmenu. */
  private lastTouch = -Infinity;
  private movieRenderer: YuvRenderer | null = null;
  private skipMovie: (() => void) | null = null;
  private readonly abort = new AbortController();
  private started = false;
  private unwatchActivation: (() => void) | null = null;

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
    const messageBox = new BrowserWindowsMessageBoxHost(this.panel, () =>
      this.canvas.focus({preventScroll: true}),
    );
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
      confirm: (caption, text) => messageBox.confirm(caption, text),
      listFonts: () => listRScriptFonts(document),
      setFullscreen: (fullscreen) => options.setFullscreen?.(fullscreen),
      // The shared audio host resumes the context again on activation.
      pauseAudio: (paused) =>
        void (paused ? this.audio.suspend() : this.audioHost.resume()).catch(() => {}),
      setCursorVisible: (visible) => {
        this.canvas.style.cursor = visible ? '' : 'none';
      },
      diagnostic: options.diagnostic,
      exit: (error) => options.exit(error),
    });
    this.bindInput();
    const view = document.defaultView;
    if (view)
      this.unwatchActivation = watchBrowserWindowActivation(view, (active) =>
        this.game.setActive(active),
      );
  }

  /** Re-reads the canvas placement; box resizes are observed, `object-fit` changes are not. */
  relayout(): void {
    this.domText.relayout();
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
    const {canvas} = this;
    const rect = canvas.getBoundingClientRect();
    const fit = objectFitPlacement(canvas, rect, canvas.width, canvas.height);
    const scaleX = fit.scaleX || 1,
      scaleY = fit.scaleY || 1;
    return {
      x: Math.floor((event.clientX - rect.left - fit.offsetX) / scaleX),
      y: Math.floor((event.clientY - rect.top - fit.offsetY) / scaleY),
    };
  }

  /** Left button down on the canvas. */
  private press(x: number, y: number): void {
    this.pressedOnCanvas = true;
    this.canvas.focus({preventScroll: true});
    this.game.pointerDown(x, y);
  }
  /** Left button up: skips a movie, or ends a press that began on the canvas. */
  private release(x: number, y: number): void {
    // A drag that selected DOM text ending over the canvas is not a click.
    const pressed = this.pressedOnCanvas;
    this.pressedOnCanvas = false;
    if (this.skipMovie) return this.skipMovie();
    if (pressed) this.game.pointerUp(x, y);
  }
  /** Right button (WM_RBUTTONDOWN). */
  private secondary(): void {
    if (!this.skipMovie) this.game.cancel();
  }

  /** Delivers the gesture frames the touch contacts produced as mouse input. */
  private drainTouch(): void {
    this.lastTouch = performance.now();
    let previous: TouchMouseFrame | null = null;
    // Sampling repeats the last frame once the queue is empty.
    for (let i = 0; i < 16; i++) {
      const frame = this.touch.sample();
      if (
        previous &&
        !frame.pressedButtons &&
        frame.buttons === previous.buttons &&
        frame.x === previous.x &&
        frame.y === previous.y
      )
        break;
      previous = frame;
      this.touchFrame(frame);
    }
    if (this.touch.active && !this.touchTimer)
      this.touchTimer = setTimeout(() => {
        this.touchTimer = null;
        this.drainTouch();
      }, 100);
  }
  private touchFrame(frame: TouchMouseFrame): void {
    const {x, y} = frame;
    const held = this.touchButtons;
    this.touchButtons = frame.buttons;
    this.game.pointerMove(x, y);
    if (frame.pressedButtons & 1) this.press(x, y);
    if (held & 1 && !(frame.buttons & 1)) this.release(x, y);
    if (frame.pressedButtons & 2) this.secondary();
  }

  private bindInput(): void {
    const signal = this.abort.signal;
    const canvas = this.canvas;
    const touchPoint = (event: PointerEvent): TouchMousePoint => {
      const {x, y} = this.point(event);
      return {x, y, inside: x >= 0 && y >= 0 && x < canvas.width && y < canvas.height};
    };
    const client = (event: PointerEvent) => ({x: event.clientX, y: event.clientY});
    canvas.addEventListener(
      'pointermove',
      (event) => {
        if (event.pointerType === 'touch') {
          this.touch.move(event.pointerId, touchPoint(event), client(event));
          return this.drainTouch();
        }
        const {x, y} = this.point(event);
        this.game.pointerMove(x, y);
      },
      {signal},
    );
    canvas.addEventListener(
      'pointerdown',
      (event) => {
        if (event.pointerType === 'touch') {
          const accepted = this.touch.down(
            event.pointerId,
            event.isPrimary,
            touchPoint(event),
            client(event),
          );
          if (!accepted) return;
          try {
            canvas.setPointerCapture(event.pointerId);
          } catch {
            // The browser no longer tracks this pointer; its release still arrives here.
          }
          event.preventDefault();
          return this.drainTouch();
        }
        if (event.button !== 0) return;
        const {x, y} = this.point(event);
        this.press(x, y);
      },
      {signal},
    );
    canvas.addEventListener(
      'pointerup',
      (event) => {
        if (event.pointerType === 'touch') {
          this.touch.up(event.pointerId, touchPoint(event), client(event));
          return this.drainTouch();
        }
        if (event.button !== 0) return;
        const {x, y} = this.point(event);
        this.release(x, y);
      },
      {signal},
    );
    const cancelTouch = (event: PointerEvent): void => {
      if (event.pointerType !== 'touch') return;
      this.touch.cancel(event.pointerId);
      this.drainTouch();
    };
    canvas.addEventListener('pointercancel', cancelTouch, {signal});
    canvas.addEventListener('lostpointercapture', cancelTouch, {signal});
    canvas.addEventListener(
      'contextmenu',
      (event) => {
        event.preventDefault();
        // The touch gestures already produced the right button for a long press.
        if (performance.now() - this.lastTouch < 1000) return;
        this.secondary();
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

  dispose(): void {
    if (this.touchTimer) clearTimeout(this.touchTimer);
    this.touch.clear();
    this.unwatchActivation?.();
    this.abort.abort();
    this.domText.dispose();
    this.skipMovie?.();
    this.game.dispose();
    this.movieRenderer?.dispose();
    this.audioHost.dispose();
    void this.audio.close().catch(() => {});
  }
}

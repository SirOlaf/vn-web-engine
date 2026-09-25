import {invalidateCanvasFrame} from '../../../../../graphics/canvas-frame-presenter.js';
import type {AokanaBpPointer} from '../bp/memory.js';
import type {AokanaBrowserMainWindow} from './browser-main-window.js';
import {
  AokanaFullscreenMovieState,
  type AokanaMfMovieDisplayControl,
} from './movie-fullscreen-state.js';
import {AokanaMfMovieDocuments} from './movie-mf-document.js';
import type {AokanaMfMovieVolumeController} from './movie-mf-volume-policy.js';
import {AokanaMfMovieVolumePolicy} from './movie-mf-volume-policy.js';

/** The retained browser video service behind MF's IMFVideoDisplayControl. */
class AokanaBrowserMfDisplayControl implements AokanaMfMovieDisplayControl {
  private readonly frame: HTMLCanvasElement | null;
  private readonly frameContext: CanvasRenderingContext2D | null;
  private readonly targetContext: CanvasRenderingContext2D | null;
  private destinationWidth: number;
  private destinationHeight: number;
  private frameReady = false;
  private closed = false;

  constructor(
    document: Document,
    private readonly video: HTMLVideoElement,
    private readonly window: AokanaBrowserMainWindow,
  ) {
    if (window.presentationMode === 'none') {
      this.frame = null;
      this.frameContext = null;
      this.targetContext = null;
      this.destinationWidth = window.surface.width;
      this.destinationHeight = window.surface.height;
      return;
    }
    this.frame = document.createElement('canvas');
    this.frame.width = video.videoWidth;
    this.frame.height = video.videoHeight;
    const frameContext = this.frame.getContext('2d');
    const targetContext = window.surface.getContext('2d');
    if (frameContext === null || targetContext === null)
      throw new Error('Aokana MF video display service cannot acquire its scoped canvas');
    this.frameContext = frameContext;
    this.targetContext = targetContext;
    this.destinationWidth = window.surface.width;
    this.destinationHeight = window.surface.height;
  }

  /** Called only from this controller's decoded video frame callback. */
  receiveFrame(): void {
    if (this.closed) return;
    if (this.frame === null || this.frameContext === null) return;
    this.frameContext.drawImage(this.video, 0, 0, this.frame.width, this.frame.height);
    this.frameReady = true;
    this.repaint();
  }

  repaint(): void {
    if (this.closed) throw new Error('Aokana MF display control was released');
    if (!this.frameReady || this.frame === null || this.targetContext === null) return;
    invalidateCanvasFrame(this.window.surface);
    this.targetContext.drawImage(
      this.frame,
      0,
      0,
      this.frame.width,
      this.frame.height,
      0,
      0,
      this.destinationWidth,
      this.destinationHeight,
    );
  }

  resize(width: number, height: number): void {
    if (this.closed) throw new Error('Aokana MF display control was released');
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 0 || height < 0)
      throw new RangeError('Aokana MF video destination rectangle is invalid');
    this.destinationWidth = width;
    this.destinationHeight = height;
    this.repaint();
  }

  close(): void {
    this.closed = true;
    this.frameReady = false;
    if (this.frame !== null) {
      this.frame.width = 0;
      this.frame.height = 0;
    }
  }
}

/** One browser media session; the object is the same global 274290 query/volume identity. */
export class AokanaBrowserMfController implements AokanaMfMovieVolumeController {
  nativeState84 = 0;
  nativeStateB8 = 0;
  clampedVolume = 0;
  private display: AokanaBrowserMfDisplayControl | null = null;
  private callback: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastFrameMediaTime = -1;
  private listeners: Array<readonly [string, EventListener]> = [];
  private closed = false;
  private url: string | null = null;
  private video: HTMLVideoElement | null = null;
  private finishedEarly = false;

  constructor(
    private readonly document: Document,
    private readonly window: AokanaBrowserMainWindow,
    private readonly fullscreen: AokanaFullscreenMovieState,
  ) {}

  applyVolume(rawVolume: number): number {
    if (this.closed) return -1;
    const clamped = Math.min(128, Math.max(0, rawVolume | 0));
    this.clampedVolume = clamped;
    try {
      if (this.video !== null) this.video.volume = clamped / 128;
      return 0;
    } catch {
      return -1;
    }
  }

  /** Source, topology, and retained display/audio services are acquired before +84=2. */
  async open(bytes: Uint8Array, signal: AbortSignal): Promise<void> {
    if (this.closed || this.video !== null)
      throw new Error('Aokana MF controller cannot open a second live source');
    const url = URL.createObjectURL(new Blob([bytes.slice().buffer]));
    const video = this.document.createElement('video');
    this.url = url;
    this.video = video;
    video.preload = 'auto';
    video.playsInline = true;
    if (this.window.presentationMode === 'none') video.muted = true;
    video.src = url;
    video.volume = this.clampedVolume / 128;
    try {
      await new Promise<void>((resolve, reject) => {
        const ready = (): void => {
          cleanup();
          resolve();
        };
        const failed = (): void => {
          cleanup();
          reject(new Error('Aokana MF browser media source failed to resolve'));
        };
        const aborted = (): void => {
          cleanup();
          reject(new DOMException('MF movie session was retired', 'AbortError'));
        };
        const cleanup = (): void => {
          video.removeEventListener('loadedmetadata', ready);
          video.removeEventListener('error', failed);
          signal.removeEventListener('abort', aborted);
        };
        video.addEventListener('loadedmetadata', ready);
        video.addEventListener('error', failed);
        signal.addEventListener('abort', aborted, {once: true});
        if (signal.aborted) return aborted();
        video.load();
      });
      if (signal.aborted || this.closed)
        throw new DOMException('MF movie session was retired', 'AbortError');
      if (this.finishedEarly) {
        this.nativeState84 = 0;
        this.nativeStateB8 = 0;
        return;
      }
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        const display = new AokanaBrowserMfDisplayControl(this.document, video, this.window);
        this.display = display;
        this.fullscreen.bindDisplayControl(this, display);
        this.startFrameDelivery(video, display);
      }
      const playing = (): void => {
        if (this.closed || this.finishedEarly) return;
        this.nativeState84 = 3;
        this.nativeStateB8 = 1;
      };
      const ended = (): void => {
        if (this.closed) return;
        this.nativeState84 = 0;
        this.nativeStateB8 = 0;
      };
      const failed = (): void => {
        if (this.closed) return;
        this.nativeState84 = 0;
        this.nativeStateB8 = 0;
      };
      for (const [name, listener] of [
        ['playing', playing],
        ['ended', ended],
        ['error', failed],
      ] as const) {
        video.addEventListener(name, listener);
        this.listeners.push([name, listener]);
      }
      this.nativeState84 = 2;
      void video.play().catch(failed);
    } catch (error) {
      this.releaseMedia();
      throw error;
    }
  }

  private startFrameDelivery(
    video: HTMLVideoElement,
    display: AokanaBrowserMfDisplayControl,
  ): void {
    const receive = (): void => {
      this.callback = null;
      this.timer = null;
      if (this.closed || this.finishedEarly) return;
      try {
        if (
          video.readyState >= 2 &&
          (typeof video.requestVideoFrameCallback === 'function' ||
            video.currentTime !== this.lastFrameMediaTime)
        ) {
          this.lastFrameMediaTime = video.currentTime;
          display.receiveFrame();
        }
      } catch {
        this.nativeState84 = 0;
        this.nativeStateB8 = 0;
        return;
      }
      if (typeof video.requestVideoFrameCallback === 'function')
        this.callback = video.requestVideoFrameCallback(receive);
      else this.timer = setTimeout(receive, 16);
    };
    if (typeof video.requestVideoFrameCallback === 'function')
      this.callback = video.requestVideoFrameCallback(receive);
    else this.timer = setTimeout(receive, 16);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.releaseMedia();
  }

  /** Host diagnostic skip completes this current controller without releasing its native owner. */
  finishEarly(): void {
    if (this.closed) return;
    this.finishedEarly = true;
    if (this.callback !== null) this.video?.cancelVideoFrameCallback(this.callback);
    if (this.timer !== null) clearTimeout(this.timer);
    this.callback = null;
    this.timer = null;
    this.video?.pause();
    this.nativeState84 = 0;
    this.nativeStateB8 = 0;
  }

  get finishedByHost(): boolean {
    return this.finishedEarly;
  }

  private releaseMedia(): void {
    this.nativeState84 = 0;
    this.nativeStateB8 = 0;
    const video = this.video;
    if (video !== null) {
      if (this.callback !== null) video.cancelVideoFrameCallback(this.callback);
      for (const [name, listener] of this.listeners) video.removeEventListener(name, listener);
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
    if (this.timer !== null) clearTimeout(this.timer);
    this.callback = null;
    this.timer = null;
    this.lastFrameMediaTime = -1;
    this.listeners = [];
    if (this.display !== null) {
      this.fullscreen.unbindDisplayControl(this, this.display);
      this.display.close();
      this.display = null;
    }
    if (this.url !== null) URL.revokeObjectURL(this.url);
    this.url = null;
    this.video = null;
  }
}

/** F0AF0/F03A0's one global MF session and archive-on-direct-failure policy. */
export class AokanaBrowserMfMovieSession {
  private current: AokanaBrowserMfController | null = null;
  private generation = 0;
  private resetting = false;
  private closed = false;
  private autoSkip = false;
  private readonly aborts = new Set<AbortController>();
  private readonly pending = new Set<Promise<number>>();

  /** Advance only the current movie; the script still observes and closes the retained session. */
  skipCurrent(): boolean {
    if (this.current === null || this.closed || this.resetting) return false;
    this.current.finishEarly();
    return true;
  }

  /** Explicit host diagnostic control; native F8 still completes through its normal poll. */
  setAutoSkip(enabled: boolean): void {
    this.autoSkip = enabled;
    if (enabled) this.skipCurrent();
  }

  constructor(
    readonly documents: AokanaMfMovieDocuments,
    readonly document: Document,
    readonly window: AokanaBrowserMainWindow,
    readonly fullscreen: AokanaFullscreenMovieState,
    readonly volume: AokanaMfMovieVolumePolicy,
  ) {
    if (volume.fullscreen !== fullscreen)
      throw new Error('Aokana MF session requires one fullscreen and volume owner');
  }

  async start(
    archive: AokanaBpPointer | null,
    name: AokanaBpPointer,
    rawVolume: number,
  ): Promise<number> {
    if (this.closed || this.resetting) throw new Error('Aokana MF source admission is closed');
    this.generation++;
    for (const pending of this.aborts) pending.abort();
    const generation = this.generation;
    const abort = new AbortController();
    this.aborts.add(abort);
    const work = this.startSelected(archive, name, rawVolume, generation, abort.signal);
    this.pending.add(work);
    try {
      return await work;
    } finally {
      this.pending.delete(work);
      this.aborts.delete(abort);
    }
  }

  private async startSelected(
    archive: AokanaBpPointer | null,
    name: AokanaBpPointer,
    rawVolume: number,
    generation: number,
    signal: AbortSignal,
  ): Promise<number> {
    this.releaseCurrent();
    const controller = new AokanaBrowserMfController(this.document, this.window, this.fullscreen);
    this.current = controller;
    this.fullscreen.controller = controller;
    this.volume.bindBorrowedController(controller);
    this.volume.initializeForNewController(rawVolume);
    if (this.autoSkip) controller.finishEarly();
    const live = (): boolean =>
      !this.closed &&
      !this.resetting &&
      this.generation === generation &&
      !signal.aborted &&
      this.current === controller;
    let started = false;
    try {
      const direct = await this.documents.direct(name);
      if (!live()) return 0x80000001;
      if (direct !== null) {
        try {
          const source = await this.documents.read(direct, signal);
          if (!live()) return 0x80000001;
          await controller.open(source.bytes, signal);
          if (!live()) return 0x80000001;
          started = true;
          return 0;
        } catch {
          if (!live()) return 0x80000001;
        }
      }
      if (archive === null) return direct === null ? 0x80000003 : 0x80000001;
      const archived = await this.documents.archive(archive, name);
      if (!live()) return 0x80000001;
      if (archived === null) return 0x80000003;
      try {
        const source = await this.documents.read(archived, signal);
        if (!live()) return 0x80000001;
        await controller.open(source.bytes, signal);
        if (!live()) return 0x80000001;
        started = true;
        return 0;
      } catch {
        return 0x80000004;
      }
    } catch {
      return 0x80000001;
    } finally {
      if (
        this.current === controller &&
        (!started || (controller.nativeState84 === 0 && !controller.finishedByHost))
      )
        this.releaseCurrent();
    }
  }

  /** F03A0: explicit release; F9 maps absent to -2. */
  release(): number {
    this.generation++;
    for (const pending of this.aborts) pending.abort();
    return this.releaseCurrent();
  }

  private releaseCurrent(): number {
    const controller = this.current;
    if (controller === null) return 0x80000002;
    controller.close();
    this.volume.unbindBorrowedController(controller);
    if (this.fullscreen.controller !== controller)
      throw new Error('Aokana MF controller owner mismatch');
    this.fullscreen.controller = null;
    this.current = null;
    return 0;
  }

  /** Exposes the current native phase only to the retained F8 wait process. */
  pollStatus(): number {
    return this.current === null ? 0x80000002 : this.current.nativeState84 === 2 ? 0 : 2;
  }

  async beginReset(): Promise<() => void> {
    if (this.closed || this.resetting) throw new Error('Aokana MF reset admission is unavailable');
    this.resetting = true;
    this.generation++;
    for (const abort of this.aborts) abort.abort();
    await Promise.allSettled([...this.pending]);
    this.releaseCurrent();
    let restored = false;
    return () => {
      if (restored) return;
      restored = true;
      if (!this.closed) this.resetting = false;
    };
  }

  async closeAndJoin(): Promise<void> {
    this.closed = true;
    this.generation++;
    for (const abort of this.aborts) abort.abort();
    await Promise.allSettled([...this.pending]);
    this.releaseCurrent();
  }
}

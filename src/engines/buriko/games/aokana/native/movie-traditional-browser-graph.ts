import type {AokanaBpPointer} from '../bp/memory.js';
import {AokanaBitmapStorage} from './bitmap.js';
import type {AokanaDisplayDevice} from './display-device.js';
import type {AokanaFullscreenMovieState} from './movie-fullscreen-state.js';
import {AokanaMfMovieDocuments} from './movie-mf-document.js';
import {
  AokanaMovieImage,
  type AokanaMovieImageConfiguration,
  type AokanaMovieMediaType,
} from './movie-image.js';
import type {AokanaProgramResources} from './program-resources.js';
import {textBytes} from './text.js';
import type {AokanaTraditionalMovieGraphAudio} from './movie-traditional-audio-policy.js';
import {AokanaTraditionalMovieAudioPolicy} from './movie-traditional-audio-policy.js';
import {AokanaTraditionalMovieRenderer} from './movie-traditional-renderer.js';

const browserRgb32 = (width: number, height: number): AokanaMovieMediaType => {
  const format = new Uint8Array(60);
  const view = new DataView(format.buffer);
  view.setInt32(52, width, true);
  view.setInt32(56, height, true);
  return {
    majorType: '73646976-0000-0010-8000-00aa00389b71',
    subtype: 'e436eb7e-524f-11ce-9f53-0020af0ba770',
    formatType: '05589f80-c356-11ce-bf01-00aa0055595a',
    format,
  };
};

/** Connected browser decoder → native DCTraditionalVR → selected display device. */
class AokanaBrowserTraditionalGraph implements AokanaTraditionalMovieGraphAudio {
  private readonly frame: HTMLCanvasElement;
  private readonly frameContext: CanvasRenderingContext2D;
  private callback: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastMediaTime = -1;
  private readonly deliveries = new Set<Promise<number>>();
  private deliveryTail: Promise<void> = Promise.resolve();
  private closed = false;
  private finishedEarly = false;

  constructor(
    readonly video: HTMLVideoElement,
    readonly url: string,
    readonly renderer: AokanaTraditionalMovieRenderer,
    document: Document,
  ) {
    this.frame = document.createElement('canvas');
    this.frame.width = video.videoWidth;
    this.frame.height = video.videoHeight;
    const context = this.frame.getContext('2d', {willReadFrequently: true});
    if (context === null) throw new Error('Aokana traditional movie cannot acquire frame pixels');
    this.frameContext = context;
  }

  get currentTime(): number {
    return this.finishedEarly ? this.video.duration : this.video.currentTime;
  }

  get stopTime(): number {
    return this.video.duration;
  }

  putVolume(decibels: number): number {
    if (this.closed) return -1;
    try {
      this.video.volume = decibels <= -10000 ? 0 : 10 ** (decibels / 2000);
      return 0;
    } catch {
      return -1;
    }
  }

  start(): void {
    if (this.closed) throw new Error('Aokana traditional movie graph was closed');
    const receive = (): void => {
      this.callback = null;
      this.timer = null;
      if (this.closed || this.finishedEarly) return;
      try {
        if (
          this.video.readyState >= 2 &&
          (typeof this.video.requestVideoFrameCallback === 'function' ||
            this.video.currentTime !== this.lastMediaTime)
        ) {
          this.lastMediaTime = this.video.currentTime;
          const width = this.frame.width,
            height = this.frame.height;
          this.frameContext.drawImage(this.video, 0, 0, width, height);
          const rgba = this.frameContext.getImageData(0, 0, width, height).data;
          const bgra = new Uint8Array(width * height * 4);
          for (let i = 0; i < bgra.length; i += 4) {
            bgra[i] = rgba[i + 2]!;
            bgra[i + 1] = rgba[i + 1]!;
            bgra[i + 2] = rgba[i]!;
            bgra[i + 3] = 255;
          }
          const sample = {storage: new AokanaBitmapStorage(bgra, true), offset: 0};
          const delivery = this.deliveryTail.then(() =>
            this.closed || this.finishedEarly ? 0 : this.renderer.deliver(sample),
          );
          this.deliveryTail = delivery.then(
            () => {},
            () => {
              this.video.pause();
            },
          );
          this.deliveries.add(delivery);
          void delivery.then(
            () => this.deliveries.delete(delivery),
            () => this.deliveries.delete(delivery),
          );
        }
      } catch {
        this.video.pause();
        return;
      }
      if (typeof this.video.requestVideoFrameCallback === 'function')
        this.callback = this.video.requestVideoFrameCallback(receive);
      else this.timer = setTimeout(receive, 16);
    };
    if (typeof this.video.requestVideoFrameCallback === 'function')
      this.callback = this.video.requestVideoFrameCallback(receive);
    else this.timer = setTimeout(receive, 16);
    // F0680 ignores Run HRESULT after publishing the presentation flag.
    void this.video.play().catch(() => {});
  }

  /** Complete the native clock poll while retaining the graph for the script's stop opcode. */
  finishEarly(): void {
    if (this.closed || this.finishedEarly) return;
    this.finishedEarly = true;
    if (this.callback !== null) this.video.cancelVideoFrameCallback(this.callback);
    if (this.timer !== null) clearTimeout(this.timer);
    this.callback = null;
    this.timer = null;
    this.video.pause();
  }

  async closeAndJoin(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.callback !== null) this.video.cancelVideoFrameCallback(this.callback);
    if (this.timer !== null) clearTimeout(this.timer);
    this.callback = null;
    this.timer = null;
    this.video.pause();
    await Promise.allSettled([...this.deliveries]);
    this.video.removeAttribute('src');
    this.video.load();
    URL.revokeObjectURL(this.url);
    this.frame.width = 0;
    this.frame.height = 0;
  }
}

/** F0680/F08C0/F05A0's distinct traditional fullscreen graph owner. */
export class AokanaBrowserTraditionalMovieSession {
  private graph: AokanaBrowserTraditionalGraph | null = null;
  private generation = 0;
  private resetting = false;
  private closed = false;
  private autoSkip = false;
  private readonly aborts = new Set<AbortController>();
  private readonly pending = new Set<Promise<number | null>>();

  constructor(
    readonly resources: AokanaProgramResources,
    readonly documents: AokanaMfMovieDocuments,
    readonly document: Document,
    readonly device: AokanaDisplayDevice,
    readonly imageConfiguration: AokanaMovieImageConfiguration,
    readonly fullscreen: AokanaFullscreenMovieState,
    readonly audio: AokanaTraditionalMovieAudioPolicy,
  ) {
    if (documents.files !== resources.files || documents.candidates.resources !== resources)
      throw new Error('Aokana traditional movie needs the selected source/file identities');
  }

  /** Advance the current presentation without releasing native graph ownership. */
  skipCurrent(): boolean {
    if (this.graph === null || this.closed || this.resetting) return false;
    this.graph.finishEarly();
    return true;
  }

  setAutoSkip(enabled: boolean): void {
    this.autoSkip = enabled;
    if (enabled) this.skipCurrent();
  }

  async start(archive: AokanaBpPointer | null, name: AokanaBpPointer): Promise<number | null> {
    if (this.closed || this.resetting)
      throw new Error('Aokana traditional movie source admission is closed');
    const ownedArchive =
      archive === null ? null : {bytes: textBytes(archive, true).slice(), offset: 0};
    const ownedName = {bytes: textBytes(name, true).slice(), offset: 0};
    this.generation++;
    for (const pending of this.aborts) pending.abort();
    const generation = this.generation;
    const abort = new AbortController();
    this.aborts.add(abort);
    const work = this.startSelected(ownedArchive, ownedName, generation, abort.signal);
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
    generation: number,
    signal: AbortSignal,
  ): Promise<number | null> {
    await this.releaseGraph();
    const live = (): boolean =>
      !this.closed && !this.resetting && this.generation === generation && !signal.aborted;
    const files = this.resources.files,
      root = this.resources.configuration.nativeFileRoot,
      decoded = files.text.decodeAuto(name);
    let direct: Uint8Array | null = null;
    const qualified = root + decoded;
    if (qualified.length >= 784)
      throw new RangeError('Aokana traditional movie direct path exceeds native scratch');
    if (await files.hasPathWide(qualified)) direct = files.text.encodeWide(qualified, 1);
    else direct = await this.resources.findRelativeFile(root, name);
    if (!live()) return null;
    if (direct !== null) {
      try {
        const source = await this.documents.read({kind: 'direct', path: direct}, signal);
        if (!live()) return null;
        const graph = await this.open(source.bytes, signal);
        if (!live()) {
          await graph.closeAndJoin();
          return null;
        }
        try {
          return this.publish(graph);
        } catch (error) {
          if (this.graph === graph) await this.releaseGraph();
          else await graph.closeAndJoin();
          throw error;
        }
      } catch {
        if (!live()) return null;
      }
    }
    if (archive === null) return null;
    const located = await this.documents.archive(archive, name);
    if (located === null || !live()) return null;
    try {
      const source = await this.documents.read(located, signal);
      if (!live()) return null;
      const graph = await this.open(source.bytes, signal);
      if (!live()) {
        await graph.closeAndJoin();
        return null;
      }
      try {
        return this.publish(graph);
      } catch (error) {
        if (this.graph === graph) await this.releaseGraph();
        else await graph.closeAndJoin();
        throw error;
      }
    } catch {
      return null;
    }
  }

  private async open(
    bytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<AokanaBrowserTraditionalGraph> {
    const url = URL.createObjectURL(new Blob([bytes.slice().buffer]));
    const video = this.document.createElement('video');
    video.preload = 'auto';
    video.playsInline = true;
    if (this.device.presentationMode === 'none') video.muted = true;
    video.src = url;
    try {
      await new Promise<void>((resolve, reject) => {
        const ready = (): void => {
          cleanup();
          resolve();
        };
        const failed = (): void => {
          cleanup();
          reject(new Error('Aokana traditional movie media source cannot render'));
        };
        const aborted = (): void => {
          cleanup();
          reject(new DOMException('Traditional movie source was retired', 'AbortError'));
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
      if (signal.aborted)
        throw new DOMException('Traditional movie source was retired', 'AbortError');
      if (
        video.videoWidth < 1 ||
        video.videoHeight < 1 ||
        !Number.isFinite(video.duration) ||
        video.duration < 0
      )
        throw new Error('Aokana traditional movie lacks a finite video presentation');
      const image = new AokanaMovieImage(this.imageConfiguration),
        renderer = new AokanaTraditionalMovieRenderer(this.device, image),
        checked = browserRgb32(video.videoWidth, video.videoHeight),
        connected = browserRgb32(video.videoWidth, -video.videoHeight);
      if (renderer.checkMediaType(checked) !== 0 || renderer.setMediaType(connected) !== 0)
        throw new Error('Aokana traditional movie video media type was rejected');
      return new AokanaBrowserTraditionalGraph(video, url, renderer, this.document);
    } catch (error) {
      video.pause();
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
      throw error;
    }
  }

  private publish(graph: AokanaBrowserTraditionalGraph): number {
    const duration = Math.trunc(graph.stopTime * 1000);
    if (!Number.isSafeInteger(duration) || duration < 0)
      throw new RangeError('Aokana traditional movie duration exceeds browser precision');
    this.graph = graph;
    this.audio.bindBorrowedGraphAudio(graph);
    graph.putVolume(this.audio.savedDecibels);
    this.fullscreen.presentationFlag = 1;
    graph.start();
    if (this.autoSkip) graph.finishEarly();
    return duration | 0;
  }

  isPlaying(): boolean {
    const graph = this.graph;
    return (
      this.fullscreen.presentationFlag !== 0 && graph !== null && graph.currentTime < graph.stopTime
    );
  }

  async stop(): Promise<number> {
    this.generation++;
    for (const pending of this.aborts) pending.abort();
    return this.releaseGraph();
  }

  private async releaseGraph(): Promise<number> {
    const graph = this.graph;
    if (graph === null) return 0;
    this.fullscreen.presentationFlag = 0;
    this.audio.unbindBorrowedGraphAudio(graph);
    this.graph = null;
    await graph.closeAndJoin();
    return 1;
  }

  async beginReset(): Promise<() => void> {
    if (this.closed || this.resetting)
      throw new Error('Aokana traditional movie reset admission is unavailable');
    this.resetting = true;
    this.generation++;
    for (const abort of this.aborts) abort.abort();
    await Promise.allSettled([...this.pending]);
    await this.releaseGraph();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (!this.closed) this.resetting = false;
    };
  }

  async closeAndJoin(): Promise<void> {
    this.closed = true;
    this.generation++;
    for (const abort of this.aborts) abort.abort();
    await Promise.allSettled([...this.pending]);
    await this.releaseGraph();
  }
}

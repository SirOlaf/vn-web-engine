import type {BurikoBpPointer} from '../bp/memory.js';
import {BurikoBitmapStorage} from './bitmap.js';
import {textBytes} from './text.js';
import {
  BurikoMovieImage,
  type BurikoMovieImageConfiguration,
  type BurikoMovieMediaType,
} from './movie-image.js';
import {BurikoMovieSourceDocument} from './movie-source-document.js';
import {BurikoMovieMediaGraph, BurikoMovieRenderer} from './movie-renderer.js';
import type {BurikoProductionDisplayResourceGraph} from './production-display-resource-graph.js';

const mediaType = (
  checkWidth: number,
  checkHeight: number,
  frameTime: bigint,
): BurikoMovieMediaType => {
  const format = new Uint8Array(60),
    view = new DataView(format.buffer);
  view.setBigInt64(40, frameTime, true);
  view.setInt32(52, checkWidth, true);
  view.setInt32(56, checkHeight, true);
  return {
    majorType: '73646976-0000-0010-8000-00aa00389b71',
    subtype: 'e436eb7e-524f-11ce-9f53-0020af0ba770',
    formatType: '05589f80-c356-11ce-bf01-00aa0055595a',
    format,
  };
};

/** Real browser video frames enter the native RGB32 Receive/delivery owner.
 * The canvas is detached and exists only as a pixel readback surface. */
class BurikoBrowserSurfaceMovieGraph extends BurikoMovieMediaGraph {
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private callback: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastMediaTime = -1;
  private closed = false;
  private failed = false;

  constructor(
    video: HTMLVideoElement,
    url: string,
    document: Document,
    readonly renderer: BurikoMovieRenderer,
  ) {
    super(video, url);
    this.canvas = document.createElement('canvas');
    this.canvas.width = video.videoWidth;
    this.canvas.height = video.videoHeight;
    const context = this.canvas.getContext('2d', {willReadFrequently: true});
    if (context === null) throw new Error('Buriko browser movie has no pixel readback context');
    this.context = context;
  }

  startFrames(): void {
    if (this.closed || this.callback !== null || this.timer !== null) return;
    const receive = (): void => {
      this.callback = null;
      this.timer = null;
      if (this.closed || this.failed) return;
      try {
        // The timer fallback samples only a new media position. Native Receive
        // must not get duplicate frames merely because a browser lacks RVFC.
        if (
          typeof this.video.requestVideoFrameCallback !== 'function' &&
          (this.video.readyState < 2 || this.video.currentTime === this.lastMediaTime)
        ) {
          this.timer = setTimeout(receive, 16);
          return;
        }
        this.lastMediaTime = this.video.currentTime;
        const {width, height} = this.canvas;
        this.context.drawImage(this.video, 0, 0, width, height);
        const rgba = this.context.getImageData(0, 0, width, height).data;
        const bgra = new Uint8Array(width * height * 4);
        for (let i = 0; i < bgra.length; i += 4) {
          bgra[i] = rgba[i + 2]!;
          bgra[i + 1] = rgba[i + 1]!;
          bgra[i + 2] = rgba[i]!;
          bgra[i + 3] = 255;
        }
        // Receive does not convert the renderer's delivery HRESULT into a graph
        // error; a temporarily unavailable display can accept the next sample.
        this.renderer.deliver({storage: new BurikoBitmapStorage(bgra, true), offset: 0});
      } catch {
        // The graph must stop admitting frames after readback or renderer failure.
        this.failed = true;
        this.video.pause();
        this.video.dispatchEvent(new Event('error'));
        return;
      }
      if (typeof this.video.requestVideoFrameCallback === 'function')
        this.callback = this.video.requestVideoFrameCallback(receive);
      else this.timer = setTimeout(receive, 16);
    };
    if (typeof this.video.requestVideoFrameCallback === 'function')
      this.callback = this.video.requestVideoFrameCallback(receive);
    else this.timer = setTimeout(receive, 16);
  }

  override async run(): Promise<number> {
    if (this.closed || this.failed) return 0x80004005;
    return super.run();
  }

  override dispose(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.callback !== null) this.video.cancelVideoFrameCallback(this.callback);
    this.callback = null;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    super.dispose();
  }
}

/** F04B0→040430 over the selected physical ISO document and actual surface registry.
 * A browser byte budget is explicit because the source is materialized for Blob playback. */
export class BurikoBrowserSurfaceMovieFactory {
  private generation = 0;
  private resetting = false;
  private closed = false;
  private readonly pending = new Set<Promise<number>>();
  private readonly aborts = new Set<AbortController>();

  constructor(
    readonly graph: BurikoProductionDisplayResourceGraph,
    readonly document: Document,
    readonly imageConfiguration: BurikoMovieImageConfiguration,
    readonly maxDocumentBytes: number,
  ) {
    if (!Number.isSafeInteger(maxDocumentBytes) || maxDocumentBytes < 1)
      throw new RangeError('Invalid Buriko surface movie document byte budget');
  }

  async create(
    slot: number,
    name: BurikoBpPointer,
    repeat: number,
    volume: number,
    archive: BurikoBpPointer | null = null,
  ): Promise<number> {
    if (this.resetting || this.closed)
      throw new Error('Buriko surface movie source admission is closed');
    const generation = this.generation;
    const abort = new AbortController();
    this.aborts.add(abort);
    const work = this.createSelected(slot, name, repeat, volume, archive, generation, abort.signal);
    this.pending.add(work);
    try {
      return await work;
    } finally {
      this.pending.delete(work);
      this.aborts.delete(abort);
    }
  }

  /** A reset closes admission before the first await and joins every old creator. */
  async beginReset(): Promise<() => void> {
    if (this.resetting || this.closed)
      throw new Error('Buriko surface movie factory reset admission is unavailable');
    this.resetting = true;
    this.generation++;
    for (const abort of this.aborts) abort.abort();
    await Promise.allSettled([...this.pending]);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (!this.closed) this.resetting = false;
    };
  }

  async closeAndJoin(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.generation++;
      for (const abort of this.aborts) abort.abort();
    }
    await Promise.allSettled([...this.pending]);
  }

  private check(generation: number, signal: AbortSignal): void {
    if (this.generation !== generation || this.closed || this.resetting || signal.aborted)
      throw new DOMException('Surface movie creation was retired', 'AbortError');
  }

  private async createSelected(
    slot: number,
    name: BurikoBpPointer,
    repeat: number,
    volume: number,
    archive: BurikoBpPointer | null,
    generation: number,
    signal: AbortSignal,
  ): Promise<number> {
    const actor = this.graph.allocator.currentActor;
    const nameBytes = textBytes(name, true).slice();
    const archiveBytes = archive === null ? null : textBytes(archive, true).slice();
    const selectedSource = await this.graph.movieSources.locate(
      archiveBytes === null ? null : {bytes: archiveBytes, offset: 0},
      {bytes: nameBytes, offset: 0},
    );
    this.check(generation, signal);
    if (selectedSource === null)
      throw new Error('Buriko native movie source status is unwritten for a missing file');
    const {surfaces, movies} = this.graph;
    surfaces.release(slot);
    await movies.joinSlotRetirements(slot);
    this.check(generation, signal);
    const selected = await BurikoMovieSourceDocument.openSelected(
      selectedSource,
      this.graph.movieSources,
      actor,
      () => this.graph.ticks.timeGetTime(),
      this.maxDocumentBytes,
    );
    this.check(generation, signal);
    const image = new BurikoMovieImage(this.imageConfiguration);
    const renderer = new BurikoMovieRenderer(surfaces, slot, image, this.graph.notifications);
    const id = movies.append(renderer);
    let media: BurikoBrowserSurfaceMovieGraph | null = null;
    let status = 0x80000001;
    try {
      const bytes = selected.movie.bytes;
      const url = URL.createObjectURL(new Blob([bytes.slice().buffer], {type: 'video/mp4'}));
      const video = this.document.createElement('video');
      video.preload = 'auto';
      video.playsInline = true;
      if (this.graph.device.presentationMode === 'none') video.muted = true;
      video.src = url;
      try {
        status = 0x80000002;
        await new Promise<void>((resolve, reject) => {
          const loaded = () => {
            cleanup();
            resolve();
          };
          const failed = () => {
            cleanup();
            reject(new Error('Browser movie metadata load failed'));
          };
          const aborted = () => {
            cleanup();
            reject(new DOMException('Surface movie creation was retired', 'AbortError'));
          };
          const cleanup = () => {
            video.removeEventListener('loadedmetadata', loaded);
            video.removeEventListener('error', failed);
            signal.removeEventListener('abort', aborted);
          };
          video.addEventListener('loadedmetadata', loaded);
          video.addEventListener('error', failed);
          signal.addEventListener('abort', aborted, {once: true});
          if (signal.aborted) return aborted();
          video.load();
        });
        this.check(generation, signal);
        const videoTrack = selected.movie.tracks.find((track) => track.handler === 'vide');
        if (videoTrack === undefined || video.videoWidth < 1 || video.videoHeight < 1)
          return status;
        const duration = videoTrack.samples.find((sample) => sample.duration > 0)?.duration ?? 0;
        const averageFrameTime =
          videoTrack.timescale > 0
            ? (BigInt(duration) * 10000000n) / BigInt(videoTrack.timescale)
            : 0n;
        const checked = mediaType(
          videoTrack.width || video.videoWidth,
          videoTrack.height || video.videoHeight,
          averageFrameTime,
        );
        status = 0x80000001;
        if (image.checkMediaType(checked) !== 0) return status;
        const connected = mediaType(video.videoWidth, -video.videoHeight, averageFrameTime);
        if (renderer.setMediaType(connected) !== 0) return status;
        media = new BurikoBrowserSurfaceMovieGraph(video, url, this.document, renderer);
        renderer.attachGraph(media, repeat, -1);
        const volumeStatus = renderer.volume(volume);
        if (volumeStatus !== 0) return volumeStatus === 0x80000003 ? 0x80000003 : 0x80000001;
        this.check(generation, signal);
        renderer.notificationId = movies.allocateNotificationId();
        media.startFrames();
        const record = surfaces.record(slot);
        if (record === null) throw new Error('Buriko movie lost its selected surface record');
        record.movieId = id;
        return 0;
      } finally {
        if (media === null) {
          video.pause();
          video.removeAttribute('src');
          video.load();
          URL.revokeObjectURL(url);
        }
      }
    } catch {
      return status;
    } finally {
      if (surfaces.record(slot)?.movieId !== id) {
        media?.dispose();
        movies.remove(id);
        await movies.joinSlotRetirements(slot);
      }
    }
  }
}

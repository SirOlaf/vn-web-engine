import type {AokanaSurfaces} from './surfaces.js';
import {clearAokanaBitmap} from './bitmap-copy.js';
import {AokanaMovieImage, type AokanaMovieMediaType, type AokanaMovieSample} from './movie-image.js';
import {AokanaNativeNotifications} from './notification-queue.js';

/** An attached browser media graph owns the real element, decoded-source URL and listeners. */
export class AokanaMovieMediaGraph {
  private readonly listeners: Array<{type: string; listener: EventListener}> = [];
  private disposed = false;
  private filterState: 0 | 1 | 2 = 0;
  constructor(readonly video: HTMLVideoElement, readonly url: string) {}
  listen(type: string, listener: EventListener): void {
    if (this.disposed) throw new Error('Aokana movie listens on a released media graph');
    this.video.addEventListener(type, listener);
    this.listeners.push({type, listener});
  }
  get currentTime(): bigint {return BigInt(Math.trunc(this.video.currentTime * 10000000));}
  get stopTime(): bigint {return BigInt(Math.trunc(this.video.duration * 10000000));}
  get state(): 0 | 1 | 2 {return this.filterState;}
  async run(): Promise<number> {
    try {await this.video.play(); this.filterState = 2; return 0;}
    catch (error) {if (error instanceof DOMException) return 0x80004005; throw error;}
  }
  pause(): number {this.video.pause(); this.filterState = 1; return 0;}
  stop(): number {this.video.pause(); this.filterState = 0; return 0;}
  seek(time: bigint): number {
    try {this.video.currentTime = Number(time) / 10000000; return 0;}
    catch (error) {if (error instanceof DOMException) return 0x80004005; throw error;}
  }
  volume(decibels: number): number {
    if (decibels < -10000 || decibels > 0) return 0x80070057;
    try {this.video.volume = decibels === -10000 ? 0 : 10 ** (decibels / 2000); return 0;}
    catch (error) {if (error instanceof DOMException) return 0x80004005; throw error;}
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const {type, listener} of this.listeners) this.video.removeEventListener(type, listener);
    this.listeners.length = 0;
    this.video.pause(); this.video.removeAttribute('src'); this.video.load();
    URL.revokeObjectURL(this.url);
  }
}

/** DCMovieRenderer's native state and teardown, independent of container/decoder negotiation. */
export class AokanaMovieRenderer {
  initialized = false;
  suspended = 0;
  started = 0;
  paused = 0;
  repeat = 0;
  deliveredFrames = 0;
  notificationId = -1;
  private graph: AokanaMovieMediaGraph | null = null;
  private readonly events: number[] = [];
  constructor(readonly surfaces: AokanaSurfaces, readonly slot: number,
    readonly image: AokanaMovieImage, readonly notifications: AokanaNativeNotifications) {}

  /** 0a95d0 allocates format1, locks, clears and unlocks after successful SetMediaType. */
  setMediaType(type: AokanaMovieMediaType): number {
    const result = this.image.setMediaType(type);
    if ((result | 0) < 0) return result;
    if (this.surfaces.allocate(this.slot, this.image.width, this.image.height, 1) === 0 ||
      this.surfaces.lock(this.slot) === 0) return 0x80004005;
    const bitmap = this.surfaces.snapshot(this.slot);
    if (bitmap === null) throw new Error('Aokana movie reads an unwritten locked bitmap descriptor');
    clearAokanaBitmap(bitmap);
    this.surfaces.unlock(this.slot);
    return 0;
  }
  /** 0a94c0 ignores copySample's return; the callback controls its own HRESULT. */
  deliver(sample: AokanaMovieSample | null): number {
    if (sample === null) return 0x80004003;
    let result = 0x80004005;
    if (this.surfaces.deviceIndex === 0 && this.surfaces.lock(this.slot) !== 0) {
      const bitmap = this.surfaces.snapshot(this.slot);
      if (bitmap !== null) {
        this.image.copySample(this.image.orientDestination(bitmap), sample);
        this.deliveredFrames = (this.deliveredFrames + 1) | 0;
        this.notifications.push(0x10000, this.slot, 0);
        result = 0;
      }
      this.surfaces.unlock(this.slot);
    }
    return result;
  }
  /** Called after native-equivalent media negotiation succeeds; no placeholder graph is accepted. */
  attachGraph(graph: AokanaMovieMediaGraph, repeat: number, notificationId: number): void {
    if (this.initialized) this.dispose();
    this.graph = graph; this.repeat = repeat | 0; this.notificationId = notificationId | 0;
    this.deliveredFrames = 0; this.initialized = true;
    graph.listen('ended', () => this.events.push(1));
  }
  processEvents(): 0 | 1 {
    if (this.graph === null) return 0;
    while (this.events.length !== 0) if (this.events.shift() === 1 && this.repeat === 0) this.started = 0;
    return 1;
  }
  async serviceRepeat(): Promise<void> {
    const graph = this.graph;
    if (this.repeat !== 0 && graph !== null && graph.stopTime <= graph.currentTime) {
      if ((graph.seek(0n) | 0) >= 0) await graph.run();
    }
  }
  framePosition(): {status: number; value?: number} {
    if (this.graph === null) return {status: 0x80000001};
    return {status: 0, value: this.image.averageFrameTime > 0n ?
      Number(BigInt.asIntN(32, this.graph.currentTime / this.image.averageFrameTime)) : 0};
  }
  milliseconds(): {status: number; value?: number} {
    if (this.graph === null) return {status: 0x80000001};
    return {status: 0, value: Number(BigInt.asIntN(32, this.graph.currentTime / 10000n))};
  }
  isPlaying(): 0 | 1 {
    const graph = this.graph;
    return this.started !== 0 && graph !== null &&
      (this.repeat !== 0 || (graph.currentTime < graph.stopTime && graph.state !== 0)) ? 1 : 0;
  }
  volume(value: number): number {
    value >>>= 0;
    if (value > 128) return 0x80000003;
    const db = value === 0 ? -10000 : Math.trunc(-(((Math.imul(value, -100) + 12800) >>> 0) / 2.6666666666));
    const result = this.graph?.volume(db) ?? 0;
    return result === 0x80070057 ? 0x80000003 : result === 0 || result === 0x80004001 ? 0 : 0x80000001;
  }
  seek(milliseconds: number): number {
    if (this.graph === null) return 0x80000001;
    const time = (milliseconds | 0) < 0 ? this.graph.stopTime : BigInt(milliseconds | 0) * 10000n;
    return (this.graph.seek(time) | 0) < 0 ? 0x80000007 : 0;
  }
  async pause(value: number): Promise<number> {
    if (this.graph === null) return 0x80000001;
    if (this.started === 0) return 0x80000004;
    if (this.paused === 0 && value !== 0) {
      if (this.suspended === 0 && (this.graph.pause() | 0) < 0) return 0xffffffff;
      this.paused = value | 0;
    } else if (this.paused !== 0 && value === 0) {
      if (this.suspended === 0 && ((await this.graph.run()) | 0) < 0) return 0xffffffff;
      this.paused = 0;
    }
    return 0;
  }
  stop(): number {return this.graph !== null && (this.graph.stop() | 0) >= 0 ? 0 : 0x80000001;}
  async start(): Promise<{status: number; remainingMilliseconds?: number}> {
    if (this.graph === null || (this.suspended === 0 && ((await this.graph.run()) | 0) < 0)) return {status: 0x80000001};
    const remainingMilliseconds = Number(BigInt.asIntN(32, (this.graph.stopTime - this.graph.currentTime) / 10000n));
    this.started = 1;
    return {status: 0, remainingMilliseconds};
  }
  suspend(): number {
    if (!this.initialized || this.graph === null) return 0x80000001;
    if (this.suspended !== 0) return 0x80000005;
    if (this.paused === 0 && this.started !== 0 && (this.graph.pause() | 0) < 0) return 0x80000001;
    this.suspended = 1; return 0;
  }
  async resume(): Promise<number> {
    if (this.initialized && this.graph !== null && this.suspended !== 0) {
      if (this.paused === 0 && this.started !== 0 && ((await this.graph.run()) | 0) < 0) return 0;
      this.suspended = 0;
    }
    return 0;
  }
  /** 094c90 drops playback before releasing graph interfaces and custom source storage. */
  dispose(): void {
    this.started = 0;
    this.graph?.dispose(); this.graph = null;
    this.initialized = false; this.suspended = 0;
    this.events.length = 0;
  }
}

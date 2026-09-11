import type {WorkerSource} from '../../../../../core/worker-source.js';
import {StreamMovieVoice} from '../../../../../video/stream-voice.js';
import type {NoahMovieHost} from './movie-devices.js';

/** Noah's CRI/file boundary backed by the web USM/MPEG/HCA decoder. */
export class BrowserNoahMovies implements NoahMovieHost {
  private readonly voices = new Map<number, StreamMovieVoice>();
  private readonly files = new Map<number, WorkerSource>();
  private readonly options = new Map<number, {gain: number; loop: boolean; paused: boolean}>();
  constructor(
    private readonly source: (asset: number) => WorkerSource,
    private readonly context = new AudioContext(),
  ) {}
  async unlock(): Promise<void> {
    await this.context.resume();
  }
  initialize(channel: number): number {
    const handle = channel + 1;
    this.stop(handle);
    this.options.set(handle, {gain: 1, loop: false, paused: false});
    return handle;
  }
  private setting(handle: number) {
    const setting = this.options.get(handle);
    if (!setting) throw new Error(`Unbound movie handle ${handle}`);
    return setting;
  }
  closeFile(channel: number, stream: number): void {
    this.files.delete(channel * 8 + stream);
  }
  openFile(channel: number, asset: number): number {
    this.files.set(channel * 8, this.source(asset));
    return 0;
  }
  start(handle: number, asset: number): void {
    if (!handle) return;
    const setting = this.setting(handle),
      source = this.files.get((handle - 1) * 8) ?? this.source(asset);
    this.stop(handle);
    const voice = new StreamMovieVoice(this.context, source);
    this.voices.set(handle, voice);
    voice.volume(setting.gain);
    voice.loop(setting.loop);
    voice.pause(setting.paused);
  }
  status(handle: number): number {
    return handle ? (this.voices.get(handle)?.snapshot().status ?? 0) : 0;
  }
  sample(handle: number) {
    return this.voices.get(handle)?.snapshot();
  }
  stop(handle: number): void {
    this.voices.get(handle)?.dispose();
    this.voices.delete(handle);
  }
  volume(handle: number, gain: number): void {
    if (!handle) return;
    this.setting(handle).gain = gain;
    this.voices.get(handle)?.volume(gain);
  }
  loop(handle: number, enabled: boolean): void {
    if (!handle) return;
    this.setting(handle).loop = enabled;
    this.voices.get(handle)?.loop(enabled);
  }
  pause(handle: number, paused: boolean): void {
    if (!handle) return;
    this.setting(handle).paused = paused;
    this.voices.get(handle)?.pause(paused);
  }
  reset(): void {
    for (const h of this.voices.keys()) this.stop(h);
    this.files.clear();
    this.options.clear();
  }
  dispose(): void {
    this.reset();
    void this.context.close();
  }
}

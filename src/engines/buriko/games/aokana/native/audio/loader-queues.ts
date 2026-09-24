import type {AokanaBpPointer} from '../../bp/memory.js';
import type {AokanaResourceLoadingState, AokanaResourceResult} from '../resource-loading.js';
import type {AokanaLoaderMetadata} from '../loader-metadata.js';
import type {AokanaAudioMusicResources} from './resource-music.js';
import type {AokanaAudioStaticResources} from './resource-static.js';

interface MusicJob {
  readonly result: AokanaResourceResult;
  readonly channel: number;
  readonly archive: Uint8Array;
  readonly name: Uint8Array;
  readonly volume: number;
  readonly pan: number;
}
interface StaticJob {
  readonly result: AokanaResourceResult;
  readonly channel: number;
  readonly source: AokanaBpPointer;
  readonly fade: number;
  readonly gain: number;
  readonly speed: number;
  readonly initialized?: Uint8Array;
}

/** FDF80/FE330 and FDAA0/FD950: actual borrowed music/static queues sharing2776F8. */
export class AokanaAudioLoaderQueues {
  private readonly musicJobs: MusicJob[] = [];
  private readonly staticJobs: StaticJob[] = [];
  private musicPending: Promise<boolean> | null = null;
  private staticPending: Promise<boolean> | null = null;
  readonly metadata: AokanaLoaderMetadata;
  constructor(
    readonly loading: AokanaResourceLoadingState,
    readonly music: AokanaAudioMusicResources,
    readonly staticResources: AokanaAudioStaticResources,
  ) {
    if (
      music.resources !== loading.resources ||
      music.streams.channels !== staticResources.channels ||
      staticResources.channels.actors !== loading.resources.mainProcessing.allocator
    )
      throw new Error('Aokana loader queues must share actual resource/channel/actor owners');
    this.metadata = loading.metadata;
  }
  get hasMusic(): boolean {
    return this.metadata.run(
      this.metadata.allocator.currentActor,
      () => this.musicJobs.length !== 0,
    );
  }
  get hasStatic(): boolean {
    return this.metadata.run(
      this.metadata.allocator.currentActor,
      () => this.staticJobs.length !== 0,
    );
  }
  /** Native copies node fields, not the pointed-to process name arrays or result cell. */
  enqueueMusic(
    result: AokanaResourceResult,
    channel: number,
    archive: Uint8Array,
    name: Uint8Array,
    volume: number,
    pan: number,
    actor = this.metadata.allocator.currentActor,
  ): void {
    result.value = 1;
    const job: MusicJob = {
      result,
      channel: channel >>> 0,
      archive,
      name,
      volume: volume | 0,
      pan: pan | 0,
    };
    this.metadata.run(actor, () => {
      this.musicJobs.push(job);
    });
  }
  /** FE330 publishes1 before allocating the0x38-byte node; source storage remains borrowed. */
  enqueueStatic(
    result: AokanaResourceResult,
    channel: number,
    source: AokanaBpPointer,
    fade: number,
    gain: number,
    speed: number,
    initialized?: Uint8Array,
    actor = this.metadata.allocator.currentActor,
  ): void {
    result.value = 1;
    const job: StaticJob = {
      result,
      channel: channel >>> 0,
      source: {bytes: source.bytes, offset: source.offset},
      fade: fade | 0,
      gain,
      speed,
      initialized,
    };
    this.metadata.run(actor, () => {
      this.staticJobs.push(job);
    });
  }
  processMusic(actor = this.metadata.allocator.currentActor): Promise<boolean> {
    if (this.musicPending !== null) return this.musicPending;
    const job = this.metadata.run(actor, () => this.musicJobs[0]);
    if (job === undefined) return Promise.resolve(false);
    // Install admission before invoking any callback-capable resource lower.
    this.musicPending = Promise.resolve()
      .then(async () => {
        const status = await this.music.loadMusic(
          job.channel,
          () => job.archive,
          () => job.name,
          job.volume,
          job.pan,
          actor,
        );
        job.result.value =
          status === 0 ? 0 : status === 12 ? 0x80000001 : status === 14 ? 0x80000002 : 0x8fffffff;
        this.metadata.run(actor, () => {
          if (this.musicJobs[0] !== job)
            throw new Error('Aokana music loader lost its borrowed head');
          this.musicJobs.shift();
        });
        return true;
      })
      .finally(() => {
        this.musicPending = null;
      });
    return this.musicPending;
  }
  processStatic(actor = this.metadata.allocator.currentActor): Promise<boolean> {
    if (this.staticPending !== null) return this.staticPending;
    const job = this.metadata.run(actor, () => this.staticJobs[0]);
    if (job === undefined) return Promise.resolve(false);
    this.staticPending = Promise.resolve()
      .then(async () => {
        const status = await this.staticResources.register(
          job.channel,
          job.source,
          job.fade,
          job.gain,
          job.speed,
          job.initialized,
          actor,
        );
        job.result.value =
          status === 0 || status === 20
            ? 0
            : status === 14
              ? 0x80000002
              : status === 18
                ? 0xffff0101
                : 0xffffffff;
        this.metadata.run(actor, () => {
          if (this.staticJobs[0] !== job)
            throw new Error('Aokana static loader lost its borrowed head');
          this.staticJobs.shift();
        });
        return true;
      })
      .finally(() => {
        this.staticPending = null;
      });
    return this.staticPending;
  }
}

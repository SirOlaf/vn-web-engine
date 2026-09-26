import type {BurikoMountedFileMetadata} from './file-metadata.js';
import type {BurikoBpAbi} from '../bp/abi.js';
import type {BurikoMountedProgramPaths} from './program-paths.js';
import {
  BurikoProgramFiles,
  type BurikoProgramMedia,
  type BurikoDriveTypeHost,
  type BurikoDiskFreeSpaceHost,
  type BurikoDriveGeometryHost,
} from './program-files.js';
import {BurikoVolumeLabels, type BurikoVolumeLabelHost} from './volume-labels.js';
import {
  BurikoProgramResources,
  type BurikoProgramResourceConfiguration,
} from './program-resources.js';
import type {BurikoNativeText} from './text.js';
import type {BurikoEngineDialogs} from './engine-dialogs.js';
import {BurikoEngineErrors} from './engine-errors.js';
import type {BurikoSaveRoot} from './save-root.js';
import {BurikoDistributedAllocator, BurikoDistributedProcessing} from './distributed-processing.js';
import type {BurikoNativeLocks} from './exclusion-locks.js';
import type {BurikoSystemTicks} from './system-ticks.js';
import {BurikoBrowserMainWindow} from './browser-main-window.js';
import {BurikoResourceLoadingState} from './resource-loading.js';
import {BurikoScriptFiles} from './script-files.js';
import {BurikoSharedLoaderWorker} from './shared-loader-worker.js';
import {BurikoSpeakerContext} from './audio/speaker.js';
import type {BurikoSpeakerBackend} from './audio/speaker-backend.js';
import {BurikoAudioChannels, type BurikoAudioOutputProfile} from './audio/channel-registry.js';
import {BurikoAudioArchiveCache} from './audio/archive-cache.js';
import {BurikoAudioResourceStreams} from './audio/resource-streams.js';
import {BurikoAudioMusicResources} from './audio/resource-music.js';
import {BurikoAudioStaticResources} from './audio/resource-static.js';
import {BurikoAudioLoaderQueues} from './audio/loader-queues.js';
import {
  BurikoTemporaryDirectoryProbe,
  type BurikoTemporaryFileHost,
} from './temporary-directory-probe.js';

export interface BurikoProductionResourceWorkerInputs {
  readonly abi?: BurikoBpAbi;
  readonly mounted: BurikoMountedFileMetadata;
  readonly paths: BurikoMountedProgramPaths;
  readonly text: BurikoNativeText;
  readonly media: BurikoProgramMedia;
  /** Explicit synchronous drive APIs; no mounted-path inference. */
  readonly driveHost?: BurikoDriveTypeHost & BurikoDiskFreeSpaceHost & BurikoVolumeLabelHost;
  /** Independent GetDiskFreeSpaceA sector size used by 81:32; absent until selected by the host. */
  readonly driveGeometryHost?: BurikoDriveGeometryHost;
  readonly dialogs: BurikoEngineDialogs;
  readonly configuration: BurikoProgramResourceConfiguration;
  readonly errorDirectory: Uint8Array | BurikoSaveRoot;
  readonly workingDirectory: Uint8Array;
  /** Native audio root 1CC538, independent of ProgramResources.primaryRoot. */
  readonly audioRootWide: string;
  readonly backend: BurikoSpeakerBackend;
  readonly output: BurikoAudioOutputProfile;
  readonly ticks: BurikoSystemTicks;
  /** The display/surface and resource worker graph share this one native work allocator. */
  readonly allocator: BurikoDistributedAllocator;
  /** Borrow the five initialized engine locks owned by the display manager. */
  readonly locks: BurikoNativeLocks;
  readonly resourceWorkerCount: number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  /** Explicit GetTempFileNameW profile; absent until the host provides one. */
  readonly temporaryFileHost?: BurikoTemporaryFileHost | null;
}

/** One mounted resource/audio/script worker graph; BP bank and GUI loop belong to a later aggregate. */
export class BurikoProductionResourceWorker {
  readonly allocator: BurikoDistributedAllocator;
  readonly locks: BurikoNativeLocks;
  readonly files: BurikoProgramFiles;
  readonly media: BurikoProgramMedia;
  readonly driveHost:
    (BurikoDriveTypeHost & BurikoDiskFreeSpaceHost & BurikoVolumeLabelHost) | null;
  readonly driveGeometryHost: BurikoDriveGeometryHost | null;
  readonly volumeLabels: BurikoVolumeLabels | null;
  readonly temporaryDirectoryProbe: BurikoTemporaryDirectoryProbe | null;
  readonly errors: BurikoEngineErrors;
  readonly processing: BurikoDistributedProcessing;
  readonly resources: BurikoProgramResources;
  readonly loading: BurikoResourceLoadingState;
  readonly channels: BurikoAudioChannels;
  readonly archiveCache: BurikoAudioArchiveCache;
  readonly streams: BurikoAudioResourceStreams;
  readonly music: BurikoAudioMusicResources;
  readonly statics: BurikoAudioStaticResources;
  readonly audio: BurikoAudioLoaderQueues;
  readonly scripts: BurikoScriptFiles;
  readonly worker: BurikoSharedLoaderWorker;
  private started = false;
  private closed = false;
  private vmQuiescing: Promise<void> | null = null;

  constructor(inputs: BurikoProductionResourceWorkerInputs) {
    this.allocator = inputs.allocator;
    this.locks = inputs.locks;
    this.media = inputs.media;
    this.driveHost = inputs.driveHost ?? null;
    this.driveGeometryHost = inputs.driveGeometryHost ?? null;
    this.files = new BurikoProgramFiles(inputs.mounted, inputs.text, this.media, inputs.paths);
    this.volumeLabels = this.driveHost === null ? null : new BurikoVolumeLabels(this.driveHost);
    this.temporaryDirectoryProbe =
      inputs.temporaryFileHost == null
        ? null
        : new BurikoTemporaryDirectoryProbe(this.files, inputs.temporaryFileHost);
    this.errors = new BurikoEngineErrors(
      this.files,
      inputs.dialogs,
      inputs.errorDirectory,
      inputs.workingDirectory,
    );
    this.processing = new BurikoDistributedProcessing(this.allocator, inputs.resourceWorkerCount);
    this.resources = new BurikoProgramResources(
      this.files,
      inputs.configuration,
      inputs.dialogs,
      this.errors,
      this.processing,
    );
    this.loading = new BurikoResourceLoadingState(this.resources);
    this.channels = new BurikoAudioChannels(
      new BurikoSpeakerContext(inputs.backend, inputs.abi),
      this.locks,
      this.allocator,
      inputs.ticks,
      inputs.output,
    );
    this.archiveCache = new BurikoAudioArchiveCache(this.channels, this.files);
    this.archiveCache.rootWide = inputs.audioRootWide;
    this.streams = new BurikoAudioResourceStreams(
      this.channels,
      this.archiveCache,
      this.files,
      inputs.abi,
    );
    this.music = new BurikoAudioMusicResources(this.resources, this.streams);
    this.statics = new BurikoAudioStaticResources(this.channels);
    this.audio = new BurikoAudioLoaderQueues(this.loading, this.music, this.statics);
    this.scripts = new BurikoScriptFiles(this.files, this.allocator, inputs.sleep);
    this.worker = new BurikoSharedLoaderWorker(this.loading, this.audio, this.scripts);
  }

  /** Channel startup retains the actual window; script-file startup is inside worker.start. */
  async start(window: BurikoBrowserMainWindow, options: {automatic?: boolean} = {}): Promise<void> {
    if (this.started || this.closed)
      throw new Error('Buriko production resource worker is already used');
    if (window.manager.surfaces.allocator !== this.allocator)
      throw new Error('Buriko audio and main window require one distributed allocator');
    if (window.manager.locks !== this.locks)
      throw new Error('Buriko audio and main window require one initialized engine-lock owner');
    try {
      this.channels.initialize(window);
      this.channels.activate();
      await this.channels.initializeMasters();
      this.worker.start(options);
      this.started = true;
    } catch (error) {
      try {
        await this.channels.disposeChannels();
      } catch {
        // Startup failure remains the error reported to the aggregate caller.
      }
      throw error;
    }
  }

  /** ECB90's per-program 031BB0 leaves the shared FD8D0 worker alive. */
  closeProgramScripts(actor = this.allocator.currentActor): Promise<void> {
    if (!this.started || this.closed)
      throw new Error('Buriko production resource worker is not running');
    return this.worker.closeProgramScripts(actor);
  }

  /** Final VM close joins the shared loader before child BP storage can be retired.
   * Direct producer admission remains the outer coordinator's responsibility. */
  quiesceForVmClose(actor = this.allocator.currentActor): Promise<void> {
    if (this.vmQuiescing !== null) return this.vmQuiescing;
    this.vmQuiescing = (async () => {
      if (!this.worker.hasStarted) return;
      let failed = false;
      let firstError: unknown;
      const capture = (error: unknown): void => {
        if (!failed) {
          failed = true;
          firstError = error;
        }
      };
      // Music queue records borrow the owning process's inline names and result.
      // Native stop leaves them linked, so consume accepted records in FD8D0 order.
      try {
        while (this.worker.isRunning && this.audio.hasMusic) {
          const job = await this.worker.processOne();
          if (job === null && this.audio.hasMusic)
            throw new Error('Buriko shared loader made no progress on pending music');
        }
      } catch (error) {
        capture(error);
      }
      let shutdownFailed = false;
      let shutdownError: unknown;
      if (this.worker.isRunning || this.worker.hasPendingScriptClose) {
        try {
          await this.worker.shutdown(actor);
        } catch (error) {
          shutdownFailed = true;
          shutdownError = error;
        }
      }
      if (this.worker.isRunning) {
        try {
          await this.worker.stop();
        } catch (error) {
          capture(error);
        }
      }
      try {
        await this.worker.join();
      } catch (error) {
        capture(error);
      }
      if (shutdownFailed) capture(shutdownError);
      if (failed) throw firstError;
    })();
    return this.vmQuiescing;
  }

  get quiescedForVmClose(): boolean {
    return this.worker.hasStarted
      ? this.worker.isQuiesced
      : !this.started &&
          !this.loading.hasPending &&
          !this.audio.hasMusic &&
          !this.audio.hasStatic &&
          !this.scripts.hasPending;
  }

  /** Final native worker stop, plus host recovery when an automatic worker already stopped. */
  async shutdown(actor = this.allocator.currentActor): Promise<void> {
    if (!this.started || this.closed)
      throw new Error('Buriko production resource worker is not running');
    let failed = false;
    let firstError: unknown;
    const capture = (error: unknown): void => {
      if (!failed) {
        failed = true;
        firstError = error;
      }
    };
    let shutdownFailed = false;
    let shutdownError: unknown;
    if (this.worker.isRunning) {
      try {
        await this.worker.shutdown(actor);
      } catch (error) {
        shutdownFailed = true;
        shutdownError = error;
      }
    }
    if (this.worker.isRunning) {
      // A script-close failure unrelated to the worker may leave it running.
      // Quiesce it before host recovery touches any of its script records.
      try {
        await this.worker.stop();
      } catch (error) {
        capture(error);
      }
    }
    // Joining wins over a secondary script-wait error: it reports the original
    // automatic worker failure after its last iteration and queue cleanup.
    try {
      await this.worker.join();
    } catch (error) {
      capture(error);
    }
    if (shutdownFailed) capture(shutdownError);
    if (this.scripts.hasLiveSection) {
      // Normal native shutdown already disposed this section. A stopped worker
      // cannot drain queued closes, so use the explicit host-only recovery path.
      try {
        await this.scripts.recoverAfterWorkerStop(actor);
      } catch (error) {
        capture(error);
      }
    }
    try {
      await this.channels.disposeChannels();
    } catch (error) {
      capture(error);
    }
    try {
      await this.channels.section.enter(actor);
      try {
        this.archiveCache.dispose(actor);
      } finally {
        this.channels.section.leave(actor);
      }
    } catch (error) {
      capture(error);
    }
    this.started = false;
    this.closed = true;
    if (failed) throw firstError;
  }
}

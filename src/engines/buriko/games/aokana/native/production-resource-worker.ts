import type {AokanaMountedFileMetadata} from './file-metadata.js';
import type {AokanaMountedProgramPaths} from './program-paths.js';
import {
  AokanaProgramFiles,
  type AokanaProgramMedia,
  type AokanaDriveTypeHost,
  type AokanaDiskFreeSpaceHost,
  type AokanaDriveGeometryHost,
} from './program-files.js';
import {AokanaVolumeLabels, type AokanaVolumeLabelHost} from './volume-labels.js';
import {
  AokanaProgramResources,
  type AokanaProgramResourceConfiguration,
} from './program-resources.js';
import type {AokanaNativeText} from './text.js';
import type {AokanaEngineDialogs} from './engine-dialogs.js';
import {AokanaEngineErrors} from './engine-errors.js';
import type {AokanaSaveRoot} from './save-root.js';
import {AokanaDistributedAllocator, AokanaDistributedProcessing} from './distributed-processing.js';
import type {AokanaNativeLocks} from './exclusion-locks.js';
import type {AokanaSystemTicks} from './system-ticks.js';
import {AokanaBrowserMainWindow} from './browser-main-window.js';
import {AokanaResourceLoadingState} from './resource-loading.js';
import {AokanaScriptFiles} from './script-files.js';
import {AokanaSharedLoaderWorker} from './shared-loader-worker.js';
import {AokanaSpeakerContext} from './audio/speaker.js';
import type {AokanaSpeakerBackend} from './audio/speaker-backend.js';
import {AokanaAudioChannels, type AokanaAudioOutputProfile} from './audio/channel-registry.js';
import {AokanaAudioArchiveCache} from './audio/archive-cache.js';
import {AokanaAudioResourceStreams} from './audio/resource-streams.js';
import {AokanaAudioMusicResources} from './audio/resource-music.js';
import {AokanaAudioStaticResources} from './audio/resource-static.js';
import {AokanaAudioLoaderQueues} from './audio/loader-queues.js';
import {
  AokanaTemporaryDirectoryProbe,
  type AokanaTemporaryFileHost,
} from './temporary-directory-probe.js';

export interface AokanaProductionResourceWorkerInputs {
  readonly mounted: AokanaMountedFileMetadata;
  readonly paths: AokanaMountedProgramPaths;
  readonly text: AokanaNativeText;
  readonly media: AokanaProgramMedia;
  /** Explicit synchronous drive APIs; no mounted-path inference. */
  readonly driveHost?: AokanaDriveTypeHost & AokanaDiskFreeSpaceHost & AokanaVolumeLabelHost;
  /** Independent GetDiskFreeSpaceA sector size used by 81:32; absent until selected by the host. */
  readonly driveGeometryHost?: AokanaDriveGeometryHost;
  readonly dialogs: AokanaEngineDialogs;
  readonly configuration: AokanaProgramResourceConfiguration;
  readonly errorDirectory: Uint8Array | AokanaSaveRoot;
  readonly workingDirectory: Uint8Array;
  /** Native audio root 1CC538, independent of ProgramResources.primaryRoot. */
  readonly audioRootWide: string;
  readonly backend: AokanaSpeakerBackend;
  readonly output: AokanaAudioOutputProfile;
  readonly ticks: AokanaSystemTicks;
  /** The display/surface and resource worker graph share this one native work allocator. */
  readonly allocator: AokanaDistributedAllocator;
  /** Borrow the five initialized engine locks owned by the display manager. */
  readonly locks: AokanaNativeLocks;
  readonly resourceWorkerCount: number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  /** Explicit GetTempFileNameW profile; absent until the host provides one. */
  readonly temporaryFileHost?: AokanaTemporaryFileHost | null;
}

/** One mounted resource/audio/script worker graph; BP bank and GUI loop belong to a later aggregate. */
export class AokanaProductionResourceWorker {
  readonly allocator: AokanaDistributedAllocator;
  readonly locks: AokanaNativeLocks;
  readonly files: AokanaProgramFiles;
  readonly media: AokanaProgramMedia;
  readonly driveHost:
    (AokanaDriveTypeHost & AokanaDiskFreeSpaceHost & AokanaVolumeLabelHost) | null;
  readonly driveGeometryHost: AokanaDriveGeometryHost | null;
  readonly volumeLabels: AokanaVolumeLabels | null;
  readonly temporaryDirectoryProbe: AokanaTemporaryDirectoryProbe | null;
  readonly errors: AokanaEngineErrors;
  readonly processing: AokanaDistributedProcessing;
  readonly resources: AokanaProgramResources;
  readonly loading: AokanaResourceLoadingState;
  readonly channels: AokanaAudioChannels;
  readonly archiveCache: AokanaAudioArchiveCache;
  readonly streams: AokanaAudioResourceStreams;
  readonly music: AokanaAudioMusicResources;
  readonly statics: AokanaAudioStaticResources;
  readonly audio: AokanaAudioLoaderQueues;
  readonly scripts: AokanaScriptFiles;
  readonly worker: AokanaSharedLoaderWorker;
  private started = false;
  private closed = false;
  private vmQuiescing: Promise<void> | null = null;

  constructor(inputs: AokanaProductionResourceWorkerInputs) {
    this.allocator = inputs.allocator;
    this.locks = inputs.locks;
    this.media = inputs.media;
    this.driveHost = inputs.driveHost ?? null;
    this.driveGeometryHost = inputs.driveGeometryHost ?? null;
    this.files = new AokanaProgramFiles(inputs.mounted, inputs.text, this.media, inputs.paths);
    this.volumeLabels = this.driveHost === null ? null : new AokanaVolumeLabels(this.driveHost);
    this.temporaryDirectoryProbe =
      inputs.temporaryFileHost == null
        ? null
        : new AokanaTemporaryDirectoryProbe(this.files, inputs.temporaryFileHost);
    this.errors = new AokanaEngineErrors(
      this.files,
      inputs.dialogs,
      inputs.errorDirectory,
      inputs.workingDirectory,
    );
    this.processing = new AokanaDistributedProcessing(this.allocator, inputs.resourceWorkerCount);
    this.resources = new AokanaProgramResources(
      this.files,
      inputs.configuration,
      inputs.dialogs,
      this.errors,
      this.processing,
    );
    this.loading = new AokanaResourceLoadingState(this.resources);
    this.channels = new AokanaAudioChannels(
      new AokanaSpeakerContext(inputs.backend),
      this.locks,
      this.allocator,
      inputs.ticks,
      inputs.output,
    );
    this.archiveCache = new AokanaAudioArchiveCache(this.channels, this.files);
    this.archiveCache.rootWide = inputs.audioRootWide;
    this.streams = new AokanaAudioResourceStreams(this.channels, this.archiveCache, this.files);
    this.music = new AokanaAudioMusicResources(this.resources, this.streams);
    this.statics = new AokanaAudioStaticResources(this.channels);
    this.audio = new AokanaAudioLoaderQueues(this.loading, this.music, this.statics);
    this.scripts = new AokanaScriptFiles(this.files, this.allocator, inputs.sleep);
    this.worker = new AokanaSharedLoaderWorker(this.loading, this.audio, this.scripts);
  }

  /** Channel startup retains the actual window; script-file startup is inside worker.start. */
  async start(window: AokanaBrowserMainWindow, options: {automatic?: boolean} = {}): Promise<void> {
    if (this.started || this.closed)
      throw new Error('Aokana production resource worker is already used');
    if (window.manager.surfaces.allocator !== this.allocator)
      throw new Error('Aokana audio and main window require one distributed allocator');
    if (window.manager.locks !== this.locks)
      throw new Error('Aokana audio and main window require one initialized engine-lock owner');
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
      throw new Error('Aokana production resource worker is not running');
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
            throw new Error('Aokana shared loader made no progress on pending music');
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
      throw new Error('Aokana production resource worker is not running');
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

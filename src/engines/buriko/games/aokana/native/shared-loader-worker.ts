import type {AokanaResourceLoadingState} from './resource-loading.js';
import type {AokanaAudioLoaderQueues} from './audio/loader-queues.js';
import type {AokanaScriptFiles} from './script-files.js';

export type AokanaSharedLoaderJob = 'resource' | 'music' | 'static' | 'script' | null;

/** FD8D0's one actor and four real FIFO consumers. The host timer approximates 09D9E0(1). */
export class AokanaSharedLoaderWorker {
  readonly actor = {};
  private running = false;
  private automatic = false;
  private scheduled: ReturnType<typeof setTimeout> | null = null;
  private iteration: Promise<AokanaSharedLoaderJob> | null = null;
  private scriptClosing: Promise<void> | null = null;
  private scriptCloseSettled = false;
  private scriptAdmissionClosed = false;
  private stopping: Promise<void> | null = null;
  private stopped = false;
  private failure: unknown = null;
  private failed = false;

  constructor(
    readonly loading: AokanaResourceLoadingState,
    readonly audio: AokanaAudioLoaderQueues,
    readonly scripts: AokanaScriptFiles,
  ) {
    if (
      audio.loading !== loading ||
      scripts.files !== loading.resources.files ||
      scripts.actors !== loading.resources.mainProcessing.allocator
    )
      throw new Error('Aokana shared loader requires the actual resource, audio and script owners');
  }

  get isRunning(): boolean {
    return this.running;
  }

  get hasStarted(): boolean {
    return this.running || this.stopping !== null || this.stopped;
  }

  get hasPendingScriptClose(): boolean {
    return this.scriptClosing !== null && !this.scriptCloseSettled;
  }

  /** A reported worker error may follow a completed stop. Queue emptiness also
   * matters because queued resource, static, and script jobs may retain BP pointers. */
  get isQuiesced(): boolean {
    return (
      this.stopped &&
      !this.running &&
      this.iteration === null &&
      !this.hasPendingScriptClose &&
      !this.loading.hasPending &&
      !this.audio.hasMusic &&
      !this.audio.hasStatic &&
      !this.scripts.hasPending
    );
  }

  /** The scheduler yields to the host task; it never consumes a loader job inline. */
  hasPendingWork(): boolean {
    return (
      this.running &&
      (this.iteration !== null ||
        this.loading.hasPending ||
        this.audio.hasMusic ||
        this.audio.hasStatic ||
        (!this.scriptAdmissionClosed && this.scripts.hasPending))
    );
  }

  /** FDEE0 initializes script files before the worker may touch its fourth queue. */
  start(options: {automatic?: boolean} = {}): void {
    if (this.running || (this.stopping !== null && !this.stopped))
      throw new Error('Aokana shared loader is already running or joining');
    this.stopping = null;
    this.scriptClosing = null;
    this.scriptCloseSettled = false;
    this.scriptAdmissionClosed = false;
    this.stopped = false;
    this.failure = null;
    this.failed = false;
    this.scripts.initialize();
    this.running = true;
    this.automatic = options.automatic !== false;
    if (this.automatic) this.schedule(0);
  }

  /** A deterministic fixture may drive processOne before enabling the normal host task. */
  resumeAutomatic(): void {
    if (!this.running) throw new Error('Aokana shared loader is not running');
    this.automatic = true;
    this.schedule(0);
  }

  /** One FD8D0 iteration, also used by the automatic host task. */
  processOne(): Promise<AokanaSharedLoaderJob> {
    if (!this.running) throw new Error('Aokana shared loader is not running');
    if (this.iteration !== null) return this.iteration;
    const iteration = Promise.resolve().then(async (): Promise<AokanaSharedLoaderJob> => {
      if (await this.loading.processNext(this.actor)) return 'resource';
      if (await this.audio.processMusic(this.actor)) return 'music';
      if (await this.audio.processStatic(this.actor)) return 'static';
      if (this.scriptAdmissionClosed) return null;
      return (await this.scripts.processFirst(this.actor)) === 0 ? 'script' : null;
    });
    this.iteration = iteration;
    void iteration.then(
      () => {
        if (this.iteration === iteration) this.iteration = null;
      },
      () => {
        if (this.iteration === iteration) this.iteration = null;
      },
    );
    return iteration;
  }

  private schedule(delay: number): void {
    if (!this.running || !this.automatic || this.scheduled !== null) return;
    this.scheduled = setTimeout(() => {
      this.scheduled = null;
      void this.pump();
    }, delay);
  }

  private async pump(): Promise<void> {
    if (!this.running) return;
    try {
      const job = await this.processOne();
      // Native restarts at resource after every job. A successful turn receives its
      // own host task; an empty turn waits approximately the native half millisecond.
      this.schedule(job === null ? 1 : 0);
    } catch (error) {
      this.failure = error;
      this.failed = true;
      try {
        await this.stop();
      } catch {
        // join() reports the worker failure after the native queue cleanup.
      }
    }
  }

  /** FDE10 clears running, joins the worker, then removes resource/static nodes. */
  stop(): Promise<void> {
    if (this.stopping !== null) return this.stopping;
    if (!this.running) throw new Error('Aokana shared loader has not been started');
    this.running = false;
    this.automatic = false;
    if (this.scheduled !== null) {
      clearTimeout(this.scheduled);
      this.scheduled = null;
    }
    this.stopping = (async () => {
      let failed = false;
      let firstError: unknown;
      const capture = (error: unknown): void => {
        if (!failed) {
          failed = true;
          firstError = error;
        }
      };
      try {
        await this.iteration;
      } catch (error) {
        capture(error);
      }
      try {
        this.loading.discardPendingResources(this.actor);
      } catch (error) {
        capture(error);
      }
      try {
        this.audio.discardPendingStatic(this.actor);
      } catch (error) {
        capture(error);
      }
      this.stopped = true;
      if (failed) throw firstError;
    })();
    return this.stopping;
  }

  /** 031BB0 closes one program's script files while FD8D0 remains available. */
  closeProgramScripts(actor = this.loading.metadata.allocator.currentActor): Promise<void> {
    if (this.scriptClosing !== null) {
      if (!this.scriptCloseSettled) return this.scriptClosing;
      throw new Error('Aokana script close has already completed for this worker start');
    }
    if (!this.running) throw new Error('Aokana script shutdown requires a running loader');
    if (!this.scripts.hasLiveSection)
      throw new Error('Aokana script section is already closed; restart does not reinitialize it');
    // Script closes must progress even after a deterministic manual start.
    this.resumeAutomatic();
    this.scriptClosing = this.scripts.shutdown(
      actor,
      () => this.running,
      async () => {
        // 031BB0 has drained the last close. Bar a new FD8D0 script turn and
        // join one that passed processFirst's enabled check before deleting 1D0340.
        this.scriptAdmissionClosed = true;
        await this.iteration;
      },
    );
    void this.scriptClosing.then(
      () => {
        this.scriptCloseSettled = true;
      },
      () => {
        this.scriptCloseSettled = true;
      },
    );
    return this.scriptClosing;
  }

  /** Final FDE10 stop after joining any in-flight 031BB0 close. */
  async shutdown(actor = this.loading.metadata.allocator.currentActor): Promise<void> {
    if (this.scriptClosing !== null) await this.scriptClosing;
    else if (this.scripts.hasLiveSection) await this.closeProgramScripts(actor);
    await this.stop();
  }

  /** Host completion is the selected replacement for the CRT thread exit-code poll. */
  async join(): Promise<void> {
    if (this.stopping === null) throw new Error('Aokana shared loader has not been stopped');
    let failed = false;
    let stopError: unknown;
    try {
      await this.stopping;
    } catch (error) {
      failed = true;
      stopError = error;
    }
    if (this.failed) throw this.failure;
    if (failed) throw stopError;
  }
}

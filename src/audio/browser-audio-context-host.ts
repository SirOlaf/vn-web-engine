export interface BrowserAudioContextSnapshot {
  /** Preserve browser extensions such as WebKit's interrupted state. */
  readonly state: string;
  readonly currentTime: number;
  readonly sampleRate: number;
  readonly needsResume: boolean;
}

/** Owns browser activation/recovery of an existing context; the caller owns its audio graph
 * and closing it. A resumed context keeps every buffer and its real playback position. */
export class BrowserAudioContextHost {
  private disposed = false;
  private readonly view: Window | null;

  constructor(
    readonly context: AudioContext,
    private readonly document: Document,
    private readonly changed: (snapshot: BrowserAudioContextSnapshot) => void = () => {},
    private readonly onError: (error: unknown) => void = () => {},
  ) {
    this.view = document.defaultView;
    context.addEventListener('statechange', this.stateChanged);
    document.addEventListener('visibilitychange', this.returned);
    this.view?.addEventListener('pageshow', this.returned);
    this.publish();
  }

  /** Reads the browser clock directly; observation never advances or reconstructs playback. */
  get snapshot(): BrowserAudioContextSnapshot {
    const state: string = this.context.state;
    return {
      state,
      currentTime: this.context.currentTime,
      sampleRate: this.context.sampleRate,
      needsResume: state === 'suspended' || state === 'interrupted',
    };
  }

  /** Call directly from the client's Play/Resume audio handler. A previous blocked resume
   * promise must not prevent a new call from carrying this gesture's activation. */
  resume(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Browser audio context host is disposed'));
    if (this.context.state === 'closed')
      return Promise.reject(new DOMException('The audio context is closed', 'InvalidStateError'));
    if (this.context.state === 'running') return Promise.resolve();
    let resuming: Promise<void>;
    try {
      resuming = this.context.resume();
    } catch (error) {
      this.publish();
      return Promise.reject(error);
    }
    this.publish();
    return resuming.then(
      () => this.publish(),
      (error: unknown) => {
        this.publish();
        throw error;
      },
    );
  }

  private publish(): void {
    if (this.disposed) return;
    try {
      this.changed(this.snapshot);
    } catch {
      // An observer does not own the audio context or its activation result.
    }
  }

  private readonly stateChanged = (): void => {
    this.publish();
  };

  private readonly returned = (): void => {
    if (this.disposed) return;
    this.publish();
    if (this.document.visibilityState !== 'visible' || !this.snapshot.needsResume) return;
    void this.resume().catch((error: unknown) => {
      if (this.disposed) return;
      try {
        this.onError(error);
      } catch {
        // Error reporting cannot change playback state.
      }
    });
  };

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.context.removeEventListener('statechange', this.stateChanged);
    this.document.removeEventListener('visibilitychange', this.returned);
    this.view?.removeEventListener('pageshow', this.returned);
  }
}

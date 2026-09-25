export interface BrowserAudioContextSnapshot {
  /** Preserve browser extensions such as WebKit's interrupted state. */
  readonly state: string;
  readonly currentTime: number;
  readonly sampleRate: number;
  readonly needsResume: boolean;
}

const hosts = new Set<BrowserAudioContextHost>();
const listeners = new Set<(hosts: readonly BrowserAudioContextHost[]) => void>();

/** Viewer controls observe browser devices, without becoming part of native playback. */
export function subscribeBrowserAudioContexts(
  listener: (hosts: readonly BrowserAudioContextHost[]) => void,
): () => void {
  listeners.add(listener);
  try {
    listener([...hosts]);
  } catch {
    // An observer cannot interrupt construction or activation of an audio device.
  }
  return () => listeners.delete(listener);
}

function publishHosts(): void {
  const current = [...hosts];
  for (const listener of listeners) {
    try {
      listener(current);
    } catch {
      // A viewer observer does not own playback or the audio graph.
    }
  }
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
    document.addEventListener('click', this.activated, true);
    document.addEventListener('keydown', this.activated, true);
    this.view?.addEventListener('pageshow', this.returned);
    hosts.add(this);
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
    publishHosts();
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
    this.recover();
  };

  private readonly activated = (): void => {
    if (this.disposed || !this.snapshot.needsResume) return;
    this.recover();
  };

  private recover(): void {
    void this.resume().catch((error: unknown) => {
      if (this.disposed) return;
      try {
        this.onError(error);
      } catch {
        // Error reporting cannot change playback state.
      }
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.context.removeEventListener('statechange', this.stateChanged);
    this.document.removeEventListener('visibilitychange', this.returned);
    this.document.removeEventListener('click', this.activated, true);
    this.document.removeEventListener('keydown', this.activated, true);
    this.view?.removeEventListener('pageshow', this.returned);
    hosts.delete(this);
    publishHosts();
  }
}

/** Red Book track. One CD frame contains 588 stereo PCM samples. */
export interface CdAudioTrack {
  readonly frames: number;
  /** Null represents a data track, which the CD audio device cannot play. */
  readonly pcm: AudioBuffer | null;
}

export interface CdAudioMedium {
  readonly context: BaseAudioContext;
  readonly destination: AudioNode;
  readonly tracks: readonly CdAudioTrack[];
}

/** A selected application host owns its medium and output connection. */
export interface CdAudioMediumLease {
  readonly medium: CdAudioMedium;
  /** Called after all sources have stopped and disconnected. */
  release(): void;
}

export interface CdAudioMediaHost {
  /** Return null when no medium is available. Each successful open owns one lease. */
  open(): CdAudioMediumLease | null;
}

/** No physical Red Book medium is exposed to an ordinary browser tab. */
export class BrowserCdAudioMediaHost implements CdAudioMediaHost {
  open(): CdAudioMediumLease | null { return null; }
}

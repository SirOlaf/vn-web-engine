/** Borrowed DirectShow fullscreen graph audio interface at native 2742D8.
 * The graph owns its lifetime. Native F0160/F05F0 ignore put_Volume's HRESULT. */
export interface BurikoTraditionalMovieGraphAudio {
  putVolume(decibels: number): number;
}

/** Shared F0160/F05F0 policy for the traditional fullscreen graph, separate from MF and surface movies. */
export class BurikoTraditionalMovieAudioPolicy {
  private audio: BurikoTraditionalMovieGraphAudio | null = null;
  private volumeDecibels = 0; // 2742D0 is initialized to zero in the executable.
  private suppression = 0; // 274288, an unnormalized signed DWORD.

  get savedDecibels(): number {
    return this.volumeDecibels;
  }

  get rawSuppression(): number {
    return this.suppression;
  }

  /** F01E0/F08C0 graph ownership binds and releases this borrowed interface. */
  bindBorrowedGraphAudio(audio: BurikoTraditionalMovieGraphAudio): void {
    if (this.audio !== null)
      throw new Error('Buriko traditional movie graph audio is already bound');
    this.audio = audio;
  }

  unbindBorrowedGraphAudio(audio: BurikoTraditionalMovieGraphAudio): void {
    if (this.audio !== audio)
      throw new Error('Buriko traditional movie graph audio owner mismatch');
    this.audio = null;
  }

  /** F05F0: valid unsigned volume writes policy even while suppressed or without a graph. */
  setVolume(rawVolume: number): boolean {
    if (!Number.isSafeInteger(rawVolume))
      throw new RangeError('Buriko traditional movie volume requires an exact DWORD');
    const volume = rawVolume >>> 0;
    if (volume > 128) return false;
    const decibels =
      volume === 0 ? -10000 : Math.trunc(-((0x3200 - volume * 100) / 2.6666666666)) | 0;
    if (this.suppression === 0) this.writeVolume(decibels);
    this.volumeDecibels = decibels;
    return true;
  }

  /** F0160: compare zero-ness, skip same-state writes, and return the old raw DWORD. */
  setSuppression(rawValue: number): number {
    if (!Number.isSafeInteger(rawValue))
      throw new RangeError('Buriko traditional movie suppression requires an exact DWORD');
    const value = rawValue | 0;
    const previous = this.suppression;
    if ((value === 0) === (previous === 0)) return previous;
    this.writeVolume(value === 0 ? this.volumeDecibels : -10000);
    this.suppression = value;
    return previous;
  }

  private writeVolume(decibels: number): void {
    // The native caller intentionally ignores the returned HRESULT; the graph adapter
    // must return it synchronously rather than hiding an asynchronous media operation.
    if (this.audio !== null) void this.audio.putVolume(decibels);
  }
}

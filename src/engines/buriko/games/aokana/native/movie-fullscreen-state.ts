/** These are the actual two queried fields of the separate fullscreen movie controller. */
export interface AokanaFullscreenMovieControllerState {
  nativeState84: number;
  nativeStateB8: number;
}

/** Borrowed IMFVideoDisplayControl-equivalent methods for the current MF epoch. */
export interface AokanaMfMovieDisplayControl {
  repaint(): void;
  resize(width: number, height: number): void;
}

/** The A0/fullscreen owner and frame controller share these native globals, not a surface movie. */
export class AokanaFullscreenMovieState {
  presentationFlag = 0; // 274278, returned by f0ac0.
  controller: AokanaFullscreenMovieControllerState | null = null; // 274290.
  private borrowedDisplay: {
    controller: AokanaFullscreenMovieControllerState;
    control: AokanaMfMovieDisplayControl;
  } | null = null;

  /** The controller owns this service; the shared frame/window route only borrows it. */
  bindDisplayControl(
    controller: AokanaFullscreenMovieControllerState,
    control: AokanaMfMovieDisplayControl,
  ): void {
    if (this.controller !== controller || this.borrowedDisplay !== null)
      throw new Error('Aokana MF display control requires the current unbound controller');
    this.borrowedDisplay = {controller, control};
  }

  unbindDisplayControl(
    controller: AokanaFullscreenMovieControllerState,
    control: AokanaMfMovieDisplayControl,
  ): void {
    if (this.borrowedDisplay?.controller !== controller || this.borrowedDisplay.control !== control)
      throw new Error('Aokana MF display control owner mismatch');
    this.borrowedDisplay = null;
  }

  get displayControl(): AokanaMfMovieDisplayControl | null {
    if (this.borrowedDisplay === null) return null;
    if (this.borrowedDisplay.controller !== this.controller)
      throw new Error('Aokana MF display control outlived its controller');
    return this.borrowedDisplay.control;
  }

  /** f0130 ->10fb10: preserve the two raw state comparisons and absent-controller status. */
  query(): number {
    if (this.controller === null) return 0x80000002;
    return this.controller.nativeState84 === 3 || this.controller.nativeStateB8 === 1 ? 0 : 1;
  }
  /** f0ad0 compares the native query result with zero. */
  suppressesOrdinaryDisplay(): boolean {
    return this.query() === 0;
  }
}

/** These are the actual two queried fields of the separate fullscreen movie controller. */
export interface AokanaFullscreenMovieControllerState {
  nativeState84: number;
  nativeStateB8: number;
}

/** The A0/fullscreen owner and frame controller share these native globals, not a surface movie. */
export class AokanaFullscreenMovieState {
  presentationFlag = 0; // 274278, returned by f0ac0.
  controller: AokanaFullscreenMovieControllerState | null = null; // 274290.

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

import {
  BurikoFullscreenMovieState,
  type BurikoFullscreenMovieControllerState,
} from './movie-fullscreen-state.js';

/** Borrowed 274290 controller with its real 10FA20 volume service.
 * The controller owns stream enumeration, normalization, +90 state and lifetime. */
export interface BurikoMfMovieVolumeController extends BurikoFullscreenMovieControllerState {
  applyVolume(rawVolume: number): number;
}

/** F0430/F0110 policy for the Media Foundation fullscreen controller, separate from DirectShow. */
export class BurikoMfMovieVolumePolicy {
  private borrowedController: BurikoMfMovieVolumeController | null = null;
  private volume = 0; // 27427C is an initialized DWORD, independent of controller +90.

  constructor(readonly fullscreen: BurikoFullscreenMovieState) {}

  get savedVolume(): number {
    return this.volume;
  }

  /** Bind only the same actual controller already published for fullscreen state queries. */
  bindBorrowedController(controller: BurikoMfMovieVolumeController): void {
    if (this.borrowedController !== null)
      throw new Error('Buriko MF movie volume controller is already bound');
    if (this.fullscreen.controller !== controller)
      throw new Error('Buriko MF volume service requires the shared fullscreen controller');
    this.borrowedController = controller;
  }

  unbindBorrowedController(controller: BurikoMfMovieVolumeController): void {
    if (this.borrowedController !== controller)
      throw new Error('Buriko MF movie volume controller owner mismatch');
    this.borrowedController = null;
  }

  /** F0430: absent controller leaves saved policy untouched; a live one stores first if requested. */
  applyVolume(rawVolume: number, savePolicy: number): number {
    const value = this.nativeDword(rawVolume);
    const controller = this.currentController();
    if (controller === null) return 0x80000002;
    if (savePolicy !== 0) this.volume = value;
    return this.callControllerVolume(controller, value) < 0 ? 0x80000001 : 0;
  }

  /** F0110: temporary zero on minimize, saved raw volume on restore; discard F0430 status. */
  applyWindowSuppression(minimized: number): void {
    void this.applyVolume(minimized === 0 ? this.volume : 0, 0);
  }

  /** F0AF0's successful controller-construction path stores raw policy, then ignores 10FA20 HRESULT. */
  initializeForNewController(rawVolume: number): void {
    const value = this.nativeDword(rawVolume);
    const controller = this.currentController();
    if (controller === null)
      throw new Error('Buriko MF initial volume requires the actual fullscreen controller');
    this.volume = value;
    void this.callControllerVolume(controller, value);
  }

  private currentController(): BurikoMfMovieVolumeController | null {
    const current = this.fullscreen.controller;
    if (current === null) return null;
    if (this.borrowedController === null || this.borrowedController !== current)
      throw new Error('Buriko MF fullscreen controller has no matching volume service');
    return this.borrowedController;
  }

  private nativeDword(value: number): number {
    if (!Number.isSafeInteger(value))
      throw new RangeError('Buriko MF movie volume requires an exact DWORD');
    return value | 0;
  }

  private callControllerVolume(controller: BurikoMfMovieVolumeController, value: number): number {
    const result = controller.applyVolume(value);
    if (!Number.isSafeInteger(result))
      throw new Error('Buriko MF volume service requires a synchronous HRESULT');
    return result | 0;
  }
}

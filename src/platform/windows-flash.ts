/** Borrowed, top-down 32-bit DIB memory owned by the selected ActiveX control.
 * The fourth byte is retained even though the native surface is RGB. */
export interface WindowsFlashBitmap {
  readonly bytes: Uint8Array;
  readonly offset: number;
  readonly stride: number;
  readonly width: number;
  readonly height: number;
}

export interface WindowsFlashIntegerResult {
  readonly hresult: number;
  readonly value: number;
}

type FlashResult<T> = T | Promise<T>;

/** IShockwaveFlash and OleDraw on one hidden window hosted by the selected
 * project window. HRESULT zero is success for these native callers. Methods
 * finish all borrowed DIB writes before their result settles. */
export interface WindowsFlashControl {
  bitmap(): WindowsFlashBitmap | null;
  putMovie(path: string): FlashResult<number>;
  putLoop(repeat: boolean): FlashResult<number>;
  play(): FlashResult<number>;
  totalFrames(): FlashResult<WindowsFlashIntegerResult>;
  frameNumber(): FlashResult<WindowsFlashIntegerResult>;
  gotoFrame(frame: number): FlashResult<number>;
  isPlaying(): FlashResult<WindowsFlashIntegerResult>;
  /** OleDraw(DVASPECT_CONTENT) into the owned DIB. Abort joins outstanding writes. */
  draw(signal: AbortSignal): FlashResult<number>;
  /** Yield between unsuccessful initial OleDraw attempts; abort must settle the wait. */
  waitForDrawRetry(signal: AbortSignal): Promise<void>;
  /** Release the COM control, DIB, DC, events and hidden window after pending calls finish. */
  dispose(): FlashResult<void>;
}

export interface WindowsFlashCreation {
  /** Native worker initialization status; a nonzero status may still own a DIB. */
  readonly status: number;
  readonly control: WindowsFlashControl | null;
}

/** Explicit Flash ActiveX hosting boundary. Hosts bind their selected parent window
 * and file namespace. This is neither an HTML movie element nor a script evaluator.
 * Native class D27CDB6E-AE6D-11CF-96B8-444553540000, interface D27CDB6C-... . */
export interface WindowsFlashHost {
  create(width: number, height: number): FlashResult<WindowsFlashCreation>;
}

/** A browser has no COM Flash control. The worker reports COM creation failure;
 * its caller subsequently observes that no DIB was created. */
export class BrowserWindowsFlashHost implements WindowsFlashHost {
  create(_width: number, _height: number): WindowsFlashCreation {
    return {status: 0x80000005, control: null};
  }
}

/** Opaque executable instance identity supplied by the selected host at startup. */
export type WindowsModuleHandle = object;

/** Synchronous WinMM PlaySoundW boundary. The return value is the immediate BOOL. */
export interface WindowsPlaySoundHost {
  readonly executableModule: WindowsModuleHandle;
  playSoundW(filename: string, module: WindowsModuleHandle, flags: number): number;
}

/** A browser cannot synchronously admit WinMM playback, so its BOOL is FALSE. */
export class BrowserWindowsPlaySoundHost implements WindowsPlaySoundHost {
  readonly executableModule: WindowsModuleHandle = {};

  playSoundW(_filename: string, module: WindowsModuleHandle, _flags: number): 0 {
    if (module !== this.executableModule)
      throw new TypeError('PlaySoundW received another executable module');
    return 0;
  }
}

/** Browsers cannot change the operating system's desktop wallpaper. */
export class BrowserWindowsDesktopWallpaperHost {
  setWallpaper(_path: string, _flags: number): false { return false; }
}

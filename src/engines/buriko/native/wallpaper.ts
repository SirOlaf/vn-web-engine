import type {BurikoBpPointer} from '../bp/memory.js';
import {pop32} from '../bp/state.js';
import type {BurikoNativeSlotDefinition} from './types.js';
import {BurikoNativeRegistry} from './windows-registry.js';
import {BurikoNativeText} from './text.js';
import {BrowserWindowsDesktopWallpaperHost} from '../../../platform/windows-desktop-wallpaper.js';

/** Explicit SystemParametersInfoW-shaped desktop effect selected by the host. */
export interface BurikoDesktopWallpaperHost {
  setWallpaper(path: string, flags: number): boolean | Promise<boolean>;
}

/** Browsers provide no SystemParametersInfoW desktop-wallpaper operation. */
export class BurikoBrowserDesktop
  extends BrowserWindowsDesktopWallpaperHost
  implements BurikoDesktopWallpaperHost {}

/** 1400fece0 deliberately retains the opened registry handle and ignores each API result. */
export class BurikoWallpaper {
  constructor(
    readonly registry: BurikoNativeRegistry,
    readonly desktop: BurikoDesktopWallpaperHost,
    readonly text: BurikoNativeText,
  ) {}
  async set(filename: BurikoBpPointer | null, stretch: number, tile: number): Promise<void> {
    const opened = await this.registry.createKey(
      0xffffffff80000001n,
      'control panel\\desktop',
      0x20006,
    );
    if (opened.handle === undefined)
      throw new Error(
        'Buriko wallpaper uses its unwritten native registry handle after RegCreateKeyExW failure',
      );
    await this.registry.setValue(
      opened.handle,
      'WallpaperStyle',
      1,
      Uint8Array.of(stretch === 0 ? 48 : 50, 0, 0, 0),
    );
    await this.registry.setValue(
      opened.handle,
      'TileWallpaper',
      1,
      Uint8Array.of(tile === 0 ? 48 : 49, 0, 0, 0),
    );
    if (filename === null) throw new Error('Buriko wallpaper dereferences a null native filename');
    const path = this.text.decodeAuto(filename);
    if (path.length > 783)
      throw new RangeError('Buriko wallpaper overwrites its native wide path stack allocation');
    await this.desktop.setWallpaper(path, 3);
  }
}

export function createGroupB0Wallpaper(wallpaper: BurikoWallpaper): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0xb0,
      secondary: 0xf0,
      nativeAddress: 0x1400d3f10,
      name: 'SetDesktopWallpaper',
      execute: async (h): Promise<0> => {
        const tile = pop32(h.thread),
          stretch = pop32(h.thread),
          filename = h.memory.resolve(h.thread, pop32(h.thread));
        await wallpaper.set(filename, stretch, tile);
        return 0;
      },
    },
  ];
}

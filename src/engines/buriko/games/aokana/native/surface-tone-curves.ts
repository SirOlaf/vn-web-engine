import {pointerView, type AokanaBpPointer} from '../bp/memory.js';
import {threeKnotPath} from './three-knot-path.js';

export interface AokanaSurfaceToneCurve {
  readonly key: number;
  /** Native red+4, green+404, blue+804 DWORD arrays. */
  readonly values: Uint32Array;
}

/** Surface manager+128: actual keyed nodes shared by 041920/0418C0/03E630. */
export class AokanaSurfaceToneCurves {
  private readonly entries: AokanaSurfaceToneCurve[] = [];
  find(key: number): AokanaSurfaceToneCurve | null {
    return this.entries.find((entry) => entry.key === (key | 0)) ?? null;
  }
  remove(key: number): 0 | 0x10 {
    const at = this.entries.findIndex((entry) => entry.key === (key | 0));
    if (at < 0) return 0x10;
    this.entries.splice(at, 1);
    return 0;
  }
  set(key: number, pointer: AokanaBpPointer): 0 | 0x16 {
    const read = (offset: number) =>
      pointerView({bytes: pointer.bytes, offset: pointer.offset + offset}, 4).getUint32(0, true);
    for (let channel = 0; channel < 3; channel++)
      if ((read(channel * 8) - 1) >>> 0 > 253 || read(channel * 8 + 4) > 255) return 0x16;
    let entry = this.find(key);
    if (entry === null) {
      entry = {key: key | 0, values: new Uint32Array(768)};
      this.entries.unshift(entry);
    }
    for (let channel = 2; channel >= 0; channel--) {
      const path = threeKnotPath(0, 0, read(channel * 8), read(channel * 8 + 4), 255, 255, 256);
      if (path === null)
        throw new Error('Aokana tone curve consumes unwritten interpolation scratch');
      for (let index = 0; index < 256; index++)
        entry.values[channel * 256 + index] =
          Math.max(0, Math.min(255, path[index * 2 + 1]!)) << ((2 - channel) * 8);
    }
    return 0;
  }
  /** 032950 retains the facade's unusual unsigned status masks. */
  configure(key: number, pointer: AokanaBpPointer | null): number {
    return pointer === null ? (this.remove(key) === 0 ? 0 : 0x8000000f) : this.set(key, pointer);
  }
}

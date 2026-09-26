import {pop32} from '../bp/state.js';
import type {AokanaSurfaces} from './surfaces.js';
import type {AokanaEngineErrors} from './engine-errors.js';
import type {AokanaBpOpcodeContext, AokanaNativeSlotDefinition} from './types.js';
export function createGroup90SurfaceMirrorReduce(
  surfaces: AokanaSurfaces,
  errors: AokanaEngineErrors,
): AokanaNativeSlotDefinition[] {
  const fatal = (h: AokanaBpOpcodeContext, message: string): Promise<never> =>
    errors.threadFatal(h.thread, h.diagnostics, surfaces.fonts.text.encodeWide(message, 0));
  const execute = (h: AokanaBpOpcodeContext, mirror: boolean): 0 | Promise<never> => {
    const mode = mirror ? pop32(h.thread) : 0,
      source = pop32(h.thread),
      destination = pop32(h.thread);
    if (destination >>> 0 >= 0x4000)
      return fatal(h, `無効なビットマップ番号 [ ${destination | 0} ] が指定されました`);
    if (source >>> 0 >= 0x4000)
      return fatal(h, `無効なビットマップ番号 [ ${source | 0} ] が指定されました`);
    const status = mirror
      ? surfaces.mirrorSurface(destination, source, mode)
      : surfaces.reduceSurfaceHalf(destination, source);
    if (status === 0x80000009)
      return fatal(h, `出力先に指定されたビットマップ [ ${destination | 0} ] は無効です`);
    if (status === 0x8000000a)
      return fatal(h, `参照元に指定されたビットマップ [ ${source | 0} ] は無効です`);
    if (mirror && status === 0x80000016)
      return fatal(h, `無効な方向 [ ${mode | 0} ] が指定されました`);
    if (!mirror && status === 0x80000006)
      return fatal(h, `参照元に指定されたビットマップ [ ${source | 0} ] は小さすぎます`);
    return 0;
  };
  return [
    {
      primary: 0x90,
      secondary: 0xc2,
      nativeAddress: 0x1400d78b0,
      name: 'MirrorSurface',
      execute: (h) => execute(h, true),
    },
    {
      primary: 0x90,
      secondary: 0xc3,
      nativeAddress: 0x1400d77d0,
      name: 'ReduceSurfaceHalf',
      execute: (h) => execute(h, false),
    },
  ];
}

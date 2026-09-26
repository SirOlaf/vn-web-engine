import {pop32} from '../bp/state.js';
import type {BurikoSurfaces} from './surfaces.js';
import type {BurikoEngineErrors} from './engine-errors.js';
import type {BurikoBpOpcodeContext, BurikoNativeSlotDefinition} from './types.js';

export function createGroup91SurfaceTransform(
  surfaces: BurikoSurfaces,
  errors: BurikoEngineErrors,
): BurikoNativeSlotDefinition[] {
  const execute = (h: BurikoBpOpcodeContext, blend: boolean): 0 | Promise<never> => {
    const sampling = pop32(h.thread),
      transparency = pop32(h.thread),
      scaleY = pop32(h.thread),
      scaleX = pop32(h.thread),
      angle = pop32(h.thread),
      pivotY = pop32(h.thread),
      pivotX = pop32(h.thread),
      source = pop32(h.thread),
      y = pop32(h.thread),
      x = pop32(h.thread),
      destination = pop32(h.thread);
    const fatal = (message: string) =>
      errors.threadFatal(h.thread, h.diagnostics, surfaces.fonts.text.encodeWide(message, 0));
    if (transparency >>> 0 > 256)
      return fatal(
        `無効なエフェクトレベル／トランスペアレンシィ／オパシティ／アディションレベル [ ${transparency | 0} ] が指定されました`,
      );
    const status = surfaces.transformSurface(
      destination,
      source,
      {x, y, pivotX, pivotY, angle, scaleX, scaleY},
      transparency,
      sampling,
      blend,
    );
    if (status === 1)
      return fatal(`出力先として指定されたビットマップ [ ${destination | 0} ] は無効です`);
    if (status === 2)
      return fatal(`参照元として指定されたビットマップ [ ${source | 0} ] は無効です`);
    if (status === 3)
      return fatal(`無効な伸縮倍率 [ ${scaleX | 0} , ${scaleY | 0} ] が指定されました`);
    return 0;
  };
  return [
    {
      primary: 0x91,
      secondary: 0x18,
      nativeAddress: 0x1400e1ee0,
      name: 'BlendTransformedSurface',
      execute: (h) => execute(h, true),
    },
    {
      primary: 0x91,
      secondary: 0x19,
      nativeAddress: 0x1400e1d50,
      name: 'CopyTransformedSurface',
      execute: (h) => execute(h, false),
    },
  ];
}

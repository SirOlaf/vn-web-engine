import {pop32} from '../bp/state.js';
import type {AokanaSurfaces} from './surfaces.js';
import type {AokanaEngineErrors} from './engine-errors.js';
import type {AokanaBpOpcodeContext, AokanaNativeSlotDefinition} from './types.js';

export function createGroup91SurfaceColorMaskCopy(
  surfaces: AokanaSurfaces,
  errors: AokanaEngineErrors,
): AokanaNativeSlotDefinition[] {
  const fatal = (h: AokanaBpOpcodeContext, message: string): Promise<never> =>
    errors.threadFatal(h.thread, h.diagnostics, surfaces.fonts.text.encodeWide(message, 0));
  const finish = (
    h: AokanaBpOpcodeContext,
    status: number,
    destination: number,
    source: number,
    kind: 'recolor' | 'effect' | 'mask' | 'copy',
    selector = 0,
  ): 0 | Promise<never> => {
    if (status === 1)
      return fatal(
        h,
        `指定された${kind === 'mask' ? '対象' : '出力先'}ビットマップ [ ${destination | 0} ] は無効です`,
      );
    if (status === 2)
      return fatal(
        h,
        `指定された${kind === 'copy' ? '複写元' : '参照元'}ビットマップ [ ${source | 0} ] は無効です`,
      );
    if (kind === 'effect' && status === 6)
      return fatal(h, `指定された処理タイプ [ ${selector | 0} ] は無効です`);
    if (kind === 'mask' && status === 3)
      return fatal(
        h,
        `指定された参照元ビットマップ [ ${source | 0} ] はグレイスケールではありません`,
      );
    return 0;
  };
  return [
    {
      primary: 0x91,
      secondary: 0x1a,
      nativeAddress: 0x1400e1ca0,
      name: 'RecolorSurfacePreservingAlpha',
      execute: (h) => {
        const color = pop32(h.thread),
          source = pop32(h.thread),
          destination = pop32(h.thread);
        return finish(
          h,
          surfaces.recolorSurface(destination, source, color),
          destination,
          source,
          'recolor',
        );
      },
    },
    {
      primary: 0x91,
      secondary: 0x1d,
      nativeAddress: 0x1400e1930,
      name: 'ApplySurfaceColorEffect',
      execute: (h) => {
        const level = pop32(h.thread),
          color = pop32(h.thread),
          selector = pop32(h.thread),
          source = pop32(h.thread),
          destination = pop32(h.thread);
        if (level >>> 0 > 256)
          return fatal(
            h,
            `無効なエフェクトレベル／トランスペアレンシィ／オパシティ／アディションレベル [ ${level | 0} ] が指定されました`,
          );
        return finish(
          h,
          surfaces.applySurfaceColorEffect(destination, source, selector, color, level),
          destination,
          source,
          'effect',
          selector,
        );
      },
    },
    {
      primary: 0x91,
      secondary: 0x1e,
      nativeAddress: 0x1400e1850,
      name: 'ApplySurfaceMask',
      execute: (h) => {
        const y = pop32(h.thread),
          x = pop32(h.thread),
          source = pop32(h.thread),
          destination = pop32(h.thread);
        return finish(
          h,
          surfaces.applySurfaceMask(destination, source, x, y),
          destination,
          source,
          'mask',
        );
      },
    },
    {
      primary: 0x91,
      secondary: 0x1f,
      nativeAddress: 0x1400e17b0,
      name: 'DuplicateSurface',
      execute: (h) => {
        const source = pop32(h.thread),
          destination = pop32(h.thread);
        return finish(
          h,
          surfaces.duplicateSurface(destination, source),
          destination,
          source,
          'copy',
        );
      },
    },
  ];
}

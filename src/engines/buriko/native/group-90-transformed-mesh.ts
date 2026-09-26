import {pop32} from '../bp/state.js';
import type {BurikoEngineErrors} from './engine-errors.js';
import type {BurikoSurfaces} from './surfaces.js';
import type {BurikoNativeSlotDefinition} from './types.js';
import {drawBurikoSurfaceTransformedMesh} from './surface-transformed-mesh.js';

export function createGroup90TransformedMesh(
  surfaces: BurikoSurfaces,
  errors: BurikoEngineErrors,
): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x90,
      secondary: 0xc8,
      nativeAddress: 0x1400d7340,
      name: 'DrawSurfaceTransformedMesh',
      execute: (h) => {
        const transparency = pop32(h.thread),
          mode = pop32(h.thread),
          perspective = pop32(h.thread),
          rotationOrder = pop32(h.thread),
          bank = pop32(h.thread),
          heading = pop32(h.thread),
          pitch = pop32(h.thread),
          translationZ = pop32(h.thread),
          translationY = pop32(h.thread),
          translationX = pop32(h.thread),
          scaleY = pop32(h.thread),
          scaleX = pop32(h.thread),
          sourcePivotY = pop32(h.thread),
          sourcePivotX = pop32(h.thread),
          source = pop32(h.thread),
          destinationPivotY = pop32(h.thread),
          destinationPivotX = pop32(h.thread),
          destination = pop32(h.thread);
        const result = drawBurikoSurfaceTransformedMesh(surfaces, {
          destination,
          destinationPivotX,
          destinationPivotY,
          source,
          sourcePivotX,
          sourcePivotY,
          scaleX,
          scaleY,
          translationX,
          translationY,
          translationZ,
          pitch,
          heading,
          bank,
          rotationOrder,
          perspective,
          mode,
          transparency,
        });
        if (result === 0x80000009 || result === 0x8000000a) {
          const message =
            result === 0x80000009
              ? `生成先に指定されたビットマップ [ ${destination | 0} ] は無効です`
              : `参照元に指定されたビットマップ [ ${source | 0} ] は無効です`;
          return errors.threadFatal(
            h.thread,
            h.diagnostics,
            surfaces.fonts.text.encodeWide(message, 0),
          );
        }
        return 0;
      },
    },
  ];
}

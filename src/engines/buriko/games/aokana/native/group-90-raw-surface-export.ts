import {pop32} from '../bp/state.js';
import type {AokanaRawSurfaceExport} from './raw-surface-export.js';
import type {AokanaEngineErrors} from './engine-errors.js';
import type {AokanaNativeSlotDefinition} from './types.js';

export function createGroup90RawSurfaceExport(
  service: AokanaRawSurfaceExport,
  errors: AokanaEngineErrors,
): AokanaNativeSlotDefinition[] {
  return [
    {
      primary: 0x90,
      secondary: 0x15,
      nativeAddress: 0x1400dd6a0,
      name: 'ExportRawSurface',
      execute: (h) => {
        const index = pop32(h.thread),
          capacity = pop32(h.thread),
          count = h.memory.resolve(h.thread, pop32(h.thread)),
          output = h.memory.resolve(h.thread, pop32(h.thread));
        const fatal = (message: string) =>
          errors.threadFatal(
            h.thread,
            h.diagnostics,
            service.surfaces.fonts.text.encodeWide(message, 0),
          );
        if (index >>> 0 >= 0x4000)
          return fatal(`無効なビットマップ番号 [ ${index | 0} ] が指定されました`);
        const result = service.export(output, count, capacity, index);
        if (result === 9) return fatal(`指定されたビットマップ [ ${index | 0} ] は存在しません`);
        if (result === 10)
          return fatal(
            `指定されたイメージの格納先のサイズ [ ${capacity | 0} ] ではイメージを取得できません`,
          );
        return 0;
      },
    },
  ];
}

import {pop32, push32} from '../bp/state.js';
import type {BurikoEngineErrors} from './engine-errors.js';
import type {BurikoFilterDisplays} from './filter-displays.js';
import type {BurikoBpOpcodeContext, BurikoNativeSlotDefinition} from './types.js';

/** Bank 90:60,61,64-66, the complete scene-facing CDspObjFilter family. */
export function createGroup90Filters(
  filters: BurikoFilterDisplays,
  errors: BurikoEngineErrors,
): BurikoNativeSlotDefinition[] {
  const fatal = (context: BurikoBpOpcodeContext, message: string): Promise<never> =>
      errors.threadFatal(
        context.thread,
        context.diagnostics,
        errors.files.text.encodeWide(message, 0),
      ),
    invalidHandle = (context: BurikoBpOpcodeContext): Promise<never> =>
      fatal(context, '無効なフィルターハンドルが指定されました'),
    validateCommon = (
      context: BurikoBpOpcodeContext,
      priority: number,
      effectLevel: number,
    ): Promise<never> | null => {
      if (priority >>> 0 >= 0x10000)
        return fatal(context, `無効なプライオリティ [ ${priority | 0} ] が指定されました`);
      if (effectLevel >>> 0 > 0x100)
        return fatal(
          context,
          `無効なエフェクトレベル／トランスペアレンシィ／オパシティ／アディションレベル [ ${effectLevel | 0} ] が指定されました`,
        );
      return null;
    };

  return [
    {
      primary: 0x90,
      secondary: 0x60,
      nativeAddress: 0x1400d9ad0,
      name: 'CreateFilterDisplay',
      execute: (context) => {
        const handle = filters.createFilter();
        if (handle === 0)
          return fatal(context, 'これ以上、フィルターオブジェクトを生成する事は出来ません');
        push32(context.thread, handle);
        return 0;
      },
    },
    {
      primary: 0x90,
      secondary: 0x61,
      nativeAddress: 0x1400d9a90,
      name: 'DestroyFilterDisplay',
      execute: (context) =>
        filters.destroyFilter(pop32(context.thread)) ? 0 : invalidHandle(context),
    },
    {
      primary: 0x90,
      secondary: 0x64,
      nativeAddress: 0x1400d9a40,
      name: 'SetFilterActivation',
      execute: (context) => {
        const activation = pop32(context.thread),
          handle = pop32(context.thread);
        return filters.setFilterActivation(handle, activation) ? 0 : invalidHandle(context);
      },
    },
    {
      primary: 0x90,
      secondary: 0x65,
      nativeAddress: 0x1400d9990,
      name: 'ConfigureColorFilter',
      execute: (context) => {
        const priority = pop32(context.thread),
          effectLevel = pop32(context.thread),
          color = pop32(context.thread),
          handle = pop32(context.thread),
          invalid = validateCommon(context, priority, effectLevel);
        if (invalid !== null) return invalid;
        return filters.configureFilter(handle, 0, color, -1, 0, effectLevel, priority) === -1
          ? invalidHandle(context)
          : 0;
      },
    },
    {
      primary: 0x90,
      secondary: 0x66,
      nativeAddress: 0x1400d9830,
      name: 'ConfigureMaskFilter',
      execute: (context) => {
        const priority = pop32(context.thread),
          effectLevel = pop32(context.thread),
          maskShift = pop32(context.thread),
          maskSurface = pop32(context.thread),
          color = pop32(context.thread),
          operation = pop32(context.thread),
          handle = pop32(context.thread),
          invalid = validateCommon(context, priority, effectLevel);
        if (invalid !== null) return invalid;
        switch (
          filters.configureFilter(
            handle,
            operation,
            color,
            maskSurface,
            maskShift,
            effectLevel,
            priority,
          )
        ) {
          case -1:
            return invalidHandle(context);
          case 1:
            return fatal(context, `無効なビットマップ番号 [ ${maskSurface | 0} ] が指定されました`);
          case 2:
            return fatal(
              context,
              `指定されたビットマップ [ ${maskSurface | 0} ] はグレイスケールではありません`,
            );
          case 3:
            return fatal(
              context,
              `指定されたビットマップ [ ${maskSurface | 0} ] はスクリーンサイズではありません`,
            );
          default:
            return 0;
        }
      },
    },
  ];
}

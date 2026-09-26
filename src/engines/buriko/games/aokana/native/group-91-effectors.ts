import {pop32, push32} from '../bp/state.js';
import type {AokanaEngineErrors} from './engine-errors.js';
import type {AokanaFilterDisplays} from './filter-displays.js';
import type {AokanaBpOpcodeContext, AokanaNativeSlotDefinition} from './types.js';

/** Bank 91:60,61,64-69, the complete scene-facing CDspObjEffector family. */
export function createGroup91Effectors(
  filters: AokanaFilterDisplays,
  errors: AokanaEngineErrors,
): AokanaNativeSlotDefinition[] {
  const fatal = (context: AokanaBpOpcodeContext, message: string): Promise<never> =>
      errors.threadFatal(
        context.thread,
        context.diagnostics,
        errors.files.text.encodeWide(message, 0),
      ),
    invalidHandle = (context: AokanaBpOpcodeContext): Promise<never> =>
      fatal(context, '無効なエフェクターハンドルが指定されました'),
    validateCommon = (
      context: AokanaBpOpcodeContext,
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
      primary: 0x91,
      secondary: 0x60,
      nativeAddress: 0x1400e0be0,
      name: 'CreateEffectorDisplay',
      execute: (context) => {
        const handle = filters.createEffector();
        if (handle === 0)
          return fatal(context, 'これ以上、エフェクターオブジェクトを生成する事は出来ません');
        push32(context.thread, handle);
        return 0;
      },
    },
    {
      primary: 0x91,
      secondary: 0x61,
      nativeAddress: 0x1400e0ba0,
      name: 'DestroyEffectorDisplay',
      execute: (context) =>
        filters.destroyEffector(pop32(context.thread)) ? 0 : invalidHandle(context),
    },
    {
      primary: 0x91,
      secondary: 0x64,
      nativeAddress: 0x1400e0b50,
      name: 'SetEffectorActivation',
      execute: (context) => {
        const activation = pop32(context.thread),
          handle = pop32(context.thread);
        return filters.setEffectorActivation(handle, activation) ? 0 : invalidHandle(context);
      },
    },
    {
      primary: 0x91,
      secondary: 0x65,
      nativeAddress: 0x1400e09e0,
      name: 'ConfigureVectorMapEffector',
      execute: (context) => {
        const priority = pop32(context.thread),
          sampling = pop32(context.thread),
          effectLevel = pop32(context.thread),
          secondaryMap = pop32(context.thread),
          primaryMap = pop32(context.thread),
          handle = pop32(context.thread),
          invalid = validateCommon(context, priority, effectLevel);
        if (invalid !== null) return invalid;
        switch (
          filters.configureVectorEffector(
            handle,
            primaryMap,
            secondaryMap,
            effectLevel,
            sampling,
            priority,
          )
        ) {
          case -1:
            return invalidHandle(context);
          case 1:
            return fatal(
              context,
              `第一ベクトルマップとして指定されたビットマップ [ ${primaryMap | 0} ] は無効です`,
            );
          case 2:
            return fatal(
              context,
              `第二ベクトルマップとして指定されたビットマップ [ ${secondaryMap | 0} ] は無効です`,
            );
          case 3:
            return fatal(
              context,
              `第一ベクトルマップとして指定されたビットマップ [ ${primaryMap | 0} ] はベクトルマップではない、\n\n若しくはスクリーンサイズとピクセル数が一致していません`,
            );
          case 4:
            return fatal(
              context,
              `第二ベクトルマップとして指定されたビットマップ [ ${secondaryMap | 0} ] はベクトルマップではない、\n\n若しくはスクリーンサイズとピクセル数が一致していません`,
            );
          default:
            return 0;
        }
      },
    },
    {
      primary: 0x91,
      secondary: 0x66,
      nativeAddress: 0x1400e0910,
      name: 'ConfigureBlurEffector',
      execute: (context) => {
        const priority = pop32(context.thread),
          effectLevel = pop32(context.thread),
          selector = pop32(context.thread),
          handle = pop32(context.thread),
          invalid = validateCommon(context, priority, effectLevel);
        if (invalid !== null) return invalid;
        const result = filters.configureBlurEffector(handle, selector, effectLevel, priority);
        if (result === -1) return invalidHandle(context);
        return result === 5
          ? fatal(context, `指定されたグラデーションタイプ [ ${selector | 0} ] は無効です`)
          : 0;
      },
    },
    {
      primary: 0x91,
      secondary: 0x67,
      nativeAddress: 0x1400e0760,
      name: 'ConfigureDisplacementEffector',
      execute: (context) => {
        const priority = pop32(context.thread),
          effectLevel = pop32(context.thread),
          coefficientSlot = pop32(context.thread),
          maximumDistance = pop32(context.thread),
          mapSurface = pop32(context.thread),
          handle = pop32(context.thread),
          invalid = validateCommon(context, priority, effectLevel);
        if (invalid !== null) return invalid;
        switch (
          filters.configureDisplacementEffector(
            handle,
            mapSurface,
            maximumDistance,
            coefficientSlot,
            effectLevel,
            priority,
          )
        ) {
          case -1:
            return invalidHandle(context);
          case 1:
            return fatal(
              context,
              `ベクトル＆ディスタンスマップとして指定されたビットマップ [ ${mapSurface | 0} ] は無効です`,
            );
          case 3:
            return fatal(
              context,
              `指定されたビットマップ [ ${mapSurface | 0} ] はベクトル＆ディスタンスマップではない、\n\n或いはスクリーンサイズと一致していません`,
            );
          case 6:
            return fatal(
              context,
              `無効なディスタンスの最大値 [ ${maximumDistance | 0} ] が指定されました`,
            );
          case 7:
            return fatal(context, `指定された波紋 [ ${coefficientSlot | 0} ] は登録されていません`);
          case 8:
            return fatal(
              context,
              `指定された波紋 [ ${coefficientSlot | 0} ] はベクトル＆ディスタンスマップ [ ${mapSurface | 0} ] に適合しません`,
            );
          default:
            return 0;
        }
      },
    },
    {
      primary: 0x91,
      secondary: 0x68,
      nativeAddress: 0x1400e0630,
      name: 'ConfigureTransformEffector',
      execute: (context) => {
        const priority = pop32(context.thread),
          effectLevel = pop32(context.thread),
          transparency = pop32(context.thread),
          scaleY = pop32(context.thread),
          scaleX = pop32(context.thread),
          angle = pop32(context.thread),
          pivotY = pop32(context.thread),
          pivotX = pop32(context.thread),
          handle = pop32(context.thread),
          invalid = validateCommon(context, priority, effectLevel);
        if (invalid !== null) return invalid;
        const result = filters.configureTransformEffector(
          handle,
          pivotX,
          pivotY,
          angle,
          scaleX,
          scaleY,
          transparency,
          effectLevel,
          priority,
        );
        if (result === -1) return invalidHandle(context);
        return result === 9
          ? fatal(context, `無効な伸縮倍率 [ ${scaleX | 0} , ${scaleY | 0} ] が指定されました`)
          : 0;
      },
    },
    {
      primary: 0x91,
      secondary: 0x69,
      nativeAddress: 0x1400e05a0,
      name: 'ConfigureFeedbackEffector',
      execute: (context) => {
        const priority = pop32(context.thread),
          effectLevel = pop32(context.thread),
          handle = pop32(context.thread),
          invalid = validateCommon(context, priority, effectLevel);
        if (invalid !== null) return invalid;
        return filters.configureFeedbackEffector(handle, effectLevel, priority) === -1
          ? invalidHandle(context)
          : 0;
      },
    },
  ];
}

import {pop32} from '../bp/state.js';
import {BurikoDisplayManager} from './display-manager.js';
import {BurikoEngineErrors} from './engine-errors.js';
import type {BurikoBpOpcodeContext, BurikoNativeSlotDefinition} from './types.js';

type Validation = 0 | Promise<never>;

/** Bank 90:56-5D, the eight scene-facing CDspObjSprite configuration wrappers. */
export function createGroup90SpriteConfiguration(
  manager: BurikoDisplayManager,
  errors: BurikoEngineErrors,
): BurikoNativeSlotDefinition[] {
  const fatal = (context: BurikoBpOpcodeContext, message: string): Promise<never> =>
    errors.threadFatal(
      context.thread,
      context.diagnostics,
      errors.files.text.encodeWide(message, 0),
    );
  const validatePriority = (context: BurikoBpOpcodeContext, value: number): Validation =>
    value >= 0x10000 ? fatal(context, `無効なプライオリティ [ ${value | 0} ] が指定されました`) : 0;
  const validateEffectLevel = (context: BurikoBpOpcodeContext, value: number): Validation =>
    value > 0x100
      ? fatal(
          context,
          `無効なエフェクトレベル／トランスペアレンシィ／オパシティ／アディションレベル [ ${value | 0} ] が指定されました`,
        )
      : 0;
  const validateEffectMode = (context: BurikoBpOpcodeContext, value: number): Validation =>
    value <= 9 ||
    (value >= 0x20 && value <= 0x27) ||
    value === 0x40 ||
    value === 0x41 ||
    value === 0x80 ||
    value === 0xc0 ||
    value === 0xc1 ||
    value === 0xf0 ||
    value === 0xff
      ? 0
      : fatal(context, `無効なエフェクトモード [ ${value | 0} ] が指定されました`);
  const validateBitmapNumber = (context: BurikoBpOpcodeContext, value: number): Validation =>
    value >= 0x4000
      ? fatal(context, `無効なビットマップ番号 [ ${value | 0} ] が指定されました`)
      : 0;
  const validateMixRatio = (context: BurikoBpOpcodeContext, value: number): Validation =>
    value > 0x100 ? fatal(context, `無効な混合比 [ ${value | 0} ] が指定されました`) : 0;
  const validateTransparency = (context: BurikoBpOpcodeContext, value: number): Validation =>
    value > 0x100 ? fatal(context, `無効な透明度 [ ${value | 0} ] が指定されました`) : 0;
  const invalidHandle = (context: BurikoBpOpcodeContext): Promise<never> =>
    fatal(context, '無効なスプライトハンドルが指定されました');
  const validate = (...checks: (() => Validation)[]): Validation => {
    for (const check of checks) {
      const result = check();
      if (result !== 0) return result;
    }
    return 0;
  };

  return [
    {
      primary: 0x90,
      secondary: 0x56,
      nativeAddress: 0x1400da8f0,
      name: 'InitializeSimpleSprite',
      execute: (context) => {
        const layer = pop32(context.thread),
          blendValue = pop32(context.thread),
          blendMode = pop32(context.thread),
          sourceSurface = pop32(context.thread),
          y = pop32(context.thread),
          x = pop32(context.thread),
          handle = pop32(context.thread),
          checked = validate(
            () => validatePriority(context, layer),
            () => validateEffectLevel(context, blendValue),
            () => validateEffectMode(context, blendMode),
            () => validateBitmapNumber(context, sourceSurface),
          );
        if (checked !== 0) return checked;
        const result = manager.initializeSimpleSprite(
          handle,
          x,
          y,
          sourceSurface,
          blendMode,
          blendValue,
          layer,
        );
        if (result === 1)
          return fatal(context, `指定されたビットマップ [ ${sourceSurface | 0} ] は無効です`);
        return result === 0xffffffff ? invalidHandle(context) : 0;
      },
    },
    {
      primary: 0x90,
      secondary: 0x57,
      nativeAddress: 0x1400da850,
      name: 'ReplaceSpriteSource',
      execute: (context) => {
        const sourceSurface = pop32(context.thread),
          handle = pop32(context.thread),
          checked = validateBitmapNumber(context, sourceSurface);
        if (checked !== 0) return checked;
        const result = manager.replaceSpriteSource(handle, sourceSurface);
        if (result === 1)
          return fatal(context, `指定されたビットマップ [ ${sourceSurface | 0} ] は無効です`);
        return result === 0xffffffff ? invalidHandle(context) : 0;
      },
    },
    {
      primary: 0x90,
      secondary: 0x58,
      nativeAddress: 0x1400da6d0,
      name: 'InitializeBlendSprite',
      execute: (context) => {
        const blendSelector = pop32(context.thread),
          layer = pop32(context.thread),
          blendValue = pop32(context.thread),
          mixValue = pop32(context.thread),
          secondarySurface = pop32(context.thread),
          sourceSurface = pop32(context.thread),
          y = pop32(context.thread),
          x = pop32(context.thread),
          handle = pop32(context.thread),
          checked = validate(
            () => validateBitmapNumber(context, sourceSurface),
            () => validateBitmapNumber(context, secondarySurface),
            () => validateMixRatio(context, mixValue),
            () => validateTransparency(context, blendValue),
            () => validatePriority(context, layer),
          );
        if (checked !== 0) return checked;
        const result: number = manager.initializeBlendSprite(
          handle,
          x,
          y,
          sourceSurface,
          secondarySurface,
          mixValue,
          blendValue,
          layer,
          blendSelector,
        );
        if (result === 1)
          return fatal(
            context,
            `指定されたビットマップ [ ${sourceSurface | 0} , ${secondarySurface | 0} ] のいずれかが無効です`,
          );
        if (result === 2)
          return fatal(
            context,
            `ビットマップ [ ${sourceSurface | 0} , ${secondarySurface | 0} ] のサイズが一致しません`,
          );
        // 085B40 returns nine for the mismatch that DA6D0 tests as two.
        return result === 0xffffffff ? invalidHandle(context) : 0;
      },
    },
    {
      primary: 0x90,
      secondary: 0x59,
      nativeAddress: 0x1400da4f0,
      name: 'InitializeAffineSprite',
      execute: (context) => {
        const layer = pop32(context.thread),
          blendValue = pop32(context.thread),
          blendMode = pop32(context.thread),
          sampling = pop32(context.thread),
          scaleY = pop32(context.thread),
          scaleX = pop32(context.thread),
          angle = pop32(context.thread),
          pivotY = pop32(context.thread),
          pivotX = pop32(context.thread),
          sourceSurface = pop32(context.thread),
          y = pop32(context.thread),
          x = pop32(context.thread),
          handle = pop32(context.thread),
          checked = validate(
            () => validatePriority(context, layer),
            () => validateEffectLevel(context, blendValue),
            () => validateEffectMode(context, blendMode),
          );
        if (checked !== 0) return checked;
        const result = manager.initializeAffineSprite(
          handle,
          x,
          y,
          {sourceSurface, pivotX, pivotY, angle, scaleX, scaleY, sampling},
          blendMode,
          blendValue,
          layer,
        );
        if (result === 1)
          return fatal(context, `無効なビットマップ [ ${sourceSurface | 0} ] が指定されました`);
        if (result === 8)
          return fatal(
            context,
            `無効な伸縮倍率 [ ${scaleX | 0} , ${scaleY | 0} ] が指定されました`,
          );
        return result === 0xffffffff ? invalidHandle(context) : 0;
      },
    },
    {
      primary: 0x90,
      secondary: 0x5a,
      nativeAddress: 0x1400da350,
      name: 'InitializeRevealSprite',
      execute: (context) => {
        const layer = pop32(context.thread),
          blendValue = pop32(context.thread),
          blendMode = pop32(context.thread),
          transitionValue = pop32(context.thread),
          revealExponent = pop32(context.thread),
          maskSurface = pop32(context.thread),
          sourceSurface = pop32(context.thread),
          y = pop32(context.thread),
          x = pop32(context.thread),
          handle = pop32(context.thread),
          checked = validate(
            () => validatePriority(context, layer),
            () => validateEffectLevel(context, blendValue),
            () => validateEffectMode(context, blendMode),
            () => validateEffectLevel(context, transitionValue),
          );
        if (checked !== 0) return checked;
        const result = manager.initializeRevealSprite(
          handle,
          x,
          y,
          sourceSurface,
          maskSurface,
          revealExponent,
          transitionValue,
          blendMode,
          blendValue,
          layer,
        );
        if (result === 1)
          return fatal(
            context,
            `指定されたビットマップ [ ${sourceSurface | 0} , ${maskSurface | 0} ] のいずれかが無効です`,
          );
        if (result === 2)
          return fatal(
            context,
            `指定されたフィルタリング用ビットマップ [ ${maskSurface | 0}  ] は不適切です`,
          );
        return result === 0xffffffff ? invalidHandle(context) : 0;
      },
    },
    {
      primary: 0x90,
      secondary: 0x5b,
      nativeAddress: 0x1400da0e0,
      name: 'InitializeDisplacementSprite',
      execute: (context) => {
        const layer = pop32(context.thread),
          transparency = pop32(context.thread),
          blendValue = pop32(context.thread),
          coefficientSlot = pop32(context.thread),
          coefficientCount = pop32(context.thread),
          mapSurface = pop32(context.thread),
          sourceSurface = pop32(context.thread),
          y = pop32(context.thread),
          x = pop32(context.thread),
          handle = pop32(context.thread),
          checked = validate(
            () => validateBitmapNumber(context, sourceSurface),
            () => validateBitmapNumber(context, mapSurface),
            () => validateTransparency(context, transparency),
            () => validatePriority(context, layer),
          );
        if (checked !== 0) return checked;
        const result = manager.initializeDisplacementSprite(
          handle,
          x,
          y,
          sourceSurface,
          mapSurface,
          coefficientCount,
          coefficientSlot,
          blendValue,
          transparency,
          layer,
        );
        switch (result) {
          case 1:
            return fatal(context, `無効なビットマップ [ ${sourceSurface | 0} ] が指定されました`);
          case 2:
            return fatal(
              context,
              `ビットマップ [ ${sourceSurface | 0} ] はスプライトとしては表示できません`,
            );
          case 3:
            return fatal(
              context,
              `ベクトル＆ディスタンスマップとして指定されたビットマップ [ ${mapSurface | 0} ] は無効です`,
            );
          case 4:
            return fatal(
              context,
              `指定されたビットマップ [ ${mapSurface | 0} ] はベクトル＆ディスタンスマップではない、\n\n或いはビットマップ [ ${sourceSurface | 0} ] とサイズが一致していません`,
            );
          case 5:
            return fatal(
              context,
              `無効なディスタンスの最大値 [ ${coefficientCount | 0} ] が指定されました`,
            );
          case 6:
            return fatal(context, `指定された波紋 [ ${coefficientSlot | 0} ] は登録されていません`);
          case 7:
            return fatal(
              context,
              `指定された波紋 [ ${coefficientSlot | 0} ] はベクトル＆ディスタンスマップ [ ${mapSurface | 0} ] に適合しません`,
            );
          case 0xffffffff:
            return invalidHandle(context);
          default:
            return 0;
        }
      },
    },
    {
      primary: 0x90,
      secondary: 0x5c,
      nativeAddress: 0x1400d9e20,
      name: 'InitializeAffineBlendSprite',
      execute: (context) => {
        const layer = pop32(context.thread),
          blendValue = pop32(context.thread),
          blendMode = pop32(context.thread),
          sampling = pop32(context.thread),
          pivotPolicy = pop32(context.thread),
          perspective = pop32(context.thread),
          angle = pop32(context.thread),
          pivotY = pop32(context.thread),
          pivotX = pop32(context.thread),
          blendSelector = pop32(context.thread),
          mixValue = pop32(context.thread),
          secondarySurface = pop32(context.thread) | 0,
          sourceSurface = pop32(context.thread),
          z = pop32(context.thread),
          y = pop32(context.thread),
          x = pop32(context.thread),
          handle = pop32(context.thread),
          checked = validate(
            () => validateBitmapNumber(context, sourceSurface),
            () => validateMixRatio(context, mixValue),
            () => validateEffectMode(context, blendMode),
            () => validateEffectLevel(context, blendValue),
            () => validatePriority(context, layer),
          );
        if (checked !== 0) return checked;
        const result: number = manager.initializeAffineBlendSprite(
          handle,
          x,
          y,
          z,
          {
            sourceSurface,
            secondarySurface,
            mixValue,
            blendSelector,
            pivotX,
            pivotY,
            angle,
            perspective,
            pivotPolicy,
            sampling,
          },
          blendMode,
          blendValue,
          layer,
        );
        if (result === 1)
          return fatal(
            context,
            `指定されたビットマップ [ ${sourceSurface | 0} , ${secondarySurface | 0} ] のいずれかが無効です`,
          );
        if (result === 2)
          return fatal(
            context,
            `指定されたビットマップ [ ${sourceSurface | 0} , ${secondarySurface | 0} ] のサイズ／ピクセルモードが一致しません`,
          );
        if (result === 8)
          return fatal(context, `無効な投射スケール [ ${perspective | 0} ] が指定されました`);
        // 0855F0 returns nine for the mismatch that D9E20 tests as two.
        return result === 0xffffffff ? invalidHandle(context) : 0;
      },
    },
    {
      primary: 0x90,
      secondary: 0x5d,
      nativeAddress: 0x1400d9b10,
      name: 'InitializeMeshSprite',
      execute: (context) => {
        const layer = pop32(context.thread),
          blendValue = pop32(context.thread),
          blendMode = pop32(context.thread),
          sampling = pop32(context.thread),
          pivotPolicy = pop32(context.thread),
          perspective = pop32(context.thread),
          rotationOrder = pop32(context.thread),
          bank = pop32(context.thread),
          heading = pop32(context.thread),
          pitch = pop32(context.thread),
          pivotY = pop32(context.thread),
          pivotX = pop32(context.thread),
          blendSelector = pop32(context.thread),
          mixValue = pop32(context.thread),
          secondarySurface = pop32(context.thread) | 0,
          sourceSurface = pop32(context.thread),
          z = pop32(context.thread),
          y = pop32(context.thread),
          x = pop32(context.thread),
          handle = pop32(context.thread),
          checked = validate(
            () => validateBitmapNumber(context, sourceSurface),
            () => validateMixRatio(context, mixValue),
            () => validateEffectMode(context, blendMode),
            () => validateEffectLevel(context, blendValue),
            () => validatePriority(context, layer),
          );
        if (checked !== 0) return checked;
        const result: number = manager.initializeMeshSprite(
          handle,
          x,
          y,
          z,
          {
            sourceSurface,
            secondarySurface,
            mixValue,
            blendSelector,
            sourcePivotX: pivotX,
            sourcePivotY: pivotY,
            pitch,
            heading,
            bank,
            rotationOrder,
            perspective,
            pivotPolicy,
            sampling,
          },
          blendMode,
          blendValue,
          layer,
        );
        if (result === 1)
          return fatal(
            context,
            `指定されたビットマップ [ ${sourceSurface | 0} , ${secondarySurface | 0} ] のいずれかが無効です`,
          );
        if (result === 2)
          return fatal(
            context,
            `指定されたビットマップ [ ${sourceSurface | 0} , ${secondarySurface | 0} ] のサイズ／ピクセルモードが一致しません`,
          );
        if (result === 8)
          return fatal(context, `無効な投射スケール [ ${perspective | 0} ] が指定されました`);
        // 085440 returns nine for the mismatch that D9B10 tests as two.
        return result === 0xffffffff ? invalidHandle(context) : 0;
      },
    },
  ];
}

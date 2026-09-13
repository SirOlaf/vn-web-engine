import {pop32, push32} from '../bp/state.js';
import {AokanaDisplayRedraw} from './display-redraw.js';
import {AokanaEngineErrors} from './engine-errors.js';
import {AokanaRainDisplays} from './rain-displays.js';
import type {
  AokanaBpOpcodeContext,
  AokanaBpOpcodeHandler,
  AokanaNativeSlotDefinition,
} from './types.js';

/** C0 40..4f, retaining native fatal selection and the create wrapper's unwritten result path. */
export function createGroupC0Rain(
  rain: AokanaRainDisplays,
  redraw: AokanaDisplayRedraw,
  errors: AokanaEngineErrors,
): AokanaNativeSlotDefinition[] {
  const invalidHandle = '無効なレインスクリーンハンドルが指定されました';
  const fatal = (h: AokanaBpOpcodeContext, message: string): Promise<never> =>
    errors.threadFatal(h.thread, h.diagnostics, errors.files.text.encodeWide(message, 0));
  const invalid = (h: AokanaBpOpcodeContext, result: number): 0 | Promise<never> =>
    result === 0xffffffff ? fatal(h, invalidHandle) : 0;
  const handlers: Record<number, AokanaBpOpcodeHandler> = {};
  handlers[0x40] = (h) => {
    const height = pop32(h.thread),
      width = pop32(h.thread);
    const result = rain.create(width, height);
    if (result.result === 1)
      return fatal(h, 'これ以上、レインスクリーンオブジェクトを生成することはできません');
    // 081a40 returns THREE for configuration failure; native d0b70 only diagnoses TWO.
    if (result.result !== 0)
      throw new Error('Aokana rain create reads its unwritten native output handle');
    push32(h.thread, result.handle);
    return 0;
  };
  handlers[0x41] = (h) => (rain.remove(pop32(h.thread)) ? 0 : fatal(h, invalidHandle));
  handlers[0x42] = (h) => {
    const elapsed = pop32(h.thread),
      handle = pop32(h.thread);
    return rain.start(handle, elapsed) ? 0 : fatal(h, invalidHandle);
  };
  handlers[0x43] = (h) => {
    const mask = pop32(h.thread),
      handle = pop32(h.thread),
      result = rain.selectMask(handle, mask);
    if (result === 4)
      return fatal(h, `指定されたマスキング用ビットマップ [ ${mask | 0} ] は存在しません`);
    if (result === 5)
      return fatal(
        h,
        `指定されたマスキング用ビットマップ [ ${mask | 0} ] はグレイスケールではない、或いはレインスクリーンとサイズが一致しません`,
      );
    return invalid(h, result);
  };
  handlers[0x44] = (h) => {
    const value = pop32(h.thread),
      handle = pop32(h.thread);
    return rain.setActivation(handle, value) ? 0 : fatal(h, invalidHandle);
  };
  handlers[0x45] = (h) => {
    const layer = pop32(h.thread),
      value = pop32(h.thread),
      mode = pop32(h.thread);
    const y = pop32(h.thread),
      x = pop32(h.thread),
      handle = pop32(h.thread);
    if (layer >= 0x10000) return fatal(h, `無効なプライオリティ [ ${layer | 0} ] が指定されました`);
    if (value > 0x100)
      return fatal(
        h,
        `無効なエフェクトレベル／トランスペアレンシィ／オパシティ／アディションレベル [ ${value | 0} ] が指定されました`,
      );
    if (!(
      mode <= 9 ||
      (mode >= 0x20 && mode <= 0x27) ||
      mode === 0x40 ||
      mode === 0x41 ||
      mode === 0x80 ||
      mode === 0xc0 ||
      mode === 0xc1 ||
      mode === 0xf0 ||
      mode === 0xff
    ))
      return fatal(h, `無効なエフェクトモード [ ${mode | 0} ] が指定されました`);
    return invalid(h, rain.configureDisplay(handle, x, y, mode, value, layer));
  };
  handlers[0x46] = (h) => {
    const z2 = pop32(h.thread),
      y2 = pop32(h.thread),
      x2 = pop32(h.thread);
    const z1 = pop32(h.thread),
      y1 = pop32(h.thread),
      x1 = pop32(h.thread),
      handle = pop32(h.thread);
    return invalid(
      h,
      rain.updateSetting(handle, (object) => object.setBounds(x1, y1, z1, x2, y2, z2)),
    );
  };
  const scalar =
    (
      operation:
        | 'setSpeed'
        | 'setDropLength'
        | 'setColor'
        | 'setSpawnCount'
        | 'setTickInterval'
        | 'setProjectionDistance',
      message?: string,
    ): AokanaBpOpcodeHandler =>
    (h) => {
      const value = pop32(h.thread),
        handle = pop32(h.thread);
      const result = rain.updateSetting(handle, (object) => object[operation](value));
      if (result === 3 && message !== undefined)
        return fatal(h, message.replace('%d', String(value | 0)));
      return invalid(h, result);
    };
  handlers[0x47] = scalar('setSpeed', '無効なステージ当たりの落下距離 [ %d ] が指定されました');
  handlers[0x48] = scalar('setDropLength', '無効な雨の長さ [ %d ] が指定されました');
  handlers[0x49] = scalar('setColor');
  handlers[0x4a] = scalar('setSpawnCount');
  handlers[0x4b] = scalar('setTickInterval', '無効なステージ当たりの時間 [ %d ] が指定されました');
  handlers[0x4c] = (h) => {
    const z = pop32(h.thread),
      y = pop32(h.thread),
      x = pop32(h.thread),
      handle = pop32(h.thread);
    return invalid(
      h,
      rain.updateSetting(handle, (object) => object.setCameraPosition(x, y, z)),
    );
  };
  handlers[0x4d] = (h) => {
    const z = pop32(h.thread),
      y = pop32(h.thread),
      x = pop32(h.thread),
      handle = pop32(h.thread);
    return invalid(
      h,
      rain.updateSetting(handle, (object) => object.setCameraRotation(x, y, z)),
    );
  };
  handlers[0x4e] = scalar(
    'setProjectionDistance',
    '無効なプロジェクション値 [ %d ] が指定されました',
  );
  handlers[0x4f] = (h) => {
    const frequency = pop32(h.thread),
      enabled = pop32(h.thread);
    if ((frequency - 1) >>> 0 >= 1000)
      return fatal(h, `無効なフレームレート [ ${frequency | 0} ] が指定されました`);
    rain.state.accumulatedMilliseconds = 0;
    rain.state.frameInterval = Math.floor(1000 / frequency);
    rain.state.enabled = enabled | 0;
    redraw.request(1);
    return 0;
  };
  const definitions = [
    [0x40, 0x1400d0b70, 'CreateRainScreen'],
    [0x41, 0x1400d0b30, 'DeleteRainScreen'],
    [0x42, 0x1400d0ae0, 'StartRainScreen'],
    [0x43, 0x1400d0a30, 'SelectRainMask'],
    [0x44, 0x1400d09e0, 'SetRainActivation'],
    [0x45, 0x1400d0900, 'ConfigureRainDisplay'],
    [0x46, 0x1400d0860, 'SetRainBounds'],
    [0x47, 0x1400d07e0, 'SetRainSpeed'],
    [0x48, 0x1400d0760, 'SetRainDropLength'],
    [0x49, 0x1400d0710, 'SetRainColor'],
    [0x4a, 0x1400d06c0, 'SetRainSpawnCount'],
    [0x4b, 0x1400d0640, 'SetRainTickInterval'],
    [0x4c, 0x1400d05e0, 'SetRainCameraPosition'],
    [0x4d, 0x1400d0580, 'SetRainCameraRotation'],
    [0x4e, 0x1400d0500, 'SetRainProjectionDistance'],
    [0x4f, 0x1400d0490, 'ConfigureRainFrames'],
  ] as const;
  return definitions.map(([secondary, nativeAddress, name]) => ({
    primary: 0xc0,
    secondary,
    nativeAddress,
    name,
    execute: handlers[secondary]!,
  }));
}

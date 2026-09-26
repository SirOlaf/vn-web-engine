import {pointerView, type BurikoBpPointer} from '../bp/memory.js';
import {pop32, push32} from '../bp/state.js';
import type {BurikoEngineErrors} from './engine-errors.js';
import type {BurikoParticleAir} from './particle-air.js';
import type {BurikoParticleDisplays} from './particle-displays.js';
import type {
  BurikoBpOpcodeContext,
  BurikoBpOpcodeHandler,
  BurikoNativeSlotDefinition,
} from './types.js';

function popArguments(h: BurikoBpOpcodeContext, count: number): number[] {
  const values = new Array<number>(count);
  for (let i = count - 1; i >= 0; i--) values[i] = pop32(h.thread);
  return values;
}
function readDword(pointer: BurikoBpPointer | null, index = 0): number {
  if (pointer === null) throw new Error('Buriko particle parameter pointer is null');
  return pointerView({...pointer, offset: pointer.offset + index * 4}, 4).getInt32(0, true);
}

/** The twenty-four actual C0 particle slots, including native prevalidation and fatal selection. */
export function createGroupC0Particle(
  particles: BurikoParticleDisplays,
  errors: BurikoEngineErrors,
): BurikoNativeSlotDefinition[] {
  const fatal = (h: BurikoBpOpcodeContext, message: string): Promise<never> =>
    errors.threadFatal(h.thread, h.diagnostics, errors.files.text.encodeWide(message, 0));
  const invalidHandle = (h: BurikoBpOpcodeContext): Promise<never> =>
    fatal(h, '無効なパーティクルスクリーンハンドルが指定されました');
  const checkHandle = (h: BurikoBpOpcodeContext, result: number): 0 | Promise<never> =>
    result === 0xffffffff ? invalidHandle(h) : 0;
  const invalidPattern = (h: BurikoBpOpcodeContext, variant: number): Promise<never> =>
    fatal(h, `無効なパターン番号 [ ${variant | 0} ] が指定されました`);
  const missingBitmap = (h: BurikoBpOpcodeContext, surface: number): Promise<never> =>
    fatal(h, `指定されたビットマップ [ ${surface | 0} ] は存在しません`);
  const imageResult = (
    h: BurikoBpOpcodeContext,
    result: number,
    kind: number,
    variant: number,
    count: number,
    surface: number,
  ): 0 | Promise<never> => {
    if (result === 0x80000001)
      return fatal(h, `無効なパーティクルタイプ [ ${kind | 0} ] が指定されました`);
    if (result === 0x80000002)
      return fatal(h, `無効なオブジェクトパターン [ ${variant | 0} ] が指定されました`);
    if (result === 0x80000004) return missingBitmap(h, surface);
    if (result === 0x80000005)
      return fatal(
        h,
        `指定されたビットマップ [ ${surface | 0} ～${(surface - 1 + count) | 0} ] の中に適合しないものが含まれています`,
      );
    if (result === 0x80000006)
      return fatal(h, `無効なビットマップ数 [ ${count | 0} ] が指定されました`);
    return 0;
  };
  const handlers: Record<number, BurikoBpOpcodeHandler> = {};
  handlers[0x00] = (h) => {
    const height = pop32(h.thread),
      width = pop32(h.thread);
    const result = particles.create(width, height);
    if (result.result !== 0)
      return result.result === 1
        ? fatal(h, 'これ以上、パーティクルスクリーンオブジェクトを生成することはできません')
        : fatal(h, `無効なスクリーンサイズ [ ${width | 0} , ${height | 0} ] が指定されました`);
    push32(h.thread, result.handle);
    return 0;
  };
  handlers[0x01] = (h) => (particles.remove(pop32(h.thread)) ? 0 : invalidHandle(h));
  handlers[0x04] = (h) => {
    const value = pop32(h.thread),
      handle = pop32(h.thread);
    return particles.setActivation(handle, value) ? 0 : invalidHandle(h);
  };
  handlers[0x05] = (h) => {
    const layer = pop32(h.thread),
      value = pop32(h.thread),
      mode = pop32(h.thread);
    const y = pop32(h.thread),
      x = pop32(h.thread),
      handle = pop32(h.thread);
    if (layer >= 0x10000) return fatal(h, `無効なプライオリティ [ ${layer | 0} ] が指定されました`);
    if (value > 256)
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
    return particles.configureDisplay(handle, x, y, mode, value, layer) ? 0 : invalidHandle(h);
  };
  handlers[0x06] = (h) => {
    const offsets = h.memory.resolve(h.thread, pop32(h.thread));
    const depths = h.memory.resolve(h.thread, pop32(h.thread));
    const count = pop32(h.thread),
      handle = pop32(h.thread);
    const result = particles.configureLayers(
      handle,
      count,
      depths === null ? null : (i) => readDword(depths, i),
      offsets === null ? null : (i) => readDword(offsets, i),
    );
    if (result === 7) return fatal(h, `無効なレイヤー数 [ ${count | 0} ] が指定されました`);
    if (result === 8) return fatal(h, '指定された相対プライオリティの中に無効なものが存在します');
    return checkHandle(h, result);
  };
  handlers[0x08] = (h) => (particles.refresh(pop32(h.thread)) ? 0 : invalidHandle(h));
  handlers[0x09] = (h) => {
    const interval = pop32(h.thread),
      handle = pop32(h.thread);
    return particles.setRefreshInterval(handle, interval) ? 0 : invalidHandle(h);
  };
  handlers[0x0a] = (h) => {
    const maximum = pop32(h.thread),
      handle = pop32(h.thread);
    return particles.apply(handle, (object) => {
      object.maximumDamageRectangles = maximum | 0;
    })
      ? 0
      : invalidHandle(h);
  };
  handlers[0x0b] = (h) => {
    const values = popArguments(h, 9),
      handle = pop32(h.thread);
    const result = particles.configureCamera(handle, values);
    if (result === 3) return fatal(h, `無効な縮尺 [ ${values[6]! | 0} ] が指定されました`);
    return checkHandle(h, result);
  };
  handlers[0x0c] = (h) => {
    const interval = pop32(h.thread),
      handle = pop32(h.thread);
    const result = particles.setInterval(handle, interval);
    if (result === 4) return fatal(h, `無効な処理間隔 [ ${interval | 0} ] が指定されました`);
    return checkHandle(h, result);
  };
  handlers[0x0d] = (h) => {
    const iterations = pop32(h.thread),
      handle = pop32(h.thread);
    return particles.warmUp(handle, iterations) ? 0 : invalidHandle(h);
  };
  handlers[0x0f] = (h) =>
    particles.apply(pop32(h.thread), (object) => object.controller.clear()) ? 0 : invalidHandle(h);
  handlers[0x10] = (h) => {
    const values = popArguments(h, 11),
      handle = pop32(h.thread);
    return particles.apply(handle, (object) =>
      object.controller.air.configure(...(values as Parameters<BurikoParticleAir['configure']>)),
    )
      ? 0
      : invalidHandle(h);
  };
  handlers[0x18] = (h) => {
    const frames = pop32(h.thread),
      spread = pop32(h.thread),
      duration = pop32(h.thread);
    const surface = pop32(h.thread),
      count = pop32(h.thread),
      variant = pop32(h.thread),
      kind = pop32(h.thread);
    return imageResult(
      h,
      particles.configureImages(kind, variant, count, surface, duration, spread, frames),
      kind,
      variant,
      count,
      surface,
    );
  };
  handlers[0x1a] = (h) => {
    const option = pop32(h.thread),
      frames = pop32(h.thread),
      spread = pop32(h.thread),
      duration = pop32(h.thread);
    const surface = pop32(h.thread),
      count = pop32(h.thread),
      variant = pop32(h.thread),
      kind = pop32(h.thread);
    if (option > 256) return fatal(h, `無効な混合比 [ ${option | 0} ] が指定されました`);
    return imageResult(
      h,
      particles.configureImages(kind, variant, count, surface, duration, spread, frames, option),
      kind,
      variant,
      count,
      surface,
    );
  };
  handlers[0x1b] = (h) => {
    const option = pop32(h.thread),
      variant = pop32(h.thread),
      kind = pop32(h.thread);
    if (option > 256) return fatal(h, `無効な混合比 [ ${option | 0} ] が指定されました`);
    const result = particles.setSpecialOption(kind, variant, option);
    if (result === 0x80000007)
      return fatal(
        h,
        `パーティクルタイプ [ ${kind | 0} ] のオブジェクトパターン [ ${variant | 0} ] には別イメージが設定されていません`,
      );
    return imageResult(h, result, kind, variant, 0, 0);
  };
  handlers[0x1f] = (h) => {
    const mode = pop32(h.thread);
    return particles.setImageTimingMode(mode)
      ? 0
      : fatal(h, `無効な制御モード [ ${mode | 0} ] が指定されました`);
  };
  for (const [secondary, kind] of [
    [0x20, 0],
    [0x28, 1],
  ] as const)
    handlers[secondary] = (h) => {
      const interval = pop32(h.thread),
        count = pop32(h.thread),
        variant = pop32(h.thread),
        handle = pop32(h.thread);
      const result = particles.setTarget(handle, kind, variant, count, interval);
      if (result === 6)
        return fatal(h, `無効な最大オブジェクト数 [ ${count | 0} ] が指定されました`);
      if (result === 10) return invalidPattern(h, variant);
      return checkHandle(h, result);
    };
  for (const [secondary, kind] of [
    [0x24, 0],
    [0x2c, 1],
  ] as const)
    handlers[secondary] = (h) => {
      const surface = pop32(h.thread),
        variant = pop32(h.thread);
      const result = particles.configureImages(kind, variant, 1, surface, 0, 0, 0);
      if (result === 0x80000002) return invalidPattern(h, variant);
      if (result === 0x80000004) return missingBitmap(h, surface);
      if (result === 0x80000005)
        return fatal(
          h,
          `指定されたビットマップ [ ${surface | 0} ] はパーティクルには使用できません`,
        );
      return 0;
    };
  handlers[0x25] = (h) => {
    const airScale = h.memory.resolve(h.thread, pop32(h.thread));
    const values = popArguments(h, 9),
      variant = pop32(h.thread);
    values.push(readDword(airScale));
    return particles.variants.configureSnow(variant, values) ? 0 : invalidPattern(h, variant);
  };
  handlers[0x29] = (h) => {
    const values = popArguments(h, 14),
      variant = pop32(h.thread),
      handle = pop32(h.thread);
    const result = particles.configureMovement(handle, variant, values);
    if (result === 10) return invalidPattern(h, variant);
    return checkHandle(h, result);
  };
  handlers[0x2d] = (h) => {
    const mode = pop32(h.thread),
      fadeOut = pop32(h.thread),
      fadeIn = pop32(h.thread);
    const airScale = h.memory.resolve(h.thread, pop32(h.thread));
    const values = popArguments(h, 13),
      variant = pop32(h.thread);
    values.push(readDword(airScale), fadeIn, fadeOut, mode);
    return particles.variants.configureFirefly(variant, values) ? 0 : invalidPattern(h, variant);
  };
  const definitions = [
    [0x00, 0x1400d1ed0, 'CreateParticleScreen'],
    [0x01, 0x1400d1e90, 'DeleteParticleScreen'],
    [0x04, 0x1400d1e40, 'SetParticleActivation'],
    [0x05, 0x1400d1d70, 'ConfigureParticleDisplay'],
    [0x06, 0x1400d1cb0, 'ConfigureParticleLayers'],
    [0x08, 0x1400d1c70, 'RefreshParticleScreen'],
    [0x09, 0x1400d1c20, 'SetParticleRefreshInterval'],
    [0x0a, 0x1400d1bd0, 'SetParticleDamageThreshold'],
    [0x0b, 0x1400d1ac0, 'ConfigureParticleCamera'],
    [0x0c, 0x1400d1a40, 'SetParticleSimulationInterval'],
    [0x0d, 0x1400d19f0, 'WarmUpParticleScreen'],
    [0x0f, 0x1400d19b0, 'ClearParticleScreen'],
    [0x10, 0x1400d18a0, 'ConfigureParticleAir'],
    [0x18, 0x1400d1710, 'ConfigureParticleImages'],
    [0x1a, 0x1400d1560, 'ConfigureParticleSpecialImages'],
    [0x1b, 0x1400d1470, 'SetParticleSpecialBlend'],
    [0x1f, 0x1400d1420, 'SetParticleImageTimingMode'],
    [0x20, 0x1400d1350, 'SetSnowTargetCount'],
    [0x24, 0x1400d1270, 'SelectSnowImage'],
    [0x25, 0x1400d1150, 'ConfigureSnowVariant'],
    [0x28, 0x1400d1080, 'SetFireflyTargetCount'],
    [0x29, 0x1400d0ee0, 'ConfigureFireflyMovement'],
    [0x2c, 0x1400d0e00, 'SelectFireflyImage'],
    [0x2d, 0x1400d0c20, 'ConfigureFireflyVariant'],
  ] as const;
  return definitions.map(([secondary, nativeAddress, name]) => ({
    primary: 0xc0,
    secondary,
    nativeAddress,
    name,
    execute: handlers[secondary]!,
  }));
}

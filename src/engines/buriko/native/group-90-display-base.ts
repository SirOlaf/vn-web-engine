import {pop32} from '../bp/state.js';
import {BurikoDisplayFrames} from './display-frames.js';
import {BurikoDisplayManager} from './display-manager.js';
import {BurikoWindowDisplayState} from './display-window-state.js';
import {BurikoEngineErrors} from './engine-errors.js';
import {BurikoResourceLoadingState} from './resource-loading.js';
import type {
  BurikoBpOpcodeContext,
  BurikoBpOpcodeHandler,
  BurikoNativeSlotDefinition,
} from './types.js';

/** The verified Bank 90 base display, redraw, capture, window, font, and matte services. */
export function createGroup90DisplayBase(
  manager: BurikoDisplayManager,
  frames: BurikoDisplayFrames,
  loading: BurikoResourceLoadingState,
  windows: BurikoWindowDisplayState,
  errors: BurikoEngineErrors,
): BurikoNativeSlotDefinition[] {
  const slots: BurikoNativeSlotDefinition[] = [];
  const add = (
    secondary: number,
    nativeAddress: number,
    name: string,
    execute: BurikoBpOpcodeHandler,
  ): void => {
    slots.push({primary: 0x90, secondary, nativeAddress, name, execute});
  };
  const fatal = (context: BurikoBpOpcodeContext, message: string): Promise<never> =>
    errors.threadFatal(
      context.thread,
      context.diagnostics,
      errors.files.text.encodeWide(message, 0),
    );
  const invalidBitmap = (context: BurikoBpOpcodeContext, index: number): Promise<never> =>
    fatal(context, `無効なビットマップ番号 [ ${index | 0} ] が指定されました`);
  const invalidPriority = (context: BurikoBpOpcodeContext, priority: number): Promise<never> =>
    fatal(context, `無効なプライオリティ [ ${priority | 0} ] が指定されました`);
  const invalidEffect = (context: BurikoBpOpcodeContext, value: number): Promise<never> =>
    fatal(
      context,
      `無効なエフェクトレベル／トランスペアレンシィ／オパシティ／アディションレベル [ ${value | 0} ] が指定されました`,
    );

  add(0x00, 0x1400de070, 'RequestDisplayRedraw', (context) => {
    manager.redraw.request(pop32(context.thread) === 0 ? 0 : 1);
    return 0;
  });
  add(0x01, 0x1400de050, 'SetPresentationEnabled', (context) => {
    manager.displayState.presentationEnabled = pop32(context.thread);
    return 0;
  });
  add(0x02, 0x1400de000, 'SetFrameFrequency', (context) => {
    const frequency = pop32(context.thread);
    return frames.setFrameFrequency(frequency) !== 0
      ? 0
      : fatal(context, `無効なフレームレート [ ${frequency | 0} ] が指定されました`);
  });
  add(0x03, 0x1400ddfa0, 'ConfigureResourceCache', (context) => {
    const capacity = pop32(context.thread);
    if (capacity > 0x20000000)
      return fatal(context, `無効なキャッシュサイズ [ ${capacity | 0} ] が指定されました`);
    loading.cache.configure(capacity);
    return 0;
  });
  add(0x04, 0x1400ddf70, 'CaptureDisplayBitmap', (context) => {
    const surface = pop32(context.thread);
    if (surface >= 0x4000) return invalidBitmap(context, surface);
    manager.captureDisplayBitmap(surface);
    return 0;
  });
  add(0x05, 0x1400ddf10, 'RenderDisplayBitmap', (context) => {
    const priority = pop32(context.thread),
      surface = pop32(context.thread);
    if (priority >= 0x10000) return invalidPriority(context, priority);
    if (surface >= 0x4000) return invalidBitmap(context, surface);
    manager.renderDisplayBitmap(surface, priority);
    return 0;
  });
  add(0x06, 0x1400ddee0, 'SetDisplayReferencePoint', (context) => {
    const y = pop32(context.thread),
      x = pop32(context.thread);
    manager.setReferencePoint(x, y);
    return 0;
  });
  add(0x08, 0x1400ddea0, 'InvalidateDisplay', (context) => {
    pop32(context.thread);
    manager.invalidateScene();
    return 0;
  });
  add(0x09, 0x1400dde70, 'SetMinimumDisplayLayer', (context) => {
    const priority = pop32(context.thread);
    if (priority >= 0x10000) return invalidPriority(context, priority);
    manager.setMinimumLayer(priority);
    return 0;
  });
  add(0x0a, 0x1400dde40, 'ConfigureAutomaticRedraw', (context) => {
    const mode = pop32(context.thread),
      enabled = pop32(context.thread);
    manager.redraw.configureAutomatic(enabled, mode);
    return 0;
  });
  add(0x0c, 0x1400dddd0, 'SetWindowDrawState', (context) => {
    const transparency = pop32(context.thread),
      enabled = pop32(context.thread);
    if (transparency > 0x100) return invalidEffect(context, transparency);
    windows.set(enabled, transparency);
    return 0;
  });
  add(0x0e, 0x1400ddc40, 'SetFontCacheCapacity', (context) => {
    const capacity = pop32(context.thread),
      bold = pop32(context.thread),
      width = pop32(context.thread),
      size = pop32(context.thread),
      fontNumber = pop32(context.thread),
      name = manager.surfaces.fonts.name(fontNumber),
      result =
        name === null
          ? 0x80000004
          : manager.surfaces.fonts.setCacheCapacity(name, size, width, bold, capacity);
    switch (result) {
      case 0:
        return 0;
      case 0x80000001:
        return fatal(context, `無効なキャッシュ量 [ ${capacity | 0} ] が指定されました`);
      case 0x80000002:
        return fatal(context, `無効なフォントサイズ [ ${size | 0} ] が指定されました`);
      case 0x80000003:
        return fatal(context, `無効なフォント幅 [ ${width | 0} ] が指定されました`);
      case 0x80000004:
        return fatal(context, `無効なフォント番号 [ ${fontNumber | 0} ] が指定されました`);
      default:
        throw new Error('Buriko font cache returned an unknown native configuration status');
    }
  });
  add(0x0f, 0x1400ddc20, 'SetImportMatteColor', (context) => {
    manager.environment.compositor.importMatteColor = pop32(context.thread);
    return 0;
  });
  return slots;
}

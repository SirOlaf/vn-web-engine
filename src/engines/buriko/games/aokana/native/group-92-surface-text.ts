import {pop32, push32} from '../bp/state.js';
import type {AokanaEngineErrors} from './engine-errors.js';
import type {AokanaSurfaces} from './surfaces.js';
import {drawAokanaSurfaceText} from './surface-text.js';
import type {AokanaBpOpcodeContext, AokanaNativeSlotDefinition} from './types.js';

export function createGroup92SurfaceText(
  surfaces: AokanaSurfaces,
  errors: AokanaEngineErrors,
): AokanaNativeSlotDefinition[] {
  const fatal = (context: AokanaBpOpcodeContext, message: string): Promise<never> =>
    errors.threadFatal(
      context.thread,
      context.diagnostics,
      surfaces.fonts.text.encodeWide(message, 0),
    );
  const execute = async (context: AokanaBpOpcodeContext, wrap: 0 | 1): Promise<0> => {
    const linePercent = wrap === 1 ? pop32(context.thread) : 0,
      color = pop32(context.thread),
      proportional = pop32(context.thread),
      bold = pop32(context.thread),
      width = pop32(context.thread),
      size = pop32(context.thread),
      registeredFont = pop32(context.thread),
      source = context.memory.resolve(context.thread, pop32(context.thread)),
      y = pop32(context.thread),
      x = pop32(context.thread),
      surface = pop32(context.thread);
    if ((surface >>> 0) >= 0x4000)
      return fatal(context, `無効なビットマップ番号 [ ${surface | 0} ] が指定されました`);
    if (surfaces.fonts.name(registeredFont) === null)
      return fatal(context, `無効なフォント番号 [ ${registeredFont | 0} ] が指定されました`);
    const result = await drawAokanaSurfaceText(surfaces, {
      surface,
      x,
      y,
      source,
      registeredFont,
      size,
      width,
      bold,
      proportional,
      color,
      wrap,
      linePercent,
    });
    if (result.status === 0x80000001)
      return fatal(context, `指定されたフォントサイズ [ ${size | 0} ] は無効です`);
    if (result.status === 0x80000002)
      return fatal(context, `指定されたフォント幅 [ ${width | 0} ] は無効です`);
    if (result.status === 0x80000003)
      return fatal(context, `指定されたフォント番号 [ ${registeredFont | 0} ] は無効です`);
    if (result.status === 0x80000004)
      return fatal(context, `指定されたビットマップ [ ${surface | 0} ] は存在しません`);
    if (result.metric === undefined)
      throw new Error('Aokana surface text wrapper consumes an unwritten metric');
    push32(context.thread, result.metric);
    return 0;
  };
  return [
    {
      primary: 0x92,
      secondary: 0x1c,
      nativeAddress: 0x1400e4360,
      name: 'DrawRegisteredSurfaceText',
      execute: (context) => execute(context, 0),
    },
    {
      primary: 0x92,
      secondary: 0x1d,
      nativeAddress: 0x1400e4180,
      name: 'DrawWrappedRegisteredSurfaceText',
      execute: (context) => execute(context, 1),
    },
  ];
}

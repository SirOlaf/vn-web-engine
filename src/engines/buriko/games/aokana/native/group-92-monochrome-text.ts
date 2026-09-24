import {pop32, push32} from '../bp/state.js';
import type {AokanaEngineErrors} from './engine-errors.js';
import type {AokanaMonochromeSurfaceText} from './surface-monochrome-text.js';
import type {AokanaBpOpcodeContext, AokanaNativeSlotDefinition} from './types.js';

export function createGroup92MonochromeText(
  service: AokanaMonochromeSurfaceText,
  errors: AokanaEngineErrors,
): AokanaNativeSlotDefinition[] {
  const fatal = (h: AokanaBpOpcodeContext, message: string): Promise<never> =>
    errors.threadFatal(h.thread, h.diagnostics, service.surfaces.fonts.text.encodeWide(message, 0));
  return [
    {
      primary: 0x92,
      secondary: 0x1e,
      nativeAddress: 0x1400e3fe0,
      name: 'DrawMonochromeSurfaceText',
      execute: async (h): Promise<0> => {
        const color = pop32(h.thread),
          spacing = pop32(h.thread),
          bold = pop32(h.thread),
          size = pop32(h.thread),
          registeredFont = pop32(h.thread),
          source = h.memory.resolve(h.thread, pop32(h.thread)),
          y = pop32(h.thread),
          x = pop32(h.thread),
          surface = pop32(h.thread);
        if (surface >>> 0 >= 0x4000)
          return fatal(h, `無効なビットマップ番号 [ ${surface | 0} ] が指定されました`);
        if (service.surfaces.fonts.name(registeredFont) === null)
          return fatal(h, `無効なフォント番号 [ ${registeredFont | 0} ] が指定されました`);
        const result = await service.draw(
          {
            surface,
            x,
            y,
            source,
            registeredFont,
            size,
            bold,
            spacing,
            color,
          },
          h.actor,
        );
        if (result.status === 0x80000000) return fatal(h, '文字フォントの取得に失敗しました');
        if (result.status === 0x80000001)
          return fatal(h, `指定されたフォントサイズ [ ${size | 0} ] は無効です`);
        if (result.status === 0x80000003)
          return fatal(h, `指定されたフォント番号 [ ${registeredFont | 0} ] は無効です`);
        if (result.status === 0x80000004)
          return fatal(h, `指定されたビットマップ [ ${surface | 0} ] は存在しません`);
        if (result.metric === undefined)
          throw new Error('Aokana mono wrapper consumes an unwritten extent');
        push32(h.thread, result.metric);
        return 0;
      },
    },
  ];
}

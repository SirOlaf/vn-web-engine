import {pointerView} from '../bp/memory.js';
import {pop32} from '../bp/state.js';
import type {BurikoDisplayManager} from './display-manager.js';
import {BurikoWindowDisplayObject} from './display-window.js';
import type {BurikoEngineErrors} from './engine-errors.js';
import {drawBurikoSelectionBitmaps} from './selection-bitmaps.js';
import type {BurikoBpOpcodeContext, BurikoNativeSlotDefinition} from './types.js';

export function createGroup90SelectionBitmaps(
  manager: BurikoDisplayManager,
  errors: BurikoEngineErrors,
): BurikoNativeSlotDefinition[] {
  const fatal = (h: BurikoBpOpcodeContext, message: string): Promise<never> =>
    errors.threadFatal(h.thread, h.diagnostics, errors.files.text.encodeWide(message, 0));
  const execute = (h: BurikoBpOpcodeContext, extended: boolean): 0 | Promise<never> => {
    let records = h.memory.resolve(h.thread, pop32(h.thread));
    const count = pop32(h.thread),
      handle = pop32(h.thread);
    if ((count - 1) >>> 0 >= 64)
      return fatal(h, `無効なアイコン数 [ ${count | 0} ] が指定されました`);
    if (extended) {
      const bytes = new Uint8Array(count * 16),
        destination = new DataView(bytes.buffer);
      for (let index = 0; index < count; index++) {
        if (records === null)
          throw new Error('Buriko extended bitmap selection reads null records');
        const source = {bytes: records.bytes, offset: records.offset + index * 64};
        for (let word = 0; word < 3; word++)
          destination.setInt32(
            index * 16 + word * 4,
            pointerView(source, word * 4 + 4).getInt32(word * 4, true),
            true,
          );
        destination.setInt32(index * 16 + 12, -1, true);
      }
      records = {bytes, offset: 0};
    }
    const window = manager.find('window', handle);
    if (window === null) return fatal(h, '無効なウィンドウハンドルが指定されました');
    if (!(window instanceof BurikoWindowDisplayObject))
      throw new Error('Buriko bitmap selection requires the actual Window owner');
    drawBurikoSelectionBitmaps(window, count, records);
    window.setTextTransparency(0);
    window.setTextEnabled(1);
    window.composeAll();
    window.disableOverlays();
    return 0;
  };
  return [
    {
      primary: 0x90,
      secondary: 0xb4,
      nativeAddress: 0x1400d7eb0,
      name: 'DrawSelectionBitmaps',
      execute: (h) => execute(h, false),
    },
    {
      primary: 0x90,
      secondary: 0xb5,
      nativeAddress: 0x1400d7d80,
      name: 'DrawExtendedSelectionBitmaps',
      execute: (h) => execute(h, true),
    },
  ];
}

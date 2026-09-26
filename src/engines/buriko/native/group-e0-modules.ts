import {listThreadModules} from '../bp/modules.js';
import type {BurikoBpThread} from '../bp/state.js';
import {writeText} from './text.js';
import {BurikoSelectionDialog} from './selection-dialog.js';
import type {BurikoNativeSlotDefinition} from './types.js';

/** 1400ab2b0 reverses the copied list and appends sprintf("%s - $%06X\n") into count*64 bytes. */
export function formatBurikoModuleList(thread: BurikoBpThread): Uint8Array {
  const modules = listThreadModules(thread, true);
  const output = new Uint8Array((modules.length << 6) >>> 0);
  let offset = 0;
  for (let index = modules.length - 1; index >= 0; index--) {
    const module = modules[index]!;
    const suffix = new TextEncoder().encode(
      ` - $${(module.base >>> 0).toString(16).toUpperCase().padStart(6, '0')}\n\0`,
    );
    writeText({bytes: output, offset}, module.name);
    offset += module.name.length;
    writeText({bytes: output, offset}, suffix);
    offset += suffix.length - 1;
  }
  // With zero modules native operator_new(0) leaves no initialized string; a later read must fault.
  return output;
}

/** Caption is the raw shared 1401ca370 buffer returned by 1400eda30, not the game-window title. */
export function createGroupE0Modules(
  selection: BurikoSelectionDialog,
  engineCaption: Uint8Array,
): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0xe0,
      secondary: 0x80,
      nativeAddress: 0x1400ab2b0,
      name: 'ShowThreadModuleList',
      execute: async (h): Promise<0> => {
        const bytes = formatBurikoModuleList(h.thread),
          output = {bytes, offset: 0};
        const prompt = new TextEncoder().encode(`Thread [ ${h.thread.id | 0} ]\0`);
        await selection.select(
          output,
          {bytes: engineCaption, offset: 0},
          {bytes: prompt, offset: 0},
          output,
        );
        return 0;
      },
    },
  ];
}

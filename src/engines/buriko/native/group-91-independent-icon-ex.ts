import {pop32, push32} from '../bp/state.js';
import {copyBurikoBitmapGroupDescription} from './bitmap-group-description.js';
import type {BurikoNativeClock} from './clock.js';
import type {BurikoCursorPolicy} from './cursor-policy.js';
import {BurikoWindowDisplayObject} from './display-window.js';
import type {BurikoEngineErrors} from './engine-errors.js';
import {BurikoIndependentIconState} from './independent-icon.js';
import {BurikoIndependentIconEx} from './independent-icon-ex.js';
import type {BurikoIndependentProcedures} from './independent-procedure.js';
import type {BurikoNativeInput} from './input.js';
import type {BurikoProcedureState} from './procedure.js';
import type {BurikoNativeSlotDefinition} from './types.js';

export function createGroup91IndependentIconEx(
  shared: BurikoIndependentProcedures,
  input: BurikoNativeInput,
  priorities: BurikoProcedureState,
  clock: BurikoNativeClock,
  cursor: BurikoCursorPolicy,
  settings: BurikoIndependentIconState,
  errors: BurikoEngineErrors,
): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x91,
      secondary: 0xb8,
      nativeAddress: 0x1400de740,
      name: 'CreateIndependentIconEx',
      execute: (h) => {
        const handle = pop32(h.thread),
          window = shared.manager.find('window', handle);
        if (window === null)
          return errors.threadFatal(
            h.thread,
            h.diagnostics,
            errors.files.text.encodeWide(
              `無効なウィンドウハンドル [ $${(handle >>> 0).toString(16).toUpperCase().padStart(8, '0')} ] が指定されました`,
              0,
            ),
          );
        if (!(window instanceof BurikoWindowDisplayObject))
          throw new Error('Buriko IconEx requires the actual Window owner');
        push32(
          h.thread,
          shared.register(
            new BurikoIndependentIconEx(shared, window, input, priorities, clock, cursor, settings),
          ),
        );
        return 0;
      },
    },
    {
      primary: 0x91,
      secondary: 0xba,
      nativeAddress: 0x1400de700,
      name: 'ConfigureIndependentIconEx',
      execute: (h) => {
        const source = h.memory.resolve(h.thread, pop32(h.thread)),
          id = pop32(h.thread),
          icon = shared.find(id);
        if (icon === null || icon.category !== 0x80) {
          push32(h.thread, 1);
          return 0;
        }
        const type = (icon as {type?: number}).type;
        if (type === undefined) throw new Error('Buriko IconEx consumes missing native subtype');
        if ((type - 1) >>> 0 > 1) {
          push32(h.thread, 4);
          return 0;
        }
        if (!(icon instanceof BurikoIndependentIconEx))
          throw new Error('Buriko IconEx configuration requires the concrete derived owner');
        const copied = copyBurikoBitmapGroupDescription(source, h.memory, h.thread);
        let status: number = copied.result;
        if (copied.result === 0) {
          const result = icon.initializeGroups(copied.description);
          status = result === 0x80000001 ? 2 : result === 0x80000002 ? 3 : 0;
        }
        push32(h.thread, status);
        return 0;
      },
    },
  ];
}

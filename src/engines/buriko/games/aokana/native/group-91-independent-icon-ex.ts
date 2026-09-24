import {pop32, push32} from '../bp/state.js';
import {copyAokanaBitmapGroupDescription} from './bitmap-group-description.js';
import type {AokanaNativeClock} from './clock.js';
import type {AokanaCursorPolicy} from './cursor-policy.js';
import {AokanaWindowDisplayObject} from './display-window.js';
import type {AokanaEngineErrors} from './engine-errors.js';
import {AokanaIndependentIconState} from './independent-icon.js';
import {AokanaIndependentIconEx} from './independent-icon-ex.js';
import type {AokanaIndependentProcedures} from './independent-procedure.js';
import type {AokanaNativeInput} from './input.js';
import type {AokanaProcedureState} from './procedure.js';
import type {AokanaNativeSlotDefinition} from './types.js';

export function createGroup91IndependentIconEx(
  shared: AokanaIndependentProcedures,
  input: AokanaNativeInput,
  priorities: AokanaProcedureState,
  clock: AokanaNativeClock,
  cursor: AokanaCursorPolicy,
  settings: AokanaIndependentIconState,
  errors: AokanaEngineErrors,
): AokanaNativeSlotDefinition[] {
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
        if (!(window instanceof AokanaWindowDisplayObject))
          throw new Error('Aokana IconEx requires the actual Window owner');
        push32(
          h.thread,
          shared.register(
            new AokanaIndependentIconEx(shared, window, input, priorities, clock, cursor, settings),
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
        if (type === undefined) throw new Error('Aokana IconEx consumes missing native subtype');
        if ((type - 1) >>> 0 > 1) {
          push32(h.thread, 4);
          return 0;
        }
        if (!(icon instanceof AokanaIndependentIconEx))
          throw new Error('Aokana IconEx configuration requires the concrete derived owner');
        const copied = copyAokanaBitmapGroupDescription(source, h.memory, h.thread);
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

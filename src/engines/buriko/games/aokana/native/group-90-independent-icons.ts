import {pop32, push32} from '../bp/state.js';
import {pointerView} from '../bp/memory.js';
import type {AokanaNativeClock} from './clock.js';
import type {AokanaCursorPolicy} from './cursor-policy.js';
import {AokanaWindowDisplayObject} from './display-window.js';
import type {AokanaEngineErrors} from './engine-errors.js';
import {copyAokanaIconDescription, iconPointerWord} from './icon-description.js';
import {
  AokanaIndependentIcon,
  AokanaIndependentIconState,
  drawAokanaIconDescription,
} from './independent-icon.js';
import type {AokanaIndependentProcedures} from './independent-procedure.js';
import type {AokanaNativeInput} from './input.js';
import type {AokanaProcedureState} from './procedure.js';
import type {AokanaBpOpcodeContext, AokanaNativeSlotDefinition} from './types.js';

export function createGroup90IndependentIcons(
  shared: AokanaIndependentProcedures,
  input: AokanaNativeInput,
  priorities: AokanaProcedureState,
  clock: AokanaNativeClock,
  cursor: AokanaCursorPolicy,
  settings: AokanaIndependentIconState,
  errors: AokanaEngineErrors,
): AokanaNativeSlotDefinition[] {
  const windowFor = (handle: number): AokanaWindowDisplayObject | null => {
    const found = shared.manager.find('window', handle);
    if (found === null) return null;
    if (!(found instanceof AokanaWindowDisplayObject))
      throw new Error('Aokana Icon requires the actual Window owner');
    return found;
  };
  const iconFor = (id: number): AokanaIndependentIcon | null => {
    const found = shared.find(id);
    if (found === null || found.category !== 0x80) return null;
    if (!(found instanceof AokanaIndependentIcon))
      throw new Error('Aokana Icon query requires concrete category80 record storage');
    return found;
  };
  const query = (
    h: AokanaBpOpcodeContext,
    read: (icon: AokanaIndependentIcon, write: (index: number, value: number) => void) => void,
  ): 0 => {
    const id = pop32(h.thread),
      output = h.memory.resolve(h.thread, pop32(h.thread)),
      icon = iconFor(id);
    if (icon !== null)
      read(icon, (index, value) => iconPointerWord(output, index).setInt32(0, value | 0, true));
    push32(h.thread, Number(icon !== null));
    return 0;
  };
  return [
    {
      primary: 0x90,
      secondary: 0xb6,
      nativeAddress: 0x1400d7d40,
      name: 'DrawIconDescription',
      execute: (h) => {
        const source = h.memory.resolve(h.thread, pop32(h.thread)),
          handle = pop32(h.thread),
          window = windowFor(handle);
        if (window === null) {
          push32(h.thread, 1);
          return 0;
        }
        const copied = copyAokanaIconDescription(h.memory, h.thread, source);
        let status: number = copied.status;
        if (copied.status === 0) {
          const result = drawAokanaIconDescription(window, copied.description);
          status = result === 0x80000001 ? 2 : result === 0x80000002 ? 3 : 0;
        }
        push32(h.thread, status);
        return 0;
      },
    },
    {
      primary: 0x90,
      secondary: 0xb8,
      nativeAddress: 0x1400d7c90,
      name: 'CreateIndependentIcon',
      execute: (h) => {
        const handle = pop32(h.thread),
          window = windowFor(handle);
        if (window === null)
          return errors.threadFatal(
            h.thread,
            h.diagnostics,
            errors.files.text.encodeWide(
              `無効なウィンドウハンドル [ $${(handle >>> 0).toString(16).toUpperCase().padStart(8, '0')} ] が指定されました`,
              0,
            ),
          );
        push32(
          h.thread,
          shared.register(
            new AokanaIndependentIcon(shared, window, input, priorities, clock, cursor, settings),
          ),
        );
        return 0;
      },
    },
    {
      primary: 0x90,
      secondary: 0xb9,
      nativeAddress: 0x1400d7c60,
      name: 'RemoveIndependentIcon',
      execute: (h) => {
        push32(h.thread, shared.remove(pop32(h.thread)));
        return 0;
      },
    },
    {
      primary: 0x90,
      secondary: 0xba,
      nativeAddress: 0x1400d7c20,
      name: 'ConfigureIndependentIcon',
      execute: (h) => {
        const source = h.memory.resolve(h.thread, pop32(h.thread)),
          id = pop32(h.thread),
          icon = iconFor(id);
        if (icon === null) {
          push32(h.thread, 1);
          return 0;
        }
        if (icon.type !== 0) {
          push32(h.thread, 4);
          return 0;
        }
        const copied = copyAokanaIconDescription(h.memory, h.thread, source);
        let status: number = copied.status;
        if (copied.status === 0) {
          const result = icon.initialize(copied.description);
          status = result === 0x80000001 ? 2 : result === 0x80000002 ? 3 : 0;
        }
        push32(h.thread, status);
        return 0;
      },
    },
    {
      primary: 0x90,
      secondary: 0xbc,
      nativeAddress: 0x1400d7bd0,
      name: 'GetIndependentIconResult',
      execute: (h) => query(h, (icon, write) => icon.writeResult(write)),
    },
    {
      primary: 0x90,
      secondary: 0xbd,
      nativeAddress: 0x1400d7b80,
      name: 'GetIndependentIconRow',
      execute: (h) => query(h, (icon, write) => write(0, icon.selectedRow())),
    },
    {
      primary: 0x90,
      secondary: 0xbe,
      nativeAddress: 0x1400d7b30,
      name: 'GetIndependentIconColumns',
      execute: (h) => query(h, (icon, write) => icon.writeSelectedColumns(write)),
    },
    {
      primary: 0x90,
      secondary: 0xbf,
      nativeAddress: 0x1400d7ae0,
      name: 'ConsumeIndependentIconNotification',
      execute: (h) => {
        const id = pop32(h.thread),
          output = h.memory.resolve(h.thread, pop32(h.thread)),
          icon = iconFor(id);
        if (icon !== null)
          icon.consumeNotification((words) => {
            if (output === null) throw new Error('Aokana Icon consumes a null notification output');
            pointerView(output, 8).setBigUint64(
              0,
              BigInt(words[0]!) | (BigInt(words[1]!) << 32n),
              true,
            );
            iconPointerWord(output, 2).setUint32(0, words[2]!, true);
          });
        push32(h.thread, Number(icon !== null));
        return 0;
      },
    },
  ];
}

import {pointerView} from '../bp/memory.js';
import {pop32, push32} from '../bp/state.js';
import type {AokanaNativeClock} from './clock.js';
import type {AokanaCursorPolicy} from './cursor-policy.js';
import {AokanaWindowDisplayObject} from './display-window.js';
import type {AokanaEngineErrors} from './engine-errors.js';
import type {AokanaIndependentIconState} from './independent-icon.js';
import {AokanaIndependentIconEx} from './independent-icon-ex.js';
import {AokanaIndependentIconEEx} from './independent-icon-eex.js';
import type {AokanaIndependentProcedures} from './independent-procedure.js';
import type {AokanaNativeInput} from './input.js';
import type {AokanaProcedureState} from './procedure.js';
import type {AokanaNativeSplines} from './spline-registry.js';
import type {AokanaBpOpcodeContext, AokanaNativeSlotDefinition} from './types.js';

export function createGroup91IndependentIconMotion(
  shared: AokanaIndependentProcedures,
  input: AokanaNativeInput,
  priorities: AokanaProcedureState,
  clock: AokanaNativeClock,
  cursor: AokanaCursorPolicy,
  settings: AokanaIndependentIconState,
  splines: AokanaNativeSplines,
  errors: AokanaEngineErrors,
): AokanaNativeSlotDefinition[] {
  const fatal = (h: AokanaBpOpcodeContext, message: string) =>
    errors.threadFatal(h.thread, h.diagnostics, errors.files.text.encodeWide(message, 0));
  const subtype = (icon: object): number => {
    const type = (icon as {type?: number}).type;
    if (type === undefined) throw new Error('Aokana Icon motion consumes absent subtype');
    return type;
  };
  return [
    {
      primary: 0x91,
      secondary: 0xbb,
      nativeAddress: 0x1400de6a0,
      name: 'SetIndependentIconVisibility',
      execute: (h) => {
        const value = pop32(h.thread),
          column = pop32(h.thread) | 0,
          row = pop32(h.thread) | 0,
          id = pop32(h.thread),
          icon = shared.find(id);
        let status: number;
        if (icon === null || icon.category !== 0x80) status = 1;
        else if ((subtype(icon) - 1) >>> 0 > 1) status = 4;
        else {
          if (!(icon instanceof AokanaIndependentIconEx))
            throw new Error('Aokana visibility requires actual IconEx owner');
          const result = icon.setIconVisibility(row, column, value);
          if (result === 0) status = 0;
          else if (result === 0x80000001) status = 2;
          else if (result === 0x80000002) status = 3;
          else throw new Error('Aokana visibility returns unwritten status');
        }
        push32(h.thread, status);
        return 0;
      },
    },
    {
      primary: 0x91,
      secondary: 0xbc,
      nativeAddress: 0x1400de630,
      name: 'CreateIndependentIconEEx',
      execute: (h) => {
        const handle = pop32(h.thread),
          window = shared.manager.find('window', handle);
        if (window === null)
          return fatal(
            h,
            `無効なウィンドウハンドル [ $${(handle >>> 0).toString(16).toUpperCase().padStart(8, '0')} ] が指定されました`,
          );
        if (!(window instanceof AokanaWindowDisplayObject))
          throw new Error('Aokana IconEEx requires actual Window owner');
        push32(
          h.thread,
          shared.register(
            new AokanaIndependentIconEEx(
              shared,
              window,
              input,
              priorities,
              clock,
              cursor,
              settings,
              splines,
            ),
          ),
        );
        return 0;
      },
    },
    {
      primary: 0x91,
      secondary: 0xbd,
      nativeAddress: 0x1400de540,
      name: 'ConfigureIndependentIconMotion',
      execute: (h) => {
        const initial = pop32(h.thread) | 0,
          duration = pop32(h.thread),
          easingOut = pop32(h.thread) | 0,
          easingIn = pop32(h.thread) | 0,
          blendB = pop32(h.thread) | 0,
          blendA = pop32(h.thread) | 0,
          points = h.memory.resolve(h.thread, pop32(h.thread)),
          count = pop32(h.thread),
          column = pop32(h.thread) | 0,
          row = pop32(h.thread) | 0,
          id = pop32(h.thread),
          icon = shared.find(id);
        let status: number;
        if (icon === null || icon.category !== 0x80) status = 1;
        else if (subtype(icon) !== 2) status = 4;
        else {
          if (!(icon instanceof AokanaIndependentIconEEx))
            throw new Error('Aokana motion requires actual IconEEx owner');
          const result = icon.configureMotion(
            row,
            column,
            count,
            points,
            blendA,
            blendB,
            easingIn,
            easingOut,
            duration,
            initial,
          );
          switch (result) {
            case 0:
              status = 0;
              break;
            case 0x80000001:
              status = 2;
              break;
            case 0x80000002:
              status = 3;
              break;
            case 0x80000003:
              status = 5;
              break;
            case 0x80000004:
              status = 6;
              break;
            case 0x80000005:
              status = 7;
              break;
            case 0x80000006:
              status = 8;
              break;
            default:
              throw new Error('Aokana motion facade returns unwritten status');
          }
        }
        push32(h.thread, status);
        return 0;
      },
    },
    {
      primary: 0x91,
      secondary: 0xbf,
      nativeAddress: 0x1400de4e0,
      name: 'SetIndependentIconKeyMap',
      execute: (h) => {
        const source = h.memory.resolve(h.thread, pop32(h.thread)),
          mode = pop32(h.thread);
        if (
          !settings.setMap(mode, (index) => {
            if (source === null) throw new Error('Aokana Icon map dereferences null source');
            return pointerView(
              {bytes: source.bytes, offset: source.offset + index * 4},
              4,
            ).getInt32(0, true);
          })
        )
          return fatal(h, `無効なキーアサインメント [ ${mode | 0} ] が指定されました`);
        return 0;
      },
    },
  ];
}

import {pop32, push32} from '../bp/state.js';
import type {BurikoBpPointer} from '../bp/memory.js';
import type {BurikoBpOpcodeHandler, BurikoNativeSlotDefinition} from './types.js';
import {BURIKO_1658_NATIVE_SLOT_ADDRESSES} from './inventory-1658.js';
import {createLegacy1665NativeDefinitions} from './legacy-1665-handlers.js';
import {BurikoD3dxEffectLibrary} from './d3dx-effect-library.js';
import {BurikoEngineDialogs} from './engine-dialogs.js';
import {BurikoNativeText, textBytes} from './text.js';

/** 1.658.5 differences from the 1.665 native bank; absent 81 slots are omitted by its inventory. */
export function createLegacy1658NativeDefinitions(
  shared: readonly BurikoNativeSlotDefinition[],
  effects: BurikoD3dxEffectLibrary,
): BurikoNativeSlotDefinition[] {
  return [
    ...createLegacy1665NativeDefinitions(shared, BURIKO_1658_NATIVE_SLOT_ADDRESSES),
    {
      primary: 0x81,
      secondary: 0x6e,
      nativeAddress: BURIKO_1658_NATIVE_SLOT_ADDRESSES[0x81]![0x6e]!,
      name: 'D3dxEffectLibraryAvailable',
      execute: (h) => {
        push32(h.thread, Number(effects.available));
        return 0;
      },
    },
  ];
}

/** 00481710 calls narrow CRT sprintf with one string argument into a 1024-byte buffer. */
function formatVerification(format: BurikoBpPointer | null, argument: BurikoBpPointer | null) {
  if (format === null) throw new Error('Buriko 1.658.5 verification message formats a null string');
  const source = textBytes(format),
    output: number[] = [];
  let consumed = false;
  for (let at = 0; at < source.length; at++) {
    if (source[at] !== 0x25) {
      output.push(source[at]!);
      continue;
    }
    const conversion = source[++at];
    if (conversion === 0x25) output.push(0x25);
    else if (conversion === 0x73 && !consumed) {
      consumed = true;
      output.push(
        ...(argument === null ? new TextEncoder().encode('(null)') : textBytes(argument)),
      );
    } else
      throw new Error(
        'Buriko 1.658.5 verification message reads an unrepresented native sprintf argument',
      );
  }
  if (output.length >= 0x400)
    throw new RangeError('Buriko 1.658.5 verification message overflows its native buffer');
  return Uint8Array.from(output);
}

/** Primary 7f is a direct verification message in 1.658.5, not a native bank. */
export function createLegacy1658PrimaryOpcodes(
  text: BurikoNativeText,
  dialogs: BurikoEngineDialogs,
): Readonly<Record<number, BurikoBpOpcodeHandler>> {
  const title = text.encodeWide('検証結果', 0);
  return {
    0x7f: async ({thread, memory}): Promise<0> => {
      const argument = memory.resolve(thread, pop32(thread)),
        format = memory.resolve(thread, pop32(thread));
      await dialogs.show(formatVerification(format, argument), title, 0);
      return 0;
    },
  };
}

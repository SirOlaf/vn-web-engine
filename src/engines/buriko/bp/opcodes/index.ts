import type {BurikoBpOpcodeHandler} from '../../native/types.js';
import type {BurikoNativeText} from '../../native/text.js';
import {controlOpcodes} from './control.js';
import {integerOpcodes} from './integer.js';
import {memoryOpcodes} from './memory.js';
import {localOpcodes} from './locals.js';
import {fixedOpcodes} from './fixed.js';
import {nativeMathOpcodes} from './native-math.js';
import {createTextOpcodes} from './text.js';
import {createLegacy169CoreOpcodes} from './legacy-169.js';
import {createLegacy1665CoreOpcodes} from './legacy-1665.js';
import {BURIKO_BP_ABI_172, type BurikoBpAbi} from '../abi.js';

/** Per-runtime text and host state are shared with that runtime's native bank. */
export function createPrimaryOpcodes(
  text: BurikoNativeText,
  hostOpcodes: Readonly<Record<number, BurikoBpOpcodeHandler>>,
  abi: BurikoBpAbi = BURIKO_BP_ABI_172,
): Readonly<Record<number, BurikoBpOpcodeHandler>> {
  return Object.freeze({
    ...controlOpcodes,
    ...integerOpcodes,
    ...memoryOpcodes,
    ...localOpcodes,
    ...fixedOpcodes,
    ...nativeMathOpcodes,
    ...createTextOpcodes(text),
    ...(abi.compatibility === '1.69' ? createLegacy169CoreOpcodes() : {}),
    ...(abi.revision === '1.665' ? createLegacy1665CoreOpcodes() : {}),
    ...hostOpcodes,
  });
}

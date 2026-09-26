import type {AokanaBpOpcodeHandler} from '../../native/types.js';
import type {AokanaNativeText} from '../../native/text.js';
import {controlOpcodes} from './control.js';
import {integerOpcodes} from './integer.js';
import {memoryOpcodes} from './memory.js';
import {localOpcodes} from './locals.js';
import {fixedOpcodes} from './fixed.js';
import {nativeMathOpcodes} from './native-math.js';
import {createTextOpcodes} from './text.js';

/** Per-runtime text and host state are shared with that runtime's native bank. */
export function createPrimaryOpcodes(
  text: AokanaNativeText,
  hostOpcodes: Readonly<Record<number, AokanaBpOpcodeHandler>>,
): Readonly<Record<number, AokanaBpOpcodeHandler>> {
  return Object.freeze({
    ...controlOpcodes,
    ...integerOpcodes,
    ...memoryOpcodes,
    ...localOpcodes,
    ...fixedOpcodes,
    ...nativeMathOpcodes,
    ...createTextOpcodes(text),
    ...hostOpcodes,
  });
}

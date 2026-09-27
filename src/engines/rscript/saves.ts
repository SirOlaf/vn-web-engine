import {CONFIG_SIZE, GAME_VARIABLE_COUNT, VARIABLE_COUNT, type RScriptMemory} from './memory.js';

const SYSTEM_VARIABLES = VARIABLE_COUNT - GAME_VARIABLE_COUNT;

/**
 * System save `<prefix>.dat` (sub_421210 / sub_4212C0): the configuration block, the
 * persistent variables 7000..9999, then the read-text and seen-image flag stores.
 */
export function encodeSystemSave(memory: RScriptMemory): Uint8Array {
  const readText = memory.readText.encode(),
    seenImages = memory.seenImages.encode();
  const bytes = new Uint8Array(
    CONFIG_SIZE + 2 * SYSTEM_VARIABLES + readText.length + seenImages.length,
  );
  let offset = 0;
  bytes.set(memory.config.subarray(0, CONFIG_SIZE), offset);
  offset += CONFIG_SIZE;
  const view = new DataView(bytes.buffer, offset, 2 * SYSTEM_VARIABLES);
  for (let i = 0; i < SYSTEM_VARIABLES; i++)
    view.setInt16(2 * i, memory.variables[GAME_VARIABLE_COUNT + i]!, true);
  offset += 2 * SYSTEM_VARIABLES;
  bytes.set(readText, offset);
  bytes.set(seenImages, offset + readText.length);
  return bytes;
}

export function decodeSystemSave(memory: RScriptMemory, bytes: Uint8Array): void {
  const fixed = CONFIG_SIZE + 2 * SYSTEM_VARIABLES;
  if (bytes.length < fixed) throw new Error('Truncated system save');
  memory.config.set(bytes.subarray(0, CONFIG_SIZE));
  const view = new DataView(bytes.buffer, bytes.byteOffset + CONFIG_SIZE, 2 * SYSTEM_VARIABLES);
  for (let i = 0; i < SYSTEM_VARIABLES; i++)
    memory.variables[GAME_VARIABLE_COUNT + i] = view.getInt16(2 * i, true);
  let offset = fixed + memory.readText.decode(bytes, fixed);
  offset += memory.seenImages.decode(bytes, offset);
  if (offset !== bytes.length) throw new Error('Unexpected data after the system save flags');
}

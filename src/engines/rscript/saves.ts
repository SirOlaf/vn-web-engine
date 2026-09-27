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

/** Size of the slot header (sub_4213D0). */
export const SLOT_HEADER_SIZE = 0x68;
/** Page text kept in the header for save screens. */
const SLOT_TEXT = {offset: 22, capacity: 80} as const;

export interface RScriptSlotHeader {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  /** Variables 1..3 of the saved snapshot, used by title-specific save screens. */
  readonly variables: readonly [number, number, number];
  /** Background (layer 0) image of the saved snapshot. */
  readonly background: number;
  /** Shift-JIS page text at the snapshot, at most 80 bytes ending on a character boundary. */
  readonly text: Uint8Array;
}

const isLead = (byte: number): boolean =>
  (byte >= 0x81 && byte <= 0x9f) || (byte >= 0xe0 && byte <= 0xfc);

/**
 * Slot save `<prefix>NN.dat` (sub_4213D0 / sub_421570): the header, then the scene and
 * play-through variables at the last message snapshot, then the previous-choice snapshot.
 */
export function encodeSlotSave(
  memory: RScriptMemory,
  pageText: Uint8Array,
  date: Date,
): Uint8Array {
  const sceneSize = memory.scene.length;
  const variableBytes = 2 * GAME_VARIABLE_COUNT;
  const bytes = new Uint8Array(SLOT_HEADER_SIZE + 2 * (sceneSize + variableBytes));
  const view = new DataView(bytes.buffer);
  const words = [
    date.getFullYear(),
    date.getMonth() + 1,
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
  ];
  words.forEach((value, i) => view.setUint16(2 * i, value, true));
  for (let i = 0; i < 3; i++) view.setInt16(10 + 2 * i, memory.messageVariables[1 + i]!, true);
  // Layer 0's image word in the snapshot (scene +0x8E).
  view.setUint16(20, new DataView(memory.messageScene.buffer).getUint16(0x8e, true), true);
  let length = 0;
  while (length < pageText.length && pageText[length] !== 0) {
    const step = isLead(pageText[length]!) ? 2 : 1;
    if (length + step > SLOT_TEXT.capacity) break;
    length += step;
  }
  bytes.set(pageText.subarray(0, length), SLOT_TEXT.offset);
  let offset = SLOT_HEADER_SIZE;
  const put = (scene: Uint8Array, variables: Int16Array): void => {
    bytes.set(scene, offset);
    offset += sceneSize;
    for (let i = 0; i < GAME_VARIABLE_COUNT; i++)
      view.setInt16(offset + 2 * i, variables[i]!, true);
    offset += variableBytes;
  };
  put(memory.messageScene, memory.messageVariables);
  put(memory.previousScene, memory.previousVariables);
  return bytes;
}

export function decodeSlotHeader(bytes: Uint8Array): RScriptSlotHeader {
  if (bytes.length < SLOT_HEADER_SIZE) throw new Error('Truncated save slot');
  const view = new DataView(bytes.buffer, bytes.byteOffset, SLOT_HEADER_SIZE);
  const word = (i: number): number => view.getUint16(2 * i, true);
  const text = bytes.subarray(SLOT_TEXT.offset, SLOT_TEXT.offset + SLOT_TEXT.capacity);
  const end = text.indexOf(0);
  return {
    year: word(0),
    month: word(1),
    day: word(2),
    hour: word(3),
    minute: word(4),
    variables: [view.getInt16(10, true), view.getInt16(12, true), view.getInt16(14, true)],
    background: word(10),
    text: text.slice(0, end < 0 ? text.length : end),
  };
}

/** Loads a slot into the current scene and variables and the previous-choice snapshot. */
export function decodeSlotSave(memory: RScriptMemory, bytes: Uint8Array): void {
  const sceneSize = memory.scene.length;
  const variableBytes = 2 * GAME_VARIABLE_COUNT;
  if (bytes.length < SLOT_HEADER_SIZE + 2 * (sceneSize + variableBytes))
    throw new Error('Truncated save slot');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = SLOT_HEADER_SIZE;
  const take = (scene: Uint8Array, variables: Int16Array): void => {
    scene.set(bytes.subarray(offset, offset + sceneSize));
    offset += sceneSize;
    for (let i = 0; i < GAME_VARIABLE_COUNT; i++)
      variables[i] = view.getInt16(offset + 2 * i, true);
    offset += variableBytes;
  };
  take(memory.scene, memory.variables);
  take(memory.previousScene, memory.previousVariables);
}

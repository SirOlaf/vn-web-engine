import {ByteView} from '../../core/binary.js';
import {RScriptBitsetStore} from './bitset-store.js';
import {
  GAME_VARIABLE_COUNT,
  MAX_CALL_DEPTH,
  Scene,
  VARIABLE_COUNT,
  type RScriptMemory,
} from './memory.js';
import {RSCRIPT_1_11, type RScriptRevision} from './revision.js';

const SYSTEM_VARIABLES = VARIABLE_COUNT - GAME_VARIABLE_COUNT;

/**
 * System save `<prefix>.dat` (sub_421210 / sub_4212C0): the configuration block, the
 * persistent variables 7000..9999, then the read-text and seen-image flag stores.
 */
export function encodeSystemSave(memory: RScriptMemory): Uint8Array {
  const configSize = memory.revision.configSize;
  const readText = memory.readText.encode(),
    seenImages = memory.seenImages.encode();
  const bytes = new Uint8Array(
    configSize + 2 * SYSTEM_VARIABLES + readText.length + seenImages.length,
  );
  let offset = 0;
  bytes.set(memory.config.subarray(0, configSize), offset);
  offset += configSize;
  const view = new DataView(bytes.buffer, offset, 2 * SYSTEM_VARIABLES);
  for (let i = 0; i < SYSTEM_VARIABLES; i++)
    view.setInt16(2 * i, memory.variables[GAME_VARIABLE_COUNT + i]!, true);
  offset += 2 * SYSTEM_VARIABLES;
  bytes.set(readText, offset);
  bytes.set(seenImages, offset + readText.length);
  return bytes;
}

/**
 * Loads a system save. The save is decoded completely before memory changes, so a
 * rejected save leaves the configuration, variables and flags as they were.
 */
export function decodeSystemSave(memory: RScriptMemory, bytes: Uint8Array): void {
  const configSize = memory.revision.configSize;
  const fixed = configSize + 2 * SYSTEM_VARIABLES;
  if (bytes.length < fixed) throw new Error('Truncated system save');
  const readText = new RScriptBitsetStore(),
    seenImages = new RScriptBitsetStore();
  let offset = fixed + readText.decode(bytes, fixed);
  offset += seenImages.decode(bytes, offset);
  if (offset !== bytes.length) throw new Error('Unexpected data after the system save flags');
  const view = new ByteView(bytes, {littleEndian: true});
  memory.config.set(bytes.subarray(0, configSize));
  for (let i = 0; i < SYSTEM_VARIABLES; i++)
    memory.variables[GAME_VARIABLE_COUNT + i] = view.i16(configSize + 2 * i);
  memory.readText.assign(readText);
  memory.seenImages.assign(seenImages);
}

/** Page text kept in the slot header (sub_4213D0) for save screens. */
const SLOT_TEXT_CAPACITY = 80;

export interface RScriptSlotHeader {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  /** Variables 1..3 of the saved snapshot, used by title-specific save screens. */
  readonly variables: readonly [number, number, number];
  /** Background (layer 0) image of the saved snapshot; 0 in 1.9, which does not store it. */
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
  const {revision} = memory;
  const sceneSize = memory.scene.length;
  const variableBytes = 2 * GAME_VARIABLE_COUNT;
  const bytes = new Uint8Array(revision.slotHeaderSize + 2 * (sceneSize + variableBytes));
  const view = new DataView(bytes.buffer);
  const words = [
    date.getFullYear(),
    date.getMonth() + 1,
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
  ];
  words.forEach((value, i) => view.setUint16(2 * i, value, true));
  const titleVariables = revision.slotLiveVariables ? memory.variables : memory.messageVariables;
  for (let i = 0; i < 3; i++) view.setInt16(10 + 2 * i, titleVariables[1 + i]!, true);
  // Layer 0's image word in the snapshot (scene +0x8E).
  if (revision.slotBackground)
    view.setUint16(
      20,
      new DataView(memory.messageScene.buffer).getUint16(revision.sceneOffset(0x8e), true),
      true,
    );
  let length = 0;
  while (length < pageText.length && pageText[length] !== 0) {
    const step = isLead(pageText[length]!) ? 2 : 1;
    if (length + step > SLOT_TEXT_CAPACITY) break;
    length += step;
  }
  bytes.set(pageText.subarray(0, length), revision.slotTextOffset);
  let offset = revision.slotHeaderSize;
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

export function decodeSlotHeader(
  bytes: Uint8Array,
  revision: RScriptRevision = RSCRIPT_1_11,
): RScriptSlotHeader {
  if (bytes.length < revision.slotHeaderSize) throw new Error('Truncated save slot');
  const view = new ByteView(bytes, {littleEndian: true, end: revision.slotHeaderSize});
  return {
    year: view.u16(0),
    month: view.u16(2),
    day: view.u16(4),
    hour: view.u16(6),
    minute: view.u16(8),
    variables: [view.i16(10), view.i16(12), view.i16(14)],
    background: revision.slotBackground ? view.u16(20) : 0,
    text: view.cString(revision.slotTextOffset, SLOT_TEXT_CAPACITY).slice(),
  };
}

/** The scene and play-through variables of a slot, both at its message and previous choice. */
export interface RScriptSlotState {
  readonly scene: Uint8Array;
  readonly variables: Int16Array;
  readonly previousScene: Uint8Array;
  readonly previousVariables: Int16Array;
}

/**
 * Decodes a slot of the revision's exact size (sub_421570 reads the blocks the slot writer
 * stores, sub_4213D0). Scene blocks hold values only, no native pointers, but the interpreter
 * resumes from their call stacks: a call depth beyond the stacks is rejected here.
 */
export function parseSlotSave(revision: RScriptRevision, bytes: Uint8Array): RScriptSlotState {
  const sceneSize = revision.sceneSize;
  const variableBytes = 2 * GAME_VARIABLE_COUNT;
  const size = revision.slotHeaderSize + 2 * (sceneSize + variableBytes);
  if (bytes.length < size) throw new Error('Truncated save slot');
  if (bytes.length > size) throw new Error('The save slot belongs to another engine revision');
  const view = new ByteView(bytes, {littleEndian: true});
  let offset = revision.slotHeaderSize;
  const block = (): [Uint8Array, Int16Array] => {
    const scene = view.range(offset, sceneSize).slice();
    offset += sceneSize;
    const variables = Int16Array.from({length: GAME_VARIABLE_COUNT}, (_, i) =>
      view.i16(offset + 2 * i),
    );
    offset += variableBytes;
    const depth = new ByteView(scene, {littleEndian: true}).u16(
      revision.sceneOffset(Scene.callDepth),
    );
    if (depth > MAX_CALL_DEPTH) throw new Error(`Save slot call depth ${depth} is invalid`);
    return [scene, variables];
  };
  const [scene, variables] = block();
  const [previousScene, previousVariables] = block();
  return {scene, variables, previousScene, previousVariables};
}

/** Loads a parsed slot into the current scene and variables and the previous-choice snapshot. */
export function applySlotSave(memory: RScriptMemory, state: RScriptSlotState): void {
  memory.scene.set(state.scene);
  memory.variables.set(state.variables);
  memory.previousScene.set(state.previousScene);
  memory.previousVariables.set(state.previousVariables);
}

/** Loads a slot into the current scene and variables and the previous-choice snapshot. */
export function decodeSlotSave(memory: RScriptMemory, bytes: Uint8Array): void {
  applySlotSave(memory, parseSlotSave(memory.revision, bytes));
}

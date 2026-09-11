import type {OpcodeGroup} from './types.js';
import {group00} from './group-00.js';
import {group01} from './group-01.js';
import {group10} from './group-10.js';
/** Absent entries fault before any operands are consumed. */
export const opcodeGroups: ReadonlyMap<number, OpcodeGroup> = new Map([
  [0x00, group00],
  [0x01, group01],
  [0x10, group10],
]);

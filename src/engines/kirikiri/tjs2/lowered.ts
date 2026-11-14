import {NifTags} from '../../../compiler/nif/tags.js';
import {OP_NAMES} from './opcodes.js';

/**
 * Tags of the `tjs2vm` NIF dialect: the lowered stage of the TJS2 compiler, where every
 * context is a flat list of VM instructions with symbolic labels. Instruction tags are the
 * opcode names of `opcodes.ts` (`CONST`, `GPD`, …); the README of this directory describes
 * the node shapes.
 */
const STRUCTURE = [
  'module',
  'context',
  'layout',
  'handlers',
  'members',
  'm',
  'supers',
  'code',
  'label',
  // Call arguments
  'args',
  'omit',
  'xargs',
  'n',
  'x',
  'u',
  // Constants
  'void',
  'null',
  'nan',
  'inf',
  'neginf',
  'octet',
  'ctx',
  'array',
  'dict',
  'kv',
] as const;

export type Tjs2VmTag = (typeof STRUCTURE)[number];

export function createTjs2VmTags(): NifTags<Tjs2VmTag> {
  const tags = new NifTags<Tjs2VmTag>('tjs2vm', STRUCTURE);
  for (const name of OP_NAMES) tags.register(name);
  return tags;
}

export const TJS2VM_TAGS = createTjs2VmTags();
export const L = TJS2VM_TAGS.id;

/** Tag id of an opcode's instruction node. */
export const OP_TAG: readonly number[] = OP_NAMES.map((name) => TJS2VM_TAGS.find(name)!);

/** Opcode of an instruction tag id, or -1. */
export const TAG_OP: readonly number[] = (() => {
  const t: number[] = new Array(TJS2VM_TAGS.size).fill(-1);
  OP_TAG.forEach((tag, op) => (t[tag] = op));
  return t;
})();

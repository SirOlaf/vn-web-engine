import {Lua51, type LuaReference, type LuaTable, type LuaValue} from '../../core/lua51/runtime.js';
import type {ArtemisReadAheadName} from './files.js';

const LUA_TABLE = 5;
/** Instruction budget for evaluating one scenario file's table constructor. */
const SCENARIO_INSTRUCTIONS = 200_000_000;
/** Blocks followed from a jump target until one shows text. */
const JUMP_BLOCKS = 3;
const text = new TextDecoder('utf-8', {fatal: true});
const string = (value: LuaValue | undefined): string | undefined => {
  if (!(value instanceof Uint8Array)) return undefined;
  try {
    return text.decode(value);
  } catch {
    return undefined;
  }
};
const table = (value: LuaValue | undefined): LuaTable | undefined =>
  value instanceof Map ? value : undefined;
const number = (value: LuaValue | undefined): number | undefined =>
  typeof value === 'number' ? value : undefined;

/** Follows `name.key...` through Lua tables; null where a step is not a table. */
function field(vm: Lua51, path: readonly string[]): LuaReference | null {
  let reference = vm.referenceGlobal(path[0]!);
  for (const key of path.slice(1)) {
    if (reference.type !== LUA_TABLE) {
      reference.release();
      return null;
    }
    const next = reference.get(key);
    reference.release();
    reference = next;
  }
  return reference;
}
function value(vm: Lua51, path: readonly string[]): LuaValue | undefined {
  const reference = field(vm, path);
  if (!reference) return undefined;
  try {
    return reference.read();
  } finally {
    reference.release();
  }
}

/** The game's current scenario file and block (`scr.ip`), or undefined. */
export function artemisCurrentBlock(vm: Lua51): {file: string; block: string} | undefined {
  const file = string(value(vm, ['scr', 'ip', 'file'])),
    block = string(value(vm, ['scr', 'ip', 'block']));
  return file !== undefined && block !== undefined ? {file, block} : undefined;
}

/** One block of the loaded scenario (`ast[name]`) as a plain table. */
function block(vm: Lua51, name: string): LuaTable | undefined {
  const reference = field(vm, ['ast', name]);
  if (!reference) return undefined;
  try {
    return reference.type === LUA_TABLE ? table(reference.read()) : undefined;
  } finally {
    reference.release();
  }
}

/** A scenario file the game enters after the current line, and where it resumes. */
export interface ArtemisScenarioJump {
  readonly file: string;
  readonly label?: string;
  /** For a return: the caller's block and the tag it resumes after. */
  readonly block?: string;
  readonly count?: number;
}

/** Tags whose strings name scenarios, labels, expressions or titles rather than files. */
const CONTROL_TAGS = new Set(['excall', 'exreturn', 'eval', 'savetitle', 'achievements']);
/** File names of a block's tags from index `from` on: every string attribute of each
 * tag, under the tag's `path` directory when it has one, and the voices of its text. */
function blockNames(
  source: LuaTable,
  names: ArtemisReadAheadName[],
  map: ArtemisNameMap,
  from = 1,
): void {
  for (const [key, item] of source) {
    const entry = table(item);
    if (!entry || typeof key !== 'number' || key < from) continue;
    const tag = string(entry.get(1)) ?? '';
    if (CONTROL_TAGS.has(tag)) continue;
    const path = string(entry.get('path'));
    const directory = path?.startsWith(':') ? path : undefined;
    for (const [attribute, attributeValue] of entry) {
      if (attribute === 1 || attribute === 'path') continue;
      const name = string(attributeValue);
      if (!name || name.includes(' ') || name.length >= 128) continue;
      names.push((attribute === 'file' && map(tag, name)) || {directory, name});
    }
  }
  const voices = table(table(source.get('text'))?.get('vo'));
  for (const voice of voices?.values() ?? []) {
    const name = string(table(voice)?.get('file'));
    if (name) names.push({directory: ':vo/', name});
  }
}
/** The file a tag's `file` attribute plays when the game translates it, else undefined. */
export type ArtemisNameMap = (tag: string, name: string) => ArtemisReadAheadName | undefined;
const identity: ArtemisNameMap = () => undefined;

/** The game's sound name tables: a `bgm` name plays `:bgm/` + `csv.extra_bgm[name][2]`
 * (system/media/bgm.lua bgm_play) and an `se` name `csv.se[name]` (se.lua). */
export function artemisNameMap(vm: Lua51): ArtemisNameMap {
  const known = new Map<string, ArtemisReadAheadName | undefined>();
  return (tag, name) => {
    if (tag !== 'bgm' && tag !== 'se') return undefined;
    const key = `${tag}\0${name}`;
    if (!known.has(key)) {
      let found: ArtemisReadAheadName | undefined;
      if (tag === 'bgm') {
        const file = string(table(value(vm, ['csv', 'extra_bgm', name]))?.get(2));
        if (file) found = {directory: ':bgm/', name: file};
      } else {
        const file = string(value(vm, ['csv', 'se', name]));
        if (file) found = {name: file};
      }
      known.set(key, found);
      if (known.size > 256) known.delete(known.keys().next().value!);
    }
    return known.get(key);
  };
}
/** Tags of a block in order: `[index, name, tag]`. */
function tags(source: LuaTable): [number, string, LuaTable][] {
  const result: [number, string, LuaTable][] = [];
  for (const [key, item] of source) {
    const entry = table(item),
      name = string(entry?.get(1));
    if (entry && name && typeof key === 'number') result.push([key, name, entry]);
  }
  return result.sort((a, b) => a[0] - b[0]);
}
const hasText = (source: LuaTable) => tags(source).some(([, name]) => name === 'text');

/** `excall` (jump or call) and `exreturn` tags of a block from index `from` on. A return
 * resumes at the top of the game script stack `scr.gss` (system/adv/system.lua popGSS),
 * which only the running game (`vm`) has. */
function jumps(vm: Lua51 | null, source: LuaTable, from = 1): ArtemisScenarioJump[] {
  const found: ArtemisScenarioJump[] = [];
  for (const [index, name, tag] of tags(source)) {
    if (index < from) continue;
    if (name === 'excall') {
      const file = string(tag.get('file'));
      if (file) found.push({file, label: string(tag.get('label'))});
    } else if (name === 'exreturn' && vm) {
      const stack = table(value(vm, ['scr', 'gss']));
      const top = stack && table(stack.get(stack.size));
      const file = string(top?.get(1));
      if (top && file)
        found.push({file, block: string(top.get(2)), count: number(top.get(3)) ?? 1});
    }
  }
  return found;
}

/**
 * Names of the files the line after `current` uses: its `linknext` block and every block
 * of the same scenario a selection names; and the scenario files that `excall` and
 * `exreturn` tags of this block or the next enter, which `artemisJumpNames` resolves.
 */
export function artemisNextBlockNames(
  vm: Lua51,
  current: string,
  map: ArtemisNameMap = identity,
): {names: ArtemisReadAheadName[]; jumps: ArtemisScenarioJump[]} {
  const names: ArtemisReadAheadName[] = [],
    found: ArtemisScenarioJump[] = [];
  const here = block(vm, current);
  if (!here) return {names, jumps: found};
  found.push(...jumps(vm, here));
  const targets = new Set<string>();
  const next = string(here.get('linknext'));
  if (next) targets.add(next);
  const visit = (item: LuaValue | undefined, depth: number) => {
    const name = string(item);
    if (name?.startsWith('block_')) targets.add(name);
    const entry = table(item);
    if (entry && depth < 4) for (const child of entry.values()) visit(child, depth + 1);
  };
  visit(here.get('select'), 0);
  for (const target of targets) {
    const source = block(vm, target);
    if (!source) continue;
    blockNames(source, names, map);
    if (target === next) found.push(...jumps(vm, source));
  }
  return {names, jumps: found};
}

/** The path the game includes for scenario `file` (system/adv/mainloop.lua
 * readScriptFile); undefined for numeric names under `init.script_format`. */
export function artemisScenarioPath(vm: Lua51, file: string): string | undefined {
  const format = string(value(vm, ['init', 'script_format'])),
    directory = string(value(vm, ['init', 'script_path'])),
    extension = string(value(vm, ['init', 'script_ext']));
  if (directory === undefined || extension === undefined) return undefined;
  if (format && /^\d+$/.test(file)) return undefined;
  return directory + file + extension;
}

/**
 * Adds the names of the files a jump target shows first: from the target label's block
 * (or, for a return, the caller's block after the tag it resumes after) through the
 * first block with text, at most `JUMP_BLOCKS` blocks. The scenario is evaluated in its
 * own Lua state. Returns a jump met on the way (a flow script calling the next scenario).
 */
export function artemisJumpNames(
  bytes: Uint8Array,
  path: string,
  jump: ArtemisScenarioJump,
  names: ArtemisReadAheadName[],
  map: ArtemisNameMap = identity,
): ArtemisScenarioJump[] {
  const vm = new Lua51(SCENARIO_INSTRUCTIONS);
  try {
    vm.execute(bytes, path);
    let current = jump.block,
      from = (jump.count ?? 0) + 1;
    if (current === undefined) {
      const label =
        table(value(vm, ['ast', 'label', jump.label ?? 'top'])) ??
        table(value(vm, ['ast', 'label', 'top']));
      current = string(label?.get('block')) ?? 'block_00000';
      from = number(label?.get('label')) ?? 1;
    }
    for (let count = 0; current && count < JUMP_BLOCKS; count++) {
      const source = block(vm, current);
      if (!source) break;
      blockNames(source, names, map, from);
      const further = jumps(null, source, from);
      if (further.length) return further;
      if (hasText(source)) break;
      current = string(source.get('linknext'));
      from = 1;
    }
    return [];
  } finally {
    vm.close();
  }
}

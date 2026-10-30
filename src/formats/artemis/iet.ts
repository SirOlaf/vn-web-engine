import type {AsbLabel, AsbTag} from './asb.js';

export interface IetProgram {
  readonly records: readonly (AsbTag | AsbLabel)[];
  readonly tags: readonly AsbTag[];
  readonly labels: ReadonlyMap<string, number>;
}

/** Compiler-generated jump tag and its decimal target index (0x14036b964, 0x1403718c8).
 * The 0x0b prefix keeps them out of script-authored names. */
export const ARTEMIS_GOTO_TAG = '\x0bgoto';
export const ARTEMIS_INDEX_ARG = '\x0bindex';

/** Confirmed boot grammar. Plain dialogue, @ commands and tag.ini syntax are refused. */
export function parseIet(bytes: Uint8Array): IetProgram {
  const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  if (text.includes('\0')) throw new Error('Invalid IET NUL');
  const records: (AsbTag | AsbLabel)[] = [],
    tags: AsbTag[] = [],
    labels = new Map<string, number>();
  let p = 0,
    line = 0;
  const fail = (reason: string): never => {
    throw new Error(`IET line ${line}: ${reason}`);
  };
  const take = () => {
    const c = text[p++]!;
    if (c === '\n') line++;
    return c;
  };
  const skip = (spaces = true) => {
    while (p < text.length) {
      if (text[p] === '\t' || text[p] === '\r' || (spaces && /[ \n]/.test(text[p]!))) {
        take();
        continue;
      }
      if (text.startsWith('//', p) || text[p] === ';') {
        while (p < text.length && text[p] !== '\n') take();
        continue;
      }
      if (text.startsWith('/*', p)) {
        take();
        take();
        while (p < text.length && !text.startsWith('*/', p)) take();
        if (p === text.length) fail('Unterminated comment');
        take();
        take();
        continue;
      }
      break;
    }
  };
  const word = (stops: string): string => {
    let result = '';
    while (p < text.length) {
      const c = text[p]!;
      if (stops.includes(c) || c === '\t' || c === '\r') break;
      if (c === '\\') {
        take();
        if (p === text.length) fail('Incomplete escape');
        result += take();
      } else result += take();
    }
    return result;
  };
  const add = (name: string, sourceLine: number, args: Map<string, string>) => {
    const tag: AsbTag = {kind: 'tag', name, sourceLine, args};
    tags.push(tag);
    records.push(tag);
  };
  // 0x14011a740 lowers conditionals and loops into compiler-only `\x0bgoto` tags.
  // Each open if keeps the index of its pending conditional tag (-1 after else) and
  // the gotos that leave its branches; `\x0bindex` receives a decimal tag index.
  const conditionals: number[] = [],
    exits: number[][] = [],
    loops: number[] = [];
  const target = (index: number, value: number) =>
    (tags[index]!.args as Map<string, string>).set(ARTEMIS_INDEX_ARG, String(value));
  const goto = (value?: number) => {
    const args = new Map<string, string>();
    if (value !== undefined) args.set(ARTEMIS_INDEX_ARG, String(value));
    add(ARTEMIS_GOTO_TAG, 0, args);
  };
  const branch = (name: string): boolean => {
    if (name === 'if') {
      conditionals.push(tags.length);
      exits.push([]);
      return false;
    }
    if (name === 'elseif' || name === 'else') {
      if (!conditionals.length) fail(`${name} without matching if`);
      if (conditionals.at(-1)! < 0) fail(`${name} after else`);
      exits.at(-1)!.push(tags.length);
      goto();
      target(conditionals.at(-1)!, tags.length);
      if (name === 'else') {
        conditionals[conditionals.length - 1] = -1;
        return true;
      }
      conditionals[conditionals.length - 1] = tags.length;
      return false;
    }
    if (name === '/if') {
      if (!conditionals.length) fail('/if without matching if');
      const pending = conditionals.pop()!;
      if (pending >= 0) target(pending, tags.length);
      for (const exit of exits.pop()!) target(exit, tags.length);
      return true;
    }
    if (name === 'loop') {
      loops.push(tags.length);
      return false;
    }
    if (name === '/loop') {
      if (!loops.length) fail('/loop without matching loop');
      const start = loops.pop()!;
      goto(start);
      target(start, tags.length);
      return true;
    }
    return false;
  };
  while (p < text.length) {
    skip();
    if (p === text.length) break;
    if (text[p] === '*') {
      const before = text.lastIndexOf('\n', p - 1) + 1;
      if (text.slice(before, p).trim()) fail('Label must start a line');
      take();
      const name = word(' \n');
      if (!name) fail('Empty label');
      labels.set(name, tags.length);
      records.push({kind: 'label', name, tagIndex: tags.length});
      skip(false);
      if (p < text.length && text[p] !== '\n') fail('Unsupported label suffix');
      continue;
    }
    if (text[p] !== '[') fail('Unsupported text/command syntax');

    take();
    skip();
    const name = word(' \n=]');
    if (!name) fail('Empty tag');
    const args = new Map<string, string>();
    let positional = 0;
    while (true) {
      skip();
      if (p === text.length) fail('Unterminated tag');
      if (text[p] === ']') {
        take();
        break;
      }
      const key = word(' \n=]');
      if (!key) fail('Empty argument');
      skip();
      if (text[p] !== '=') {
        args.set(String(positional++), key);
        continue;
      }
      take();
      skip();
      let value: string;
      if (text[p] === '"') {
        take();
        value = '';
        while (p < text.length && text[p] !== '"') {
          if (text[p] === '\\') {
            take();
            if (p === text.length) fail('Incomplete escape');
          }
          value += take();
        }
        if (p === text.length) fail('Unterminated quote');
        take();
      } else value = word(' \n]');
      args.set(key, value);
    }
    if (name === 'lua') {
      if (args.size) fail('Unsupported lua block arguments');
      const start = p;
      while (p < text.length && !text.startsWith('[/lua]', p)) take();
      if (p === text.length) fail('Unterminated lua block');
      args.set('script', text.slice(start, p));
      for (let i = 0; i < 6; i++) take();
    }
    if (!branch(name)) add(name, line, args);
  }
  return {records, tags, labels};
}

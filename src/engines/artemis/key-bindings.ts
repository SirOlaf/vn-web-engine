import type {AsbTag} from '../../formats/artemis/asb.js';
import {captureEventCommand} from './event-commands.js';

function integer(value: string): number {
  const token = /^[\t\n\v\f\r ]*([+-]?\d+)/.exec(value);
  const number = token ? Number(token[1]) : 0;
  if (!Number.isInteger(number) || number < -0x80000000 || number > 0x7fffffff)
    throw new Error('Unsupported Artemis key integer');
  return number;
}
export interface ArtemisKeyRole {
  readonly keys: ReadonlySet<number>;
  readonly special136: boolean;
  readonly special137: boolean;
}
/** CArtemisKeyConfig constructor 0x1400c2bc0, in insertion order through the add helper
 * 0x1400acbb0 (136 → +0x20 flag, 137 → +0x30 flag, other codes → +0x10 ordinary set). */
const defaultRoles: readonly (readonly [number, readonly number[]])[] = [
  [0, [1, 136, 13]],
  [1, [2, 27]],
  [2, [2, 27]],
  [3, [32]],
  [4, [1, 137, 13, 2, 27, 32, 136, 38, 40, 65, 16, 17]],
  [5, [136, 38]],
  [6, [2, 27]],
  [7, [136, 38]],
  [8, [137, 40]],
  [9, [65]],
  [10, [1, 137, 13, 2, 27, 32, 136, 38, 40, 65, 16, 17]],
  [11, [2, 27, 32, 136, 38, 40, 65, 16, 17]],
  [12, [16]],
  [13, [1, 137, 13, 2, 27, 32, 136, 38, 40, 65, 16, 17]],
  [14, [17]],
  [0, [0x8a]],
  [1, [0x8b]],
  [2, [0x8b]],
  [3, [0x9a]],
  [4, [0x8a, 0x8b, 0x9a, 0x97, 0x99, 0x8f, 0x98, 0x8c]],
  [5, [0x97]],
  [6, [0x8b]],
  [7, [0x97]],
  [8, [0x99]],
  [9, [0x8f]],
  [10, [0x8a, 0x8b, 0x9a, 0x97, 0x99, 0x8f, 0x98, 0x8c]],
  [11, [0x8b, 0x9a, 0x97, 0x99, 0x8f, 0x98, 0x8c]],
  [12, [0x98]],
  [13, [0x8a, 0x8b, 0x9a, 0x97, 0x99, 0x8f, 0x98, 0x8c]],
  [14, [0x8c]],
];

/** Native role configuration (CArtemisKeyConfig ordinary key map +0x10 and the 136/137
 * flag maps +0x20/+0x30), the role queries over the input owner and both push-handler
 * maps.
 */
export class ArtemisKeyBindings {
  private readonly ordinary = new Map<number, Set<number>>();
  private readonly special136 = new Set<number>();
  private readonly special137 = new Set<number>();
  private readonly pushHandlers = [new Map<number, AsbTag>(), new Map<number, AsbTag>()] as const;
  constructor(
    private readonly currentFile: () => string = () => {
      throw new Error('Artemis event registration requires the current script file');
    },
  ) {
    this.constructDefaults();
  }
  private constructDefaults(): void {
    this.ordinary.clear();
    this.special136.clear();
    this.special137.clear();
    for (const [role, keys] of defaultRoles) for (const key of keys) this.add(role, key);
  }
  /** 0x1400acbb0. */
  private add(role: number, key: number): void {
    if (key === 136) this.special136.add(role);
    else if (key === 137) this.special137.add(role);
    else {
      let keys = this.ordinary.get(role);
      if (!keys) this.ordinary.set(role, (keys = new Set()));
      keys.add(key);
    }
  }
  role(id: number): ArtemisKeyRole | undefined {
    const keys = this.ordinary.get(id);
    const special136 = this.special136.has(id),
      special137 = this.special137.has(id);
    if (!keys && !special136 && !special137) return undefined;
    return {keys: new Set([...(keys ?? [])].sort((a, b) => a - b)), special136, special137};
  }
  /** Role query over input `kind` (0x1400ad130 with decide, 0x1400acec0 with down): the
   * 136 flag asks key 0x88, the 137 flag key 0x89, then each ordinary key ascending, until
   * one answers. The click query 0x1400b5690 (`decide`) also refuses Alt+Enter: a role
   * holding key 13 is not decided while Alt (0x12) is down and Enter decided. */
  roleActive(
    id: number,
    kind: 'decide' | 'down',
    query: (kind: 'decide' | 'down', key: number) => boolean,
  ): boolean {
    const keys = [...(this.ordinary.get(id) ?? [])].sort((a, b) => a - b);
    const active =
      (this.special136.has(id) && query(kind, 0x88)) ||
      (this.special137.has(id) && query(kind, 0x89)) ||
      keys.some((key) => query(kind, key));
    if (!active || kind === 'down') return active;
    return !(keys.includes(13) && query('down', 0x12) && query('decide', 13));
  }
  /** Section 0x41 (0x1400f4f90): the ordinary key map, roles and keys ascending. */
  keyRoles(): Map<number, number[]> {
    return new Map(
      [...this.ordinary]
        .sort(([a], [b]) => a - b)
        .map(([role, keys]) => [role, [...keys].sort((a, b) => a - b)]),
    );
  }
  /** Loader: a newly constructed key configuration (0x1400f5d60) whose ordinary map is
   * cleared and read (0x1400b5830); the 136/137 maps keep the constructor defaults. */
  loadKeyRoles(roles: ReadonlyMap<number, readonly number[]>): void {
    this.constructDefaults();
    this.ordinary.clear();
    for (const [role, keys] of roles) this.ordinary.set(role, new Set(keys));
  }
  /** Sections 0x38 and 0x4e: copies of both push-handler maps. */
  pushHandlerMaps(): [Map<number, AsbTag>, Map<number, AsbTag>] {
    const copy = (map: ReadonlyMap<number, AsbTag>) =>
      new Map([...map].map(([key, tag]) => [key, {...tag, args: new Map(tag.args)}]));
    return [copy(this.pushHandlers[0]), copy(this.pushHandlers[1])];
  }
  loadPushHandlers(
    maps: readonly [ReadonlyMap<number, AsbTag>, ReadonlyMap<number, AsbTag>],
  ): void {
    this.resetPushHandlers();
    for (const slot of [0, 1] as const)
      for (const [key, tag] of maps[slot]) this.storePushHandler(key, slot, tag);
  }
  /** bf210 empties both push maps (3890/38a0); key roles remain. */
  resetPushHandlers(): void {
    this.pushHandlers[0].clear();
    this.pushHandlers[1].clear();
  }
  /** Owner-side storage of a copied command in native push-map slot 0 or 1. */
  storePushHandler(key: number, slot: 0 | 1, tag: AsbTag): void {
    this.pushHandlers[slot].set(key, {...tag, args: new Map(tag.args)});
  }
  pushHandler(key: number, slot: 0 | 1): AsbTag | undefined {
    const tag = this.pushHandlers[slot].get(key);
    return tag ? {...tag, args: new Map(tag.args)} : undefined;
  }
  /** c0560 run mode 1/3 slice (capture mode 0): slot 0 (map 0x3890, input virtual +0x38)
   * then slot 1 (map 0x38a0, input virtual +0x18), each in ascending key order. A pushed
   * key's copied command goes to c6730; a delivered (not failed) command ends the frame's
   * mode processing, reported here as true. */
  deliverPushed(
    pushed: (key: number, slot: 0 | 1) => boolean,
    dispatch: (command: AsbTag) => boolean,
  ): boolean {
    for (const slot of [0, 1] as const)
      for (const key of [...this.pushHandlers[slot].keys()].sort((a, b) => a - b)) {
        const command = this.pushHandler(key, slot);
        if (command && pushed(key, slot) && !dispatch(command)) return true;
      }
    return false;
  }
  dispatch(tag: AsbTag): boolean {
    const p = tag.args;
    if (tag.name === 'setonpush') {
      const command = captureEventCommand(tag, this.currentFile);
      const key = integer(p.get('key') ?? '');
      const slot = !p.has('keyrepeat') || p.get('keyrepeat') === '0' ? 0 : 1;
      this.storePushHandler(key, slot, command);
      return true;
    }
    if (tag.name === 'delonpush') {
      const key = integer(p.get('key') ?? '');
      this.pushHandlers[0].delete(key);
      this.pushHandlers[1].delete(key);
      return true;
    }
    if (tag.name !== 'keyconfig') return false;
    if (!p.has('role')) throw new Error('Missing Artemis keyconfig role');
    const id = integer(p.get('role')!);
    // Native clears ordinary keys and both special flags even when keys is absent.
    this.ordinary.set(id, new Set());
    this.special136.delete(id);
    this.special137.delete(id);
    if (p.has('keys')) for (const token of p.get('keys')!.split(',')) this.add(id, integer(token));
    return true;
  }
}

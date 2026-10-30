import type {AsbTag} from '../../formats/artemis/asb.js';
import {artemisRevision} from './revision.js';
import {artemisMapOrder} from './save-data.js';

const copy = (tag: AsbTag): AsbTag => ({...tag, args: new Map(tag.args)});

/** Native layer command registry +0x68 and coalescing helper 0x140144570.
 * These are original command arguments, not native save serialization.
 */
export class ArtemisLayerCommands {
  private readonly lists = new Map<string, AsbTag[]>();
  constructor(executableSha256: string) {
    artemisRevision(executableSha256);
  }
  /** bf210 save-object reset empties the whole registry (+0x68). */
  clearAll(): void {
    this.lists.clear();
  }
  /** 0x1400edec0 move-assigned to the id: a list holding only a copy of `tag`. */
  reset(id: string, tag: AsbTag): void {
    this.lists.set(id, [copy(tag)]);
  }
  clear(ids: readonly string[]): void {
    for (const id of ids) this.lists.delete(id);
  }
  record(tag: AsbTag, equalKeys: ReadonlySet<string> = new Set()): void {
    // Native find(id) returns without creating a list when the argument is absent.
    if (!tag.args.has('id')) return;
    const id = tag.args.get('id')!;
    let list = this.lists.get(id);
    if (!list) {
      list = [];
      this.lists.set(id, list);
    }
    for (let index = list.length - 1; index >= 0; index--) {
      const old = list[index]!;
      if (old.name !== tag.name) continue;
      if (
        [...equalKeys].some(
          (key) =>
            !old.args.has(key) || !tag.args.has(key) || old.args.get(key) !== tag.args.get(key),
        )
      )
        continue;
      const merged = new Map(old.args);
      for (const [key, value] of tag.args) merged.set(key, value);
      // Native argument values are byte strings: an overwritten key takes the new value's
      // exact bytes, or none when the new value is plain text.
      let bytes = old.bytes;
      if (bytes || tag.bytes) {
        const values = new Map(bytes);
        for (const key of tag.args.keys()) {
          const exact = tag.bytes?.get(key);
          if (exact) values.set(key, exact);
          else values.delete(key);
        }
        bytes = values;
      }
      // Native only overwrites the argument map, retaining the earlier line/name.
      const {bytes: _bytes, ...rest} = old;
      list[index] = {...rest, args: merged, ...(bytes?.size ? {bytes} : {})};
      return;
    }
    list.push(copy(tag));
  }
  /** Unconditional append of a command copy to the id's list (find-or-create). */
  append(id: string, tag: AsbTag): void {
    let list = this.lists.get(id);
    if (!list) this.lists.set(id, (list = []));
    list.push(copy(tag));
  }
  /** Native 0x140144960: remove every command with this name whose arguments contain each
   * key/value of `keys`. The id's list is created when absent; nothing is appended. */
  erase(id: string, name: string, keys: ReadonlyMap<string, string>): void {
    const list = this.lists.get(id) ?? [];
    this.lists.set(
      id,
      list.filter(
        (tag) =>
          tag.name !== name ||
          [...keys].some(([key, value]) => !tag.args.has(key) || tag.args.get(key) !== value),
      ),
    );
  }
  commands(id: string): readonly AsbTag[] | undefined {
    return this.lists.get(id)?.map(copy);
  }
  snapshot(): ReadonlyMap<string, readonly AsbTag[]> {
    return new Map(artemisMapOrder(this.lists).map(([id, tags]) => [id, tags.map(copy)]));
  }
  /** Scenario load: the registry becomes the saved +0x68 map. */
  restore(snapshot: ReadonlyMap<string, readonly AsbTag[]>): void {
    this.lists.clear();
    for (const [id, tags] of snapshot) this.lists.set(id, tags.map(copy));
  }
}

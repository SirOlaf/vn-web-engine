import {artemisRevision} from './revision.js';

export type ArtemisSceneView = 'current' | 'retained';
export interface ArtemisSceneEntry<T> {
  readonly id: string;
  readonly value: T | undefined;
  readonly acceptsChildren: boolean;
}
/** A layer node held by an owner beyond its tree membership (for example a tween setter). */
export interface ArtemisSceneLayer<T> {
  /** CArtemisLayer setters 0x1400b22e0..0x1400b2660: the current inner actor, then the
   * retained one when the two indices differ. Empty once the node is destroyed. */
  actors(): readonly T[];
  /** True once the last tree reference is released; a destroyed node never returns to a
   * tree, so a lookup by id can no longer reach it. */
  readonly destroyed: boolean;
}
function integerKey(key: string): number | null {
  // Native 0x1401856c0 accepts a lone minus sign; atoi then yields zero.
  if (!/^-?\d*$/.test(key) || !key) return null;
  const number = key === '-' ? 0 : Number(key);
  if (!Number.isSafeInteger(number) || number < -0x80000000 || number > 0x7fffffff)
    throw new Error('Unsupported Artemis numeric layer id');
  return number;
}
/** Validated keys: the integer value, or null for a key compared by its UTF-8 bytes. */
const keyKinds = new Map<string, number | null>();
function keyKind(key: string): number | null {
  let kind = keyKinds.get(key);
  if (kind !== undefined) return kind;
  kind = integerKey(key);
  if (kind === null) {
    if (key.includes('\0') || /[\uD800-\uDFFF]/u.test(key))
      throw new Error('Invalid Artemis UTF-8 layer id');
  }
  // Layer ids repeat; the bound only limits a script that generates them without end.
  if (keyKinds.size >= 0x4000) keyKinds.clear();
  keyKinds.set(key, kind);
  return kind;
}
const astral = /[\uD800-\uDBFF]/;
function compare(a: string, b: string, emptyIsZero: boolean): number {
  const left = emptyIsZero && a === '' ? 0 : keyKind(a),
    right = emptyIsZero && b === '' ? 0 : keyKind(b);
  if (left !== null && right !== null) return left < right ? -1 : left > right ? 1 : 0;
  // UTF-8 byte order is code-point order, shorter prefix first. Without surrogate pairs
  // that is UTF-16 code-unit order.
  if (!astral.test(a) && !astral.test(b)) return a < b ? -1 : a > b ? 1 : 0;
  const x = [...a].map((c) => c.codePointAt(0)!),
    y = [...b].map((c) => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(x.length, y.length); i++)
    if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  return x.length < y.length ? -1 : x.length > y.length ? 1 : 0;
}
interface Child<T> {
  readonly key: string;
  node: Node<T>;
}
class PayloadLifetime<T> {
  readonly references = new Map<T, number>();
  constructor(
    readonly emptyIsZero: boolean,
    private readonly released?: (value: T) => void,
    readonly nodeReleased?: (values: readonly T[]) => void,
  ) {}
  retain(value: T | undefined): void {
    if (value !== undefined) this.references.set(value, (this.references.get(value) ?? 0) + 1);
  }
  release(value: T | undefined): void {
    if (value === undefined) return;
    const count = this.references.get(value)! - 1;
    if (count) this.references.set(value, count);
    else {
      this.references.delete(value);
      this.released?.(value);
    }
  }
}
class Node<T> implements ArtemisSceneLayer<T> {
  private readonly maps: [Child<T>[], Child<T>[]] = [[], []];
  private readonly values: [T | undefined, T | undefined];
  private currentMap = 0;
  private retainedMap = 0;
  private currentValue = 0;
  private retainedValue = 0;
  private references = 0;
  private released = false;
  constructor(
    value: T | undefined,
    readonly acceptsChildren: boolean,
    private readonly lifetime: PayloadLifetime<T>,
  ) {
    this.values = [value, undefined];
    lifetime.retain(value);
  }
  retain(): void {
    this.references++;
  }
  get destroyed(): boolean {
    return this.released;
  }
  release(): void {
    if (--this.references) return;
    this.released = true;
    // Capture/mask members precede both child-map and holder-slot destructors.
    this.lifetime.nodeReleased?.(this.values.filter((value): value is T => value !== undefined));
    // 0x1400b1860 destroys map slots 1,0 before inner-actor slots 1,0.
    this.clearMap(1);
    this.clearMap(0);
    this.clearValue(1);
    this.clearValue(0);
  }
  private clearMap(index: number): void {
    const entries = this.maps[index]!;
    this.maps[index] = [];
    // Full-map clear 0x1400ec380 / 0x1400f0f70 releases descending keys.
    for (let i = entries.length - 1; i >= 0; i--) entries[i]!.node.release();
  }
  private clearValue(index: number): void {
    const value = this.values[index];
    this.values[index] = undefined;
    this.lifetime.release(value);
  }
  value(view: ArtemisSceneView): T | undefined {
    return this.values[view === 'current' ? this.currentValue : this.retainedValue];
  }
  actors(): readonly T[] {
    const current = this.values[this.currentValue],
      retained = this.values[this.retainedValue];
    const result = current === undefined ? [] : [current];
    if (this.retainedValue !== this.currentValue && retained !== undefined) result.push(retained);
    return result;
  }
  edit(copy: (value: T) => T, create?: () => T): T | undefined {
    const value = this.value('current');
    if (
      (value !== undefined && this.currentValue === this.retainedValue) ||
      (value === undefined && create)
    ) {
      const replacement = value === undefined ? create!() : copy(value);
      this.currentValue = 1 - this.retainedValue;
      this.values[this.currentValue] = replacement;
      this.lifetime.retain(replacement);
    }
    return this.value('current');
  }
  children(view: ArtemisSceneView): readonly Child<T>[] {
    return this.maps[view === 'current' ? this.currentMap : this.retainedMap]!;
  }
  private index(key: string, entries: readonly Child<T>[]): number {
    const cmp = (a: string, b: string): number => compare(a, b, this.lifetime.emptyIsZero);
    // Rev.2908 0x5eeb50 / Rev.3179 0x140185740: numeric/numeric uses atoi,
    // every other pair uses byte order. Mixed components are valid when this
    // sibling domain (including the lookup key) still has a strict weak order.
    // E.g. 2 < 10 < 1x < 2 is cyclic; binary search cannot model that native tree.
    // Validate ALL comparisons for risky domains, including equivalent spellings
    // on lookup; never silently impose an arbitrary JS sort order on a cycle.
    const risky = (value: string): boolean =>
      (this.lifetime.emptyIsZero && value === '') ||
      (keyKind(value) === null && /^[\x2d-\x39]/.test(value));
    if (risky(key) || entries.some((entry) => risky(entry.key))) {
      let previous = -1;
      for (const entry of entries) {
        const order = cmp(entry.key, key);
        if (order < previous) throw new Error('Unsupported Artemis nontransitive layer key domain');
        previous = order;
      }
    }
    let low = 0,
      high = entries.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (cmp(entries[middle]!.key, key) < 0) low = middle + 1;
      else high = middle;
    }
    return low;
  }
  child(key: string, view: ArtemisSceneView): Child<T> | undefined {
    const entries = this.children(view),
      entry = entries[this.index(key, entries)];
    return entry && compare(entry.key, key, this.lifetime.emptyIsZero) === 0 ? entry : undefined;
  }
  assign(key: string, node: Node<T> | null): boolean {
    let entries = this.maps[this.currentMap]!;
    const index = this.index(key, entries);
    const exists =
      index < entries.length && compare(entries[index]!.key, key, this.lifetime.emptyIsZero) === 0;
    if (!node && !exists) return false;
    if (this.currentMap === this.retainedMap) {
      this.currentMap = 1 - this.retainedMap;
      entries = entries.map((entry) => {
        entry.node.retain();
        return {...entry};
      });
      this.maps[this.currentMap] = entries;
    }
    const old = exists ? entries[index]!.node : undefined;
    node?.retain();
    if (!node) entries.splice(index, 1);
    else if (exists) entries[index]!.node = node;
    else entries.splice(index, 0, {key, node});
    old?.release();
    return true;
  }
  commit(): void {
    // 0x1400b3340 commits current children ascending, then releases its old
    // inner actor before clearing the old child map.
    for (const entry of this.children('current')) entry.node.commit();
    if (this.retainedValue !== this.currentValue) this.clearValue(this.retainedValue);
    if (this.retainedMap !== this.currentMap) this.clearMap(this.retainedMap);
    this.retainedMap = this.currentMap;
    this.retainedValue = this.currentValue;
  }
}

/** UTF-8 subset of CLayerSet's hierarchical child maps, independent of raster/geometry owners.
 * Mutation updates current child maps; commit releases the retained structural version.
 */
export class ArtemisScene<T> {
  private root: Node<T>;
  private readonly lifetime: PayloadLifetime<T>;
  /** Release notifications must only record effects, without throwing or mutating this scene. */
  constructor(
    executableSha256: string,
    onPayloadReleased?: (value: T) => void,
    private readonly createGroup?: () => T,
    onNodeReleased?: (values: readonly T[]) => void,
  ) {
    const revision = artemisRevision(executableSha256);
    this.lifetime = new PayloadLifetime(
      revision.emptyLayerKeyIsZero === true,
      onPayloadReleased,
      onNodeReleased,
    );
    this.root = new Node(undefined, true, this.lifetime);
    this.root.retain();
  }
  private path(id: string): string[] {
    const parts = id.split('.');
    if (parts.length > 256) throw new Error('Artemis layer id depth limit exceeded');
    for (const part of parts) keyKind(part);
    return parts;
  }
  /** Image-backed constructor 0x1400b1690 has type 1; empty groups have type 0. */
  set(id: string, value: T | undefined, acceptsChildren = false): boolean {
    const parts = this.path(id);
    let parent = this.root;
    for (const key of parts.slice(0, -1)) {
      if (!parent.acceptsChildren) return false;
      let child = parent.child(key, 'current');
      if (!child) {
        parent.assign(key, new Node<T>(this.createGroup?.(), true, this.lifetime));
        child = parent.child(key, 'current')!;
      }
      parent = child.node;
    }
    return (
      parent.acceptsChildren &&
      parent.assign(
        parts.at(-1)!,
        new Node(
          value === undefined && acceptsChildren ? this.createGroup?.() : value,
          acceptsChildren,
          this.lifetime,
        ),
      )
    );
  }
  remove(id: string): boolean {
    const parts = this.path(id);
    let parent = this.root;
    for (const key of parts.slice(0, -1)) {
      const child = parent.child(key, 'current');
      if (!parent.acceptsChildren || !child) return false;
      parent = child.node;
    }
    return parent.acceptsChildren && parent.assign(parts.at(-1)!, null);
  }
  entry(id: string, view: ArtemisSceneView = 'current'): ArtemisSceneEntry<T> | undefined {
    let parent = this.root;
    const canonical: string[] = [];
    for (const key of this.path(id)) {
      if (!parent.acceptsChildren) return undefined;
      const child = parent.child(key, view);
      if (!child) return undefined;
      canonical.push(child.key);
      parent = child.node;
    }
    return {
      id: canonical.join('.'),
      value: parent.value(view),
      acceptsChildren: parent.acceptsChildren,
    };
  }
  /** The node at `id` in the current structure, without copying its inner actor. */
  layer(id: string): ArtemisSceneLayer<T> | undefined {
    let node = this.root;
    for (const key of this.path(id)) {
      if (!node.acceptsChildren) return undefined;
      const child = node.child(key, 'current');
      if (!child) return undefined;
      node = child.node;
    }
    return node === this.root ? undefined : node;
  }
  /** Inner-actor copy on first edit; empty group defaults may be materialized lazily.
   * The retained view keeps its old payload (or default identity) until commit. */
  editValue(id: string, copy: (value: T) => T, createGroup?: () => T): T | undefined {
    let node = this.root;
    for (const key of this.path(id)) {
      if (!node.acceptsChildren) return undefined;
      const child = node.child(key, 'current');
      if (!child) return undefined;
      node = child.node;
    }
    if (createGroup && !node.acceptsChildren)
      throw new Error('Cannot initialize a non-group scene payload');
    return node.edit(copy, createGroup);
  }
  /** All payloads held by reachable nodes, including inner retained versions. */
  payloads(): ReadonlySet<T> {
    return new Set(this.lifetime.references.keys());
  }
  /** Destroy both physical structural buffers in native member order. */
  clear(): void {
    this.root.release();
    this.root = new Node(undefined, true, this.lifetime);
    this.root.retain();
  }
  /** Native 0x140113e50 selects the node and its descendants using the requested prefix.
   * Numeric aliases retain the caller's spelling in the selected identifiers.
   */
  select(id: string): readonly ArtemisSceneEntry<T>[] {
    let node = this.root;
    for (const key of this.path(id)) {
      if (!node.acceptsChildren) return [];
      const child = node.child(key, 'current');
      if (!child) return [];
      node = child.node;
    }
    const result: ArtemisSceneEntry<T>[] = [
      {id, value: node.value('current'), acceptsChildren: node.acceptsChildren},
    ];
    this.visit(node, id + '.', 'current', result);
    return result;
  }
  private visit(
    node: Node<T>,
    prefix: string,
    view: ArtemisSceneView,
    result: ArtemisSceneEntry<T>[],
    reverse = false,
  ): void {
    if (!node.acceptsChildren) return;
    const children = node.children(view);
    for (let index = 0; index < children.length; index++) {
      const child = children[reverse ? children.length - index - 1 : index]!;
      const id = prefix + child.key;
      result.push({id, value: child.node.value(view), acceptsChildren: child.node.acceptsChildren});
      this.visit(child.node, id + '.', view, result, reverse);
    }
  }
  /** Borrowed payloads in native child order; not the native layer-selection/enumeration API. */
  entries(view: ArtemisSceneView = 'current'): readonly ArtemisSceneEntry<T>[] {
    const result: ArtemisSceneEntry<T>[] = [];
    this.visit(this.root, '', view, result);
    return result;
  }
  /** Native 0x140186770 prepares children ascending; GPU images paint in this pass. */
  prepareEntries(view: ArtemisSceneView = 'retained'): readonly ArtemisSceneEntry<T>[] {
    return this.entries(view);
  }
  /** Ordinary non-raster callbacks (0x1401864a0): group first, then descending children.
   * GPU images paint separately through prepareEntries. */
  drawEntries(view: ArtemisSceneView = 'retained'): readonly ArtemisSceneEntry<T>[] {
    const result: ArtemisSceneEntry<T>[] = [];
    this.visit(this.root, '', view, result, true);
    return result;
  }
  commit(): void {
    this.root.commit();
  }
}

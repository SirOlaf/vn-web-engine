import type {AsbTag} from '../../formats/artemis/asb.js';
import {artemisRevision} from './revision.js';

export type ArtemisMessageLayerMode = -1 | 0 | 1;
export interface ArtemisMessageLayerOwner<T extends object> {
  /** Creates the complete native message/font/surface bundle with one store loan. */
  createMessageLayer(id: string): T;
  /** Full CLinkableTextLayer copy, including retained geometry and text/style state. */
  copyMessageLayer(layer: T): T;
  retainMessageLayer(layer: T): void;
  releaseMessageLayer(layer: T): void;
  /** Scene wrappers own their own loans, including retained frames after detach. */
  attachMessageLayer(id: string, layer: T): void;
  detachMessageLayer(id: string): void;
}
interface MessageEntry<T> {
  layer: T;
  layered: boolean;
}
const encoder = new TextEncoder();
function compare(a: string, b: string): number {
  const x = encoder.encode(a),
    y = encoder.encode(b);
  for (let index = 0; index < Math.min(x.length, y.length); index++)
    if (x[index] !== y[index]) return x[index]! - y[index]!;
  return x.length - y.length;
}
function id(value: string): void {
  if (value.includes('\0') || /[\uD800-\uDFFF]/u.test(value))
    throw Error('Unsupported Artemis message-layer id');
}

/** Stage14f490 named message store and selected smart-pointer loan. Font construction,
 * text/surface copies and scene wrappers are mandatory resource-owner effects.
 */
export class ArtemisMessageLayers<T extends object> {
  private readonly layers = new Map<string, MessageEntry<T>>();
  private selected: T | undefined;
  private selectedName = '';
  private closed = false;
  constructor(
    hash: string,
    initialId: string,
    private readonly owner: ArtemisMessageLayerOwner<T>,
  ) {
    artemisRevision(hash);
    this.selectMessageLayer(initialId);
  }
  currentMessageLayer(): string {
    return this.selectedName;
  }
  messageLayerExists(name: string): boolean {
    id(name);
    return this.layers.has(name);
  }
  currentLayer(): T {
    if (this.closed || !this.selected) throw Error('Artemis message-layer store closed');
    return this.selected;
  }
  private fresh(layer: T): void {
    if ([...this.layers.values()].some((entry) => entry.layer === layer))
      throw Error('Artemis message resource owner must create a fresh layer');
  }
  selectMessageLayer(name: string, mode: ArtemisMessageLayerMode = 0): void {
    if (this.closed) throw Error('Artemis message-layer store closed');
    id(name);
    if (mode !== -1 && mode !== 0 && mode !== 1) throw Error('Invalid Artemis message-layer mode');
    let entry = this.layers.get(name);
    if (!entry) {
      const layer = this.owner.createMessageLayer(name);
      this.fresh(layer);
      entry = {layer, layered: mode > 0};
      try {
        if (entry.layered) this.owner.attachMessageLayer(name, layer);
      } catch (error) {
        this.owner.releaseMessageLayer(layer);
        throw error;
      }
      this.layers.set(name, entry);
    } else if (mode !== 0) {
      if (entry.layered) {
        this.owner.detachMessageLayer(name);
        const copy = this.owner.copyMessageLayer(entry.layer);
        this.fresh(copy);
        this.owner.releaseMessageLayer(entry.layer);
        entry.layer = copy;
      }
      entry.layered = mode > 0;
      if (entry.layered) this.owner.attachMessageLayer(name, entry.layer);
    }
    // Native selection assigns its shared current-layer pointer independently of map ownership.
    if (this.selected !== entry.layer) {
      this.owner.retainMessageLayer(entry.layer);
      if (this.selected) this.owner.releaseMessageLayer(this.selected);
      this.selected = entry.layer;
    }
    this.selectedName = name;
  }
  /** Scenario archive section 0x40: names of the layered message layers, in map order. */
  layeredNames(): string[] {
    return [...this.layers]
      .filter(([, entry]) => entry.layered)
      .map(([name]) => name)
      .sort(compare);
  }
  /** bf210 stage reset: the message store (+0x80/+0x90) is emptied, then 14f490 creates
   * "backlog" and "" (mode 0) and selects "". The scene root is replaced by the caller. */
  reset(): void {
    if (this.closed) throw Error('Artemis message-layer store closed');
    for (const [name, entry] of [...this.layers].sort(([a], [b]) => compare(b, a))) {
      if (entry.layered) this.owner.detachMessageLayer(name);
      this.owner.releaseMessageLayer(entry.layer);
    }
    this.layers.clear();
    this.selectMessageLayer('backlog');
    this.selectMessageLayer('');
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.selected) this.owner.releaseMessageLayer(this.selected);
    this.selected = undefined;
    for (const [name, entry] of [...this.layers].sort(([a], [b]) => compare(b, a))) {
      if (entry.layered) this.owner.detachMessageLayer(name);
      this.owner.releaseMessageLayer(entry.layer);
    }
    this.layers.clear();
  }
}

export interface ArtemisMessageSelectionHost {
  /** Native script's automatic-name allocator; no fallback counter is invented. */
  nextMessageLayerId(): string;
  /** Native script history creates its entry from the selected font/message state. */
  ensureMessageHistory(id: string): void;
  deleteMessageHistory(id: string): void;
  publishCurrentMessageLayer(id: string): void;
  /** Native INFO3 diagnostics are nonfatal unless the logger owner throws. */
  selectionChanged(tag: AsbTag, id: string): void;
  stackUnderflow(tag: AsbTag, id: string): void;
  /** 0x1400b6cf0: releases a placed click glyph. */
  messageStateUpdated(): void;
}

/** Script d1c10/d20d0 chgmsg selection stack, independent of stage/backlog selection. */
export class ArtemisMessageSelection<T extends object> {
  private readonly stack: string[] = [];
  private currentName: string;
  constructor(
    private readonly stage: ArtemisMessageLayers<T>,
    private readonly host: ArtemisMessageSelectionHost,
  ) {
    this.currentName = stage.currentMessageLayer();
  }
  currentMessageLayer(): string {
    return this.currentName;
  }
  get depth(): number {
    return this.stack.length;
  }
  /** bf210: current name 35e0 = "" and the chgmsg stack 3600 is emptied. */
  reset(): void {
    this.stack.length = 0;
    this.currentName = '';
  }
  /** Scenario archive sections 0xb (+0x35e0) and 0xc (+0x3600, oldest first). */
  saveFields(): {readonly current: string; readonly stack: readonly string[]} {
    return {current: this.currentName, stack: [...this.stack]};
  }
  /** Loader section reads: plain assignment; the scenario replay selects the layers. */
  loadFields(fields: {readonly current?: string; readonly stack?: readonly string[]}): void {
    if (fields.current !== undefined) this.currentName = fields.current;
    if (fields.stack) this.stack.splice(0, this.stack.length, ...fields.stack);
  }
  dispatch(tag: AsbTag): boolean {
    if (tag.name !== 'chgmsg' && tag.name !== '/chgmsg') return false;
    if (tag.name === '/chgmsg') {
      const previous = this.stack.pop();
      if (previous === undefined) {
        this.host.stackUnderflow(tag, this.currentName);
        return true;
      }
      this.currentName = previous;
      this.stage.selectMessageLayer(previous, 0);
    } else {
      if (tag.args.get('stack') !== '0') this.stack.push(this.currentName);
      this.currentName = tag.args.has('id') ? tag.args.get('id')! : this.host.nextMessageLayerId();
      const mode: ArtemisMessageLayerMode = !tag.args.has('layered')
        ? 0
        : tag.args.get('layered') === '0'
          ? -1
          : 1;
      this.stage.selectMessageLayer(this.currentName, mode);
      if (mode === -1) this.host.deleteMessageHistory(this.currentName);
      this.host.ensureMessageHistory(this.currentName);
    }
    this.host.publishCurrentMessageLayer(this.currentName);
    this.host.selectionChanged(tag, this.currentName);
    this.host.messageStateUpdated();
    return true;
  }
}

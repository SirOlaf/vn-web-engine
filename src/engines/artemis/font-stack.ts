import type {AsbTag} from '../../formats/artemis/asb.js';

export interface ArtemisFontStackHost<T extends object> {
  currentMessageLayer(): string;
  /** Copies the selected stage font into a complete native font-frame record. */
  snapshotCurrentFont(): T;
  /** Copies current font/frame, applies native a74d0 properties and returns the new record. */
  createFontCommandSnapshot(tag: AsbTag): T;
  /** Applies the font attributes only; the frame's additional fields remain in history. */
  applyFontSnapshot(snapshot: T): void;
  releaseFontSnapshot(snapshot: T): void;
  recordFontCommand(layer: string, tag: AsbTag): void;
  stackUnderflow(layer: string, tag: AsbTag): void;
}

/** cd380/cd460/cd950 per-script-message font frames. Font grammar, complete
 * frame copies and actual font/render effects remain mandatory owners.
 */
export class ArtemisFontStack<T extends object> {
  private readonly layers = new Map<string, T[]>();
  private closed = false;
  constructor(private readonly host: ArtemisFontStackHost<T>) {}
  /** Borrowed read-only records; callers needing ownership must copy their data. */
  borrowFrames(layer = this.host.currentMessageLayer()): readonly Readonly<T>[] {
    return Object.freeze([...(this.layers.get(layer) ?? [])]);
  }
  depth(layer = this.host.currentMessageLayer()): number {
    return this.layers.get(layer)?.length ?? 0;
  }
  /** Explicit message-history deletion also releases that layer's font frames. */
  deleteLayer(layer: string): void {
    for (const snapshot of this.layers.get(layer) ?? []) this.host.releaseFontSnapshot(snapshot);
    this.layers.delete(layer);
  }
  /** Message-history initialization samples the selected stage font once. */
  seedCurrentLayer(): void {
    if (this.closed) throw Error('Artemis font stack closed');
    const layer = this.host.currentMessageLayer();
    if (!this.layers.has(layer)) this.layers.set(layer, [this.host.snapshotCurrentFont()]);
  }
  dispatch(tag: AsbTag, recordHistory = true): boolean {
    if (!['fontinit', 'font', '/font'].includes(tag.name)) return false;
    if (this.closed) throw Error('Artemis font stack closed');
    const layer = this.host.currentMessageLayer(),
      stack = this.layers.get(layer) ?? [];
    if (tag.name === 'fontinit') {
      // Native samples current font; this does not reset the font to factory defaults.
      const snapshot = this.host.snapshotCurrentFont();
      for (const old of stack) this.host.releaseFontSnapshot(old);
      this.layers.set(layer, [snapshot]);
    } else if (tag.name === 'font') {
      const snapshot = this.host.createFontCommandSnapshot(tag);
      try {
        this.host.applyFontSnapshot(snapshot);
      } catch (error) {
        this.host.releaseFontSnapshot(snapshot);
        throw error;
      }
      if (stack.length && tag.args.get('stack') === '0')
        this.host.releaseFontSnapshot(stack.pop()!);
      stack.push(snapshot);
      this.layers.set(layer, stack);
    } else {
      if (stack.length < 2) {
        this.host.stackUnderflow(layer, tag);
        return true;
      }
      this.host.releaseFontSnapshot(stack.pop()!);
      this.host.applyFontSnapshot(stack.at(-1)!);
    }
    // Native third-argument replay mode suppresses command-history appends.
    if (recordHistory) this.host.recordFontCommand(layer, {...tag, args: new Map(tag.args)});
    return true;
  }
  /** Scenario load: +0x3708 is replaced by the saved per-layer frames (save object +0x18);
   * the old frames are released. The frames become owned by the stack. */
  replaceFrames(frames: ReadonlyMap<string, readonly T[]>): void {
    if (this.closed) throw Error('Artemis font stack closed');
    for (const stack of this.layers.values())
      for (const snapshot of stack) this.host.releaseFontSnapshot(snapshot);
    this.layers.clear();
    for (const [layer, stack] of frames) this.layers.set(layer, [...stack]);
  }
  /** bf210 3708: every frame is released and "" and "backlog" restart with one frame of
   * the factory-default CFontProperty (not the current font). */
  reset(createDefault: () => T): void {
    if (this.closed) throw Error('Artemis font stack closed');
    for (const stack of this.layers.values())
      for (const snapshot of stack) this.host.releaseFontSnapshot(snapshot);
    this.layers.clear();
    this.layers.set('', [createDefault()]);
    this.layers.set('backlog', [createDefault()]);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const stack of this.layers.values())
      for (const snapshot of stack) this.host.releaseFontSnapshot(snapshot);
    this.layers.clear();
  }
}

import {artemisRevision} from './revision.js';
import type {ArtemisTweenDescriptor, ArtemisTweenParameter} from './scene-tweens.js';
import type {ArtemisTextBlock} from './text-block.js';
import {ArtemisFloatTween, type ArtemisTweenRegistry} from './tween.js';

/** One display property of a glyph or block actor. `left`/`top` are the actor position
 * getters/setters (+0x20/+0x28), the others +0x50/+0x68/+0x70/+0x78. */
export interface ArtemisTextDisplayActor {
  property(parameter: Exclude<ArtemisTweenParameter, 'unknown'>): number;
  setProperty(parameter: Exclude<ArtemisTweenParameter, 'unknown'>, value: number): void;
}
export interface ArtemisTextDisplayHost<T> {
  /** Lines (+0x528) after the layout finalize +0x208; each line lists its blocks. */
  lines(): readonly (readonly ArtemisTextBlock<T>[])[];
  /** Logical glyph index +0x88; ruby glyphs share the counter with main glyphs. */
  glyphIndex(glyph: T): number;
  /** Glyph counter +0x520 of the owning text layer. */
  glyphCount(): number;
  /** Character actor +0x98, or null when the character has none. */
  glyphActor(glyph: T): ArtemisTextDisplayActor | null;
  /** The block itself as an actor (used by `entire*` parameters). */
  blockActor(block: ArtemisTextBlock<T>): ArtemisTextDisplayActor;
}

/** Display progression of CLinkableTextLayer (vtable 0x140376af0):
 * +0x1c8 start 0x140196b10, +0x1d0 finish 0x140197100, +0x1e0 complete 0x14014a0a0.
 *
 * `start` creates one float tween per descriptor and displayed character (or block for
 * `entire*`), registers it in the global tween registry and keeps its id in the layer
 * set +0x558. Only blocks whose first main glyph index is at least the display start
 * +0x524 take part; afterwards +0x524 becomes the glyph counter +0x520, so a continued
 * start only animates text inserted since the previous one.
 *
 * Delays are `descriptor.delay * order`: the per-character order counts every main glyph
 * of the included blocks from 0 (characters without an actor still advance it), ruby
 * glyphs spread their block's main count evenly, and `entire*` blocks use the cumulative
 * main-glyph count over all blocks of the layer (0x140198ce0). */
export class ArtemisTextDisplay<T> {
  private readonly ids = new Set<number>();
  private begin = 0;
  constructor(
    private readonly hash: string,
    private readonly registry: ArtemisTweenRegistry,
    private readonly host: ArtemisTextDisplayHost<T>,
  ) {
    artemisRevision(hash);
  }
  /** Display start +0x524. */
  get start(): number {
    return this.begin;
  }
  /** Registered ids in insertion order (the native set iterates in hash order). */
  get tweens(): readonly number[] {
    return [...this.ids];
  }
  /** +0x1c8: `continuing` false resets the display start to 0 first. */
  show(descriptors: readonly ArtemisTweenDescriptor[], continuing: boolean): void {
    if (!continuing) this.begin = 0;
    const lines = this.host.lines(),
      begin = this.begin;
    const included = (block: ArtemisTextBlock<T>) =>
      (block.main.length ? this.host.glyphIndex(block.main[0]!.glyph) >>> 0 : 0) >= begin >>> 0;
    const characters: number[] = [],
      ruby: number[] = [],
      blocks: number[] = [];
    let order = 0;
    for (const line of lines)
      for (const block of line) {
        if (!included(block)) continue;
        const first = Math.fround(order);
        for (let index = 0; index < block.main.length; index++) characters.push(order++);
        const step = Math.fround(Math.fround(block.main.length) / Math.fround(block.ruby.length));
        let value = first;
        for (let index = 0; index < block.ruby.length; index++) {
          ruby.push(value);
          value = Math.fround(value + step);
        }
      }
    let offset = 0;
    for (const line of lines)
      for (const block of line) {
        blocks.push(offset);
        offset = (offset + block.main.length) | 0;
      }
    for (const descriptor of descriptors) {
      // random_shuffle with the CRT rand state is not reconstructed.
      if (descriptor.randomDelay) throw Error('Unsupported Artemis random text display delay');
      const orders = (descriptor.entire ? blocks : characters).slice(),
        rubyOrders = ruby.slice();
      for (const line of lines)
        for (const block of line) {
          if (!included(block)) continue;
          if (descriptor.entire) {
            this.tween(
              this.host.blockActor(block),
              descriptor,
              Math.imul(descriptor.delay, orders.shift()!),
            );
            continue;
          }
          for (const glyph of block.main) {
            const actor = this.host.glyphActor(glyph.glyph),
              position = orders.shift()!;
            if (actor) this.tween(actor, descriptor, Math.imul(descriptor.delay, position));
          }
          for (const glyph of block.ruby) {
            const actor = this.host.glyphActor(glyph.glyph),
              position = rubyOrders.shift()!;
            if (actor)
              this.tween(
                actor,
                descriptor,
                Math.trunc(Math.fround(Math.fround(descriptor.delay >>> 0) * position)) | 0,
              );
          }
        }
    }
    this.begin = this.host.glyphCount();
  }
  /** 0x1401990e0: in-tweens jump to `value + diff` and return to the current value;
   * outgoing tweens move from the current value by `diff`. */
  private tween(
    actor: ArtemisTextDisplayActor,
    descriptor: ArtemisTweenDescriptor,
    delay: number,
  ): void {
    const parameter = descriptor.parameter;
    // Unknown parameters create no tween; the zero id is still inserted.
    if (parameter === 'unknown') {
      this.ids.add(0);
      return;
    }
    const current = actor.property(parameter),
      shifted = Math.fround(descriptor.diff + current);
    if (!descriptor.outgoing) actor.setProperty(parameter, shifted);
    const tween = new ArtemisFloatTween(
      this.hash,
      descriptor.outgoing ? current : shifted,
      descriptor.outgoing ? shifted : current,
      descriptor.time >>> 0,
      (value) => actor.setProperty(parameter, value),
      () => {},
      {ease: descriptor.ease, delay},
    );
    this.ids.add(this.registry.register(tween));
  }
  /** 0x1401962d0 empty-outgoing clear after it reset the layer: finish the display, then
   * the 8-byte store zeroes the glyph counter +0x520 and the display start +0x524. */
  clear(): void {
    this.finish();
    this.begin = 0;
  }
  /** CLinkableTextLayer copy 0x14014b350 copies the display start and job set. */
  copy(host: ArtemisTextDisplayHost<T>): ArtemisTextDisplay<T> {
    const copy = new ArtemisTextDisplay(this.hash, this.registry, host);
    copy.begin = this.begin;
    for (const id of this.ids) copy.ids.add(id);
    return copy;
  }
  /** +0x1e0: true once no id of the set is registered any more. */
  get complete(): boolean {
    for (const id of this.ids) if (this.registry.has(id)) return false;
    return true;
  }
  /** +0x1d0: finish every tween of the set, then empty it. */
  finish(): void {
    for (const id of this.ids) this.registry.finish(id);
    this.ids.clear();
  }
}

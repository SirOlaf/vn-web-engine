import type {AsbTag} from '../../formats/artemis/asb.js';
import {artemisInteger} from './numbers.js';

/** CArtemis::CGlyphInfo (node constructor 0x140105530): click-wait glyph placement for one
 * message layer. */
export interface ArtemisClickGlyph {
  /** +8: homing="0" clears it, any other homing value sets it; absent keeps it. */
  homing: boolean;
  /** +9 / +0x10: the glyph is the named layer. */
  layer: boolean;
  layerName: string;
  /** +0x50 TPoint<int>. */
  left: number;
  top: number;
  /** +10 / +0x30 / +0x60: the glyph of a wait followed by an `rp` tag; absent `rplayer`
   * copies the layer fields. */
  rplayer: boolean;
  rplayerName: string;
  rpleft: number;
  rptop: number;
}

export interface ArtemisClickGlyphHost {
  /** Current message layer name (script +0x35e0). */
  currentMessageLayer(): string;
  /** Layer set +0x140 lookup by name; when the layer exists, its virtual +0xf0 (0x1400a4970)
   * stores the draggable flag (layer +0x16c). The glyph tag passes 0, placement 1. */
  setLayerDraggable(name: string, value: boolean): void;
}

/** Glyph tag 0x1400d3290 over the per-message-layer map at script +0x3818 (find-or-create
 * 0x1400eb500). bf210 clears the map. */
export class ArtemisClickGlyphs {
  private readonly entries = new Map<string, ArtemisClickGlyph>();
  /** Script +0x3838: the placed glyph layer name, empty while none is placed. */
  private placedName = '';
  constructor(private readonly host: ArtemisClickGlyphHost) {}
  get(name: string): Readonly<ArtemisClickGlyph> | undefined {
    return this.entries.get(name);
  }
  private entry(): ArtemisClickGlyph {
    const name = this.host.currentMessageLayer();
    let entry = this.entries.get(name);
    if (!entry)
      this.entries.set(
        name,
        (entry = {
          homing: false,
          layer: false,
          layerName: '',
          left: 0,
          top: 0,
          rplayer: false,
          rplayerName: '',
          rpleft: 0,
          rptop: 0,
        }),
      );
    return entry;
  }
  get placed(): string {
    return this.placedName;
  }
  reset(): void {
    this.entries.clear();
  }
  /** 0x1400b6820, called by the run mode 1 automode branch before the automode deadline is
   * armed. A placed glyph stays until `release`. The current message layer's entry selects
   * the `rplayer` fields when the caret's next tag is `rp`, else the layer fields; a cleared
   * flag or an empty name places nothing. The name is recorded even when no such layer
   * exists. */
  place(beforePageEnd: boolean): void {
    if (this.placedName) return;
    const entry = this.entry();
    const [present, name] = beforePageEnd
      ? [entry.rplayer, entry.rplayerName]
      : [entry.layer, entry.layerName];
    if (!present || !name) return;
    this.placedName = name;
    // Homing moves the layer into the glyph container attached to the text layer (+0x3828,
    // text layer virtual +0x1b0) at the stored position.
    if (entry.homing) throw Error('Artemis homing click glyph is not implemented');
    this.host.setLayerDraggable(name, true);
  }
  /** 0x1400b6cf0: run on wait end (c6160 mode 0), every caret transfer (b6520), message
   * layer selection (chgmsg) and engine reset. Uses the current message layer's homing. */
  release(): void {
    if (!this.placedName) return;
    if (this.entry().homing) throw Error('Artemis homing click glyph is not implemented');
    this.host.setLayerDraggable(this.placedName, false);
    this.placedName = '';
  }
  /** Scenario archive section 0x12: copies of the map entries. */
  saveFields(): Map<string, ArtemisClickGlyph> {
    return new Map([...this.entries].map(([name, glyph]) => [name, {...glyph}]));
  }
  /** Loader read replaces the map. */
  loadFields(glyphs: ReadonlyMap<string, Readonly<ArtemisClickGlyph>>): void {
    this.entries.clear();
    for (const [name, glyph] of glyphs) this.entries.set(name, {...glyph});
  }
  dispatch(tag: AsbTag): boolean {
    if (tag.name !== 'glyph') return false;
    const args = tag.args;
    const entry = this.entry();
    // Without layer only the flag clears; the stored name is kept.
    entry.layer = args.has('layer');
    if (entry.layer) {
      entry.layerName = args.get('layer')!;
      this.host.setLayerDraggable(entry.layerName, false);
    }
    if (args.has('left')) entry.left = artemisInteger(args.get('left')!);
    if (args.has('top')) entry.top = artemisInteger(args.get('top')!);
    if (!args.has('rplayer')) {
      entry.rplayer = entry.layer;
      entry.rplayerName = entry.layerName;
      entry.rpleft = entry.left;
      entry.rptop = entry.top;
    } else {
      entry.rplayer = true;
      entry.rplayerName = args.get('rplayer')!;
      if (args.has('rpleft')) entry.rpleft = artemisInteger(args.get('rpleft')!);
      if (args.has('rptop')) entry.rptop = artemisInteger(args.get('rptop')!);
      this.host.setLayerDraggable(entry.rplayerName, false);
    }
    if (args.has('homing')) entry.homing = args.get('homing') !== '0';
    return true;
  }
}

import type {AsbTag} from '../../formats/artemis/asb.js';
import type {ArtemisMusicHistory} from './music.js';

const encoder = new TextEncoder();
const copy = (tag: AsbTag): AsbTag => ({...tag, args: new Map(tag.args)});

/** std::map<std::string, …> iteration order: unsigned byte comparison of the UTF-8 keys. */
export function artemisMapOrder<T>(map: ReadonlyMap<string, T>): [string, T][] {
  const entries = [...map].map((entry) => ({entry, bytes: encoder.encode(entry[0])}));
  entries.sort((a, b) => {
    for (let index = 0; index < Math.min(a.bytes.length, b.bytes.length); index++)
      if (a.bytes[index] !== b.bytes[index]) return a.bytes[index]! - b.bytes[index]!;
    return a.bytes.length - b.bytes.length;
  });
  return entries.map(({entry}) => entry);
}

export type ArtemisTextReplaySlot = 'indent' | 'prohibit';

/** Native CSaveData (script +0xd0) replay histories owned outside the layer command
 * registry (+0x68, `ArtemisLayerCommands`) and the BGM record (+0x88/+0x90, `ArtemisMusic`).
 * `Font` is the message font-stack frame type copied into +0x18. */
export class ArtemisSaveData<Font extends object> {
  /** +0x08: per message layer, text commands since the layer's last clear. */
  private readonly text = new Map<string, AsbTag[]>();
  /** +0x18: per message layer, the font-stack frames copied at the last clear. */
  private readonly fonts = new Map<string, readonly Readonly<Font>[]>();
  /** +0x38 indent/wordparts and +0x58 prohibit since the last clear. */
  private readonly pending = {
    indent: new Map<string, AsbTag>(),
    prohibit: new Map<string, AsbTag>(),
  };
  /** +0x28 and +0x48: the pending slots promoted by a clear. */
  private readonly retained = {
    indent: new Map<string, AsbTag>(),
    prohibit: new Map<string, AsbTag>(),
  };
  /** +0x78: per se id, the looping seplay tag, or null for the native empty block. A
   * nameless tag is an empty block that `sefade`/`sepan` gave arguments. */
  private readonly effects = new Map<string, AsbTag | null>();

  /** bf210 save-object reset of these fields. */
  clear(): void {
    this.text.clear();
    this.fonts.clear();
    for (const slots of [this.pending, this.retained]) {
      slots.indent.clear();
      slots.prohibit.clear();
    }
    this.effects.clear();
  }

  /** Appends a text command copy to the layer's +0x08 vector (find-or-create). */
  recordText(layer: string, tag: AsbTag): void {
    let tags = this.text.get(layer);
    if (!tags) this.text.set(layer, (tags = []));
    tags.push(copy(tag));
  }
  /** Indent/wordparts (d0510/cff50) write +0x38, prohibit (d0d00) +0x58. */
  rememberText(layer: string, slot: ArtemisTextReplaySlot, tag: AsbTag): void {
    this.pending[slot].set(layer, copy(tag));
  }
  /** Clear path, in native order: empty the layer's +0x08 vector (`clearText`), copy its
   * script +0x3708 font frames into +0x18 (`saveFonts`), then move +0x38 → +0x28 and
   * +0x58 → +0x48 (`promoteText`). */
  clearText(layer: string): void {
    this.text.set(layer, []);
  }
  saveFonts(layer: string, fonts: readonly Readonly<Font>[]): void {
    this.fonts.set(layer, [...fonts]);
  }
  promoteText(layer: string): void {
    for (const slot of ['indent', 'prohibit'] as const) {
      const tag = this.pending[slot].get(layer);
      if (!tag) continue;
      this.retained[slot].set(layer, tag);
      this.pending[slot].delete(layer);
    }
  }
  textCommands(layer: string): readonly AsbTag[] | undefined {
    return this.text.get(layer)?.map(copy);
  }
  /** `var system=get_message_tags` (0x1400e56a0): nothing when +0x08 has no entry for the
   * layer; otherwise its text commands and, with `fonts`, the +0x18 frames, which
   * operator[] creates empty when absent. */
  messageTags(
    layer: string,
    fonts: boolean,
  ): {readonly fonts: readonly Readonly<Font>[]; readonly tags: readonly AsbTag[]} | undefined {
    const tags = this.text.get(layer);
    if (!tags) return undefined;
    if (fonts && !this.fonts.has(layer)) this.fonts.set(layer, []);
    return {fonts: fonts ? [...this.fonts.get(layer)!] : [], tags: tags.map(copy)};
  }

  hasEffect(id: string): boolean {
    return this.effects.has(id);
  }
  replaceEffect(id: string, tag: AsbTag | null): void {
    this.effects.set(id, tag && copy(tag));
  }
  deleteEffect(id: string): void {
    this.effects.delete(id);
  }
  /** operator[](id) on +0x78, then the block's `key` argument (`sefade`/`sepan`). */
  setEffectArgument(id: string, key: string, value: string): void {
    const tag = this.effects.get(id),
      args = new Map(tag?.args);
    args.set(key, value);
    this.effects.set(id, {...(tag ?? {kind: 'tag', name: '', sourceLine: 0}), args});
  }

  snapshot(): ArtemisSaveDataSnapshot<Font> {
    const tags = (map: ReadonlyMap<string, AsbTag>) =>
      new Map(artemisMapOrder(map).map(([key, tag]) => [key, copy(tag)]));
    return {
      text: new Map(artemisMapOrder(this.text).map(([key, list]) => [key, list.map(copy)])),
      fonts: new Map(artemisMapOrder(this.fonts).map(([key, frames]) => [key, [...frames]])),
      retainedIndent: tags(this.retained.indent),
      pendingIndent: tags(this.pending.indent),
      retainedProhibit: tags(this.retained.prohibit),
      pendingProhibit: tags(this.pending.prohibit),
      effects: new Map(artemisMapOrder(this.effects).map(([key, tag]) => [key, tag && copy(tag)])),
    };
  }
  restore(snapshot: ArtemisSaveDataSnapshot<Font>): void {
    this.clear();
    for (const [key, list] of snapshot.text) this.text.set(key, list.map(copy));
    for (const [key, frames] of snapshot.fonts) this.fonts.set(key, [...frames]);
    const fill = (target: Map<string, AsbTag>, source: ReadonlyMap<string, AsbTag>) => {
      for (const [key, tag] of source) target.set(key, copy(tag));
    };
    fill(this.retained.indent, snapshot.retainedIndent);
    fill(this.pending.indent, snapshot.pendingIndent);
    fill(this.retained.prohibit, snapshot.retainedProhibit);
    fill(this.pending.prohibit, snapshot.pendingProhibit);
    for (const [key, tag] of snapshot.effects) this.effects.set(key, tag && copy(tag));
  }
}

/** Save-object fields in std::map order. */
export interface ArtemisSaveDataSnapshot<Font extends object> {
  readonly text: ReadonlyMap<string, readonly AsbTag[]>;
  readonly fonts: ReadonlyMap<string, readonly Readonly<Font>[]>;
  readonly retainedIndent: ReadonlyMap<string, AsbTag>;
  readonly pendingIndent: ReadonlyMap<string, AsbTag>;
  readonly retainedProhibit: ReadonlyMap<string, AsbTag>;
  readonly pendingProhibit: ReadonlyMap<string, AsbTag>;
  readonly effects: ReadonlyMap<string, AsbTag | null>;
}

export interface ArtemisScenarioReplayHost<Font extends object> {
  /** 0x14014f490: select (creating when absent) a message layer resource; mode 1 for the
   * saved layered names, 0 otherwise. */
  selectMessageLayer(name: string, mode: 0 | 1): void;
  /** Script +0x35e0. */
  currentMessageLayer(): string;
  setCurrentMessageLayer(name: string): void;
  /** Script +0x3708 is replaced by the saved +0x18 map. */
  replaceFontFrames(fonts: ReadonlyMap<string, readonly Readonly<Font>[]>): void;
  /** 0x1400a5ac0 on the selected layer's font renderer with the layer's last frame. */
  applyFontFrame(name: string, frame: Readonly<Font>): void;
  /** 0x1400c5800(script, tag, 1). */
  dispatch(tag: AsbTag): Promise<void> | void;
  /** Renderer vtbl+0x1c8 with the current layer's +0x3750 (in) or +0x3760 (out) scene
   * tween; `out` also runs vtbl+0x1d0. */
  applySceneTween(out: boolean): void;
  writeCurrentMessageLayerVariable(name: string): void;
}

/** Tag replay of loader 0x140141b10 after the section reads: layered message names, font
 * frames, retained indent then prohibit commands, per-layer text with the scene tween, the
 * layer command registry (`lyc`/`anime`/`video` first, then the rest), BGM and se. Every
 * tag goes through the dispatcher with the replay flag; empty blocks are skipped as the
 * dispatcher returns on an empty name. The pre-1003 `colormultiply` fixup does not apply
 * to archives of this version. `afterLayerCommands` runs between the layer
 * commands and BGM, where the loader refreshes the +0x3818 glyph layers. */
export async function replayArtemisScenario<Font extends object>(
  data: ArtemisSaveDataSnapshot<Font>,
  layered: readonly string[],
  layerCommands: ReadonlyMap<string, readonly AsbTag[]>,
  music: ArtemisMusicHistory,
  host: ArtemisScenarioReplayHost<Font>,
  afterLayerCommands: () => void = () => {},
): Promise<void> {
  const dispatch = async (tag: AsbTag) => {
    if (tag.name) await host.dispatch(tag);
  };
  for (const name of layered) host.selectMessageLayer(name, 1);
  host.replaceFontFrames(data.fonts);
  for (const [name, frames] of data.fonts) {
    if (!frames.length) continue;
    host.selectMessageLayer(name, 0);
    host.applyFontFrame(name, frames.at(-1)!);
  }
  for (const slot of [data.retainedIndent, data.retainedProhibit])
    for (const [name, tag] of slot) {
      host.selectMessageLayer(name, 0);
      await dispatch(tag);
    }
  const original = host.currentMessageLayer();
  for (const [name, tags] of data.text) {
    host.selectMessageLayer(name, 0);
    host.setCurrentMessageLayer(name);
    let out = false;
    for (const tag of tags) {
      if (tag.name === 'scein') out = false;
      else if (tag.name === 'sceout') out = true;
      else await dispatch(tag);
    }
    host.applySceneTween(out);
  }
  host.selectMessageLayer(original, 0);
  host.setCurrentMessageLayer(original);
  host.writeCurrentMessageLayerVariable(original);
  const creates = new Set(['lyc', 'anime', 'video']);
  for (const first of [true, false])
    for (const tags of layerCommands.values())
      for (const tag of tags) if (creates.has(tag.name) === first) await dispatch(tag);
  afterLayerCommands();
  if (music.playing) await dispatch(music.tag);
  // Empty blocks, with or without arguments, replay nothing.
  for (const tag of data.effects.values()) if (tag?.name) await dispatch(tag);
}

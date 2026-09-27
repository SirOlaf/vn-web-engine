import {Scene, type RScriptMemory} from '../memory.js';
import {RScriptContainer} from '../graphics/sprite.js';
import {RScriptMessagePanel, type PanelCommand} from './message-panel.js';
import {BoxRecord, RScriptTextBox, type TextBoxEnvironment} from './text-box.js';

/** Offsets inside the message state (0x48AE70, scene +0x523C). */
export const MessageState = {
  panelEnabled: 0,
  backlogEnabled: 4,
  menuEnabled: 8,
  panelButtons: 12,
  tabEnabled: 16,
  boxes: 20,
  boxStride: 96,
  sources: 404,
  sourceStride: 12,
  page: 452,
  /** Page record fields (32 bytes). */
  panelX: 452,
  panelY: 456,
  faceX: 460,
  faceY: 464,
  faceImage: 468,
  faceOrder: 470,
  currentBox: 472,
  voice: 476,
  voiceVolume: 480,
  backlog: 484,
  backlogStride: 144,
  backlogCount: 100,
} as const;

/** Backlog entry layout (0x417490). */
const Entry = {
  pageStart: 0,
  box: 4,
  script: 100,
  text: 104,
  name: 108,
  page: 112,
} as const;

export interface MessageSource {
  script: number;
  text: number;
  name: number;
}

export interface MessageEnvironment extends TextBoxEnvironment {
  /** Returns the expanded bytes of `script`'s string `index`. */
  scriptString(script: number, index: number): Promise<Uint8Array>;
  /** Text colour of backlog pages (APINI +502/+504), or null to keep the box colour. */
  readonly backlogColor: number | null;
  /** Companion panel commands and auto-speed slider (the callbacks at +228..+276). */
  command(command: PanelCommand): void;
  autoSpeed(value: number): void;
}

/**
 * Message window (0x415750): four text boxes and the backlog stored as script references
 * in the scene state (0x417490), so saves and nested calls restore the page (0x416C30).
 */
export class RScriptMessageWindow extends RScriptContainer {
  readonly boxes: readonly RScriptTextBox[];
  readonly panel: RScriptMessagePanel;
  /** Page text shown by save screens (the global String1). */
  pageText: Uint8Array = new Uint8Array();
  /** The script waits for input; panel buttons and the backlog respond (+212). */
  inputActive = false;
  /** Auto mode hid the panel (+220). */
  autoHidden = false;
  /** A backlog page is shown instead of the current page (+208), from entry +204. */
  browsing = false;
  private browseIndex: number = MessageState.backlogCount;
  /** Scene offset of the page record in view, for voice replay (+200). */
  private pageRecord: number = Scene.message + MessageState.page;

  constructor(private readonly env: MessageEnvironment) {
    super();
    this.boxes = Array.from(
      {length: 4},
      (_, i) =>
        new RScriptTextBox(env, Scene.message + MessageState.boxes + i * MessageState.boxStride),
    );
    for (const box of this.boxes) this.add(box, 1);
    this.panel = new RScriptMessagePanel(
      (command) => env.command(command),
      (value) => env.autoSpeed(value),
    );
    this.add(this.panel, 2);
  }

  loadPanel(): Promise<void> {
    return this.panel.load(this.env.images, this.env.systemDirectory);
  }

  /** sub_418220: the panel shows with box 0 while enabled and not hidden by auto mode. */
  updatePanel(): void {
    this.panel.setPosition(this.dword(MessageState.panelX), this.dword(MessageState.panelY));
    this.panel.show(
      !!this.dword(MessageState.panelEnabled) && this.boxes[0]!.recordVisible && !this.autoHidden,
    );
  }
  /** sub_418280: input while the script waits for a click, a button or a choice. */
  setInput(active: boolean): void {
    this.inputActive = active;
    this.panel.setInput(active);
  }
  /** sub_417820: auto mode ended; the panel returns. */
  restorePanel(): void {
    this.autoHidden = false;
    this.updatePanel();
  }
  /** Voice and pan of the page in view (page record +24, +28). */
  currentVoice(): {voice: number; pan: number} {
    return {
      voice: this.memory.sceneDword(this.pageRecord + 24) >>> 0,
      pan: this.memory.sceneWord(this.pageRecord + 28),
    };
  }

  private get memory(): RScriptMemory {
    return this.env.memory;
  }
  private at(offset: number): number {
    return Scene.message + offset;
  }
  word(offset: number): number {
    return this.memory.sceneUword(this.at(offset));
  }
  setWord(offset: number, value: number): void {
    this.memory.setSceneWord(this.at(offset), value);
  }
  dword(offset: number): number {
    return this.memory.sceneDword(this.at(offset));
  }
  setDword(offset: number, value: number): void {
    this.memory.setSceneDword(this.at(offset), value);
  }

  source(box: number): MessageSource {
    const base = MessageState.sources + box * MessageState.sourceStride;
    return {script: this.word(base), text: this.dword(base + 4), name: this.dword(base + 8)};
  }
  private setSource(box: number, source: MessageSource): void {
    const base = MessageState.sources + box * MessageState.sourceStride;
    this.setWord(base, source.script);
    this.setDword(base + 4, source.text);
    this.setDword(base + 8, source.name);
  }

  /** sub_417490: appends the current page state of box 0 to the backlog ring. */
  private pushBacklog(pageStart: boolean): void {
    const scene = this.memory.scene;
    const base = this.at(MessageState.backlog);
    const stride = MessageState.backlogStride;
    const last = base + stride * (MessageState.backlogCount - 1);
    const view = this.memory.sceneView;
    if (view.getUint16(last + Entry.script, true) || view.getUint32(last + Entry.text + 4, true)) {
      scene.copyWithin(base, base + stride, base + stride * MessageState.backlogCount);
      scene[last + Entry.pageStart] = pageStart ? 1 : 0;
    } else scene[last + Entry.pageStart] = 1;
    scene.set(
      scene.subarray(this.at(MessageState.page), this.at(MessageState.page) + 32),
      last + Entry.page,
    );
    scene.set(
      scene.subarray(this.at(MessageState.sources), this.at(MessageState.sources) + 12),
      last + Entry.script,
    );
    scene.set(
      scene.subarray(this.at(MessageState.boxes), this.at(MessageState.boxes) + 96),
      last + Entry.box,
    );
  }

  /** sub_418010: shows or hides a box; hiding also clears it. */
  async showBox(box: number, visible: boolean, skipping: boolean): Promise<void> {
    const target = this.boxes[box]!;
    target.setVisible(visible, skipping);
    if (!visible) this.clear(box, skipping);
    if (!skipping && visible) await target.apply();
    if (!skipping && box === 0) this.updatePanel();
  }

  /** sub_417C80: displays script text in a box, starting a page when `newPage`. */
  async display(
    box: number,
    source: MessageSource,
    newPage: boolean,
    skipping: boolean,
  ): Promise<void> {
    this.setWord(MessageState.currentBox, box);
    this.setSource(box, source);
    await this.showBox(box, true, skipping);
    if (box === 0) this.pushBacklog(newPage);
    if (skipping) return;
    const target = this.boxes[box]!;
    const text = await this.env.scriptString(source.script, source.text);
    if (newPage) {
      this.pageText = text;
      target.setName(source.name ? await this.env.scriptString(source.script, source.name) : null);
    } else {
      const joined = new Uint8Array(this.pageText.length + text.length);
      joined.set(this.pageText);
      joined.set(text, this.pageText.length);
      this.pageText = joined;
    }
    target.appendText(text);
  }

  /** sub_417F40: clears the text of a box. */
  clear(box: number, skipping: boolean): void {
    this.setSource(box, {script: 0, text: 0, name: 0});
    if (box === 0) this.pushBacklog(true);
    if (skipping) return;
    this.pageText = new Uint8Array();
    this.boxes[box]!.clearText();
    this.boxes[box]!.setName(null);
  }

  /** sub_4182E0: reveals every visible box. */
  reveal(): void {
    for (const box of this.boxes) box.reveal();
  }
  get revealing(): boolean {
    return this.boxes.some((box) => box.text.animating && !box.text.complete);
  }
  /** vtable +96: completes reveals and fades. */
  finish(): void {
    for (const box of this.boxes) {
      box.text.finishReveal();
      box.stopAnimation();
    }
  }
  /** sub_418330: click-wait icon on the current box. */
  setWaiting(waiting: boolean): void {
    const current = this.word(MessageState.currentBox) & 3;
    this.boxes.forEach((box, i) => box.setWaiting(waiting && i === current));
  }

  /** sub_4183B0 */
  tickWaiting(): void {
    for (const box of this.boxes) box.tickWaiting();
  }
  /** sub_418930 for both box groups: the configured reveal speed. */
  setSpeed(speed: number): void {
    for (const box of this.boxes) box.setSpeed(speed);
  }
  /** sub_417EA0: voice of the current page, kept for backlog replay. */
  setVoice(voice: number, pan: number): void {
    this.setDword(MessageState.voice, voice);
    this.setWord(MessageState.voiceVolume, pan);
    this.panel.setVoice(voice !== 0);
  }
  /** sub_416B70: forgets the backlog. */
  clearBacklog(): void {
    const start = this.at(MessageState.backlog);
    this.memory.scene.fill(
      0,
      start,
      start + MessageState.backlogStride * MessageState.backlogCount,
    );
  }

  setBoxWord(box: number, field: number, value: number): void {
    this.boxes[box]!.setWord(field, value);
  }
  setBoxDword(box: number, field: number, value: number): void {
    this.boxes[box]!.setDword(field, value);
  }
  /** Applies record changes to one box, or to boxes 1..3 like the native "all" setters. */
  async applyBoxes(box: number, all: boolean): Promise<void> {
    for (const index of all && box !== 0 ? [1, 2, 3] : [box]) await this.boxes[index]!.apply();
  }

  // Backlog browsing inside box 0 (0x4175A0, 0x417550, 0x4172F0, 0x416FE0).

  private previousPageStart(): boolean {
    for (let i = this.browseIndex - 1; i >= 0; i--)
      if (this.isPageStart(i)) {
        this.browseIndex = i;
        return true;
      }
    return false;
  }
  private nextPageStart(): boolean {
    for (let i = this.browseIndex + 1; i < MessageState.backlogCount; i++)
      if (this.isPageStart(i)) {
        this.browseIndex = i;
        return true;
      }
    this.browseIndex = MessageState.backlogCount;
    return false;
  }
  private atLastPage(): boolean {
    for (let i = this.browseIndex + 1; i < MessageState.backlogCount; i++)
      if (this.isPageStart(i)) return false;
    return true;
  }

  /** sub_4175A0: the previous backlog page (wheel up, the bak button). */
  async backlogBack(): Promise<boolean> {
    if (!this.inputActive) return false;
    if (this.browsing) {
      if (this.previousPageStart()) await this.showBacklogPage(this.browseIndex);
      return true;
    }
    if (!this.dword(MessageState.backlogEnabled)) return false;
    this.browseIndex = this.lastPage();
    if (this.previousPageStart()) {
      this.browsing = true;
      this.setWaiting(false);
      await this.showBacklogPage(this.browseIndex);
    }
    return true;
  }
  /** sub_417550: the next backlog page, leaving the backlog after the last one. */
  async backlogForward(): Promise<boolean> {
    if (!this.browsing) return false;
    if (!this.nextPageStart()) await this.exitBacklog();
    else {
      await this.showBacklogPage(this.browseIndex);
      if (this.atLastPage()) await this.exitBacklog();
    }
    return true;
  }
  /** sub_4172F0: returns box 0 to the current page; true when the backlog was open. */
  async exitBacklog(): Promise<boolean> {
    if (!this.browsing) return false;
    this.browsing = false;
    this.pageRecord = this.at(MessageState.page);
    const box = this.boxes[0]!;
    box.record = this.at(MessageState.boxes);
    box.clearText();
    await box.apply();
    const start = this.lastPage();
    box.appendText(await this.backlogPage(start));
    box.text.finishReveal();
    await this.showEntryName(start);
    this.panel.setVoice(this.currentVoice().voice !== 0);
    return true;
  }
  private async showEntryName(index: number): Promise<void> {
    const entry = this.entryOffset(index);
    const name = this.memory.sceneDword(entry + Entry.name);
    const script = this.memory.sceneUword(entry + Entry.script);
    this.boxes[0]!.setName(name ? await this.env.scriptString(script, name) : null);
  }
  /** sub_416FE0: shows the page starting at backlog entry `index` with its saved box. */
  private async showBacklogPage(index: number): Promise<void> {
    const box = this.boxes[0]!;
    const entry = this.entryOffset(index);
    box.clearText();
    box.record = entry + Entry.box;
    if (this.env.backlogColor !== null) box.setDword(BoxRecord.color, this.env.backlogColor);
    await box.apply();
    box.appendText(await this.backlogPage(index));
    box.text.finishReveal();
    await this.showEntryName(index);
    this.pageRecord = entry + Entry.page;
    this.panel.setVoice(this.currentVoice().voice !== 0);
  }

  /** sub_416C30: rebuilds boxes and their current page text from the state. */
  async restore(): Promise<void> {
    this.browsing = false;
    this.pageRecord = this.at(MessageState.page);
    this.boxes[0]!.record = this.at(MessageState.boxes);
    for (let i = 0; i < 4; i++) {
      const box = this.boxes[i]!;
      box.clearText();
      await box.apply();
      const source = this.source(i);
      if (!source.script) {
        box.setName(null);
        continue;
      }
      if (i === 0) {
        const page = await this.backlogPage(this.lastPage());
        this.pageText = page;
        box.appendText(page);
      } else box.appendText(await this.env.scriptString(source.script, source.text));
      box.text.finishReveal();
      box.setName(source.name ? await this.env.scriptString(source.script, source.name) : null);
    }
    this.updatePanel();
    this.panel.setVoice(this.currentVoice().voice !== 0);
  }

  private entryOffset(index: number): number {
    return this.at(MessageState.backlog) + index * MessageState.backlogStride;
  }
  private isPageStart(index: number): boolean {
    return this.memory.scene[this.entryOffset(index) + Entry.pageStart] !== 0;
  }
  /** sub_4172B0: the last page start. */
  lastPage(): number {
    for (let i = MessageState.backlogCount - 1; i >= 0; i--) if (this.isPageStart(i)) return i;
    return 0;
  }
  /** sub_416EF0: concatenated text of the page starting at `index`. */
  async backlogPage(index: number): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    for (let i = index; i < MessageState.backlogCount; i++) {
      if (i > index && this.isPageStart(i)) break;
      const offset = this.entryOffset(i);
      const script = this.memory.sceneUword(offset + Entry.script);
      const text = this.memory.sceneDword(offset + Entry.text);
      if (!script && !text) continue;
      parts.push(await this.env.scriptString(script, text));
    }
    const total = parts.reduce((n, p) => n + p.length, 0);
    const joined = new Uint8Array(total);
    let cursor = 0;
    for (const part of parts) {
      joined.set(part, cursor);
      cursor += part.length;
    }
    return joined;
  }
}
export {BoxRecord};

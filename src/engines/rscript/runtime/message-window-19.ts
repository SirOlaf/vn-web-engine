import {Config, Scene, type RScriptMemory} from '../memory.js';
import {RScriptContainer, RScriptSprite} from '../graphics/sprite.js';
import {encodeCp932} from '../text.js';
import {loadFrameAnimation} from './animation.js';
import {FONT_PANEL, RScriptFontWindow} from './font-window.js';
import {RScriptMessagePanel} from './message-panel.js';
import {BoxRecord, type TextBoxEnvironment} from './text-box.js';
import {RScriptTextBlock, type TextStyle} from './text-block.js';
import {
  MessageState,
  type MessageEnvironment,
  type MessageSource,
  type RScriptMessageView,
} from './message-window.js';
import {FrameSprite, ImageButton, ScreenImage, ScrollBar, StateButtons} from './widgets.js';
import type {RScriptFiles} from '../files.js';

/**
 * RScript 1.9 message settings at the end of the configuration block (0x482A5E..0x482A6C),
 * as raw 1.9 offsets. The `excompane` buttons set them (0x42E200..0x42E320).
 */
export const MessageSettings19 = {
  /** 0 writes in columns from the right, 1 in rows. */
  direction: 0x84a,
  /** 0 large, 1 medium, 2 small text. */
  size: 0x84c,
  /** Nonzero draws text without its shadow. */
  shadowOff: 0x850,
  /** Where the text sits, 0..8 (three columns of three rows, from the right). */
  placement: 0x852,
  /** Nonzero keeps earlier messages of a page at full strength (0x430F40). */
  keepText: 0x854,
  /** Nonzero places characters at fixed positions instead of clear of the text (0x431370). */
  fixedCharacters: 0x856,
  /** Nonzero leaves characters who are not speaking undimmed (0x431440). */
  keepCharacters: 0x858,
} as const;
export type MessageSetting19 = keyof typeof MessageSettings19;

export function messageSetting19(memory: RScriptMemory, setting: MessageSetting19): number {
  return memory.configView.getUint16(MessageSettings19[setting], true);
}

/** The message state (word_487CA0, scene +0x5230) in 1.9 offsets. */
const State = {
  panelEnabled: 0,
  backlogEnabled: 4,
  /** Text box record 0 (68 bytes); only it is shown. */
  box: 20,
  boxSize: 68,
  /** Text source: script word, text dword and the speaker flag word (16 bytes). */
  source: 292,
  script: 292,
  text: 300,
  speaker: 304,
  sourceSize: 16,
  /** Page record (32 bytes): panel position, face, box, voice and pan. */
  page: 308,
  pageSize: 32,
  voice: 332,
  pan: 336,
  backlog: 340,
  entrySize: 120,
  entryCount: 100,
} as const;

/** Backlog entry (0x42CB10): kind byte, box record, source and page record. */
const Entry = {
  kind: 0,
  box: 4,
  script: 72,
  text: 80,
  speaker: 84,
  page: 88,
  voice: 112,
  pan: 116,
} as const;
/** Entry kinds: a continuation, a new message on the page, and a page start. */
const NEW_MESSAGE = 1;
const PAGE_START = 2;

const LINE_BREAK = encodeCp932('^n')!;
/** The blank line around a speaker's message (byte_47EE80). */
const BLANK_LINE = encodeCp932('　^n')!;
/** Speaker messages start with 【 (byte_47EE94). */
const SPEAKER = encodeCp932('【')!;

/** Text layouts by direction then size (0x4301B0): glyph size, line spacing, ruby size and area. */
const LAYOUTS = [
  [
    {size: 24, lineSpacing: 10, ruby: 9, width: 646, height: 480},
    {size: 18, lineSpacing: 8, ruby: 8, width: 494, height: 360},
    {size: 12, lineSpacing: 6, ruby: 6, width: 342, height: 240},
  ],
  [
    {size: 18, lineSpacing: 9, ruby: 9, width: 360, height: 513},
    {size: 16, lineSpacing: 8, ruby: 8, width: 320, height: 456},
    {size: 12, lineSpacing: 6, ruby: 6, width: 240, height: 342},
  ],
] as const;
/** Text positions by direction, size and placement (0x4301B0). */
const PLACEMENTS: readonly (readonly {x: readonly number[]; y: readonly number[]}[])[] = [
  [
    {x: [114, 114, 114, 77, 77, 77, 20, 20, 20], y: [30, 30, 30, 30, 30, 30, 30, 30, 30]},
    {x: [266, 266, 266, 153, 153, 153, 20, 20, 20], y: [30, 75, 150, 30, 75, 150, 30, 75, 150]},
    {x: [418, 418, 418, 229, 229, 229, 20, 20, 20], y: [30, 155, 270, 30, 155, 270, 30, 155, 270]},
  ],
  [
    {x: [400, 400, 400, 220, 220, 220, 20, 20, 20], y: [20, 20, 20, 20, 20, 20, 20, 20, 20]},
    {x: [440, 440, 440, 240, 240, 240, 20, 20, 20], y: [20, 42, 65, 20, 42, 65, 20, 42, 65]},
    {x: [520, 520, 520, 280, 280, 280, 20, 20, 20], y: [20, 104, 188, 20, 104, 188, 20, 104, 188]},
  ],
];
/** Wait icon and voice mark sizes by direction and text size (dword_4753C0). */
const MARK_SIZES = [
  [24, 18, 12],
  [18, 16, 12],
] as const;

interface Layout19 {
  readonly direction: number;
  readonly size: number;
}

function layoutOf(memory: RScriptMemory): Layout19 {
  return {
    direction: Math.min(1, messageSetting19(memory, 'direction')),
    size: Math.min(2, messageSetting19(memory, 'size')),
  };
}

export interface TextBoxEnvironment19 extends TextBoxEnvironment {
  readonly files: RScriptFiles;
}

/**
 * The 1.9 text box (0x42FA40): the frame's back and front, one text object of 800 glyphs laid
 * out by the message settings, and a looping wait icon at the end of the text.
 */
export class RScriptTextBox19 extends RScriptContainer {
  private readonly back = new RScriptSprite();
  private readonly front = new RScriptSprite();
  private readonly wait = new RScriptContainer();
  private readonly waitIcon = new FrameSprite();
  readonly text: RScriptTextBlock;
  private frameLoaded = -1;
  private waitLoaded = '';
  /** The wait icon is on show (+108). */
  waiting = false;

  constructor(
    private readonly env: TextBoxEnvironment19,
    private readonly record: number,
  ) {
    super();
    this.text = new RScriptTextBlock(env.rasterizer, 800, this.style());
    this.add(this.back, 0);
    this.add(this.front, 1);
    this.add(this.text, 2);
    this.add(this.wait, 3);
    this.wait.add(this.waitIcon, 0);
    this.back.setBlendMode(2);
    this.back.setAlpha(0x80);
    this.wait.visible = false;
    this.visible = false;
  }

  private word(field: number): number {
    return this.env.memory.sceneUword(this.record + field);
  }
  private dword(field: number): number {
    return this.env.memory.sceneDword(this.record + field);
  }
  get recordVisible(): boolean {
    return this.dword(BoxRecord.visible) !== 0;
  }
  private get layout(): Layout19 {
    return layoutOf(this.env.memory);
  }
  /** The size of the wait icon and voice marks for the current settings. */
  get markSize(): number {
    const {direction, size} = this.layout;
    return MARK_SIZES[direction]![size]!;
  }

  /** The record's text settings with the size, spacing and area of the settings (0x4301B0). */
  private style(): TextStyle {
    const r = BoxRecord;
    const {direction, size} = this.layout;
    const layout = LAYOUTS[direction]![size]!;
    return {
      face: 2,
      size: layout.size,
      color: this.dword(r.color),
      palette: this.env.palette,
      shadow: messageSetting19(this.env.memory, 'shadowOff') === 0,
      speed: this.word(r.speed),
      lineSpacing: layout.lineSpacing,
      charSpacing: 0,
      indent: this.word(r.indent),
      firstIndent: this.word(r.firstIndent),
      align: this.word(r.align),
      width: layout.width,
      height: layout.height,
      rubyFace: 0,
      rubySize: layout.ruby,
      rubyRaise: layout.ruby,
      vertical: direction === 0,
    };
  }

  /** sub_431070: the frame back's opacity, set by the window opacity slider. */
  setBackAlpha(alpha: number): void {
    this.back.setAlpha(alpha);
  }

  /** sub_430B30: `tboxNN` front and back; an absent image or layer keeps the previous one. */
  private async loadFrame(frame: number): Promise<void> {
    if (frame === this.frameLoaded) return;
    this.frameLoaded = frame;
    const path = `${this.env.systemDirectory}\\tbox${String(frame).padStart(2, '0')}`;
    const image = await ScreenImage.open(this.env.images, path);
    if (!image) return;
    for (const [sprite, layer] of [
      [this.front, 'front'],
      [this.back, 'back'],
    ] as const) {
      const at = image.position(layer);
      const surface = await image.surface(layer);
      if (!at || !surface) continue;
      sprite.setSurface(surface);
      sprite.setPosition(at.x, at.y);
      sprite.show(true);
    }
  }

  /** sub_430CB0: `waitNN` as a looping frame animation for the settings' size. */
  private async loadWaitIcon(): Promise<void> {
    const path = `${this.env.systemDirectory}\\wait${String(this.markSize).padStart(2, '0')}`;
    if (path === this.waitLoaded) return;
    this.waitLoaded = path;
    const animation = await loadFrameAnimation(this.env.images, this.env.files, path);
    this.waitIcon.setFrames(animation?.frames ?? [], 0, 0);
    this.waitIcon.play(true);
    this.waitIcon.animating = this.waiting;
    this.waitIcon.show(true);
  }

  /** sub_4301B0: applies the record and the message settings to the visible objects. */
  async apply(): Promise<void> {
    await this.loadFrame(this.word(BoxRecord.frame));
    await this.loadWaitIcon();
    const {direction, size} = this.layout;
    const placement = Math.min(8, messageSetting19(this.env.memory, 'placement'));
    const at = PLACEMENTS[direction]![size]!;
    this.text.style = this.style();
    this.text.resize(this.text.style.width, this.text.style.height);
    this.text.setPosition(at.x[placement]!, at.y[placement]!);
    this.setPosition(0, 0);
    this.show(this.recordVisible);
  }

  /** sub_430170 */
  setVisible(visible: boolean, skipping: boolean): void {
    this.env.memory.setSceneDword(this.record + BoxRecord.visible, visible ? 1 : 0);
    if (!skipping) this.show(visible);
  }

  /** sub_430DB0: appends text and moves the wait icon to the last glyph; false on overflow. */
  append(text: Uint8Array): boolean {
    if (!this.text.append(text) || !this.text.length) return false;
    const rect = this.glyphRect(this.text.length - 1)!;
    if (this.layout.direction) this.wait.setPosition(rect.x + rect.width, rect.y);
    else this.wait.setPosition(rect.x, rect.y + rect.height);
    return true;
  }
  /** sub_430F60: a glyph's cell in box coordinates. */
  glyphRect(index: number): {x: number; y: number; width: number; height: number} | null {
    const rect = this.text.glyphRect(index);
    return rect && {...rect, x: rect.x + this.text.x, y: rect.y + this.text.y};
  }
  /** sub_430F30 */
  clearText(): void {
    this.text.clear();
  }
  /** sub_430F40: earlier text dims unless the settings keep it. */
  dim(): void {
    if (!messageSetting19(this.env.memory, 'keepText')) this.text.dim();
  }

  /** sub_430E70: starts revealing if the box is visible. */
  reveal(): void {
    if (!this.recordVisible) return;
    this.text.startReveal();
    this.animating = true;
  }
  /** The configured reveal speed (sub_430140 from 0x416D90). */
  setSpeed(speed: number): void {
    this.env.memory.setSceneWord(this.record + BoxRecord.speed, speed);
    this.text.style = {...this.text.style, speed};
  }
  /** sub_430EB0: the looping wait icon, when the record allows one. */
  setWaiting(waiting: boolean): void {
    this.waiting = waiting && this.dword(BoxRecord.waitEnabled) !== 0;
    this.wait.show(this.waiting);
    this.waitIcon.animating = this.waiting;
  }
  tickWaiting(): boolean {
    return this.waiting && this.visible && this.wait.animate();
  }
}

export interface MessageEnvironment19 extends MessageEnvironment, TextBoxEnvironment19 {
  /** Plays a backlog voice mark's voice (the callback at +316). */
  voice(voice: number, pan: number): void;
  /** A setting changed; the game rebuilds the scene (window message 0x433, sub_421BC0). */
  settingsChanged(): void;
  /** The font list's catalog (0x4572F0). */
  listFonts(): Promise<readonly string[]>;
  /** Objects changed outside a script step (a posted 0x401 repaint). */
  redraw(): void;
}

/** A backlog voice mark (0x42D2A0): the glyph it precedes, the voice and its button. */
interface VoiceMark {
  readonly glyph: number;
  readonly voice: number;
  readonly pan: number;
  button: ImageButton | null;
}

/**
 * The 1.9 message window (0x42A0D0): one full-screen text box that collects a page of
 * messages, the backlog kept in the scene state (0x42CB10), the companion panel, the message
 * settings panel (`excompane`), the font list and the backlog scroll bars (`logbar_h` for
 * rows, `logbar_v` for columns) with voice marks beside spoken lines.
 */
export class RScriptMessageWindow19 extends RScriptContainer implements RScriptMessageView {
  readonly box: RScriptTextBox19;
  readonly panel: RScriptMessagePanel;
  private readonly settings = new RScriptContainer();
  private readonly marks = new RScriptContainer();
  private readonly settingButtons = new Map<MessageSetting19, StateButtons>();
  private fontButton: ImageButton | null = null;
  private fonts: RScriptFontWindow | null = null;
  private listingFonts = false;
  /** Backlog bars for rows (+168) and columns (+172). */
  private rowBar: ScrollBar | null = null;
  private columnBar: ScrollBar | null = null;
  /** Page starts from the newest (+152) and the page in view (+264). */
  private pages: number[] = [];
  private pageIndex = 0;
  private voiceMarks: VoiceMark[] = [];
  /** Page text shown by save screens. */
  pageText: Uint8Array = new Uint8Array();
  /** The script waits for input (+272). */
  inputActive = false;
  /** Auto mode hid the panel (+280). */
  autoHidden = false;
  /** The backlog is open (+268). */
  browsing = false;
  /** The wait icon showed when the backlog opened (+276). */
  private waitingBeforeBacklog = false;

  constructor(private readonly env: MessageEnvironment19) {
    super();
    this.box = new RScriptTextBox19(env, Scene.message + MessageState.boxes);
    this.add(this.box, 1);
    this.panel = new RScriptMessagePanel(
      (command) => env.command(command),
      (value) => {
        // sub_42D540: the frame back follows the slider, then the game stores the value.
        this.box.setBackAlpha(value);
        env.windowAlpha(value);
      },
    );
    this.add(this.panel, 2);
    this.settings.setPosition(0, 550);
    this.settings.visible = false;
    this.add(this.settings, 2);
    this.marks.visible = false;
    this.add(this.marks, 3);
  }

  private get memory(): RScriptMemory {
    return this.env.memory;
  }
  /** Scene offset of a 1.9 message state field. */
  private at(offset: number): number {
    return this.memory.sceneAt(Scene.message) + offset;
  }
  private rawWord(offset: number): number {
    return this.memory.sceneView.getUint16(this.at(offset), true);
  }
  private rawDword(offset: number): number {
    return this.memory.sceneView.getUint32(this.at(offset), true);
  }
  private setRawWord(offset: number, value: number): void {
    this.memory.sceneView.setUint16(this.at(offset), value, true);
  }
  private setRawDword(offset: number, value: number): void {
    this.memory.sceneView.setUint32(this.at(offset), value >>> 0, true);
  }
  private entry(index: number): number {
    return State.backlog + index * State.entrySize;
  }
  private entryKind(index: number): number {
    return this.memory.scene[this.at(this.entry(index) + Entry.kind)]!;
  }
  /** A 1.11 message state field, as the game and opcodes name them. */
  dword(offset: number): number {
    return this.memory.sceneDword(Scene.message + offset);
  }
  private get direction(): number {
    return layoutOf(this.memory).direction;
  }
  private get bar(): ScrollBar | null {
    return this.direction ? this.rowBar : this.columnBar;
  }

  /** 0x42AA80, 0x42B790 and the bars and font list of 0x42A0D0. */
  async loadPanel(): Promise<void> {
    const {images, systemDirectory} = this.env;
    await this.panel.load(images, systemDirectory);
    this.panel.setPosition(585, 572);
    const image = await ScreenImage.open(images, `${systemDirectory}\\excompane`);
    if (image) {
      this.settings.resize(image.width, image.height);
      this.fontButton = await image.button('font_0', () => void this.toggleFonts());
      if (this.fontButton) this.settings.add(this.fontButton, 0);
      const groups: [MessageSetting19, string, 'select' | 'cycle'][] = [
        ['size', 'size', 'select'],
        ['shadowOff', 'shdw', 'cycle'],
        ['direction', 'dir', 'cycle'],
        ['placement', 'snap', 'select'],
        ['fixedCharacters', 'lctr', 'cycle'],
        ['keepCharacters', 'lfcs', 'cycle'],
        ['keepText', 'tfcs', 'cycle'],
      ];
      for (const [setting, name, mode] of groups) {
        const group = await StateButtons.create(image, name, mode, (value) =>
          this.changeSetting(setting, value),
        );
        for (const button of group.buttons) this.settings.add(button, 0);
        group.set(messageSetting19(this.memory, setting));
        this.settingButtons.set(setting, group);
      }
    }
    this.rowBar = await ScrollBar.create(images, `${systemDirectory}\\logbar_h`, true, (value) =>
      this.browse(value),
    );
    this.columnBar = await ScrollBar.create(
      images,
      `${systemDirectory}\\logbar_v`,
      false,
      (value) => this.browse(value),
    );
    this.rowBar?.setPosition(770, 30);
    this.columnBar?.setPosition(90, 550);
    for (const bar of [this.rowBar, this.columnBar]) {
      if (!bar) continue;
      bar.visible = false;
      this.add(bar, 3);
    }
    const fonts = new RScriptFontWindow(
      {
        images,
        rasterizer: this.env.rasterizer,
        systemDirectory,
        chosen: (index) => this.fontChosen(index),
      },
      FONT_PANEL,
    );
    if (await fonts.load()) {
      fonts.setPosition(64, 350);
      this.add(fonts, 3);
      this.fonts = fonts;
    }
    this.setInput(false);
  }

  /** 0x42E200..0x42E320: stores a setting and rebuilds the scene with it. */
  private changeSetting(setting: MessageSetting19, value: number): void {
    this.memory.configView.setUint16(MessageSettings19[setting], value, true);
    this.env.settingsChanged();
  }
  /** Shows the settings' current values on their buttons. */
  private showSettings(): void {
    for (const [setting, group] of this.settingButtons)
      group.set(messageSetting19(this.memory, setting));
  }

  /** sub_42E180: the font button shows or hides the font list, which lists on first use. */
  private async toggleFonts(): Promise<void> {
    const fonts = this.fonts;
    if (!fonts || this.listingFonts) return;
    if (fonts.visible) {
      fonts.close();
      return;
    }
    if (!fonts.fonts.length) {
      this.listingFonts = true;
      try {
        fonts.setFonts(await this.env.listFonts());
      } finally {
        this.listingFonts = false;
      }
    }
    fonts.show(true);
    this.env.redraw();
  }
  /** sub_42DED0: the chosen font becomes the configured name and face 2. */
  private fontChosen(index: number): void {
    const fonts = this.fonts;
    if (!fonts) return;
    fonts.close();
    const name = fonts.fonts[index];
    const bytes = name === undefined ? null : encodeCp932(name);
    if (!name || !bytes) return;
    this.memory.setConfigString(Config.fontName, 52, bytes);
    this.env.rasterizer.setFace(2, name);
    this.env.settingsChanged();
  }

  /** sub_42DCB0: the slider position and the frame back's opacity. */
  setWindowAlpha(value: number): void {
    this.panel.setWindowAlpha(value);
    this.box.setBackAlpha(value);
  }

  /**
   * sub_42DB00: the panels show while enabled, box 0 is visible and auto mode has not hidden
   * them; `allowed` is the caller's switch.
   */
  updatePanel(allowed = true): void {
    const shown =
      allowed &&
      this.rawDword(State.panelEnabled) !== 0 &&
      this.box.recordVisible &&
      !this.autoHidden;
    this.panel.show(shown);
    this.settings.show(shown);
  }
  /** sub_42DB90: input while the script waits; the font list closes. */
  setInput(active: boolean): void {
    this.inputActive = active;
    this.panel.setInput(active);
    if (this.fontButton) {
      this.fontButton.interactive = active;
      if (!active) this.fontButton.unfocus();
    }
    for (const group of this.settingButtons.values()) group.setInput(active);
    this.fonts?.close();
  }
  /** sub_42CDF0: auto mode ended; the panels return. */
  restorePanel(): void {
    this.autoHidden = false;
    this.updatePanel();
  }
  /** sub_42D950: the voice button while the page in view has a voice. */
  private showVoiceButton(): void {
    this.panel.setVoice(this.rawDword(State.voice) !== 0);
  }
  /** Voice and pan of the current page (page record +24, +28). */
  currentVoice(): {voice: number; pan: number} {
    return {
      voice: this.rawDword(State.voice),
      pan: this.memory.sceneView.getInt16(this.at(State.pan), true),
    };
  }
  /** sub_42D930 */
  setVoice(voice: number, pan: number): void {
    this.setRawDword(State.voice, voice);
    this.setRawWord(State.pan, pan);
  }

  /** sub_42CB10: records the current source as the newest backlog entry. */
  private pushBacklog(kind: number): void {
    const scene = this.memory.scene;
    const base = this.at(State.backlog);
    const size = State.entrySize;
    const last = base + size * (State.entryCount - 1);
    const view = this.memory.sceneView;
    const filled = (): boolean =>
      view.getUint16(last + Entry.script, true) !== 0 ||
      view.getUint32(last + Entry.text, true) !== 0;
    if (!scene[last + Entry.kind] && !filled()) scene[last + Entry.kind] = PAGE_START;
    if (filled()) {
      // The oldest page leaves whole: its later entries go before the ring moves on.
      if (scene[base + Entry.kind] === PAGE_START)
        for (let i = 1; i < State.entryCount; i++) {
          const entry = base + size * i;
          if (scene[entry + Entry.kind] === PAGE_START) break;
          scene.fill(0, entry, entry + size);
        }
      scene.copyWithin(base, base + size, base + size * State.entryCount);
      scene[last + Entry.kind] = kind;
    }
    const copy = (from: number, length: number, to: number): void => {
      scene.copyWithin(last + to, this.at(from), this.at(from) + length);
    };
    copy(State.page, State.pageSize, Entry.page);
    copy(State.source, State.sourceSize, Entry.script);
    copy(State.box, State.boxSize, Entry.box);
  }

  /** sub_42DA20: shows or hides the box; hiding clears it. */
  async showBox(box: number, visible: boolean, skipping: boolean): Promise<void> {
    this.box.setVisible(visible, skipping);
    if (!visible) this.clear(box, skipping);
    if (!skipping && visible) await this.box.apply();
    if (box === 0) this.updatePanel(visible);
  }

  /**
   * sub_42D790: adds a message to the page. A new message starts a line, with a blank line
   * around a speaker's message (one starting with 【); earlier text dims, and a message that
   * does not fit starts a new page.
   */
  async display(
    box: number,
    source: MessageSource,
    newMessage: boolean,
    skipping: boolean,
  ): Promise<void> {
    this.setRawWord(State.script, source.script);
    this.setRawDword(State.text, source.text);
    await this.showBox(box, true, skipping);
    const text = await this.env.scriptString(source.script, source.text);
    const lastSpeaker = this.rawWord(this.entry(State.entryCount - 1) + Entry.speaker);
    const speaker = text[0] === SPEAKER[0] && text[1] === SPEAKER[1];
    if (newMessage) {
      if (this.box.text.length) {
        this.box.append(LINE_BREAK);
        this.setRawWord(State.speaker, speaker ? 1 : 0);
        if (speaker || lastSpeaker) this.box.append(BLANK_LINE);
      } else if (speaker) this.setRawWord(State.speaker, 1);
    } else this.setRawWord(State.speaker, lastSpeaker);
    this.box.dim();
    if (this.box.append(text)) {
      this.pushBacklog(newMessage ? NEW_MESSAGE : 0);
      this.pageText = newMessage ? text : concat(this.pageText, text);
    } else {
      this.box.clearText();
      this.box.append(text);
      this.pushBacklog(PAGE_START);
      this.pageText = text;
    }
    if (!skipping) this.showVoiceButton();
  }

  /** sub_42D9D0: clears the page and starts a new one in the backlog. */
  clear(_box: number, _skipping: boolean): void {
    this.setRawWord(State.script, 0);
    this.setRawDword(State.text, 0);
    this.setRawWord(State.speaker, 0);
    this.pushBacklog(PAGE_START);
    this.box.clearText();
    this.pageText = new Uint8Array();
  }

  /** sub_42DC40 */
  reveal(): void {
    this.box.reveal();
  }
  get revealing(): boolean {
    return this.box.text.animating && !this.box.text.complete;
  }
  /** vtable +96: completes the reveal. */
  finish(): void {
    this.box.text.finishReveal();
    this.box.stopAnimation();
  }
  /** sub_42DC90 */
  setWaiting(waiting: boolean): void {
    this.box.setWaiting(waiting);
  }
  tickWaiting(): void {
    this.box.tickWaiting();
  }
  setSpeed(speed: number): void {
    this.box.setSpeed(speed);
  }
  /** Scene bytes of the backlog, which nested calls keep. */
  backlogRange(): {start: number; length: number} {
    return {start: this.at(State.backlog), length: State.entrySize * State.entryCount};
  }
  /** sub_42C060 */
  clearBacklog(): void {
    const {start, length} = this.backlogRange();
    this.memory.scene.fill(0, start, start + length);
  }
  private boxField(box: number, field: number): number {
    return Scene.message + MessageState.boxes + box * MessageState.boxStride + field;
  }
  setBoxWord(box: number, field: number, value: number): void {
    this.memory.setSceneWord(this.boxField(box, field), value);
  }
  setBoxDword(box: number, field: number, value: number): void {
    this.memory.setSceneDword(this.boxField(box, field), value);
  }
  /** The box setters apply the whole record, settings included. */
  async applyBoxes(): Promise<void> {
    await this.box.apply();
  }

  /** sub_42C6E0: the newest page start. */
  private lastPage(): number {
    for (let i = State.entryCount - 1; i >= 0; i--) if (this.entryKind(i) === PAGE_START) return i;
    return 0;
  }
  private async entryText(index: number): Promise<Uint8Array | null> {
    const entry = this.entry(index);
    const script = this.rawWord(entry + Entry.script);
    const text = this.rawDword(entry + Entry.text);
    if (!script && !text) return null;
    return this.env.scriptString(script, text);
  }
  private entrySpeaker(index: number): boolean {
    return index >= 0 && this.rawWord(this.entry(index) + Entry.speaker) !== 0;
  }

  /**
   * sub_42C2E0 (`marks` false) and sub_42C480: lays out the page starting at backlog entry
   * `start` the way it was displayed. The current page dims earlier messages; a backlog page
   * gets voice marks before spoken speaker messages instead.
   */
  private async showPage(start: number, marks: boolean): Promise<void> {
    this.box.clearText();
    await this.box.apply();
    if (marks) this.removeVoiceMarks();
    const first = await this.entryText(start);
    if (!first) {
      if (!marks) this.pageText = new Uint8Array();
      return;
    }
    if (marks) this.markVoice(start);
    this.box.append(first);
    let text = first;
    for (let i = start + 1; i < State.entryCount; i++) {
      if (this.entryKind(i) === PAGE_START) break;
      const next = (await this.entryText(i)) ?? new Uint8Array();
      if (this.entryKind(i) === NEW_MESSAGE) this.box.append(LINE_BREAK);
      if (this.entrySpeaker(i)) {
        this.box.append(BLANK_LINE);
        if (marks) this.markVoice(i);
      } else if (this.entrySpeaker(i - 1)) this.box.append(BLANK_LINE);
      if (!marks) this.box.dim();
      this.box.append(next);
      text = concat(text, next);
    }
    this.box.text.finishReveal();
    if (!marks) this.pageText = text;
    else this.createVoiceMarks();
  }

  /** sub_42D2A0 for a speaker entry with a voice: a mark before its first glyph. */
  private markVoice(index: number): void {
    const entry = this.entry(index);
    if (!this.entrySpeaker(index)) return;
    const voice = this.rawDword(entry + Entry.voice);
    if (!voice) return;
    this.voiceMarks.push({
      glyph: this.box.text.length,
      voice,
      pan: this.memory.sceneView.getInt16(this.at(entry + Entry.pan), true),
      button: null,
    });
  }
  /** sub_42D200 */
  private removeVoiceMarks(): void {
    for (const mark of this.voiceMarks) if (mark.button) this.marks.remove(mark.button);
    this.voiceMarks = [];
  }
  /**
   * sub_42CF40: `vocmarkNN` buttons for the marks, above the first glyph's column or left of
   * its row.
   */
  private createVoiceMarks(): void {
    const path = `${this.env.systemDirectory}\\vocmark${String(this.box.markSize).padStart(2, '0')}`;
    const marks = this.voiceMarks;
    void ScreenImage.open(this.env.images, path).then(async (image) => {
      if (!image) return;
      for (const mark of marks) {
        if (mark.button || marks !== this.voiceMarks) continue;
        const button = await image.button('voc', () => {
          if (this.inputActive) this.env.voice(mark.voice, mark.pan);
        });
        const rect = this.box.glyphRect(mark.glyph);
        if (!button || !rect || marks !== this.voiceMarks) continue;
        if (this.direction) button.setPosition(rect.x - button.width, rect.y);
        else button.setPosition(rect.x + rect.width - button.width, rect.y - button.height);
        mark.button = button;
        this.marks.add(button, 0);
      }
      this.env.redraw();
    });
  }

  /** sub_42C7E0: page starts from the newest, and the bars' ranges. */
  private findPages(): void {
    this.pages = [];
    for (let i = State.entryCount - 1; i >= 0; i--)
      if (this.entryKind(i) === PAGE_START) this.pages.push(i);
    for (const bar of [this.rowBar, this.columnBar]) bar?.setRange(0, this.pages.length - 1);
  }
  private showBar(): void {
    const bar = this.bar;
    const other = bar === this.rowBar ? this.columnBar : this.rowBar;
    other?.show(false);
    other?.setInput(false);
    if (!bar || this.pages.length <= 1) return;
    bar.set(this.pageIndex);
    bar.show(true);
    bar.setInput(true);
  }
  /** sub_42C710: the bar chose a page. */
  private browse(index: number): void {
    this.pageIndex = index;
    const start = this.pages[index];
    if (start !== undefined) void this.showPage(start, true).then(() => this.env.redraw());
  }

  /** sub_42C890: opens the backlog at the current page, or closes it when open. */
  async enterBacklog(): Promise<boolean> {
    if (this.browsing) return this.exitBacklog();
    if (!this.rawDword(State.backlogEnabled)) return false;
    this.findPages();
    if (!this.pages.length) return false;
    this.browsing = true;
    this.waitingBeforeBacklog = this.box.waiting;
    this.setWaiting(false);
    this.pageIndex = 0;
    await this.showPage(this.pages[0]!, true);
    this.marks.show(true);
    this.showBar();
    return true;
  }
  /** sub_42CA00: returns to the current page; true when the backlog was open. */
  async exitBacklog(): Promise<boolean> {
    if (!this.browsing) return false;
    this.pages = [];
    await this.showPage(this.lastPage(), false);
    this.showVoiceButton();
    if (this.waitingBeforeBacklog) this.setWaiting(true);
    this.browsing = false;
    this.marks.show(false);
    for (const bar of [this.rowBar, this.columnBar]) {
      bar?.show(false);
      bar?.setInput(false);
    }
    return true;
  }

  /**
   * The mouse wheel (sub_42C750 down, sub_42C730 up): it opens the backlog, and while it is
   * open steps the bar back (down in columns, up in rows) or on. Stepping on, and opening
   * with that turn, needs input.
   */
  async wheel(up: boolean): Promise<boolean> {
    const back = up === (this.direction !== 0);
    if (!back && !this.inputActive) return true;
    if (!this.browsing) await this.enterBacklog();
    else if (back) this.bar?.previous();
    else this.bar?.next();
    return true;
  }
  /** The panel's `bak` button opens or closes the backlog; `fow` closes it. */
  async backlogButton(forward: boolean): Promise<boolean> {
    if (forward) await this.exitBacklog();
    else await this.enterBacklog();
    return true;
  }

  /** The constructor's state (0x42A0D0): panels, marks and bars hidden, the backlog closed. */
  reset(): void {
    this.autoHidden = false;
    this.browsing = false;
    this.pages = [];
    this.setWaiting(false);
    this.setInput(false);
    this.panel.show(false);
    this.settings.show(false);
    this.marks.show(false);
    for (const bar of [this.rowBar, this.columnBar]) {
      bar?.show(false);
      bar?.setInput(false);
    }
  }

  /** sub_42C0F0: rebuilds the page, or the backlog page in view, from the state. */
  async restore(): Promise<void> {
    await this.box.apply();
    if (this.browsing) {
      this.showBar();
      const start = this.pages[this.pageIndex];
      if (start !== undefined) await this.showPage(start, true);
    } else await this.showPage(this.lastPage(), false);
    this.showVoiceButton();
    this.panel.setPosition(585, 572);
    this.showSettings();
    if (this.box.recordVisible) this.updatePanel();
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const joined = new Uint8Array(a.length + b.length);
  joined.set(a);
  joined.set(b, a.length);
  return joined;
}

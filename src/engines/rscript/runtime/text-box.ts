import type {RScriptImages} from '../images.js';
import type {RScriptMemory} from '../memory.js';
import {RScriptContainer, RScriptSprite} from '../graphics/sprite.js';
import {RScriptTextBlock, type GlyphRasterizer, type TextStyle} from './text-block.js';

/** 96-byte text box record inside the message state (0x48AE84 + 96 * box). */
export const BoxRecord = {
  x: 0,
  y: 4,
  textX: 8,
  textY: 12,
  nameX: 16,
  nameY: 20,
  waitX: 24,
  waitY: 28,
  textWidth: 32,
  textHeight: 36,
  nameWidth: 40,
  nameHeight: 44,
  frame: 48,
  waitIcon: 50,
  face: 54,
  size: 56,
  align: 58,
  rubyFace: 60,
  rubySize: 62,
  rubyRaise: 64,
  lineSpacing: 66,
  charSpacing: 68,
  speed: 70,
  indent: 72,
  firstIndent: 74,
  color: 76,
  glow: 80,
  nameVisible: 84,
  waitEnabled: 88,
  visible: 92,
} as const;

export interface TextBoxEnvironment {
  readonly memory: RScriptMemory;
  readonly images: RScriptImages;
  readonly rasterizer: GlyphRasterizer;
  /** System image directory holding `tboxNN.lwg` and `waitNN.lwg`. */
  readonly systemDirectory: string;
  /** `^C0`..`^C9` palette from the APINI text defaults. */
  readonly palette: readonly number[];
  readonly shadow: boolean;
}

/**
 * Message text box (0x418C20): frame back/front, name plate, main text (200 glyphs),
 * name text (32 glyphs) and the click-wait icon with its glowing overlay.
 */
export class RScriptTextBox extends RScriptContainer {
  private readonly back = new RScriptSprite();
  private readonly front = new RScriptSprite();
  private readonly plate = new RScriptSprite();
  private readonly wait = new RScriptContainer();
  private readonly waitBody = new RScriptSprite();
  private readonly waitGlow = new RScriptSprite();
  readonly text: RScriptTextBlock;
  readonly name: RScriptTextBlock;
  private frameLoaded = -1;
  private waitLoaded = -1;
  waiting = false;

  constructor(
    private readonly env: TextBoxEnvironment,
    readonly record: number,
  ) {
    super();
    this.text = new RScriptTextBlock(env.rasterizer, 200, this.style(false));
    this.name = new RScriptTextBlock(env.rasterizer, 32, this.style(true));
    this.add(this.back, 0);
    this.add(this.front, 1);
    this.add(this.text, 2);
    this.add(this.wait, 3);
    this.add(this.plate, 5);
    this.add(this.name, 6);
    this.wait.add(this.waitBody, 0);
    this.wait.add(this.waitGlow, 1);
    this.back.setBlendMode(2);
    this.waitGlow.setBlendMode(0x6b);
    this.wait.visible = false;
    this.visible = false;
  }

  private word(field: number): number {
    return this.env.memory.sceneUword(this.record + field);
  }
  private dword(field: number): number {
    return this.env.memory.sceneDword(this.record + field);
  }
  setWord(field: number, value: number): void {
    this.env.memory.setSceneWord(this.record + field, value);
  }
  setDword(field: number, value: number): void {
    this.env.memory.setSceneDword(this.record + field, value);
  }
  get recordVisible(): boolean {
    return this.dword(BoxRecord.visible) !== 0;
  }

  private style(name: boolean): TextStyle {
    const r = BoxRecord;
    return {
      face: this.word(r.face),
      size: this.word(r.size) || 24,
      color: this.dword(r.color),
      palette: this.env.palette,
      shadow: this.env.shadow,
      speed: this.word(r.speed),
      lineSpacing: this.word(r.lineSpacing),
      charSpacing: this.word(r.charSpacing),
      indent: name ? 0 : this.word(r.indent),
      firstIndent: name ? 0 : this.word(r.firstIndent),
      align: this.word(r.align),
      width: this.dword(name ? r.nameWidth : r.textWidth),
      height: this.dword(name ? r.nameHeight : r.textHeight),
      rubyFace: this.word(r.rubyFace),
      rubySize: this.word(r.rubySize) || 12,
      rubyRaise: this.word(r.rubyRaise),
    };
  }

  private async loadLwgLayer(target: RScriptSprite, lwg: string, layer: string): Promise<boolean> {
    const image = await this.env.images.lwg(lwg);
    const entry = image?.find(layer);
    if (!entry) {
      target.setSurface(null);
      return false;
    }
    target.setSurface(await this.env.images.lwgLayer(lwg, layer));
    target.setPosition(entry.x, entry.y);
    target.show(true);
    return true;
  }

  /** sub_419A40 / sub_419FD0: frame and wait icon images for the record's numbers. */
  private async loadImages(): Promise<void> {
    const frame = this.word(BoxRecord.frame),
      waitIcon = this.word(BoxRecord.waitIcon);
    const dir = this.env.systemDirectory;
    if (frame !== this.frameLoaded) {
      this.frameLoaded = frame;
      const lwg = `${dir}\\tbox${String(frame).padStart(2, '0')}`;
      await this.loadLwgLayer(this.front, lwg, 'front');
      await this.loadLwgLayer(this.back, lwg, 'back');
      await this.loadLwgLayer(this.plate, lwg, 'plate');
    }
    if (waitIcon !== this.waitLoaded) {
      this.waitLoaded = waitIcon;
      const lwg = `${dir}\\wait${String(waitIcon).padStart(2, '0')}`;
      await this.loadLwgLayer(this.waitBody, lwg, 'body');
      if (await this.loadLwgLayer(this.waitGlow, lwg, 'grow')) {
        this.waitGlow.startFade(0x6b, 0, 8);
        this.waitGlow.fade.loop = true;
      }
    }
  }

  /** sub_419750: applies the whole record to the visible objects. */
  async apply(): Promise<void> {
    await this.loadImages();
    const r = BoxRecord;
    this.setPosition(this.dword(r.x), this.dword(r.y));
    this.text.setPosition(this.dword(r.textX), this.dword(r.textY));
    this.name.setPosition(this.dword(r.nameX), this.dword(r.nameY));
    this.wait.setPosition(this.dword(r.waitX), this.dword(r.waitY));
    this.waitGlow.blend.color = this.dword(r.glow);
    this.text.style = this.style(false);
    this.name.style = this.style(true);
    this.text.resize(this.text.style.width, this.text.style.height);
    this.name.resize(this.name.style.width, this.name.style.height);
    const nameVisible = this.dword(r.nameVisible) !== 0;
    this.name.show(nameVisible);
    this.plate.show(nameVisible && this.plate.surface !== null);
    this.show(this.recordVisible);
  }

  setVisible(visible: boolean, skipping: boolean): void {
    this.setDword(BoxRecord.visible, visible ? 1 : 0);
    if (!skipping) this.show(visible);
  }

  /** sub_41A180 / sub_41A190 / sub_41A2B0 / sub_41A2C0 */
  appendText(text: Uint8Array): void {
    this.text.append(text);
  }
  clearText(): void {
    this.text.clear();
  }
  setName(name: Uint8Array | null): void {
    this.name.clear();
    const visible = !!name?.length;
    if (name?.length) {
      this.name.append(name);
      this.name.finishReveal();
    }
    this.setDword(BoxRecord.nameVisible, visible ? 1 : 0);
    this.name.show(visible);
    this.plate.show(visible && this.plate.surface !== null);
  }

  /** sub_41A1F0: starts revealing if the box is visible. */
  reveal(): void {
    if (!this.recordVisible) return;
    this.text.startReveal();
    this.animating = true;
  }
  /** sub_4196C0: glyph reveal speed from the configuration. */
  setSpeed(speed: number): void {
    this.setWord(BoxRecord.speed, speed);
    this.text.style = {...this.text.style, speed};
  }
  /** sub_41A2F0: animates the wait icon while the scene only ticks idle objects. */
  tickWaiting(): boolean {
    return this.waiting && this.visible && this.wait.animate();
  }
  /** sub_41A230: the click-wait icon with its looping glow. */
  setWaiting(waiting: boolean): void {
    this.waiting = waiting && this.dword(BoxRecord.waitEnabled) !== 0;
    this.wait.show(this.waiting);
    this.waitGlow.animating = this.waiting;
  }
}

import {decodeWcg} from '../../../formats/rscript/wcg.js';
import {createSurface, surfaceFromImage, type RScriptSurface} from '../graphics/pixels.js';
import {RScriptContainer, RScriptSprite} from '../graphics/sprite.js';
import type {RScriptImages} from '../images.js';
import type {RScriptMemory} from '../memory.js';
import {decodeSlotHeader, type RScriptSlotHeader} from '../saves.js';
import {RScriptTextBlock, type GlyphRasterizer, type TextStyle} from './text-block.js';
import {ScreenImage, type ImageButton} from './widgets.js';

export interface SaveScreenEnvironment {
  readonly memory: RScriptMemory;
  readonly images: RScriptImages;
  readonly rasterizer: GlyphRasterizer;
  readonly systemDirectory: string;
  readonly width: number;
  readonly height: number;
  /** APINI text palette (+440), date size (+496) and page count (+438). */
  readonly palette: readonly number[];
  readonly dateSize: number;
  readonly pageCount: number;
  readSlot(slot: number): Promise<Uint8Array | null>;
  readThumbnail(slot: number): Promise<Uint8Array | null>;
  /** A slot panel was clicked (0x41EA70 saves, 0x41EB60 loads). */
  choose(slot: number, save: boolean): void;
  close(): void;
  sound(sound: number): void;
}

const pad = (value: number, digits: number): string => String(value).padStart(digits, '0');

/** Page selection lives in the configuration word 0x38; the last saved slot in 0x3A. */
const PAGE = 0x38,
  LAST_SAVED = 0x3a;

/**
 * One slot of the save screen (0x405240): chapter images `dt1_NNNN` and `dt2_NNNN` from
 * the saved variables 1 and 2, the date coloured by variable 3, the thumbnail saved with
 * the slot and the marker of the last save, under a hover mask that inverts the panel.
 */
class SlotPanel extends RScriptContainer {
  private readonly title = new RScriptSprite();
  private readonly chapter = new RScriptSprite();
  private readonly thumbnail = new RScriptSprite();
  private readonly marker = new RScriptSprite();
  private readonly mask = new RScriptSprite();
  private readonly date: RScriptTextBlock;
  slot = 0;

  constructor(
    private readonly env: SaveScreenEnvironment,
    private readonly layout: ScreenImage,
    private readonly newMarker: RScriptSurface | null,
    press: (panel: SlotPanel) => void,
  ) {
    super(layout.width, layout.height);
    const at = (name: string, fallback: {x: number; y: number}) =>
      layout.position(name) ?? fallback;
    this.chapter.setPosition(at('icon', {x: 59, y: 0}).x, at('icon', {x: 59, y: 0}).y);
    const date = at('date', {x: 110, y: 40});
    this.date = new RScriptTextBlock(env.rasterizer, 30, this.dateStyle(0xffffff));
    this.date.resize(300, 30);
    this.date.setPosition(date.x, date.y);
    const thumb = layout.position('thmb');
    if (thumb) this.thumbnail.setPosition(thumb.x, thumb.y);
    const marker = at('new', {x: 0, y: 0});
    this.marker.setPosition(marker.x, marker.y);
    this.mask.setSurface(createSurface(layout.width, layout.height));
    // Blend mode 23 draws nothing; hovering switches to 103, which inverts the panel.
    this.mask.setBlendMode(23);
    this.mask.onHover = (_, inside) => this.mask.setBlendMode(inside ? 103 : 23);
    this.mask.onPress = () => press(this);
    this.mask.interactive = true;
    this.add(this.title, 0);
    this.add(this.chapter, 1);
    this.add(this.date, 1);
    if (thumb) this.add(this.thumbnail, 2);
    this.add(this.marker, 3);
    this.add(this.mask, 1);
    this.mask.show(true);
  }

  private dateStyle(color: number): TextStyle {
    return {
      face: 0,
      size: this.env.dateSize,
      color,
      palette: this.env.palette,
      shadow: false,
      speed: 0,
      lineSpacing: 0,
      charSpacing: 0,
      indent: 0,
      firstIndent: 0,
      align: 0,
      width: 300,
      height: 30,
      rubyFace: 0,
      rubySize: 12,
      rubyRaise: 0,
      baselineAtBottom: true,
    };
  }

  /** sub_405970: shows slot `index + 10 * page + 1`. */
  async fill(page: number, index: number): Promise<void> {
    const slot = index + 10 * page + 1;
    this.slot = slot;
    const bytes = await this.env.readSlot(slot);
    if (this.slot !== slot) return;
    let header: RScriptSlotHeader | null = null;
    try {
      header = bytes ? decodeSlotHeader(bytes, this.env.memory.revision) : null;
    } catch {
      header = null;
    }
    const {images, systemDirectory} = this.env;
    if (!header) {
      for (const sprite of [this.title, this.chapter, this.thumbnail, this.marker])
        sprite.show(false);
      this.date.show(false);
      return;
    }
    const [first, second, color] = header.variables;
    const title = await images.image(`${systemDirectory}\\dt1_${pad(first & 0xffff, 4)}`);
    const chapter = await images.image(`${systemDirectory}\\dt2_${pad(second & 0xffff, 4)}`);
    this.title.setSurface(title);
    this.title.show(!!title);
    this.chapter.setSurface(chapter);
    this.chapter.show(!!chapter);
    const text = `${pad(header.year, 4)}/${pad(header.month, 2)}/${pad(header.day, 2)} ${pad(header.hour, 2)}:${pad(header.minute, 2)}`;
    this.date.clear();
    this.date.style = this.dateStyle(this.env.palette[color] ?? 0xffffff);
    this.date.append(new TextEncoder().encode(text));
    this.date.finishReveal();
    this.date.show(true);
    let thumbnail: RScriptSurface | null = null;
    try {
      const wcg = await this.env.readThumbnail(slot);
      thumbnail = wcg ? surfaceFromImage(decodeWcg(wcg)) : null;
    } catch {
      thumbnail = null;
    }
    this.thumbnail.setSurface(thumbnail);
    this.thumbnail.show(!!thumbnail);
    const latest = (this.env.memory.configWord(LAST_SAVED) & 0xffff) === slot;
    this.marker.setSurface(latest ? this.newMarker : null);
    this.marker.show(latest && !!this.newMarker);
  }

  setInput(enabled: boolean): void {
    this.mask.interactive = enabled;
    if (!enabled) this.mask.setBlendMode(23);
  }
}

/**
 * Save and load screen (0x411820): ten slot panels per page placed at the `0`..`9` layers
 * of `savescrn`, next and previous buttons, buttons `01`..`10` that choose a page, the page
 * digit from `nonbl` and the exit button, each where its layers exist.
 */
export class RScriptSaveScreen extends RScriptContainer {
  private readonly background = new RScriptSprite();
  private readonly panels: SlotPanel[] = [];
  private readonly digit = new RScriptSprite();
  private digits: {surface: RScriptSurface | null; x: number; y: number}[] = [];
  private numberAt: {x: number; y: number} | null = null;
  private image: ScreenImage | null = null;
  private next: RScriptSprite | null = null;
  private previous: RScriptSprite | null = null;
  private exit: RScriptSprite | null = null;
  /** Page buttons by page; absent layers leave gaps. */
  private pageButtons: (ImageButton | null)[] = [];
  private inputEnabled = false;
  save = false;

  constructor(private readonly env: SaveScreenEnvironment) {
    super(env.width, env.height);
    this.visible = false;
  }

  async load(): Promise<void> {
    const {images, systemDirectory} = this.env;
    const image = await ScreenImage.open(images, `${systemDirectory}\\savescrn`);
    const layout = await ScreenImage.open(images, `${systemDirectory}\\saveconf`);
    if (!image || !layout) return;
    this.image = image;
    this.setPosition((this.env.width - image.width) >> 1, (this.env.height - image.height) >> 1);
    this.add(this.background, 0);
    const marker = await images.image(`${systemDirectory}\\dat_new`);
    for (let i = 0; i < 10; i++) {
      const panel = new SlotPanel(this.env, layout, marker, (p) =>
        this.env.choose(p.slot, this.save),
      );
      const at = image.position(String(i));
      if (at) {
        panel.setPosition(at.x, at.y);
        this.add(panel, 10 - i);
        panel.show(true);
      }
      this.panels.push(panel);
    }
    this.exit = await image.button('exit', () => {
      this.env.sound(1);
      this.env.close();
    });
    this.next = await image.button('next', () => this.turn(1));
    this.previous = await image.button('prev', () => this.turn(-1));
    for (const button of [this.exit, this.next, this.previous]) if (button) this.add(button, 20);
    for (let page = 0; page < 10; page++) {
      const button = await image.button(pad(page + 1, 2), () => this.choosePage(page));
      if (button) this.add(button, 100);
      this.pageButtons.push(button);
    }
    this.numberAt = image.position('number');
    if (this.numberAt) {
      const digits = await ScreenImage.open(images, `${systemDirectory}\\nonbl`);
      if (digits)
        for (let i = 0; i < 10; i++)
          this.digits.push({
            surface: await digits.surface(String(i)),
            ...(digits.position(String(i)) ?? {x: 0, y: 0}),
          });
      this.add(this.digit, 20);
    }
  }

  private get page(): number {
    return this.env.memory.configWord(PAGE) & 0xffff;
  }

  /** sub_412630 / sub_412660: next and previous page. */
  private turn(direction: number): void {
    const page = this.page + direction;
    if (page < 0 || page > 9) return;
    this.env.memory.setConfigWord(PAGE, page);
    this.env.sound(1);
    void this.refresh();
  }

  /** The `NN` page buttons (sub_4105F0 in 1.9). */
  private choosePage(page: number): void {
    this.env.memory.setConfigWord(PAGE, page);
    this.env.sound(1);
    void this.refresh();
  }

  /** sub_412370: shows the screen for saving or loading. */
  async open(save: boolean): Promise<void> {
    this.save = save;
    const surface = this.image ? await this.image.surface(save ? 'bg_save' : 'bg_load') : null;
    this.background.setSurface(surface);
    this.background.setPosition(0, 0);
    this.background.show(!!surface);
    this.show(true);
    this.setInput(true);
    await this.refresh();
  }

  /** sub_412240: fills the panels, page buttons and digit for the current page. */
  async refresh(): Promise<void> {
    const page = this.page;
    await Promise.all(this.panels.map((panel, i) => panel.fill(page, i)));
    this.next?.show(page <= this.env.pageCount - 2);
    this.previous?.show(page !== 0);
    const digit = this.digits[page];
    if (digit && this.numberAt) {
      this.digit.setSurface(digit.surface);
      this.digit.setPosition(this.numberAt.x + digit.x, this.numberAt.y + digit.y);
      this.digit.show(!!digit.surface);
    }
    // The current page's button shows its selected image and ignores input (sub_4101A0).
    this.pageButtons.forEach((button, index) => {
      if (!button) return;
      button.show(true);
      button.selected = index === page;
      button.interactive = this.inputEnabled && index !== page;
    });
  }

  /** Refreshes the panel showing `slot`, after saving into it (sub_4124F0). */
  async refreshSlot(slot: number): Promise<void> {
    if (!slot) return;
    const index = (slot - 1) % 10;
    if (Math.trunc((slot - 1) / 10) === this.page) await this.panels[index]?.fill(this.page, index);
  }

  setInput(enabled: boolean): void {
    this.inputEnabled = enabled;
    for (const panel of this.panels) panel.setInput(enabled);
    for (const button of [this.exit, this.next, this.previous])
      if (button) button.interactive = enabled;
    this.pageButtons.forEach((button, index) => {
      if (!button) return;
      button.interactive = enabled && index !== this.page;
      if (!enabled) button.unfocus();
    });
  }

  close(): void {
    this.setInput(false);
    this.show(false);
  }
}

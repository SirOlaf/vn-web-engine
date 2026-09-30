import {RScriptContainer, type RScriptSprite} from '../graphics/sprite.js';
import type {RScriptImages} from '../images.js';
import {encodeCp932} from '../text.js';
import {RScriptTextBlock, type GlyphRasterizer} from './text-block.js';
import {ScreenImage, type ImageButton} from './widgets.js';

export interface FontWindowEnvironment {
  readonly images: RScriptImages;
  readonly rasterizer: GlyphRasterizer;
  readonly systemDirectory: string;
  /** The window's result (0x410750): a catalog index, or -1 from the exit button. */
  chosen(index: number): void;
}

/** Rows per page; each row sits 22 pixels below the previous one (0x430940). */
const ROWS = 10;
const ROW_STEP = 22;
/** The sample shown beside a hovered row (0x482070). */
const SAMPLE = encodeCp932('あぃウェ５＃―壱弐鶴亀ＡｂAb')!;

/** One list button (0x4501E0 over `list`): the font name, and a caption with a sample. */
interface FontRow {
  readonly button: ImageButton;
  readonly name: RScriptTextBlock | null;
  readonly caption: RScriptSprite | null;
  readonly sample: RScriptTextBlock | null;
}

/**
 * The configuration's font window (0x430940) from `fontwnd`: ten font rows per page with
 * previous, next and exit buttons. Each row draws its font's name and, while hovered, a
 * sample in that font (0x430ED0).
 */
export class RScriptFontWindow extends RScriptContainer {
  private readonly rows: FontRow[] = [];
  private next: ImageButton | null = null;
  private previous: ImageButton | null = null;
  private exit: ImageButton | null = null;
  private page = 0;
  fonts: readonly string[] = [];

  constructor(private readonly env: FontWindowEnvironment) {
    super();
    this.visible = false;
  }

  /** Builds the window from `fontwnd`; false when the image is absent. */
  async load(): Promise<boolean> {
    const image = await ScreenImage.open(this.env.images, `${this.env.systemDirectory}\\fontwnd`);
    if (!image) return false;
    this.resize(image.width, image.height);
    const background = await image.sprite('bg');
    if (background) this.add(background, 0);
    const nameRect = await image.rect('list_txt'),
      sampleRect = await image.rect('list_ctx');
    for (let row = 0; row < ROWS; row++) {
      const offset = row * ROW_STEP;
      const button = await image.button('list', () => this.press(row));
      if (!button) break;
      button.move(0, offset);
      const caption = await image.sprite('list_cap');
      caption?.move(0, offset);
      caption?.show(false);
      const text = (rect: typeof nameRect): RScriptTextBlock | null =>
        rect && this.textBlock(rect.x, rect.y + offset, rect.width, rect.height);
      const entry: FontRow = {button, name: text(nameRect), caption, sample: text(sampleRect)};
      entry.sample?.show(false);
      // The caption and sample appear while the pointer is over the row (0x450BA0).
      const hover = button.onHover;
      button.onHover = (sprite, inside) => {
        hover?.(sprite, inside);
        this.showSample(entry, inside);
      };
      for (const node of [button, caption, entry.name, entry.sample]) if (node) this.add(node, 1);
      this.rows.push(entry);
    }
    this.next = await image.button('next', () => this.turn(1));
    this.previous = await image.button('prev', () => this.turn(-1));
    this.exit = await image.button('exit', () => this.env.chosen(-1));
    for (const button of [this.next, this.previous, this.exit]) if (button) this.add(button, 1);
    this.render();
    return true;
  }

  /** sub_4507F0 as the rows call it: black, the rectangle's height, face set per row. */
  private textBlock(x: number, y: number, width: number, height: number): RScriptTextBlock {
    const block = new RScriptTextBlock(this.env.rasterizer, 64, {
      face: 0,
      size: height,
      color: 0,
      palette: [],
      shadow: false,
      speed: 0,
      lineSpacing: 0,
      charSpacing: 0,
      indent: 0,
      firstIndent: 0,
      align: 0,
      width,
      height,
      rubyFace: 0,
      rubySize: 12,
      rubyRaise: 0,
    });
    block.setPosition(x, y);
    return block;
  }

  private showSample(row: FontRow, shown: boolean): void {
    row.caption?.show(shown);
    row.sample?.show(shown);
  }

  /** sub_4317B0: a row's press hides its sample and reports the catalog index. */
  private press(row: number): void {
    this.showSample(this.rows[row]!, false);
    this.env.chosen(row + ROWS * this.page);
  }

  /** sub_4314F0 and sub_431740: the next or previous page, when there is one. */
  private turn(step: 1 | -1): void {
    const page = this.page + step;
    if (page < 0 || page > this.lastPage) return;
    this.page = page;
    this.render();
  }
  private get lastPage(): number {
    return Math.trunc((this.fonts.length - 1) / ROWS);
  }

  /** Replaces the catalog and shows its first page. */
  setFonts(fonts: readonly string[]): void {
    this.fonts = fonts;
    this.page = 0;
    this.render();
  }

  /**
   * sub_430ED0: draws each row's name and sample with its font as a temporary face, hides
   * rows past the catalog, and offers the page buttons where there are more pages.
   */
  private render(): void {
    const {rasterizer} = this.env;
    this.rows.forEach((row, i) => {
      const name = this.fonts[this.page * ROWS + i];
      const shown = name !== undefined;
      row.button.show(shown);
      row.button.interactive = shown;
      row.name?.show(shown);
      if (!shown) {
        this.showSample(row, false);
        return;
      }
      const face = rasterizer.addFace(name);
      write(row.name, encodeCp932(name) ?? new Uint8Array(), face);
      write(row.sample, SAMPLE, face);
      rasterizer.removeFace();
    });
    const offer = (button: ImageButton | null, shown: boolean): void => {
      if (!button) return;
      button.show(shown);
      button.interactive = shown;
    };
    offer(this.previous, this.page !== 0);
    offer(this.next, this.page !== this.lastPage);
    offer(this.exit, true);
  }

  /** Stops hover state when the window closes. */
  close(): void {
    for (const row of this.rows) {
      row.button.unfocus();
      this.showSample(row, false);
    }
    this.next?.unfocus();
    this.previous?.unfocus();
    this.exit?.unfocus();
    this.show(false);
  }
}

function write(block: RScriptTextBlock | null, text: Uint8Array, face: number): void {
  if (!block) return;
  block.style = {...block.style, face};
  block.clear();
  block.append(text);
  block.finishReveal();
}

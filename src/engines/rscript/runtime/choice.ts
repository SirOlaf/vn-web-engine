import {blendSprite} from '../graphics/blend.js';
import {createSurface, type RScriptRect, type RScriptSurface} from '../graphics/pixels.js';
import {RScriptContainer, RScriptSprite, type RScriptPoint} from '../graphics/sprite.js';
import type {RScriptImages} from '../images.js';
import {RScriptTextBlock, type GlyphRasterizer, type TextStyle} from './text-block.js';

export interface ChoiceEnvironment {
  readonly images: RScriptImages;
  readonly rasterizer: GlyphRasterizer;
  readonly systemDirectory: string;
  readonly width: number;
  readonly height: number;
  /**
   * Choice text defaults from the APINI block: the palette (+440), the question's size (+492)
   * and colour (+480), and the answers' size (+494) and colour (+484).
   */
  readonly palette: readonly number[];
  readonly questionTextSize: number;
  readonly questionTextColor: number;
  readonly textSize: number;
  /** 0xRRGGBB, stored as the text colour itself (sub_40FA00), not a palette index. */
  readonly textColor: number;
  /** An answer was clicked while the window accepted input (0x41EDF0). */
  answered(): void;
}

/** A plate with its text composited in; while canvas text is hidden it draws without it. */
class PlateSprite extends RScriptSprite {
  constructor(
    private readonly states: readonly RScriptSurface[],
    private readonly plain: readonly RScriptSurface[],
  ) {
    super();
  }
  protected override paint(target: RScriptSurface, clip: RScriptRect, x: number, y: number): void {
    let surface = this.surface;
    if (this.root()?.textHidden) surface = this.plain[this.states.indexOf(surface!)] ?? surface;
    if (surface) blendSprite(target, surface, x, y, clip, this.blend);
  }
}

interface Item {
  readonly sprite: RScriptSprite;
  /** Normal, focused and pressed images; missing states reuse the normal image. */
  readonly states: readonly RScriptSurface[];
  final: RScriptPoint;
  start: RScriptPoint;
  end: RScriptPoint;
}

const pad = (value: number): string => String(value).padStart(2, '0');

type PlateKind = 'q' | 'a';
interface TextRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
/** Glyph capacity of the text on an LWG plate and on a plain fallback plate. */
const PLATE_GLYPHS = 50;
const FALLBACK_GLYPHS = 25;
/** Text areas on the plain `sel_q` and `sel_a` plates. */
const FALLBACK_TEXT: Readonly<Record<PlateKind, TextRect>> = {
  q: {x: 20, y: 14, width: 510, height: 29},
  a: {x: 20, y: 11, width: 510, height: 27},
};

/** A leading `<N>` selects image set N (0x4151F0, 0x412C30). */
function imageSet(text: Uint8Array): {set: number; text: Uint8Array} {
  if (text[0] !== 0x3c) return {set: 0, text};
  const close = text.indexOf(0x3e);
  if (close < 0) return {set: 0, text};
  let set = 0;
  for (let i = 1; i < close && text[i]! >= 0x30 && text[i]! <= 0x39; i++)
    set = set * 10 + text[i]! - 0x30;
  return {set, text: text.subarray(close + 1)};
}

/**
 * Choice window (0x413940): a question plate over up to five answer buttons built from
 * `sel_qNN` and `sel_aNN` in the system directory, laid out by the default arrangement
 * used when no `selmapNN` layout exists, sliding in and out around the answer.
 */
export class RScriptChoiceWindow extends RScriptContainer {
  private question: Item | null = null;
  private answers: Item[] = [];
  /** 1-based answer, 0 while none is chosen (+112). */
  selected = 0;

  constructor(private readonly env: ChoiceEnvironment) {
    super(env.width, env.height);
    this.visible = false;
  }

  private style(kind: PlateKind, width: number, height: number): TextStyle {
    const env = this.env;
    return {
      face: 0,
      size: kind === 'q' ? env.questionTextSize : env.textSize,
      color: kind === 'q' ? env.questionTextColor : env.textColor,
      palette: env.palette,
      // The plain text object (0x44BEE0) keeps its default unshadowed glyph style.
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
      baselineAtBottom: true,
    };
  }

  /** A plain text object of `capacity` glyphs holding the plate's text, fully shown. */
  private text(
    kind: PlateKind,
    text: Uint8Array,
    capacity: number,
    rect: TextRect,
  ): RScriptTextBlock {
    const block = new RScriptTextBlock(
      this.env.rasterizer,
      capacity,
      this.style(kind, rect.width, rect.height),
    );
    block.resize(rect.width, rect.height);
    block.append(text);
    block.finishReveal();
    block.show(true);
    return block;
  }

  /** Composites the text into a copy of each state image (0x413190). */
  private plate(plain: RScriptSurface[], block: RScriptTextBlock, rect: TextRect): Item {
    const states = plain.map((surface) => {
      const state = {...surface, data: surface.data.slice()};
      const clip = {left: 0, top: 0, right: state.width, bottom: state.height};
      block.draw(state, clip, rect.x - block.x, rect.y - block.y);
      return state;
    });
    const sprite = new PlateSprite(states, plain);
    sprite.setSurface(states[0]!);
    sprite.bakedText = block
      .shownGlyphs()
      .map((glyph) => ({...glyph, x: glyph.x + rect.x, y: glyph.y + rect.y}));
    return {sprite, states, final: {x: 0, y: 0}, start: {x: 0, y: 0}, end: {x: 0, y: 0}};
  }

  /** Builds the plate of `sel_{kind}NN` (0x4151F0, 0x412C30). */
  private async build(kind: PlateKind, source: Uint8Array): Promise<Item | null> {
    const {set, text} = imageSet(source);
    const path = `${this.env.systemDirectory}\\sel_${kind}${pad(set)}`;
    const lwg = await this.env.images.lwg(path);
    if (!lwg) return this.fallback(kind, text);
    // The `text` layer's placement and size give the text rectangle.
    const rect = lwg.find('text');
    const rectImage = rect ? await this.env.images.lwgLayer(path, 'text') : null;
    const textRect =
      rect && rectImage
        ? {x: rect.x, y: rect.y, width: rectImage.width, height: rectImage.height}
        : {
            x: Math.trunc((lwg.width - Math.trunc((80 * lwg.width) / 100)) / 2),
            y: Math.trunc((lwg.height - Math.trunc((90 * lwg.height) / 100)) / 2),
            width: Math.trunc((80 * lwg.width) / 100),
            height: Math.trunc((90 * lwg.height) / 100),
          };
    const plain: RScriptSurface[] = [];
    for (const name of kind === 'q' ? ['body'] : ['body', 'body_f', 'body_c']) {
      const entry = lwg.find(name);
      const body = entry ? await this.env.images.lwgLayer(path, name) : null;
      if (!entry || !body) continue;
      const surface = createSurface(lwg.width, lwg.height, 0xff000000);
      for (let y = 0; y < body.height; y++) {
        const row = y + entry.y;
        if (row < 0 || row >= surface.height) continue;
        for (let x = 0; x < body.width; x++) {
          const column = x + entry.x;
          if (column >= 0 && column < surface.width)
            surface.data[row * surface.width + column] = body.data[y * body.width + x]!;
        }
      }
      plain.push(surface);
    }
    if (!plain.length) return null;
    return this.plate(plain, this.text(kind, text, PLATE_GLYPHS, textRect), textRect);
  }

  /**
   * Without `sel_{kind}NN.lwg`, the plain `sel_q` or `sel_a` image takes the text in a fixed
   * area. An answer is left out when that image is missing too; the question keeps its text.
   */
  private async fallback(kind: PlateKind, text: Uint8Array): Promise<Item | null> {
    const image = await this.env.images.image(`${this.env.systemDirectory}\\sel_${kind}`);
    if (kind === 'a' && !image?.width) return null;
    const rect = FALLBACK_TEXT[kind];
    const surface = image ?? createSurface(rect.x + rect.width, rect.y + rect.height, 0xff000000);
    return this.plate([surface], this.text(kind, text, FALLBACK_GLYPHS, rect), rect);
  }

  /** sub_413BE0: builds the plates for `answers.length` answers and lays them out. */
  async open(
    question: Uint8Array,
    answers: readonly Uint8Array[],
    arrangement: number,
  ): Promise<void> {
    this.close();
    this.selected = 0;
    this.question = question.length ? await this.build('q', question) : null;
    this.answers = [];
    for (const answer of answers) {
      const item = await this.build('a', answer);
      if (item) this.answers.push(item);
    }
    if (this.question) this.add(this.question.sprite, 0);
    this.answers.forEach((item, i) => {
      const index = i + 1;
      item.sprite.onHover = (_, inside) => this.hover(item, inside);
      item.sprite.onPress = () => this.press(index);
      this.add(item.sprite, 3 - i);
    });
    this.layout(arrangement);
  }

  /** sub_4142C0 default branch and sub_414C40 start/end arrangements. */
  private layout(arrangement: number): void {
    const {width: W, height: H} = this.env;
    const q = this.question;
    const qHeight = q?.sprite.height ?? 0;
    let total = qHeight;
    for (const a of this.answers) total += a.sprite.height + 5;
    const qx = ((W - (q?.sprite.width ?? 0)) >> 1) - 30;
    const qy = Math.max(0, Math.trunc((80 * H) / 100) - total) >> 1;
    if (q) q.final = q.start = q.end = {x: qx, y: qy};
    let y = qHeight + qy + 5;
    for (const a of this.answers) {
      const x = (W - a.sprite.width) >> 1;
      a.final = {x, y};
      a.start = {x, y: qy};
      a.end = {x, y: H};
      y += a.sprite.height + 5;
    }
    const all = [...(q ? [q] : []), ...this.answers];
    switch (arrangement) {
      case 2: // from the top, out through the bottom
        for (const item of all) {
          item.start = {x: item.final.x, y: -item.sprite.height};
          item.end = {x: item.final.x, y: H};
        }
        break;
      case 3: // from the bottom, out through the top
        for (const item of all) {
          item.start = {x: item.final.x, y: H};
          item.end = {x: item.final.x, y: -item.sprite.height};
        }
        break;
      case 4: // from the left, out to the right
        for (const item of all) {
          item.start = {x: -item.sprite.width, y: item.final.y};
          item.end = {x: W, y: item.final.y};
        }
        break;
    }
  }

  private slide(
    item: Item,
    from: RScriptPoint,
    to: RScriptPoint,
    divisor: number,
    accelerate: boolean,
  ): void {
    const sprite = item.sprite;
    sprite.stopAnimation();
    sprite.setPosition(from.x, from.y);
    const distance = Math.trunc(Math.hypot(to.x - from.x, to.y - from.y));
    sprite.motion.curved(from, to, Math.trunc(distance / divisor), accelerate);
    sprite.animating = sprite.motion.active;
    if (!sprite.motion.active) sprite.setPosition(to.x, to.y);
  }

  /** sub_401700: shows the window, sliding the plates in unless `instant`. */
  appear(instant: boolean): void {
    this.show(true);
    const items = [...(this.question ? [this.question] : []), ...this.answers];
    for (const item of items) {
      item.sprite.show(true);
      if (instant) item.sprite.setPosition(item.final.x, item.final.y);
      else this.slide(item, item.start, item.final, 10, true);
    }
  }

  /** vtable +104: answers accept pointer input only while the script waits. */
  setInput(enabled: boolean): void {
    for (const item of this.answers) item.sprite.interactive = enabled;
    if (!enabled) for (const item of this.answers) this.hover(item, false);
  }

  /** sub_401B80: slides away everything but the chosen answer. */
  disappear(instant: boolean): void {
    const items = [...(this.question ? [this.question] : [])];
    this.answers.forEach((item, i) => {
      if (i !== this.selected - 1) items.push(item);
    });
    for (const item of items) {
      if (instant) item.sprite.show(false);
      else this.slide(item, item.sprite.position, item.end, 5, false);
    }
  }

  close(): void {
    for (const item of [...(this.question ? [this.question] : []), ...this.answers])
      this.remove(item.sprite);
    this.question = null;
    this.answers = [];
    this.show(false);
  }

  /** sub_413930: the focused answer shows its second image, or is inverted with only one. */
  private hover(item: Item, inside: boolean): void {
    if (item.states.length === 1) item.sprite.setBlendMode(inside ? 13 : 0);
    else item.sprite.setSurface(item.states[inside ? 1 : 0]!);
  }
  private press(index: number): void {
    const item = this.answers[index - 1];
    if (!item?.sprite.interactive) return;
    item.sprite.setSurface(item.states[2] ?? item.states[1] ?? item.states[0]!);
    this.selected = index;
    this.env.answered();
  }
}

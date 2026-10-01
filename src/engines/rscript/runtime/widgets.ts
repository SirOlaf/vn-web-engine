import type {LwgImage} from '../../../formats/rscript/lwg.js';
import type {RScriptSurface} from '../graphics/pixels.js';
import {RScriptContainer, RScriptSprite} from '../graphics/sprite.js';
import type {RScriptImages} from '../images.js';
import type {AnimationFrame} from './animation.js';

/** An LWG opened for a native screen, with helpers that place its named layers. */
export class ScreenImage {
  private constructor(
    private readonly images: RScriptImages,
    readonly path: string,
    readonly lwg: LwgImage,
  ) {}

  static async open(images: RScriptImages, path: string): Promise<ScreenImage | null> {
    const lwg = await images.lwg(path);
    return lwg ? new ScreenImage(images, path, lwg) : null;
  }
  get width(): number {
    return this.lwg.width;
  }
  get height(): number {
    return this.lwg.height;
  }
  /** Placement of a layer, or null when the image has none of that name. */
  position(name: string): {x: number; y: number} | null {
    const entry = this.lwg.find(name);
    return entry ? {x: entry.x, y: entry.y} : null;
  }
  /** A layer's rectangle, for layers that only mark an area. */
  async rect(name: string): Promise<{x: number; y: number; width: number; height: number} | null> {
    const at = this.position(name);
    const surface = await this.surface(name);
    return at && surface ? {...at, width: surface.width, height: surface.height} : null;
  }
  async surface(name: string): Promise<RScriptSurface | null> {
    return this.lwg.find(name) ? this.images.lwgLayer(this.path, name) : null;
  }
  /** A visible sprite for a layer at its placement. */
  async sprite(name: string): Promise<RScriptSprite | null> {
    const at = this.position(name);
    const surface = await this.surface(name);
    if (!at || !surface) return null;
    const sprite = new RScriptSprite();
    sprite.setSurface(surface);
    sprite.setPosition(at.x, at.y);
    sprite.show(true);
    return sprite;
  }
  /**
   * A button from `name` and whichever of `name_f`, `name_c`, `name_l` exist (0x449C00).
   * Each frame keeps its own placement relative to the first, so a focus image may add a
   * caption beside the button.
   */
  async button(name: string, press: () => void): Promise<ImageButton | null> {
    const at = this.position(name);
    if (!at) return null;
    const frames: ButtonFrame[] = [];
    for (const suffix of ['', '_f', '_c', '_l']) {
      const place = this.position(name + suffix);
      const surface = await this.surface(name + suffix);
      if (place && surface) frames.push({surface, dx: place.x - at.x, dy: place.y - at.y});
    }
    if (!frames.length) return null;
    const button = new ImageButton(frames);
    button.setPosition(at.x, at.y);
    button.onPress = press;
    button.interactive = true;
    button.show(true);
    return button;
  }
}

/**
 * Every layer of a layered image as a frame at its own placement (0x44E0E0). Playing steps
 * one frame per tick after `frameDelay` idle ticks (sub_44F0B0), holding the last frame or
 * starting over when looping (sub_44F090); stopping returns to the first (sub_44F160).
 */
export class FrameSprite extends RScriptSprite {
  private frames: readonly AnimationFrame[] = [];
  private index = 0;
  private baseX = 0;
  private baseY = 0;

  get frameCount(): number {
    return this.frames.length;
  }
  setFrames(frames: readonly AnimationFrame[], x: number, y: number): void {
    this.frames = frames;
    this.baseX = x;
    this.baseY = y;
    this.stop();
  }
  /** Moves the frames' origin. */
  place(x: number, y: number): void {
    this.baseX = x;
    this.baseY = y;
    this.setFrame(this.index);
  }
  private setFrame(index: number): void {
    this.index = index;
    const frame = this.frames[index];
    this.setSurface(frame?.surface ?? null);
    this.setPosition(this.baseX + (frame?.x ?? 0), this.baseY + (frame?.y ?? 0));
  }
  play(loop: boolean, frameDelay = 0): void {
    if (this.frames.length < 2) return;
    this.frameDelay = frameDelay;
    this.onStep = () => {
      const next = this.index + 1;
      if (next < this.frames.length) this.setFrame(next);
      else if (loop) this.setFrame(0);
      return loop || this.index + 1 < this.frames.length;
    };
    this.animating = true;
  }
  stop(): void {
    this.animating = false;
    this.onStep = null;
    this.setFrame(0);
  }
}

/** A button image and its offset from the button's first frame. */
interface ButtonFrame {
  readonly surface: RScriptSurface;
  readonly dx: number;
  readonly dy: number;
}

/**
 * Image button (0x4499F0) over the frames that exist in load order. The pointer shows the
 * second frame (0x44AB00) and selection in an option group the last (0x44A860); a single
 * frame is drawn inverted (blend mode 13) instead.
 */
export class ImageButton extends RScriptSprite {
  private inside = false;
  private chosen = false;
  /** Placement of the first frame; others are drawn at their offsets from it. */
  private baseX = 0;
  private baseY = 0;
  private frame: ButtonFrame;
  constructor(private readonly frames: readonly ButtonFrame[]) {
    super();
    this.frame = frames[0]!;
    this.setSurface(this.frame.surface);
    this.onHover = (_, inside) => {
      this.inside = inside;
      this.redraw();
    };
  }
  get selected(): boolean {
    return this.chosen;
  }
  set selected(selected: boolean) {
    this.chosen = selected;
    this.redraw();
  }
  override setPosition(x: number, y: number): void {
    this.baseX = x | 0;
    this.baseY = y | 0;
    super.setPosition(this.baseX + this.frame.dx, this.baseY + this.frame.dy);
  }
  override move(dx: number, dy: number): void {
    this.setPosition(this.baseX + dx, this.baseY + dy);
  }
  private redraw(): void {
    const {frames} = this;
    const lit = this.inside || this.chosen;
    if (frames.length === 1) {
      this.setBlendMode(lit ? 13 : 0);
      return;
    }
    this.frame = this.chosen ? frames.at(-1)! : this.inside ? frames[1]! : frames[0]!;
    this.setSurface(this.frame.surface);
    this.setPosition(this.baseX, this.baseY);
  }
  /** Leaves the focus image when input stops (vtable +148). */
  unfocus(): void {
    this.inside = false;
    this.redraw();
  }
}

/**
 * Option group (0x432600): one two-image button per option whose image exists, so absent
 * options shift the later indexes. The selected option keeps its focus image and ignores
 * input (0x432AC0).
 */
export class OptionGroup {
  readonly buttons: ImageButton[] = [];
  value = 0;

  private constructor(private readonly change: (value: number) => void) {}

  static async create(
    image: ScreenImage,
    names: readonly string[],
    change: (value: number) => void,
  ): Promise<OptionGroup> {
    const group = new OptionGroup(change);
    for (const name of names) {
      const index = group.buttons.length;
      const button = await image.button(name, () => group.choose(index));
      if (button) group.buttons.push(button);
    }
    return group;
  }
  /** `prefix_off` then `prefix_on` (0x4327A0). */
  static toggle(
    image: ScreenImage,
    prefix: string,
    change: (value: number) => void,
  ): Promise<OptionGroup> {
    return OptionGroup.create(image, [`${prefix}_off`, `${prefix}_on`], change);
  }

  private choose(index: number): void {
    this.set(index);
    this.change(index);
  }
  set(value: number): void {
    if (value < 0 || value >= this.buttons.length) return;
    this.value = value;
    this.buttons.forEach((button, i) => {
      button.selected = i === value;
      button.interactive = i !== value;
    });
  }
}

/**
 * State buttons (1.9 0x4561D0): one button per `<name>_<n>` layer, where pressing button
 * `n` selects state `n` (0x456780). `select` marks the selected button and ignores its input;
 * `cycle` hides it, so the button on show offers the other state (0x456670).
 */
export class StateButtons {
  readonly buttons: ImageButton[] = [];
  value = 0;
  private enabled = true;

  private constructor(
    private readonly mode: 'select' | 'cycle',
    private readonly change: (value: number) => void,
  ) {}

  static async create(
    image: ScreenImage,
    name: string,
    mode: 'select' | 'cycle',
    change: (value: number) => void,
  ): Promise<StateButtons> {
    const group = new StateButtons(mode, change);
    for (let state = 0; ; state++) {
      const button = await image.button(`${name}_${state}`, () => group.choose(state));
      if (!button) break;
      group.buttons.push(button);
    }
    return group;
  }

  private choose(state: number): void {
    this.set(state);
    this.change(state);
  }
  set(value: number): void {
    this.value = value;
    this.buttons.forEach((button, state) => {
      const selected = state === value;
      if (this.mode === 'select') button.selected = selected;
      else button.show(!selected);
      button.interactive = this.enabled && !selected;
    });
  }
  /** The panel's input switch (vtable +104 on the owning container). */
  setInput(enabled: boolean): void {
    this.enabled = enabled;
    this.set(this.value);
    if (!enabled) for (const button of this.buttons) button.unfocus();
  }
}

/**
 * Scroll bar (1.9 0x459860) from an LWG: `back`, the `range` rectangle, the draggable `hand`
 * knob and the `begin`, `prev`, `next` and `end` buttons. Positions `min`..`max` spread over
 * the range, which runs down when it is taller than wide; `reversed` reports positions from
 * the far end (+108). Moving to a new position reports it (the callback at +140).
 */
export class ScrollBar extends RScriptContainer {
  /** Current position (+88) and the position range (+96, +92). */
  position = 0;
  private min = 0;
  private max = 0;
  private readonly track = new RScriptSprite();
  private readonly buttons: ImageButton[] = [];

  private constructor(
    private readonly knob: ImageButton,
    private readonly range: {x: number; y: number; width: number; height: number},
    private readonly reversed: boolean,
    private readonly change: (value: number) => void,
  ) {
    super();
    this.track.setPosition(range.x, range.y);
    this.track.setSurface(createTrack(range.width, range.height));
    this.track.setBlendMode(23);
    this.track.onPress = (_, at) => this.jump(this.vertical ? at.y : at.x);
    this.track.show(true);
    this.add(this.track, 1);
    knob.onPress = null;
    knob.onDrag = (_, at) => {
      const offset = this.vertical
        ? knob.y - range.y + at.y - (knob.height >> 1)
        : knob.x - range.x + at.x - (knob.width >> 1);
      this.placeKnob(offset);
      this.dragged(offset);
    };
    this.add(knob, 1);
  }

  /** sub_45A000 / sub_459D10 */
  static async create(
    images: RScriptImages,
    path: string,
    reversed: boolean,
    change: (value: number) => void,
  ): Promise<ScrollBar | null> {
    const image = await ScreenImage.open(images, path);
    if (!image) return null;
    const range = await image.rect('range');
    const knob = await image.button('hand', () => {});
    if (!range || !knob) return null;
    const bar = new ScrollBar(knob, range, reversed, change);
    bar.resize(image.width, image.height);
    const back = await image.sprite('back');
    if (back) bar.add(back, 0);
    const actions: [string, () => void][] = [
      ['begin', () => bar.first()],
      ['end', () => bar.last()],
      ['prev', () => bar.previous()],
      ['next', () => bar.next()],
    ];
    for (const [name, press] of actions) {
      const button = await image.button(name, press);
      if (!button) continue;
      bar.buttons.push(button);
      bar.add(button, 1);
    }
    bar.setInput(false);
    return bar;
  }

  private get vertical(): boolean {
    return this.range.height > this.range.width;
  }
  /** The knob's travel in pixels (+100). */
  private get travel(): number {
    return Math.max(1, this.vertical ? this.range.height : this.range.width);
  }
  /** Pixels per position. */
  private get spacing(): number {
    return Math.trunc((this.travel - this.min + this.max - 1) / (this.max - this.min));
  }
  private report(): void {
    this.change(this.reversed ? this.max - this.position : this.position);
  }
  private placeKnob(offset: number): void {
    const at = Math.max(0, Math.min(this.travel, offset));
    if (this.vertical) this.knob.setPosition(this.range.x, this.range.y + at);
    else this.knob.setPosition(this.range.x + at, this.range.y);
  }
  /** sub_45A140: the knob moved to `offset`. */
  private dragged(offset: number): void {
    const at = Math.max(0, Math.min(this.travel, offset));
    const position = this.min + Math.trunc((at * (this.max - this.min)) / this.travel);
    if (position === this.position) return;
    this.position = position;
    this.report();
  }
  /** Moves the knob as a drag would (sub_44CF40 with notification). */
  private dragTo(offset: number): void {
    this.placeKnob(offset);
    this.dragged(offset);
  }

  /** Sets the position range. */
  setRange(min: number, max: number): void {
    this.min = min;
    this.max = max;
  }
  /** sub_45A0D0: places the knob for `value` without reporting it. */
  set(value: number): void {
    if (this.max === this.min || value > this.max || value < this.min) return;
    this.position = this.reversed ? this.max - value : value;
    this.placeKnob((this.position - this.min) * this.spacing);
  }
  /** sub_45A1D0: a press on the range. */
  private jump(offset: number): void {
    if (this.max === this.min) return;
    const target = Math.trunc((offset * (this.max - this.min)) / this.travel);
    this.dragTo((target - this.min) * this.spacing);
  }
  /** sub_45A250 and sub_45A270 */
  first(): void {
    this.dragTo(0);
  }
  last(): void {
    this.dragTo(this.travel);
  }
  /** sub_45A2A0: one position back. */
  previous(): void {
    if (this.max === this.min) return;
    if (this.position === this.min) return this.first();
    this.placeKnob((this.position - this.min - 1) * this.spacing);
    this.position--;
    this.report();
  }
  /** sub_45A360: one position on. */
  next(): void {
    if (this.max === this.min) return;
    if (this.position === this.max) return this.last();
    this.placeKnob((this.position - this.min + 1) * this.spacing);
    this.position++;
    this.report();
  }
  /** vtable +104: the bar's buttons and knob accept input. */
  setInput(enabled: boolean): void {
    for (const node of [...this.buttons, this.knob]) {
      node.interactive = enabled;
      if (!enabled) node.unfocus();
    }
    this.track.interactive = enabled;
  }
}

/**
 * Slider (0x4517E0): the knob travels across the level rectangle, which is only a marker,
 * for values 0..`max`; pressing or dragging on the rectangle sets the value (0x451B20).
 * A rectangle taller than it is wide makes a vertical slider (the panel's +224 flag).
 */
export class Slider {
  readonly knob: ImageButton;
  /** Invisible hit area over the track. */
  readonly track = new RScriptSprite();
  private readonly rect: {x: number; y: number; width: number; height: number};
  private readonly vertical: boolean;
  value = 0;

  private constructor(
    knob: ImageButton,
    rect: {x: number; y: number; width: number; height: number},
    private readonly max: number,
    private readonly change: (value: number) => void,
  ) {
    this.knob = knob;
    this.rect = rect;
    this.vertical = rect.height > rect.width;
    this.knob.interactive = false;
    this.track.setPosition(rect.x, rect.y);
    this.track.setSurface(
      this.vertical
        ? createTrack(Math.max(rect.width, knob.width), rect.height)
        : createTrack(rect.width, Math.max(rect.height, knob.height)),
    );
    // Blend mode 23 draws nothing; the sprite only receives the pointer.
    this.track.setBlendMode(23);
    this.track.interactive = true;
    this.track.onPress = (_, at) => this.drag(at);
    this.track.onDrag = (_, at) => this.drag(at);
    this.track.show(true);
  }

  /** The `level` rectangle and the `knob` button (0x4519C0) with its focus frames. */
  static async create(
    image: ScreenImage,
    level: string,
    knobName: string,
    max: number,
    change: (value: number) => void,
  ): Promise<Slider | null> {
    const rect = await image.rect(level);
    const knob = await image.button(knobName, () => {});
    if (!rect || !knob) return null;
    return new Slider(knob, rect, max, change);
  }

  private get travel(): number {
    return Math.max(
      1,
      this.vertical ? this.rect.height - this.knob.height : this.rect.width - this.knob.width,
    );
  }
  private drag(at: {x: number; y: number}): void {
    const offset = this.vertical ? at.y - (this.knob.height >> 1) : at.x - (this.knob.width >> 1);
    this.set(Math.round((offset * this.max) / this.travel));
    this.change(this.value);
  }
  set(value: number): void {
    this.value = Math.max(0, Math.min(this.max, value));
    const offset = Math.trunc((this.value * this.travel) / this.max);
    if (this.vertical) this.knob.setPosition(this.rect.x, this.rect.y + offset);
    else this.knob.setPosition(this.rect.x + offset, this.rect.y);
  }
}

function createTrack(width: number, height: number): RScriptSurface {
  return {width, height, data: new Uint32Array(width * height)};
}

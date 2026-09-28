import type {LwgImage} from '../../../formats/rscript/lwg.js';
import type {RScriptSurface} from '../graphics/pixels.js';
import {RScriptSprite} from '../graphics/sprite.js';
import type {RScriptImages} from '../images.js';

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
  /** A two-image button from `name` and `name_f` (0x4499F0 +4). */
  async button(name: string, press: () => void): Promise<ImageButton | null> {
    const at = this.position(name);
    const normal = await this.surface(name);
    if (!at || !normal) return null;
    const button = new ImageButton(normal, await this.surface(`${name}_f`));
    button.setPosition(at.x, at.y);
    button.onPress = press;
    button.interactive = true;
    button.show(true);
    return button;
  }
}

/**
 * Two-image button (0x4499F0): the normal image, or the focus image under the pointer or
 * while selected in an option group.
 */
export class ImageButton extends RScriptSprite {
  private inside = false;
  private chosen = false;
  constructor(
    private readonly normal: RScriptSurface,
    private readonly focus: RScriptSurface | null,
  ) {
    super();
    this.setSurface(normal);
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
  private redraw(): void {
    this.setSurface((this.inside || this.chosen) && this.focus ? this.focus : this.normal);
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
 * Slider (0x4517E0): the `name_vol` knob travels across the `name_lev` rectangle for
 * values 0..`max`; pressing or dragging on the rectangle sets the value (0x451B20).
 */
export class Slider {
  readonly knob: ImageButton;
  /** Invisible hit area over the track. */
  readonly track = new RScriptSprite();
  private readonly rect: {x: number; y: number; width: number; height: number};
  value = 0;

  private constructor(
    knob: ImageButton,
    rect: {x: number; y: number; width: number; height: number},
    private readonly max: number,
    private readonly change: (value: number) => void,
  ) {
    this.knob = knob;
    this.rect = rect;
    this.knob.interactive = false;
    this.track.setPosition(rect.x, rect.y);
    this.track.setSurface(createTrack(rect.width, Math.max(rect.height, knob.height)));
    // Blend mode 23 draws nothing; the sprite only receives the pointer.
    this.track.setBlendMode(23);
    this.track.interactive = true;
    this.track.onPress = (_, at) => this.drag(at.x);
    this.track.onDrag = (_, at) => this.drag(at.x);
    this.track.show(true);
  }

  static async create(
    image: ScreenImage,
    name: string,
    max: number,
    change: (value: number) => void,
  ): Promise<Slider | null> {
    const at = image.position(`${name}_lev`);
    const level = await image.surface(`${name}_lev`);
    const knob = await image.button(`${name}_vol`, () => {});
    if (!at || !level || !knob) return null;
    return new Slider(knob, {...at, width: level.width, height: level.height}, max, change);
  }

  private get travel(): number {
    return Math.max(1, this.rect.width - this.knob.width);
  }
  private drag(x: number): void {
    const value = Math.round(((x - (this.knob.width >> 1)) * this.max) / this.travel);
    this.set(value);
    this.change(this.value);
  }
  set(value: number): void {
    this.value = Math.max(0, Math.min(this.max, value));
    this.knob.setPosition(
      this.rect.x + Math.trunc((this.value * this.travel) / this.max),
      this.rect.y,
    );
  }
}

function createTrack(width: number, height: number): RScriptSurface {
  return {width, height, data: new Uint32Array(width * height)};
}

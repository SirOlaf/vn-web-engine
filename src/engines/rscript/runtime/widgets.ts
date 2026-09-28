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

/** Two-image button (0x4499F0): the normal image, or the focus image under the pointer. */
export class ImageButton extends RScriptSprite {
  constructor(
    private readonly normal: RScriptSurface,
    private readonly focus: RScriptSurface | null,
  ) {
    super();
    this.setSurface(normal);
    this.onHover = (_, inside) => this.setSurface(inside && this.focus ? this.focus : this.normal);
  }
  /** Leaves the focus image when input stops (vtable +148). */
  unfocus(): void {
    this.setSurface(this.normal);
  }
}

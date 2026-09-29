import {decodeCp932} from '../text.js';
import {LayerRecord, Scene, type RScriptMemory} from '../memory.js';
import type {RScriptImages} from '../images.js';
import {filterLayerImage} from '../graphics/filters.js';
import {createSurface, type RScriptSurface} from '../graphics/pixels.js';
import {RScriptContainer, RScriptSprite, type RScriptPoint} from '../graphics/sprite.js';
import {FramePlayer, type AnimationFrame, type FrameAnimation} from './animation.js';

export interface LayerEnvironment {
  readonly memory: RScriptMemory;
  readonly images: RScriptImages;
  readonly width: number;
  readonly height: number;
  /** Renders a text layer (layer source 2) with the given glyph size. */
  renderText(text: Uint8Array, size: number): Promise<RScriptSurface>;
  /** Pointer callbacks for button layers, by button mode (sub_41EE50/0x41EEC0/0x41EFD0). */
  buttonPressed(layer: RScriptLayer, mode: number, id: number): void;
  /** Frames and frame script of an animated (kind 2) layer image. */
  animation(path: string): Promise<FrameAnimation | null>;
  /** Script variables and the C runtime random generator read by frame scripts. */
  variable(index: number): number;
  random(): number;
  diagnostic(message: string): void;
}

/** Source kinds in record +10. */
const enum LayerSource {
  Numbered = 0,
  Named = 1,
  Text = 2,
  Fill = 3,
}

/** Layer kinds in record +8 (sub_406690). */
const enum LayerKind {
  Plain = 0,
  Filtered = 1,
  Animated = 2,
}

/**
 * Hover image slot 2 (0x44E0E0): every layer of a layered image as a frame at its own
 * placement. Hovering plays the frames once and holds the last (0x40B070, sub_44F0B0);
 * stopping returns to the first (sub_44F160).
 */
class OverlayFrames extends RScriptSprite {
  private frames: readonly AnimationFrame[] = [];
  private index = 0;
  private baseX = 0;
  private baseY = 0;

  setFrames(frames: readonly AnimationFrame[], x: number, y: number): void {
    this.frames = frames;
    this.baseX = x;
    this.baseY = y;
    this.stop();
  }
  private setFrame(index: number): void {
    this.index = index;
    const frame = this.frames[index];
    this.setSurface(frame?.surface ?? null);
    this.setPosition(this.baseX + (frame?.x ?? 0), this.baseY + (frame?.y ?? 0));
  }
  /** sub_44F090 without looping, with the hover's one-tick frame delay. */
  play(): void {
    if (this.frames.length < 2) return;
    this.frameDelay = 1;
    this.onStep = () => {
      if (this.index + 1 < this.frames.length) this.setFrame(this.index + 1);
      return this.index + 1 < this.frames.length;
    };
    this.animating = true;
  }
  stop(): void {
    this.animating = false;
    this.onStep = null;
    this.setFrame(0);
  }
}

/**
 * One of the hundred script layers (0x4061E0). Its state lives in the scene record so that
 * saves and nested calls restore it (0x407480); the sprites here are the visible objects.
 * Kind 2 layers play LWG frames sequenced by an FSC script; kinds 0 and 1 apply the colour
 * effect named by the load flags. Kind 1 also mirrors and scales in the native engine,
 * which the supported titles do not use.
 */
export class RScriptLayer extends RScriptContainer {
  readonly main = new RScriptSprite();
  /** Crossfade source and hover images for button slots 0 and 1 (+92, +96). */
  readonly under = [new RScriptSprite(), new RScriptSprite()] as const;
  /** Hover image slot 2 (+100). */
  readonly special = new OverlayFrames();
  private loadGeneration = 0;
  private player: FramePlayer | null = null;

  constructor(
    readonly index: number,
    private readonly env: LayerEnvironment,
  ) {
    super(env.width, env.height);
    this.add(this.under[0], 0);
    this.add(this.under[1], 0);
    this.add(this.special, 0);
    this.add(this.main, 1);
    this.main.onPress = () => this.pressed();
    // sub_442B90 ignores disabled sprites, so a button disabled by its press keeps its hover
    // images when the pointer leaves (sub_442D00 clears only the hover flag).
    this.main.onHover = (_, inside) => {
      if (inside) this.hoverIn();
      else if (this.main.interactive) this.hoverOut();
    };
  }

  get record(): number {
    return Scene.layers + this.index * Scene.layerStride;
  }
  private word(field: number): number {
    return this.env.memory.sceneWord(this.record + field);
  }
  private uword(field: number): number {
    return this.env.memory.sceneUword(this.record + field);
  }
  private setWord(field: number, value: number): void {
    this.env.memory.setSceneWord(this.record + field, value);
  }
  private dword(field: number): number {
    return this.env.memory.sceneDword(this.record + field);
  }
  private setDword(field: number, value: number): void {
    this.env.memory.setSceneDword(this.record + field, value);
  }
  get directory(): string {
    const bytes = this.env.memory.sceneString(this.record + LayerRecord.directory, 23);
    return decodeCp932(bytes);
  }
  private imagePath(image: number): string {
    return `${this.directory}\\${String(image).padStart(4, '0')}`;
  }

  /** sub_4069C0: resource directory for numbered images. */
  setDirectory(directory: Uint8Array): void {
    this.env.memory.setSceneString(this.record + LayerRecord.directory, 23, directory);
  }
  /** sub_406A20: anchors and edge clamping. */
  setAnchors(centerX: number, centerY: number, keepOnScreen: number): void {
    this.setDword(LayerRecord.centerX, centerX);
    this.setDword(LayerRecord.centerY, centerY);
    this.setDword(LayerRecord.keepOnScreen, keepOnScreen);
  }
  setFontSize(size: number): void {
    this.setWord(LayerRecord.priority, size);
  }
  setClip(flip: number, scaleX: number, scaleY: number, mask: number): void {
    this.setWord(LayerRecord.clip, flip);
    this.setWord(LayerRecord.clip + 2, scaleX);
    this.setWord(LayerRecord.clip + 4, scaleY);
    this.setWord(LayerRecord.clip + 6, mask);
  }

  /** sub_4071A0 / sub_407A50 placement: anchors and edge clamping for a sprite size. */
  private place(x: number, y: number, sprite: RScriptSprite = this.main): RScriptPoint {
    if (this.dword(LayerRecord.centerX)) x -= sprite.width >>> 1;
    if (this.dword(LayerRecord.centerY)) y -= sprite.height >>> 1;
    if (this.dword(LayerRecord.keepOnScreen)) {
      x = Math.max(0, x);
      y = Math.max(0, y);
      if (x + sprite.width > this.env.width) x = this.env.width - sprite.width;
      if (y + sprite.height > this.env.height) y = this.env.height - sprite.height;
    }
    return {x, y};
  }

  /** sub_4070E0 slot 2: the frames of `<image>.lwg`, or a single image. */
  private async loadSpecial(image: number, x: number, y: number): Promise<void> {
    if (!image) return this.special.setFrames([], x, y);
    const path = this.imagePath(image);
    const animation = await this.env.animation(path);
    if (animation?.frames.length) {
      this.special.setFrames(animation.frames, x, y);
      return;
    }
    const surface = await this.fetch(image);
    this.special.setFrames(surface ? [{surface, x: 0, y: 0}] : [], x, y);
  }

  private async fetch(image: number): Promise<RScriptSurface | null> {
    const surface = await this.env.images.image(this.imagePath(image));
    if (!surface) this.env.diagnostic(`missing image ${this.imagePath(image)}`);
    return surface;
  }

  /** Loads the record's current source into the main sprite (0x40AA30, 0x40AB50, 0x40ABA0). */
  private async loadSource(): Promise<boolean> {
    const generation = ++this.loadGeneration;
    const source = this.uword(LayerRecord.source);
    let surface: RScriptSurface | null = null,
      player: FramePlayer | null = null;
    if (source === LayerSource.Fill) {
      surface = createSurface(
        this.env.width,
        this.env.height,
        // sub_40CC60 fills through sub_442390, which takes a raw 0xRRGGBB pixel.
        this.dword(LayerRecord.color) & 0xffffff,
      );
    } else if (source === LayerSource.Text) {
      const text = this.env.memory.sceneString(this.record + LayerRecord.name, 81);
      surface = await this.env.renderText(text, this.uword(LayerRecord.priority) || 30);
    } else {
      const image = this.uword(LayerRecord.image);
      if (image && this.uword(LayerRecord.kind) === LayerKind.Animated) {
        const animation = await this.env.animation(this.imagePath(image));
        if (generation !== this.loadGeneration) return false;
        if (!animation) this.env.diagnostic(`missing animation ${this.imagePath(image)}`);
        player = animation ? new FramePlayer(animation) : null;
        surface = animation?.frames[0]?.surface ?? null;
      } else if (image) {
        surface = await this.fetch(image);
        // sub_40C870 / sub_40C2F0: kinds 0 and 1 filter the image by its load flags.
        if (surface) surface = filterLayerImage(surface, this.uword(LayerRecord.loadFlags));
      }
    }
    if (generation !== this.loadGeneration) return false;
    this.player = player;
    this.main.stopAnimation();
    this.main.setSurface(surface);
    this.applyBlend();
    return surface !== null;
  }

  /** sub_40A270: keeps the outgoing image in slot 0 for crossfades. */
  private keepPrevious(): void {
    const previous = this.under[0];
    previous.stopAnimation();
    if (this.main.visible && this.main.surface) {
      previous.setSurface(this.main.surface);
      previous.setPosition(this.main.x, this.main.y);
    }
    previous.show(false);
  }

  /** sub_406C20: numbered image, effect, position and load flags. */
  async load(
    image: number,
    effect: number,
    x: number,
    y: number,
    flags: number,
    skipping: boolean,
  ): Promise<void> {
    this.stopButton(true, skipping);
    this.setWord(LayerRecord.image, image);
    this.setWord(LayerRecord.source, LayerSource.Numbered);
    this.setDword(LayerRecord.x, x);
    this.setDword(LayerRecord.y, y);
    this.setWord(LayerRecord.loadFlags, flags);
    this.setWord(LayerRecord.pattern, 0);
    if (skipping) return;
    const previousVisible = this.main.visible;
    const previousSurface = this.main.surface;
    const previousPosition = this.main.position;
    if (!(await this.loadSource())) return;
    if (previousVisible && previousSurface) {
      this.under[0].setSurface(previousSurface);
      this.under[0].setPosition(previousPosition.x, previousPosition.y);
    }
    this.under[0].show(false);
    this.appear(effect, x, y, previousVisible);
  }

  /** sub_406CF0: numbered image placed at the anchor-adjusted origin. */
  async loadAtOrigin(
    image: number,
    effect: number,
    flags: number,
    skipping: boolean,
  ): Promise<void> {
    this.stopButton(true, skipping);
    this.setWord(LayerRecord.image, image);
    this.setWord(LayerRecord.source, LayerSource.Numbered);
    this.setWord(LayerRecord.loadFlags, flags);
    this.setWord(LayerRecord.pattern, 0);
    if (skipping) return;
    const previousVisible = this.main.visible;
    this.keepPrevious();
    if (!(await this.loadSource())) return;
    let {x, y} = this.main.position;
    if (this.dword(LayerRecord.centerX)) x += this.main.width >>> 1;
    if (this.dword(LayerRecord.centerY)) y += this.main.height >>> 1;
    this.appear(effect, x, y, previousVisible);
  }

  /** sub_406E20: text layer rendered from a script string. */
  async loadText(
    text: Uint8Array,
    effect: number,
    x: number,
    y: number,
    skipping: boolean,
  ): Promise<void> {
    this.stopButton(true, skipping);
    this.setWord(LayerRecord.image, 0);
    this.setWord(LayerRecord.source, LayerSource.Text);
    this.setDword(LayerRecord.x, x);
    this.setDword(LayerRecord.y, y);
    this.env.memory.setSceneString(this.record + LayerRecord.name, 81, text);
    this.setWord(LayerRecord.pattern, 0);
    if (skipping) return;
    const previousVisible = this.main.visible;
    this.keepPrevious();
    if (await this.loadSource()) this.appear(effect, x, y, previousVisible);
  }

  /** sub_406F20: full-screen colour, as 0xRRGGBB. */
  async fill(color: number, skipping: boolean): Promise<void> {
    this.stopButton(true, skipping);
    this.setWord(LayerRecord.image, 0);
    this.setWord(LayerRecord.source, LayerSource.Fill);
    this.setDword(LayerRecord.color, color);
    this.setWord(LayerRecord.pattern, 0);
    if (skipping) return;
    if (await this.loadSource()) this.appear(0, 0, 0, false);
  }

  /** sub_407A50: shows the main sprite with one of the native entrance effects. */
  private appear(effect: number, x: number, y: number, hadImage: boolean): void {
    const main = this.main;
    const target = this.place(x, y);
    main.stopAnimation();
    const slide = (from: RScriptPoint, distance: number, eased = true): void => {
      main.setPosition(from.x, from.y);
      main.motion.curved(from, target, Math.trunc((distance & 0xffff) / 15), eased);
    };
    const W = this.env.width,
      H = this.env.height;
    const fade = (mode: number, step: number): void => {
      main.setPosition(target.x, target.y);
      main.startFade(mode, 0, step);
    };
    switch (effect) {
      case 2:
        if (hadImage) {
          this.under[0].show(true);
          this.under[0].startFade(2, 1, 32);
          this.under[0].animating = true;
        }
        fade(2, 32);
        break;
      case 3:
        fade(2, 32);
        break;
      case 4:
        fade(0x12, 32);
        break;
      case 5:
        fade(4, 32);
        break;
      case 6:
        fade(3, 32);
        break;
      case 7:
        slide({x: -main.width, y: target.y}, target.x + main.width);
        break;
      case 8:
        slide({x: W, y: target.y}, W - target.x);
        break;
      case 9:
        slide({x: target.x, y: -main.height}, target.y + main.height);
        break;
      case 10:
        slide({x: target.x, y: H}, H - target.y);
        break;
      case 11:
        slide(
          {x: -main.width, y: -main.height},
          Math.trunc(Math.hypot(target.x + main.width, target.y + main.height)),
        );
        break;
      case 12:
        slide(
          {x: W, y: -main.height},
          Math.trunc(Math.hypot(W - target.x, target.y + main.height)),
        );
        break;
      case 13:
        slide({x: -main.width, y: H}, Math.trunc(Math.hypot(target.x + main.width, H - target.y)));
        break;
      case 14:
        slide({x: W, y: H}, Math.trunc(Math.hypot(W - target.x, H - target.y)));
        break;
      case 15:
        fade(4, 16);
        break;
      case 16:
        fade(2, 24);
        break;
      case 17:
        fade(0x14, 16);
        break;
      case 18:
        fade(0x15, 16);
        break;
      case 19:
        fade(2, 8);
        break;
      case 20:
        main.setPosition(target.x, target.y - 150);
        main.startFade(2, 0, 8);
        main.motion.linear(main.position, target, 5);
        break;
      case 21:
      case 22:
      case 23: {
        const from =
          effect === 21
            ? {x: target.x, y: target.y + 150}
            : effect === 22
              ? {x: target.x - 150, y: target.y}
              : {x: target.x + 150, y: target.y};
        main.setPosition(from.x, from.y);
        main.startFade(2, 0, 16);
        main.motion.linear(from, target, 10);
        break;
      }
      default:
        if (effect > 28) this.env.diagnostic(`unknown layer entrance effect ${effect}`);
        main.setPosition(target.x, target.y);
    }
    main.show(true);
    main.animating = effect !== 0;
  }

  /** sub_406EC0 → sub_4087B0: clears the image with an exit effect. */
  hide(effect: number, skipping: boolean): void {
    const image = this.uword(LayerRecord.image),
      source = this.uword(LayerRecord.source);
    if (!image && !source) return;
    this.setWord(LayerRecord.image, 0);
    this.setWord(LayerRecord.source, 0);
    this.setWord(LayerRecord.pattern, 0);
    this.stopButton(true, skipping);
    if (skipping) return;
    this.loadGeneration++;
    this.player = null;
    const main = this.main;
    if (!main.visible) return;
    main.stopAnimation();
    const W = this.env.width,
      H = this.env.height;
    const slide = (to: RScriptPoint, distance: number): void => {
      main.motion.curved(main.position, to, Math.trunc((distance & 0xffff) / 15), true);
      main.animating = true;
    };
    const fadeOut = (mode: number, step: number): void => {
      main.startFade(mode, 1, step);
      main.animating = true;
    };
    const {x, y} = main.position;
    switch (effect) {
      case 3:
        return fadeOut(2, 32);
      case 4:
        return fadeOut(0x12, 32);
      case 5:
        return fadeOut(4, 32);
      case 6:
        return fadeOut(3, 32);
      case 7:
        return slide({x: -main.width, y}, x + main.width);
      case 8:
        return slide({x: W, y}, W - x);
      case 9:
        return slide({x, y: -main.height}, y + main.height);
      case 10:
        return slide({x, y: H}, H - y);
      case 11:
        return slide(
          {x: -main.width, y: -main.height},
          Math.trunc(Math.hypot(x + main.width, y + main.height)),
        );
      case 12:
        return slide({x: W, y: -main.height}, Math.trunc(Math.hypot(W - x, y + main.height)));
      case 13:
        return slide({x: -main.width, y: H}, Math.trunc(Math.hypot(x + main.width, H - y)));
      case 14:
        return slide({x: W, y: H}, Math.trunc(Math.hypot(W - x, H - y)));
      case 15:
        return fadeOut(4, 16);
      case 16:
        return fadeOut(2, 24);
      case 17:
        return fadeOut(0x14, 16);
      case 18:
        return fadeOut(0x15, 16);
      case 19:
        return fadeOut(2, 8);
      case 20:
      case 21:
      case 22:
      case 23: {
        const to =
          effect === 20
            ? {x, y: y - 150}
            : effect === 21
              ? {x, y: y + 150}
              : effect === 22
                ? {x: x - 150, y}
                : {x: x + 150, y};
        main.startFade(2, 1, 16);
        main.motion.linear(main.position, to, 10);
        main.animating = true;
        return;
      }
      default:
        if (effect > 35) this.env.diagnostic(`unknown layer exit effect ${effect}`);
        main.show(false);
    }
  }

  /** sub_406A90 → sub_4097F0: moves the main sprite. Effects ≥ 7 are skipped when fast. */
  moveTo(effect: number, x: number, y: number, speed: number, skipping: boolean): void {
    const kind = effect % 100;
    const hasImage = this.uword(LayerRecord.image) || this.uword(LayerRecord.source);
    if (hasImage && kind < 7) {
      this.setDword(LayerRecord.x, x);
      this.setDword(LayerRecord.y, y);
    }
    if (skipping) return;
    const main = this.main;
    const target = this.place(x, y);
    const distance = Math.trunc(Math.hypot(main.x - target.x, main.y - target.y));
    // The native passes distance / ticks as the per-tick speed of the motion.
    const pace = Math.trunc(distance / (speed || 15)) || 1;
    main.motion.finish(main);
    switch (kind) {
      case 0:
        main.setPosition(target.x, target.y);
        return;
      case 1:
        main.motion.linear(main.position, target, pace);
        break;
      case 2:
        main.motion.curved(main.position, target, pace, false);
        break;
      case 3:
        main.motion.curved(main.position, target, pace, true);
        break;
      case 4:
        main.motion.arc(main.position, target, pace, 2, 3);
        break;
      case 5:
      case 6:
        main.motion.swing(main.position, target, pace, kind === 5);
        break;
      case 7:
      case 9:
        main.motion.bounce(main.position, 5, 30, 25, kind === 9 ? 1 : 0);
        break;
      case 8:
      case 10:
        main.motion.bounce(main.position, 5, 5, 4, kind === 10 ? 1 : 0);
        break;
      case 11:
        main.motion.hop(main.position, 40, 10);
        break;
      case 12:
        main.motion.hop(main.position, 100, 10);
        break;
      case 13:
        main.motion.hop(main.position, 300, 20);
        break;
      default:
        return;
    }
    main.animating = true;
  }

  /** sub_406B50: visibility flag of the whole layer. */
  setVisible(visible: number, skipping: boolean): void {
    this.setDword(LayerRecord.visible, visible & 0xffff);
    if (!skipping) this.show(!!visible);
  }

  /** sub_406B90 → sub_40A100: blend presets with a percentage level. */
  setBlend(mode: number, percent: number, skipping: boolean): void {
    this.setWord(LayerRecord.blendMode, mode);
    this.setWord(LayerRecord.blendValue, percent);
    if (!skipping) this.applyBlend();
  }
  private applyBlend(): void {
    const preset = this.word(LayerRecord.blendMode);
    const mode =
      preset === 1
        ? 2
        : preset === 2
          ? 14
          : preset === 3
            ? 104
            : preset === 4
              ? 3
              : preset === 5
                ? 4
                : 0;
    if (this.main.fade.active) return;
    this.main.setBlendMode(mode);
    this.main.setAlpha(Math.trunc((255 * this.uword(LayerRecord.blendValue)) / 100));
  }

  /** sub_406690: changes the layer kind; the next load uses the new sprite class. */
  setKind(kind: number, skipping: boolean): void {
    this.hide(0, skipping);
    this.setWord(LayerRecord.kind, kind);
  }

  // Buttons (0x406F90, 0x407000, 0x407070, 0x407210, 0x4070E0).
  setButton(
    mode: number,
    hoverStyle: number,
    id: number,
    keepHover: number,
    skipping: boolean,
  ): void {
    this.setDword(LayerRecord.animating, 1);
    this.setWord(LayerRecord.animationSpeed, hoverStyle);
    this.setWord(LayerRecord.animationFrames, id);
    this.setWord(LayerRecord.animationMode, mode);
    this.setWord(LayerRecord.animationStep, keepHover);
    if (!skipping) this.main.interactive = true;
  }
  /** sub_407210: disables the button (mode-2 buttons only when `all`). */
  stopButton(all: boolean, skipping: boolean): void {
    if (!this.dword(LayerRecord.animating)) return;
    if (!all && this.uword(LayerRecord.animationMode) === 2) return;
    this.setDword(LayerRecord.animating, 0);
    for (const slot of [0, 1, 2]) this.setWord(LayerRecord.overlays + slot * 2, 0);
    if (skipping) return;
    this.main.interactive = false;
    this.hoverOut();
    for (const sprite of [...this.under, this.special]) sprite.show(false);
    this.special.stop();
  }
  /** Enables or suspends button input while the script waits (sub_407310/sub_407360). */
  setButtonInput(enabled: boolean, onlyInterrupts: boolean): void {
    if (!this.dword(LayerRecord.animating)) return;
    if (onlyInterrupts && this.uword(LayerRecord.animationMode) !== 2) return;
    this.main.interactive = enabled;
  }
  async setOverlay(
    slot: number,
    image: number,
    x: number,
    y: number,
    skipping: boolean,
  ): Promise<void> {
    if (slot > 2) return;
    this.setWord(LayerRecord.overlays + slot * 2, image);
    this.setDword(LayerRecord.overlayPositions + slot * 8, x);
    this.setDword(LayerRecord.overlayPositions + slot * 8 + 4, y);
    if (skipping) return;
    if (slot === 2) {
      await this.loadSpecial(image, x, y);
      this.special.show(false);
      return;
    }
    const sprite = this.under[slot]!;
    sprite.setSurface(image ? await this.fetch(image) : null);
    sprite.setPosition(x, y);
    sprite.show(false);
  }
  private hoverIn(): void {
    const style = this.uword(LayerRecord.animationSpeed);
    if (style === 1) this.main.setBlendMode(13);
    else if (style === 2) {
      this.main.setBlendMode(4);
      this.main.setAlpha(64);
    } else if (style === 3) this.main.setBlendMode(23);
    for (const slot of [0, 1] as const)
      if (this.uword(LayerRecord.overlays + slot * 2)) this.under[slot].show(true);
    if (this.uword(LayerRecord.overlays + 4)) {
      this.special.show(true);
      this.special.play();
    }
  }
  private hoverOut(): void {
    this.applyBlend();
    for (const slot of [0, 1] as const)
      if (this.uword(LayerRecord.overlays + slot * 2)) this.under[slot].show(false);
    if (this.uword(LayerRecord.overlays + 4)) {
      this.special.show(false);
      this.special.stop();
    }
  }
  private pressed(): void {
    this.applyBlend();
    if (!this.uword(LayerRecord.animationStep)) this.under[1].show(false);
    this.env.buttonPressed(
      this,
      this.uword(LayerRecord.animationMode),
      this.word(LayerRecord.animationFrames),
    );
  }

  /** sub_40AC40 → sub_40AF10: advances an animated layer by one scene tick. */
  /** sub_40AF10: the frame script and the hover image slot 2 advance each tick. */
  tick(): void {
    if (this.visible) this.special.animate();
    const player = this.player;
    if (!player || !this.visible || !this.main.visible) return;
    const previous = player.frame;
    if (
      !player.step(
        (index) => this.env.variable(index),
        () => this.env.random(),
      )
    )
      return;
    const frames = player.animation.frames;
    const from = frames[previous],
      to = frames[player.frame];
    if (player.frame === previous || !to) return;
    this.main.setSurface(to.surface);
    this.main.move(to.x - (from?.x ?? 0), to.y - (from?.y ?? 0));
  }

  /** sub_407480: rebuilds the visible layer from its record after a load or a skip. */
  async restore(): Promise<void> {
    this.loadGeneration++;
    this.main.stopAnimation();
    for (const sprite of [...this.under, this.special]) {
      sprite.stopAnimation();
      sprite.show(false);
    }
    this.show(!!this.dword(LayerRecord.visible));
    const source = this.uword(LayerRecord.source);
    const image = this.uword(LayerRecord.image);
    if (source === LayerSource.Numbered && !image) {
      this.player = null;
      this.main.show(false);
      this.main.setSurface(null);
    } else if (await this.loadSource()) {
      const target = this.place(
        source === LayerSource.Fill ? 0 : this.dword(LayerRecord.x),
        source === LayerSource.Fill ? 0 : this.dword(LayerRecord.y),
      );
      this.main.setPosition(target.x, target.y);
      this.main.show(true);
    }
    const button = !!this.dword(LayerRecord.animating);
    this.main.interactive = button;
    for (const slot of [0, 1, 2]) {
      const overlay = this.uword(LayerRecord.overlays + slot * 2);
      if (!overlay) continue;
      const x = this.dword(LayerRecord.overlayPositions + slot * 8),
        y = this.dword(LayerRecord.overlayPositions + slot * 8 + 4);
      if (slot === 2) {
        await this.loadSpecial(overlay, x, y);
        continue;
      }
      const sprite = this.under[slot]!;
      sprite.setSurface(await this.fetch(overlay));
      sprite.setPosition(x, y);
    }
  }
}

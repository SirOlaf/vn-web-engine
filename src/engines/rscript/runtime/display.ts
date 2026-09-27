import {blendSprite, type BlendState} from '../graphics/blend.js';
import {createSurface, type RScriptRect, type RScriptSurface} from '../graphics/pixels.js';
import {RScriptScreen} from '../graphics/sprite.js';

/** Presents native frames; implemented by the browser canvas or by tests. */
export interface RScriptPresenter {
  /** Copies `rect` of the frame, shifted by the screen shake offset. */
  present(frame: RScriptSurface, rect: RScriptRect, offsetX: number, offsetY: number): void;
  /** Fills the whole window with a COLORREF without touching the frame (flashes). */
  fill(colorref: number): void;
}

export interface RScriptTimer {
  /** Real-time sleep used by the native Sleep/timeGetTime loops. */
  sleep(milliseconds: number): Promise<void>;
  now(): number;
}

const full = (s: RScriptSurface): RScriptRect => ({
  left: 0,
  top: 0,
  right: s.width,
  bottom: s.height,
});

/**
 * Window-level drawing (the application object at dwNewLong): the root container, the
 * presented back buffer (+156), the transition sprite (+160) and a scratch frame (+164).
 */
export class RScriptDisplay {
  readonly screen: RScriptScreen;
  private readonly scratch: RScriptSurface;
  private readonly transition: RScriptSurface;
  offsetX = 0;
  offsetY = 0;

  constructor(
    readonly width: number,
    readonly height: number,
    private readonly presenter: RScriptPresenter,
    private readonly timer: RScriptTimer,
  ) {
    this.screen = new RScriptScreen(width, height);
    this.scratch = createSurface(width, height);
    this.transition = createSurface(width, height);
  }
  get frame(): RScriptSurface {
    return this.screen.surface;
  }

  /** sub_452F10: redraws and presents only the dirty area. */
  update(): boolean {
    const area = this.screen.render();
    if (!area) return false;
    this.presenter.present(this.frame, area, this.offsetX, this.offsetY);
    return true;
  }
  /** sub_453020: full redraw and presentation. */
  refresh(): void {
    this.screen.invalidateAll();
    this.update();
  }
  private presentAll(): void {
    this.presenter.present(this.frame, full(this.frame), this.offsetX, this.offsetY);
  }

  /** sub_453080: renders the current scene state into `target` without presenting it. */
  private renderScene(target: RScriptSurface): void {
    target.data.fill(0);
    this.screen.draw(target, full(target), -this.screen.x, -this.screen.y);
  }

  private async steps(
    count: number,
    milliseconds: number,
    draw: (step: number) => void,
  ): Promise<void> {
    for (let step = 0; step < count; step++) {
      const started = this.timer.now();
      draw(step);
      this.presentAll();
      const elapsed = this.timer.now() - started;
      await this.timer.sleep(Math.max(0, milliseconds + 1 - elapsed));
    }
  }

  private state(mode: number, alpha: number, mask = 6, maskLevel = 0): BlendState {
    return {mode, alpha, mask, maskLevel, color: 0};
  }

  /** sub_455200: crossfade over `steps + 1` frames of `milliseconds`. */
  async fade(steps: number, milliseconds: number): Promise<void> {
    this.renderScene(this.transition);
    this.scratch.data.set(this.frame.data);
    await this.steps(steps + 1, milliseconds, (step) => {
      this.frame.data.set(this.scratch.data);
      const level = Math.trunc((255 * (steps - step)) / steps);
      blendSprite(this.frame, this.transition, 0, 0, full(this.frame), this.state(2, level));
    });
    this.refresh();
  }

  /** sub_4550C0: accumulating dissolve with the 4x4 dither patterns. */
  async dissolve(steps: number, milliseconds: number): Promise<void> {
    this.renderScene(this.transition);
    await this.steps(Math.max(0, steps - 1), milliseconds, (step) => {
      const level = Math.trunc((255 * (steps - step)) / steps);
      blendSprite(this.frame, this.transition, 0, 0, full(this.frame), this.state(0x12, level));
    });
    this.refresh();
  }

  /** sub_455B10 (white, mode 4) and sub_455870 (black, mode 3): dip through a colour. */
  async dip(white: boolean, steps: number, milliseconds: number): Promise<void> {
    const mode = white ? 4 : 3;
    this.transition.data.set(this.frame.data);
    this.scratch.data.set(this.frame.data);
    await this.steps(steps + 1, milliseconds, (step) => {
      this.frame.data.set(this.scratch.data);
      const level = Math.trunc((255 * step) / steps);
      blendSprite(this.frame, this.transition, 0, 0, full(this.frame), this.state(mode, level));
    });
    this.renderScene(this.transition);
    await this.steps(steps + 1, milliseconds, (step) => {
      const level = Math.trunc((255 * (steps - step)) / steps);
      blendSprite(this.frame, this.transition, 0, 0, full(this.frame), this.state(mode, level));
    });
    this.refresh();
  }

  /** sub_454F60: wipe driven by a mask image's transparency byte. */
  async wipe(mask: RScriptSurface, steps: number, milliseconds: number): Promise<void> {
    this.renderScene(this.transition);
    const pixels = this.transition.data,
      source = mask.data;
    const count = Math.min(pixels.length, source.length);
    for (let i = 0; i < count; i++)
      pixels[i] = ((pixels[i]! & 0xffffff) | (source[i]! & 0xff000000)) >>> 0;
    const total = (2 * steps) & 0xffff;
    await this.steps(Math.max(0, total - 1), milliseconds, (step) => {
      const level = Math.trunc((255 * (step + 1)) / total);
      blendSprite(this.frame, this.transition, 0, 0, full(this.frame), this.state(0, 0, 2, level));
    });
    this.refresh();
  }

  /** Nearest-neighbour StretchBlt of `rect` of `source` into `rect` of `target`. */
  private stretch(
    source: RScriptSurface,
    from: RScriptRect,
    target: RScriptSurface,
    to: RScriptRect,
  ): void {
    const sw = from.right - from.left,
      sh = from.bottom - from.top,
      dw = to.right - to.left,
      dh = to.bottom - to.top;
    if (sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) return;
    for (let y = Math.max(0, to.top); y < Math.min(target.height, to.bottom); y++) {
      const sy = from.top + Math.trunc(((y - to.top) * sh) / dh);
      if (sy < 0 || sy >= source.height) continue;
      for (let x = Math.max(0, to.left); x < Math.min(target.width, to.right); x++) {
        const sx = from.left + Math.trunc(((x - to.left) * sw) / dw);
        if (sx >= 0 && sx < source.width)
          target.data[y * target.width + x] = source.data[sy * source.width + sx]!;
      }
    }
  }
  /** Rectangle scaled to 100 / (zoom + 100) of the screen around an anchor (0x4531A0). */
  private zoomRect(zoom: number, anchor: {x: number; y: number}): RScriptRect {
    const w = Math.trunc((100 * this.width) / (zoom + 100)),
      h = Math.trunc((100 * this.height) / (zoom + 100));
    let left = Math.max(0, anchor.x - (w >> 1)),
      top = Math.max(0, anchor.y - (h >> 1));
    if (left + w > this.width) left = this.width - w;
    if (top + h > this.height) top = this.height - h;
    return {left, top, right: left + w, bottom: top + h};
  }

  /** sub_455360: zooms into the old frame, then out of the new scene. */
  async zoomThrough(from: {x: number; y: number}, to: {x: number; y: number}): Promise<void> {
    this.scratch.data.set(this.frame.data);
    const zoomed = createSurface(this.width, this.height);
    const pass = async (
      source: RScriptSurface,
      anchor: {x: number; y: number},
      reverse: boolean,
    ): Promise<void> => {
      for (let i = 0; i <= 600; i += 20) {
        this.stretch(source, this.zoomRect(reverse ? 600 - i : i, anchor), zoomed, full(zoomed));
        blendSprite(this.frame, zoomed, 0, 0, full(this.frame), this.state(8, 255));
        this.presentAll();
        await this.timer.sleep(5);
      }
    };
    await pass(this.scratch, from, false);
    this.renderScene(this.scratch);
    await pass(this.scratch, to, true);
    this.refresh();
  }

  /** sub_455500: shrinks the old frame into an anchor, then grows the new scene. */
  async shrinkThrough(from: {x: number; y: number}, to: {x: number; y: number}): Promise<void> {
    this.scratch.data.set(this.frame.data);
    const pass = async (
      source: RScriptSurface,
      anchor: {x: number; y: number},
      reverse: boolean,
    ): Promise<void> => {
      for (let i = 0; i <= 2000; i += 50) {
        this.frame.data.fill(0);
        this.stretch(
          source,
          full(source),
          this.frame,
          this.zoomRect(reverse ? 2000 - i : i, anchor),
        );
        this.presentAll();
        await this.timer.sleep(5);
      }
    };
    await pass(this.scratch, from, false);
    this.renderScene(this.scratch);
    await pass(this.scratch, to, true);
    this.refresh();
  }

  /** sub_454E30: presents the frame shifted for `milliseconds`. */
  async shakeStep(x: number, y: number, milliseconds: number): Promise<void> {
    const started = this.timer.now();
    this.offsetX = x;
    this.offsetY = y;
    this.presentAll();
    await this.timer.sleep(Math.max(0, milliseconds + 1 - (this.timer.now() - started)));
    this.offsetX = 0;
    this.offsetY = 0;
  }
  private async shakePath(
    count: number,
    path: readonly (readonly [number, number])[],
    ms: number,
  ): Promise<void> {
    for (let i = 0; i < count; i++) for (const [x, y] of path) await this.shakeStep(x, y, ms);
  }
  /** sub_454A80 (horizontal) and sub_454B90 (vertical): a triangle wave in thirds of `amplitude`. */
  async shake(
    count: number,
    amplitude: number,
    milliseconds: number,
    vertical: boolean,
  ): Promise<void> {
    const s = Math.trunc(amplitude / 3);
    const wave = [s, 2 * s, 3 * s, 2 * s, s, 0, -s, -2 * s, -3 * s, -2 * s, -s, 0];
    await this.shakePath(
      count,
      wave.map((d): [number, number] => (vertical ? [0, d] : [d, 0])),
      milliseconds,
    );
  }
  /** sub_454CA0: a loop through sixths of `amplitude`. */
  async shakeLoop(count: number, amplitude: number, milliseconds: number): Promise<void> {
    const s = Math.trunc(amplitude / 6);
    const path = [
      [0, 2],
      [1, 3],
      [2, 4],
      [1, 5],
      [0, 6],
      [-1, 5],
      [-2, 4],
      [-3, 3],
      [-4, 2],
      [-5, 0],
      [-6, -2],
      [-4, -3],
      [-2, -2],
      [-1, -1],
      [0, 0],
    ].map(([x, y]) => [x! * s, y! * s] as const);
    await this.shakePath(count, path, milliseconds);
  }
  /** sub_454E70: cycles white, blue, white, red, white and yellow flashes. */
  async flashCycle(count: number): Promise<void> {
    for (let i = 0; i < count; i++)
      for (const color of [0xffffff, 0xff0000, 0xffffff, 0xff, 0xffffff, 0xffff])
        await this.flash(color, 1);
    this.refresh();
  }
  /** sub_454EF0: flashes a colour, then the frame, 30 ms each. */
  async flash(colorref: number, count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      this.presenter.fill(colorref);
      await this.timer.sleep(31);
      this.presentAll();
      await this.timer.sleep(31);
    }
  }
}

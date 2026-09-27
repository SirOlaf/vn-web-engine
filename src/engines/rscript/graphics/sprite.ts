import {blendSprite, type BlendState} from './blend.js';
import {
  COS_TABLE,
  SIN_TABLE,
  createSurface,
  emptyRect,
  intersectRect,
  isEmptyRect,
  unionRect,
  type RScriptRect,
  type RScriptSurface,
} from './pixels.js';

export interface RScriptPoint {
  x: number;
  y: number;
}

/**
 * Base of every drawable (the native sprite object at 0x440910). Positions are relative
 * to the parent container; invalidation accumulates one screen-space dirty rectangle.
 */
export abstract class RScriptNode {
  parent: RScriptContainer | null = null;
  x = 0;
  y = 0;
  visible = false;
  /** Per-tick animation enabled (sprite +128, vtable +92). */
  animating = false;
  /** Accepts pointer input (sprite +152, vtable +104). */
  interactive = false;
  /** Ticks between animation steps and remaining idle repeats (+136, +138, +140). */
  frameDelay = 0;
  private delayCounter = 0;
  idleRepeats = 0;
  /** Called on every animation step; a true result keeps the node animating (+132). */
  onStep: (() => boolean) | null = null;
  private drawn: RScriptRect = emptyRect();

  abstract get width(): number;
  abstract get height(): number;
  protected abstract paint(target: RScriptSurface, clip: RScriptRect, x: number, y: number): void;

  /** Screen position after adding every ancestor container's position. */
  screenPosition(): RScriptPoint {
    let x = this.x,
      y = this.y;
    for (let p = this.parent; p; p = p.parent) {
      x += p.x;
      y += p.y;
    }
    return {x, y};
  }
  screenRect(): RScriptRect {
    const {x, y} = this.screenPosition();
    return {left: x, top: y, right: x + this.width, bottom: y + this.height};
  }
  root(): RScriptScreen | null {
    let node: RScriptNode = this;
    while (node.parent) node = node.parent;
    return node instanceof RScriptScreen ? node : null;
  }

  /** vtable +32: marks the old and new extents dirty. */
  invalidate(): void {
    const screen = this.root();
    if (!screen) return;
    const current = this.visible ? this.screenRect() : emptyRect();
    screen.addDirty(unionRect(this.drawn, current));
    this.drawn = current;
  }

  show(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible && this.canShow();
    this.invalidate();
  }
  protected canShow(): boolean {
    return true;
  }
  setPosition(x: number, y: number): void {
    if (this.x === x && this.y === y) return;
    this.x = x | 0;
    this.y = y | 0;
    this.invalidate();
  }
  move(dx: number, dy: number): void {
    this.setPosition(this.x + dx, this.y + dy);
  }

  draw(target: RScriptSurface, clip: RScriptRect, originX: number, originY: number): void {
    if (!this.visible) return;
    this.paint(target, clip, originX + this.x, originY + this.y);
  }

  /** sub_442D90: one timer tick. Returns whether the node still wants ticks. */
  animate(): boolean {
    if (!this.visible || !this.animating) return false;
    if (this.delayCounter < this.frameDelay) {
      this.delayCounter++;
      return true;
    }
    this.delayCounter = 0;
    if (this.idleRepeats) {
      this.idleRepeats--;
      return true;
    }
    const keep = this.onStep ? this.onStep() : false;
    if (this.step()) return true;
    if (!keep) this.animating = false;
    return keep;
  }
  /** Subclass animation components (vtable +244). */
  protected step(): boolean {
    return false;
  }
  /** vtable +96: stops animation immediately. */
  stopAnimation(): void {
    this.finishStep();
    this.idleRepeats = 0;
    this.animating = false;
  }
  protected finishStep(): void {}

  /** sub_4428F0: inside the bounds and over a pixel that is not fully transparent. */
  hitTest(x: number, y: number): boolean {
    const r = this.screenRect();
    return this.visible && x >= r.left && x < r.right && y >= r.top && y < r.bottom;
  }
}

/** Alpha fade driven per tick (0x44B790 / 0x44B800). */
class FadeComponent {
  active = false;
  /** 0 fades in (level falls to 0), 1 fades out (level rises to 255, then hides). */
  direction = 0;
  loop = false;
  step = 16;

  start(sprite: RScriptSprite, mode: number, direction: number, step: number): void {
    this.direction = direction;
    this.active = true;
    this.step = step;
    sprite.setBlendMode(mode);
    sprite.setAlpha(direction ? 0 : 255);
  }
  tick(sprite: RScriptSprite): boolean {
    if (!this.active) return false;
    let level: number;
    let running = true;
    if (!this.direction) {
      level = sprite.blend.alpha - this.step;
      if (level <= 0) {
        level = 0;
        if (this.loop) this.direction = 1;
        else {
          sprite.setBlendMode(0);
          this.active = false;
          running = false;
        }
      }
    } else {
      level = sprite.blend.alpha + this.step;
      if (level > 255) {
        level = 255;
        if (this.loop) this.direction = 0;
        else {
          sprite.setBlendMode(0);
          sprite.show(false);
          this.active = false;
          running = false;
        }
      }
    }
    sprite.setAlpha(level);
    return running;
  }
  /** 0x44B8B0: jumps to the end state. */
  finish(sprite: RScriptSprite): void {
    if (!this.active) return;
    this.active = false;
    if (this.direction) {
      sprite.setAlpha(255);
      sprite.show(false);
    } else sprite.setAlpha(0);
    sprite.setBlendMode(0);
  }
}

/** Point motion (0x448AE0 family); coordinates use the native truncating integer math. */
class MotionComponent {
  active = false;
  kind = 0;
  target: RScriptPoint = {x: 0, y: 0};
  /** Per-step delta scaled by 0xFFFF (+24). */
  delta: RScriptPoint = {x: 0, y: 0};
  /** Arc normal or oscillation offset (+32). */
  offset: RScriptPoint = {x: 0, y: 0};
  angleStep = 0;
  remaining = 0;

  private begin(kind: number, from: RScriptPoint, to: RScriptPoint): number {
    this.kind = kind;
    this.target = {...to};
    this.delta = {x: to.x - from.x, y: to.y - from.y};
    return Math.trunc(Math.sqrt(this.delta.x ** 2 + this.delta.y ** 2));
  }
  private scaleDelta(): void {
    this.delta = {
      x: Math.trunc((this.delta.x * 0xffff) / this.remaining),
      y: Math.trunc((this.delta.y * 0xffff) / this.remaining),
    };
  }

  /** 0x448C30: straight line at `speed` pixels per tick. */
  linear(from: RScriptPoint, to: RScriptPoint, speed: number): void {
    if (!speed) return;
    this.remaining = Math.trunc(this.begin(0, from, to) / speed) & 0xffff;
    if (!this.remaining) return;
    this.scaleDelta();
    this.active = true;
  }

  /** 0x448D80: line with a sine bulge of `bulge / 20` of the distance, `waves` half-periods. */
  arc(from: RScriptPoint, to: RScriptPoint, speed: number, waves: number, bulge: number): void {
    if (!speed) return;
    const distance = this.begin(1, from, to);
    this.offset = {
      x: Math.trunc((this.delta.y * bulge) / 20),
      y: Math.trunc((-this.delta.x * bulge) / 20),
    };
    this.remaining = Math.trunc(distance / speed) & 0xffff;
    if (!this.remaining) return;
    this.scaleDelta();
    this.angleStep = Math.trunc((0xffff * waves) / this.remaining) & 0xffff;
    this.active = true;
  }

  /** 0x448E90: half-circle arc to either side. */
  swing(from: RScriptPoint, to: RScriptPoint, speed: number, clockwise: boolean): void {
    if (!speed) return;
    const distance = this.begin(1, from, to);
    const sign = clockwise ? 1 : -1;
    this.offset = {
      x: Math.trunc((sign * this.delta.y) / 2),
      y: Math.trunc((-sign * this.delta.x) / 2),
    };
    this.remaining = Math.trunc(distance / speed) & 0xffff;
    if (!this.remaining) return;
    this.scaleDelta();
    this.angleStep = Math.trunc(0x8000 / this.remaining) & 0xffff;
    this.active = true;
  }

  /** 0x448FA0 (sine, decelerating) and 0x449050 (cosine, accelerating). */
  curved(from: RScriptPoint, to: RScriptPoint, speed: number, accelerate: boolean): void {
    if (!speed) return;
    const distance = this.begin(accelerate ? 4 : 3, from, to);
    this.offset = {x: -this.delta.x, y: -this.delta.y};
    this.remaining = Math.trunc(distance / speed) & 0xffff;
    if (!this.remaining) return;
    this.angleStep = Math.trunc(0x4000 / this.remaining) & 0xffff;
    this.active = true;
  }

  /** 0x4492D0: oscillates around the current point. */
  bounce(
    at: RScriptPoint,
    count: number,
    amplitude: number,
    speed: number,
    direction: number,
  ): void {
    if (!speed) return;
    this.begin(5, at, at);
    this.offset =
      direction === 1
        ? {x: -amplitude, y: 0}
        : direction === 2
          ? {x: 0, y: amplitude}
          : direction === 3
            ? {x: amplitude, y: 0}
            : {x: 0, y: -amplitude};
    this.remaining = Math.trunc((amplitude * count) / speed) & 0xffff;
    if (!this.remaining) return;
    this.angleStep = Math.trunc((count << 15) / this.remaining) & 0xffff;
    this.active = true;
  }

  /** 0x449460: a single vertical hop. */
  hop(at: RScriptPoint, height: number, speed: number): void {
    if (!speed) return;
    this.begin(6, at, at);
    this.offset = {x: 0, y: -height};
    this.remaining = Math.trunc(height / speed) & 0xffff;
    if (!this.remaining) return;
    this.angleStep = (Math.trunc(34816 / this.remaining) + 2) & 0xffff;
    this.active = true;
  }

  private angle(): number {
    return Math.trunc((this.remaining * this.angleStep) / 255);
  }
  private scaled(offset: RScriptPoint, factor: number): RScriptPoint {
    return {
      x: Math.trunc((offset.x * factor) / 0xffff),
      y: Math.trunc((offset.y * factor) / 0xffff),
    };
  }

  tick(sprite: RScriptSprite): boolean {
    if (!this.active) return false;
    if (!this.remaining) {
      sprite.placeFromMotion(this.target);
      this.active = false;
      return false;
    }
    const t = this.target;
    let point: RScriptPoint;
    switch (this.kind) {
      case 1: {
        // 0x449100
        const line = this.scaled(this.delta, this.remaining);
        const bulge = this.scaled(this.offset, SIN_TABLE[this.angle() % 255]!);
        point = {x: t.x - line.x + bulge.x, y: t.y - line.y + bulge.y};
        break;
      }
      case 3:
      case 5: {
        // 0x4493A0
        const shift = this.scaled(this.offset, SIN_TABLE[this.angle() % 255]!);
        point = {x: t.x + shift.x, y: t.y + shift.y};
        break;
      }
      case 4: {
        // 0x449200
        const shift = this.scaled(this.offset, COS_TABLE[this.angle() % 255]!);
        point = {x: t.x + this.offset.x - shift.x, y: t.y + this.offset.y - shift.y};
        break;
      }
      case 6: {
        // 0x4494D0
        const shift = this.scaled(this.offset, SIN_TABLE[(390 - this.angle()) % 255]!);
        point = {x: t.x + shift.x, y: t.y + shift.y};
        break;
      }
      default: {
        // 0x448CF0
        const line = this.scaled(this.delta, this.remaining);
        point = {x: t.x - line.x, y: t.y - line.y};
      }
    }
    sprite.placeFromMotion(point);
    this.remaining--;
    return true;
  }

  finish(sprite: RScriptSprite): void {
    if (!this.active) return;
    this.active = false;
    sprite.placeFromMotion(this.target);
  }
}

/** Image sprite with blend state plus fade and motion components (0x448770 layout). */
export class RScriptSprite extends RScriptNode {
  surface: RScriptSurface | null = null;
  readonly blend: BlendState = {mode: 0, alpha: 0, mask: 0, maskLevel: 0, color: 0};
  readonly fade = new FadeComponent();
  readonly motion = new MotionComponent();
  /** Pointer callbacks used by native controls. */
  /** A click on the sprite; `at` is the pointer relative to the sprite. */
  onPress: ((sprite: RScriptSprite, at: RScriptPoint) => void) | null = null;
  onRelease: ((sprite: RScriptSprite) => void) | null = null;
  onHover: ((sprite: RScriptSprite, inside: boolean) => void) | null = null;
  hovered = false;

  get width(): number {
    return this.surface?.width ?? 0;
  }
  get height(): number {
    return this.surface?.height ?? 0;
  }
  protected override canShow(): boolean {
    return this.surface !== null;
  }
  setSurface(surface: RScriptSurface | null): void {
    this.invalidate();
    this.surface = surface;
    if (!surface) this.visible = false;
    this.invalidate();
  }
  /** Allocates a cleared surface (vtable +232). */
  allocate(width: number, height: number): RScriptSurface {
    const surface = createSurface(width, height);
    this.setSurface(surface);
    return surface;
  }
  setBlendMode(mode: number): void {
    this.blend.mode = mode;
    this.invalidate();
  }
  setAlpha(alpha: number): void {
    this.blend.alpha = alpha;
    this.invalidate();
  }
  setMask(mask: number): void {
    this.blend.mask = mask;
    this.invalidate();
  }
  setMaskLevel(level: number): void {
    this.blend.maskLevel = level;
    this.invalidate();
  }
  /** Motion updates bypass component-relative positioning. */
  placeFromMotion(point: RScriptPoint): void {
    this.setPosition(point.x, point.y);
  }

  startFade(mode: number, direction: number, step: number): void {
    this.fade.start(this, mode, direction, step);
  }
  get position(): RScriptPoint {
    return {x: this.x, y: this.y};
  }

  protected override step(): boolean {
    let running = this.fade.tick(this);
    if (this.motion.tick(this)) running = true;
    return running;
  }
  protected override finishStep(): void {
    this.fade.finish(this);
    this.motion.finish(this);
  }

  override hitTest(x: number, y: number): boolean {
    if (!super.hitTest(x, y) || !this.surface) return false;
    const {x: left, y: top} = this.screenPosition();
    return this.surface.data[(y - top) * this.surface.width + (x - left)]! >>> 24 !== 0xff;
  }

  protected paint(target: RScriptSurface, clip: RScriptRect, x: number, y: number): void {
    if (this.surface) blendSprite(target, this.surface, x, y, clip, this.blend);
  }
}

interface Child {
  node: RScriptNode;
  priority: number;
}

/** Priority-ordered container (0x43EF70). Equal priorities keep insertion order. */
export class RScriptContainer extends RScriptNode {
  private children: Child[] = [];
  /** Optional clip in container coordinates. */
  clip: RScriptRect | null = null;
  private size = {width: 0, height: 0};

  constructor(width = 0, height = 0) {
    super();
    this.size = {width, height};
    this.visible = true;
  }
  get width(): number {
    return this.size.width;
  }
  get height(): number {
    return this.size.height;
  }
  resize(width: number, height: number): void {
    this.size = {width, height};
    this.invalidate();
  }

  add(node: RScriptNode, priority = 0): void {
    node.parent = this;
    this.children.push({node, priority});
    this.sort();
    node.invalidate();
  }
  remove(node: RScriptNode): void {
    const index = this.children.findIndex((child) => child.node === node);
    if (index < 0) return;
    node.invalidate();
    this.children.splice(index, 1);
    node.parent = null;
  }
  /** sub_43F200: changes a child's priority and re-sorts. */
  setPriority(node: RScriptNode, priority: number): void {
    const child = this.children.find((c) => c.node === node);
    if (!child || child.priority === priority) return;
    child.priority = priority;
    this.sort();
    node.invalidate();
  }
  /** sub_43F230: stable bubble sort by ascending priority. */
  private sort(): void {
    const list = this.children;
    for (let pass = 1; pass < list.length; pass++)
      for (let i = 0; i < list.length - pass; i++)
        if (list[i]!.priority > list[i + 1]!.priority)
          [list[i], list[i + 1]] = [list[i + 1]!, list[i]!];
  }
  nodes(): RScriptNode[] {
    return this.children.map((child) => child.node);
  }

  override invalidate(): void {
    super.invalidate();
    for (const {node} of this.children) node.invalidate();
  }

  protected paint(target: RScriptSurface, clip: RScriptRect, x: number, y: number): void {
    let area = clip;
    if (this.clip)
      area = intersectRect(clip, {
        left: x + this.clip.left,
        top: y + this.clip.top,
        right: x + this.clip.right,
        bottom: y + this.clip.bottom,
      });
    if (isEmptyRect(area)) return;
    for (const {node} of this.children) node.draw(target, area, x, y);
  }

  /**
   * vtable +88 on containers (0x4060A0): nothing while hidden; otherwise every child from
   * the top priority down, then the container's own step.
   */
  override animate(): boolean {
    if (!this.visible) return false;
    let running = false;
    const children = [...this.children];
    for (let i = children.length - 1; i >= 0; i--) if (children[i]!.node.animate()) running = true;
    if (super.animate()) running = true;
    return running;
  }

  /** Topmost interactive node under the point. */
  pick(x: number, y: number): RScriptNode | null {
    for (let i = this.children.length - 1; i >= 0; i--) {
      const node = this.children[i]!.node;
      if (!node.visible) continue;
      if (node instanceof RScriptContainer) {
        const found = node.pick(x, y);
        if (found) return found;
      } else if (node.interactive && node.hitTest(x, y)) return node;
    }
    return null;
  }
}

/** Root container owning the back buffer and the accumulated dirty rectangle. */
export class RScriptScreen extends RScriptContainer {
  readonly surface: RScriptSurface;
  private dirty: RScriptRect = emptyRect();

  constructor(width: number, height: number) {
    super(width, height);
    this.surface = createSurface(width, height);
  }
  addDirty(rect: RScriptRect): void {
    this.dirty = unionRect(
      this.dirty,
      intersectRect(rect, {left: 0, top: 0, right: this.width, bottom: this.height}),
    );
  }
  invalidateAll(): void {
    this.dirty = {left: 0, top: 0, right: this.width, bottom: this.height};
  }
  /** sub_452F10: redraws the dirty area; returns it for presentation, or null. */
  render(): RScriptRect | null {
    const area = this.dirty;
    if (isEmptyRect(area)) return null;
    this.dirty = emptyRect();
    const {data, width} = this.surface;
    for (let y = area.top; y < area.bottom; y++)
      data.fill(0, y * width + area.left, y * width + area.right);
    this.paint(this.surface, area, 0, 0);
    return area;
  }
}

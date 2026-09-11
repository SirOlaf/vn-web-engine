import {TouchMouse} from './touch-mouse.js';
export interface InputFrame {
  keys: ReadonlySet<string>;
  pressed: ReadonlySet<string>;
  buttons: number;
  pressedButtons: number;
  x: number;
  y: number;
  wheel: number;
  inside: boolean;
  focused?: boolean;
}
/** DOM events accumulate until an engine tick; browser repeat never drives VM repeat. */
export class BrowserInput {
  private keys = new Set<string>();
  private pressed = new Set<string>();
  private buttons = 0;
  private clicks = 0;
  private x = 0;
  private y = 0;
  private wheel = 0;
  private inside = false;
  private readonly touch = new TouchMouse();
  private touchMode = false;
  private readonly abort = new AbortController();
  constructor(
    readonly element: HTMLElement,
    readonly width: number,
    readonly height: number,
  ) {
    if (!(width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height)))
      throw new Error('Invalid input surface dimensions');
    const signal = this.abort.signal;
    element.tabIndex = element.tabIndex < 0 ? 0 : element.tabIndex;
    const editable = (target: EventTarget | null) =>
      target instanceof Element &&
      !!target.closest('input,textarea,select,[contenteditable="true"],[data-game-text]');
    element.addEventListener(
      'keydown',
      (e) => {
        if (editable(e.target) || e.metaKey) return;
        if (!this.keys.has(e.code)) this.pressed.add(e.code);
        this.keys.add(e.code);
        e.preventDefault();
      },
      {signal},
    );
    element.addEventListener(
      'keyup',
      (e) => {
        this.keys.delete(e.code);
        if (!editable(e.target) && !e.metaKey) e.preventDefault();
      },
      {signal},
    );
    const point = (e: PointerEvent) => {
      const r = element.getBoundingClientRect(),
        scale = Math.min(r.width / width, r.height / height);
      if (!(scale > 0)) return {x: 0, y: 0, inside: false};
      const x = (e.clientX - r.left - (r.width - width * scale) / 2) / scale,
        y = (e.clientY - r.top - (r.height - height * scale) / 2) / scale;
      return {
        x: Math.trunc(x),
        y: Math.trunc(y),
        inside: x >= 0 && y >= 0 && x < width && y < height,
      };
    };
    const mousePoint = (e: PointerEvent) => {
      const p = point(e);
      this.x = p.x;
      this.y = p.y;
      this.inside = p.inside;
    };
    const capture = (e: PointerEvent) => {
      element.setPointerCapture(e.pointerId);
    };
    element.addEventListener(
      'pointermove',
      (e) => {
        if (e.pointerType === 'touch') {
          this.touch.move(e.pointerId, point(e), {x: e.clientX, y: e.clientY});
          return;
        }
        if (this.touch.active) return;
        this.touchMode = false;
        this.touch.clear();
        mousePoint(e);
      },
      {signal},
    );
    element.addEventListener(
      'pointerdown',
      (e) => {
        if (editable(e.target)) return;
        if (e.pointerType === 'touch') {
          if (this.buttons || (!e.isPrimary && !this.touch.active) || !point(e).inside) return;
          element.focus({preventScroll: true});
          if (this.touch.down(e.pointerId, e.isPrimary, point(e), {x: e.clientX, y: e.clientY})) {
            this.touchMode = true;
            capture(e);
            e.preventDefault();
          }
          return;
        }
        if (this.touch.active) return;
        this.touchMode = false;
        this.touch.clear();
        mousePoint(e);
        element.focus({preventScroll: true});
        const mask = e.button === 0 ? 1 : e.button === 2 ? 2 : e.button === 1 ? 4 : 0;
        this.clicks |= mask & ~this.buttons;
        this.buttons |= mask;
        capture(e);
        e.preventDefault();
      },
      {signal},
    );
    element.addEventListener(
      'pointerup',
      (e) => {
        if (e.pointerType === 'touch') {
          this.touch.up(e.pointerId, point(e), {x: e.clientX, y: e.clientY});
          return;
        }
        if (this.touchMode) return;
        mousePoint(e);
        this.buttons &= ~(e.button === 0 ? 1 : e.button === 2 ? 2 : e.button === 1 ? 4 : 0);
      },
      {signal},
    );
    const cancel = (e: PointerEvent) => {
      if (e.pointerType === 'touch') {
        this.touch.cancel(e.pointerId);
        return;
      }
      if (!this.touchMode) {
        this.buttons = 0;
        this.clicks = 0;
      }
    };
    element.addEventListener('pointercancel', cancel, {signal});
    element.addEventListener(
      'lostpointercapture',
      (e) => {
        // Normal release already removed this finger; preserve its queued release.
        if (e.pointerType === 'touch') this.touch.cancel(e.pointerId);
        else if (this.buttons) cancel(e);
      },
      {signal},
    );
    element.addEventListener(
      'pointerleave',
      (e) => {
        if (e.pointerType !== 'touch' && !this.touchMode) this.inside = false;
      },
      {signal},
    );
    element.addEventListener(
      'contextmenu',
      (e) => {
        if (!editable(e.target)) e.preventDefault();
      },
      {signal},
    );
    element.addEventListener(
      'wheel',
      (e) => {
        if (editable(e.target)) return;
        this.wheel += e.deltaY === 0 ? 0 : e.deltaY > 0 ? -120 : 120;
        e.preventDefault();
      },
      {signal, passive: false},
    );
    element.addEventListener('blur', () => this.clear(), {signal});
    document.addEventListener(
      'visibilitychange',
      () => {
        if (document.hidden) this.clear();
      },
      {signal},
    );
  }
  clear(): void {
    this.touch.clear();
    this.touchMode = false;
    this.keys.clear();
    this.pressed.clear();
    this.buttons = 0;
    this.clicks = 0;
    this.wheel = 0;
    this.inside = false;
  }
  sample(): InputFrame {
    const pointer = this.touchMode
      ? this.touch.sample()
      : {
          buttons: this.buttons,
          pressedButtons: this.clicks,
          x: this.x,
          y: this.y,
          inside: this.inside,
        };
    const frame = {
      keys: new Set(this.keys),
      pressed: new Set(this.pressed),
      ...pointer,
      wheel: this.wheel,
      focused: document.hasFocus() && !document.hidden,
    };
    this.pressed.clear();
    this.clicks = 0;
    this.wheel = 0;
    return frame;
  }
  dispose(): void {
    this.abort.abort();
    this.clear();
  }
}

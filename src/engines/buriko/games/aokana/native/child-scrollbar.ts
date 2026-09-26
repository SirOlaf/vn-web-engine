import type {AokanaChildScrollbar} from './child-scroll.js';
import type {AokanaWindowMessages} from './window-messages.js';

/** Concrete browser scrollbar for the child WndProc's WM_HSCROLL/WM_VSCROLL messages. */
export class AokanaChildScrollbarControl {
  readonly element: HTMLDivElement;
  private readonly track: HTMLDivElement;
  private readonly thumb: HTMLButtonElement;
  private readonly arrows: HTMLButtonElement[] = [];
  private drag: {pointer: number; start: number; position: number; value: number} | null = null;
  constructor(
    readonly document: Document,
    readonly axis: 0 | 1,
    readonly state: AokanaChildScrollbar,
    readonly messages: AokanaWindowMessages,
    readonly target: number,
  ) {
    const root = document.createElement('div');
    this.element = root;
    root.style.cssText = `display:flex;flex-direction:${axis === 0 ? 'row' : 'column'};min-width:0;min-height:0`;
    const arrow = (label: string, action: number): HTMLButtonElement => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.style.cssText = 'padding:0;flex:none;min-width:1em;min-height:1em';
      button.addEventListener('click', () => this.post(action));
      this.arrows.push(button);
      return button;
    };
    const track = document.createElement('div');
    this.track = track;
    track.style.cssText =
      'position:relative;flex:1;background:ButtonFace;min-width:1em;min-height:1em';
    const thumb = document.createElement('button');
    this.thumb = thumb;
    thumb.type = 'button';
    thumb.setAttribute('role', 'scrollbar');
    thumb.setAttribute('aria-orientation', axis === 0 ? 'horizontal' : 'vertical');
    thumb.style.cssText = 'position:absolute;padding:0;touch-action:none;min-width:0;min-height:0';
    track.append(thumb);
    root.append(arrow(axis === 0 ? '◀' : '▲', 0), track, arrow(axis === 0 ? '▶' : '▼', 1));
    track.addEventListener('pointerdown', (event) => {
      if (!state.enabled || event.target === thumb) return;
      event.preventDefault();
      const bounds = thumb.getBoundingClientRect();
      this.post((axis === 0 ? event.clientX < bounds.left : event.clientY < bounds.top) ? 2 : 3);
    });
    thumb.addEventListener('pointerdown', (event) => {
      if (!state.enabled) return;
      event.preventDefault();
      event.stopPropagation();
      this.drag = {
        pointer: event.pointerId,
        start: axis === 0 ? event.clientX : event.clientY,
        position: state.position,
        value: state.position,
      };
      thumb.setPointerCapture(event.pointerId);
    });
    thumb.addEventListener('pointermove', (event) => {
      if (this.drag?.pointer !== event.pointerId) return;
      const trackBounds = track.getBoundingClientRect(),
        thumbBounds = thumb.getBoundingClientRect();
      const available =
        axis === 0
          ? trackBounds.width - thumbBounds.width
          : trackBounds.height - thumbBounds.height;
      const delta = (axis === 0 ? event.clientX : event.clientY) - this.drag.start;
      const maximum = this.maximum;
      const value =
        available <= 0
          ? 0
          : Math.min(
              maximum,
              Math.max(0, Math.round(this.drag.position + (delta * maximum) / available)),
            );
      this.drag.value = value;
      this.post(5, value);
    });
    const stop = (event: PointerEvent): void => {
      if (this.drag?.pointer !== event.pointerId) return;
      this.post(4, this.drag.value);
      this.drag = null;
      if (thumb.hasPointerCapture(event.pointerId)) thumb.releasePointerCapture(event.pointerId);
    };
    thumb.addEventListener('pointerup', stop);
    thumb.addEventListener('pointercancel', stop);
    thumb.addEventListener('keydown', (event) => {
      const action = (
        {
          ArrowLeft: 0,
          ArrowUp: 0,
          ArrowRight: 1,
          ArrowDown: 1,
          PageUp: 2,
          PageDown: 3,
          Home: 6,
          End: 7,
        } as Record<string, number>
      )[event.key];
      if (action !== undefined) {
        event.preventDefault();
        this.post(action);
      }
    });
    this.update();
  }
  private get maximum(): number {
    return Math.max(0, this.state.maximum - Math.max(this.state.page - 1, 0));
  }
  private post(action: number, position = 0): void {
    if (!this.state.enabled) return;
    this.messages.post({
      target: this.target,
      message: this.axis === 0 ? 0x114 : 0x115,
      wParam: (((position & 0xffff) << 16) | action) >>> 0,
      lParam: 0,
    });
  }
  update(): void {
    const {state, thumb, axis} = this;
    for (const arrow of this.arrows) arrow.disabled = !state.enabled;
    thumb.disabled = !state.enabled;
    const fraction =
      state.maximum > 0 ? Math.min(1, Math.max(0, state.page / (state.maximum + 1))) : 1;
    const size = Math.max(0.05, fraction);
    const position = this.maximum === 0 ? 0 : (state.position / this.maximum) * (1 - size);
    thumb.style.left = axis === 0 ? `${position * 100}%` : '0';
    thumb.style.top = axis === 1 ? `${position * 100}%` : '0';
    thumb.style.width = axis === 0 ? `${size * 100}%` : '100%';
    thumb.style.height = axis === 1 ? `${size * 100}%` : '100%';
    thumb.setAttribute('aria-valuemin', '0');
    thumb.setAttribute('aria-valuemax', String(this.maximum));
    thumb.setAttribute('aria-valuenow', String(state.position));
  }
}

import type {ViewportScreenMapping} from './window-display.js';

/** Screen-positioned auxiliary windows, independent of their browser containing block. */
export interface WindowCoordinatesHost {
  setPosition(element: HTMLElement, x: number, y: number): void;
  readPosition(element: HTMLElement): readonly [number, number];
  viewportToScreen(x: number, y: number): readonly [number, number];
  forget(element: HTMLElement): void;
}

/** Keeps native screen positions stable inside a scaled, positioned browser window.
 * Refresh after the containing block's layout or virtual desktop position changes. */
export class BrowserWindowCoordinatesHost implements WindowCoordinatesHost {
  private readonly positions = new Map<HTMLElement, readonly [number, number]>();

  constructor(
    readonly parent: HTMLElement,
    private readonly readMapping: () => ViewportScreenMapping,
  ) {}

  viewportToScreen(x: number, y: number): readonly [number, number] {
    const mapping = this.readMapping();
    return [
      mapping.originX + x * mapping.nativePixelsPerCssX,
      mapping.originY + y * mapping.nativePixelsPerCssY,
    ];
  }

  setPosition(element: HTMLElement, x: number, y: number): void {
    this.positions.set(element, [x, y]);
    this.place(element, x, y);
  }

  readPosition(element: HTMLElement): readonly [number, number] {
    const position = this.positions.get(element);
    if (position === undefined) throw new Error('Browser window has no registered screen position');
    return [...position];
  }

  forget(element: HTMLElement): void {
    this.positions.delete(element);
  }

  refresh(): void {
    for (const [element, [x, y]] of this.positions) this.place(element, x, y);
  }

  private place(element: HTMLElement, x: number, y: number): void {
    const mapping = this.readMapping(),
      bounds = this.parent.getBoundingClientRect(),
      width = bounds.right - bounds.left,
      height = bounds.bottom - bounds.top;
    // Hidden/detached parents have no measurable transform; retain the native
    // position so the next visible layout can restore the corresponding placement.
    if (width <= 0 || height <= 0 || this.parent.offsetWidth <= 0 || this.parent.offsetHeight <= 0)
      return;
    const scaleX = width / this.parent.offsetWidth,
      scaleY = height / this.parent.offsetHeight;
    element.style.left = `${((x - mapping.originX) / mapping.nativePixelsPerCssX - bounds.left) / scaleX - this.parent.clientLeft}px`;
    element.style.top = `${((y - mapping.originY) / mapping.nativePixelsPerCssY - bounds.top) / scaleY - this.parent.clientTop}px`;
  }
}

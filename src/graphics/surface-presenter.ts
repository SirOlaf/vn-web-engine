import {Surface} from './surface.js';
import {invalidateCanvasFrame} from './canvas-frame-presenter.js';

/** Canvas is only the presentation sink; off-screen buffers have no DOM dependency. */
export class SurfacePresenter {
  private readonly context: CanvasRenderingContext2D;
  constructor(readonly canvas: HTMLCanvasElement) {
    const context = canvas.getContext('2d', {alpha: true});
    if (!context) throw new Error('Canvas 2D unavailable');
    this.context = context;
  }
  present(surface: Surface): void {
    invalidateCanvasFrame(this.canvas);
    if (this.canvas.width !== surface.width) this.canvas.width = surface.width;
    if (this.canvas.height !== surface.height) this.canvas.height = surface.height;
    this.context.putImageData(
      new ImageData(
        Uint8ClampedArray.from(surface.straightPixels()),
        surface.width,
        surface.height,
      ),
      0,
      0,
    );
  }
}

import type {ArtemisGlyphPaint, ArtemisGlyphSurface} from './glyph-paint.js';
import type {ArtemisFileGlyph} from './file-fonts.js';
import type {ArtemisGlyphPaintRequest, ArtemisGlyphPaintResponse} from './glyph-paint-worker.js';
import {artemisRevision} from './revision.js';
export interface ArtemisGlyphPaintWorkerHost {
  onmessage: ((event: MessageEvent<ArtemisGlyphPaintResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(value: ArtemisGlyphPaintRequest, transfers: Transferable[]): void;
  terminate(): void;
}
/** Native paint jobs keep edge computation off the main thread. Input coverage
 * remains owned by its font/cache; output is independent transferable storage.
 */
export class ArtemisGlyphPainter {
  private readonly worker: ArtemisGlyphPaintWorkerHost;
  private readonly jobs = new Map<
    number,
    {resolve: (value: ArtemisGlyphSurface) => void; reject: (error: unknown) => void}
  >();
  private serial = 0;
  private closed = false;
  constructor(
    private readonly hash: string,
    createWorker: () => ArtemisGlyphPaintWorkerHost = () =>
      new Worker(new URL('./glyph-paint-worker.js', import.meta.url), {type: 'module'}),
  ) {
    artemisRevision(hash);
    this.worker = createWorker();
    this.worker.onmessage = ({data}) => {
      const job = this.jobs.get(data.id);
      if (!job) return;
      this.jobs.delete(data.id);
      if (data.error !== undefined) job.reject(Error(data.error));
      else if (data.surface) job.resolve(data.surface);
      else job.reject(Error('Invalid Artemis glyph paint result'));
    };
    this.worker.onerror = this.worker.onmessageerror = () => this.close();
  }
  paint(glyph: ArtemisFileGlyph, style: ArtemisGlyphPaint): Promise<ArtemisGlyphSurface> {
    if (this.closed) return Promise.reject(Error('Artemis glyph painter closed'));
    if (this.jobs.size >= 64)
      return Promise.reject(Error('Artemis glyph paint job budget exceeded'));
    if (glyph.pixels.length > 4 * 1024 * 1024)
      return Promise.reject(Error('Artemis glyph coverage budget exceeded'));
    const id = ++this.serial,
      pixels = Uint8Array.from(glyph.pixels),
      color = glyph.color && Uint8Array.from(glyph.color);
    return new Promise((resolve, reject) => {
      this.jobs.set(id, {resolve, reject});
      try {
        this.worker.postMessage(
          {
            id,
            executableSha256: this.hash,
            glyph: color ? {...glyph, pixels, color} : {...glyph, pixels},
            style: {...style},
          },
          color ? [pixels.buffer, color.buffer] : [pixels.buffer],
        );
      } catch (error) {
        this.jobs.delete(id);
        reject(error);
      }
    });
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.worker.terminate();
    for (const job of this.jobs.values()) job.reject(Error('Artemis glyph painter closed'));
    this.jobs.clear();
  }
}

import type {FreeTypeMetrics, FreeTypeGlyph, FreeTypeRasterOptions} from './freetype.js';
import type {FreeTypeRequest, FreeTypeResponse} from './freetype-worker.js';
export interface FreeTypeWorkerHost {
  onmessage: ((event: MessageEvent<FreeTypeResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(value: FreeTypeRequest, transfers: Transferable[]): void;
  terminate(): void;
}
type Request = FreeTypeRequest extends infer T
  ? T extends {id: number}
    ? Omit<T, 'id'>
    : never
  : never;
/** Browser font jobs keep wasm rasterization off the main thread. Workers own
 * fonts until close; each raster response transfers a separate coverage buffer.
 * Failure rejects outstanding operations; it never switches font implementation.
 */
export class FreeTypeWorker {
  private readonly worker: FreeTypeWorkerHost;
  private readonly jobs = new Map<
    number,
    {resolve: (value: FreeTypeResponse['value']) => void; reject: (error: unknown) => void}
  >();
  private nextJob = 0;
  private closed = false;
  constructor(
    createWorker: () => FreeTypeWorkerHost = () =>
      new Worker(new URL('./freetype-worker.js', import.meta.url), {type: 'module'}),
  ) {
    this.worker = createWorker();
    this.worker.onmessage = ({data}) => {
      const job = this.jobs.get(data.id);
      if (!job) return;
      this.jobs.delete(data.id);
      if (data.error !== undefined) job.reject(Error(data.error));
      else job.resolve(data.value);
    };
    this.worker.onerror = this.worker.onmessageerror = () =>
      this.fail(Error('FreeType worker failed'));
  }
  private request(
    request: Request,
    transfers: Transferable[] = [],
  ): Promise<FreeTypeResponse['value']> {
    if (this.closed) return Promise.reject(Error('FreeType worker closed'));
    if (this.jobs.size >= 64) return Promise.reject(Error('FreeType worker job budget exceeded'));
    const id = ++this.nextJob;
    return new Promise((resolve, reject) => {
      this.jobs.set(id, {resolve, reject});
      try {
        this.worker.postMessage({...request, id} as FreeTypeRequest, transfers);
      } catch (error) {
        this.jobs.delete(id);
        reject(error);
      }
    });
  }
  async open(bytes: Uint8Array, faceIndex = 0): Promise<FreeTypeWorkerFace> {
    if (!bytes.length || bytes.length > 64 * 1024 * 1024)
      throw Error('FreeType worker font budget exceeded');
    const copy = Uint8Array.from(bytes);
    const handle = await this.request({kind: 'open', bytes: copy, faceIndex}, [copy.buffer]);
    if (typeof handle !== 'number') throw Error('Invalid FreeType worker font response');
    return new FreeTypeWorkerFace(this, handle);
  }
  async metrics(face: number): Promise<FreeTypeMetrics> {
    return (await this.request({kind: 'metrics', face})) as FreeTypeMetrics;
  }
  async size(
    face: number,
    type: 0 | 1 | 2 | 3 | 4,
    width: number,
    height: number,
  ): Promise<FreeTypeMetrics> {
    return (await this.request({kind: 'size', face, type, width, height})) as FreeTypeMetrics;
  }
  async glyph(
    face: number,
    codePoint: number,
    options: FreeTypeRasterOptions,
  ): Promise<FreeTypeGlyph> {
    return (await this.request({
      kind: 'glyph',
      face,
      codePoint,
      flags: options.flags ?? 6,
      bold: options.bold ?? false,
      shear: options.shear ?? 0,
      size: options.size,
    })) as FreeTypeGlyph;
  }
  async release(face: number): Promise<void> {
    if (!this.closed) await this.request({kind: 'close', face});
  }
  private fail(error: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.worker.terminate();
    for (const job of this.jobs.values()) job.reject(error);
    this.jobs.clear();
  }
  close(): void {
    this.fail(Error('FreeType worker closed'));
  }
}
export class FreeTypeWorkerFace {
  private closed = false;
  constructor(
    private readonly owner: FreeTypeWorker,
    private readonly handle: number,
  ) {}
  private assertOpen(): void {
    if (this.closed) throw Error('FreeType worker face closed');
  }
  metrics(): Promise<FreeTypeMetrics> {
    this.assertOpen();
    return this.owner.metrics(this.handle);
  }
  requestSize(type: 0 | 1 | 2 | 3 | 4, width: number, height: number): Promise<FreeTypeMetrics> {
    this.assertOpen();
    return this.owner.size(this.handle, type, width, height);
  }
  rasterize(codePoint: number, options: FreeTypeRasterOptions = {}): Promise<FreeTypeGlyph> {
    this.assertOpen();
    return this.owner.glyph(this.handle, codePoint, options);
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.owner.release(this.handle);
  }
}

/** Envelope posted to a pool worker. */
export interface WorkerPoolRequest<Request> {
  readonly id: number;
  readonly request: Request;
}

/** Envelope a pool worker posts back; `failed` reports an exception thrown by its handler. */
export interface WorkerPoolResponse<Response> {
  readonly id: number;
  readonly response?: Response;
  readonly failed?: true;
}

interface PoolWorker<Response> {
  readonly worker: Worker;
  readonly pending: Map<number, (response: Response | undefined) => void>;
}

/**
 * Request/response jobs over lazily created module workers. Each job goes to the worker with
 * the fewest pending jobs; a new worker starts only while every existing one is busy and the
 * pool is below its size. `run` resolves with undefined, never rejects, when workers are
 * unavailable, the handler threw, or a worker failed. A failed worker also disables the pool,
 * so callers keep an in-thread implementation for that result.
 *
 * `create` must construct the worker from a literal module URL relative to `import.meta.url` at its call
 * site so bundlers emit the worker chunk.
 */
export class WorkerPool<Request, Response> {
  private readonly workers: PoolWorker<Response>[] = [];
  private nextId = 1;
  private failed = typeof Worker === 'undefined';

  constructor(
    private readonly create: () => Worker,
    readonly size = defaultWorkerPoolSize(),
  ) {
    if (!Number.isSafeInteger(size) || size < 1)
      throw new RangeError('Worker pool size must be a positive safe integer');
  }

  /** False once workers are known to be unavailable. */
  get available(): boolean {
    return !this.failed;
  }

  run(request: Request, transfer: Transferable[] = []): Promise<Response | undefined> {
    const target = this.failed ? undefined : this.select();
    if (target === undefined) return Promise.resolve(undefined);
    const id = this.nextId++;
    return new Promise((resolve) => {
      target.pending.set(id, resolve);
      try {
        target.worker.postMessage({id, request} satisfies WorkerPoolRequest<Request>, transfer);
      } catch {
        target.pending.delete(id);
        resolve(undefined);
      }
    });
  }

  /** Stops every worker; pending jobs resolve with undefined. */
  terminate(): void {
    this.failed = true;
    for (const entry of this.workers.splice(0)) this.stop(entry);
  }

  private select(): PoolWorker<Response> | undefined {
    let best: PoolWorker<Response> | undefined;
    for (const entry of this.workers)
      if (best === undefined || entry.pending.size < best.pending.size) best = entry;
    if (best !== undefined && (best.pending.size === 0 || this.workers.length >= this.size))
      return best;
    let worker: Worker;
    try {
      worker = this.create();
    } catch {
      this.failed = true;
      return best;
    }
    const entry: PoolWorker<Response> = {worker, pending: new Map()};
    worker.onmessage = ({data}: MessageEvent<WorkerPoolResponse<Response>>) => {
      const resolve = entry.pending.get(data.id);
      entry.pending.delete(data.id);
      resolve?.(data.failed ? undefined : data.response);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      this.terminate();
    };
    worker.onmessageerror = () => this.terminate();
    this.workers.push(entry);
    return entry;
  }

  private stop(entry: PoolWorker<Response>): void {
    entry.worker.terminate();
    const jobs = [...entry.pending.values()];
    entry.pending.clear();
    for (const resolve of jobs) resolve(undefined);
  }
}

/** Leaves one hardware thread to the page, with at most two workers. */
export function defaultWorkerPoolSize(): number {
  const threads = typeof navigator === 'undefined' ? 1 : navigator.hardwareConcurrency || 1;
  return Math.max(1, Math.min(2, threads - 1));
}

/**
 * Worker-side counterpart of `WorkerPool`: answers each request with the handler's result and
 * its transfer list. A thrown handler exception is reported as a failed job.
 */
export function serveWorkerPool<Request, Response>(
  handler: (request: Request) => {response: Response; transfer?: Transferable[]},
): void {
  const scope = globalThis as unknown as {
    onmessage: ((event: MessageEvent<WorkerPoolRequest<Request>>) => void) | null;
    postMessage(message: WorkerPoolResponse<Response>, transfer?: Transferable[]): void;
  };
  scope.onmessage = ({data: {id, request}}) => {
    let result: {response: Response; transfer?: Transferable[]};
    try {
      result = handler(request);
    } catch {
      scope.postMessage({id, failed: true});
      return;
    }
    scope.postMessage({id, response: result.response}, result.transfer ?? []);
  };
}

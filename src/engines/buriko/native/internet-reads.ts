import {pointerView, type BurikoBpPointer} from '../bp/memory.js';
import type {BurikoProgramFiles} from './program-files.js';
import {terminatedNativeBytes} from './program-files.js';

export const BURIKO_INTERNET_USER_AGENT = 'Ethornell - BURIKO General Interpreter';

/** The complete request identity presented to the selected WinINet-shaped host. */
export interface BurikoInternetReadRequest {
  readonly url: string;
  readonly userAgent: typeof BURIKO_INTERNET_USER_AGENT;
  readonly reload: true;
  readonly destination: BurikoBpPointer | null;
  readonly offset: number;
  readonly length: number;
}

/**
 * Host-visible stages remain distinct even where a browser fetch cannot recover
 * the original WinINet distinction from one rejected promise.
 */
export type BurikoInternetReadHostOutcome =
  | {readonly kind: 'connectivity-failure'}
  | {readonly kind: 'session-open-failure'}
  | {readonly kind: 'url-open-failure'}
  | {readonly kind: 'query-failure'}
  | {readonly kind: 'read-failure'; readonly lastError: number}
  | {readonly kind: 'opened'; readonly body: Uint8Array};

export interface BurikoInternetReadHostOperation {
  readonly completion: Promise<BurikoInternetReadHostOutcome>;
  cancelSession(): void;
  dispose(): void;
}

/** Explicit blocking-shaped and worker-shaped network boundary for Bank 81:31. */
export interface BurikoInternetReadHost {
  read(request: BurikoInternetReadRequest): Promise<BurikoInternetReadHostOutcome>;
  start(request: BurikoInternetReadRequest): BurikoInternetReadHostOperation | null;
}

export interface BurikoInternetReadOperation {
  readonly completion: Promise<number>;
  cancelSession(): void;
  dispose(): void;
}

interface PendingInternetRead {
  readonly completion: Promise<number>;
  readonly cancelSession: (() => void) | null;
  cancellationRequested: boolean;
}

type BurikoFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Browser network implementation; HTTP error responses remain readable handles. */
export class BurikoBrowserInternetReadHost implements BurikoInternetReadHost {
  constructor(private readonly fetcher: BurikoFetch = (input, init) => fetch(input, init)) {}

  read(request: BurikoInternetReadRequest): Promise<BurikoInternetReadHostOutcome> {
    return this.run(request, new AbortController());
  }

  start(request: BurikoInternetReadRequest): BurikoInternetReadHostOperation {
    const controller = new AbortController();
    let settled = false;
    const completion = this.run(request, controller).finally(() => {
      settled = true;
    });
    return {
      completion,
      cancelSession: () => controller.abort(),
      dispose: () => {
        if (!settled) controller.abort();
      },
    };
  }

  private async run(
    request: BurikoInternetReadRequest,
    controller: AbortController,
  ): Promise<BurikoInternetReadHostOutcome> {
    let response: Response;
    try {
      // Browsers own the protected User-Agent header. The exact title identity is
      // retained on request for hosts that can transmit it.
      response = await this.fetcher(request.url, {
        cache: request.reload ? 'reload' : 'default',
        signal: controller.signal,
      });
    } catch {
      return {kind: 'url-open-failure'};
    }
    if (request.length === 0 && request.offset !== 0)
      return {kind: 'opened', body: new Uint8Array()};
    try {
      return {kind: 'opened', body: new Uint8Array(await response.arrayBuffer())};
    } catch {
      return request.length === 0
        ? {kind: 'query-failure'}
        : {
            kind: 'read-failure',
            lastError: controller.signal.aborted ? 0x2ef1 : 0,
          };
    }
  }
}

/** Shared lower for the synchronous wrapper and the asynchronous worker record. */
export class BurikoInternetReads {
  private readonly pending = new Set<PendingInternetRead>();
  private closed = false;
  private closing: Promise<void> | null = null;
  private failed = false;
  private firstFailure: unknown;

  constructor(
    readonly files: Pick<BurikoProgramFiles, 'text'>,
    readonly host: BurikoInternetReadHost,
  ) {}

  get admissionClosed(): boolean {
    return this.closed;
  }

  /** A closed owner has no host completion left that can write a borrowed BP pointer. */
  get quiesced(): boolean {
    return this.closed && this.pending.size === 0;
  }

  private rememberFailure(error: unknown): void {
    if (!this.failed) {
      this.failed = true;
      this.firstFailure = error;
    }
  }

  private track(completion: Promise<number>, cancelSession: (() => void) | null): Promise<number> {
    const pending: PendingInternetRead = {completion, cancelSession, cancellationRequested: false};
    this.pending.add(pending);
    void completion.then(
      () => {
        this.pending.delete(pending);
      },
      (error: unknown) => {
        this.rememberFailure(error);
        this.pending.delete(pending);
      },
    );
    return completion;
  }

  /** Cancel accepted worker sessions, then join their final BP writes and blocking reads. */
  closeAndJoin(): Promise<void> {
    this.closed = true;
    return (this.closing ??= this.joinPending());
  }

  private async joinPending(): Promise<void> {
    while (this.pending.size !== 0) {
      const accepted = [...this.pending];
      for (const pending of accepted) {
        if (pending.cancelSession === null || pending.cancellationRequested) continue;
        pending.cancellationRequested = true;
        try {
          pending.cancelSession();
        } catch (error) {
          this.rememberFailure(error);
        }
      }
      await Promise.allSettled(accepted.map(({completion}) => completion));
    }
    if (this.failed) throw this.firstFailure;
  }

  async read(
    destination: BurikoBpPointer | null,
    url: Uint8Array,
    offset: number,
    length: number,
  ): Promise<number> {
    if (this.closed) throw new Error('Buriko internet-read admission is closed');
    const request = this.request(destination, url, offset, length);
    return this.track(
      this.host.read(request).then((outcome) => this.finish(request, outcome)),
      null,
    );
  }

  start(
    destination: BurikoBpPointer | null,
    url: Uint8Array,
    offset: number,
    length: number,
  ): BurikoInternetReadOperation | null {
    if (this.closed) throw new Error('Buriko internet-read admission is closed');
    const request = this.request(destination, url, offset, length),
      operation = this.host.start(request);
    if (operation === null) return null;
    return {
      completion: this.track(
        operation.completion.then((outcome) => this.finish(request, outcome)),
        () => operation.cancelSession(),
      ),
      cancelSession: () => operation.cancelSession(),
      dispose: () => operation.dispose(),
    };
  }

  private request(
    destination: BurikoBpPointer | null,
    url: Uint8Array,
    offset: number,
    length: number,
  ): BurikoInternetReadRequest {
    return {
      url: this.files.text.decodeAuto({bytes: terminatedNativeBytes(url), offset: 0}),
      userAgent: BURIKO_INTERNET_USER_AGENT,
      reload: true,
      destination,
      offset: offset >>> 0,
      length: length >>> 0,
    };
  }

  private finish(
    request: BurikoInternetReadRequest,
    outcome: BurikoInternetReadHostOutcome,
  ): number {
    switch (outcome.kind) {
      case 'connectivity-failure':
      case 'session-open-failure':
        return 0xffffffff;
      case 'url-open-failure':
        return 1;
      case 'query-failure':
        return 12;
      case 'read-failure':
        return outcome.lastError >>> 0 === 0x2ef1 ? 12 : 2;
      case 'opened':
        break;
    }
    if (request.length === 0) {
      if (request.offset !== 0) return 3;
      pointerView(request.destination!, 4).setUint32(0, outcome.body.byteLength >>> 0, true);
      return 0;
    }
    const start = Math.min(request.offset, outcome.body.byteLength),
      bytes = outcome.body.subarray(
        start,
        Math.min(start + request.length, outcome.body.byteLength),
      );
    if (bytes.byteLength === 0 || request.destination === null) return 2;
    pointerView(request.destination, bytes.byteLength);
    request.destination.bytes.set(bytes, request.destination.offset);
    return bytes.byteLength === request.length ? 0 : 3;
  }
}

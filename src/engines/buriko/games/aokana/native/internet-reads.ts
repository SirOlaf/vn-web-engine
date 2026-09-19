import {pointerView, type AokanaBpPointer} from '../bp/memory.js';
import type {AokanaProgramFiles} from './program-files.js';
import {terminatedNativeBytes} from './program-files.js';

export const AOKANA_INTERNET_USER_AGENT = 'Ethornell - BURIKO General Interpreter';

/** The complete request identity presented to the selected WinINet-shaped host. */
export interface AokanaInternetReadRequest {
  readonly url: string;
  readonly userAgent: typeof AOKANA_INTERNET_USER_AGENT;
  readonly reload: true;
  readonly destination: AokanaBpPointer | null;
  readonly offset: number;
  readonly length: number;
}

/**
 * Host-visible stages remain distinct even where a browser fetch cannot recover
 * the original WinINet distinction from one rejected promise.
 */
export type AokanaInternetReadHostOutcome =
  | {readonly kind: 'connectivity-failure'}
  | {readonly kind: 'session-open-failure'}
  | {readonly kind: 'url-open-failure'}
  | {readonly kind: 'query-failure'}
  | {readonly kind: 'read-failure'; readonly lastError: number}
  | {readonly kind: 'opened'; readonly body: Uint8Array};

export interface AokanaInternetReadHostOperation {
  readonly completion: Promise<AokanaInternetReadHostOutcome>;
  cancelSession(): void;
  dispose(): void;
}

/** Explicit blocking-shaped and worker-shaped network boundary for Bank 81:31. */
export interface AokanaInternetReadHost {
  read(request: AokanaInternetReadRequest): Promise<AokanaInternetReadHostOutcome>;
  start(request: AokanaInternetReadRequest): AokanaInternetReadHostOperation | null;
}

export interface AokanaInternetReadOperation {
  readonly completion: Promise<number>;
  cancelSession(): void;
  dispose(): void;
}

type AokanaFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Browser network implementation; HTTP error responses remain readable handles. */
export class AokanaBrowserInternetReadHost implements AokanaInternetReadHost {
  constructor(private readonly fetcher: AokanaFetch = (input, init) => fetch(input, init)) {}

  read(request: AokanaInternetReadRequest): Promise<AokanaInternetReadHostOutcome> {
    return this.run(request, new AbortController());
  }

  start(request: AokanaInternetReadRequest): AokanaInternetReadHostOperation {
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
    request: AokanaInternetReadRequest,
    controller: AbortController,
  ): Promise<AokanaInternetReadHostOutcome> {
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
export class AokanaInternetReads {
  constructor(
    private readonly files: Pick<AokanaProgramFiles, 'text'>,
    private readonly host: AokanaInternetReadHost,
  ) {}

  async read(
    destination: AokanaBpPointer | null,
    url: Uint8Array,
    offset: number,
    length: number,
  ): Promise<number> {
    const request = this.request(destination, url, offset, length);
    return this.finish(request, await this.host.read(request));
  }

  start(
    destination: AokanaBpPointer | null,
    url: Uint8Array,
    offset: number,
    length: number,
  ): AokanaInternetReadOperation | null {
    const request = this.request(destination, url, offset, length),
      operation = this.host.start(request);
    if (operation === null) return null;
    return {
      completion: operation.completion.then((outcome) => this.finish(request, outcome)),
      cancelSession: () => operation.cancelSession(),
      dispose: () => operation.dispose(),
    };
  }

  private request(
    destination: AokanaBpPointer | null,
    url: Uint8Array,
    offset: number,
    length: number,
  ): AokanaInternetReadRequest {
    return {
      url: this.files.text.decodeAuto({bytes: terminatedNativeBytes(url), offset: 0}),
      userAgent: AOKANA_INTERNET_USER_AGENT,
      reload: true,
      destination,
      offset: offset >>> 0,
      length: length >>> 0,
    };
  }

  private finish(
    request: AokanaInternetReadRequest,
    outcome: AokanaInternetReadHostOutcome,
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

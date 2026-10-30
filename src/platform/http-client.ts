/** Host networking reports the stage of failure; engine-specific codes belong to its owner. */
export type HttpGetResult =
  | {readonly status: number; readonly body: Uint8Array}
  | {readonly failure: 'request' | 'connection' | 'receive'};

export interface HttpClientHost {
  get(url: string, signal: AbortSignal): Promise<HttpGetResult>;
}

/** Ordinary fetch, including the browser's CORS and mixed-content restrictions. */
export class FetchHttpClient implements HttpClientHost {
  constructor(private readonly request: typeof fetch = fetch) {}
  async get(url: string, signal: AbortSignal): Promise<HttpGetResult> {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return {failure: 'request'};
    } catch {
      return {failure: 'request'};
    }
    let response: Response;
    try {
      response = await this.request(url, {signal});
    } catch {
      return {failure: 'connection'};
    }
    try {
      return {status: response.status, body: new Uint8Array(await response.arrayBuffer())};
    } catch {
      return {failure: 'receive'};
    }
  }
}

import type {HttpClientHost, HttpGetResult} from '../../platform/http-client.js';
import type {AsbTag} from '../../formats/artemis/asb.js';

export interface ArtemisHttpEffects {
  beginWait(): void;
  endWait(): void;
  cancelled(): boolean;
  writeVariable(name: string, value: string | Uint8Array): void;
}

/** Rev.2601 4b7510 / 4dd190 GET, polled by mode 8 (48fe40 → 4dd0c0).
 * Result publication (4de830) happens on the frame thread; cancellation publishes nothing.
 * Custom headers, response files and POST remain refused until their owners are modeled. */
export class ArtemisHttp {
  private active: {controller: AbortController; tag: AsbTag; result?: HttpGetResult} | null = null;
  private waiting = false;
  constructor(
    private readonly host: HttpClientHost,
    private readonly effects: ArtemisHttpEffects,
  ) {}

  dispatch(tag: AsbTag): boolean {
    if (tag.name !== 'httpget') return false;
    if (this.active) return true;
    if ([...tag.args.keys()].some((k) => /^(filename|header_key|header_value)/.test(k)))
      throw Error('Unsupported Artemis HTTP response file or custom headers');
    const request = {
      controller: new AbortController(),
      tag,
      result: undefined as HttpGetResult | undefined,
    };
    this.active = request;
    this.waiting = true;
    this.effects.writeVariable('s.http.cancel', '0');
    this.effects.beginWait();
    void Promise.resolve()
      .then(() => this.host.get(tag.args.get('url') ?? '', request.controller.signal))
      .then(
        (result) => {
          if (this.active === request) request.result = result;
        },
        () => {
          if (this.active === request) request.result = {failure: 'connection'};
        },
      );
    return true;
  }

  tick(): void {
    if (!this.waiting) return;
    if (this.effects.cancelled()) {
      this.active?.controller.abort();
      this.active = null;
    } else if (this.active) {
      const {tag, result} = this.active;
      if (!result) return;
      let code: number, body: Uint8Array;
      if ('failure' in result) {
        const failure = {
          request: [-1, 'ドメインが見つからないか、不正なURLです'],
          connection: [-2, 'サーバとの通信に失敗しました'],
          receive: [-3, 'サーバからの受信に失敗しました'],
        } as const;
        const [status, message] = failure[result.failure];
        code = status;
        // Fetch has no Winsock error pair; the platform leaves both unavailable codes zero.
        body = new TextEncoder().encode(`${message} (0,0)`);
      } else {
        code = result.status;
        const end = result.body.indexOf(0);
        body = result.body.slice(0, end < 0 ? undefined : end);
      }
      const codeName = tag.args.get('varname_code'),
        dataName = tag.args.get('varname_data');
      if (codeName) this.effects.writeVariable(codeName, String(code));
      if (dataName) this.effects.writeVariable(dataName, body);
      this.active = null;
      // Native poll returns false for this completion; the following frame releases mode 8.
      return;
    }
    this.waiting = false;
    this.effects.endWait();
  }

  close(): void {
    this.active?.controller.abort();
    this.active = null;
    this.waiting = false;
  }
}

import {AokanaMoviePcmCore} from './movie-pcm-core.js';
import type {
  AokanaMoviePcmFormat,
  AokanaMoviePcmRequest,
  AokanaMoviePcmResponse,
} from './movie-pcm-protocol.js';

/** One command/render owner for both browser audio hosts. */
export class AokanaMoviePcmProcessor {
  private readonly core: AokanaMoviePcmCore;
  private closed = false;
  private failure: string | null = null;
  constructor(
    format: AokanaMoviePcmFormat,
    outputRate: number,
    private readonly send: (response: AokanaMoviePcmResponse) => void,
  ) {
    this.core = new AokanaMoviePcmCore(format, outputRate);
  }
  receive({id, command}: AokanaMoviePcmRequest): void {
    try {
      if (this.failure !== null) throw new Error(this.failure);
      const status = this.core.command(command);
      if (command.kind === 'dispose' && status.result === 'ok') this.closed = true;
      this.send({kind: 'reply', id, status});
    } catch (error) {
      this.send({
        kind: 'error',
        id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  render(output: Float32Array[]): boolean {
    if (this.closed || this.failure !== null) return false;
    try {
      const previous = this.core.status();
      const status = this.core.render(output);
      if (!previous.ended && status.ended) this.send({kind: 'complete', status});
      this.send({kind: 'progress', status});
      return true;
    } catch (error) {
      this.failure = error instanceof Error ? error.message : String(error);
      this.send({kind: 'failure', message: this.failure});
      return false;
    }
  }
}

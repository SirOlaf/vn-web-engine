import {AokanaAudioBufferRenderCore} from './buffer-render-core.js';
import type {
  AokanaAudioBufferFormat,
  AokanaAudioBufferRequest,
  AokanaAudioBufferResponse,
} from './buffer-protocol.js';

/** One command/render owner for both browser audio hosts. */
export class AokanaBufferProcessor {
  private readonly core: AokanaAudioBufferRenderCore;
  private closed = false;
  private failure: string | null = null;
  constructor(
    format: AokanaAudioBufferFormat,
    outputRate: number,
    private readonly send: (response: AokanaAudioBufferResponse) => void,
  ) {
    this.core = new AokanaAudioBufferRenderCore(format, outputRate);
  }
  receive({id, command}: AokanaAudioBufferRequest): void {
    try {
      if (this.failure !== null) throw new Error(this.failure);
      const status = this.core.command(command);
      if (command.kind === 'dispose') this.closed = true;
      this.events();
      this.send({kind: 'reply', id, status});
    } catch (error) {
      this.send({
        kind: 'error',
        id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  private events(): void {
    const events = this.core.takeNotifications();
    if (events.length !== 0) this.send({kind: 'events', events});
  }
  render(output: Float32Array[]): boolean {
    if (this.closed || this.failure !== null) return false;
    try {
      this.core.render(output);
      this.events();
      return true;
    } catch (error) {
      this.failure = error instanceof Error ? error.message : String(error);
      this.send({kind: 'failure', message: this.failure});
      return false;
    }
  }
}

import {AokanaStaticSpeaker, type AokanaSpeakerDescriptor} from './speaker.js';
import type {AokanaSpeakerModel} from './speaker-model.js';

/** CDSStreamSpeaker116650: actual independent event/refill worker over five blocks. */
export class AokanaStreamSpeaker extends AokanaStaticSpeaker {
  readonly blockCount = 5;
  blockMilliseconds = 100;
  blockFrames = 0;
  blockBytes = 0;
  private fillState = 1;
  private terminalBlock = 0xffffffff;
  private paused = 0;
  private savedCursor = 0;
  private readonly events = new Uint8Array(6);
  private unsubscribe: (() => void) | null = null;
  private cancel = true;
  private wake: (() => void) | null = null;
  private worker: Promise<void> | null = null;
  private failure: unknown = null;
  private readonly workerActor = {};
  protected override looping(): boolean {
    return true;
  }
  protected override makeDescriptor(model: AokanaSpeakerModel): AokanaSpeakerDescriptor {
    this.blockFrames = Math.floor(
      (Math.imul(this.blockMilliseconds, model.sampleRate) >>> 0) / 1000,
    );
    this.blockBytes = Math.imul(this.blockFrames, model.frameBytes) >>> 0;
    return this.formatDescriptor(
      model,
      Math.imul(this.blockCount, this.blockFrames) >>> 0,
      0x181e8,
    );
  }
  protected override async fill(): Promise<void> {
    const length = Math.imul(this.blockCount - 1, this.blockBytes) >>> 0;
    await this.readSpans(0, length);
    await this.publish(0, length);
  }
  override async attach(model: AokanaSpeakerModel): Promise<number> {
    const status = await super.attach(model);
    if (status !== 0) return status;
    const buffer = this.actualBuffer();
    this.events.fill(0);
    this.failure = null;
    this.unsubscribe = buffer.onNotification((event) => {
      if (event.index < 0 || event.index >= this.events.length)
        throw new RangeError('Aokana speaker notification exceeds event array');
      this.events[event.index] = 1;
      this.wake?.();
    });
    await buffer.command({
      kind: 'notifications',
      offsets: [
        0,
        this.blockBytes,
        2 * this.blockBytes,
        3 * this.blockBytes,
        4 * this.blockBytes,
        0xffffffff,
      ],
    });
    this.cancel = false;
    this.worker = this.runWorker().catch((error) => {
      this.failure = error;
    });
    this.paused = 0;
    this.savedCursor = 0;
    this.fillState = 1;
    return 0;
  }
  private async waitEvent(): Promise<number | null> {
    const take = (): number | null => {
      const index = this.events.indexOf(1);
      if (index < 0) return null;
      this.events[index] = 0;
      return index;
    };
    const ready = take();
    if (ready !== null) return ready;
    await new Promise<void>((resolve) => {
      let complete = false;
      const finish = (): void => {
        if (complete) return;
        complete = true;
        this.wake = null;
        resolve();
      };
      this.wake = finish;
    });
    return take();
  }
  private async runWorker(): Promise<void> {
    let previous = 0xffffffff;
    while (!this.cancel) {
      const event = await this.waitEvent();
      if (this.cancel) return;
      if (event === null) continue;
      // WaitForMultipleObjects already consumed this lowest auto-reset event.
      if (previous !== 0xffffffff && event !== (previous + 1) % this.blockCount) continue;
      previous = event;
      const block = event >= 1 && event <= this.blockCount ? event - 1 : this.blockCount - 1;
      const offset = Math.imul(block, this.blockBytes) >>> 0;
      const storage = this.storage;
      if (storage === null) throw new Error('Aokana stream refill has no actual ring');
      let frames = this.blockFrames;
      if (this.fillState === 1) frames = await this.readSpans(offset, this.blockBytes);
      else {
        storage.bytes.fill(0, offset, offset + this.blockBytes);
        storage.initialized.fill(1, offset, offset + this.blockBytes);
        if (this.terminalBlock === block) {
          // Write transport preserves the actual pre-stop memset; it is NOT native Unlock.
          await this.publish(offset, this.blockBytes);
          await this.stop(this.workerActor);
          throw new Error(
            'Aokana stream terminal stop leaves a native buffer lock outstanding; unsupported host lifetime',
          );
        }
      }
      if (frames < this.blockFrames) {
        const written = Math.imul(frames, this.actualModel().frameBytes) >>> 0;
        storage.bytes.fill(0, offset + written, offset + this.blockBytes);
        storage.initialized.fill(1, offset + written, offset + this.blockBytes);
        this.fillState = 2;
        this.terminalBlock = block;
      }
      await this.publish(offset, this.blockBytes);
      if (this.paused !== 0) {
        await this.actualBuffer().command({kind: 'stop'});
        this.savedCursor = (await this.actualBuffer().command({kind: 'status'})).byteCursor;
      }
    }
  }
  /** Observes the independent worker's retained failure without running refill work. */
  checkWorker(): void {
    if (this.failure !== null) throw this.failure;
  }
  override async start(attenuation: number): Promise<number> {
    this.checkWorker();
    const status = await super.start(attenuation);
    if (status === 0) this.paused = 0;
    return status;
  }
  override async pause(value: number): Promise<number> {
    this.checkWorker();
    if (!this.ready) return this.notReady();
    const buffer = this.actualBuffer(),
      state = await buffer.command({kind: 'status'});
    if (!state.playing && (value | 0) === 0) {
      await buffer.command({
        kind: 'seek',
        byteOffset: this.savedCursor - (this.savedCursor % this.blockCount),
      });
      await buffer.command({kind: 'play', loop: true});
    }
    this.paused = value | 0;
    return 0;
  }
  override async stop(actor?: object): Promise<number> {
    const status = await super.stop(actor);
    if (status === 0) {
      this.terminalBlock = 0xffffffff;
      this.fillState = 1;
    }
    return status;
  }
  override async detach(): Promise<AokanaSpeakerModel | null> {
    this.cancel = true;
    this.wake?.();
    if (this.worker !== null) {
      await this.worker;
      this.worker = null;
    }
    const model = await super.detach();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.events.fill(0);
    this.checkWorker();
    return model;
  }
}

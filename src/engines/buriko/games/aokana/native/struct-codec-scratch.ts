import {AokanaAsyncCriticalSection} from './async-critical-section.js';
import type {AokanaCodecPointer} from './codec-storage.js';

/** F9790/F9620/F9720 successful reservation profile; page size is explicitly selected. */
export class AokanaStructCodecScratch {
  readonly section = new AokanaAsyncCriticalSection();
  readonly capacity = 0x6000000;
  private reserved = true;
  private committed: AokanaCodecPointer | null = null;
  constructor(readonly pageSize = 4096) {
    if (!Number.isInteger(pageSize) || pageSize <= 0 || this.capacity % pageSize !== 0)
      throw new RangeError('Aokana codec scratch requires an explicit compatible page size');
    this.section.initialize();
  }
  commit(bytes: number, actor: object): AokanaCodecPointer | null {
    if (!this.reserved || this.section.owner !== actor)
      throw new Error('Aokana codec scratch commit requires its live owned reservation');
    if (this.committed !== null) throw new Error('Aokana codec scratch still has committed pages');
    bytes >>>= 0;
    const extent = Math.ceil(bytes / this.pageSize) * this.pageSize;
    if (bytes === 0 || extent > this.capacity) return null;
    try {
      this.committed = {bytes: new Uint8Array(extent), offset: 0};
    } catch (error) {
      if (error instanceof RangeError) return null;
      throw error;
    }
    return this.committed;
  }
  decommit(actor: object): void {
    if (this.section.owner !== actor) throw new Error('Aokana codec scratch decommit is not owned');
    this.committed = null;
  }
  async dispose(): Promise<void> {
    if (!this.reserved) return;
    const actor = {};
    await this.section.enter(actor);
    this.committed = null;
    this.reserved = false;
    this.section.leave(actor);
    this.section.dispose();
  }
}

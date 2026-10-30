import type {AsbTag} from '../../formats/artemis/asb.js';
import {artemisRevision} from './revision.js';

function state(value: number): number {
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff)
    throw new Error('Invalid Artemis native stage state');
  return value;
}

export interface ArtemisStageHost {
  /** Script field +0x3520; nonzero makes native flip return immediately. */
  captureMode(): number;
  /** Stage field +0x60, read at the time of the command. */
  transitionState(): number;
  clearTransitionRule(): void;
  /** Native transition layer virtual +0xe0 receives uint32 -1 (field +0x168). */
  resetTransitionLayerValue(value: number): void;
  setTransitionState(value: number): void;
  markSceneDirty(): void;
  /** Commit the actual scene/resource owner, not only a command cursor. */
  commitLayers(): void;
  /** Stage field +0xd0; nonzero is replaced with 2 after commit. */
  refreshState(): number;
  setRefreshState(value: number): void;
}

/** Native flip entry 0x1400e10a0 and stage commit helper 0x14014f420.
 * Presentation/scheduling and transition layer services remain required effects.
 */
export class ArtemisStage {
  constructor(
    executableSha256: string,
    private readonly host: ArtemisStageHost,
  ) {
    artemisRevision(executableSha256);
  }
  dispatch(tag: AsbTag): boolean {
    if (tag.name !== 'flip') return false;
    if (state(this.host.captureMode()) !== 0) return true;
    this.commit();
    return true;
  }
  /** 0x14014f420, also called by trans and its completion callback 0x1400b7440. */
  commit(): void {
    if (state(this.host.transitionState()) === 2) {
      this.host.clearTransitionRule();
      this.host.resetTransitionLayerValue(0xffffffff);
    }
    this.host.setTransitionState(0);
    this.host.markSceneDirty();
    this.host.commitLayers();
    if (state(this.host.refreshState()) !== 0) this.host.setRefreshState(2);
  }
}

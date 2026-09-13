import {AokanaDisplayManager, AOKANA_DISPLAY_POOLS} from './display-manager.js';
import {AokanaTextLayoutState} from './text-layout-state.js';

/** The one 1d1d40/1d1d14 pair shared by all CDspObjWindow draw virtuals. */
export class AokanaWindowDisplayState {
  enabled = 0;
  transparency = 0;

  constructor(
    readonly manager: AokanaDisplayManager,
    readonly textLayout = new AokanaTextLayoutState(manager.surfaces),
  ) {}

  /** 083460/0690c0/0690b0 publish both DWORDs before invalidating the sixteen slots. */
  set(enabled: number, transparency: number): void {
    this.enabled = enabled >>> 0;
    this.transparency = transparency >>> 0;
    const pool = AOKANA_DISPLAY_POOLS.window;
    for (let index = 0; index < pool.capacity; index++)
      this.manager.find('window', (pool.prefix + index) >>> 0)?.invalidate();
  }
}

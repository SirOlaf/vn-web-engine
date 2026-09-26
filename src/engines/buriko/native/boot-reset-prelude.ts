import {BurikoBootTerminationGate} from './boot-termination-gate.js';
import {BurikoProductionDisplayResourceGraph} from './production-display-resource-graph.js';

/** The first six ECB90 reset calls, before the asynchronous audio reset.
 * This owner does not authorize a program load or complete the outer reset.
 */
export class BurikoBootResetPrelude {
  private phase: 'idle' | 'prefix' | 'audio-running' | 'audio-complete' = 'idle';

  constructor(
    readonly graph: BurikoProductionDisplayResourceGraph,
    readonly gate: BurikoBootTerminationGate,
  ) {
    if (
      !(graph instanceof BurikoProductionDisplayResourceGraph) ||
      !(gate instanceof BurikoBootTerminationGate) ||
      gate.loading !== graph.resource.loading
    )
      throw new TypeError('Buriko reset prelude requires the shared production graph and gate');
  }

  /** Consume the restart latch before applying ECB90 calls FF520 through 0375D0. */
  run(): 'reset-prefix-complete' | null {
    if (this.phase === 'audio-running') throw new Error('Buriko reset audio is still running');
    if (!this.gate.beginOuterReset()) return null;
    this.phase = 'idle';
    this.graph.host.setClosePolicy(1);
    this.graph.controller.configureModeToggle(0, null);
    this.graph.display.presentationEnabled = 1;
    this.graph.frames.setFrameFrequency(0xfa);
    this.graph.surfaces.preserveImageIds = 0;
    this.graph.resource.loading.preloaded.clear();
    this.phase = 'prefix';
    return 'reset-prefix-complete';
  }

  /** ECB90 calls 7–8; the worker and audio channels were started by global setup. */
  async resetAudio(actor = this.graph.allocator.currentActor): Promise<'audio-reset-complete'> {
    const {channels, worker} = this.graph.resource;
    if (
      this.phase !== 'prefix' ||
      !worker.isRunning ||
      (channels.flags & 3) !== 3 ||
      channels.window !== this.graph.host
    )
      throw new Error('Buriko reset audio requires active graph channels after the reset prefix');
    this.phase = 'audio-running';
    await channels.initializeMasters(actor);
    await channels.clearStaticHeaders(actor);
    this.phase = 'audio-complete';
    return 'audio-reset-complete';
  }
}

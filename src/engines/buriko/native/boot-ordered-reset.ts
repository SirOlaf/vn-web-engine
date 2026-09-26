import {BurikoBootInputNotificationResetSegment} from './boot-input-notification-reset-segment.js';
import {BurikoBootInteractionResetSegment} from './boot-interaction-reset-segment.js';
import {BurikoBootResetPrelude} from './boot-reset-prelude.js';
import {BurikoProductionInterpreter} from './production-interpreter.js';
import {BurikoProductionVmCore} from './production-vm-core.js';

export interface BurikoBootNames {
  readonly archive: Uint8Array;
  readonly module: Uint8Array;
}

/** ECB90's ordered per-program reset over the interpreter's exact graph and data owners. */
export class BurikoBootOrderedReset {
  readonly prelude: BurikoBootResetPrelude;
  readonly interaction: BurikoBootInteractionResetSegment;
  readonly input: BurikoBootInputNotificationResetSegment;

  constructor(
    readonly core: BurikoProductionVmCore,
    readonly interpreter: BurikoProductionInterpreter,
  ) {
    if (!(core instanceof BurikoProductionVmCore) || interpreter.core !== core)
      throw new TypeError('Buriko ordered reset requires the bound production interpreter');
    this.prelude = new BurikoBootResetPrelude(core.graph, core.gate);
    this.interaction = new BurikoBootInteractionResetSegment(core.graph);
    this.input = new BurikoBootInputNotificationResetSegment(core.graph);
  }

  /** Returns null only when ECB90's restart latch was not set. */
  async run(actor = this.core.graph.allocator.currentActor): Promise<BurikoBootNames | null> {
    if (this.prelude.run() === null) return null;
    const {core, interpreter} = this;
    const {graph, data} = core;
    const releaseMovieSourceReset = await graph.beginMovieSourceReset();
    try {
      // Fence source documents before pooled BP storage can be released.
      // Calls 7–10: live channel reset, pooled allocations and FF registrations.
      await this.prelude.resetAudio(actor);
      core.memory.clearPooled();
      interpreter.extensions.clear();
      // Calls 11–19 retain the exact knob, capture, wait and input owners.
      this.interaction.run();
      this.input.run();
      // B6E50, 038480 and B60E0: reuse the manager and fixed surface slots.
      graph.manager.resetForProgram(graph.windowState);
      graph.surfaces.releaseAllForProgram(actor);
      graph.movies.clear();
      await graph.movies.joinAllRetirements();
      graph.compositor.importMatteColor = 0;
      // C1C30 through F1F30: BP data and display registries in native order.
      data.save.cipher = 1;
      graph.input.enabled = 1;
      graph.input.skipAllowed = 1;
      graph.input.skipForced = 0;
      data.backlog.reset(0);
      data.histories.clear();
      data.strings.reset(0);
      data.maps.clear();
      data.records.clear();
      data.procedures.clear();
      graph.particles.clearRefreshScheduleForProgram();
      // BC240 through BC250 end with a fresh snapshot of the selected boot names.
      graph.resource.resources.resetDirectorySearchForProgram();
      data.resetSelectionForegroundDefaults(graph, core.memory);
      graph.droppedFiles.setEnabled(0);
      data.resetProcedureExecutionForProgram(graph, core.memory);
      graph.manager.redraw.configureAutomatic(1, 0);
      core.frameHistory.clear();
      const archive = new Uint8Array(784);
      const module = new Uint8Array(784);
      graph.launchSelection.copyBootNames(archive, module);
      return {archive, module};
    } finally {
      releaseMovieSourceReset();
    }
  }
}

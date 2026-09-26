import {AokanaProductionDisplayResourceGraph} from './production-display-resource-graph.js';
import {AokanaSpriteTargets} from './sprite-targets.js';

/** ECB90 calls 11–16, after pooled-memory and FF-extension clearing.
 * The remaining outer reset and program boot belong to a later coordinator.
 */
export class AokanaBootInteractionResetSegment {
  constructor(readonly graph: AokanaProductionDisplayResourceGraph) {
    if (
      !(graph instanceof AokanaProductionDisplayResourceGraph) ||
      !(graph.spriteTargets instanceof AokanaSpriteTargets) ||
      graph.spriteTargets.manager !== graph.manager ||
      graph.spriteTargets.input !== graph.input ||
      graph.knobs.manager !== graph.manager ||
      graph.knobs.input !== graph.input ||
      graph.receiver.knobs !== graph.knobs ||
      graph.receiver.waits !== graph.waits
    )
      throw new TypeError('Aokana interaction reset requires the shared production owners');
  }

  run(): 'interaction-reset-segment-complete' {
    this.graph.knobs.clearPointerReceivers();
    this.graph.knobs.clearWheelReceivers();
    this.graph.knobs.exchangeWheelMode(1);
    this.graph.spriteTargets.clear();
    this.graph.input.resetCaptures();
    this.graph.waits.clear();
    return 'interaction-reset-segment-complete';
  }
}

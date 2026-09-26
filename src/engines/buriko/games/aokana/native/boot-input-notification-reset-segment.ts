import {AokanaProductionDisplayResourceGraph} from './production-display-resource-graph.js';

/** ECB90's three calls immediately after the interaction/wait reset.
 * The display and surface restart reset is a separate later segment. */
export class AokanaBootInputNotificationResetSegment {
  constructor(readonly graph: AokanaProductionDisplayResourceGraph) {
    if (
      !(graph instanceof AokanaProductionDisplayResourceGraph) ||
      graph.receiver.notifications !== graph.notifications ||
      graph.receiver.input !== graph.input ||
      graph.messages.input !== graph.input
    )
      throw new TypeError('Aokana input reset requires the shared production owners');
  }

  run(): 'input-notification-reset-segment-complete' {
    this.graph.notifications.clear();
    this.graph.input.clearAllKeyRecords();
    this.graph.input.mouseButtonMode = 0;
    return 'input-notification-reset-segment-complete';
  }
}

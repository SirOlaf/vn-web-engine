import {BurikoProductionDisplayResourceGraph} from './production-display-resource-graph.js';

/** ECB90's three calls immediately after the interaction/wait reset.
 * The display and surface restart reset is a separate later segment. */
export class BurikoBootInputNotificationResetSegment {
  constructor(readonly graph: BurikoProductionDisplayResourceGraph) {
    if (
      !(graph instanceof BurikoProductionDisplayResourceGraph) ||
      graph.receiver.notifications !== graph.notifications ||
      graph.receiver.input !== graph.input ||
      graph.messages.input !== graph.input
    )
      throw new TypeError('Buriko input reset requires the shared production owners');
  }

  run(): 'input-notification-reset-segment-complete' {
    this.graph.notifications.clear();
    this.graph.input.clearAllKeyRecords();
    this.graph.input.mouseButtonMode = 0;
    return 'input-notification-reset-segment-complete';
  }
}

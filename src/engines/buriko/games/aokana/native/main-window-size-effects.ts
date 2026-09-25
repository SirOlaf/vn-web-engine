import {AokanaProductionDisplayResourceGraph} from './production-display-resource-graph.js';
import {aokanaWindowPositionAllowed} from './browser-main-window.js';

/** The initialized-engine effects before FF770's WM_SIZE minimize menu/input tail.
 * This lower does not publish 1E8B78, dispatch a message, or minimize the host. */
export class AokanaMainWindowSizeEffects {
  constructor(readonly graph: AokanaProductionDisplayResourceGraph) {
    if (
      !(graph instanceof AokanaProductionDisplayResourceGraph) ||
      graph.resource.channels.actors !== graph.allocator ||
      graph.resource.channels.locks !== graph.manager.locks ||
      !graph.input.usesClock(graph.clock) ||
      graph.messages.input !== graph.input ||
      graph.host.display !== graph.input.display ||
      graph.controller.fullscreenMovie !== graph.fullscreenMovie ||
      graph.mfMovieVolume.fullscreen !== graph.fullscreenMovie ||
      !graph.messages.hasMainReceiver(graph.receiver)
    )
      throw new Error('Aokana size effects require the shared production window/audio owners');
  }

  /** FF770 wParam=1, after broadcast and 1E8B78 admission, before the menu/input tail. */
  async runInitializedMinimize(actor = this.graph.allocator.currentActor): Promise<void> {
    const {graph} = this;
    if (
      !graph.initialized.initialized ||
      (graph.resource.channels.flags & 3) !== 3 ||
      graph.resource.channels.window !== graph.host ||
      graph.messages.mainTarget() === null
    )
      throw new Error('Aokana initialized size effects require live shared channels and window');
    await graph.resource.channels.mute(actor);
    graph.traditionalMovieAudio.setSuppression(1);
    graph.mfMovieVolume.applyWindowSuppression(1);
    graph.clock.beginSuspension(false);
  }

  /** FF770 wParam=0, before the unconditional restore menu/input tail. */
  async runInitializedRestore(
    actor = this.graph.allocator.currentActor,
    width = 0,
    height = 0,
  ): Promise<void> {
    const {graph} = this;
    if (
      !graph.initialized.initialized ||
      (graph.resource.channels.flags & 3) !== 3 ||
      graph.resource.channels.window !== graph.host ||
      graph.messages.mainTarget() === null
    )
      throw new Error('Aokana initialized size effects require live shared channels and window');
    await graph.resource.channels.unmute(actor);
    graph.traditionalMovieAudio.setSuppression(0);
    graph.mfMovieVolume.applyWindowSuppression(0);
    if (graph.display.windowMoveImmediate !== 0 && graph.display.fullscreen !== 1) {
      const [x, y] = graph.host.readRestoredOuterScreenRectangle();
      if (!aokanaWindowPositionAllowed(graph.display, x, y)) graph.host.center();
      if (graph.fullscreenMovie.query() === 0) {
        const control = graph.fullscreenMovie.displayControl;
        if (control === null)
          throw new Error('Aokana initialized MF WM_SIZE restore requires a retained display control');
        control.resize(width & 0xffff, height & 0xffff);
      }
    }
  }
}

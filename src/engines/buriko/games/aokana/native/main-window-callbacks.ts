import {AokanaBrowserMainWindow, type AokanaMainWindowCallbacks} from './browser-main-window.js';
import {AokanaDisplayController} from './display-controller.js';
import {AokanaDisplayFrames} from './display-frames.js';
import {AokanaMainWindowMessageReceiver} from './main-window-messages.js';
import type {AokanaNativeDisplayState} from './display-state.js';

/** The main HWND's callback edge, bound after its controller and frames exist. */
export class AokanaMainWindowCallbackBinding implements AokanaMainWindowCallbacks {
  private controller: AokanaDisplayController | null = null;
  private frames: AokanaDisplayFrames | null = null;
  private readyReceiver: AokanaMainWindowMessageReceiver | null = null;

  constructor(readonly display: AokanaNativeDisplayState) {}

  bind(
    host: AokanaBrowserMainWindow,
    controller: AokanaDisplayController,
    frames: AokanaDisplayFrames,
  ): void {
    if (this.controller !== null || this.frames !== null)
      throw new Error('Aokana main-window callbacks are already bound');
    if (
      !(host instanceof AokanaBrowserMainWindow) ||
      !(controller instanceof AokanaDisplayController) ||
      !(frames instanceof AokanaDisplayFrames) ||
      host.callbacks !== this ||
      host.display !== this.display ||
      controller.host !== host ||
      controller.manager !== host.manager ||
      controller.device.canvas !== host.surface ||
      controller.inline.host !== host ||
      controller.inline.messages !== controller.messages ||
      frames.manager !== host.manager ||
      frames.device !== controller.device ||
      frames.inline !== controller.inline ||
      frames.fullscreenMovie !== controller.fullscreenMovie ||
      frames.children.document !== host.document ||
      frames.children.parent !== host.parent ||
      frames.children.desktopCanvas !== host.surface ||
      frames.children.surfaces !== host.manager.surfaces ||
      frames.children.messages !== controller.messages ||
      (this.readyReceiver !== null &&
        (this.readyReceiver.window !== host ||
          this.readyReceiver.messages !== controller.messages ||
          this.readyReceiver.lifecycle?.inline !== controller.inline))
    )
      throw new Error(
        'Aokana main-window callbacks require the shared host, controller and frames',
      );
    this.controller = controller;
    this.frames = frames;
  }

  bindReadyReceiver(
    host: AokanaBrowserMainWindow,
    receiver: AokanaMainWindowMessageReceiver,
  ): void {
    if (this.readyReceiver !== null)
      throw new Error('Aokana main-window ready receiver is already bound');
    if (
      !(host instanceof AokanaBrowserMainWindow) ||
      !(receiver instanceof AokanaMainWindowMessageReceiver) ||
      host.callbacks !== this ||
      host.display !== this.display ||
      receiver.window !== host ||
      receiver.lifecycle?.host !== host ||
      receiver.lifecycle.inline.messages !== receiver.messages ||
      receiver.input.display !== this.display ||
      receiver.messages.input !== receiver.input ||
      !receiver.messages.hasMainReceiver(receiver) ||
      (this.controller !== null &&
        (this.controller.host !== host ||
          this.controller.messages !== receiver.messages ||
          this.controller.inline !== receiver.lifecycle.inline))
    )
      throw new Error('Aokana ready receiver requires the shared main-window owners');
    this.readyReceiver = receiver;
  }

  /** The receiver publishes 1e8d00 from real WM_CREATE/WM_DESTROY. */
  isReady(): boolean {
    return this.readyReceiver?.isReady() ?? false;
  }

  presentTransient(x: number, y: number): Promise<number> {
    if (this.frames === null) throw new Error('Aokana main-window frames are not bound');
    return this.frames.presentTransient(x, y);
  }

  inlinePaintSuppressed(): boolean {
    return this.display.inlinePaintSuppression !== 0;
  }

  geometryChanged(y: number): void {
    if (this.controller === null) throw new Error('Aokana main-window controller is not bound');
    this.controller.noteGeometryChange(y);
  }
}

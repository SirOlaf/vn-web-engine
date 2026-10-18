/**
 * The presentation side of a Win32 window manager. `user32.dll` keeps every window's state
 * (classes, styles, geometry, text, the window tree, control state); the host decides what the
 * page shows of it and feeds user input back. A headless host shows nothing: windows keep
 * their state, modal loops wait for `EndDialog` from code.
 */
import type {WindowsMessageBoxHost} from './windows-message-box.js';
import {
  LEGACY_SUBSYSTEM_FRAME_METRICS,
  WindowsTopLevelWindow,
  type WindowsFrameMetrics,
} from './windows-top-level-window.js';

/** What a host sees of a window when the window tree changes. */
export interface WindowsUserWindowView {
  readonly hwnd: number;
  readonly className: string;
  readonly parent: number;
  readonly owner: number;
  readonly style: number;
  readonly exStyle: number;
  readonly text: string;
  readonly id: number;
  /** Window rectangle: screen coordinates for top-level windows, parent client otherwise. */
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly visible: boolean;
  readonly enabled: boolean;
}

export interface WindowsUserInterfaceHost {
  readonly metrics: WindowsFrameMetrics;
  /** The primary screen size (`SM_CXSCREEN`, `SM_CYSCREEN`). */
  readonly screen: {readonly width: number; readonly height: number};
  /**
   * The platform state of a new top-level window with the given client size. A browser host
   * passes a `WindowsTopLevelWindowHost` that mirrors it into the page.
   */
  createTopLevelWindow(
    hwnd: number,
    caption: string,
    clientWidth: number,
    clientHeight: number,
    style: number,
    exStyle: number,
  ): WindowsTopLevelWindow;
  /** A window was created, changed (geometry, text, state) or destroyed. */
  windowCreated?(view: WindowsUserWindowView): void;
  windowChanged?(view: WindowsUserWindowView): void;
  windowDestroyed?(hwnd: number): void;
  /** Runs `task` from the message loop (posted messages, deferred painting). */
  post(task: () => void): void;
  /** The cursor in screen coordinates. */
  cursorPos(): {x: number; y: number};
  setCursorPos?(x: number, y: number): void;
  /**
   * `GetMessageExtraInfo` of the input being delivered: pen and touch input that Windows turns
   * into mouse messages carries `0xFF515700` in the upper 24 bits (`MI_WP_SIGNATURE`).
   */
  messageExtraInfo?(): number;
  /** `MessageBoxW`; without it a message box cannot be shown and fails. */
  readonly messageBox?: WindowsMessageBoxHost;
}

/** A host without a page. */
export function headlessUserInterfaceHost(
  post: (task: () => void) => void = (task) => void setTimeout(task, 0),
): WindowsUserInterfaceHost {
  return {
    metrics: LEGACY_SUBSYSTEM_FRAME_METRICS,
    screen: {width: 1920, height: 1080},
    createTopLevelWindow: (_hwnd, caption, w, h, style, exStyle) =>
      new WindowsTopLevelWindow(caption, w, h, style, exStyle),
    post,
    cursorPos: () => ({x: 0, y: 0}),
  };
}

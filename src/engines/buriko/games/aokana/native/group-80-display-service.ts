import {pop32, push32} from '../bp/state.js';
import type {AokanaDisplayController} from './display-controller.js';
import type {AokanaEngineErrors} from './engine-errors.js';
import type {AokanaNativeSlotDefinition} from './types.js';

/** Script display services use the actual device/controller and authoritative geometry globals. */
export function createGroup80DisplayService(
  controller: AokanaDisplayController,
  errors: AokanaEngineErrors,
): AokanaNativeSlotDefinition[] {
  const display = controller.display;
  return [
    {
      primary: 0x80,
      secondary: 0x60,
      nativeAddress: 0x1400e86b0,
      name: 'ConfigureDisplay',
      execute: async (h): Promise<0> => {
        const fullscreen = pop32(h.thread),
          parameter = pop32(h.thread),
          preset = pop32(h.thread);
        if (parameter > 1)
          return errors.threadFatal(
            h.thread,
            h.diagnostics,
            errors.files.text.encodeWide('無効なピクセルモードが設定されました', 0),
          );
        if (preset >= 16)
          return errors.threadFatal(
            h.thread,
            h.diagnostics,
            errors.files.text.encodeWide('無効なスクリーンサイズが設定されました', 0),
          );
        await controller.reconfigure(preset, parameter, fullscreen, null, 0);
        display.setAspectSize(0, 0);
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x61,
      nativeAddress: 0x1400e8690,
      name: 'ReadDisplayFullscreen',
      execute: (h) => {
        push32(h.thread, controller.device.fullscreen);
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x63,
      nativeAddress: 0x1400e8610,
      name: 'SetDisplayMode',
      execute: (h) => {
        display.displayMode = Number(pop32(h.thread) === 0);
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x6e,
      nativeAddress: 0x1400e83c0,
      name: 'SetDisplayVerticalSynchronization',
      execute: async (h): Promise<0> => {
        display.verticalSynchronization = pop32(h.thread);
        await controller.reconfigure(
          display.selectedSizePreset,
          display.selectedWindowParameter,
          controller.device.fullscreen,
          null,
          0,
        );
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x6f,
      nativeAddress: 0x1400e8390,
      name: 'ReadDesktopAspectDifference',
      execute: (h) => {
        push32(h.thread, display.desktopAspectDiffers());
        return 0;
      },
    },
  ];
}

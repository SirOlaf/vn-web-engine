import {pointerView} from '../bp/memory.js';
import {pop32, push32} from '../bp/state.js';
import type {BurikoDisplayController} from './display-controller.js';
import {readBurikoDisplayAdapter, setBurikoRequestedClientSize} from './display-services.js';
import type {BurikoNativeSlotDefinition} from './types.js';

export function createGroup81Device(
  controller: BurikoDisplayController,
): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x81,
      secondary: 0x0b,
      nativeAddress: 0x1400ec660,
      name: 'ReadDisplayAdapter',
      execute: (h) => {
        h.memory.resolve(h.thread, pop32(h.thread)); // Native resolves the unused third output.
        const version = h.memory.resolve(h.thread, pop32(h.thread)),
          description = h.memory.resolve(h.thread, pop32(h.thread));
        readBurikoDisplayAdapter(controller.display, description!, version!);
        return 0;
      },
    },
    {
      primary: 0x81,
      secondary: 0x0e,
      nativeAddress: 0x1400ec530,
      name: 'ReadAdjustedDesktopSize',
      execute: (h) => {
        const output = h.memory.resolve(h.thread, pop32(h.thread));
        controller.adapters.queryDesktopMode();
        const [width, height] = controller.display.adjustedDesktopSize();
        pointerView(output!, 4).setUint32(0, width, true);
        pointerView({bytes: output!.bytes, offset: output!.offset + 4}, 4).setUint32(
          0,
          height,
          true,
        );
        return 0;
      },
    },
    {
      primary: 0x81,
      secondary: 0x64,
      nativeAddress: 0x1400eb350,
      name: 'SetRequestedClientSize',
      execute: async (h): Promise<0> => {
        const height = pop32(h.thread),
          width = pop32(h.thread);
        await setBurikoRequestedClientSize(controller, width, height, null);
        return 0;
      },
    },
    {
      primary: 0x81,
      secondary: 0x66,
      nativeAddress: 0x1400eb310,
      name: 'SetWindowStyleOption',
      execute: (h) => {
        controller.setWindowStyle(pop32(h.thread));
        return 0;
      },
    },
    {
      primary: 0x81,
      secondary: 0x6d,
      nativeAddress: 0x1400eb1f0,
      name: 'ReadPixelShaderVersion',
      execute: (h) => {
        push32(h.thread, controller.device.adapter.pixelShaderVersion & 0xffff);
        return 0;
      },
    },
    {
      primary: 0x81,
      secondary: 0x6f,
      nativeAddress: 0x1400eb1a0,
      name: 'SetPresentationFilter',
      execute: (h) => {
        push32(h.thread, controller.device.setFilter(pop32(h.thread)));
        return 0;
      },
    },
  ];
}

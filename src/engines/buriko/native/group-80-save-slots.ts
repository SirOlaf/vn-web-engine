import {pop32, push32} from '../bp/state.js';
import type {BurikoSaveSlots} from './save-slots.js';
import {textBytes} from './text.js';
import type {BurikoNativeSlotDefinition} from './types.js';

export function createGroup80SaveSlots(service: BurikoSaveSlots): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x80,
      secondary: 0x74,
      nativeAddress: 0x1400e82d0,
      name: 'SetSaveSlotCipher',
      execute: (h) => {
        service.cipher = pop32(h.thread);
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x78,
      nativeAddress: 0x1400e8250,
      name: 'SaveSlot',
      execute: async (h): Promise<0> => {
        const comment = h.memory.resolve(h.thread, pop32(h.thread)),
          slot = pop32(h.thread);
        if (comment === null) throw new RangeError('Buriko save wrapper consumed a null comment');
        if (textBytes(comment).length >= 40)
          return service.resources.errors.threadFatal(
            h.thread,
            h.diagnostics,
            service.resources.files.text.encodeWide(
              '付加情報文字列が長すぎます\n\n文字列は39文字以内である必要があります',
              1,
            ),
          );
        await service.save(slot, comment);
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x79,
      nativeAddress: 0x1400e8130,
      name: 'LoadSlotPreserveGlobalPrefix',
      execute: async (h): Promise<0> => {
        const globals = service.memory.globalMemory;
        if (globals.length < 0x400)
          throw new RangeError('Buriko save wrapper reads beyond its global arena');
        const prefix = globals.slice(0, 0x400);
        const slot = pop32(h.thread);
        push32(h.thread, await service.load(slot));
        service.memory.globalMemory.set(prefix);
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x7a,
      nativeAddress: 0x1400e80e0,
      name: 'ReadSaveSlotHeader',
      execute: async (h): Promise<0> => {
        const slot = pop32(h.thread),
          destination = h.memory.resolve(h.thread, pop32(h.thread));
        push32(h.thread, await service.header(destination, slot));
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x7b,
      nativeAddress: 0x1400e80b0,
      name: 'ValidateSaveSlot',
      execute: async (h): Promise<0> => {
        push32(h.thread, await service.validate(pop32(h.thread)));
        return 0;
      },
    },
  ];
}

import {pop32, push32} from '../bp/state.js';
import type {BurikoBpPointer} from '../bp/memory.js';
import type {BurikoPersistence} from './persistence.js';
import {BurikoUndefinedResourceRead} from './resource-memory.js';
import type {BurikoBpOpcodeContext, BurikoNativeSlotDefinition} from './types.js';

function popPointer(h: BurikoBpOpcodeContext): BurikoBpPointer | null {
  return h.memory.resolve(h.thread, pop32(h.thread));
}
function validate(
  persistence: BurikoPersistence,
  h: BurikoBpOpcodeContext,
  offset: number,
  length: number,
): Promise<never> | null {
  const hex = (offset >>> 0).toString(16).toUpperCase().padStart(8, '0');
  const message =
    offset > 0xfffff
      ? `無効なオフセット [ $${hex} ] が指定されました`
      : (offset + length) >>> 0 <= 0x100000 && (length - 1) >>> 0 < 0x100000
        ? null
        : `オフセット [ $${hex} ] から無効なデータサイズ [ ${length | 0} ] が指定されました`;
  if (message !== null)
    return persistence.resources.errors.threadFatal(
      h.thread,
      h.diagnostics,
      persistence.resources.files.text.encodeWide(message, 1),
    );
  return null;
}

export function createGroup80Persistence(
  persistence: BurikoPersistence,
): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x80,
      secondary: 0x39,
      nativeAddress: 0x1400e91d0,
      name: 'SetSaveRoot',
      execute: async (h): Promise<0> => {
        push32(h.thread, await persistence.root.set(popPointer(h)));
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x80,
      nativeAddress: 0x1400e8040,
      name: 'LoadGlobalDatabase',
      execute: async (h): Promise<0> => {
        const result = await persistence.load();
        if (result.position === null)
          throw new BurikoUndefinedResourceRead(
            'Buriko GDB wrapper pushes unwritten stack coordinates',
          );
        push32(h.thread, result.position[0]);
        push32(h.thread, result.position[1]);
        push32(
          h.thread,
          result.status === 0x80000001 ? 1 : result.status === 0x80000002 ? 2 : result.status,
        );
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x81,
      nativeAddress: 0x1400e8010,
      name: 'SaveGlobalDatabase',
      execute: async (h): Promise<0> => {
        push32(h.thread, await persistence.save());
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x82,
      nativeAddress: 0x1400e7f50,
      name: 'WritePersistentBytes',
      execute: (h) => {
        const length = pop32(h.thread),
          source = popPointer(h),
          offset = pop32(h.thread);
        const failure = validate(persistence, h, offset, length);
        if (failure !== null) return failure;
        persistence.persistent.write(offset, source, length);
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x83,
      nativeAddress: 0x1400e7e80,
      name: 'ReadPersistentBytes',
      execute: (h) => {
        const length = pop32(h.thread),
          offset = pop32(h.thread),
          destination = popPointer(h);
        const failure = validate(persistence, h, offset, length);
        if (failure !== null) return failure;
        persistence.persistent.read(destination, offset, length);
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x84,
      nativeAddress: 0x1400e7e50,
      name: 'AppendReservedString',
      execute: (h) => {
        persistence.strings.append(0x80000000, popPointer(h));
        push32(h.thread, 1);
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x85,
      nativeAddress: 0x1400e7e20,
      name: 'ContainsReservedString',
      execute: (h) => {
        push32(h.thread, Number(persistence.strings.contains(0x80000000, popPointer(h)) === 0));
        return 0;
      },
    },
  ];
}

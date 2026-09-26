import {pop32, push32} from '../bp/state.js';
import type {BurikoBpPointer} from '../bp/memory.js';
import type {BurikoFileAssociations} from './file-associations.js';
import type {BurikoBpOpcodeContext, BurikoNativeSlotDefinition} from './types.js';

function pointer(context: BurikoBpOpcodeContext): BurikoBpPointer {
  const value = context.memory.resolve(context.thread, pop32(context.thread));
  if (value === null) throw new Error('Buriko file association reads a null native string');
  return value;
}

/** 80:FC retains the five native address-pop order and one pushed status. */
export function createGroup80FileAssociations(
  service: BurikoFileAssociations,
): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x80,
      secondary: 0xfc,
      nativeAddress: 0x1400e5f20,
      name: 'RegisterFileAssociation',
      execute: async (context): Promise<0> => {
        const command = pointer(context),
          icon = pointer(context),
          description = pointer(context),
          className = pointer(context),
          extension = pointer(context);
        push32(
          context.thread,
          await service.register(extension, className, description, icon, command),
        );
        return 0;
      },
    },
  ];
}

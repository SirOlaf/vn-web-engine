import {pop32} from '../bp/state.js';
import type {AokanaProductIdentity} from './product-identity.js';
import {copyText} from './text.js';
import type {AokanaNativeSlotDefinition} from './types.js';

export function createGroup80ProductIdentity(
  identity: AokanaProductIdentity,
): AokanaNativeSlotDefinition[] {
  return [
    {
      primary: 0x80,
      secondary: 0xe8,
      nativeAddress: 0x1400e6a30,
      name: 'CopyProductIdentifier',
      execute: (h) => {
        const output = h.memory.resolve(h.thread, pop32(h.thread)),
          source = identity.pointer();
        if (output === null) throw new Error('Aokana product identifier writes a null output');
        copyText(output, source);
        return 0;
      },
    },
  ];
}

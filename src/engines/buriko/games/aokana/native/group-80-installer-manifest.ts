import {pointerView, type AokanaBpPointer} from '../bp/memory.js';
import {pop32, push32} from '../bp/state.js';
import type {AokanaInstallerManifestActions} from './installer-manifest-actions.js';
import {textBytes} from './text.js';
import type {AokanaBpOpcodeContext, AokanaNativeSlotDefinition} from './types.js';
import {resolveAokanaAddressArray} from './vm-address-array.js';

function argumentsFor(context: AokanaBpOpcodeContext): {
  root: Uint8Array;
  entries: Uint8Array[];
} {
  const {thread, memory} = context;
  const addresses = memory.resolve(thread, pop32(thread));
  const root = memory.resolve(thread, pop32(thread));
  if (addresses === null || root === null)
    throw new Error('Aokana installer manifest dereferences a null argument');
  let count = 0;
  while (pointerView(addresses, (count + 1) * 4).getUint32(count * 4, true) !== 0) count++;
  const resolved = resolveAokanaAddressArray(memory, thread, addresses, count + 1);
  const entries = resolved.slice(0, count).map((pointer: AokanaBpPointer | null) => {
    if (pointer === null) throw new Error('Aokana installer manifest has a null list entry');
    return textBytes(pointer, true).slice();
  });
  return {root: textBytes(root, true).slice(), entries};
}

/** E6290/E61D0 resolve the terminated BP address array before entering their file lowers. */
export function createGroup80InstallerManifest(
  actions: AokanaInstallerManifestActions,
): AokanaNativeSlotDefinition[] {
  return [
    {
      primary: 0x80,
      secondary: 0xf4,
      nativeAddress: 0x1400e6290,
      name: 'DeleteUnlistedInstalledFiles',
      execute: async (context): Promise<0> => {
        const {root, entries} = argumentsFor(context);
        push32(context.thread, await actions.deleteUnlisted(root, entries));
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0xf5,
      nativeAddress: 0x1400e61d0,
      name: 'MergeUninstallList',
      execute: async (context): Promise<0> => {
        const {root, entries} = argumentsFor(context);
        push32(context.thread, Number(await actions.mergeUninstallList(root, entries)));
        return 0;
      },
    },
  ];
}

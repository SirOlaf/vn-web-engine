import type {AokanaDisplayObject} from './display-object.js';
import type {AokanaDisplayManager} from './display-manager.js';
import type {AokanaSelectionDialog} from './selection-dialog.js';
import type {AokanaNativeSlotDefinition} from './types.js';
import {writeText} from './text.js';
const labels = [
  'BG',
  'Map',
  'Sprite',
  'Window',
  'PrtclScrn',
  'RainScrn',
  'Effector',
  'Filter',
  'Virtual',
  'Group',
  'Knob',
] as const;
// Exact CP932180418; immutable literal prompt, independent of the engine caption buffer.
const prompt = Uint8Array.from([
  0x95, 0x5c, 0x8e, 0xa6, 0x83, 0x49, 0x83, 0x75, 0x83, 0x57, 0x83, 0x46, 0x83, 0x4e, 0x83, 0x67,
  0x88, 0xea, 0x97, 0x97, 0,
]);
/**AB7A0 preserves two separate virtual+B0 reads, followed by nonvirtual category. */
export function formatAokanaObjectList(objects: readonly AokanaDisplayObject[]): Uint8Array {
  const bytes = new Uint8Array((objects.length << 6) >>> 0);
  let offset = 0;
  for (const object of objects) {
    const decimal = object.getLayer() | 0,
      hex = object.getLayer() >>> 0,
      category = object.category >>> 0;
    const label = labels[category];
    if (label === undefined)
      throw new Error('Aokana object diagnostic indexes outside its native category table');
    const line = new TextEncoder().encode(
      `${label} - $${hex.toString(16).toUpperCase().padStart(8, '0')}( ${decimal} )\n\0`,
    );
    writeText({bytes, offset}, line);
    offset += line.length - 1;
  }
  // A zero-object allocation has no published terminator; shared text consumption guards it.
  return bytes;
}
export function createGroupE0ObjectList(
  manager: AokanaDisplayManager,
  selection: AokanaSelectionDialog,
  engineCaption: Uint8Array,
): AokanaNativeSlotDefinition[] {
  return [
    {
      primary: 0xe0,
      secondary: 0x00,
      nativeAddress: 0x1400ab7a0,
      name: 'ShowOrdinaryObjectList',
      execute: async (): Promise<0> => {
        const bytes = formatAokanaObjectList(manager.collectOrdinaryObjects());
        await selection.select(
          {bytes: new Uint8Array(64), offset: 0},
          {bytes: engineCaption, offset: 0},
          {bytes: prompt, offset: 0},
          {bytes, offset: 0},
        );
        return 0;
      },
    },
  ];
}

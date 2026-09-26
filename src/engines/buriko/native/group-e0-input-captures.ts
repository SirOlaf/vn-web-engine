import {BurikoDisplayObject} from './display-object.js';
import type {BurikoInputCaptureView, BurikoNativeInput} from './input.js';
import type {BurikoSelectionDialog} from './selection-dialog.js';
import type {BurikoNativeSlotDefinition} from './types.js';
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
const sentinel: BurikoInputCaptureView = {token: 0xffffffff, object: null};
// Raw CP932 180398 and 1803D8; enabled suffix at17D828 is empty.
const inactive = Uint8Array.of(0x3c, 0x96, 0xb3, 0x8c, 0xf8, 0x3e, 0x20);
const prompt = Uint8Array.of(
  0x93,
  0xfc,
  0x97,
  0xcd,
  0x83,
  0x74,
  0x83,
  0x48,
  0x81,
  0x5b,
  0x83,
  0x4a,
  0x83,
  0x58,
  0x88,
  0xea,
  0x97,
  0x97,
  0,
);

/** AB3C0's unsigned merge uses FFFFFFFF only after advancing past a list end. */
export function formatBurikoInputCaptures(input: BurikoNativeInput): Uint8Array {
  const lists = input.captureDiagnosticView();
  const count = (lists.pointer.length + lists.key.length) >>> 0;
  const bytes = new Uint8Array((count << 6) >>> 0);
  let pointer = lists.pointer[0],
    key = lists.key[0],
    pointerIndex = 0,
    keyIndex = 0;
  let consumed = 0,
    offset = 0;
  const append = (prefix: string, suffix?: Uint8Array): void => {
    const head = new TextEncoder().encode(prefix);
    const line = new Uint8Array(head.length + (suffix?.length ?? 0) + 2);
    line.set(head);
    if (suffix !== undefined) line.set(suffix, head.length);
    line[line.length - 2] = 10;
    writeText({bytes, offset}, line);
    offset += line.length - 1;
  };
  const hex = (token: number): string =>
    `$${(token >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
  while (consumed < count) {
    if (key === undefined || pointer === undefined)
      throw new Error('Buriko capture diagnostic dereferences an absent initial list head');
    const pointerToken = pointer.token >>> 0;
    if (pointerToken < key.token >>> 0) {
      append(hex(key.token));
      key = lists.key[++keyIndex] ?? sentinel;
    } else {
      if (pointer.object === null) append(hex(pointerToken));
      else {
        const rectangle = pointer.object.inputRectangle(0);
        const activeObject = pointer.object;
        if (activeObject === null)
          throw new Error('Buriko capture diagnostic dereferences a missing active-state object');
        const active = activeObject.inputActive();
        const categoryObject = pointer.object;
        if (!(categoryObject instanceof BurikoDisplayObject))
          throw new Error('Buriko capture diagnostic requires the native display category owner');
        const label = labels[categoryObject.category >>> 0];
        if (label === undefined)
          throw new Error('Buriko capture diagnostic indexes outside its native category table');
        const [left, top, right, bottom] =
          'left' in rectangle
            ? [rectangle.left, rectangle.top, rectangle.right, rectangle.bottom]
            : rectangle;
        append(
          `${hex(pointerToken)} : ${label} [ ${left! | 0}, ${top! | 0} - ${right! | 0}, ${bottom! | 0} (${(right! - left!) | 0}x${(bottom! - top!) | 0}) ] `,
          active !== 0 ? undefined : inactive,
        );
      }
      const equal = pointerToken === key.token >>> 0;
      if (equal) consumed = (consumed + 1) >>> 0;
      pointer = lists.pointer[++pointerIndex] ?? sentinel;
      if (equal) key = lists.key[++keyIndex] ?? sentinel;
    }
    consumed = (consumed + 1) >>> 0;
  }
  return bytes;
}

export function createGroupE0InputCaptures(
  input: BurikoNativeInput,
  selection: BurikoSelectionDialog,
  engineCaption: Uint8Array,
): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0xe0,
      secondary: 0x40,
      nativeAddress: 0x1400ab3c0,
      name: 'ShowInputCaptureList',
      execute: async (): Promise<0> => {
        const list = {bytes: formatBurikoInputCaptures(input), offset: 0};
        await selection.select(
          list,
          {bytes: engineCaption, offset: 0},
          {bytes: prompt, offset: 0},
          list,
        );
        return 0;
      },
    },
  ];
}

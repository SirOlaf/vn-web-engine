import type {BurikoBitmapGroupDescription} from './bitmap-group-description.js';
import type {BurikoWindowDisplayObject} from './display-window.js';
import {requireBurikoResourceRange} from './bf-entropy.js';

/** 0933F0: immediate descriptions own real affine Sprites in the Window's inner manager. */
export function drawBurikoWindowBitmapGroups(
  window: BurikoWindowDisplayObject,
  description: BurikoBitmapGroupDescription,
): number {
  window.disableOverlays();
  window.configureInnerObjects(0);
  window.clearText();
  window.setTextTransparency(0);
  // 068B60 is a MOV/RET leaf: EDX remains zero for the following 068B70 call.
  window.setTextEnabled(0);
  window.composeAll();
  let status = 0x80000001;
  const count = description.words[0]! | 0;
  if ((count - 1) >>> 0 < 256) {
    status = 0;
    let total = 0;
    for (let row = 0; row < count; row++) {
      const units = description.groups[row]!.words[0]! | 0;
      total = (total + units) | 0;
      if ((units - 1) >>> 0 >= 1024) {
        status = 0x80000002;
        break;
      }
    }
    if (status === 0) {
      window.configureInnerObjects(total);
      let flat = 0;
      for (let row = 0; row < count; row++) {
        const group = description.groups[row]!,
          view = new DataView(group.units.buffer, group.units.byteOffset, group.units.byteLength);
        for (let column = 0; column < (group.words[0]! | 0); column++, flat++) {
          const word = (index: number): number => {
            const offset = column * 0xc4 + index * 4;
            requireBurikoResourceRange(group.units.length, offset, 4);
            return view.getInt32(offset, true);
          };
          let layer = word(1);
          if (layer === 0) continue;
          const flags = word(48);
          if ((flags & 0x40) !== 0) continue;
          let source = word(8);
          // Native expanded row+10 is VM row+0C, selected column.
          if (source !== -1 && column === (group.words[3]! | 0)) {
            const selected = word(10);
            if (selected !== -1) source = selected;
          }
          if (window.windowState.manager.surfaces.snapshot(source) === null) continue;
          if ((flags & 0x10) === 0) layer = (flags & 2) !== 0 ? word(3) : flat;
          const pivotY = word(5),
            y = (word(3) + pivotY) | 0,
            pivotX = word(4),
            x = (word(2) + pivotX) | 0;
          window.createInnerSprite(flat, source, x, y, pivotX, pivotY, layer);
          // Native ignores both return values and never consumes this scratch on failure.
          window.composeInnerObject({left: 0, top: 0, right: 0, bottom: 0}, flat);
        }
      }
    }
  }
  window.invalidate();
  return status;
}

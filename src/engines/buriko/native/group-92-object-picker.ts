import {pop32, push32} from '../bp/state.js';
import {pointerView} from '../bp/memory.js';
import type {BurikoDisplayManager} from './display-manager.js';
import type {BurikoNativeInput} from './input.js';
import type {BurikoCursorPolicy} from './cursor-policy.js';
import type {BurikoNativeTouch} from './touch-input.js';
import type {BurikoNativeSlotDefinition} from './types.js';

/** E3F40/C4750: reverse ordinary-list picker over the shared native input and renderer owners. */
export function createGroup92ObjectPicker(
  manager: BurikoDisplayManager,
  input: BurikoNativeInput,
  cursor: BurikoCursorPolicy,
  touch: BurikoNativeTouch,
): BurikoNativeSlotDefinition[] {
  if (
    input.display !== manager.displayState ||
    cursor.manager !== manager ||
    cursor.input !== input ||
    touch.input !== input
  )
    throw new Error('Buriko object picker requires shared display and input owners');
  return [
    {
      primary: 0x92,
      secondary: 0x3d,
      nativeAddress: 0x1400e3f40,
      name: 'PickObjectAtPointer',
      execute: (h) => {
        const output = h.memory.resolve(h.thread, pop32(h.thread));
        let category = 0xffffffff;
        if ((cursor.queryVisible() !== 0 || touch.available) && input.foreground) {
          const [x, y] = input.pointerPosition();
          if (
            x >= 0 &&
            x < input.display.logicalWidth &&
            y >= 0 &&
            y < input.display.logicalHeight
          ) {
            const objects = manager.collectOrdinaryObjects();
            for (let index = objects.length - 1; index >= 0; index--) {
              const object = objects[index]!;
              if (object.inputActive() === 0 || object.option5c === 0) continue;
              const rectangle = object.inputRectangle(0);
              if (object.inputHitTest((x - rectangle.left) | 0, (y - rectangle.top) | 0, 1) === 0)
                continue;
              if (output === null)
                throw new Error('Buriko pointer picker writes null caller output');
              pointerView(output).setUint32(0, object.handle >>> 0, true);
              category = object.category >>> 0;
              break;
            }
          }
        }
        push32(h.thread, category);
        return 0;
      },
    },
  ];
}

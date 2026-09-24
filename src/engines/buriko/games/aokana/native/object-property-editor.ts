import type {AokanaBpPointer} from '../bp/memory.js';
import {AokanaDisplayObject} from './display-object.js';
import {AokanaDisplaySprite} from './display-sprite.js';
import type {AokanaDisplayManager} from './display-manager.js';
import type {AokanaPropertyEditors, AokanaPropertyCallback} from './property-editor.js';
import {readPropertyWord, writePropertyWord} from './property-values.js';

const literal = (value: string): AokanaBpPointer => ({
  bytes: new TextEncoder().encode(value + '\0'),
  offset: 0,
});

/** ABB40. Rows borrow the original object; callbacks resolve its handle anew. */
export function createAokanaObjectPropertyTab(
  editors: AokanaPropertyEditors,
  manager: AokanaDisplayManager,
  output: AokanaBpPointer | null,
  editorId: number,
  handle: number,
  label: AokanaBpPointer | null,
): number {
  handle >>>= 0;
  const object = manager.resolve(handle);
  if (object === null) return 0x80000014;
  const category = object.category >>> 0;
  if (category !== 2 && category !== 3) return 0x80000010;
  const tabOutput = {bytes: new Uint8Array(4), offset: 0};
  const status = editors.addTab(tabOutput, editorId, label);
  if (status !== 0) return status;
  const tab = readPropertyWord(tabOutput);
  writePropertyWord(output, tab);
  const handleSource = {bytes: new Uint8Array(4), offset: 0};
  writePropertyWord(handleSource, handle);
  editors.addRow(null, editorId, tab, literal('Handle'), 2, handleSource, 0, 0);
  editors.addRow(
    null,
    editorId,
    tab,
    literal('Object Type'),
    5,
    literal(category === 2 ? 'Sprite' : 'Window'),
    0,
    0,
  );
  const refresh: AokanaPropertyCallback = (_row, context) =>
    Number(manager.resolve(context as number) !== null);
  const raw = (owner: AokanaDisplayObject, offset: number): number =>
    AokanaDisplayObject.prototype.diagnosticPropertyWord.call(owner, offset);
  const current = (): AokanaDisplayObject => {
    const value = manager.resolve(handle);
    if (value === null)
      throw new Error('Aokana object-property callback dereferences a missing object');
    return value;
  };
  const add = (
    name: string,
    kind: number,
    offset: number,
    edit?: (value: () => number) => number | boolean,
    read?: () => number,
  ): void => {
    editors.addRow(
      null,
      editorId,
      tab,
      literal(name),
      kind,
      {readPropertyWord: read ?? (() => raw(object, offset))},
      1,
      edit === undefined ? 0 : 1,
      refresh,
      handle,
      edit === undefined ? null : (row) => Number(edit(() => row.value)),
      handle,
    );
  };
  add('Display State', 4, 0x18, (value) => manager.setActivation(handle, value()));
  add('Visibility', 4, 0x08, (value) => manager.setSecondaryVisibility(handle, value()));
  add('Invisibility', 4, 0x10, (value) => manager.setObjectSuppression(handle, value()));
  add('Priority', 2, 0x20, (value) => manager.setObjectLayer(handle, value()));
  add('Position X', 0, 0x40, (value) => {
    const owner = current();
    return manager.move(handle, value(), raw(owner, 0x44));
  });
  add('Position Y', 0, 0x44, (value) => {
    const y = value();
    return manager.move(handle, raw(current(), 0x40), y);
  });
  add('Adjustment to X', 0, 0x48);
  add('Adjustment to Y', 0, 0x4c);
  add('Difference of X', 0, 0x50);
  add('Difference of Y', 0, 0x54);
  if (category === 2) {
    if (!(object instanceof AokanaDisplaySprite))
      throw new Error('Aokana property diagnostic requires the concrete Sprite field owner');
    add('Bitmap Number', 0, 0x194, undefined, () => {
      raw(object, 0x18); // The borrowed object must still own its storage.
      return object.sourceSurface;
    });
    if (object.mode === 5) {
      for (const [prefix, offset] of [
        ['Logical', 0x60],
        ['Adjustment to logical', 0x70],
        ['Difference of logical', 0x80],
      ] as const)
        for (const [index, axis] of ['X', 'Y', 'Z'].entries())
          add(`${prefix} ${axis}`, 3, offset + index * 4);
    }
  }
  add('Effect Mode', 1, 0xc8, (value) => {
    current().blendMode = value() | 0;
    return 1;
  });
  add('Effect Level', 1, 0xcc, (value) => manager.setObjectBlendValue(handle, value()));
  add('Transparency', 1, 0xd0, (value) => manager.setObjectTransparency(handle, value()));
  add('Opacity', 1, 0xd4, (value) => manager.setObjectOpacityScale(handle, value()));
  return 0;
}

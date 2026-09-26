import type {BurikoBpPointer} from '../bp/memory.js';
import {pop32, push32} from '../bp/state.js';
import type {
  BurikoBpOpcodeContext,
  BurikoBpOpcodeHandler,
  BurikoNativeSlotDefinition,
} from './types.js';
import {BurikoPropertyEditors} from './property-editor.js';

function pointer(h: BurikoBpOpcodeContext): BurikoBpPointer | null {
  return h.memory.resolve(h.thread, pop32(h.thread));
}
function local(...words: number[]): BurikoBpPointer {
  const bytes = new Uint8Array(words.length * 4),
    view = new DataView(bytes.buffer);
  words.forEach((word, index) => view.setUint32(index * 4, word, true));
  return {bytes, offset: 0};
}
function status(result: number, accepted: readonly (readonly [number, number])[]): number {
  return result === 0 ? 0 : (accepted.find(([native]) => native === result)?.[1] ?? 0xffffffff);
}
const windowErrors = [[0x80000007, 1]] as const;
const rowErrors = [
  [0x80000007, 1],
  [0x80000014, 2],
  [0x8000000d, 4],
] as const;

/** All eleven B0 property-window wrappers, retaining each slot's own status translation. */
export function createGroupB0Properties(
  editors: BurikoPropertyEditors,
): BurikoNativeSlotDefinition[] {
  const definitions: BurikoNativeSlotDefinition[] = [];
  const add = (
    secondary: number,
    nativeAddress: number,
    name: string,
    execute: BurikoBpOpcodeHandler,
  ): void => {
    definitions.push({primary: 0xb0, secondary, nativeAddress, name, execute});
  };
  add(0x60, 0x1400d4f40, 'CreatePropertyEditor', (h) => {
    const secondWidth = pop32(h.thread),
      firstWidth = pop32(h.thread),
      y = pop32(h.thread),
      x = pop32(h.thread);
    const subtitle = pointer(h),
      title = pointer(h),
      output = pointer(h);
    push32(
      h.thread,
      editors.create(output, title, subtitle, local(x, y), firstWidth, secondWidth) === 0
        ? 0
        : 0xffffffff,
    );
    return 0;
  });
  add(0x61, 0x1400d4ef0, 'DestroyPropertyEditor', (h) => {
    push32(h.thread, status(editors.destroy(pop32(h.thread)), windowErrors));
    return 0;
  });
  add(0x62, 0x1400d4e70, 'MovePropertyEditor', (h) => {
    const y = pop32(h.thread),
      x = pop32(h.thread),
      id = pop32(h.thread);
    push32(h.thread, status(editors.setPosition(id, local(x, y)), windowErrors));
    return 0;
  });
  add(0x63, 0x1400d4e00, 'GetPropertyEditorPosition', (h) => {
    const id = pop32(h.thread),
      output = pointer(h);
    push32(h.thread, status(editors.getPosition(output, id), windowErrors));
    return 0;
  });
  add(0x66, 0x1400d4db0, 'RefreshPropertyEditor', (h) => {
    push32(h.thread, status(editors.refresh(pop32(h.thread)), windowErrors));
    return 0;
  });
  add(0x67, 0x1400d4d30, 'PollPropertyEditor', (h) => {
    const id = pop32(h.thread),
      output = pointer(h);
    push32(
      h.thread,
      status(editors.poll(output, id), [
        [0x80000007, 1],
        [0x8000001f, 6],
      ]),
    );
    return 0;
  });
  add(0x68, 0x1400d4cb0, 'AddPropertyTab', (h) => {
    const name = pointer(h),
      id = pop32(h.thread),
      output = pointer(h);
    push32(h.thread, status(editors.addTab(output, id, name), windowErrors));
    return 0;
  });
  add(0x6a, 0x1400d4c20, 'AddPropertyButton', (h) => {
    const name = pointer(h),
      id = pop32(h.thread),
      output = pointer(h);
    push32(
      h.thread,
      status(editors.addButton(output, id, name), [
        [0x80000006, 5],
        [0x80000007, 1],
      ]),
    );
    return 0;
  });
  add(0x6c, 0x1400d4b00, 'AddStaticProperty', (h) => {
    const value = pop32(h.thread),
      kind = pop32(h.thread),
      name = pointer(h),
      tab = pop32(h.thread),
      id = pop32(h.thread),
      output = pointer(h);
    // Resolve the string address only after every operand has been consumed; other kinds use the local DWORD.
    const source = kind === 5 ? h.memory.resolve(h.thread, value) : local(value);
    push32(h.thread, status(editors.addRow(output, id, tab, name, kind, source, 0, 0), rowErrors));
    return 0;
  });
  add(0x6d, 0x1400d49f0, 'AddLiveProperty', (h) => {
    const editable = pop32(h.thread),
      source = pointer(h),
      kind = pop32(h.thread),
      name = pointer(h);
    const tab = pop32(h.thread),
      id = pop32(h.thread),
      output = pointer(h);
    push32(
      h.thread,
      status(editors.addRow(output, id, tab, name, kind, source, 1, editable), rowErrors),
    );
    return 0;
  });
  add(0x6f, 0x1400d4920, 'ReadProperty', (h) => {
    const row = pop32(h.thread),
      tab = pop32(h.thread),
      id = pop32(h.thread),
      type = pointer(h),
      output = pointer(h);
    push32(
      h.thread,
      status(editors.getValue(output, type, id, tab, row), [
        [0x80000007, 1],
        [0x80000014, 2],
        [0x8000001f, 3],
      ]),
    );
    return 0;
  });
  return definitions;
}

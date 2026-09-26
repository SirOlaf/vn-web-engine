import type {BurikoBpPointer} from '../bp/memory.js';
import {pop32, push32} from '../bp/state.js';
import type {
  BurikoBpOpcodeContext,
  BurikoBpOpcodeHandler,
  BurikoNativeSlotDefinition,
} from './types.js';
import {BurikoAnsiDialogs} from './ansi-dialogs.js';
import {BurikoEngineDialogs} from './engine-dialogs.js';
import {BurikoProductKeyDialog} from './product-key-dialog.js';
import {BurikoSelectionDialog} from './selection-dialog.js';
import {BurikoModelessSettings} from './modeless-settings.js';
import {textBytes} from './text.js';
import {readPropertyWord, writePropertyWord} from './property-values.js';

function pointer(h: BurikoBpOpcodeContext): BurikoBpPointer | null {
  return h.memory.resolve(h.thread, pop32(h.thread));
}

/** The graph-owned message and list modals need no ANSI form or settings-window host. */
export function createGroupB0ModalDialogs(
  dialogs: BurikoEngineDialogs,
  selection: BurikoSelectionDialog,
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
  add(0x80, 0x1400d48f0, 'ShowMessage', async (h): Promise<0> => {
    await dialogs.show(pointer(h), null, 0x40);
    return 0;
  });
  add(0x81, 0x1400d4880, 'AskYesNo', async (h): Promise<0> => {
    const affirmative = pop32(h.thread),
      message = pointer(h);
    push32(
      h.thread,
      Number((await dialogs.show(message, null, affirmative === 0 ? 0x124 : 0x24)) === 6),
    );
    return 0;
  });
  add(0x82, 0x1400d47d0, 'AskDialogChoice', async (h): Promise<0> => {
    const affirmative = pop32(h.thread),
      kind = pop32(h.thread),
      message = pointer(h);
    const result = await dialogs.show(
      message,
      null,
      kind === 1 ? (affirmative === 0 ? 0x141 : 0x41) : affirmative === 0 ? 0x124 : 0x24,
    );
    push32(h.thread, Number(result === (kind === 1 ? 1 : 6)));
    return 0;
  });
  add(0x83, 0x1400d47b0, 'SetMessageTitle', (h) => {
    const title = pointer(h);
    // c10a0 frees the previous title before scanning and allocating its replacement.
    dialogs.preferredTitle = null;
    if (title !== null) dialogs.preferredTitle = textBytes(title, true).slice();
    return 0;
  });
  add(0x8c, 0x1400d4410, 'SelectFromList', async (h): Promise<0> => {
    const list = pointer(h),
      prompt = pointer(h),
      title = pointer(h),
      output = pointer(h);
    push32(h.thread, await selection.select(output, title, prompt, list));
    return 0;
  });
  return definitions;
}

/** The five browser forms share one ANSI host and one persistent product-key edit state. */
export function createGroupB0FormDialogs(
  ansi: BurikoAnsiDialogs,
  productKey: BurikoProductKeyDialog,
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
  add(0x84, 0x1400d4730, 'EditSingleText', async (h): Promise<0> => {
    const limit = pop32(h.thread),
      initial = pointer(h),
      title = pointer(h),
      output = pointer(h);
    push32(h.thread, await ansi.single(output, title, initial, limit));
    return 0;
  });
  add(0x85, 0x1400d4630, 'EditTwoStrings', async (h): Promise<0> => {
    const limit2 = pop32(h.thread),
      initial2 = pointer(h),
      label2 = pointer(h),
      limit1 = pop32(h.thread),
      initial1 = pointer(h),
      label1 = pointer(h);
    const title = pointer(h),
      output2 = pointer(h),
      output1 = pointer(h);
    push32(
      h.thread,
      await ansi.pair(
        0,
        title,
        {output: output1, label: label1, initial: initial1, limit: limit1, numeric: 0},
        {output: output2, label: label2, initial: initial2, limit: limit2, numeric: 0},
      ),
    );
    return 0;
  });
  add(0x86, 0x1400d45b0, 'EditProductKey', async (h): Promise<0> => {
    pop32(h.thread);
    const numeric = pop32(h.thread),
      initial = pointer(h),
      title = pointer(h),
      output = pointer(h);
    push32(h.thread, await productKey.show(output, title, initial, numeric));
    return 0;
  });
  add(0x87, 0x1400d4490, 'EditTwoFields', async (h): Promise<0> => {
    const numeric2 = pop32(h.thread),
      limit2 = pop32(h.thread),
      initial2 = pointer(h),
      label2 = pointer(h);
    const numeric1 = pop32(h.thread),
      limit1 = pop32(h.thread),
      initial1 = pointer(h),
      label1 = pointer(h);
    const title = pointer(h),
      output2 = pointer(h),
      output1 = pointer(h),
      kind = pop32(h.thread);
    push32(
      h.thread,
      await ansi.pair(
        kind,
        title,
        {output: output1, label: label1, initial: initial1, limit: limit1, numeric: numeric1},
        {output: output2, label: label2, initial: initial2, limit: limit2, numeric: numeric2},
      ),
    );
    return 0;
  });
  add(0x8f, 0x1400d4370, 'EditNameAndBirthday', async (h): Promise<0> => {
    const day = pointer(h),
      month = pointer(h),
      firstPerson = pointer(h),
      nickname = pointer(h),
      first = pointer(h),
      last = pointer(h);
    push32(h.thread, await ansi.nameAndBirthday(last, first, nickname, firstPerson, month, day));
    return 0;
  });
  return definitions;
}

/** The persistent settings window has its own graph lifetime and event queue. */
export function createGroupB0ModelessSettings(
  settings: BurikoModelessSettings,
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
  add(0xa0, 0x1400d4310, 'CreateSettingsWindow', (h) => {
    const initial = pointer(h),
      kind = pop32(h.thread),
      output = pointer(h);
    const result = settings.create(kind, initial);
    if (result.result === 0) writePropertyWord(output, result.id!);
    push32(h.thread, Number(result.result === 0));
    return 0;
  });
  add(0xa1, 0x1400d42d0, 'DestroySettingsWindow', (h) => {
    push32(h.thread, Number(settings.destroy(pop32(h.thread)) === 0));
    return 0;
  });
  add(0xa2, 0x1400d4290, 'ShowSettingsWindow', (h) => {
    const visible = pop32(h.thread),
      id = pop32(h.thread);
    push32(h.thread, Number(settings.show(id, visible) === 0));
    return 0;
  });
  add(0xa3, 0x1400d4200, 'PollSettingsWindow', (h) => {
    const id = pop32(h.thread),
      output = pointer(h),
      local = {bytes: new Uint8Array(16), offset: 0};
    const result = settings.poll(id, local);
    let status = 0xfffffffe;
    if (result === 0) {
      // The native queue entry is already unlinked before these two independent VM stores.
      writePropertyWord(output, readPropertyWord(local));
      writePropertyWord(
        output === null ? null : {bytes: output.bytes, offset: output.offset + 4},
        readPropertyWord({bytes: local.bytes, offset: 4}),
      );
      status = 0;
    } else if (result === 1) status = 1;
    else if (result === 0x80000000) status = 0xffffffff;
    push32(h.thread, status);
    return 0;
  });
  return definitions;
}

import {pop32, push32} from '../bp/state.js';
import {AokanaEngineErrors} from './engine-errors.js';
import {AokanaKnobDisplays} from './knob-displays.js';
import type {AokanaBpOpcodeContext, AokanaNativeSlotDefinition} from './types.js';

/** Bank 90:D0,D1,D4-DF, the complete scene-facing CDspObjKnob family. */
export function createGroup90Knobs(
  knobs: AokanaKnobDisplays,
  errors: AokanaEngineErrors,
): AokanaNativeSlotDefinition[] {
  const fatal = (context: AokanaBpOpcodeContext, message: string): Promise<never> =>
      errors.threadFatal(
        context.thread,
        context.diagnostics,
        errors.files.text.encodeWide(message, 0),
      ),
    invalidKnob = (context: AokanaBpOpcodeContext): Promise<never> =>
      fatal(context, '無効なノブハンドルが指定されました');

  return [
    {
      primary: 0x90,
      secondary: 0xd0,
      nativeAddress: 0x1400d6d30,
      name: 'CreateKnobDisplay',
      execute: (context) => {
        const target = pop32(context.thread);
        if (knobs.targetHasParent(target))
          return fatal(context, '指定されたオブジェクトにはオーナーが存在します');
        const result = knobs.create(target);
        switch (result.result) {
          case 0:
            push32(context.thread, result.handle);
            return 0;
          case 1:
            return fatal(context, 'これ以上、ノブオブジェクトを生成する事は出来ません');
          case 2:
            return fatal(context, '無効なターゲットハンドルが指定されました');
          case 3:
            return fatal(context, '仮想オブジェクトはターゲットに指定できません');
        }
      },
    },
    {
      primary: 0x90,
      secondary: 0xd1,
      nativeAddress: 0x1400d6ce0,
      name: 'DestroyKnobDisplay',
      execute: (context) => (knobs.destroy(pop32(context.thread)) ? 0 : invalidKnob(context)),
    },
    {
      primary: 0x90,
      secondary: 0xd4,
      nativeAddress: 0x1400d6c90,
      name: 'SetKnobActivation',
      execute: (context) => {
        const activation = pop32(context.thread),
          handle = pop32(context.thread);
        return knobs.setActivation(handle, activation) ? 0 : invalidKnob(context);
      },
    },
    {
      primary: 0x90,
      secondary: 0xd5,
      nativeAddress: 0x1400d6c40,
      name: 'MoveKnobBase',
      execute: (context) => {
        const y = pop32(context.thread),
          x = pop32(context.thread),
          handle = pop32(context.thread);
        return knobs.moveBase(handle, x, y) ? 0 : invalidKnob(context);
      },
    },
    {
      primary: 0x90,
      secondary: 0xd6,
      nativeAddress: 0x1400d6bf0,
      name: 'SetKnobValue',
      execute: (context) => {
        const y = pop32(context.thread),
          x = pop32(context.thread),
          handle = pop32(context.thread);
        return knobs.setValue(handle, x, y) ? 0 : invalidKnob(context);
      },
    },
    {
      primary: 0x90,
      secondary: 0xd7,
      nativeAddress: 0x1400d6ba0,
      name: 'GetKnobValue',
      execute: (context) => {
        const value = knobs.value(pop32(context.thread));
        if (value === null) return invalidKnob(context);
        push32(context.thread, value.x);
        push32(context.thread, value.y);
        return 0;
      },
    },
    {
      primary: 0x90,
      secondary: 0xd8,
      nativeAddress: 0x1400d6b10,
      name: 'SetKnobPrecision',
      execute: (context) => {
        const y = pop32(context.thread),
          x = pop32(context.thread),
          handle = pop32(context.thread),
          result = knobs.setPrecision(handle, x, y);
        if (result === -1) return invalidKnob(context);
        return result === 4
          ? fatal(context, `無効な移動精度 [ ${x | 0} , ${y | 0} ] が指定されました`)
          : 0;
      },
    },
    {
      primary: 0x90,
      secondary: 0xd9,
      nativeAddress: 0x1400d6a70,
      name: 'SetKnobRange',
      execute: (context) => {
        const height = pop32(context.thread),
          width = pop32(context.thread),
          handle = pop32(context.thread),
          result = knobs.setRange(handle, width, height);
        if (result === -1) return invalidKnob(context);
        return result === 5
          ? fatal(context, `無効な可動範囲 [ ${width | 0} , ${height | 0} ] が指定されました`)
          : 0;
      },
    },
    {
      primary: 0x90,
      secondary: 0xda,
      nativeAddress: 0x1400d6a20,
      name: 'ConsumeKnobWheelBoundary',
      execute: (context) => {
        const result = knobs.takeWheelBoundary(pop32(context.thread));
        if (result === null) return invalidKnob(context);
        push32(context.thread, result);
        return 0;
      },
    },
    {
      primary: 0x90,
      secondary: 0xdb,
      nativeAddress: 0x1400d69f0,
      name: 'ConsumeKnobRightClick',
      execute: (context) => {
        push32(context.thread, knobs.consumeRightClick());
        return 0;
      },
    },
    {
      primary: 0x90,
      secondary: 0xdc,
      nativeAddress: 0x1400d69a0,
      name: 'SetKnobDragAnchor',
      execute: (context) => {
        const value = pop32(context.thread),
          handle = pop32(context.thread);
        return knobs.setDragAnchor(handle, value) ? 0 : invalidKnob(context);
      },
    },
    {
      primary: 0x90,
      secondary: 0xdd,
      nativeAddress: 0x1400d6970,
      name: 'ExchangeKnobWheelMode',
      execute: (context) => {
        push32(context.thread, knobs.exchangeWheelMode(pop32(context.thread)));
        return 0;
      },
    },
    {
      primary: 0x90,
      secondary: 0xde,
      nativeAddress: 0x1400d6930,
      name: 'RegisterKnobWheelControl',
      execute: (context) => (knobs.registerWheel(pop32(context.thread)) ? 0 : invalidKnob(context)),
    },
    {
      primary: 0x90,
      secondary: 0xdf,
      nativeAddress: 0x1400d68f0,
      name: 'UnregisterKnobWheelControl',
      execute: (context) =>
        knobs.unregisterWheel(pop32(context.thread)) ? 0 : invalidKnob(context),
    },
  ];
}

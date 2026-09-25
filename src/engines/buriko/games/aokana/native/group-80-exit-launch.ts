import {pop32} from '../bp/state.js';
import type {AokanaExitLaunchHandoff} from './exit-launch-handoff.js';
import type {AokanaEngineErrors} from './engine-errors.js';
import {textBytes} from './text.js';
import type {AokanaNativeSlotDefinition} from './types.js';

const nullCommandDiagnostic = Uint8Array.of(
  138, 79, 149, 148, 131, 118, 131, 141, 131, 79, 131, 137, 131, 128, 130, 204,
  131, 116, 131, 64, 131, 67, 131, 139, 150, 188, 130, 201, 78, 85, 76, 76,
  131, 124, 131, 67, 131, 147, 131, 94, 130, 170, 142, 119, 146, 232, 130, 179,
  130, 234, 130, 220, 130, 181, 130, 189, 0,
);

/** E6B20 stores copied bytes, destroys the window and returns scheduler result six. */
export function createGroup80ExitLaunch(
  handoff: AokanaExitLaunchHandoff,
  errors: AokanaEngineErrors,
): AokanaNativeSlotDefinition[] {
  return [{
    primary: 0x80,
    secondary: 0xe1,
    nativeAddress: 0x1400e6b20,
    name: 'ExitAndLaunch',
    execute: async (context): Promise<6> => {
      const failurePointer = context.memory.resolve(context.thread, pop32(context.thread)),
        commandPointer = context.memory.resolve(context.thread, pop32(context.thread)),
        basePointer = context.memory.resolve(context.thread, pop32(context.thread)),
        baseDirectory = basePointer === null ? null : textBytes(basePointer, true).slice();
      if (commandPointer === null)
        return errors.threadFatal(context.thread, context.diagnostics, nullCommandDiagnostic);
      const command = textBytes(commandPointer, true).slice(),
        failureMessage = failurePointer === null ? null : textBytes(failurePointer, true).slice();
      return handoff.request(baseDirectory, command, failureMessage);
    },
  }];
}

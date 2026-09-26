import {pop32} from '../bp/state.js';
import {AokanaEngineErrors} from './engine-errors.js';
import {AokanaSurfaces} from './surfaces.js';
import type {AokanaBpOpcodeContext, AokanaNativeSlotDefinition} from './types.js';

/** Runtime-owned 92 00/01 producers for the surface manager's one shared coefficient owner. */
export function createGroup92CoefficientTables(
  surfaces: AokanaSurfaces,
  errors: AokanaEngineErrors,
): AokanaNativeSlotDefinition[] {
  const fatal = (context: AokanaBpOpcodeContext, index: number): Promise<never> =>
    errors.threadFatal(
      context.thread,
      context.diagnostics,
      errors.files.text.encodeWide(`無効な波紋番号 [ ${index | 0} ] が指定されました`, 0),
    );
  return [
    {
      primary: 0x92,
      secondary: 0x00,
      nativeAddress: 0x1400e4f00,
      name: 'ConfigureRippleCoefficients',
      execute: (context) => {
        const repetitions = pop32(context.thread),
          spacing = pop32(context.thread),
          amplitude = pop32(context.thread),
          quarterPeriod = pop32(context.thread),
          index = pop32(context.thread);
        return surfaces.coefficientTables.configureRipple(
          index,
          quarterPeriod,
          amplitude,
          spacing,
          repetitions,
        ) === 0x10
          ? fatal(context, index)
          : 0;
      },
    },
    {
      primary: 0x92,
      secondary: 0x01,
      nativeAddress: 0x1400e4e40,
      name: 'ConfigureRippleEnvelopeCoefficients',
      execute: (context) => {
        const repetitions = pop32(context.thread),
          spacing = pop32(context.thread),
          fadeOutPeriods = pop32(context.thread),
          fadeInPeriods = pop32(context.thread),
          amplitude = pop32(context.thread),
          quarterPeriod = pop32(context.thread),
          index = pop32(context.thread);
        return surfaces.coefficientTables.configureRippleEnvelope(
          index,
          quarterPeriod,
          amplitude,
          fadeInPeriods,
          fadeOutPeriods,
          spacing,
          repetitions,
        ) === 0x10
          ? fatal(context, index)
          : 0;
      },
    },
  ];
}

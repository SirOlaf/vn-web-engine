import {Sc3Runtime, Sc3Fault} from './runtime.js';

export class BootDiagnosticLimit extends Error {
  constructor(readonly passes: number) {
    super(`Boot diagnostic paused after ${passes} VM passes; no unsupported opcode was reached.`);
  }
}
export interface BootReady {
  kind: 'ready';
  message: string;
  context: number;
  asset: number;
  slot: number;
  pc: number;
  bytes: string;
}
/** Deterministic I/O-ready VM passes, not a real-time game/frame loop. */
export async function driveBootDiagnostic(
  vm: Sc3Runtime,
  limit = 2000,
  afterPass?: (pass: number) => void,
): Promise<{context: number; passes: number; stop: Sc3Fault | BootReady}> {
  const context = await vm.boot();
  for (let passes = 1; passes <= limit; passes++) {
    try {
      let result = vm.runFrame();
      while (result === 'blocked') {
        await vm.waitHost();
        result = vm.runFrame();
      }
      if (result === 'budget') throw new Error('Boot diagnostic instruction budget exhausted');
      afterPass?.(passes);
      if (vm.state.variable(0x210c / 4) === 1 && vm.state.flags[0x9b]! & 1) {
        const title = vm.trace
          .slice()
          .reverse()
          .find((t) => t.operation === 'title menu');
        if (title) {
          const current = vm.trace
            .slice()
            .reverse()
            .find((t) => t.context === title.context)!;
          return {
            context,
            passes,
            stop: {
              kind: 'ready',
              message: 'Title prompt ready; waiting for input.',
              context: title.context,
              asset: current.asset,
              slot: current.slot,
              pc: current.nextPc,
              bytes: current.bytes,
            },
          };
        }
      }
    } catch (error) {
      if (error instanceof Sc3Fault) return {context, passes, stop: error};
      throw error;
    }
    await vm.settleLoads();
    vm.publishLoadCompletions();
    if (vm.loadErrors.length)
      throw new Error('Boot asset transport failed', {cause: vm.loadErrors[0]});
  }
  throw new BootDiagnosticLimit(limit);
}

import {AokanaBpInterpreter} from '../bp/interpreter.js';
import {AokanaBpModuleExtensions} from '../bp/module-extensions.js';
import {createPrimaryOpcodes} from '../bp/opcodes/index.js';
import {createPrimaryDisplayOpcodes} from '../bp/opcodes/display.js';
import {createDiagnosticHostOpcodes} from '../bp/opcodes/diagnostic-host.js';
import {createFontHostOpcodes} from '../bp/opcodes/font-host.js';
import {createGroup81SharedInterpreters} from './group-81-shared-interpreters.js';
import {createGroup80ExitLaunch} from './group-80-exit-launch.js';
import {AokanaExitLaunchHandoff} from './exit-launch-handoff.js';
import {AokanaProductionVmCore} from './production-vm-core.js';
import {AokanaProductionVmFragments} from './production-vm-fragments.js';
import {AokanaNativeBank} from './registry.js';
import {AokanaSharedInterpreters} from './shared-interpreters.js';

/**
 * The complete BP dispatch owner. Bank validation is deliberately first: an
 * incomplete graph cannot bind an executable callback to the scheduler.
 */
export class AokanaProductionInterpreter {
  readonly bank: AokanaNativeBank;
  readonly extensions: AokanaBpModuleExtensions;
  readonly shared: AokanaSharedInterpreters;
  readonly exitLaunch: AokanaExitLaunchHandoff;
  readonly interpreter: AokanaBpInterpreter;

  constructor(readonly core: AokanaProductionVmCore) {
    if (!(core instanceof AokanaProductionVmCore))
      throw new TypeError('Aokana production interpreter requires the actual VM core');
    const {graph, scheduler} = core;
    this.shared = new AokanaSharedInterpreters(
      core.control,
      graph.resource.processing,
      graph.compositor,
      graph.resource.locks,
      null,
      graph.resource.errors,
    );
    this.exitLaunch = new AokanaExitLaunchHandoff(graph.messages);
    this.bank = new AokanaNativeBank([
      ...new AokanaProductionVmFragments(core).nativeDefinitions(),
      ...createGroup81SharedInterpreters(this.shared),
      ...(graph.externalProcesses === null
        ? []
        : createGroup80ExitLaunch(this.exitLaunch, graph.resource.errors)),
    ]);
    this.extensions = new AokanaBpModuleExtensions(graph.resource.resources);
    const primary = createPrimaryOpcodes(graph.text, {
      ...createPrimaryDisplayOpcodes(graph.manager),
      ...createDiagnosticHostOpcodes(
        graph.text,
        graph.dialogs,
        graph.resource.errors,
        graph.children.navigator,
      ),
      ...createFontHostOpcodes(
        graph.surfaces,
        graph.fontResources,
        graph.selectionDialog,
        graph.resource.errors,
        graph.localized.language,
      ),
    });
    this.interpreter = new AokanaBpInterpreter(primary, this.bank, this.extensions, (thread) => ({
      thread,
      memory: core.memory,
      diagnostics: core.diagnostics,
      actor: graph.allocator.currentActor,
    }));
    this.shared.bindInterpreter(this.interpreter);
    scheduler.bindInstructionExecutor((thread) => this.interpreter.step(thread));
  }
}

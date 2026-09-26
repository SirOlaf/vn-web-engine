import {BurikoBpInterpreter} from '../bp/interpreter.js';
import {BurikoBpModuleExtensions} from '../bp/module-extensions.js';
import {createPrimaryOpcodes} from '../bp/opcodes/index.js';
import {createPrimaryDisplayOpcodes} from '../bp/opcodes/display.js';
import {createDiagnosticHostOpcodes} from '../bp/opcodes/diagnostic-host.js';
import {createFontHostOpcodes} from '../bp/opcodes/font-host.js';
import {createGroup81SharedInterpreters} from './group-81-shared-interpreters.js';
import {createGroup80ExitLaunch} from './group-80-exit-launch.js';
import {BurikoExitLaunchHandoff} from './exit-launch-handoff.js';
import {BurikoProductionVmCore} from './production-vm-core.js';
import {BurikoProductionVmFragments} from './production-vm-fragments.js';
import {BurikoNativeBank} from './registry.js';
import {BurikoSharedInterpreters} from './shared-interpreters.js';
import {
  createLegacy169NativeDefinitions,
  createLegacy169PrimaryOpcodes,
  legacy169BaseSystemIdentity,
} from './legacy-169-handlers.js';
import {BurikoLegacy169Registration} from './legacy-169-registration.js';
import {createLegacy1665NativeDefinitions} from './legacy-1665-handlers.js';

/**
 * The complete BP dispatch owner. Bank validation is deliberately first: an
 * incomplete graph cannot bind an executable callback to the scheduler.
 */
export class BurikoProductionInterpreter {
  readonly bank: BurikoNativeBank;
  readonly extensions: BurikoBpModuleExtensions;
  readonly shared: BurikoSharedInterpreters;
  readonly exitLaunch: BurikoExitLaunchHandoff;
  readonly interpreter: BurikoBpInterpreter;

  constructor(readonly core: BurikoProductionVmCore) {
    if (!(core instanceof BurikoProductionVmCore))
      throw new TypeError('Buriko production interpreter requires the actual VM core');
    const {graph, scheduler} = core;
    const abi = core.memory.abi;
    const legacy = abi.compatibility === '1.69';
    if (legacy && (graph.systemProfile === null || graph.legacy169Flash === null))
      throw new Error('Buriko1.69 interpreter requires its system profile and Flash service');
    const legacyRegistration =
      legacy && graph.systemProfile !== null
        ? new BurikoLegacy169Registration(
            graph.resource.files,
            () => legacy169BaseSystemIdentity(graph.controller.cpu, graph.systemProfile!),
            graph.externalProcessHost,
          )
        : null;
    this.shared = new BurikoSharedInterpreters(
      core.control,
      graph.resource.processing,
      graph.compositor,
      graph.resource.locks,
      null,
      graph.resource.errors,
    );
    this.exitLaunch = new BurikoExitLaunchHandoff(graph.messages);
    const definitions = [
      ...new BurikoProductionVmFragments(core).nativeDefinitions(),
      ...createGroup81SharedInterpreters(this.shared),
      ...(graph.externalProcesses === null
        ? []
        : createGroup80ExitLaunch(this.exitLaunch, graph.resource.errors)),
    ];
    this.bank = new BurikoNativeBank(
      definitions,
      abi,
      legacy
        ? createLegacy169NativeDefinitions(
            graph.controller.cpu,
            graph.systemProfile!,
            graph.legacy169Flash!,
            legacyRegistration,
          )
        : abi.revision === '1.665'
          ? createLegacy1665NativeDefinitions(definitions)
          : [],
    );
    this.extensions = new BurikoBpModuleExtensions(graph.resource.resources);
    const primary = createPrimaryOpcodes(
      graph.text,
      {
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
        ...(legacy ? createLegacy169PrimaryOpcodes(graph.surfaces) : {}),
      },
      abi,
    );
    this.interpreter = new BurikoBpInterpreter(
      primary,
      this.bank,
      this.extensions,
      (thread) => ({
        thread,
        memory: core.memory,
        diagnostics: core.diagnostics,
        actor: graph.allocator.currentActor,
      }),
      abi,
    );
    this.shared.bindInterpreter(this.interpreter);
    scheduler.bindInstructionExecutor((thread) => this.interpreter.step(thread));
  }
}

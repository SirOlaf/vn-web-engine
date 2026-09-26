import {attachModule, BURIKO_BP_MODULE_NO_SPACE} from '../bp/modules.js';
import type {BurikoBpScheduler} from '../bp/scheduler.js';
import {BurikoBpThread} from '../bp/state.js';
import type {BurikoBpDiagnostics} from './diagnostics.js';
import {burikoProgramLoadDiagnostic} from './group-80-resources.js';
import type {BurikoVmControlState} from './group-80-threads.js';
import type {BurikoProgramResources} from './program-resources.js';
import {BURIKO_ENGINE_1685, type BurikoEngineVersion} from './engine-version.js';

const BOOT_NAME_CAPACITY = 784;

/** BC250 copies the selected C strings into separate 784-byte scratch buffers. */
function copiedBootName(source: Uint8Array): Uint8Array {
  const end = source.indexOf(0);
  if (end < 0 || end >= BOOT_NAME_CAPACITY)
    throw new RangeError('Buriko boot name exceeds its terminated 784-byte buffer');
  const copied = new Uint8Array(BOOT_NAME_CAPACITY);
  copied.set(source.subarray(0, end + 1));
  return copied;
}

/** ED170 appends one selected program under the actual root, before any bank execution. */
export class BurikoBootProgramLoader {
  constructor(
    readonly resources: BurikoProgramResources,
    readonly control: BurikoVmControlState,
    readonly scheduler: BurikoBpScheduler,
    readonly diagnostics: BurikoBpDiagnostics,
    readonly version: BurikoEngineVersion = BURIKO_ENGINE_1685,
  ) {}

  /** Each invocation is an explicit boot/restart selection with its own copied name buffers. */
  async appendSelectedProgram(
    archiveName: Uint8Array,
    moduleName: Uint8Array,
    actor = this.resources.mainProcessing.allocator.currentActor,
  ): Promise<number> {
    const archive = copiedBootName(archiveName),
      module = copiedBootName(moduleName),
      archiveText = archive.subarray(0, archive.indexOf(0)),
      moduleText = module.subarray(0, module.indexOf(0)),
      root = this.scheduler.root.state;
    const bytes = await this.resources.readModule(archive, module, false, actor);
    if (bytes === null) {
      await this.resources.errors.show(
        burikoProgramLoadDiagnostic(this.resources, 'missing', archiveText, moduleText),
      );
      return 0;
    }
    const child = new BurikoBpThread({
      id: this.control.allocateThreadId(),
      operandCapacity: this.version.bootOperandCells,
      moduleCapacity: this.version.bootModuleBytes,
      frameCapacity: this.version.bootFrameBytes,
      heapEnabled: true,
      mode: 0,
    });
    this.scheduler.append(child);
    if (attachModule(child, module, bytes) === BURIKO_BP_MODULE_NO_SPACE)
      return this.resources.errors.threadFatal(
        root,
        this.diagnostics,
        burikoProgramLoadDiagnostic(this.resources, 'thread-space', archiveText, moduleText),
      );
    return child.id;
  }
}

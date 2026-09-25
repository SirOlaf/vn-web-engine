import {attachModule, AOKANA_BP_MODULE_NO_SPACE} from '../bp/modules.js';
import type {AokanaBpScheduler} from '../bp/scheduler.js';
import {AokanaBpThread} from '../bp/state.js';
import type {AokanaBpDiagnostics} from './diagnostics.js';
import {aokanaProgramLoadDiagnostic} from './group-80-resources.js';
import type {AokanaVmControlState} from './group-80-threads.js';
import type {AokanaProgramResources} from './program-resources.js';

const BOOT_NAME_CAPACITY = 784;
const BOOT_OPERAND_CELLS = 0x1000;
const BOOT_MODULE_BYTES = 0x800000;
const BOOT_FRAME_BYTES = 0x400000;

/** BC250 copies the selected C strings into separate 784-byte scratch buffers. */
function copiedBootName(source: Uint8Array): Uint8Array {
  const end = source.indexOf(0);
  if (end < 0 || end >= BOOT_NAME_CAPACITY)
    throw new RangeError('Aokana boot name exceeds its terminated 784-byte buffer');
  const copied = new Uint8Array(BOOT_NAME_CAPACITY);
  copied.set(source.subarray(0, end + 1));
  return copied;
}

/** ED170 appends one selected program under the actual root, before any bank execution. */
export class AokanaBootProgramLoader {
  constructor(
    readonly resources: AokanaProgramResources,
    readonly control: AokanaVmControlState,
    readonly scheduler: AokanaBpScheduler,
    readonly diagnostics: AokanaBpDiagnostics,
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
        aokanaProgramLoadDiagnostic(this.resources, 'missing', archiveText, moduleText),
      );
      return 0;
    }
    const child = new AokanaBpThread({
      id: this.control.allocateThreadId(),
      operandCapacity: BOOT_OPERAND_CELLS,
      moduleCapacity: BOOT_MODULE_BYTES,
      frameCapacity: BOOT_FRAME_BYTES,
      heapEnabled: true,
      mode: 0,
    });
    this.scheduler.append(child);
    if (attachModule(child, module, bytes) === AOKANA_BP_MODULE_NO_SPACE)
      return this.resources.errors.threadFatal(
        root,
        this.diagnostics,
        aokanaProgramLoadDiagnostic(this.resources, 'thread-space', archiveText, moduleText),
      );
    return child.id;
  }
}

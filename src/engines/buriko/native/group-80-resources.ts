import {attachModule, BURIKO_BP_MODULE_NO_SPACE} from '../bp/modules.js';
import type {BurikoBpScheduler} from '../bp/scheduler.js';
import {BurikoBpThread, pop32, push32} from '../bp/state.js';
import type {BurikoBpPointer} from '../bp/memory.js';
import type {BurikoNativeSlotDefinition} from './types.js';
import type {BurikoVmControlState} from './group-80-threads.js';
import {BurikoProgramResources} from './program-resources.js';
import {textBytes} from './text.js';

function name(pointer: BurikoBpPointer | null, nullable: boolean): Uint8Array | null {
  if (pointer === null) {
    if (nullable) return null;
    throw new Error('Buriko module load dereferences a null resource name');
  }
  return textBytes(pointer).slice();
}

export function burikoProgramLoadDiagnostic(
  resources: BurikoProgramResources,
  kind: 'missing' | 'space' | 'thread-space',
  archive: Uint8Array | null,
  resource: Uint8Array,
): Uint8Array {
  const text = resources.files.text;
  const prefix =
    kind === 'missing'
      ? '指定されたプログラム [ '
      : kind === 'space'
        ? 'コード領域のサイズが不足しているので、プログラム [ '
        : '生成されたスレッドのコード領域のサイズが不足しているので、プログラム [ ';
  const suffix =
    kind === 'missing'
      ? ' ] は存在しません'
      : kind === 'space'
        ? ' ] を読み込むことができません'
        : ' ] を読み込むことができません';
  const pieces = [
    text.encodeWide(prefix, 0).subarray(0, -1),
    archive ?? new TextEncoder().encode('(null)'),
    Uint8Array.of(32, 58, 32),
    resource,
    text.encodeWide(suffix, 0),
  ];
  const length = pieces.reduce((sum, part) => sum + part.length, 0);
  if (length > 256) throw new RangeError('Buriko module error message exceeds native scratch');
  const result = new Uint8Array(length);
  let offset = 0;
  for (const piece of pieces) {
    result.set(piece, offset);
    offset += piece.length;
  }
  return result;
}

/** Complete native wrappers over the title's concrete program resource path. */
export function createGroup80Resources(
  scheduler: BurikoBpScheduler,
  control: BurikoVmControlState,
  resources: BurikoProgramResources,
): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x80,
      secondary: 0x40,
      nativeAddress: 0x1400e8e10,
      name: 'LoadModule',
      execute: async (context): Promise<0> => {
        const {thread, memory} = context;
        const resourcePointer = memory.resolve(thread, pop32(thread));
        const archivePointer = memory.resolve(thread, pop32(thread));
        const resource = name(resourcePointer, false)!,
          archive = name(archivePointer, true);
        const bytes = await resources.readModule(archive, resource, true, context.actor);
        if (bytes === null)
          return resources.errors.threadFatal(
            thread,
            context.diagnostics,
            burikoProgramLoadDiagnostic(resources, 'missing', archive, resource),
          );
        const base = attachModule(thread, resource, bytes);
        if (base === BURIKO_BP_MODULE_NO_SPACE)
          return resources.errors.threadFatal(
            thread,
            context.diagnostics,
            burikoProgramLoadDiagnostic(resources, 'space', archive, resource),
          );
        push32(thread, base);
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x44,
      nativeAddress: 0x1400e8d10,
      name: 'StartProgramThread',
      execute: async (context): Promise<0> => {
        const {thread, memory} = context;
        const frameCapacity = pop32(thread),
          moduleCapacity = pop32(thread),
          operandCapacity = pop32(thread);
        const resourcePointer = memory.resolve(thread, pop32(thread));
        const archivePointer = memory.resolve(thread, pop32(thread));
        const resource = name(resourcePointer, false)!,
          archive = name(archivePointer, true);
        const bytes = await resources.readModule(archive, resource, false, context.actor);
        if (bytes === null) {
          const diagnostic = burikoProgramLoadDiagnostic(resources, 'missing', archive, resource);
          if (thread !== scheduler.root.state)
            return resources.errors.threadFatal(thread, context.diagnostics, diagnostic);
          await resources.errors.show(diagnostic);
          push32(thread, 0);
          return 0;
        }
        const child = new BurikoBpThread({
          id: control.allocateThreadId(),
          operandCapacity,
          moduleCapacity,
          frameCapacity,
          heapEnabled: true,
          mode: 0,
        });
        scheduler.append(child);
        if (attachModule(child, resource, bytes) === BURIKO_BP_MODULE_NO_SPACE) {
          // Native fatal leaves the newly appended thread and its allocations in the root list.
          return resources.errors.threadFatal(
            thread,
            context.diagnostics,
            burikoProgramLoadDiagnostic(resources, 'thread-space', archive, resource),
          );
        }
        push32(thread, child.id);
        return 0;
      },
    },
  ];
}

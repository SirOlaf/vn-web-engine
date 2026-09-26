import {pointerView, type BurikoBpPointer} from '../bp/memory.js';
import type {BurikoBpScheduledThread} from '../bp/scheduler.js';
import {BurikoBpScheduler} from '../bp/scheduler.js';
import type {BurikoBpThread} from '../bp/state.js';
import {pop32, push32} from '../bp/state.js';
import {type BurikoInstallationCall, BurikoInstallationService} from './installation.js';
import {textBytes} from './text.js';
import type {BurikoBpOpcodeContext, BurikoNativeSlotDefinition} from './types.js';

function requirePointer(pointer: BurikoBpPointer | null, what: string): BurikoBpPointer {
  if (pointer === null) throw new Error(`Buriko installation dereferences a null ${what}`);
  return pointer;
}

function copyString(pointer: BurikoBpPointer | null, what: string): Uint8Array {
  return textBytes(requirePointer(pointer, what), true).slice();
}

export function copyAddressString(
  context: BurikoBpOpcodeContext,
  address: number,
  what: string,
): Uint8Array {
  return copyString(context.memory.resolve(context.thread, address), what);
}

/** 9BFF0's zero-terminated VM-address input becomes independent native strings. */
export function copyStringArray(
  context: BurikoBpOpcodeContext,
  address: number,
  nullable: boolean,
  what: string,
): Uint8Array[] {
  const pointer = context.memory.resolve(context.thread, address);
  if (pointer === null) {
    if (nullable) return [];
    throw new Error(`Buriko installation dereferences a null ${what} array`);
  }
  const view = pointerView(pointer),
    strings: Uint8Array[] = [];
  for (let offset = 0; ; offset += 4) {
    const item = view.getUint32(offset, true);
    if (item === 0) return strings;
    strings.push(copyAddressString(context, item, what));
  }
}

export function copyFixedStringArray(
  context: BurikoBpOpcodeContext,
  address: number,
  count: number,
  what: string,
): Uint8Array[] {
  count >>>= 0;
  if (count === 0) return [];
  const view = pointerView(
    requirePointer(context.memory.resolve(context.thread, address), `${what} array`),
    count * 4,
  );
  return Array.from({length: count}, (_, index) =>
    copyAddressString(context, view.getUint32(index * 4, true), what),
  );
}

export function copyGroupCounts(
  context: BurikoBpOpcodeContext,
  address: number,
  count: number,
): Uint32Array {
  count >>>= 0;
  if (count === 0) return new Uint32Array();
  const view = pointerView(
    requirePointer(context.memory.resolve(context.thread, address), 'group-count array'),
    count * 4,
  );
  return Uint32Array.from({length: count}, (_, index) => view.getUint32(index * 4, true));
}

function scheduled(scheduler: BurikoBpScheduler, thread: BurikoBpThread): BurikoBpScheduledThread {
  const node = thread === scheduler.root.state ? scheduler.root : scheduler.findById(thread.id);
  if (node === null || node.state !== thread)
    throw new Error('Buriko installation thread is not linked to its scheduler');
  return node;
}

/** Bank 81:F2 snapshots all thirteen inputs before constructing its real wait process. */
export function createGroup81Installation(
  service: BurikoInstallationService,
  scheduler: BurikoBpScheduler,
): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x81,
      secondary: 0xf2,
      nativeAddress: 0x1400ea480,
      name: 'StartInstallation',
      execute: async (context): Promise<0 | 2> => {
        const uninstallerRetryAddress = pop32(context.thread),
          uninstallerAddress = pop32(context.thread),
          productAddress = pop32(context.thread),
          publisherAddress = pop32(context.thread),
          numberedFormatAddress = pop32(context.thread),
          numberedCount = pop32(context.thread),
          retryMessagesAddress = pop32(context.thread),
          mediaProbeNamesAddress = pop32(context.thread),
          groupCountsAddress = pop32(context.thread),
          groupCount = pop32(context.thread),
          fileNamesAddress = pop32(context.thread),
          directoriesAddress = pop32(context.thread),
          destinationAddress = pop32(context.thread),
          call: BurikoInstallationCall = {
            destinationRoot: copyAddressString(context, destinationAddress, 'destination root'),
            directories: copyStringArray(context, directoriesAddress, true, 'relative directory'),
            fileNames: copyStringArray(context, fileNamesAddress, false, 'installation filename'),
            groupCounts: copyGroupCounts(context, groupCountsAddress, groupCount),
            mediaProbeNames: copyFixedStringArray(
              context,
              mediaProbeNamesAddress,
              groupCount,
              'media probe name',
            ),
            retryMessages: copyFixedStringArray(
              context,
              retryMessagesAddress,
              groupCount,
              'media retry message',
            ),
            numberedCount,
            numberedFormat: copyAddressString(context, numberedFormatAddress, 'component format'),
            publisher: copyAddressString(context, publisherAddress, 'publisher'),
            product: copyAddressString(context, productAddress, 'product'),
            uninstallerName: copyAddressString(context, uninstallerAddress, 'uninstaller filename'),
            uninstallerRetryMessage: copyAddressString(
              context,
              uninstallerRetryAddress,
              'uninstaller retry message',
            ),
          },
          process = service.createProcess(context.thread);
        let status: number;
        try {
          status = await process.initialize(call);
        } catch (error) {
          process.dispose();
          throw error;
        }
        if (status !== 0) {
          process.dispose();
          push32(
            context.thread,
            status === 0x80000000
              ? 1
              : status === 0x80000001
                ? 2
                : status === 0x80000002
                  ? 3
                  : 0xffffffff,
          );
          return 0;
        }
        scheduled(scheduler, context.thread).installProcess(process);
        return 2;
      },
    },
  ];
}

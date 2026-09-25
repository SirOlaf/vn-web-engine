import {pop32, push32} from '../bp/state.js';
import {
  copyAddressString,
  copyFixedStringArray,
  copyGroupCounts,
  copyStringArray,
} from './group-81-installation.js';
import type {AokanaInstallationCall} from './installation.js';
import type {AokanaInstallerModal} from './installer-modal.js';
import type {AokanaBpOpcodeContext, AokanaNativeSlotDefinition} from './types.js';

const empty = Uint8Array.of(0);

function optionalString(context: AokanaBpOpcodeContext, address: number, label: string): Uint8Array {
  return context.memory.resolve(context.thread, address) === null
    ? empty
    : copyAddressString(context, address, label);
}

/** E6420 clones its four VM arrays before entering C7640's modal transaction. */
export function createGroup80Installation(modal: AokanaInstallerModal): AokanaNativeSlotDefinition[] {
  return [{
    primary: 0x80,
    secondary: 0xf2,
    nativeAddress: 0x1400e6420,
    name: 'RunInstaller',
    execute: async (context): Promise<0> => {
      const cancellable = pop32(context.thread),
        retryAddress = pop32(context.thread),
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
        publishUninstaller = context.memory.resolve(context.thread, uninstallerAddress) !== null,
        call: AokanaInstallationCall = {
          destinationRoot: copyAddressString(context, destinationAddress, 'destination root'),
          directories: copyStringArray(context, directoriesAddress, true, 'relative directory'),
          fileNames: copyStringArray(context, fileNamesAddress, false, 'installation filename'),
          groupCounts: copyGroupCounts(context, groupCountsAddress, groupCount),
          mediaProbeNames: copyFixedStringArray(context, mediaProbeNamesAddress, groupCount, 'media probe name'),
          retryMessages: copyFixedStringArray(context, retryMessagesAddress, groupCount, 'media retry message'),
          numberedCount,
          numberedFormat: optionalString(context, numberedFormatAddress, 'component format'),
          publisher: optionalString(context, publisherAddress, 'publisher'),
          product: optionalString(context, productAddress, 'product'),
          uninstallerName: optionalString(context, uninstallerAddress, 'uninstaller filename'),
          uninstallerRetryMessage: optionalString(context, retryAddress, 'uninstaller retry message'),
          publishUninstaller,
        };
      push32(context.thread, await modal.install(context.thread, call, cancellable));
      return 0;
    },
  }];
}

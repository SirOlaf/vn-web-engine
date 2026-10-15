import type {NativeLibraryImplementation} from '../../platform/native-libraries.js';
import type {WindowsColorDialogHost} from '../../platform/windows-color-dialog.js';
import {COMDLG32, CC_RGBINIT, type Comdlg32Exports} from './contract.js';

/**
 * `comdlg32.dll`: `ChooseColorW` on the host's colour dialog. Without a host the dialog cannot
 * be shown and the call reports a cancel (false), as a closed dialog does.
 */
export function comdlg32Library(
  host: WindowsColorDialogHost | null = null,
): NativeLibraryImplementation<Comdlg32Exports> {
  return {
    contract: COMDLG32,
    identities: [{kind: 'system', fileName: 'comdlg32.dll'}],
    imports: [],
    link: () => ({
      exports: {
        ChooseColorW: async (request) => {
          if (!host) return false;
          const chosen = await host.chooseColor({
            initial: request.flags & CC_RGBINIT ? request.rgbResult & 0xffffff : 0,
            customColors: [...request.customColors],
            flags: request.flags,
          });
          if (!chosen) return false;
          request.rgbResult = chosen.color & 0xffffff;
          chosen.customColors.forEach((c, i) => {
            if (i < request.customColors.length) request.customColors[i] = c & 0xffffff;
          });
          return true;
        },
      },
    }),
  };
}

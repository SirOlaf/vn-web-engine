import {defineNativeContract} from '../../platform/native-libraries.js';

/** `CHOOSECOLORW` members a caller sets and reads. */
export interface ChooseColorRequest {
  owner: number;
  /** `COLORREF` 0x00BBGGRR. */
  rgbResult: number;
  /** The 16 custom colours, read and written back. */
  customColors: number[];
  /** `CC_*` flags. */
  flags: number;
}

/** `comdlg32.dll`: the common dialogs. */
export interface Comdlg32Exports {
  /** `ChooseColorW`: settles with true when a colour was chosen (written to the request). */
  ChooseColorW(request: ChooseColorRequest): Promise<boolean>;
}

export const CC_RGBINIT = 0x00000001;
export const CC_FULLOPEN = 0x00000002;
export const CC_PREVENTFULLOPEN = 0x00000004;

export const COMDLG32 = defineNativeContract<Comdlg32Exports>('comdlg32.dll', '1');

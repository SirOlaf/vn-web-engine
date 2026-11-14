/**
 * The colour dialog (`ChooseColor`) as a host shows it. Colours are `COLORREF` values
 * (0x00BBGGRR); `flags` are the native `CC_*` flags. Null means the user cancelled.
 */
export interface WindowsColorDialogHost {
  chooseColor(request: {
    readonly initial: number;
    readonly customColors: readonly number[];
    readonly flags: number;
  }): Promise<{color: number; customColors: number[]} | null>;
}

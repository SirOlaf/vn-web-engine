/** Selected host order for the two window messages caused by a scoped state change.
 * Win32 message order varies with activation and owner-window circumstances. */
export interface WindowsWindowTransitionProfile {
  readonly minimize: readonly ['size', 'activate'] | readonly ['activate', 'size'];
  readonly restore: readonly ['size', 'activate'] | readonly ['activate', 'size'];
}

/** The scoped browser host publishes geometry before its focus transition. */
export const BROWSER_WINDOWS_WINDOW_TRANSITION_PROFILE: WindowsWindowTransitionProfile = {
  minimize: ['size', 'activate'],
  restore: ['size', 'activate'],
};

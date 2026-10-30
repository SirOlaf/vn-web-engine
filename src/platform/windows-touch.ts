/** A registered Windows Touch input owner. Registration capability is independent of
 * the number of contacts currently down (RegisterTouchWindow can succeed with none).
 */
export interface WindowsTouchHost {
  registered(): boolean;
  count(): number;
  setHold(enabled: boolean): void;
}

/** The page currently delivers pointer events as mouse input, without a registered
 * Windows Touch contact owner. Navigator.maxTouchPoints alone does not establish one.
 */
export class BrowserWindowsTouchHost implements WindowsTouchHost {
  registered(): boolean {
    return false;
  }
  count(): number {
    return 0;
  }
  setHold(_enabled: boolean): void {}
}

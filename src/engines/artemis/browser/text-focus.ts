/** The parts of an element the focus check reads. */
export interface ArtemisFocusElement {
  readonly isConnected: boolean;
  readonly tabIndex: number;
  closest(selectors: string): unknown;
  focus(options?: FocusOptions): void;
}

/**
 * Keys reach the game from the canvas or from a focused DOM text slot. A slot that is hidden,
 * made inert or removed while it has focus (a choice closing after a click on its text) leaves
 * focus on the body, where keys reach nothing; native keys always reach the game window, so
 * the canvas takes focus back. Focus moved elsewhere, or a slot left by a click outside the
 * player, is kept.
 */
export class ArtemisTextFocus {
  private text: ArtemisFocusElement | null = null;

  constructor(
    private readonly document: {readonly activeElement: unknown; readonly body: unknown},
    private readonly canvas: ArtemisFocusElement,
  ) {}

  /** A focusin in the player: `inText` when the target is in the DOM text. */
  focusin(target: ArtemisFocusElement, inText: boolean): void {
    this.text = inText ? target : null;
  }

  /** Called after each DOM text update; true when the canvas took focus back. */
  restore(): boolean {
    const text = this.text;
    if (!text) return false;
    const active = this.document.activeElement;
    const usable = text.isConnected && text.tabIndex >= 0 && !text.closest('[hidden],[inert]');
    if (usable) {
      if (active !== text) this.text = null;
      return false;
    }
    this.text = null;
    if (active !== text && active !== this.document.body && active !== null) return false;
    this.canvas.focus({preventScroll: true});
    return true;
  }
}

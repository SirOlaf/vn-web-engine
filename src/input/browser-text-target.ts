/** Browser selection/editing owns input inside DOM text, including dictionary extensions. */
export function isBrowserTextTarget(target: EventTarget | null): boolean {
  const element = target as Element | null;
  return (
    typeof element?.closest === 'function' &&
    !!element.closest('input,textarea,select,[contenteditable="true"],[data-game-text]')
  );
}

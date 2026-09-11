import type {NoahState} from './noah-state.js';

/** Browser chrome policy for NOAH, observed only when native draw context 10 runs.
 * Gates follow 14002e710 (menu-renderer.ts) and 140031fb0 (title-parent-draw.ts).
 * This observes state; it must never advance a controller or invoke a painter.
 */
export function noahMenuAllowsSidebar(s: NoahState): boolean {
  const v = (offset: number) => s.variable(offset / 4),
    title = !!(s.flags[0x9b]! & 1);
  const progress = v(0x2178),
    fade = v(0x218c),
    overlay = v(0x2190),
    extra = v(0x219c),
    force = !!(s.flags[0x99]! & 16);
  let enabled = v(0x217c) !== 0 || progress !== 0 || title || force;
  if (!enabled) return false;
  if (title) {
    // Press-start, main menu and Extras, including their menu-to-menu transitions.
    // Reveal / New Game zoom / opening phases 0 and 6–9 are intentionally clean.
    if ([1, 2, 3, 4, 5, 10, 11, 12, 15].includes(v(0x210c))) return true;
    enabled =
      (fade !== 0 && (v(0x210c) === 5 || v(0x210c) === 15)) || extra !== 0 || overlay === 12;
  } else if (progress !== 0) return true;
  // Directly opened destinations (e.g. help) need not have an in-game menu behind them.
  return (
    enabled &&
    ((progress === 32 && fade !== 0) || extra !== 0 || overlay === 12 || force) &&
    v(0x2194) > 0 &&
    [0, 1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12, 14].includes(overlay)
  );
}

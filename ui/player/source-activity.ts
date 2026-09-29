import {subscribeSourceActivity, type SourceActivity} from '../../src/core/source-activity.js';
import {
  subscribeRuntimeActivity,
  type RuntimeActivity,
} from '../../src/platform/runtime-activity.js';

/**
 * Host loading feedback stays outside the game's canvas and native presentation.
 * `essentialOnly` limits it to activities that would otherwise look like a frozen game.
 */
export function subscribePlayerActivity(
  changed: (state: {hidden: boolean; label: string}) => void,
  {essentialOnly = false}: {essentialOnly?: boolean} = {},
): () => void {
  const status = {hidden: true, label: ''};
  let source: SourceActivity | undefined;
  let activities: readonly RuntimeActivity[] = [];
  let show: ReturnType<typeof setTimeout> | undefined;
  let hide: ReturnType<typeof setTimeout> | undefined;
  let tick: ReturnType<typeof setInterval> | undefined;
  let frame: number | undefined;
  // Start of the current idle gap; null while reads or activities are pending.
  let idleSince: number | null = null;
  const elapsed = (startedAt: number) => `${Math.floor((performance.now() - startedAt) / 1000)} s`;
  function render(): void {
    const labels = activities.map(
      ({label, startedAt, progress}) =>
        `${label}${progress ? ` ${progress.done}/${progress.total}` : ''}… ${elapsed(startedAt)}`,
    );
    if (source?.pending) {
      const locations = [source.pendingLocal ? 'device' : '', source.pendingRemote ? 'server' : '']
        .filter(Boolean)
        .join(' and ');
      const bytes =
        (source.pendingLocal ? source.readBytes : 0) +
        (source.pendingRemote ? source.receivedBytes : 0);
      labels.push(
        `Reading ${locations} files… ${(bytes / 1048576).toFixed(1)} MiB read; oldest read ${elapsed(source.oldestStartedAt!)}`,
      );
    }
    if (labels.length) status.label = labels.join(' · ');
    changed({...status});
  }
  /** Sequential reads publish per chunk; the label needs at most one render per frame. */
  function renderSoon(): void {
    if (frame !== undefined) return;
    if (typeof requestAnimationFrame === 'undefined') {
      render();
      return;
    }
    frame = requestAnimationFrame(() => {
      frame = undefined;
      if (idleSince === null) render();
    });
  }
  function hideAfterIdle(): void {
    hide = undefined;
    if (idleSince === null) return;
    const remaining = idleSince + 200 - performance.now();
    if (remaining > 0) {
      hide = setTimeout(hideAfterIdle, remaining);
      return;
    }
    // Keep the original show deadline across short gaps between sequential reads.
    // Resetting it at every chunk would hide even minutes of continuous file I/O.
    clearTimeout(show);
    show = undefined;
    clearInterval(tick);
    tick = undefined;
    status.hidden = true;
    changed({...status});
  }
  function update(): void {
    const pending = (source?.pending ?? 0) > 0 || activities.length > 0;
    if (pending) {
      idleSince = null;
      renderSoon();
      if (tick === undefined) tick = setInterval(render, 1000);
      if (show === undefined && status.hidden)
        show = setTimeout(() => {
          status.hidden = false;
          changed({...status});
          show = undefined;
        }, 350);
    } else {
      // One timer spans the gap; it re-arms for the remainder if reads resumed meanwhile.
      if (idleSince === null) idleSince = performance.now();
      if (hide === undefined) hide = setTimeout(hideAfterIdle, 200);
    }
  }
  const unsubscribeSource = essentialOnly
    ? () => {}
    : subscribeSourceActivity((value) => {
        source = value;
        update();
      });
  const unsubscribeRuntime = subscribeRuntimeActivity((value) => {
    activities = essentialOnly ? value.filter(({essential}) => essential) : value;
    update();
  });
  return () => {
    unsubscribeSource();
    unsubscribeRuntime();
    clearTimeout(show);
    clearTimeout(hide);
    clearInterval(tick);
    if (frame !== undefined) cancelAnimationFrame(frame);
  };
}

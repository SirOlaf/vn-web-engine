import {subscribeSourceActivity, type SourceActivity} from '../core/source-activity.js';
import {subscribeRuntimeActivity, type RuntimeActivity} from '../platform/runtime-activity.js';

/** Host loading feedback stays outside the game's canvas and native presentation. */
export function mountSourceActivity(parent: HTMLElement): () => void {
  const status = parent.ownerDocument.createElement('div');
  status.className = 'source-activity';
  status.setAttribute('role', 'status');
  status.hidden = true;
  parent.append(status);
  let source: SourceActivity | undefined;
  let activities: readonly RuntimeActivity[] = [];
  let show: ReturnType<typeof setTimeout> | undefined;
  let hide: ReturnType<typeof setTimeout> | undefined;
  let tick: ReturnType<typeof setInterval> | undefined;
  const elapsed = (startedAt: number) => `${Math.floor((performance.now() - startedAt) / 1000)} s`;
  function render(): void {
    const labels = activities.map(({label, startedAt}) => `${label}… ${elapsed(startedAt)}`);
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
    if (labels.length) status.textContent = labels.join(' · ');
  }
  function update(): void {
    const pending = (source?.pending ?? 0) > 0 || activities.length > 0;
    if (pending) {
      clearTimeout(hide);
      hide = undefined;
      render();
      if (tick === undefined) tick = setInterval(render, 1000);
      if (show === undefined && status.hidden)
        show = setTimeout(() => {
          status.hidden = false;
          show = undefined;
        }, 350);
    } else {
      clearTimeout(hide);
      hide = setTimeout(() => {
        // Keep the original show deadline across short gaps between sequential reads.
        // Resetting it at every chunk would hide even minutes of continuous file I/O.
        clearTimeout(show);
        show = undefined;
        clearInterval(tick);
        tick = undefined;
        status.hidden = true;
        hide = undefined;
      }, 200);
    }
  }
  const unsubscribeSource = subscribeSourceActivity((value) => {
    source = value;
    update();
  });
  const unsubscribeRuntime = subscribeRuntimeActivity((value) => {
    activities = value;
    update();
  });
  return () => {
    unsubscribeSource();
    unsubscribeRuntime();
    clearTimeout(show);
    clearTimeout(hide);
    clearInterval(tick);
    status.remove();
  };
}

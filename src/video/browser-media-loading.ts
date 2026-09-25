import {beginRuntimeActivity} from '../platform/runtime-activity.js';

/** Observe browser-owned media I/O without changing playback, clocks, or buffering policy. */
export function observeBrowserMediaLoading(media: HTMLMediaElement): () => void {
  let metadata = media.readyState >= 1;
  let finish: (() => void) | null = null;
  let label: string | null = null;
  const clear = (): void => {
    finish?.();
    finish = null;
    label = null;
  };
  const loading = (): void => {
    const next = metadata ? 'Buffering movie' : 'Loading movie metadata';
    if (label === next) return;
    clear();
    label = next;
    finish = beginRuntimeActivity(next);
  };
  const started = (): void => {
    metadata = false;
    loading();
  };
  const readMetadata = (): void => {
    metadata = true;
    if (media.readyState >= 3) clear();
    else loading();
  };
  const stalled = (): void => {
    // A stalled download may still have ample playable data in the browser's buffer.
    if (media.readyState < 3 && !media.paused && !media.ended) loading();
  };
  const listeners: ReadonlyArray<readonly [string, () => void]> = [
    ['loadstart', started],
    ['loadedmetadata', readMetadata],
    ['waiting', loading],
    ['stalled', stalled],
    ['canplay', clear],
    ['playing', clear],
    ['ended', clear],
    ['error', clear],
    ['abort', clear],
    ['emptied', clear],
  ];
  for (const [name, listener] of listeners) media.addEventListener(name, listener);
  if (media.readyState < 3) loading();
  return () => {
    for (const [name, listener] of listeners) media.removeEventListener(name, listener);
    clear();
  };
}

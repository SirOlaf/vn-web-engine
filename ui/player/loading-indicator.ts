import {writable} from 'svelte/store';

const storageKey = 'vn-web-engine.loading-indicator';

function saved(): boolean {
  try {
    return localStorage.getItem(storageKey) === 'shown';
  } catch {
    /* The indicator stays hidden when browser storage is unavailable. */
    return false;
  }
}

/** Whether host loading feedback is drawn over the display. Hidden unless the player opts in. */
export const loadingIndicatorShown = writable(saved());

export function setLoadingIndicatorShown(shown: boolean): void {
  loadingIndicatorShown.set(shown);
  try {
    localStorage.setItem(storageKey, shown ? 'shown' : 'hidden');
  } catch {
    /* Keep the live selection even when it cannot be remembered. */
  }
}

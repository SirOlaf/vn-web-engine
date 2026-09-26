import {writable} from 'svelte/store';

/** Page controls observe runtime ownership without reaching into either game engine. */
export const playerRuntimeState = writable({running: false, busy: false, saveBusy: false});

export function setRuntimeState(state: {running?: boolean; busy?: boolean}): void {
  playerRuntimeState.update((current) => ({...current, ...state}));
}

export function setSaveBusy(saveBusy: boolean): void {
  playerRuntimeState.update((current) => ({...current, saveBusy}));
}

export function subscribeSaveBusy(listener: (busy: boolean) => void): () => void {
  let previous: boolean | undefined;
  return playerRuntimeState.subscribe(({saveBusy}) => {
    if (previous === saveBusy) return;
    previous = saveBusy;
    listener(saveBusy);
  });
}

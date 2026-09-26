import {readable} from 'svelte/store';
import {
  subscribeBrowserAudioContexts,
  type BrowserAudioContextHost,
} from '../../src/audio/browser-audio-context-host.js';

interface AudioControlsState {
  available: boolean;
  needsResume: boolean;
  status: string;
  failure: string;
}
let contexts: readonly BrowserAudioContextHost[] = [];
let failure = '';
let publish: ((state: AudioControlsState) => void) | undefined;

export function refreshAudioControls(): void {
  const needsResume = contexts.some((host) => host.snapshot.needsResume);
  if (!needsResume) failure = '';
  publish?.({
    available: contexts.length > 0,
    needsResume,
    failure,
    status: contexts
      .map((host, index) => {
        const snapshot = host.snapshot;
        return `Device ${index + 1}: ${snapshot.state}, ${snapshot.sampleRate.toLocaleString()} Hz, clock ${snapshot.currentTime.toFixed(3)} s`;
      })
      .join('; '),
  });
}

export const audioControls = readable<AudioControlsState>(
  {available: false, needsResume: false, status: '', failure: ''},
  (set) => {
    publish = set;
    const unsubscribe = subscribeBrowserAudioContexts((hosts) => {
      contexts = hosts;
      refreshAudioControls();
    });
    return () => {
      unsubscribe();
      publish = undefined;
    };
  },
);

/** Every resume retains the click's activation even while an earlier request is pending. */
export function resumeBrowserAudio(): void {
  failure = '';
  for (const host of contexts) {
    if (!host.snapshot.needsResume) continue;
    void host.resume().catch((error: unknown) => {
      if (!contexts.includes(host)) return;
      failure = error instanceof Error ? error.message : String(error);
      refreshAudioControls();
    });
  }
  refreshAudioControls();
}

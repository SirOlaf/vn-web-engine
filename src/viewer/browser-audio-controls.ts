import {subscribeBrowserAudioContexts} from '../audio/browser-audio-context-host.js';
import type {BrowserAudioContextHost} from '../audio/browser-audio-context-host.js';

/** Recovery stays available while startup or a native audio wait is pending. */
export function mountBrowserAudioControls(notices: HTMLElement, options: HTMLElement): void {
  const document = notices.ownerDocument;
  const card = document.createElement('section');
  card.className = 'runtime-advisory runtime-audio-recovery';
  card.hidden = true;
  const title = document.createElement('strong');
  title.textContent = 'Audio paused by browser';
  const message = document.createElement('p');
  message.textContent = 'Resume audio to continue playback.';
  const resume = document.createElement('button');
  resume.type = 'button';
  resume.textContent = 'Resume audio';
  const failure = document.createElement('p');
  failure.setAttribute('role', 'status');
  card.append(title, message, resume, failure);
  notices.prepend(card);

  const details = document.createElement('details');
  details.hidden = true;
  const summary = document.createElement('summary');
  summary.textContent = 'Audio diagnostics';
  const state = document.createElement('p');
  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.textContent = 'Refresh audio status';
  details.append(summary, state, refresh);
  options.append(details);

  let contexts: readonly BrowserAudioContextHost[] = [];
  function update(): void {
    card.hidden = !contexts.some((host) => host.snapshot.needsResume);
    details.hidden = contexts.length === 0;
    state.textContent = contexts
      .map((host, index) => {
        const snapshot = host.snapshot;
        return `Device ${index + 1}: ${snapshot.state}, ${snapshot.sampleRate.toLocaleString()} Hz, clock ${snapshot.currentTime.toFixed(3)} s`;
      })
      .join('; ');
    if (card.hidden) failure.textContent = '';
  }
  subscribeBrowserAudioContexts((hosts) => {
    contexts = hosts;
    update();
  });
  refresh.addEventListener('click', update);
  resume.addEventListener('click', () => {
    failure.textContent = '';
    // Every resume must occur before the first await, inside this activation. Never disable
    // the button while a browser leaves an earlier resume promise indefinitely pending.
    for (const host of contexts) {
      if (!host.snapshot.needsResume) continue;
      void host.resume().catch((error: unknown) => {
        if (!contexts.includes(host)) return;
        failure.textContent = error instanceof Error ? error.message : String(error);
        update();
      });
    }
    update();
  });
}

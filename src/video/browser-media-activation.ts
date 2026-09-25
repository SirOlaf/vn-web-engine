/** Start real media playback, requesting a new gesture only when browser autoplay policy
 * requires one. Cancellation retires both the prompt and pending playback; codec failures
 * remain failures for the caller. No media clock, volume, or source is substituted. */
export function playBrowserMediaWithActivation(
  media: HTMLMediaElement,
  options: {document: Document; signal: AbortSignal; returnFocus?: HTMLElement},
): Promise<void> {
  const {document, signal} = options;
  const fullscreenDocument = document as Document & {webkitFullscreenElement?: Element | null};
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let pending = false;
    let prompt: HTMLElement | null = null;
    let button: HTMLButtonElement | null = null;
    let previousFocus: Element | null = null;
    const mount = (): void => {
      if (prompt !== null)
        (
          document.fullscreenElement ??
          fullscreenDocument.webkitFullscreenElement ??
          document.body
        ).append(prompt);
    };
    const cleanup = (): void => {
      signal.removeEventListener('abort', aborted);
      media.removeEventListener('error', failed);
      if (prompt !== null)
        for (const name of ['fullscreenchange', 'webkitfullscreenchange'])
          document.removeEventListener(name, mount);
      const restore = prompt?.contains(document.activeElement) === true;
      prompt?.remove();
      prompt = null;
      button = null;
      if (restore) {
        const target = options.returnFocus ?? previousFocus;
        if (target?.isConnected && 'focus' in target)
          (target as HTMLElement).focus({preventScroll: true});
      }
    };
    const complete = (failed: boolean, error?: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (failed) reject(error);
      else resolve();
    };
    const aborted = (): void => {
      media.pause();
      complete(true, new DOMException('Media playback was retired', 'AbortError'));
    };
    const failed = (): void => {
      complete(true, new Error(media.error?.message || 'Browser media playback failed'));
    };
    const showPrompt = (): void => {
      if (prompt !== null) {
        if (button !== null) button.disabled = false;
        return;
      }
      previousFocus = document.activeElement;
      prompt = document.createElement('section');
      prompt.setAttribute('aria-label', 'Video playback');
      Object.assign(prompt.style, {
        position: 'fixed',
        zIndex: '2147483647',
        bottom: '1rem',
        left: '1rem',
        right: '1rem',
        margin: '0 auto',
        maxWidth: '32rem',
        padding: '1rem',
        border: '1px solid #7484a5',
        borderRadius: '0.5rem',
        background: '#10131c',
        color: '#fff',
        font: '1rem system-ui, sans-serif',
        textAlign: 'center',
      });
      const message = document.createElement('p');
      message.setAttribute('role', 'status');
      message.textContent = 'Your browser paused video playback. Select Play video to continue.';
      button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Play video';
      Object.assign(button.style, {
        padding: '0.6rem 1rem',
        font: 'inherit',
        color: '#fff',
        background: '#26344e',
        border: '1px solid #7484a5',
        borderRadius: '0.35rem',
        cursor: 'pointer',
      });
      button.addEventListener('click', attempt);
      prompt.append(message, button);
      for (const name of ['fullscreenchange', 'webkitfullscreenchange'])
        document.addEventListener(name, mount);
      mount();
      button.focus({preventScroll: true});
    };
    const refused = (error: unknown): void => {
      pending = false;
      if (settled) return;
      if (
        error !== null &&
        typeof error === 'object' &&
        'name' in error &&
        error.name === 'NotAllowedError'
      ) {
        try {
          showPrompt();
        } catch (promptError) {
          complete(true, promptError);
        }
      } else complete(true, error);
    };
    function attempt(): void {
      if (settled || pending) return;
      pending = true;
      if (button !== null) button.disabled = true;
      try {
        // Keep play() in the button's activation task; awaiting anything first loses the gesture.
        void media.play().then(() => {
          pending = false;
          if (settled) {
            if (signal.aborted) media.pause();
            return;
          }
          complete(false);
        }, refused);
      } catch (error) {
        refused(error);
      }
    }
    signal.addEventListener('abort', aborted, {once: true});
    media.addEventListener('error', failed);
    if (signal.aborted) aborted();
    else attempt();
  });
}

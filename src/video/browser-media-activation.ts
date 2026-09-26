/** A host-rendered recovery action. Calling retry must retain the original user gesture. */
export interface BrowserMediaActivationRequest {
  readonly id: number;
  readonly pending: boolean;
  readonly returnFocus?: HTMLElement;
  retry(): void;
}

type ActivationListener = (requests: readonly BrowserMediaActivationRequest[]) => void;
interface ActivationState {
  requests: Map<number, BrowserMediaActivationRequest>;
  listeners: Set<ActivationListener>;
}
const documents = new WeakMap<Document, ActivationState>();
let nextRequest = 0;
function activationState(document: Document): ActivationState {
  let state = documents.get(document);
  if (!state) {
    state = {requests: new Map(), listeners: new Set()};
    documents.set(document, state);
  }
  return state;
}
function publish(state: ActivationState): void {
  const requests = [...state.requests.values()];
  for (const listener of state.listeners) {
    try {
      listener(requests);
    } catch {
      /* Presentation cannot own playback. */
    }
  }
}

/** The shared page UI observes pending browser gestures, outside native media ownership. */
export function subscribeBrowserMediaActivation(
  document: Document,
  listener: ActivationListener,
): () => void {
  const state = activationState(document);
  state.listeners.add(listener);
  listener([...state.requests.values()]);
  return () => state.listeners.delete(listener);
}

/** Start real media playback, requesting a new gesture only when browser autoplay policy
 * requires one. Cancellation retires both the request and pending playback; codec failures
 * remain failures for the caller. No media clock, volume, or source is substituted. */
export function playBrowserMediaWithActivation(
  media: HTMLMediaElement,
  options: {document: Document; signal: AbortSignal; returnFocus?: HTMLElement},
): Promise<void> {
  const {document, signal} = options;
  return new Promise<void>((resolve, reject) => {
    const state = activationState(document);
    const id = ++nextRequest;
    let settled = false;
    let pending = false;
    let requested = false;
    const update = (): void => {
      if (!requested) return;
      state.requests.set(id, {id, pending, returnFocus: options.returnFocus, retry: attempt});
      publish(state);
    };
    const cleanup = (): void => {
      signal.removeEventListener('abort', aborted);
      media.removeEventListener('error', failed);
      if (state.requests.delete(id)) publish(state);
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
    const refused = (error: unknown): void => {
      pending = false;
      if (settled) return;
      if (
        error !== null &&
        typeof error === 'object' &&
        'name' in error &&
        error.name === 'NotAllowedError'
      ) {
        requested = true;
        update();
      } else complete(true, error);
    };
    function attempt(): void {
      if (settled || pending) return;
      pending = true;
      update();
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

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  playBrowserMediaWithActivation,
  subscribeBrowserMediaActivation,
} from '../dist/video/browser-media-activation.js';
import {AokanaBrowserMfController} from '../dist/engines/buriko/games/aokana/native/movie-mf-browser-session.js';
import {AokanaBrowserTraditionalMovieSession} from '../dist/engines/buriko/games/aokana/native/movie-traditional-browser-graph.js';
import {AokanaFullscreenMovieState} from '../dist/engines/buriko/games/aokana/native/movie-fullscreen-state.js';
import {AokanaTraditionalMovieAudioPolicy} from '../dist/engines/buriko/games/aokana/native/movie-traditional-audio-policy.js';
import {AokanaMovieImageConfiguration} from '../dist/engines/buriko/games/aokana/native/movie-image.js';
import {AokanaBitmapStorage} from '../dist/engines/buriko/games/aokana/native/bitmap.js';
import {subscribeRuntimeActivity} from '../dist/platform/runtime-activity.js';

class Element extends EventTarget {
  style = {};
  children = [];
  parentElement = null;
  constructor(document, tag) {
    super();
    this.document = document;
    this.tag = tag;
  }
  get isConnected() {
    return this === this.document.body || !!this.parentElement?.isConnected;
  }
  append(...children) {
    for (const child of children) {
      child.remove();
      child.parentElement = this;
      this.children.push(child);
    }
  }
  remove() {
    if (this.parentElement)
      this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
  }
  contains(child) {
    return child === this || this.children.some((item) => item.contains(child));
  }
  setAttribute() {}
  focus() {
    this.document.activeElement = this;
  }
  getContext() {
    return {
      drawImage() {
        throw new Error('This lifecycle fixture never presents video pixels');
      },
    };
  }
}
class Video extends EventTarget {
  allowed = false;
  calls = 0;
  paused = true;
  currentTime = 0;
  duration = 5;
  videoWidth = 0;
  videoHeight = 0;
  volume = 0.75;
  muted = false;
  error = null;
  readyState = 0;
  load() {
    if (this.src) {
      this.readyState = 1;
      this.dispatchEvent(new Event('loadedmetadata'));
    }
  }
  play() {
    this.calls++;
    if (!this.allowed)
      return Promise.reject(new DOMException('Gesture required', 'NotAllowedError'));
    this.paused = false;
    this.readyState = 3;
    this.dispatchEvent(new Event('playing'));
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  removeAttribute() {
    this.src = '';
  }
  requestVideoFrameCallback() {
    return 1;
  }
  cancelVideoFrameCallback() {}
}
function fixture() {
  const document = new EventTarget();
  document.body = new Element(document, 'body');
  document.activeElement = document.body;
  document.videos = [];
  document.createElement = (tag) => {
    if (tag !== 'video') return new Element(document, tag);
    const video = new Video();
    document.videos.push(video);
    return video;
  };
  const canvas = new Element(document, 'canvas');
  document.body.append(canvas);
  let requests = [];
  subscribeBrowserMediaActivation(document, (value) => {
    requests = value;
  });
  const request = () => requests[0];
  return {document, canvas, request};
}
const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

test('browser policy gate publishes host recovery actions, retries in the gesture, and cancels cleanly', async () => {
  const s = fixture(),
    media = new Video(),
    abort = new AbortController();
  const playing = playBrowserMediaWithActivation(media, {
    document: s.document,
    signal: abort.signal,
    returnFocus: s.canvas,
  });
  await tick();
  const request = s.request();
  assert.equal(request.pending, false);
  assert.equal(request.returnFocus, s.canvas);
  assert.equal(media.currentTime, 0);
  assert.equal(media.muted, false);
  assert.equal(media.volume, 0.75);
  request.retry();
  assert.equal(media.calls, 2); // play() happens inside the gesture, before a microtask.
  await tick();
  assert.equal(s.request().pending, false);
  media.allowed = true;
  request.retry();
  await playing;
  assert.equal(s.request(), undefined);
  assert.equal(media.currentTime, 0);

  s.document.webkitFullscreenElement = null;
  const blocked = new Video(),
    cancel = new AbortController();
  const pending = playBrowserMediaWithActivation(blocked, {
    document: s.document,
    signal: cancel.signal,
  });
  await tick();
  const retiredButton = s.request();
  cancel.abort();
  await assert.rejects(pending, {name: 'AbortError'});
  retiredButton.retry();
  assert.equal(blocked.calls, 1);
  assert.equal(s.request(), undefined);

  const broken = new Video();
  const codecFailure = new DOMException('Unsupported codec', 'NotSupportedError');
  broken.play = () => Promise.reject(codecFailure);
  await assert.rejects(
    playBrowserMediaWithActivation(broken, {
      document: s.document,
      signal: new AbortController().signal,
    }),
    (error) => error === codecFailure,
  );
  assert.equal(s.request(), undefined);
});

test('MF and traditional movie owners retain their clocks during activation and remove pending controls on skip/reset', async () => {
  const s = fixture(),
    fullscreen = new AokanaFullscreenMovieState();
  let activities = [];
  const stopObserving = subscribeRuntimeActivity((current) => {
    activities = current.map((activity) => activity.label);
  });
  const controller = new AokanaBrowserMfController(
    s.document,
    {surface: s.canvas, presentationMode: 'canvas'},
    fullscreen,
  );
  await controller.open(new Blob(), new AbortController().signal);
  await tick();
  assert.equal(controller.nativeState84, 2);
  assert.deepEqual(activities, ['Buffering movie']);
  assert.equal(s.document.videos[0].currentTime, 0);
  const retiredButton = s.request();
  controller.finishEarly();
  await tick();
  assert.equal(controller.nativeState84, 0);
  assert.deepEqual(activities, []);
  assert.equal(s.request(), undefined);
  retiredButton.retry();
  assert.equal(s.document.videos[0].calls, 1);
  controller.close();

  const files = {
    text: {decodeAuto: () => 'synthetic.mp4', encodeWide: () => Uint8Array.of(1, 0)},
    hasPathWide: async () => true,
  };
  const resources = {files, configuration: {nativeFileRoot: ''}};
  const documents = {files, candidates: {resources}, read: async () => ({blob: new Blob()})};
  const device = {
    canvas: s.canvas,
    presentationMode: 'canvas',
    display: {logicalWidth: 2, logicalHeight: 2},
    dynamicTexture: {
      lock: () => ({
        storage: new AokanaBitmapStorage(new Uint8Array(16), true),
        offset: 0,
        pitch: 8,
      }),
      unlock() {},
    },
  };
  const create = s.document.createElement;
  s.document.createElement = (tag) => {
    const element = create(tag);
    if (tag === 'video') {
      element.videoWidth = 2;
      element.videoHeight = 2;
    }
    return element;
  };
  const session = new AokanaBrowserTraditionalMovieSession(
    resources,
    documents,
    s.document,
    device,
    new AokanaMovieImageConfiguration(),
    fullscreen,
    new AokanaTraditionalMovieAudioPolicy(),
  );
  try {
    assert.equal(await session.start(null, {bytes: Uint8Array.of(1, 0), offset: 0}), 5000);
    await tick();
    assert.equal(session.isPlaying(), true);
    assert.deepEqual(activities, ['Buffering movie']);
    const video = s.document.videos.at(-1);
    assert.equal(video.currentTime, 0);
    video.allowed = true;
    s.request().retry();
    await tick();
    assert.equal(video.paused, false);
    assert.deepEqual(activities, []);
    video.dispatchEvent(new Event('stalled'));
    assert.deepEqual(activities, []); // Network stall is harmless while playable data remains.
    video.readyState = 2;
    video.dispatchEvent(new Event('waiting'));
    assert.deepEqual(activities, ['Buffering movie']);
    video.readyState = 3;
    video.dispatchEvent(new Event('canplay'));
    assert.deepEqual(activities, []);
    assert.equal(s.request(), undefined);
    video.currentTime = 5;
    assert.equal(session.isPlaying(), false);

    await session.start(null, {bytes: Uint8Array.of(1, 0), offset: 0});
    await tick();
    const button = s.request(),
      pendingVideo = s.document.videos.at(-1);
    const releaseReset = await session.beginReset();
    assert.deepEqual(activities, []);
    assert.equal(s.request(), undefined);
    assert.equal(pendingVideo.paused, true);
    button.retry();
    assert.equal(pendingVideo.calls, 1);
    releaseReset();
  } finally {
    await session.closeAndJoin();
    stopObserving();
  }
});

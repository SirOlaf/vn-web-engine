import assert from 'node:assert/strict';
import {test} from 'node:test';
import {playBrowserMediaWithActivation} from '../dist/video/browser-media-activation.js';
import {AokanaBrowserMfController} from '../dist/engines/buriko/games/aokana/native/movie-mf-browser-session.js';
import {AokanaBrowserTraditionalMovieSession} from '../dist/engines/buriko/games/aokana/native/movie-traditional-browser-graph.js';
import {AokanaFullscreenMovieState} from '../dist/engines/buriko/games/aokana/native/movie-fullscreen-state.js';
import {AokanaTraditionalMovieAudioPolicy} from '../dist/engines/buriko/games/aokana/native/movie-traditional-audio-policy.js';
import {AokanaMovieImageConfiguration} from '../dist/engines/buriko/games/aokana/native/movie-image.js';
import {AokanaBitmapStorage} from '../dist/engines/buriko/games/aokana/native/bitmap.js';

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
  load() {
    if (this.src) this.dispatchEvent(new Event('loadedmetadata'));
  }
  play() {
    this.calls++;
    if (!this.allowed)
      return Promise.reject(new DOMException('Gesture required', 'NotAllowedError'));
    this.paused = false;
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
  const prompt = () => document.body.children.find((child) => child.tag === 'section');
  const button = () => prompt()?.children.find((child) => child.tag === 'button');
  return {document, canvas, prompt, button};
}
const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

test('browser policy gate retries from a gesture without changing media state, survives fullscreen, and cancels cleanly', async () => {
  const s = fixture(),
    media = new Video(),
    abort = new AbortController();
  const playing = playBrowserMediaWithActivation(media, {
    document: s.document,
    signal: abort.signal,
    returnFocus: s.canvas,
  });
  await tick();
  const prompt = s.prompt(),
    button = s.button();
  assert.equal(button.textContent, 'Play video');
  assert.equal(media.currentTime, 0);
  assert.equal(media.muted, false);
  assert.equal(media.volume, 0.75);
  const fullscreen = new Element(s.document, 'main');
  s.document.body.append(fullscreen);
  s.document.webkitFullscreenElement = fullscreen;
  s.document.dispatchEvent(new Event('webkitfullscreenchange'));
  assert.equal(prompt.parentElement, fullscreen);
  button.dispatchEvent(new Event('click'));
  assert.equal(media.calls, 2); // play() happens inside the gesture, before a microtask.
  await tick();
  assert.equal(button.disabled, false);
  media.allowed = true;
  button.dispatchEvent(new Event('click'));
  await playing;
  assert.equal(prompt.parentElement, null);
  assert.equal(s.document.activeElement, s.canvas);
  assert.equal(media.currentTime, 0);

  s.document.webkitFullscreenElement = null;
  const blocked = new Video(),
    cancel = new AbortController();
  const pending = playBrowserMediaWithActivation(blocked, {
    document: s.document,
    signal: cancel.signal,
  });
  await tick();
  const retiredButton = s.button();
  cancel.abort();
  await assert.rejects(pending, {name: 'AbortError'});
  retiredButton.dispatchEvent(new Event('click'));
  assert.equal(blocked.calls, 1);
  assert.equal(s.prompt(), undefined);

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
  assert.equal(s.prompt(), undefined);
});

test('MF and traditional movie owners retain their clocks during activation and remove pending controls on skip/reset', async () => {
  const s = fixture(),
    fullscreen = new AokanaFullscreenMovieState();
  const controller = new AokanaBrowserMfController(
    s.document,
    {surface: s.canvas, presentationMode: 'canvas'},
    fullscreen,
  );
  await controller.open(new Uint8Array(), new AbortController().signal);
  await tick();
  assert.equal(controller.nativeState84, 2);
  assert.equal(s.document.videos[0].currentTime, 0);
  const retiredButton = s.button();
  controller.finishEarly();
  await tick();
  assert.equal(controller.nativeState84, 0);
  assert.equal(s.prompt(), undefined);
  retiredButton.dispatchEvent(new Event('click'));
  assert.equal(s.document.videos[0].calls, 1);
  controller.close();

  const files = {
    text: {decodeAuto: () => 'synthetic.mp4', encodeWide: () => Uint8Array.of(1, 0)},
    hasPathWide: async () => true,
  };
  const resources = {files, configuration: {nativeFileRoot: ''}};
  const documents = {files, candidates: {resources}, read: async () => ({bytes: new Uint8Array()})};
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
    const video = s.document.videos.at(-1);
    assert.equal(video.currentTime, 0);
    video.allowed = true;
    s.button().dispatchEvent(new Event('click'));
    await tick();
    assert.equal(video.paused, false);
    assert.equal(s.prompt(), undefined);
    video.currentTime = 5;
    assert.equal(session.isPlaying(), false);

    await session.start(null, {bytes: Uint8Array.of(1, 0), offset: 0});
    await tick();
    const button = s.button(),
      pendingVideo = s.document.videos.at(-1);
    const releaseReset = await session.beginReset();
    assert.equal(s.prompt(), undefined);
    assert.equal(pendingVideo.paused, true);
    button.dispatchEvent(new Event('click'));
    assert.equal(pendingVideo.calls, 1);
    releaseReset();
  } finally {
    await session.closeAndJoin();
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BrowserWindowDisplayHost,
  browserDesktopSize,
} from '../dist/platform/browser-window-display.js';

function fixture(prefixed = false) {
  const document = new EventTarget(),
    view = new EventTarget(),
    root = {},
    calls = [],
    messages = [];
  const saved = new Map();
  Object.assign(view, {
    innerHeight: 900,
    devicePixelRatio: 2,
    screen: {width: 1440, height: 900},
    localStorage: {
      getItem: (key) => saved.get(key),
      setItem: (key, value) => saved.set(key, value),
    },
  });
  document.defaultView = view;
  const elementKey = prefixed ? 'webkitFullscreenElement' : 'fullscreenElement';
  let reject = false;
  Object.assign(root, {
    ownerDocument: document,
    toggleAttribute(name, active) {
      root[name] = active;
    },
    [prefixed ? 'webkitRequestFullscreen' : 'requestFullscreen']() {
      calls.push('enter');
      if (reject) return Promise.reject(new Error('No user activation'));
      document[elementKey] = root;
      document.dispatchEvent(new Event(prefixed ? 'webkitfullscreenchange' : 'fullscreenchange'));
      return Promise.resolve();
    },
  });
  document[prefixed ? 'webkitExitFullscreen' : 'exitFullscreen'] = () => {
    calls.push('exit');
    document[elementKey] = null;
    document.dispatchEvent(new Event(prefixed ? 'webkitfullscreenchange' : 'fullscreenchange'));
    return Promise.resolve();
  };
  const viewport = {
    style: {},
    clientWidth: 960,
    clientHeight: 720,
    getBoundingClientRect: () => ({top: 100}),
  };
  const windowElement = {style: {}, getBoundingClientRect: () => ({left: 32, top: 140})};
  const auxiliaryLayer = {style: {}};
  const host = new BrowserWindowDisplayHost(
    root,
    viewport,
    windowElement,
    () => {},
    (message) => messages.push(message),
    auxiliaryLayer,
  );
  return {
    host,
    document,
    view,
    root,
    viewport,
    windowElement,
    auxiliaryLayer,
    calls,
    messages,
    saved,
    reject: (value) => {
      reject = value;
    },
  };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('native desktop pixels, fitted window and pointer mapping retain one coordinate space', () => {
  const s = fixture();
  assert.deepEqual(browserDesktopSize(s.view), [2880, 1800]);
  s.host.configure({width: 1920, height: 1080, fullscreen: false});
  s.host.setPosition(300, 200);
  assert.equal(s.windowElement.style.transform, 'scale(0.5)');
  assert.equal(s.windowElement.style.top, '90px');
  assert.equal(s.viewport.style.height, '540px');
  const m = s.host.readViewportScreenMapping();
  assert.equal(m.originX + (32 + 480) * m.nativePixelsPerCssX, 300 + 960);
  assert.equal(m.originY + (140 + 270) * m.nativePixelsPerCssY, 200 + 540);
  // A narrow viewport scales both dimensions, including native child-window contents.
  s.viewport.clientWidth = 360;
  s.view.dispatchEvent(new Event('resize'));
  assert.equal(s.windowElement.style.transform, 'scale(0.1875)');
  assert.equal(s.host.readViewportScreenMapping().nativePixelsPerCssY, 1920 / 360);
  s.host.dispose();
});

test('expanded presentation stretches both axes and preserves native pointer coordinates', () => {
  const s = fixture();
  s.host.configure({width: 1920, height: 1080, fullscreen: true});
  s.host.setPosition(300, 200);
  assert.equal(s.windowElement.style.transform, 'scale(0.5, 0.6666666666666666)');
  assert.equal(s.auxiliaryLayer.style.transform, s.windowElement.style.transform);
  assert.equal(s.windowElement.style.left, '0px');
  assert.equal(s.windowElement.style.top, '0px');
  assert.equal(s.viewport.style.height, '');
  const mapping = s.host.readViewportScreenMapping();
  assert.equal(mapping.nativePixelsPerCssX, 2);
  assert.equal(mapping.nativePixelsPerCssY, 1.5);
  assert.equal(mapping.originX + (32 + 480) * mapping.nativePixelsPerCssX, 300 + 960);
  assert.equal(mapping.originY + (140 + 360) * mapping.nativePixelsPerCssY, 200 + 540);
  s.viewport.clientWidth = 720;
  s.view.dispatchEvent(new Event('resize'));
  assert.equal(s.windowElement.style.transform, 'scale(0.375, 0.6666666666666666)');
  assert.equal(s.auxiliaryLayer.style.transform, s.windowElement.style.transform);
  s.host.configure({width: 1920, height: 1080, fullscreen: false});
  assert.equal(s.windowElement.style.transform, 'scale(0.375)');
  s.host.dispose();
});

test('page and screen policies follow native transitions, denial, user retry and external exit', async () => {
  for (const prefixed of [false, true]) {
    const s = fixture(prefixed);
    s.host.configure({width: 1920, height: 1080, fullscreen: true});
    assert.equal(s.root['data-expanded'], true);
    assert.deepEqual(s.calls, []);
    s.reject(true);
    s.host.setMode('screen');
    await settle();
    assert.equal(s.host.isExpanded, true);
    assert.equal(s.host.isScreenFullscreen, false);
    assert.equal(s.messages.length, 1);
    assert.equal(s.saved.get('vn.fullscreen-mode'), 'screen');
    s.reject(false);
    s.host.toggleFullscreen();
    await settle();
    assert.equal(s.host.isScreenFullscreen, true);
    s.host.setMode('page');
    await settle();
    assert.equal(s.host.isScreenFullscreen, false);
    assert.equal(s.host.isExpanded, true);
    s.host.configure({width: 1280, height: 720, fullscreen: false});
    assert.equal(s.host.isExpanded, false);
    s.host.toggleFullscreen();
    assert.equal(s.host.isExpanded, true);
    s.host.setFullscreen(false);
    assert.equal(s.root['data-expanded'], false);
    s.host.dispose();
  }
});

test('changing policy during a browser request settles to the latest requested view', async () => {
  const s = fixture();
  let finish;
  s.root.requestFullscreen = () =>
    new Promise((resolve) => {
      finish = () => {
        s.document.fullscreenElement = s.root;
        resolve();
      };
    });
  s.host.setMode('screen');
  s.host.setFullscreen(true);
  s.host.setMode('page');
  finish();
  await settle();
  assert.equal(s.host.isScreenFullscreen, false);
  assert.equal(s.host.isExpanded, true);
  assert.deepEqual(s.calls, ['exit']);
  s.host.dispose();
  // Teardown also exits an entry request that completes after the host is disposed.
  const closing = fixture();
  closing.root.requestFullscreen = () =>
    new Promise((resolve) => {
      finish = () => {
        closing.document.fullscreenElement = closing.root;
        resolve();
      };
    });
  closing.host.setMode('screen');
  closing.host.setFullscreen(true);
  closing.host.dispose();
  finish();
  await settle();
  assert.equal(closing.host.isScreenFullscreen, false);
  assert.deepEqual(closing.calls, ['exit']);
});

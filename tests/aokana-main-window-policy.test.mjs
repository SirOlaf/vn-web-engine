import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpScheduler} from '../dist/engines/buriko/games/aokana/bp/scheduler.js';
import {AokanaBitmapStorage} from '../dist/engines/buriko/games/aokana/native/bitmap.js';
import {AokanaBitmapCompositor} from '../dist/engines/buriko/games/aokana/native/bitmap-compositor.js';
import {AokanaDisplayDamage} from '../dist/engines/buriko/games/aokana/native/display-damage.js';
import {
  AokanaDisplayObject,
  AokanaDisplayObjectEnvironment,
} from '../dist/engines/buriko/games/aokana/native/display-object.js';
import {AokanaDisplayManager} from '../dist/engines/buriko/games/aokana/native/display-manager.js';
import {AokanaNativeDisplayState} from '../dist/engines/buriko/games/aokana/native/display-state.js';
import {AokanaDistributedAllocator} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {AokanaNativeFonts} from '../dist/engines/buriko/games/aokana/native/fonts.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {AokanaSurfaces} from '../dist/engines/buriko/games/aokana/native/surfaces.js';
import {AokanaNativeClock} from '../dist/engines/buriko/games/aokana/native/clock.js';
import {AokanaNativeInput} from '../dist/engines/buriko/games/aokana/native/input.js';
import {
  AokanaNativeCursor,
  AokanaEngineDialogs,
} from '../dist/engines/buriko/games/aokana/native/engine-dialogs.js';
import {AokanaWindowMessages} from '../dist/engines/buriko/games/aokana/native/window-messages.js';
import {AokanaKeyboardMessages} from '../dist/engines/buriko/games/aokana/native/keyboard-messages.js';
import {AokanaCursorPolicy} from '../dist/engines/buriko/games/aokana/native/cursor-policy.js';
import {
  AokanaBrowserMainWindow,
  aokanaWindowCenteredPosition,
  aokanaWindowPositionAllowed,
} from '../dist/engines/buriko/games/aokana/native/browser-main-window.js';
import {AokanaInlineTextControl} from '../dist/engines/buriko/games/aokana/native/inline-text-control.js';
import {AokanaShakeProcess} from '../dist/engines/buriko/games/aokana/native/shake-process.js';
import {AokanaProcedureState} from '../dist/engines/buriko/games/aokana/native/procedure.js';
import {AokanaCrtRandom} from '../dist/engines/buriko/games/aokana/native/system-timing.js';
import {createGroupB0Main} from '../dist/engines/buriko/games/aokana/native/group-b0-main.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';

// A DOM primitive fixture: it never creates a browser, canvas context, image, or rendered asset.
class Element {
  constructor(tag, document) {
    this.tagName = tag.toUpperCase();
    this.document = document;
    this.style = {};
    this.children = [];
    this.listeners = new Map();
    this.selectionStart = this.selectionEnd = 0;
    this.text = '';
  }
  get value() {
    return this.text;
  }
  set value(value) {
    this.text =
      this.tagName === 'INPUT' ? value.replace(/[\r\n]/g, '') : value.replace(/\r\n?|\n/g, '\n');
    this.selectionStart = this.selectionEnd = this.text.length;
  }
  append(element) {
    element.parent = this;
    this.children.push(element);
  }
  remove() {
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
  }
  setAttribute(name, value) {
    this[name] = value;
  }
  focus() {
    this.document.activeElement = this;
  }
  setSelectionRange(start, end, direction = 'none') {
    this.selectionStart = Math.min(start, this.value.length);
    this.selectionEnd = Math.min(end, this.value.length);
    this.selectionDirection = direction;
  }
  setRangeText(text, start, end) {
    this.value = this.value.slice(0, start) + text + this.value.slice(end);
    this.setSelectionRange(start + text.length, start + text.length);
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  fire(type, fields = {}) {
    const event = {
      type,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      ...fields,
    };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    return event;
  }
  getContext() {
    assert.fail('numerical/control tests must not render');
  }
}

function setup() {
  const time = {now: 0},
    clipboard = {text: '', reads: 0, writes: []},
    fontRequests = [];
  const document = {
    activeElement: null,
    createElement(tag) {
      return new Element(tag, this);
    },
    defaultView: {
      navigator: {
        clipboard: {
          async readText() {
            clipboard.reads++;
            return clipboard.text;
          },
          async writeText(value) {
            clipboard.text = value;
            clipboard.writes.push(value);
          },
        },
      },
    },
  };
  const parent = document.createElement('div'),
    surface = document.createElement('canvas');
  const text = new AokanaNativeText();
  text.selectMode(1);
  const fonts = new AokanaNativeFonts(text, {
    async create(request) {
      fontRequests.push(request);
      return {cssFamily: 'Fixture Sans', emSize: request.height - 2, horizontalScale: 1.25};
    },
  });
  fonts.registerName(new TextEncoder().encode('Fixture Sans'), 0);
  const compositor = new AokanaBitmapCompositor();
  compositor.defaultFormat = 1;
  const bounds = {left: 0, top: 0, right: 799, bottom: 599};
  const environment = new AokanaDisplayObjectEnvironment(
    compositor,
    new AokanaDisplayDamage(1024, bounds),
  );
  const display = new AokanaNativeDisplayState(1920, 1080);
  display.requestedWidth = 800;
  display.requestedHeight = 600;
  const manager = new AokanaDisplayManager(
    environment,
    new AokanaSurfaces(fonts, compositor, new AokanaDistributedAllocator(1)),
    display,
  );
  manager.bindDisplayContext({
    bounds,
    bitmap: {
      storage: new AokanaBitmapStorage(new Uint8Array(800 * 600 * 4), true),
      offset: 0,
      stride: 3200,
      width: 800,
      height: 600,
      format: 1,
      bytesPerPixel: 4,
    },
  });
  const clock = new AokanaNativeClock(() => time.now);
  clock.setGapLimit(60000);
  const input = new AokanaNativeInput(display, clock);
  input.foreground = input.pointerAvailable = true;
  const physical = new AokanaNativeCursor(surface),
    cursor = new AokanaCursorPolicy(manager, input, clock, physical);
  const calls = {
    geometry: 0,
    geometryValues: [],
    presented: [],
    ready: true,
    suppressed: false,
    refreshed: 0,
  };
  const host = new AokanaBrowserMainWindow(document, parent, surface, manager, {
    isReady: () => calls.ready,
    presentTransient: (x, y) => {
      calls.presented.push([x, y]);
      return 0;
    },
    inlinePaintSuppressed: () => calls.suppressed,
    geometryChanged: (y) => {
      calls.geometry++;
      calls.geometryValues.push(y);
    },
  });
  const dialogs = new AokanaEngineDialogs(
    {},
    text,
    clock,
    input,
    physical,
    {
      isPresent: () => true,
      refresh: () => {
        calls.refreshed++;
      },
    },
    display,
    null,
    new Uint8Array(),
  );
  const messages = new AokanaWindowMessages(input),
    keyboard = new AokanaKeyboardMessages(messages);
  const inline = new AokanaInlineTextControl(host, fonts, dialogs, messages, keyboard);
  const thread = new AokanaBpThread({
    id: 7,
    operandCapacity: 32,
    moduleCapacity: 64,
    frameCapacity: 64,
  });
  const procedures = new AokanaProcedureState(),
    random = new AokanaCrtRandom();
  const shake = () =>
    new AokanaShakeProcess(
      thread,
      procedures,
      clock,
      input,
      display,
      random,
      host.callbacks.presentTransient,
    );
  const message = (id, wParam = 0, lParam = 0) =>
    inline.handleMessage({target: inline.target, message: id, wParam, lParam});
  return {
    time,
    clipboard,
    fontRequests,
    document,
    parent,
    surface,
    text,
    fonts,
    environment,
    display,
    manager,
    clock,
    input,
    physical,
    cursor,
    calls,
    host,
    messages,
    keyboard,
    inline,
    thread,
    procedures,
    random,
    shake,
    message,
  };
}

test('mode geometry preserves the requested window size, focus and device storage across fullscreen', () => {
  const {display, host, parent, surface, document, manager, calls} = setup();
  const descriptor = manager.environment.displayContext;
  display.frameInsetWidth = 16;
  display.frameInsetHeight = 39;
  surface.width = 320;
  surface.height = 240;
  surface.focus();
  host.applyPosition(100, 200);
  host.applyWindowedGeometry(800, 600, null, 0x90ca0000);
  assert.deepEqual([display.windowX, display.windowY], [100, 200]);
  assert.deepEqual([parent.style.width, parent.style.height], ['816px', '639px']);
  assert.deepEqual([surface.style.width, surface.style.height], ['800px', '600px']);
  assert.equal(parent['data-aokana-window-style'], '90ca0000');
  assert.equal(parent.style.zIndex, 'auto');
  host.applyFullscreenGeometry(-1920, -100, 1920, 1080);
  assert.deepEqual([parent.style.width, parent.style.height], ['1920px', '1080px']);
  assert.deepEqual([display.windowX, display.windowY], [-1920, -100]);
  assert.deepEqual([display.requestedWidth, display.requestedHeight], [800, 600]);
  assert.equal(parent['data-aokana-window-style'], '90000000');
  host.applyWindowedGeometry(1024, 768, [50, 60], 0x90ce0000);
  assert.deepEqual([display.windowX, display.windowY], [50, 60]);
  assert.deepEqual([display.requestedWidth, display.requestedHeight], [1024, 768]);
  assert.equal(parent['data-aokana-window-style'], '90ce0000');
  assert.equal(document.activeElement, surface);
  assert.deepEqual([surface.width, surface.height], [320, 240]);
  assert.equal(manager.environment.displayContext, descriptor);
  assert.equal(calls.geometry, 0);
  assert.deepEqual(calls.presented, []);
});

test('window monitor containment, centering and pending/direct moves use the one shared display state', () => {
  const {display: d, host, parent, calls} = setup();
  host.configureMonitorProfile(
    [
      [-1920, -100, 0, 980],
      [0, 0, 1920, 1080],
    ],
    0,
    8,
    31,
  );
  d.frameInsetWidth = 17;
  assert.deepEqual(aokanaWindowCenteredPosition(d), [-1369, 171]);
  assert.equal(host.center(), 1);
  assert.deepEqual(
    [d.windowX, d.windowY, parent.style.left, parent.style.top],
    [-1369, 171, '-1369px', '171px'],
  );
  assert.equal(aokanaWindowPositionAllowed(d, -2620, -625), true);
  assert.equal(aokanaWindowPositionAllowed(d, -2621, -625), false);
  assert.equal(host.move(-500, 200), 1);
  assert.deepEqual(d.pendingWindowPosition, [-500, 200]);
  assert.equal(d.windowPositionPending, 1);
  assert.equal(d.windowX, -1369);
  d.windowMoveImmediate = 1;
  assert.equal(host.move(100, 250), 1);
  assert.equal(d.windowX, 100);
  assert.equal(calls.geometry, 1);
  assert.deepEqual(calls.geometryValues, [250]);
  d.fullscreen = 1;
  assert.deepEqual(aokanaWindowCenteredPosition(d), [0, 0]);
  assert.equal(host.center(), 0);
  assert.equal(host.move(10, 10), 0);
  assert.equal(d.windowX, 100);
});

test('custom cursor activation, logical movement and independent visibility use shared scene objects', () => {
  const {cursor, input, manager, environment, physical} = setup();
  const handle = manager.createSimple(
    'sprite',
    (order) => new AokanaDisplayObject(environment, 1, order, 1),
  );
  input.pointerClientX = 12;
  input.pointerClientY = 30;
  assert.equal(cursor.setCustom(handle, -2, 7), 0);
  assert.equal(manager.resolve(handle).activation, 1);
  assert.deepEqual(manager.resolve(handle).position(), {x: 10, y: 37});
  assert.equal(physical.requestedVisibility, 0);
  assert.equal(cursor.queryVisible(), 1);
  assert.equal(cursor.setVisible(0), 1);
  assert.equal(cursor.queryVisible(), 0);
  assert.equal(cursor.setVisible(7), 0);
  assert.equal(cursor.setVisible(3), 7);
  assert.equal(cursor.queryVisible(), 7);
  input.pointerClientX = 800;
  cursor.updateCustom();
  assert.equal(physical.requestedVisibility, 1);
  assert.deepEqual(manager.resolve(handle).position(), {x: 798, y: 37});
  assert.equal(cursor.setCustom(0, 99, 99), 0);
  assert.equal(manager.resolve(handle).activation, 0);
  assert.equal(cursor.queryVisible(), 1);
});

test('cursor auto-hide waits for stationary logical input and restores on background/minimize transitions', () => {
  const {cursor, time, input, physical} = setup();
  cursor.setAutoHide(100);
  cursor.advanceAutoHide();
  time.now = 99;
  cursor.advanceAutoHide();
  assert.equal(cursor.queryVisible(), 1);
  time.now = 100;
  cursor.advanceAutoHide();
  assert.equal(cursor.autoHideShown, 0);
  assert.equal(physical.requestedVisibility, 0);
  input.foreground = false;
  cursor.advanceAutoHide();
  assert.equal(cursor.autoHideShown, 1);
  input.foreground = true;
  time.now = 200;
  cursor.advanceAutoHide();
  assert.equal(cursor.autoHideShown, 0);
  input.iconic = 1;
  cursor.advanceAutoHide();
  assert.equal(cursor.autoHideShown, 1);
  input.iconic = 0;
  time.now = 300;
  cursor.advanceAutoHide();
  assert.equal(cursor.autoHideShown, 0);
  cursor.setAutoHide(0);
  assert.equal(cursor.autoHideEnabled, 0);
  assert.equal(cursor.queryVisible(), 1);
  assert.equal(cursor.autoHideShown, 0); // Native disable does not rewrite this field.
});

test('shake deadline stepping, reflection and decay produce the native ordinary sequence', async () => {
  const {shake, time, calls, display} = setup(),
    process = shake();
  assert.equal(display.ordinaryPresentationEnabled, 0);
  assert.equal(process.initialize(0, 8, 1, 2, 50, 4, 0), 0);
  for (let tick = 0; tick < 8; tick++) {
    time.now = tick * 250;
    assert.equal(await process.poll(), Number(tick === 7));
    if (tick < 7) assert.equal(await process.poll(), 0);
  }
  assert.deepEqual(calls.presented, [
    [4, 0],
    [0, 0],
    [-4, 0],
    [0, 0],
    [2, 0],
    [0, 0],
    [-2, 0],
    [0, 0],
    [0, 0],
  ]);
  assert.equal(process.amplitude, 4096);
  process.dispose();
  assert.equal(display.ordinaryPresentationEnabled, 1);
});

test('shake skips late presentations while advancing phase and shares its CRT draws and captures', async () => {
  const s = setup(),
    process = s.shake();
  process.initialize(2, 8, 1, 1, 0, 4, 0);
  await process.poll();
  s.time.now = 750;
  await process.poll();
  await process.poll();
  assert.deepEqual(s.calls.presented, [[4, 4]]);
  assert.equal(await process.poll(), 1);
  assert.deepEqual(s.calls.presented, [
    [4, 4],
    [0, 0],
    [0, 0],
  ]);
  process.dispose();
  const t = setup(),
    expected = new AokanaCrtRandom();
  t.random.seed(123);
  expected.seed(123);
  const randomShake = t.shake();
  randomShake.initialize(3, 64, 1, 2, 0, 4, 1);
  assert.equal(t.input.pointerCaptures[0].token, 0xffffffff);
  assert.equal(t.input.keyCaptures[0].token, 0xffffffff);
  await randomShake.poll();
  for (let index = 0; index < 32; index++) expected.next();
  assert.equal(t.random.next(), expected.next());
  assert.deepEqual(t.calls.presented, [[0, 0]]);
  t.input.inputEventCount++;
  assert.equal(await randomShake.poll(), 1);
  assert.deepEqual(t.calls.presented, [
    [0, 0],
    [0, 0],
  ]);
  randomShake.dispose();
  assert.equal(
    t.input.pointerCaptures.some((entry) => entry.token === 0xffffffff),
    false,
  );
  assert.equal(
    t.input.keyCaptures.some((entry) => entry.token === 0xffffffff),
    false,
  );
});

test('inline creation uses native font/geometry, visibility and wide-text read semantics', async () => {
  const s = setup();
  s.inline.state.setInitial({bytes: new TextEncoder().encode('A日本😀\0'), offset: 0});
  s.inline.state.setAlignment(1);
  s.inline.state.setColor(0x123456);
  assert.equal(await s.inline.create(10, 20, 120, 20, 0, 20, 16, 1), 0);
  const element = s.inline.element,
    frame = s.parent.children[0];
  assert.equal(s.document.activeElement, element);
  assert.deepEqual(s.fontRequests[0], {
    face: 'Fixture Sans',
    height: 20,
    width: 10,
    weight: 100,
    italic: false,
    charset: 128,
    pitchAndFamily: 1,
  });
  assert.deepEqual(
    [frame.style.left, frame.style.top, frame.style.width, frame.style.height],
    ['10px', '20px', '120px', '20px'],
  );
  assert.deepEqual(s.inline.state.rectangle, [10, 20, 129, 39]);
  assert.equal(element.style.width, '96px');
  assert.equal(element.style.textAlign, 'center');
  assert.equal(element.style.color, '#123456');
  assert.deepEqual([element.selectionStart, element.selectionEnd], [0, 5]);
  const output = new Uint8Array(64);
  assert.equal(s.inline.read({bytes: output, offset: 0}), 5);
  assert.equal(new TextDecoder().decode(output.slice(0, output.indexOf(0))), 'A日本😀');
  s.inline.show(7);
  assert.equal(s.inline.state.visible, 7);
  assert.equal(frame.hidden, false);
  s.inline.state.hideOnReturn = 1;
  await s.message(0x102, 13);
  assert.equal(s.inline.state.visible, 0);
  assert.equal(s.document.activeElement, s.surface);
  s.display.fullscreen = 1;
  s.display.displayFlag = 0;
  assert.equal(s.inline.close(), 0);
  assert.equal(s.calls.refreshed, 1);
  assert.equal(s.parent.children.length, 0);
});

test('inline queued default editing performs selection, backspace, copy, cut and policy-vs-direct paste', async () => {
  const s = setup();
  await s.inline.create(0, 0, 120, 40, 0, 16, 4, 1);
  s.inline.element.value = 'A日B';
  await s.message(0xb1, 1, 2);
  await s.message(0x102, 3);
  assert.deepEqual(s.clipboard.writes, ['日']);
  await s.message(0x102, 24);
  assert.equal(s.inline.element.value, 'AB');
  await s.message(0x102, 8);
  assert.equal(s.inline.element.value, 'B');
  s.clipboard.text = '日本';
  await s.message(0x102, 0x16);
  assert.equal(s.inline.element.value, 'B');
  await s.message(0x302);
  assert.equal(s.inline.element.value, '日本B');
  await s.message(0xb1, 0, -1);
  s.inline.state.rejectAscii = 1;
  await s.message(0x102, 65);
  assert.equal(s.inline.element.value, '日本B');
  await s.message(0x303);
  assert.equal(s.inline.element.value, '');
  assert.equal(await s.message(0x7fff), false);
});

test('inline preserves native CRLF counts and maps browser selections before the width policy', async () => {
  const s = setup();
  s.inline.state.setInitial({bytes: new TextEncoder().encode('A\r\n日本\0'), offset: 0});
  await s.inline.create(0, 0, 120, 48, 0, 16, 8, 1);
  assert.equal(s.inline.element.value, 'A\n日本');
  assert.equal(s.inline.read(null), 5);
  await s.message(0xb1, 3, 4);
  assert.deepEqual([s.inline.element.selectionStart, s.inline.element.selectionEnd], [2, 3]);
  await s.message(0x102, 65);
  assert.equal(s.inline.element.value, 'A\nA本');
  const output = new Uint8Array(32);
  assert.equal(s.inline.read({bytes: output, offset: 0}), 5);
  assert.equal(new TextDecoder().decode(output.slice(0, output.indexOf(0))), 'A\r\nA本');
  s.inline.element.value = 'A\nA本\nZ';
  s.inline.element.fire('input');
  assert.equal(s.inline.read({bytes: output, offset: 0}), 8);
  assert.equal(new TextDecoder().decode(output.slice(0, output.indexOf(0))), 'A\r\nA本\r\nZ');
});

test('inline physical text and keyboard paste retain the WM_CHAR filter without double insertion', async () => {
  const s = setup();
  await s.inline.create(0, 0, 120, 20, 0, 16, 2, 1);
  const element = s.inline.element;
  const event = element.fire('beforeinput', {
    inputType: 'insertText',
    data: '日本',
    isComposing: false,
  });
  assert.equal(event.defaultPrevented, true);
  assert.equal(element.value, '日');
  const key = element.fire('keydown', {
    code: 'KeyV',
    key: 'v',
    keyCode: 86,
    repeat: false,
    ctrlKey: true,
    metaKey: false,
    getModifierState: () => false,
  });
  assert.equal(key.defaultPrevented, false);
  const paste = element.fire('paste', {clipboardData: {getData: () => '本'}});
  assert.equal(paste.defaultPrevented, true);
  const queued = s.messages.take();
  assert.equal(queued.message, 0x100);
  assert.equal(queued.target, s.inline.target);
  await s.inline.handleMessage(queued);
  assert.equal(element.value, '日');
  const direct = element.fire('paste', {clipboardData: {getData: () => '本'}});
  assert.equal(direct.defaultPrevented, false);
});

test('inline paint gates record shared display damage without presenting or rendering', async () => {
  const s = setup();
  await s.inline.create(4, 5, 80, 20, 0, 16, 10, 0);
  s.environment.damage.clear();
  s.manager.redraw.pending = 0;
  s.calls.ready = false;
  await s.message(0xf);
  assert.equal(s.environment.damage.count, 0);
  s.calls.ready = true;
  s.calls.suppressed = true;
  await s.message(0xf);
  assert.equal(s.environment.damage.count, 0);
  s.calls.suppressed = false;
  await s.message(0xf);
  assert.deepEqual(s.environment.damage.snapshot(), [
    {key: 0, rectangle: {left: 4, top: 5, right: 83, bottom: 24}},
  ]);
  assert.equal(s.manager.redraw.pending, 1);
  assert.equal(s.manager.redraw.mode, 0);
  assert.deepEqual(s.calls.presented, []);
});

test('inline synthetic navigation updates the selection while physical key provenance prevents a second edit', async () => {
  const s = setup();
  await s.inline.create(0, 0, 120, 20, 0, 16, 20, 1);
  s.inline.element.value = 'A😀BC';
  await s.message(0xb1, 3, 3);
  assert.equal(await s.message(0x100, 0x25), true);
  assert.equal(s.inline.element.selectionStart, 1);
  s.input.setDequeuedKey(0x10, true);
  await s.message(0x100, 0x27);
  assert.deepEqual([s.inline.element.selectionStart, s.inline.element.selectionEnd], [1, 3]);
  s.input.setDequeuedKey(0x10, false);
  await s.message(0x100, 0x2e);
  assert.equal(s.inline.element.value, 'ABC');
  s.messages.enqueuePhysicalTransitions(
    {target: s.inline.target, message: 0x100, wParam: 0x2e, lParam: 1},
    [],
  );
  const event = s.messages.take();
  assert.equal(s.messages.isPhysical(event), true);
  await s.inline.handleMessage(event);
  assert.equal(s.inline.element.value, 'ABC');
  assert.equal(await s.message(0x100, 0x70), false);
});

test('all eighteen B0 wrapper definitions preserve stack order and install the actual shake procedure', async () => {
  const s = setup(),
    memory = new AokanaBpMemory(new Uint8Array(128));
  const scheduler = new AokanaBpScheduler(s.thread, () => 0);
  const slots = createGroupB0Main(s.host, s.cursor, s.inline, scheduler, s.procedures, s.random, {
    threadFatal() {
      assert.fail('normal B0 operations should succeed');
    },
  });
  assert.equal(slots.length, 18);
  for (const slot of slots)
    assert.equal(slot.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[0xb0][slot.secondary]);
  const run = async (secondary, values = []) => {
    for (const value of values) push32(s.thread, value);
    return slots.find((slot) => slot.secondary === secondary).execute({thread: s.thread, memory});
  };
  const handle = s.manager.createSimple(
    'sprite',
    (order) => new AokanaDisplayObject(s.environment, 1, order, 1),
  );
  await run(0x04, [handle, 6, 9]);
  assert.deepEqual(s.manager.resolve(handle).position(), {x: 6, y: 9});
  await run(0x20, [2, 3, 100, 20, 0, 16, 20, 1]);
  assert.deepEqual(s.inline.state.rectangle, [2, 3, 101, 22]);
  await run(0x24, [3]);
  await run(0x23);
  assert.equal(pop32(s.thread), 3);
  await run(0x22, [150]);
  assert.equal(pop32(s.thread), 1);
  assert.equal(s.inline.state.widthPercent, 150);
  await run(0x2a, [2]);
  assert.equal(pop32(s.thread), 1);
  assert.equal(s.inline.state.alignment, 2);
  assert.equal(await run(0x08, [1, 8, 1, 1, 0, 4, 0]), 2);
  assert.equal(scheduler.root.process instanceof AokanaShakeProcess, true);
  assert.equal(scheduler.root.process.mode, 1);
  assert.equal(s.thread.stackIndex, 0);
  for (let tick = 0; tick < 4; tick++) {
    s.time.now = tick * 250;
    await scheduler.root.pollProcess(false);
  }
  assert.equal(scheduler.root.process, null);
  assert.equal(s.display.ordinaryPresentationEnabled, 1);
  assert.deepEqual(s.calls.presented, [
    [0, 4],
    [0, 0],
    [0, -4],
    [0, 0],
    [0, 0],
  ]);
});

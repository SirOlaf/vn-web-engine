import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserTextDialogHost} from '../dist/platform/text-dialog.js';

class FakeElement {
  constructor(document, tagName) {
    this.ownerDocument = document;
    this.tagName = tagName;
    this.style = {};
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.parent = null;
    this.open = false;
    this.value = '';
    this.textContent = '';
  }
  setAttribute(name, value) {
    this.attributes.set(name, value);
  }
  append(...children) {
    for (const child of children) {
      child.parent = this;
      this.children.push(child);
    }
  }
  remove() {
    if (!this.parent) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  addEventListener(type, listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  /** Delivers the event here and to the ancestors, as a bubbling DOM event would. */
  dispatch(type, init = {}) {
    let stopped = false;
    const event = {
      type,
      defaultPrevented: false,
      isComposing: false,
      keyCode: 0,
      ...init,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        stopped = true;
      },
    };
    for (let node = this; node && !stopped; node = node.parent)
      for (const listener of node.listeners.get(type) ?? []) listener(event);
    return event;
  }
  focus() {
    this.ownerDocument.activeElement = this;
  }
  setSelectionRange(start, end) {
    this.selection = [start, end];
  }
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
  }
  find(tagName, text) {
    if (this.tagName === tagName && (text === undefined || this.textContent === text)) return this;
    for (const child of this.children) {
      const found = child.find(tagName, text);
      if (found) return found;
    }
    return null;
  }
}

function setup(request) {
  const document = {activeElement: null};
  document.createElement = (tagName) => new FakeElement(document, tagName);
  const owner = new FakeElement(document, 'section');
  const keys = [];
  owner.addEventListener('keydown', (event) => keys.push(event.key));
  let now = 1000,
    closed = 0;
  const results = [];
  new BrowserTextDialogHost(
    owner,
    () => closed++,
    () => now,
  ).present(
    {
      title: 'T',
      message: 'm',
      canCancel: true,
      fontSize: 18,
      minimumWidth: 300,
      applyDesktopScale: false,
      textField: true,
      inputDelay: 500,
      ...request,
    },
    (result) => results.push(result),
  );
  const dialog = owner.find('dialog');
  return {
    document,
    owner,
    dialog,
    results,
    keys,
    closed: () => closed,
    advance: (ms) => (now += ms),
    key: (key, init = {}) => document.activeElement.dispatch('keydown', {key, ...init}),
  };
}

test('Text dialogs ignore completion during the input delay, then accept with Enter outside IME composition', () => {
  const s = setup({});
  const field = s.dialog.find('input');
  assert.equal(s.dialog.open, true);
  assert.equal(field.value, 'm');
  assert.equal(s.document.activeElement, field);
  assert.deepEqual(field.selection, [0, 0]);
  assert.match(s.dialog.style.cssText, /font:18px Tahoma/);
  assert.match(s.dialog.style.cssText, /min-width:min\(90vw,300px\)/);
  field.value = 'edited';
  s.key('Enter');
  s.dialog.find('button', 'OK').dispatch('click');
  assert.deepEqual(s.results, []);
  s.advance(500);
  assert.equal(s.key('Enter', {isComposing: true}).defaultPrevented, false);
  assert.equal(s.key('Enter', {keyCode: 229}).defaultPrevented, false);
  assert.deepEqual(s.results, []);
  assert.equal(s.key('Enter').defaultPrevented, true);
  assert.deepEqual(s.results, [{result: 1, text: 'edited'}]);
  assert.equal(s.dialog.open, false);
  assert.equal(s.dialog.parent, null);
  assert.equal(s.closed(), 1);
  // Keys never reach the game behind the dialog, and a closed dialog completes once.
  assert.deepEqual(s.keys, []);
  s.key('Escape');
  s.dialog.find('button', 'Cancel').dispatch('click');
  assert.equal(s.results.length, 1);
});

test('Text dialog Tab cycles forward through field, OK and Cancel; Enter on Cancel still accepts', () => {
  const s = setup({});
  const field = s.dialog.find('input'),
    ok = s.dialog.find('button', 'OK'),
    cancel = s.dialog.find('button', 'Cancel');
  const visited = [];
  for (let i = 0; i < 4; i++) {
    assert.equal(s.key('Tab', {shiftKey: i === 2}).defaultPrevented, true);
    visited.push(s.document.activeElement);
  }
  assert.deepEqual(visited, [ok, cancel, field, ok]);
  s.advance(600);
  cancel.focus();
  s.key('Enter');
  assert.deepEqual(s.results, [{result: 1, text: 'm'}]);
});

test('Message dialogs focus OK; Escape cancels without a Cancel button and browser close requests are ignored', () => {
  const s = setup({textField: false, canCancel: false, message: 'line\nline'});
  const ok = s.dialog.find('button', 'OK');
  assert.equal(s.dialog.find('input'), null);
  assert.equal(s.dialog.find('button', 'Cancel'), null);
  assert.equal(s.dialog.find('p').textContent, 'line\nline');
  assert.equal(s.document.activeElement, ok);
  s.advance(500);
  assert.equal(s.dialog.dispatch('cancel').defaultPrevented, true);
  assert.equal(s.dialog.open, true);
  s.key('Tab');
  assert.equal(s.document.activeElement, s.dialog.find('p'));
  s.key('Tab');
  assert.equal(s.document.activeElement, ok);
  s.key('Escape');
  assert.deepEqual(s.results, [{result: 0, text: 'line\nline'}]);
});

test('The text dialog Cancel button cancels and returns the field text', () => {
  const s = setup({inputDelay: 0});
  s.dialog.find('input').value = 'x';
  s.dialog.find('button', 'Cancel').dispatch('click');
  assert.deepEqual(s.results, [{result: 0, text: 'x'}]);
});

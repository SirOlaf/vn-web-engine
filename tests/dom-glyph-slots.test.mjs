import test from 'node:test';
import assert from 'node:assert/strict';
import {slotText} from '../dist/text/glyph-slots.js';
import {decodeNoahGlyph} from '../dist/engines/mages/games/chaos-head-noah/sc3/glyph-unicode.js';
import {NoahState} from '../dist/engines/mages/games/chaos-head-noah/sc3/noah-state.js';
import {
  beginTextFrame,
  collectTextFrame,
  textInteractionBoundary,
  tagGlyph,
  tokenLayouts,
  packedLayouts,
} from '../dist/engines/mages/games/chaos-head-noah/sc3/dom-text-data.js';
import {drawWrappedText} from '../dist/engines/mages/games/chaos-head-noah/sc3/wrapped-text-draw.js';
import {drawMenuText} from '../dist/engines/mages/games/chaos-head-noah/sc3/menu-text-draw.js';
import {drawSceneGlyphs} from '../dist/engines/mages/games/chaos-head-noah/sc3/scene-text-draw.js';
import {SceneText} from '../dist/engines/mages/games/chaos-head-noah/sc3/scene-text.js';
import {compileNativeRectangles} from '../dist/engines/mages/games/chaos-head-noah/sc3/rectangle-submit.js';
import {nativeBlend} from '../dist/engines/mages/games/chaos-head-noah/sc3/render-state.js';
const glyph = (text, line, x, y, alpha = 255) => ({
  id: 1,
  text,
  line,
  x,
  y,
  width: 20,
  height: 30,
  color: 0xffffff,
  alpha,
});
const sprite = (texture = 91, x = 0, y = 0) => ({
  texture,
  source: {x: 0, y: 0, width: 20, height: 30},
  destination: {x, y, width: 20, height: 30},
  alpha: 255,
  color: 0xffffff,
});
const tag = (d, slot, index, id = 1, line = 0, shadow = false) => {
  tagGlyph(d, slot, index, id, {role: 'body', line}, d.destination, d.color, d.alpha, shadow);
  return d;
};

test('one slot keeps continuous text across visual and blank lines with full reveal bounds', () => {
  const glyphs = [
    glyph('日', 0, 0, 0),
    glyph('本', 0, 20, 0),
    glyph('語', 2, 0, 80),
    glyph('。', 2, 20, 80, 0),
  ];
  const a = slotText({id: 'a', glyphs});
  assert.equal(a.text, '日本語');
  assert.equal(a.lines, 3);
  assert.ok(!/[\r\n\u200b\u2028\u2029]/.test(a.text));
  assert.deepEqual(a.bounds, {x: 0, y: 0, width: 40, height: 110});
  glyphs[3].alpha = 255;
  const b = slotText({id: 'a', glyphs});
  assert.equal(b.text, '日本語。');
  assert.deepEqual(b.bounds, a.bounds);
  assert.equal(slotText({id: 'a', glyphs: glyphs.map((g) => ({...g, alpha: 0}))}), undefined);
  assert.equal(
    slotText({id: 'scrolled', glyphs: [glyph('日', 8, 0, 80), glyph('本', 9, 0, 120)]}).text,
    '日本',
  );
});

test('native token roles keep ruby/name separate without breaking body continuity', () => {
  const s = new NoahState(() => 0),
    ids = [0x8001, 1, 0x8002, 2, 0x8009, 3, 0x800a, 4, 0x800b, 5, 0x8000, 0x8000, 6];
  s.put(0x737988, ids.length);
  ids.forEach((id, i) => s.put(0x80d860 + i * 2, id, 2));
  for (const i of [2, 10, 11]) s.put(0x80c520 + i, 7, 1);
  const a = tokenLayouts(s, 0x7fbd80);
  assert.equal(a[1].role, 'name');
  assert.equal(a[7].role, 'ruby-1');
  assert.equal(a[3].line, 0);
  assert.equal(a[9].line, 0);
  assert.equal(a[12].line, 2);
  s.put(0x7fbd88, 1, 2);
  assert.equal(tokenLayouts(s, 0x7fbd80)[1].role, 'body');
});

test('wrapped text records explicit blank lines and native width wraps without re-parsing expressions', () => {
  const s = new NoahState(() => 0);
  beginTextFrame(s);
  let expressions = 0;
  const bytes = [0x80, 1, 0, 0, 0x80, 2, 255],
    host = {
      byte: (a) => bytes[a],
      expression: () => {
        expressions++;
        throw Error('unexpected');
      },
    };
  const draws = drawWrappedText(s, host, 0, 10, 20, 100, 256, 0xffffff, 32, 40, 255).sprites,
    plan = collectTextFrame(draws);
  assert.equal(slotText(plan.slots[0]).text, '01');
  assert.equal(plan.omit.size, 2);
  assert.equal(expressions, 0);
  const narrow = drawWrappedText(
    s,
    {...host, byte: (a) => [0x80, 1, 0x80, 2, 255][a]},
    0,
    0,
    0,
    20,
    256,
    0xffffff,
    32,
    40,
    255,
  ).sprites;
  assert.equal(slotText(collectTextFrame(narrow).slots[0]).text, '01');
});

test('outline passes and color changes produce one dialog node with ordered native lines', () => {
  const s = new NoahState(() => 0),
    host = {
      byte: (a) => [0x80, 1, 0x80, 2, 255][a],
      expression: () => {
        throw Error('unexpected');
      },
    },
    draws = [];
  for (let line = 0; line < 2; line++)
    for (const dx of [-1, 1, 0])
      draws.push(
        ...drawMenuText(
          s,
          host,
          0,
          10 + dx,
          20 + line * 40 + dx,
          100,
          dx ? 0 : 0xffffff,
          32,
          255,
          91,
          {slot: 'dialog', line, index: line * 256, shadow: dx !== 0},
        ),
      );
  const plan = collectTextFrame(draws);
  assert.equal(plan.slots.length, 1);
  assert.equal(slotText(plan.slots[0]).text, '0101');
  assert.equal(plan.omit.size, 12);
  assert.equal(plan.after.size, 1);
  assert.equal(plan.after.get(draws.at(-1))[0], plan.slots[0]);
  for (const g of plan.slots[0].glyphs)
    assert.deepEqual(g.shadows, [
      {x: -1.5, y: -1.5, color: 0, alpha: 255},
      {x: 1.5, y: 1.5, color: 0, alpha: 255},
    ]);
  const content = slotText(plan.slots[0]);
  assert.equal(content.clip.x, content.bounds.x - 1.5);
  assert.equal(content.clip.width, content.bounds.width + 3);
});

test('native submission preserves sidecars without adding fields or changing glyph order across fonts', () => {
  const s = new NoahState(() => 0);
  s.put(0x5b10ac, 3);
  const layouts = packedLayouts(s, 0);
  for (let i = 0; i < 3; i++) {
    layouts[i] = {role: 'body', line: 0};
    s.put(0x5b10e4 + i * 4, i % 2);
    s.put(0x5b8164 + i, i + 1, 1);
    s.put(0x5b9424 + i, 17, 1);
    s.put(0x5b9d84 + i, 32, 1);
    s.put(0x5ba6e4 + i * 2, i * 17, 2);
    s.put(0x5bcc64 + i * 2, 17, 2);
    s.put(0x5bdf24 + i * 2, 32, 2);
    s.put(0x5c20c4 + i, 255, 1);
  }
  const draws = [...drawSceneGlyphs(s, 0, 0, 256, 0, 0), ...drawSceneGlyphs(s, 1, 0, 256, 0, 0)],
    before = structuredClone(draws);
  for (const id of [91, 92]) {
    const base = 0x1d1b200 + id * 0x1b0;
    s.put(base + 0x32, 1, 1);
    s.put(base + 0x76, 4096, 2);
    s.put(base + 0x78, 4096, 2);
  }
  const commands = compileNativeRectangles(s, draws),
    plan = collectTextFrame(commands);
  assert.deepEqual(draws, before);
  assert.equal(plan.slots.length, 1);
  assert.equal(slotText(plan.slots[0]).text, '012');
  assert.equal(plan.omit.size, 6);
  for (const g of plan.slots[0].glyphs)
    assert.deepEqual(g.shadows, [{x: 1.5, y: 1.5, color: 0, alpha: 255}]);
  s.put(0x5b5be4, -1);
  const unshadowed = collectTextFrame(drawSceneGlyphs(s, 0, 0, 256, 0, 0));
  assert.equal(unshadowed.slots[0].glyphs[0].shadows, undefined);
});

test('phone surface text follows native copy coordinates, clipping and draw order', () => {
  const d = tag(sprite(93, 10, 40), 'phone', 0),
    copy = {
      ...sprite(206),
      source: {x: 0, y: 50, width: 100, height: 100},
      destination: {x: 200, y: 300, width: 200, height: 200},
    },
    commands = [
      {kind: 'target', texture: 206, width: 1920, height: 1080},
      d,
      {kind: 'target', texture: null, width: 1920, height: 1080},
      copy,
    ];
  const plan = collectTextFrame(commands),
    g = plan.slots[0].glyphs[0];
  assert.deepEqual([g.x, g.y, g.width, g.height], [220, 280, 40, 60]);
  assert.deepEqual(g.clip, {x: 220, y: 300, width: 40, height: 40});
  assert.equal(plan.after.get(copy)[0], plan.slots[0]);
  assert.ok(plan.omit.has(d));
  assert.ok(!plan.omit.has(copy));
  const native = collectTextFrame([...commands, {...sprite(80), blendState: nativeBlend(2)}]);
  assert.equal(native.slots.length, 1);
  assert.equal(native.omit.size, 0);
  assert.equal(native.after.size, 0);
  const shadow = tag({...sprite(93, 11, 41), color: 0x808080, alpha: 128}, 'phone', 0, 1, 0, true);
  const shaded = collectTextFrame([commands[0], shadow, ...commands.slice(1)]),
    text = slotText(shaded.slots[0]);
  assert.deepEqual(text.shadows, [{x: 2, y: 2, color: 0x808080, alpha: 128}]);
  assert.deepEqual(text.clip, g.clip);
  assert.ok(shaded.omit.has(shadow));
});

test('unknown/custom glyphs and destination-dependent effects retain native text', () => {
  const known = tag(sprite(), 'body', 0),
    unknown = tag(sprite(91, 20), 'body', 1, 0x7000);
  assert.equal(decodeNoahGlyph(0x7000), undefined);
  assert.equal(decodeNoahGlyph(0x64), undefined);
  let plan = collectTextFrame([known, unknown]);
  assert.equal(plan.slots.length, 1);
  assert.equal(plan.slots[0].glyphs.length, 2);
  assert.equal(plan.after.size, 0);
  assert.equal(plan.omit.size, 0);
  const effect = {...sprite(80), blendState: nativeBlend(2)},
    later = tag(sprite(91, 0, 100), 'later', 0, 2);
  plan = collectTextFrame([known, effect, later]);
  assert.equal(plan.slots.length, 2);
  assert.equal(slotText(plan.slots[1]).text, '1');
  assert.equal(plan.after.size, 1);
  assert.ok(!plan.omit.has(known));
  assert.deepEqual(collectTextFrame([]).slots, []);
});

test('real scene continuation appends to its body buffer, including font changes', () => {
  const s = new NoahState(() => 0);
  s.initialize();
  const font = [
    0, 10, 10, 0, 1, 100, 0, 0, 24, 24, 600, 600, 0, 0, 32, 32, 16, 16, 8, 4, 0, 0, 0, 0,
  ];
  font.forEach((n, i) => s.put(0x7fbf00 + i * 2, n, 2));
  s.put(0x7fbd94, 600, 2);
  let bytes = [0x80, 1, 255];
  const text = new SceneText(s, {
    byte: (a) => bytes[a],
    message: () => 0,
    expression: () => {
      throw Error('unexpected');
    },
  });
  text.prepare(0, 0, 8, 0, 0);
  s.flags[0xbe] |= 1;
  bytes = [27, 1, 0x80, 2, 255];
  text.prepare(0, 0, 8, 0, 0);
  assert.equal(s.get(0x5b10ac), 2);
  assert.deepEqual(
    packedLayouts(s, 0).map((g) => [g.role, g.line]),
    [
      ['body', 0],
      ['body', 0],
    ],
  );
  s.flags[0xbe] |= 1;
  bytes = [0, 0x80, 3, 255];
  text.prepare(0, 0, 8, 0, 0);
  assert.equal(packedLayouts(s, 0)[2].line, 1);
  s.resetText(0);
  bytes = [0x80, 4, 255];
  text.prepare(0, 0, 8, 0, 0);
  assert.deepEqual(packedLayouts(s, 0), [{role: 'body', line: 0}]);
});

test('DOM slots retain exactly one Text node as glyphs reveal and slots disappear', async () => {
  const original = globalThis.document,
    originalCancel = globalThis.cancelAnimationFrame;
  class Node {
    constructor() {
      this.children = [];
      this.style = {};
      this.dataset = {};
    }
    append(...children) {
      for (const child of children) {
        child.parent = this;
        this.children.push(child);
      }
    }
    remove() {
      this.parent.children.splice(this.parent.children.indexOf(this), 1);
    }
    getContext() {
      return {measureText: (text) => ({width: [...text].length * 20})};
    }
  }
  class TextNode {
    constructor(data) {
      this.data = data;
    }
    get length() {
      return this.data.length;
    }
    replaceData(start, length, text) {
      this.data = this.data.slice(0, start) + text + this.data.slice(start + length);
    }
  }
  globalThis.document = {
    createElement: () => new Node(),
    createTextNode: (data) => new TextNode(data),
    addEventListener() {},
    removeEventListener() {},
    getSelection: () => null,
  };
  globalThis.cancelAnimationFrame = () => {};
  try {
    const {DomGlyphSlots} = await import('../dist/text/dom-glyph-slots.js'),
      parent = new Node(),
      layer = new DomGlyphSlots(parent),
      glyphs = [glyph('日', 0, 0, 0), glyph('本', 0, 20, 0, 0), glyph('語', 1, 0, 40, 0)];
    layer.show({id: 'body', glyphs}, 1);
    const box = layer.element.children[0],
      span = box.children[0],
      node = span.children[0];
    assert.equal(span.children.length, 1);
    assert.equal(node.data, '日');
    glyphs[1].alpha = 255;
    glyphs[2].alpha = 255;
    layer.show({id: 'body', glyphs}, 3);
    assert.equal(span.children[0], node);
    assert.equal(node.data, '日本語');
    assert.match(span.style.cssText, /white-space:break-spaces/);
    assert.match(span.style.cssText, /--text-wrap-shape:polygon/);
    assert.equal(layer.buffers.get('body'), glyphs);
    layer.show({id: 'body', glyphs}, 3);
    assert.equal(span.children[0], node);
    let cleared = 0,
      blurred = 0;
    span.blur = () => {
      blurred++;
      globalThis.document.activeElement = null;
    };
    globalThis.document.activeElement = span;
    globalThis.document.getSelection = () => ({
      containsNode: (n) => n === node && cleared === 0,
      removeAllRanges: () => cleared++,
    });
    layer.show({id: 'body', glyphs, interactive: false}, 3);
    assert.equal(box.inert, true);
    assert.equal(span.tabIndex, -1);
    assert.match(span.style.cssText, /pointer-events:none/);
    assert.match(span.style.cssText, /user-select:none/);
    assert.equal(cleared, 1);
    assert.equal(blurred, 1);
    assert.equal(span.children[0], node);
    layer.show({id: 'body', glyphs}, 3);
    assert.equal(box.inert, false);
    assert.equal(span.tabIndex, 0);
    assert.match(span.style.cssText, /pointer-events:auto/);
    globalThis.document.getSelection = () => null;
    layer.retain(new Set(), new Set(['body']));
    assert.equal(box.hidden, true);
    assert.equal(span.children[0], node);
    layer.show({id: 'body', glyphs}, 3);
    assert.equal(box.hidden, false);
    assert.equal(span.children[0], node);
    layer.retain(new Set());
    assert.equal(layer.buffers.size, 0);
    assert.equal(layer.element.children.length, 0);
    layer.dispose();
    assert.equal(parent.children.length, 0);
  } finally {
    globalThis.document = original;
    globalThis.cancelAnimationFrame = originalCancel;
  }
});

test('only text above the last modal boundary is interactive, including raster-only menus', () => {
  const story = tag(sprite(), 'story', 0),
    menu = tag(sprite(), 'menu', 0),
    dialog = tag(sprite(), 'dialog', 0);
  textInteractionBoundary([menu]);
  let plan = collectTextFrame([story, menu]);
  assert.deepEqual(
    plan.slots.map((s) => s.interactive),
    [false, true],
  );
  assert.equal(plan.omit.size, 2, 'inactive text still renders through DOM');
  textInteractionBoundary([dialog]);
  assert.deepEqual(
    collectTextFrame([story, menu, dialog]).slots.map((s) => s.interactive),
    [false, false, true],
  );
  const raster = sprite(80);
  textInteractionBoundary([raster]);
  assert.equal(collectTextFrame([story, raster]).slots[0].interactive, false);
  assert.equal(
    collectTextFrame([story]).slots[0].interactive,
    true,
    'closing the menu restores story interaction',
  );
  const state = new NoahState(() => 0);
  for (const id of [80, 91]) {
    const base = 0x1d1b200 + id * 0x1b0;
    state.put(base + 0x32, 1, 1);
    state.put(base + 0x76, 4096, 2);
    state.put(base + 0x78, 4096, 2);
  }
  plan = collectTextFrame(compileNativeRectangles(state, [story, raster, dialog]));
  assert.deepEqual(
    plan.slots.map((s) => s.interactive),
    [false, true],
    'rectangle compilation retains interaction boundaries',
  );
});

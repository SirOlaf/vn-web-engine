import test from 'node:test';
import assert from 'node:assert/strict';
import {Config, RScriptMemory, Scene} from '../dist/engines/rscript/memory.js';
import {RSCRIPT_1_9, RSCRIPT_1_11} from '../dist/engines/rscript/revision.js';
import {RSCRIPT_1_9_LAYOUTS} from '../dist/engines/rscript/vm/layouts.js';
import {MessageState} from '../dist/engines/rscript/runtime/message-window.js';
import {BoxRecord} from '../dist/engines/rscript/runtime/text-box.js';
import {
  MessageSettings19,
  RScriptMessageWindow19,
} from '../dist/engines/rscript/runtime/message-window-19.js';
import {encodeCp932} from '../dist/text/cp932.js';
import {decodeSlotHeader, decodeSlotSave, encodeSlotSave} from '../dist/engines/rscript/saves.js';
import {parseApini} from '../dist/engines/rscript/apini.js';
import {RScriptChoiceWindow} from '../dist/engines/rscript/runtime/choice.js';
import {createSurface} from '../dist/engines/rscript/graphics/pixels.js';

test('RScript 1.9 maps 1.11 configuration and scene offsets to its own blocks', () => {
  assert.equal(RSCRIPT_1_11.configOffset(Config.fontName), Config.fontName);
  assert.equal(RSCRIPT_1_9.configOffset(Config.fontName), 0x816);
  assert.equal(RSCRIPT_1_9.configOffset(Config.systemWords), -1);
  // One sound-effect record: records 1 and 2 are absent and later fields move up 12 bytes.
  assert.equal(RSCRIPT_1_9.sceneOffset(Scene.soundChannels + 6), -1);
  assert.equal(RSCRIPT_1_9.sceneOffset(Scene.layers), Scene.layers - 12);
  // Text box records are 68 bytes without the name plate, ruby and spacing fields.
  const box = (index, field) =>
    RSCRIPT_1_9.sceneOffset(Scene.message + MessageState.boxes + 96 * index + field);
  assert.equal(box(0, BoxRecord.color), 0x5230 + 20 + 52);
  assert.equal(box(1, BoxRecord.visible), 0x5230 + 20 + 68 + 64);
  assert.equal(box(0, BoxRecord.nameX), -1);
  // Backlog entries are 120 bytes: kind, box, source and page record.
  const entry = Scene.message + MessageState.backlog + 2 * MessageState.backlogStride;
  assert.equal(RSCRIPT_1_9.sceneOffset(entry + 112 + 24), 0x5230 + 340 + 240 + 88 + 24);
  assert.equal(RSCRIPT_1_9.sceneOffset(Scene.stringRegisters), Scene.stringRegisters - 2556);

  const memory = new RScriptMemory(RSCRIPT_1_9);
  assert.equal(RSCRIPT_1_9.configSize, 0x85a);
  assert.equal(memory.scene.length, 0x8f70);
  memory.setSceneWord(Scene.layers + 14, 1234);
  assert.equal(memory.sceneView.getUint16(Scene.layers - 12 + 14, true), 1234);
  assert.throws(() => memory.setConfigWord(Config.systemWords, 1));

  // The voice opcode reads its number as a value; one sound channel drops the channel operand.
  assert.deepEqual(RSCRIPT_1_9_LAYOUTS.get(0x42), ['value', 'value', 'value', 'value']);
  assert.equal(RSCRIPT_1_9_LAYOUTS.get(0x3e)?.length, 1);
  assert.equal(RSCRIPT_1_9_LAYOUTS.has(0x6a), false);
});

/** A 1.9 message window without images: glyphs are blank cells of the requested size. */
function messageWindow(strings) {
  const memory = new RScriptMemory(RSCRIPT_1_9);
  memory.setSceneDword(Scene.message + MessageState.backlogEnabled, 1);
  const voices = [];
  const window = new RScriptMessageWindow19({
    memory,
    images: {lwg: async () => null, lwgLayer: async () => null, lwgFrame: async () => null},
    files: {read: async () => null},
    rasterizer: {
      rasterize: (code, size) => {
        const width = code > 0xff ? size : size >> 1;
        return {width, height: size, levels: new Uint8Array(width * size)};
      },
      addFace: () => 3,
      setFace() {},
      removeFace() {},
    },
    systemDirectory: 'grps',
    palette: [],
    shadow: false,
    scriptString: async (_script, index) => encodeCp932(strings[index]),
    backlogColor: null,
    command() {},
    windowAlpha() {},
    voice: (voice, pan) => voices.push([voice, pan]),
    settingsChanged() {},
    listFonts: async () => [],
    redraw() {},
  });
  const base = memory.sceneAt(Scene.message);
  const entry = (index) => {
    const at = base + 340 + 120 * index;
    return {
      kind: memory.scene[at],
      text: memory.sceneView.getUint32(at + 80, true),
      speaker: memory.sceneView.getUint16(at + 84, true),
      voice: memory.sceneView.getUint32(at + 112, true),
    };
  };
  return {window, memory, entry, voices};
}

const glyphs = (window) => window.box.text.shownGlyphs();
const text = (window) =>
  glyphs(window)
    .map((glyph) => glyph.text)
    .join('');

test('RScript 1.9 collects a page of messages with blank lines around speakers', async () => {
  const strings = ['', '　^n海だ', '【青年】^n「おう」', 'あ'.repeat(300)];
  const {window, entry} = messageWindow(strings);
  await window.display(0, {script: 1, text: 1, name: 0}, true, false);
  window.setVoice(30002, 0);
  await window.display(0, {script: 1, text: 2, name: 0}, true, false);
  window.finish();
  assert.equal(text(window), '　海だ　【青年】「おう」');
  // The speaker's message follows a line break and a blank line; the first message dims.
  assert.deepEqual(
    glyphs(window).map((glyph) => glyph.newline),
    [false, true, false, true, true, false, false, false, true, false, false, false],
  );
  assert.ok(glyphs(window)[1].opacity < 0.6);
  assert.equal(glyphs(window).at(-1).opacity, 1);
  assert.equal(glyphs(window)[0].vertical, true);
  assert.deepEqual(entry(98), {kind: 2, text: 1, speaker: 0, voice: 0});
  assert.deepEqual(entry(99), {kind: 1, text: 2, speaker: 1, voice: 30002});

  // A message that no longer fits the page starts the next one.
  window.setVoice(0, 0);
  await window.display(0, {script: 1, text: 3, name: 0}, true, false);
  window.finish();
  assert.equal(text(window), 'あ'.repeat(300));
  assert.deepEqual(entry(99), {kind: 2, text: 3, speaker: 0, voice: 0});
});

test('RScript 1.9 keeps earlier messages lit with the focus setting', async () => {
  const {window, memory} = messageWindow(['', '一', '二']);
  memory.configView.setUint16(MessageSettings19.keepText, 1, true);
  await window.display(0, {script: 1, text: 1, name: 0}, true, false);
  await window.display(0, {script: 1, text: 2, name: 0}, true, false);
  window.finish();
  assert.deepEqual(
    glyphs(window).map((glyph) => glyph.opacity),
    [1, 1],
  );
});

test('RScript 1.9 browses backlog pages with voice marks and returns to the page', async () => {
  const strings = ['', '　^n昔の頁', '【娘】^n「待っている」', '　^n今の頁'];
  const {window, voices} = messageWindow(strings);
  await window.display(0, {script: 1, text: 1, name: 0}, true, false);
  window.setVoice(30004, 0);
  await window.display(0, {script: 1, text: 2, name: 0}, true, false);
  window.clear(0, false);
  window.setVoice(0, 0);
  await window.display(0, {script: 1, text: 3, name: 0}, true, false);
  window.setInput(true);

  assert.equal(await window.enterBacklog(), true);
  assert.equal(window.browsing, true);
  assert.equal(text(window), '　今の頁');
  // The bar reports page indexes from the newest; page 1 is the earlier page, undimmed.
  window['browse'](1);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(text(window), '　昔の頁　【娘】「待っている」');
  assert.ok(glyphs(window).every((glyph) => glyph.opacity === 1));
  const marks = window['voiceMarks'];
  assert.deepEqual(
    marks.map((mark) => [mark.glyph, mark.voice]),
    [[5, 30004]],
  );
  assert.equal(glyphs(window)[5].text, '【');
  assert.deepEqual(voices, []);

  assert.equal(await window.exitBacklog(), true);
  assert.equal(window.browsing, false);
  assert.equal(text(window), '　今の頁');
});

test('RScript 1.9 slots store the live title variables and page text after a 20-byte header', () => {
  const memory = new RScriptMemory(RSCRIPT_1_9);
  memory.variables.set([0, 7, 1002, 3], 0);
  memory.messageVariables.set([0, 1, 1001, 0], 0);
  memory.messageScene[5] = 42;
  const text = encodeCp932('【青年】^n「おう」');
  const bytes = encodeSlotSave(memory, text, new Date(2026, 9, 1, 12, 34));
  assert.equal(bytes.length, 0x66 + 2 * (0x8f70 + 14000));
  const header = decodeSlotHeader(bytes, RSCRIPT_1_9);
  assert.deepEqual(
    [header.year, header.month, header.day, header.hour, header.minute],
    [2026, 10, 1, 12, 34],
  );
  assert.deepEqual(header.variables, [7, 1002, 3]);
  assert.equal(header.background, 0);
  assert.deepEqual([...header.text], [...text]);
  const loaded = new RScriptMemory(RSCRIPT_1_9);
  decodeSlotSave(loaded, bytes);
  assert.equal(loaded.scene[5], 42);
  assert.equal(loaded.variables[2], 1001);
});

test('RScript APINI blocks give choice questions their own text colour and size', () => {
  for (const revision of [RSCRIPT_1_9, RSCRIPT_1_11]) {
    const layout = revision.apini;
    const block = new Uint8Array(layout.size);
    const view = new DataView(block.buffer);
    block.set(Buffer.from('APINI\0', 'latin1'));
    view.setUint32(layout.width, 800, true);
    view.setUint32(layout.height, 600, true);
    view.setUint32(layout.questionTextColor, 0x112233, true);
    view.setUint16(layout.questionTextSize, 28, true);
    view.setUint32(layout.choiceTextColor, 0x445566, true);
    view.setUint16(layout.choiceTextSize, 22, true);
    const apini = parseApini(block, revision);
    assert.deepEqual(
      [
        apini.questionTextColor,
        apini.questionTextSize,
        apini.choiceTextColor,
        apini.choiceTextSize,
      ],
      [0x112233, 28, 0x445566, 22],
      revision.version,
    );
  }
});

/** A choice window over the plain plates only: no `sel_xNN.lwg` exists. */
function choiceWindow(plates) {
  return new RScriptChoiceWindow({
    images: {
      lwg: async () => null,
      lwgLayer: async () => null,
      image: async (path) => plates[path] ?? null,
    },
    rasterizer: {
      rasterize: (code, size) => {
        const width = code > 0xff ? size : size >> 1;
        return {width, height: size, levels: new Uint8Array(width * size)};
      },
      addFace: () => 3,
      setFace() {},
      removeFace() {},
    },
    systemDirectory: 'grps',
    width: 800,
    height: 600,
    palette: [],
    questionTextSize: 28,
    questionTextColor: 0x112233,
    textSize: 22,
    textColor: 0x445566,
    answered() {},
  });
}
const plates = (window) =>
  window.nodes().map((node) => ({
    width: node.width,
    glyphs: node.bakedText.map(({text, x, y, height, color}) => ({text, x, y, height, color})),
  }));

test('RScript choices fall back to the plain sel_q and sel_a plates', async () => {
  const window = choiceWindow({
    'grps\\sel_q': createSurface(560, 60, 0xff000000),
    'grps\\sel_a': createSurface(540, 50, 0xff000000),
  });
  await window.open(encodeCp932('問'), [encodeCp932('<3>答')], 0);
  // The question's text sits at (20,14) in its style, the answer's at (20,11) in its own.
  assert.deepEqual(plates(window), [
    {width: 560, glyphs: [{text: '問', x: 20, y: 14, height: 28, color: 0x112233}]},
    {width: 540, glyphs: [{text: '答', x: 20, y: 11, height: 22, color: 0x445566}]},
  ]);

  // Without the plain images, answers are left out and the question keeps its text.
  const bare = choiceWindow({});
  await bare.open(encodeCp932('問'), [encodeCp932('答')], 0);
  assert.deepEqual(
    plates(bare).map((plate) => plate.glyphs.map((glyph) => glyph.text).join('')),
    ['問'],
  );
});

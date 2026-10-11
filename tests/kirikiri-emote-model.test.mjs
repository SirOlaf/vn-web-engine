import test from 'node:test';
import assert from 'node:assert/strict';
import {PsbResource} from '../dist/formats/kirikiri/psb.js';
import {decryptPsbBody} from '../dist/formats/kirikiri/psb-filter.js';
import {
  EMOTE_MOTION_VERSION,
  EmoteModelError,
  readEmoteModel,
  walkEmoteLayers,
} from '../dist/formats/kirikiri/emote-model.js';
import {buildPsb, emoteWinTree as winModel, f32, resource} from './kirikiri-psb-fixtures.mjs';

test('E-mote model reads the source, layer tree, keyframes and controls of a win file', () => {
  const model = readEmoteModel(buildPsb(winModel()));
  assert.equal(model.spec, 'win');
  assert.equal(model.version, EMOTE_MOTION_VERSION);
  assert.deepEqual(model.diagnostics, []);
  assert.ok('stereovisionProfile' in model.unread);

  const texture = model.sources.get('tex').texture;
  assert.equal(texture.type, 'DXT5');
  assert.deepEqual([texture.width, texture.height, texture.mipMapLevel], [256, 128, 2]);
  assert.ok(texture.pixel instanceof PsbResource);
  assert.deepEqual([...texture.pixel.bytes], [1, 2, 3, 4]);
  assert.deepEqual([...texture.mipMap[0].pixel.bytes], [5, 6]);
  const icon = model.sources.get('tex').icons.get('eye');
  assert.deepEqual(
    [icon.left, icon.top, icon.width, icon.height, icon.originY, icon.attr],
    [4, 8, 32, 16, 7.5, 1],
  );

  const motion = model.objects.get('all_parts').motions.get('base');
  assert.equal(motion.parameters[0].id, 'head_LR');
  assert.equal(motion.parameterize, 0);
  assert.equal(motion.layerIndexMap.get('head'), 1);
  assert.ok('enabled' in motion.parameters[0].unread);
  const labels = [...walkEmoteLayers(motion.layers)].map(({layer, depth}) => [layer.label, depth]);
  assert.deepEqual(labels, [
    ['root', 0],
    ['head', 1],
    ['mask', 1],
  ]);

  const [root] = motion.layers,
    [head, mask] = root.children;
  assert.equal(root.parameterize, 0);
  assert.equal(root.stencilType, 0);
  assert.equal(root.mesh, null);
  assert.equal(head.objTriPriority, 2);
  assert.equal(head.stencilType, 5);
  assert.deepEqual(head.mesh, {syncChildMask: 8, division: 20, combine: true});
  assert.deepEqual(mask.stencilCompositeMaskLayerList, ['head']);
  assert.deepEqual(Object.keys(head.unread).sort(), ['exportSelf', 'metadata']);

  const [empty, tween, step] = head.frames;
  assert.equal(empty.content, null);
  const c = tween.content;
  assert.deepEqual(c.coord, [1, 2.5, 0]);
  assert.deepEqual(c.color, [1, 2, 3, 4]);
  assert.equal(c.mesh.bp.length, 32);
  assert.equal(c.mesh.bp[31], Math.fround(31 / 8));
  // Defaults where the mask leaves a field unset; keys outside the mask are not read.
  assert.deepEqual([c.zx, c.zy, c.opa, c.bm, c.ox], [1, 1, 255, 0x10, 0]);
  assert.deepEqual(Object.keys(c.unread), ['ox']);
  // Blend mode without colour: bm & 0xf0 == 0 turns the corner colours white.
  assert.equal(step.content.bm, 0);
  assert.deepEqual(step.content.color, [0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff]);
  assert.equal(step.content.mesh, null);

  const m = model.metadata;
  assert.deepEqual(m.base, {chara: 'all_parts', motion: 'base'});
  assert.equal(m.bustControl[0].param.p.y, Math.fround(9.6));
  assert.deepEqual(m.hairControl[0].length, [64, 48]);
  assert.equal(m.hairControl[0].param.p[1].y, 166);
  assert.equal(m.partsControl[0].enabled, false);
  assert.deepEqual(m.eyeControl[0].edge, [
    [-10, 20],
    [30, 30],
  ]);
  assert.equal(m.mouthControl[0].talkLabel, 'face_talk');
  assert.equal(m.selectorControl, null);
  assert.ok('editLock' in m.unread);
  const [timeline] = m.timelineControl;
  assert.equal(timeline.diff, true);
  // A negative lastTime becomes the latest frame time.
  assert.equal(timeline.lastTime, 45);
  assert.deepEqual(
    timeline.variables[0].frames.map((f) => [f.time, f.type, f.value, f.easing]),
    [
      [0, 2, -5, 0],
      [31, 0, null, null],
      [45, 2, 12, -1],
    ],
  );
  assert.deepEqual(m.variableList[0].frames, [{label: 'left', frame: -30}]);
  assert.ok(Object.isFrozen(model) && Object.isFrozen(head) && Object.isFrozen(c));
});

test('E-mote model aborts where the runtime aborts and keeps its defaults elsewhere', () => {
  const missing = winModel();
  delete missing.object.all_parts.motion.base.layer[0].children[0].inheritMask;
  assert.throws(
    () => readEmoteModel(buildPsb(missing)),
    (error) =>
      error instanceof EmoteModelError &&
      /undefined object key 'inheritMask'/.test(error.message) &&
      error.message.includes('layer[0].children[0]'),
  );

  const meshless = winModel();
  delete meshless.object.all_parts.motion.base.layer[0].children[0].meshDivision;
  assert.throws(() => readEmoteModel(buildPsb(meshless)), /'meshDivision'/);

  const badFloat = winModel();
  badFloat.metadata.scale = 'large';
  assert.throws(() => readEmoteModel(buildPsb(badFloat)), /can't convert value to float/);

  // Keys read behind a presence test take the runtime default.
  const defaults = winModel();
  delete defaults.metadata.timelineControl[0].diff;
  delete defaults.object.all_parts.motion.base.layer[0].children[0].stencilType;
  const model = readEmoteModel(buildPsb(defaults));
  assert.equal(model.metadata.timelineControl[0].diff, false);
  assert.equal(
    model.objects.get('all_parts').motions.get('base').layers[0].children[0].stencilType,
    0,
  );
});

test('E-mote model tolerates krkr-spec gaps and reports them as native aborts', () => {
  const krkr = winModel();
  krkr.spec = 'krkr';
  krkr.version = f32(3.1);
  delete krkr.source.tex.texture;
  delete krkr.source.tex.icon.eye.left;
  delete krkr.source.tex.icon.eye.top;
  krkr.source.tex.icon.eye.pixel = resource(Uint8Array.of(7));
  krkr.source.tex.icon.eye.attr = null;
  const motion = krkr.object.all_parts.motion.base;
  delete motion.bounds;
  delete motion.layerIndexMap;
  for (const frame of motion.layer[0].children[0].frameList)
    if (frame.content) delete frame.content.icon;
  krkr.metadata.timelineControl[0].variableList[0].frameList[0].content.value = '20';

  const model = readEmoteModel(
    decryptPsbBody(decryptPsbBody(buildPsb(krkr), 742877301), 742877301),
  );
  assert.equal(model.sources.get('tex').texture, null);
  assert.equal(model.sources.get('tex').icons.get('eye').left, null);
  assert.deepEqual([...model.sources.get('tex').icons.get('eye').pixel.bytes], [7]);
  const m = model.objects.get('all_parts').motions.get('base');
  assert.equal(m.bounds, null);
  assert.equal(m.layerIndexMap, null);
  assert.equal(m.layers[0].children[0].frames[1].content.icon, null);
  assert.equal(model.metadata.timelineControl[0].variables[0].frames[0].value, '20');
  const summary = Object.fromEntries(
    model.diagnostics.map((d) => [`${d.kind} ${d.text}`, d.count]),
  );
  assert.deepEqual(summary, {
    "message spec 'krkr' is not adaptive for emotedriver": 1,
    'message version 3.0999999046325684 is too new': 1,
    "abort psb: undefined object key 'texture' is referenced.": 1,
    "abort psb: undefined object key 'left' is referenced.": 1,
    "abort psb: undefined object key 'top' is referenced.": 1,
    "abort psb: undefined object key 'bounds' is referenced.": 1,
    "abort psb: undefined object key 'layerIndexMap' is referenced.": 1,
    "abort psb: undefined object key 'icon' is referenced.": 2,
    "abort psb: can't convert value to float.": 1,
    "abort psb: can't convert value to int.": 1,
  });
});

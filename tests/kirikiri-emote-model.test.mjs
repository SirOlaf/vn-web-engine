import test from 'node:test';
import assert from 'node:assert/strict';
import {PsbResource} from '../dist/formats/kirikiri/psb.js';
import {decryptPsbBody} from '../dist/formats/kirikiri/psb-filter.js';
import {
  EMOTE_MOTION_VERSION,
  EmoteLayerType,
  EmoteModelError,
  readEmoteModel,
  walkEmoteLayers,
} from '../dist/formats/kirikiri/emote-model.js';
import {buildPsb, f32, resource} from './kirikiri-psb-fixtures.mjs';

const vec = (x, y, z = 0) => ({x, y, z});
const layer = (fields) => ({
  label: 'layer',
  parameterize: null,
  frameList: [],
  inheritMask: 2044,
  transformOrder: [0, 3, 2, 1],
  type: EmoteLayerType.Group,
  coordinate: 0,
  joinTarget: 1,
  groundCorrection: 0,
  meshTransform: 0,
  children: [],
  exportSelf: 1,
  metadata: null,
  ...fields,
});
const bp = Array.from({length: 32}, (_, i) => i / 8);

/** A small `win`-spec E-mote tree with every block the D3D runtime requires. */
function winModel() {
  return {
    id: 'motion',
    label: 'template',
    spec: 'win',
    version: f32(3.03),
    screenSize: {width: 800, height: 1080, originX: 0, originY: 0},
    stereovisionProfile: {fov: f32(0.6)},
    source: {
      tex: {
        type: 0,
        metadata: null,
        texture: {
          type: 'DXT5',
          width: 256,
          height: 128,
          truncated_width: 256,
          truncated_height: 128,
          pixel: resource(Uint8Array.of(1, 2, 3, 4)),
          mipMapLevel: 2,
          mipMap: [{width: 128, height: 64, pixel: resource(Uint8Array.of(5, 6))}],
        },
        icon: {
          eye: {left: 4, top: 8, width: 32, height: 16, originX: 16, originY: f32(7.5), attr: 1},
        },
      },
    },
    object: {
      all_parts: {
        type: 0,
        metadata: null,
        motion: {
          base: {
            type: 0,
            metadata: null,
            variable: [],
            priority: [{time: 0, type: 1, content: [3, 2, 1]}],
            tag: [],
            loopTime: -1,
            lastTime: 61,
            bounds: {left: 0, top: 0, right: 10, bottom: 20},
            parameter: [
              {
                id: 'head_LR',
                enabled: 1,
                discretization: 0,
                rangeBegin: -30,
                rangeEnd: 30,
                division: 60,
              },
            ],
            parameterize: 0,
            layerIndexMap: {head: 1},
            layer: [
              layer({
                label: 'root',
                parameterize: 0,
                children: [
                  layer({
                    label: 'head',
                    type: EmoteLayerType.Image,
                    objTriPriority: 2,
                    stencilType: 5,
                    meshTransform: 1,
                    meshSyncChildMask: 8,
                    meshDivision: 20,
                    meshCombine: 1,
                    frameList: [
                      {time: 0, type: 0},
                      {
                        time: 30,
                        type: 3,
                        content: {
                          mask: 0x2000000 | 0x200 | 0x2,
                          src: 'tex',
                          icon: 'eye',
                          coord: [1, f32(2.5), 0],
                          color: [1, 2, 3, 4],
                          mesh: {bp, cc: null},
                          // Outside the mask: present in data, not read.
                          ox: 9,
                        },
                      },
                      {
                        time: 61,
                        type: 2,
                        content: {mask: 0x20000, src: 'tex', icon: 'eye', bm: 0, mesh: {bp: null}},
                      },
                    ],
                  }),
                  layer({
                    label: 'mask',
                    type: EmoteLayerType.StencilComposite,
                    stencilCompositeMaskLayerList: ['head'],
                    frameList: [{time: 0, type: 2, content: {mask: 0, src: 'tex', icon: 'eye'}}],
                  }),
                ],
              }),
            ],
          },
        },
      },
    },
    metadata: {
      format: 'emote',
      version: 1,
      base: {chara: 'all_parts', motion: 'base'},
      mirror: 0,
      scale: 1,
      editLock: 0,
      bustControl: [
        {
          enabled: 1,
          label: 'bust',
          param: {op: vec(0, 0), p: vec(0, f32(9.6)), pv: vec(0, 0), ofs: f32(9.6)},
          gravity: f32(0.3),
          spring: f32(0.03125),
          friction: f32(0.125),
          scale_x: 1,
          scale_y: 2,
          baseLayer: 'center_bust',
          var_lr: 'bust_LR',
          var_ud: 'bust_UD',
        },
      ],
      hairControl: [
        {
          enabled: 1,
          param: {
            op: vec(0, 0),
            ofs: f32(-53.9),
            bendR: f32(0.36),
            bendS: 0,
            bp: [vec(0, 64), vec(0, 112)],
            p: [vec(0, 118), vec(0, 166)],
            pv: [vec(0, 0), vec(0, 0)],
          },
          gravity: f32(0.2),
          friction_x: f32(0.03125),
          friction_y: f32(0.03125),
          b_rate: f32(0.0037),
          v_bound: f32(0.5),
          ud_eft: 0,
          bend_spd: f32(0.3927),
          bend_vol: 3,
          length: [64, 48],
          scale_x: [f32(0.75), f32(0.25)],
          scale_y: [2, 3],
          baseLayer: 'center_fronthair',
          var_lr: 'hair_LR',
          var_lrm: 'hair_LR_M',
          var_ud: 'hair_UD',
        },
      ],
      // Disabled entries are skipped without reading their other keys.
      partsControl: [{enabled: 0, label: 'spare'}],
      eyeControl: [
        {
          enabled: 1,
          label: 'face_eye_open',
          beginFrame: 0,
          endFrame: 10,
          blinkIntervalMin: 30,
          blinkIntervalMax: 180,
          blinkFrameCount: 16,
          blinkEnabled: 1,
          edge: [
            [-10, 20],
            [30, 30],
          ],
          node: [[5, 30]],
        },
      ],
      eyebrowControl: [],
      mouthControl: [{enabled: 1, label: 'face_mouth', talkLabel: 'face_talk', beginFrame: 0}],
      transitionControl: [{enabled: 1, label: 'head_LR'}],
      clampControl: [
        {
          enabled: 1,
          label: 'head',
          type: 0,
          var_lr: 'head_LR',
          var_ud: 'head_UD',
          min: -30,
          max: 30,
        },
      ],
      loopControl: [],
      mirrorControl: {variableMatchList: ['_LR']},
      timelineControl: [
        {
          label: 'idle',
          diff: 1,
          loopBegin: 0,
          loopEnd: 61,
          lastTime: -1,
          variableList: [
            {
              label: 'head_LR',
              frameList: [
                {time: 0, type: 2, content: {value: -5, easing: 0}},
                {time: 31, type: 0},
                {time: 45, type: 2, content: {value: 12, easing: -1}},
              ],
            },
          ],
        },
      ],
      variableList: [{label: 'head_LR', frameList: [{label: 'left', frame: -30}]}],
    },
  };
}

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

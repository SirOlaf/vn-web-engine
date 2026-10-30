import test from 'node:test';
import assert from 'node:assert/strict';
import {ArtemisScene} from '../dist/engines/artemis/scene.js';
import {ARTEMIS_3179_EXECUTABLE_SHA256 as revision} from '../dist/engines/artemis/revision.js';

test('Dimension effects preserve reversed-edge smoothstep, raw Fore UV and aspect-correct distance', async () => {
  const {artemisDimensionShade: shade} =
    await import('../dist/engines/artemis/dimension-shader.js');
  const p = {alpha: 0.5, centerX: 0.5, centerY: 0.5, radius: 0.2, ratio: 2, thick: 0.1};
  const sample = (u, v) => [u, v, 0.6, 0.8];
  const close = (actual, expected) =>
    actual.forEach((v, i) =>
      assert.ok(Math.abs(v - expected[i]) < 1e-5, `${i}: ${v}/${expected[i]}`),
    );
  // Halfway through the native distortion range: source UV approaches the centre.
  close(shade('dimhole', sample, 0.75, 0.5, p), [0.625, 0.5, 0.6, 0.4]);
  // Ratio changes the distance; interpolation still uses uncorrected Fore coordinates.
  close(shade('dimhole', sample, 0.5, 0.625, p), [0.5, 0.5625, 0.6, 0.4]);
  assert.equal(shade('dimhole', sample, 0.5, 0.5, p)[3], 0);
  close(shade('dimring', sample, 0.75, 0.5, p), [1.25, 1, 1.1, 0.4]);
  close(shade('dimring', sample, 0.5, 0.625, p), [1, 1.125, 1.1, 0.4]);
  close(shade('dimring', sample, 0.6, 0.5, p), [0.6, 0.5, 0.6, 0.4]);
  close(shade('dimring', sample, 0.9, 0.5, p), [0.9, 0.5, 0.6, 0.4]);
  // Collapsed equal edges follow HLSL saturate(0/0)=0, with finite output.
  assert.ok(shade('dimhole', sample, 0.5, 0.5, {...p, radius: 0}).every(Number.isFinite));
  assert.throws(() => shade('dimring', sample, 0.5, 0.5, {...p, thick: undefined}), /thickness/);
});

test('Dimension draw presets consume native ordered vectors across the second constant-buffer row', async () => {
  const {createArtemisDrawShaderPreset} = await import('../dist/engines/artemis/draw-shader.js');
  const {ARTEMIS_3257_WRAPPED_RESOURCE_VARIANT_SHA256: hash} =
    await import('../dist/engines/artemis/revision.js');
  const ring = createArtemisDrawShaderPreset(hash, 'dimring');
  const buffer = ring.nativeParameters([
    {name: 'ignored-order', values: [0.5, 0.5, 0.2, 2]},
    {name: 'ignored-thickness', values: [0.1]},
  ]);
  assert.deepEqual(Array.from(buffer.slice(0, 8)), [
    0.5,
    0.5,
    Math.fround(0.2),
    2,
    Math.fround(0.1),
    0,
    0,
    0,
  ]);
  assert.equal(ring.needsUserTexture, false);
  assert.equal(ring.requiresBackground, false);
  assert.equal(ring.replacesDestination, false);
  assert.match(ring.fragment, /uThick=parameters\[1\]\.x/);
  assert.match(ring.fragment, /fore\.a\*=tint\.a/);
});

test('Artemis child maps retain each nested structure until recursive commit', () => {
  const scene = new ArtemisScene(revision);
  const old = {image: 'old'},
    replacement = {image: 'replacement'};
  assert.equal(scene.set('bg.2', old), true);
  assert.equal(scene.entry('bg', 'retained'), undefined);
  scene.commit();
  scene.set('bg.2', replacement);
  scene.set('bg.10', 'new');
  assert.equal(scene.entry('bg.2').value, replacement);
  assert.equal(scene.entry('bg.2', 'retained').value, old);
  assert.equal(scene.entry('bg.10', 'retained'), undefined);
  assert.deepEqual(
    scene.entries().map((x) => x.id),
    ['bg', 'bg.2', 'bg.10'],
  );
  scene.remove('bg.2');
  assert.equal(scene.entry('bg.2'), undefined);
  assert.equal(scene.entry('bg.2', 'retained').value, old);
  scene.commit();
  assert.deepEqual(scene.entries('retained'), scene.entries());
  scene.set('bg', 'whole group replacement');
  assert.equal(scene.entry('bg.10'), undefined);
  assert.equal(scene.entry('bg.10', 'retained').value, 'new');
});

test('Artemis numeric child keys preserve first spelling and use signed integer order', () => {
  const scene = new ArtemisScene(revision);
  for (const id of ['10', '2', '-3', '00', '+group', 'name']) scene.set(id, id);
  scene.set('-', 'zero replacement');
  scene.set('-0', 'another zero');
  scene.set('02', 'two replacement');
  assert.deepEqual(
    scene.entries().map((x) => x.id),
    ['+group', '-3', '00', '2', '10', 'name'],
  );
  assert.equal(scene.entry('0').id, '00');
  assert.equal(scene.entry('0').value, 'another zero');
  assert.equal(scene.entry('002').id, '2');
  assert.equal(scene.remove('0002'), true);
  assert.equal(scene.entry('2'), undefined);
});

test('Artemis group deletion keeps empty ancestors and refuses traversal through leaves', () => {
  const scene = new ArtemisScene(revision);
  scene.set('bg', 'group image', true);
  scene.set('bg.child', 'child');
  assert.equal(scene.entry('bg').value, 'group image');
  scene.remove('bg.child');
  assert.equal(scene.entry('bg').value, 'group image');
  assert.equal(scene.remove('missing.child'), false);
  assert.equal(scene.entry('missing'), undefined);
  scene.set('leaf', 'opaque', false);
  assert.equal(scene.set('leaf.child', 'ignored'), false);
  assert.equal(scene.remove('leaf.child'), false);
  assert.equal(scene.entry('leaf.child'), undefined);
  assert.equal(scene.remove('leaf'), true);
});

test('Artemis UTF-8 child ordering and empty dotted components are explicit', () => {
  const scene = new ArtemisScene(revision);
  scene.set('\u{10000}', 'astral');
  scene.set('\ue000', 'BMP');
  scene.set('.child.', 'empty components');
  assert.deepEqual(
    scene.entries().map((x) => x.id),
    ['', '.child', '.child.', '\ue000', '\u{10000}'],
  );
  assert.equal(scene.entry('.child.').value, 'empty components');
});

test('Artemis scene refuses unproved comparator cases before mutating any parent', () => {
  const scene = new ArtemisScene(revision);
  assert.throws(() => new ArtemisScene('unknown'), /Unsupported Artemis executable/);
  for (const id of ['parent.2147483648', 'parent.-2147483649', 'parent.\ud800', 'parent.\0'])
    assert.throws(() => scene.set(id, 'bad'), /Unsupported|Invalid/);
  assert.throws(() => scene.set(Array(257).fill('x').join('.'), 'bad'), /depth limit/);
  assert.deepEqual(scene.entries(), []);
  scene.set('2147483647', 'max');
  scene.set('-2147483648', 'min');
  assert.deepEqual(
    scene.entries().map((x) => x.value),
    ['min', 'max'],
  );
});

test('Artemis mixed layer components preserve traversal, aliases and retained ownership', () => {
  const released = [];
  const scene = new ArtemisScene(revision, (value) => released.push(value));
  for (const id of ['5', '4time', '2', '4', 'name']) scene.set(`group.${id}`, id);
  const ids = ['group', 'group.2', 'group.4', 'group.4time', 'group.5', 'group.name'];
  assert.deepEqual(
    scene.entries().map((entry) => entry.id),
    ids,
  );
  scene.commit();
  scene.set('group.04', 'replacement');
  scene.remove('group.4time');
  assert.equal(scene.entry('group.004').id, 'group.4');
  assert.equal(scene.entry('group.004').value, 'replacement');
  assert.equal(scene.entry('group.4time'), undefined);
  assert.deepEqual(
    scene.entries('retained').map((entry) => entry.id),
    ids,
  );
  assert.deepEqual(released, []);
  scene.commit();
  assert.deepEqual(released, ['4time', '4']);
  assert.deepEqual(
    scene.select('group').map((entry) => entry.id),
    ids.filter((id) => id !== 'group.4time'),
  );
});

test('Artemis rejects cyclic sibling order and inconsistent alias queries before mutation', () => {
  const scene = new ArtemisScene(revision);
  scene.set('group.2', 'two');
  scene.set('group.10', 'ten');
  const before = scene.entries();
  for (const action of [
    () => scene.set('group.1x.new.child', 'bad'),
    () => scene.entry('group.1x'),
    () => scene.remove('group.1x'),
  ])
    assert.throws(action, /nontransitive/);
  assert.deepEqual(scene.entries(), before);
  const aliases = new ArtemisScene(revision);
  aliases.set('02', 'two');
  aliases.set('1x', 'mixed');
  assert.throws(() => aliases.entry('2'), /nontransitive/);
  assert.throws(() => aliases.set('2', 'bad'), /nontransitive/);
  assert.equal(aliases.entry('02').value, 'two');
});

test('Artemis Rev.2908 empty components alias native atoi zero independently of older profiles', async () => {
  const {ARTEMIS_2908_EXECUTABLE_SHA256: henpri} =
    await import('../dist/engines/artemis/revision.js');
  const scene = new ArtemisScene(henpri);
  scene.set('parent.', 'empty');
  scene.commit();
  scene.set('parent.00', 'zero');
  assert.equal(scene.entry('parent.-').id, 'parent.');
  assert.equal(scene.entry('parent.0').value, 'zero');
  assert.equal(scene.entry('parent.', 'retained').value, 'empty');
  const old = new ArtemisScene(revision);
  old.set('parent.', 'empty');
  old.set('parent.0', 'zero');
  assert.equal(old.entry('parent.').value, 'empty');
  assert.equal(old.entry('parent.0').value, 'zero');
  const cyclic = new ArtemisScene(henpri);
  cyclic.set('-1', 'negative');
  cyclic.set('', 'empty');
  assert.throws(() => cyclic.set('+group', 'bad'), /nontransitive/);
});

test('Artemis native selection uses the requested prefix and only expands groups', () => {
  const scene = new ArtemisScene(revision);
  scene.set('2', undefined, true);
  scene.set('2.10', 'image');
  scene.set('2.3', undefined, true);
  scene.set('2.3.name', 'nested image');
  assert.deepEqual(
    scene.select('02').map((x) => x.id),
    ['02', '02.3', '02.3.name', '02.10'],
  );
  assert.deepEqual(
    scene.select('2.10').map((x) => x.id),
    ['2.10'],
  );
  assert.deepEqual(scene.select('missing'), []);
  assert.equal(scene.set('2.10.child', 'blocked'), false);
  scene.commit();
  scene.remove('02');
  assert.deepEqual(scene.select('2'), []);
  assert.equal(scene.entry('2.3.name', 'retained').value, 'nested image');
});

function command(name, args = {}) {
  return {kind: 'tag', name, sourceLine: 7, args: new Map(Object.entries(args))};
}

async function layerFixture(readFile, extraHost = {}) {
  const {ArtemisLayers} = await import('../dist/engines/artemis/layers.js');
  const {createArtemisImageLoader} = await import('../dist/engines/artemis/image-loader.js');
  const events = [];
  let next = 0;
  const layers = new ArtemisLayers(revision, createArtemisImageLoader(revision, readFile), {
    creationMode: () => 0,
    createImageLayer(resource, anchor) {
      const actor = {number: ++next, resource, anchor};
      events.push(['create', actor.number, anchor]);
      return actor;
    },
    copyImageLayer(actor) {
      const copy = {...actor, number: ++next, properties: {...actor.properties}};
      events.push(['copy', actor.number, copy.number]);
      return copy;
    },
    applyImageProperties(id, actor, properties) {
      actor.properties = {...actor.properties, ...properties};
      events.push(['properties', id]);
    },
    recordLayerProperties: (tag) => events.push(['record', tag.args.get('id')]),
    layerNotFound: (tag) => events.push(['missing', tag.args.get('id')]),
    releaseImageLayer: (actor) => events.push(['release', actor.number]),
    clearLayerCommands: (ids) => events.push(['clear', [...ids]]),
    resetLayerCommands: (id) => events.push(['reset', id]),
    imageLoadFailed: (tag) => events.push(['error', tag.args.get('file')]),
    ...extraHost,
  });
  return {layers, events};
}

test('Artemis lyc with a missing file creates neither the layer nor its parents', async () => {
  // Native lyc (Rev.3179 0x1400d5930) reports and returns before creating the layer when no image loads and
  // width/height/color are absent; later commands on that subtree find no layer.
  const {layers, events} = await layerFixture(async () => null);
  await layers.dispatch(command('lyc', {id: 'a.b.c.d', file: 'missing'}));
  for (const id of ['a', 'a.b', 'a.b.c', 'a.b.c.d'])
    assert.equal(layers.scene.entry(id), undefined);
  await layers.dispatch(command('lyprop', {id: 'a.b.c.d', left: '1'}));
  await layers.dispatch(command('lyprop', {id: 'a.b', top: '1'}));
  // lyprop without an id names no layer either (native 0x1400d76d0 reports it).
  await layers.dispatch(command('lyprop', {visible: '0'}));
  assert.deepEqual(events, [
    ['error', 'missing'],
    ['missing', 'a.b.c.d'],
    ['missing', 'a.b'],
    ['missing', undefined],
  ]);
});

async function syntheticImage() {
  const {png} = await import('./png-fixtures.mjs');
  return png({width: 2, height: 1, raw: Buffer.from([0, 255, 0, 0, 0, 0, 255, 0, 128])});
}

test('Artemis image commands retain replaced actors, clear subtree registrations and release on commit', async () => {
  const image = await syntheticImage();
  const {layers, events} = await layerFixture(async (path) =>
    path === 'synthetic.png' ? image : null,
  );
  try {
    assert.equal(await layers.dispatch(command('unrelated')), false);
    await layers.dispatch(
      command('lyc', {id: 'bg.2', file: 'synthetic', alpha: '0', anchorx: '99'}),
    );
    const old = layers.scene.entry('bg.2').value;
    assert.deepEqual(old.anchor, {x: 1, y: 0.5});
    assert.deepEqual([...old.resource.image.pixels], [255, 0, 0, 0, 0, 255, 0, 128]);
    layers.commit();
    await layers.dispatch(command('lyc', {id: 'bg.02', file: 'synthetic'}));
    assert.equal(layers.scene.entry('bg.2', 'retained').value, old);
    assert.deepEqual(
      events.map((x) => x.slice(0, 2)),
      [
        ['create', 1],
        ['reset', 'bg.2'],
        ['create', 2],
        ['clear', ['bg.02']],
        ['reset', 'bg.02'],
      ],
    );
    await layers.dispatch(command('lyc', {id: 'bg.2', file: 'missing'}));
    assert.equal(layers.scene.entry('bg.2').value.number, 2);
    assert.deepEqual(events.at(-1), ['error', 'missing']);
    layers.commit();
    assert.deepEqual(events.at(-1), ['release', 1]);
    await layers.dispatch(command('lydel', {id: 'bg'}));
    assert.equal(layers.scene.entry('bg'), undefined);
    assert.deepEqual(events.at(-1), ['clear', ['bg', 'bg.02']]);
    layers.commit();
    assert.deepEqual(events.at(-1), ['release', 2]);
    await layers.dispatch(command('lyc', {id: 'leaf', file: 'synthetic'}));
    await layers.dispatch(command('lyc', {id: 'leaf.blocked', file: 'synthetic'}));
    assert.equal(layers.scene.entry('leaf.blocked'), undefined);
    assert.deepEqual(events.at(-1), ['release', 4]);
  } finally {
    layers.close();
  }
  assert.deepEqual(events.at(-1), ['release', 3]);
  layers.close();
  await assert.rejects(() => layers.dispatch(command('lydel')), /closed/);
});

test('Artemis image command cancellation rejects stale completions and copies pending tag arguments', async () => {
  const image = await syntheticImage();
  const readers = [];
  const {layers, events} = await layerFixture((path) => {
    if (path === 'old' || path === 'new')
      return new Promise((resolve) => readers.push({path, resolve}));
    return Promise.resolve(null);
  });
  const first = command('lyc', {id: 'old', file: 'old'});
  const pending = layers.dispatch(first);
  first.args.set('id', 'mutated');
  await assert.rejects(() => layers.dispatch(command('lydel', {id: 'old'})), /already pending/);
  layers.cancelPending();
  const current = layers.dispatch(command('lyc', {id: 'new', file: 'new'}));
  readers[0].resolve(image);
  await assert.rejects(() => pending, /cancelled/);
  assert.deepEqual(events, []);
  readers[1].resolve(image);
  await current;
  assert.equal(layers.scene.entry('new').value.number, 1);
  assert.equal(layers.scene.entry('old'), undefined);
  assert.equal(layers.scene.entry('mutated'), undefined);
  await assert.rejects(
    () => layers.dispatch(command('lyc', {id: 'bad', file: 'missing', rule: ''})),
    /rule surface/,
  );
  await assert.rejects(
    () =>
      layers.dispatch(
        command('lyc', {id: 'bad', file: 'missing', width: '-2', height: '1', color: 'ffffff'}),
      ),
    /solid surface dimension/,
  );
  layers.close();
  const capture = await layerFixture(async () => null, {creationMode: () => 1});
  await assert.rejects(() => capture.layers.dispatch(command('lyc')), /capture-mode/);
  assert.deepEqual(capture.events, []);
  capture.layers.close();
});

test('Artemis suspended Lua drives actual image-backed lyc and resumes after scene insertion', async () => {
  const {ArtemisLua} = await import('../dist/engines/artemis/lua.js');
  const {ArtemisScript} = await import('../dist/engines/artemis/script.js');
  const image = await syntheticImage();
  const {layers} = await layerFixture(async (path) => (path === 'synthetic.png' ? image : null));
  const source = new TextEncoder().encode(
    `[lua]function prepare(e) e:tag{'lyc',id='2',file='synthetic'}; finished=true end[/lua][calllua function="prepare"][stop]`,
  );
  let script, pending;
  const lua = new ArtemisLua({
    readFile: () => source,
    fileExists: () => true,
    now: () => 0,
    variable: () => '0',
    suspendableTags: true,
    tag: (tag) => script.executeTag(tag),
    enqueueTag: () => {},
  });
  script = new ArtemisScript(lua, {
    readFile: () => source,
    dispatch: (tag) => {
      if (tag.name === 'lyc') {
        pending = layers.dispatch(tag);
        return 'suspended';
      }
      if (tag.name === 'stop') return 'stopped';
      throw new Error('unsupported tag');
    },
  });
  try {
    script.load('boot');
    assert.equal(script.run(), 'waiting');
    assert.equal(layers.scene.entry('2'), undefined);
    assert.equal(lua.vm.getGlobal('finished'), null);
    assert.equal(await pending, true);
    script.resumeLua();
    assert.equal(script.run(), 'stopped');
    assert.equal(lua.vm.getGlobal('finished'), true);
    assert.equal(layers.scene.entry('2').value.resource.image.width, 2);
  } finally {
    lua.close();
    layers.close();
  }
});

test('Artemis image properties copy the inner actor once per commit and retain newly inserted old state', async () => {
  const image = await syntheticImage();
  const {layers, events} = await layerFixture(async (path) =>
    path === 'synthetic.png' ? image : null,
  );
  try {
    await layers.dispatch(command('lyc', {id: '2', file: 'synthetic'}));
    const first = layers.scene.entry('2').value;
    await layers.dispatch(
      command('lyprop', {
        id: '02',
        left: ' 12.5px',
        top: '-.25',
        alpha: '128.3',
        xscale: '50',
        reversex: '00',
      }),
    );
    const second = layers.scene.entry('2').value;
    assert.notEqual(second, first);
    assert.deepEqual(second.properties, {
      left: 12.5,
      top: -0.25,
      alpha: 0.5031372904777527,
      wrapperAlpha: 0.5031372308731079,
      xscale: 0.5,
      reversex: true,
    });
    assert.equal(first.properties, undefined);
    assert.equal(layers.scene.entry('2', 'retained'), undefined);
    assert.equal(layers.scene.payloads().has(first), true);
    assert.equal(
      events.some((x) => x[0] === 'release'),
      false,
    );
    await layers.dispatch(command('lyprop', {id: '2', yscale: '25', reversex: '0', visible: ''}));
    assert.equal(layers.scene.entry('2').value, second);
    assert.deepEqual(
      events.filter((x) => x[0] === 'copy'),
      [['copy', 1, 2]],
    );
    assert.equal(second.properties.reversex, false);
    assert.equal(second.properties.visible, true);
    layers.commit();
    assert.deepEqual(events.at(-1), ['release', 1]);
    await layers.dispatch(command('lyprop', {id: '2', rotate: '90'}));
    const third = layers.scene.entry('2').value;
    assert.notEqual(third, second);
    assert.equal(layers.scene.entry('2', 'retained').value, second);
    assert.equal(second.properties.rotate, undefined);
    assert.equal(third.properties.rotate, 90);
    const before = events.length;
    await assert.rejects(
      () => layers.dispatch(command('lyprop', {id: '2', shader: 'unsupported'})),
      /shader property owner/,
    );
    assert.equal(events.length, before);
    await layers.dispatch(command('lyprop', {id: 'missing', left: '0'}));
    assert.deepEqual(events.at(-1), ['missing', 'missing']);
    await assert.rejects(
      () => layers.dispatch(command('lyprop', {id: '!', left: '0'})),
      /group\/shader/,
    );
    await assert.rejects(
      () => layers.dispatch(command('lyprop', {id: '~shader', left: '0'})),
      /group\/shader/,
    );
  } finally {
    layers.close();
  }
  assert.deepEqual(events.slice(-2), [
    ['release', 2],
    ['release', 3],
  ]);
});

test('Artemis layer number conversion preserves decimal prefixes, float32 boundaries and omission', async () => {
  const {artemisLayerProperties} = await import('../dist/engines/artemis/layer-properties.js');
  assert.deepEqual(artemisLayerProperties(new Map([['id', '2']])), {});
  const patch = artemisLayerProperties(
    new Map(
      Object.entries({
        left: '16777217 trailing',
        top: '-0',
        alpha: '510',
        xscale: '1e2%',
        yscale: 'junk',
        rotate: '',
        reversey: '0',
        visible: ' 0',
      }),
    ),
  );
  assert.equal(patch.left, 16777216);
  assert.equal(Object.is(patch.top, -0), true);
  assert.equal(patch.alpha, 2);
  assert.equal(patch.wrapperAlpha, 2);
  assert.equal(patch.xscale, 1);
  assert.equal(patch.yscale, 0);
  assert.equal(patch.rotate, 0);
  assert.equal(patch.reversey, false);
  assert.equal(patch.visible, true);
  for (const value of ['0x1p2', 'nan', 'Infinity', '1e39'])
    assert.throws(() => artemisLayerProperties(new Map([['left', value]])), /property number/);
});

test('Clickable thresholds use atoi, survive actor copies and gate the alpha hit test', async () => {
  const {artemisLayerProperties} = await import('../dist/engines/artemis/layer-properties.js');
  const {ArtemisDisplayObject} = await import('../dist/engines/artemis/display-object.js');
  const display = new ArtemisDisplayObject(revision);
  let reads = 0;
  const alpha = (value) => () => (reads++, value);
  assert.equal(display.hitsAlpha(alpha(0)), true);
  assert.equal(reads, 0);
  const revisionBefore = display.propertyRevision;
  display.apply(artemisLayerProperties(new Map([['clickablethreshold', ' 128px']])));
  assert.equal(display.clickableThreshold, 128);
  assert.equal(display.propertyRevision, revisionBefore);
  const copy = display.copy();
  assert.deepEqual([copy.hitsAlpha(alpha(127)), copy.hitsAlpha(alpha(128))], [false, true]);
  display.apply(artemisLayerProperties(new Map([['clickablethreshold', '-1']])));
  assert.equal(display.hitsAlpha(alpha(255)), false);
  assert.equal(copy.clickableThreshold, 128);
});

test('Drag properties keep the native flag spelling and inclusive area, and survive actor copies', async () => {
  const {artemisLayerProperties} = await import('../dist/engines/artemis/layer-properties.js');
  const {ArtemisDisplayObject} = await import('../dist/engines/artemis/display-object.js');
  const display = new ArtemisDisplayObject(revision);
  assert.equal(display.draggable, false);
  assert.deepEqual(display.dragArea, {left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0});
  const revisionBefore = display.propertyRevision;
  display.apply(
    artemisLayerProperties(
      new Map([
        ['draggable', '1'],
        ['dragarea', '0,-720,0,720'],
      ]),
    ),
  );
  assert.equal(display.draggable, true);
  assert.deepEqual(display.dragArea, {
    left: 0,
    top: -720,
    width: 1,
    height: 1441,
    right: 0,
    bottom: 720,
  });
  assert.equal(display.propertyRevision, revisionBefore);
  const copy = display.copy();
  // Only exactly "0" clears; a field count other than four leaves the area.
  display.apply(
    artemisLayerProperties(
      new Map([
        ['draggable', '00'],
        ['dragarea', '1,2,3'],
      ]),
    ),
  );
  assert.equal(display.draggable, true);
  assert.equal(display.dragArea.top, -720);
  display.apply(artemisLayerProperties(new Map([['draggable', '0']])));
  assert.equal(display.draggable, false);
  assert.equal(copy.draggable, true);
  assert.equal(copy.dragArea.bottom, 720);
  // Empty fields read as zero.
  assert.deepEqual(artemisLayerProperties(new Map([['dragarea', ',,4.5,']])).dragarea, {
    left: 0,
    top: 0,
    width: 5.5,
    height: 1,
    right: 4.5,
    bottom: 0,
  });
});

test('Artemis missing-image fallback preserves native RGB/ARGB color forms and decimal dimensions', async () => {
  const {layers, events} = await layerFixture(async () => null);
  try {
    for (const [color, format, expected] of [
      ['123456', 1, [18, 52, 86, 255]],
      ['0x123456', 1, [18, 52, 86, 255]],
      ['0X123456', 1, [18, 52, 86, 255]],
      ['00123456', 2, [18, 52, 86, 0]],
      ['0x80123456', 2, [18, 52, 86, 128]],
      ['f', 2, [0, 0, 15, 0]],
      ['-ff', 2, [255, 255, 1, 255]],
      ['100000000', 2, [255, 255, 255, 255]],
      ['雪雪', 1, [0, 0, 0, 255]],
    ]) {
      await layers.dispatch(
        command('lyc', {id: 'solid', file: 'missing', width: ' 2pixels', height: '1', color}),
      );
      const resource = layers.scene.entry('solid').value.resource;
      assert.equal(resource.surfaceFormat, format);
      assert.deepEqual([...resource.image.pixels], [...expected, ...expected]);
      assert.deepEqual(layers.scene.entry('solid').value.anchor, {x: 1, y: 0.5});
    }
    assert.equal(
      events.some((x) => x[0] === 'error'),
      false,
    );
    await layers.dispatch(
      command('lyc', {id: 'partial', file: 'missing', width: '2', height: '1'}),
    );
    assert.equal(layers.scene.entry('partial'), undefined);
    assert.deepEqual(events.at(-1), ['error', 'missing']);
  } finally {
    layers.close();
  }
});

test('Artemis solid fallback snapshots arguments before its asynchronous file miss', async () => {
  let resolve;
  const {layers} = await layerFixture((path) =>
    path === 'missing'
      ? new Promise((done) => {
          resolve = done;
        })
      : Promise.resolve(null),
  );
  const tag = command('lyc', {
    id: 'solid',
    file: 'missing',
    width: '2',
    height: '1',
    color: '123456',
  });
  const pending = layers.dispatch(tag);
  tag.args.set('width', '9');
  tag.args.set('color', 'ffffff');
  resolve(null);
  try {
    await pending;
    const image = layers.scene.entry('solid').value.resource.image;
    assert.equal(image.width, 2);
    assert.deepEqual([...image.pixels.slice(0, 4)], [18, 52, 86, 255]);
  } finally {
    layers.close();
  }
});

test('Shared solid image allocation preserves straight transparent RGB and rejects native allocation overflow', async () => {
  const {createSolidImage} = await import('../dist/graphics/solid-image.js');
  const image = createSolidImage(3, 2, [12, 34, 56, 0]);
  assert.deepEqual([...image.pixels], Array(6).fill([12, 34, 56, 0]).flat());
  assert.equal(createSolidImage(0, 1, [0, 0, 0, 255]).pixels.length, 0);
  for (const [w, h] of [
    [-1, 1],
    [1.5, 1],
    [0x80000000, 0],
    [0x20000000, 1],
  ])
    assert.throws(() => createSolidImage(w, h, [0, 0, 0, 0]), /dimensions/);
  assert.throws(() => createSolidImage(1, 1, [256, 0, 0, 0]), /RGBA color/);
});

test('Artemis native display state applies centered scale/reversal and composes a parent matrix', async () => {
  const {ArtemisDisplayObject, artemisDisplayPoint} =
    await import('../dist/engines/artemis/display-object.js');
  const object = new ArtemisDisplayObject(revision);
  assert.deepEqual(object.properties, {
    left: 0,
    top: 0,
    alpha: 1,
    anchorx: 0,
    anchory: 0,
    xscale: 1,
    yscale: 1,
    rotate: 0,
    reversex: false,
    reversey: false,
    visible: true,
  });
  object.apply({left: 10, top: 20, anchorx: 1, anchory: 2, xscale: 2, yscale: 0.5});
  assert.deepEqual([...object.matrix()], [2, 0, 9, 0, 0.5, 21]);
  assert.deepEqual(artemisDisplayPoint(object.matrix(), 2, 4), [13, 23]);
  object.apply({reversex: true, reversey: true});
  assert.deepEqual([...object.matrix()], [-2, 0, 13, 0, -0.5, 23]);
  const copy = object.copy();
  copy.apply({visible: false, alpha: 0.25});
  assert.equal(object.properties.visible, true);
  assert.equal(object.properties.alpha, 1);
  assert.equal(copy.properties.visible, false);
  assert.equal(copy.properties.alpha, 0.25);
  const child = new ArtemisDisplayObject(revision);
  child.apply({left: 1, top: 2});
  assert.deepEqual([...child.matrix(new Float32Array([2, 3, 4, 5, 6, 7]))], [2, 3, 12, 5, 6, 24]);
});

test('Artemis matrix keeps native float32 cancellation and strictly snaps below FLT_EPSILON', async () => {
  const {ArtemisDisplayObject} = await import('../dist/engines/artemis/display-object.js');
  const object = new ArtemisDisplayObject(revision);
  object.apply({left: 16777216, anchorx: 1});
  assert.equal(object.matrix()[2], 16777215);
  const small = new ArtemisDisplayObject(revision);
  const epsilon = 2 ** -23;
  assert.deepEqual(
    [...small.matrix(new Float32Array([epsilon, epsilon / 2, 0, -epsilon / 2, 1, -0]))],
    [epsilon, 0, 0, 0, 1, 0],
  );
  small.apply({xscale: 0.5});
  assert.equal(small.matrix(new Float32Array([epsilon, 0, 0, 0, 1, 0]))[0], 0);
  assert.throws(() => new ArtemisDisplayObject('unknown'), /executable/);
  assert.throws(() => small.apply({left: Infinity}), /display value/);
  assert.throws(() => small.matrix(new Float32Array(5)), /parent matrix/);
});

test('Artemis nonzero rotation requires native float trig and supplies float32 radians', async () => {
  const {ArtemisDisplayObject, artemisDisplayPoint} =
    await import('../dist/engines/artemis/display-object.js');
  const object = new ArtemisDisplayObject(revision);
  object.apply({rotate: 90, anchorx: 1, anchory: 1});
  assert.throws(() => object.matrix(), /trigonometry owner/);
  let radians;
  const matrix = object.matrix(undefined, (angle) => {
    radians = angle;
    return {sin: 1, cos: 0};
  });
  assert.equal(radians, 1.5707963705062866);
  assert.deepEqual([...matrix], [0, -1, 2, 1, 0, 0]);
  assert.deepEqual(artemisDisplayPoint(matrix, 2, 0), [2, 2]);
  assert.deepEqual(artemisDisplayPoint(matrix, 0, 2), [0, 0]);
  assert.throws(() => object.matrix(undefined, () => ({sin: NaN, cos: 1})), /trigonometry/);
});

const straightBlend = {
  color: {source: 'source-alpha', destination: 'inverse-source-alpha', operation: 'add'},
  alpha: {source: 'one', destination: 'inverse-source-alpha', operation: 'add'},
};
async function rasterFixture(
  rasterPolicy = {filter: 'nearest', blend: straightBlend},
  surfaces = false,
  clock = undefined,
  files = {},
) {
  const {ArtemisImageGraphics} = await import('../dist/engines/artemis/image-graphics.js');
  const {ArtemisLayers} = await import('../dist/engines/artemis/layers.js');
  const {createArtemisImageLoader} = await import('../dist/engines/artemis/image-loader.js');
  const image = await syntheticImage(),
    prepared = [],
    invalidated = [],
    frames = [],
    effects = [];
  let rejectUpload = false;
  const target = {
    width: 4,
    height: 2,
    prepareImage(image) {
      if (rejectUpload) throw new Error('synthetic upload failure');
      prepared.push(image);
    },
    ...(surfaces
      ? {
          prepareRenderSurface: (image) => {
            if (rejectUpload) throw new Error('synthetic upload failure');
            prepared.push(image);
          },
        }
      : {}),
    invalidate: (image) => invalidated.push(image),
    draw(list, resolve) {
      frames.push({
        list,
        images: list.commands
          .filter((command) => command.kind === 'triangles')
          .map((command) => resolve(command.texture)),
      });
    },
  };
  const graphics = new ArtemisImageGraphics(
    revision,
    target,
    {
      creationMode: () => 0,
      clearLayerCommands: (ids) => effects.push(['clear', ...ids]),
      resetLayerCommands: (id) => effects.push(['reset', id]),
      recordLayerProperties: (tag) => effects.push(['record', tag.args.get('id')]),
      imageLoadFailed: (tag) => effects.push(['missing image', tag.args.get('file')]),
      layerNotFound: (tag) => effects.push(['missing layer', tag.args.get('id')]),
      animationError: (tag, error) => effects.push(['animation', error, tag.args.get('id')]),
      appendLayerCommand: (id, tag) => effects.push(['append', id, Object.fromEntries(tag.args)]),
    },
    rasterPolicy,
    undefined,
    clock,
  );
  const layers = new ArtemisLayers(
    revision,
    createArtemisImageLoader(revision, async (path) =>
      path === 'synthetic.png' ? image : (files[path] ?? null),
    ),
    graphics,
  );
  return {
    graphics,
    layers,
    prepared,
    invalidated,
    frames,
    effects,
    target,
    setRejectUpload: (value) => {
      rejectUpload = value;
    },
  };
}

test('Artemis raster owner prepares real decoded images, shares actor copies and emits committed normalized quads', async () => {
  const {graphics, layers, prepared, invalidated, frames} = await rasterFixture();
  try {
    await layers.dispatch(command('lyc', {id: '2', file: 'synthetic'}));
    const old = layers.scene.entry('2').value;
    assert.equal(prepared.length, 1);
    assert.equal(graphics.drawCommitted(layers.scene).commands.length, 0);
    layers.commit();
    const initial = graphics.drawCommitted(layers.scene).commands[0];
    assert.equal(initial.topology, 'triangle-strip');
    assert.equal(initial.normalizedUV, true);
    assert.deepEqual(
      [...initial.vertices].filter((_, i) => i % 9 < 2),
      [-1, 1, 0, 1, -1, 0, 0, 0],
    );
    assert.deepEqual(
      [...initial.vertices].filter((_, i) => i % 9 >= 7),
      [0, 0, 1, 0, 0, 1, 1, 1],
    );
    assert.deepEqual([...frames.at(-1).images[0].pixels], [255, 0, 0, 0, 0, 255, 0, 128]);
    await layers.dispatch(
      command('lyprop', {id: '02', left: '1', top: '1', alpha: '128.3', reversex: '1'}),
    );
    const edited = layers.scene.entry('2').value;
    assert.equal(edited.texture, old.texture);
    assert.equal(prepared.length, 1);
    assert.equal(edited.wrapper, old.wrapper);
    assert.equal(old.wrapper.alpha, 0.5031372308731079);
    assert.equal(old.display.properties.alpha, 1);
    assert.equal(graphics.drawCommitted(layers.scene).commands[0].vertices[6], 1);
    layers.commit();
    const visible = graphics.drawCommitted(layers.scene).commands[0];
    assert.deepEqual(
      [...visible.vertices].filter((_, i) => i % 9 < 2),
      [0.5, 0, -0.5, 0, 0.5, -1, -0.5, -1],
    );
    assert.equal(visible.vertices[6], 0.5031372904777527);
    assert.equal(invalidated.length, 0);
    await layers.dispatch(command('lydel', {id: '2'}));
    assert.equal(graphics.drawCommitted(layers.scene).commands.length, 1);
    layers.commit();
    assert.equal(invalidated.length, 1);
    assert.equal(invalidated[0], prepared[0]);
    assert.equal(graphics.drawCommitted(layers.scene).commands.length, 0);
    assert.throws(() => graphics.image(old.texture), /released/);
    assert.throws(() => graphics.copyImageLayer(old), /not owned|released/);
  } finally {
    layers.close();
  }
});

test('Artemis anime builds a timed animation layer that draws its current frame by the clock', async () => {
  let now = 1000;
  const {graphics, layers, effects, invalidated, prepared} = await rasterFixture(undefined, false, {
    now: () => now,
  });
  const uv = () => {
    const quads = graphics.drawCommitted(layers.scene).commands;
    assert.equal(quads.length, 1);
    return [...quads[0].vertices].filter((_, i) => i % 9 >= 7);
  };
  const whole = [0, 0, 1, 0, 0, 1, 1, 1],
    right = [0.5, 0, 1, 0, 0.5, 1, 1, 1];
  try {
    const anime = (args) => layers.dispatch(command('anime', {id: 'a', ...args}));
    await anime({mode: 'init', file: 'synthetic', clip: '0,0,2,1', loop: '1'});
    await anime({mode: 'add', file: 'synthetic', clip: '1,0,1,1', time: '100'});
    await anime({mode: 'add', file: 'synthetic', clip: '0,0,2,1'}); // key 0 is ignored
    await anime({mode: 'end', time: '200'});
    await anime({mode: 'other'});
    await layers.dispatch(command('anime', {id: 'missing', mode: 'end', time: '1'}));
    assert.deepEqual(invalidated, [prepared[2]]);
    assert.deepEqual(effects, [
      ['reset', 'a'],
      ['append', 'a', {id: 'a', mode: 'add', file: 'synthetic', clip: '1,0,1,1', time: '100'}],
      ['append', 'a', {id: 'a', mode: 'add', file: 'synthetic', clip: '0,0,2,1', time: ''}],
      ['append', 'a', {id: 'a', mode: 'end', time: '200'}],
      ['animation', 'mode', 'a'],
      ['animation', 'not-found', 'missing'],
    ]);
    const actor = layers.scene.entry('a').value,
      frames = graphics.animationFrames(actor);
    assert.deepEqual(
      frames.entries().map(([time, frame]) => [time, frame !== null]),
      [
        [0, true],
        [100, true],
        [200, false],
      ],
    );
    layers.commit();
    assert.deepEqual(uv(), whole); // first draw starts the clock at 1000
    now = 1099;
    assert.deepEqual(uv(), whole);
    now = 1100;
    assert.deepEqual(uv(), right);
    now = 1250; // end marker at 1200: one remaining loop restarts from key 0
    assert.deepEqual(uv(), whole);
    now = 1300;
    assert.deepEqual(uv(), right);
    now = 9000; // loop count exhausted: the last frame stays
    assert.deepEqual(uv(), right);
    assert.deepEqual(frames.state, {key: 100, loops: 0, started: true});

    // A property edit copies the layer; the copy shares frames and advances on its own.
    await layers.dispatch(command('lyprop', {id: 'a', left: '1'}));
    const copy = layers.scene.entry('a').value;
    assert.notEqual(copy, actor);
    const frame = frames.entries()[0][1];
    layers.commit();
    assert.deepEqual(uv(), right);
    assert.equal(graphics.copyImageLayer(frame) !== frame, true);
    await layers.dispatch(command('lyc', {id: 'plain', file: 'synthetic'}));
    await layers.dispatch(command('anime', {id: 'plain', mode: 'end', time: '5'}));
    assert.deepEqual(effects.at(-1), ['animation', 'not-found', 'plain']);
    await layers.dispatch(command('animedel', {id: 'a'}));
    assert.deepEqual(effects.at(-1), ['clear', 'a']);
    layers.commit();
    assert.equal(layers.scene.entry('a'), undefined);
    assert.throws(() => frames.frame(), /closed/);
    // Loads 0-3: frame 0, frame 100, the ignored key-0 frame (released at once), plain.
    // Deletion releases frame 100; the extra copy keeps frame 0.
    assert.deepEqual(invalidated, [prepared[2], prepared[1]]);
  } finally {
    layers.close();
  }
});

test('Artemis E-mote layers redraw their player into the layer target once per draw', async () => {
  let now = 500;
  const {graphics, layers, prepared, invalidated} = await rasterFixture(undefined, true, {
    now: () => now,
  });
  const advanced = [];
  const atlas = {type: 'L8', width: 4, height: 4, pixel: {bytes: new Uint8Array(16)}};
  const item = {
    blank: false,
    clipFlags: 0,
    bm: 0x10,
    bmParam: 0,
    grayscaleMode: 0,
    grayscaleLevel: 0,
    z: 0,
    texIndex: 0,
    file: {sources: new Map([['s', {texture: atlas}]])},
    attr: 0,
    left: 0,
    top: 0,
    width: 4,
    height: 4,
    opa: 255,
    colors: Uint32Array.of(0x808080ff, 0x808080ff, 0x808080ff, 0x808080ff),
    grid: {cols: 1, rows: 1, points: Float32Array.of(-2, -1, 2, -1, -2, 1, 2, 1)},
    stencilType: 0,
    stencilParent: null,
    composite: [],
  };
  const emote = {
    width: 4,
    height: 2,
    player: {clip: {drawList: [item], smoothing: false}},
    advance: (time) => advanced.push(time),
  };
  try {
    const actor = graphics.createEmoteLayer(emote);
    assert.equal(graphics.emoteOf(actor), emote);
    assert.throws(() => graphics.copyImageLayer(actor), /E-mote layer copy/);
    assert.ok(layers.attachActor('e', actor));
    layers.commit();
    const commands = graphics.drawCommitted(layers.scene).commands;
    const layer = graphics.image(actor.texture);
    const kinds = commands.map((c) =>
      c.kind === 'gpu-target'
        ? c.surface === layer
          ? 'layer'
          : c.surface
            ? 'surface'
            : 'screen'
        : c.kind,
    );
    // Atlas decode, the player's draw into the layer, then the layer's own quad.
    assert.deepEqual(kinds, ['surface', 'triangles', 'layer', 'triangles', 'screen', 'triangles']);
    assert.equal(commands.at(-1).texture, actor.texture);
    assert.deepEqual(advanced, [500]);
    now = 516;
    assert.equal(graphics.drawCommitted(layers.scene).commands.length, 4);
    assert.deepEqual(advanced, [500, 516]);
    assert.ok(prepared.includes(layer));
    await layers.dispatch(command('lydel', {id: 'e'}));
    layers.commit();
    assert.ok(invalidated.includes(layer));
    assert.throws(() => graphics.image(actor.texture), /released/);
  } finally {
    layers.close();
  }
});

test('Artemis raster upload refusal preserves the old scene and hidden images retain resource ownership', async () => {
  const {graphics, layers, prepared, invalidated, setRejectUpload} = await rasterFixture();
  try {
    await layers.dispatch(command('lyc', {id: 'image', file: 'synthetic'}));
    layers.commit();
    const original = layers.scene.entry('image').value;
    setRejectUpload(true);
    await assert.rejects(
      () => layers.dispatch(command('lyc', {id: 'image', file: 'synthetic'})),
      /upload failure/,
    );
    assert.equal(layers.scene.entry('image').value, original);
    assert.equal(invalidated.length, 0);
    setRejectUpload(false);
    await layers.dispatch(command('lyprop', {id: 'image', visible: '0', rotate: '90'}));
    layers.commit();
    assert.throws(() => graphics.drawCommitted(layers.scene), /trigonometry owner/);
    assert.equal(prepared.length, 1);
    assert.equal(invalidated.length, 0);
    await layers.dispatch(command('lyprop', {id: 'image', visible: '1'}));
    layers.commit();
    assert.throws(() => graphics.drawCommitted(layers.scene), /trigonometry owner/);
    await layers.dispatch(command('lyprop', {id: 'image', rotate: '0', alpha: '0'}));
    layers.commit();
    assert.equal(graphics.drawCommitted(layers.scene).commands.length, 0);
    assert.equal(invalidated.length, 0);
  } finally {
    layers.close();
  }
  assert.equal(invalidated.length, 1);
});

test('Artemis ordinary dispatch descends child keys while GPU preparation and selection ascend', () => {
  const scene = new ArtemisScene(revision);
  scene.set('2.2', '2.2');
  scene.set('2.10', '2.10');
  scene.set('10', '10');
  scene.set('-3', '-3');
  scene.commit();
  assert.deepEqual(
    scene.drawEntries().map((entry) => entry.id),
    ['10', '2', '2.10', '2.2', '-3'],
  );
  assert.deepEqual(
    scene.prepareEntries().map((entry) => entry.id),
    ['-3', '2', '2.2', '2.10', '10'],
  );
  assert.deepEqual(
    scene.select('2').map((entry) => entry.id),
    ['2', '2.2', '2.10'],
  );
});

test('Artemis GPU preparation paints the higher numeric id after the lower background id', async () => {
  const {graphics, layers, prepared} = await rasterFixture();
  try {
    await layers.dispatch(
      command('lyc', {id: '-1', file: 'missing', width: '4', height: '2', color: 'ff0000'}),
    );
    await layers.dispatch(
      command('lyc', {id: '0', file: 'missing', width: '4', height: '2', color: '00ff00'}),
    );
    layers.commit();
    const list = graphics.drawCommitted(layers.scene);
    assert.equal(graphics.image(list.commands[0].texture), prepared[0]);
    assert.equal(graphics.image(list.commands[1].texture), prepared[1]);
  } finally {
    layers.close();
  }
});

test('Artemis flip commits real retained image resources, marks presentation dirty and promotes nonzero refresh state', async () => {
  const {ArtemisStage} = await import('../dist/engines/artemis/stage.js');
  const {graphics, layers, prepared, invalidated} = await rasterFixture();
  const effects = [];
  let transition = 0,
    dirty = false,
    refresh = 1,
    capture = 0;
  const stage = new ArtemisStage(revision, {
    captureMode: () => capture,
    transitionState: () => transition,
    clearTransitionRule: () => {
      throw new Error('unexpected transition cleanup');
    },
    resetTransitionLayerValue: () => {
      throw new Error('unexpected transition cleanup');
    },
    setTransitionState: (value) => {
      transition = value;
      effects.push(['transition', value]);
    },
    markSceneDirty: () => {
      dirty = true;
      effects.push(['dirty']);
    },
    commitLayers: () => {
      effects.push(['commit', dirty]);
      layers.commit();
    },
    refreshState: () => refresh,
    setRefreshState: (value) => {
      refresh = value;
      effects.push(['refresh', value]);
    },
  });
  try {
    await layers.dispatch(command('lyc', {id: '2', file: 'synthetic'}));
    assert.equal(graphics.drawCommitted(layers.scene).commands.length, 0);
    assert.equal(stage.dispatch(command('flip', {ignored: 'native ignores tag arguments'})), true);
    assert.equal(graphics.drawCommitted(layers.scene).commands.length, 1);
    assert.deepEqual(effects, [['transition', 0], ['dirty'], ['commit', true], ['refresh', 2]]);
    await layers.dispatch(command('lyc', {id: '2', file: 'synthetic'}));
    assert.equal(invalidated.length, 0);
    stage.dispatch(command('flip'));
    assert.equal(invalidated[0], prepared[0]);
    capture = 1;
    const before = effects.length;
    await layers.dispatch(command('lydel', {id: '2'}));
    stage.dispatch(command('flip'));
    assert.equal(effects.length, before);
    assert.equal(graphics.drawCommitted(layers.scene).commands.length, 1);
    capture = 0;
    refresh = 0;
    stage.dispatch(command('flip'));
    assert.equal(graphics.drawCommitted(layers.scene).commands.length, 0);
    assert.equal(refresh, 0);
  } finally {
    layers.close();
  }
});

test('Artemis flip clears transition rule/value before commit and reads refresh state after owner effects', async () => {
  const {ArtemisStage} = await import('../dist/engines/artemis/stage.js');
  const effects = [];
  let transition = 2,
    rule = 'mask',
    value = 0,
    refresh = 1;
  const stage = new ArtemisStage(revision, {
    captureMode: () => 0,
    transitionState: () => transition,
    clearTransitionRule: () => {
      rule = null;
      effects.push(['rule', rule]);
    },
    resetTransitionLayerValue: (next) => {
      value = next;
      effects.push(['value', value]);
    },
    setTransitionState: (next) => {
      transition = next;
      effects.push(['transition', next]);
    },
    markSceneDirty: () => effects.push(['dirty']),
    commitLayers: () => {
      effects.push(['commit', rule, value]);
      refresh = 0;
    },
    refreshState: () => refresh,
    setRefreshState: (next) => {
      refresh = next;
      effects.push(['refresh', next]);
    },
  });
  assert.equal(stage.dispatch(command('not flip')), false);
  assert.equal(stage.dispatch(command('flip')), true);
  assert.deepEqual(effects, [
    ['rule', null],
    ['value', 0xffffffff],
    ['transition', 0],
    ['dirty'],
    ['commit', null, 0xffffffff],
  ]);
  assert.equal(refresh, 0);
});

test('Artemis layer command history coalesces the newest matching name across intervening commands', async () => {
  const {ArtemisLayerCommands} = await import('../dist/engines/artemis/layer-commands.js');
  const store = new ArtemisLayerCommands(revision);
  const first = command('lyprop', {id: '2', left: '10', alpha: '128'});
  store.record(first);
  first.args.set('left', 'external mutation');
  store.record(command('lyevent', {id: '2', event: 'click', label: 'clicked'}));
  store.record({...command('lyprop', {id: '2', top: '20'}), sourceLine: 99});
  const history = store.commands('2');
  assert.equal(history.length, 2);
  assert.deepEqual(Object.fromEntries(history[0].args), {
    id: '2',
    left: '10',
    alpha: '128',
    top: '20',
  });
  assert.equal(history[0].sourceLine, 7);
  assert.equal(history[1].name, 'lyevent');
  history[0].args.set('left', 'returned snapshot mutation');
  assert.equal(store.commands('2')[0].args.get('left'), '10');
  store.record(command('lyprop', {top: 'missing id'}));
  assert.equal(store.snapshot().size, 1);
  // Exact argument bytes follow the value that overwrote them.
  const bytes = (text) => new TextEncoder().encode(text);
  store.record({
    ...command('lyprop', {id: '3', clip: '1', file: 'f'}),
    bytes: new Map([
      ['clip', bytes('1')],
      ['file', bytes('f')],
    ]),
  });
  store.record(command('lyprop', {id: '3', clip: '2'}));
  store.record({
    ...command('lyprop', {id: '3', alpha: '9'}),
    bytes: new Map([['alpha', bytes('9')]]),
  });
  const [merged] = store.commands('3');
  assert.deepEqual(Object.fromEntries(merged.args), {id: '3', clip: '2', file: 'f', alpha: '9'});
  assert.deepEqual([...merged.bytes.keys()], ['file', 'alpha']);
});

test('Artemis keyed layer command coalescing requires every selected argument and preserves separate raw ids', async () => {
  const {ArtemisLayerCommands} = await import('../dist/engines/artemis/layer-commands.js');
  const store = new ArtemisLayerCommands(revision),
    keys = new Set(['event', 'key']);
  store.record(command('lyevent', {id: '2', event: 'click', key: '1', label: 'first'}), keys);
  store.record(command('lyevent', {id: '2', event: 'click', key: '2', label: 'other'}), keys);
  store.record(command('lyevent', {id: '2', event: 'click', key: '1', label: 'updated'}), keys);
  assert.deepEqual(
    store.commands('2').map((tag) => tag.args.get('label')),
    ['updated', 'other'],
  );
  store.record(
    command('lyevent', {id: '2', event: 'click', label: 'missing comparison key'}),
    keys,
  );
  assert.equal(store.commands('2').length, 3);
  store.record(command('lyprop', {id: '02', left: 'separate bucket'}));
  store.clear(['02']);
  assert.equal(store.commands('02'), undefined);
  assert.equal(store.commands('2').length, 3);
  // lyc, anime init and video replace the list with a copy of their tag.
  const created = command('lyc', {id: '2', file: 'a'});
  store.reset('2', created);
  created.args.set('file', 'external mutation');
  assert.deepEqual(
    store.commands('2').map((tag) => [tag.name, tag.args.get('file')]),
    [['lyc', 'a']],
  );
  store.reset('\u{10000}', command('lyc', {id: '\u{10000}'}));
  store.reset('\ue000', command('lyc', {id: '\ue000'}));
  assert.deepEqual([...store.snapshot().keys()], ['2', '\ue000', '\u{10000}']);
});

async function surfaceFixture(budget = 16n, overrides = {}) {
  const {ArtemisSurfaceCache} = await import('../dist/engines/artemis/surface-cache.js');
  const {createSolidImage} = await import('../dist/graphics/solid-image.js');
  const loaded = [],
    prepared = [],
    disposed = [];
  const source = overrides.source ?? {
    async load(name) {
      loaded.push(name);
      if (name === 'missing') return null;
      return {path: `${name}.png`, image: createSolidImage(1, 1, [10, 20, 30, 255])};
    },
  };
  const cache = new ArtemisSurfaceCache(revision, budget, source, {
    storageBytes: () => 8, // Explicit native-size fixture, independent of four RGBA bytes.
    prepare: (resource) => prepared.push(resource),
    dispose: (resource) => disposed.push(resource),
    ...overrides.owner,
  });
  return {cache, loaded, prepared, disposed};
}

test('Artemis surface loans share active and idle resources using exact requested names', async () => {
  const {cache, loaded, prepared, disposed} = await surfaceFixture();
  const a = await cache.load('日本/😀'),
    b = await cache.load('日本/😀');
  assert.equal(a.image, b.image);
  assert.notEqual(a.lease, b.lease);
  assert.equal(cache.bytesUsed, 8n);
  a.lease.release();
  a.lease.release();
  assert.equal(disposed.length, 0);
  const c = await cache.load('日本/😀');
  assert.equal(c.image, b.image);
  b.lease.release();
  c.lease.release();
  const revived = await cache.load('日本/😀');
  assert.equal(revived.image, a.image);
  assert.deepEqual(loaded, ['日本/😀']);
  assert.equal(prepared.length, 1);
  const explicit = await cache.load('日本/😀.png');
  assert.notEqual(explicit.image, a.image); // Requested key, not decoder candidate path.
  revived.lease.release();
  explicit.lease.release();
  cache.close();
  cache.close();
  assert.equal(disposed.length, 2);
  assert.equal(cache.bytesUsed, 0n);
  await assert.rejects(cache.load('later'), /closed/);
});

test('Artemis surface budget trims oldest idle entries before a miss, without reserving its size', async () => {
  const {cache, loaded, disposed} = await surfaceFixture();
  const a = await cache.load('a'),
    b = await cache.load('b');
  a.lease.release();
  b.lease.release();
  const promoted = await cache.load('a');
  promoted.lease.release(); // FIFO now b, a.
  const c = await cache.load('c');
  assert.equal(cache.bytesUsed, 24n); // Native allows the new active resource to exceed budget.
  assert.equal(disposed.length, 0);
  const activeHit = await cache.load('c');
  assert.equal(cache.bytesUsed, 24n); // Neither a hit nor promotion trims.
  activeHit.lease.release();
  const missing = await cache.load('missing');
  assert.equal(missing, null);
  assert.deepEqual(
    disposed.map((x) => x.path),
    ['b.png'],
  );
  assert.equal(cache.bytesUsed, 16n);
  const idleHit = await cache.load('a');
  assert.deepEqual(loaded, ['a', 'b', 'c', 'missing']);
  c.lease.release();
  idleHit.lease.release();
  cache.close();
  assert.equal(cache.bytesUsed, 0n);
});

test('Artemis releases the newly unloaned surface while over budget and preserves active borrowers on close', async () => {
  const {cache, disposed} = await surfaceFixture(8n);
  const a = await cache.load('a'),
    b = await cache.load('b');
  cache.trim(); // Both active; neither can be evicted.
  assert.equal(cache.bytesUsed, 16n);
  b.lease.release();
  assert.deepEqual(
    disposed.map((x) => x.path),
    ['b.png'],
  );
  cache.close();
  assert.equal(cache.bytesUsed, 8n);
  assert.equal(a.image.pixels[0], 10);
  a.lease.release();
  a.lease.release();
  assert.equal(cache.bytesUsed, 0n);
  assert.deepEqual(
    disposed.map((x) => x.path),
    ['b.png', 'a.png'],
  );
});

test('Artemis surface load failures, shutdown during decoding and unsupported names leave no loans', async () => {
  const {ArtemisSurfaceCache} = await import('../dist/engines/artemis/surface-cache.js');
  assert.throws(
    () => new ArtemisSurfaceCache('unknown', 0n, {}, {}),
    /Unsupported Artemis executable/,
  );
  assert.throws(() => new ArtemisSurfaceCache(revision, -1n, {}, {}), /budget/);
  const failed = await surfaceFixture(0n, {
    owner: {
      prepare() {
        throw Error('GPU failure');
      },
    },
  });
  await assert.rejects(failed.cache.load('a'), /GPU failure/);
  assert.equal(failed.disposed.length, 1);
  assert.equal(failed.cache.bytesUsed, 0n);
  await assert.rejects(failed.cache.load('a'), /GPU failure/); // Failed resources are not cached.
  assert.equal(failed.loaded.length, 2);
  for (const name of ['nul\0', '\ud800', '\udc00'])
    await assert.rejects(failed.cache.load(name), /surface name/);
  assert.equal(failed.loaded.length, 2);
  let finish;
  const pending = await surfaceFixture(8n, {
    source: {
      load: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    },
  });
  const loading = pending.cache.load('pending');
  await assert.rejects(pending.cache.load('another'), /overlapping/);
  pending.cache.close();
  finish({path: 'pending', image: {width: 1, height: 1, pixels: new Uint8Array(4)}});
  await assert.rejects(loading, /closed during load/);
  assert.equal(pending.prepared.length, 0);
  assert.equal(pending.disposed.length, 1);
  assert.equal(pending.cache.bytesUsed, 0n);
});

async function cachedLayerFixture(budget = 0n, source) {
  const {ArtemisImageGraphics} = await import('../dist/engines/artemis/image-graphics.js');
  const {ArtemisLayers} = await import('../dist/engines/artemis/layers.js');
  const f = await surfaceFixture(budget, source ? {source} : {});
  const target = {width: 4, height: 2, prepareImage() {}, invalidate() {}, draw() {}};
  const graphics = new ArtemisImageGraphics(
    revision,
    target,
    {
      creationMode: () => 0,
      clearLayerCommands() {},
      resetLayerCommands() {},
      recordLayerProperties() {},
      imageLoadFailed() {},
      layerNotFound() {},
    },
    {filter: 'nearest', blend: straightBlend},
  );
  return {...f, graphics, layers: new ArtemisLayers(revision, f.cache, graphics)};
}

test('Rev.2898 named effects retain coefficients and A8 masks across actor changes and release their upload views', async () => {
  const {ARTEMIS_2898_EXECUTABLE_SHA256: hash} =
    await import('../dist/engines/artemis/revision.js');
  const {ArtemisImageGraphics} = await import('../dist/engines/artemis/image-graphics.js');
  const {ArtemisLayers} = await import('../dist/engines/artemis/layers.js');
  const {ArtemisShaderLibrary} = await import('../dist/engines/artemis/shader-library.js');
  const {ArtemisDrawShaderResource} = await import('../dist/engines/artemis/draw-shader.js');
  const uploaded = [],
    invalidated = [],
    released = [];
  const target = {
    width: 2,
    height: 1,
    prepareImage: (image) => uploaded.push(image),
    invalidate: (image) => invalidated.push(image),
    draw(list, resolve) {
      for (const c of list.commands) for (const t of c.additionalTextures ?? []) resolve(t.texture);
    },
  };
  const library = new ArtemisShaderLibrary(
    hash,
    async () => new Uint8Array([1]),
    {
      // Synthetic calibration compiler; installation checks exercise real-source signatures.
      compile: async () => ({shader: new ArtemisDrawShaderResource(hash, 'raster', () => {})}),
      dispose: (shader) => shader.dispose(),
    },
    () => assert.fail('shader compilation failed'),
  );
  const tag = (name, args) => ({name, args: new Map(Object.entries(args))});
  await library.dispatch(tag('lyshader', {id: 'warp', file: 'calibration'}));
  await library.dispatch(tag('lyshader', {id: 'other', file: 'calibration'}));
  const graphics = new ArtemisImageGraphics(
    hash,
    target,
    {
      creationMode: () => 0,
      clearLayerCommands() {},
      resetLayerCommands() {},
      recordLayerProperties() {},
      imageLoadFailed: () => assert.fail('image failed'),
      layerNotFound: () => assert.fail('layer missing'),
    },
    {filter: 'nearest', blend: straightBlend},
    library,
  );
  const fore = {width: 2, height: 1, pixels: new Uint8Array([10, 20, 30, 255, 40, 50, 60, 255])};
  const gray = {width: 2, height: 1, pixels: new Uint8Array([64, 64, 64, 0, 192, 192, 192, 0])};
  const secondGray = {
    width: 2,
    height: 1,
    pixels: new Uint8Array([128, 128, 128, 0, 255, 255, 255, 0]),
  };
  const layers = new ArtemisLayers(
    hash,
    {
      load: async (path) => {
        const image =
          path === 'fore'
            ? fore
            : path === 'mask'
              ? gray
              : path === 'second-mask'
                ? secondGray
                : null;
        if (!image) return null;
        return {
          path,
          image,
          surfaceFormat: path === 'fore' ? 2 : 0,
          lease: {release: () => released.push(path)},
        };
      },
    },
    graphics,
  );
  try {
    await layers.dispatch(tag('lyc', {id: '1', file: 'fore'}));
    layers.commit();
    await layers.dispatch(
      tag('lyprop', {
        id: '1',
        shader: 'warp',
        shaderconstant: 'size,angle,inter,alpha',
        size: '.25',
        angle: '90',
        inter: '0',
        alpha: '.5',
        intermediate_render_mask: 'mask',
      }),
    );
    layers.commit();
    const first = graphics.drawCommitted(layers.scene).commands[0];
    assert.deepEqual([...first.parameters.slice(0, 3)], [90, 0, 0.25]);
    assert.equal(first.parameters[31], 0.5);
    assert.equal(first.filter, 'linear');
    const maskId = first.additionalTextures[0].texture;
    const mask = graphics.image(maskId);
    assert.notEqual(mask, gray);
    assert.deepEqual([...mask.pixels], [0, 0, 0, 64, 0, 0, 0, 192]);
    assert.deepEqual([...gray.pixels], [64, 64, 64, 0, 192, 192, 192, 0]);
    assert.ok(first.fragment.includes('additionalAtlas0,additionalUV0).a'));
    await layers.dispatch(
      tag('lyprop', {id: '1', intermediate_render_mask: '', shaderconstant: ''}),
    );
    layers.commit();
    const retained = graphics.drawCommitted(layers.scene).commands[0];
    assert.equal(retained.additionalTextures[0].texture, maskId);
    assert.deepEqual([...retained.parameters.slice(0, 3)], [90, 0, 0.25]);
    assert.equal(retained.parameters[31], retained.vertices[6]); // Builtin alpha is assigned for each draw.
    await layers.dispatch(tag('lyc', {id: '2', file: 'fore'}));
    layers.commit();
    await layers.dispatch(tag('lyprop', {id: '2', shader: 'warp'}));
    layers.commit();
    const shared = graphics.drawCommitted(layers.scene).commands[1];
    assert.deepEqual([...shared.parameters.slice(0, 3)], [90, 0, 0.25]);
    assert.equal(shared.additionalTextures[0].texture, maskId);
    await layers.dispatch(tag('lyprop', {id: '2', shader: 'other'}));
    layers.commit();
    const separate = graphics.drawCommitted(layers.scene).commands[1];
    assert.deepEqual([...separate.parameters.slice(0, 3)], [0, 0, 0]);
    assert.equal(separate.additionalTextures, undefined);
    // First actor samples the retained old mask; a later actor replaces the same effect's
    // binding before batch submission. Both command dependencies must remain resolvable.
    await layers.dispatch(
      tag('lyprop', {id: '2', shader: 'warp', intermediate_render_mask: 'second-mask'}),
    );
    layers.commit();
    const replaced = graphics.drawCommitted(layers.scene).commands;
    assert.equal(replaced[0].additionalTextures[0].texture, maskId);
    assert.notEqual(replaced[1].additionalTextures[0].texture, maskId);
    assert.equal(released.filter((p) => p === 'mask').length, 1);
    layers.close();
    assert.ok(!released.includes('second-mask'));
    library.close();
    assert.equal(released.filter((p) => p === 'mask').length, 1);
    assert.equal(released.filter((p) => p === 'second-mask').length, 1);
    assert.equal(invalidated.filter((i) => i === mask).length, 1);
    assert.throws(() => graphics.image(maskId), /released/);
  } finally {
    layers.close();
    library.close();
  }
});
test('DX9 captured custom passes inherit device blend factors while legacy captures replace RGBA', async () => {
  const {ARTEMIS_2898_EXECUTABLE_SHA256: dx9, ARTEMIS_3179_EXECUTABLE_SHA256: old} =
    await import('../dist/engines/artemis/revision.js');
  const {ArtemisImageGraphics} = await import('../dist/engines/artemis/image-graphics.js');
  const {ArtemisLayers} = await import('../dist/engines/artemis/layers.js');
  const {ArtemisDrawShaderResource} = await import('../dist/engines/artemis/draw-shader.js');
  const {createArtemisOrdinaryGpuRaster} = await import('../dist/engines/artemis/gpu-raster.js');
  const tag = (name, args) => ({name, args: new Map(Object.entries(args))});
  for (const hash of [dx9, old]) {
    const shader = new ArtemisDrawShaderResource(hash, 'raster', () => {});
    const target = {
      width: 2,
      height: 1,
      prepareImage() {},
      prepareRenderSurface() {},
      invalidate() {},
      draw() {},
    };
    const graphics = new ArtemisImageGraphics(
      hash,
      target,
      {
        creationMode: () => 0,
        clearLayerCommands() {},
        resetLayerCommands() {},
        recordLayerProperties() {},
        imageLoadFailed: () => assert.fail('image failed'),
        layerNotFound: () => assert.fail('layer missing'),
      },
      createArtemisOrdinaryGpuRaster(hash),
      {bind: () => ({shader, release() {}})},
    );
    const image = {
      width: 2,
      height: 1,
      pixels: new Uint8Array([100, 20, 30, 128, 40, 50, 60, 128]),
    };
    const layers = new ArtemisLayers(
      hash,
      {load: async (path) => ({path, image, surfaceFormat: 2})},
      graphics,
    );
    try {
      await layers.dispatch(tag('lyc', {id: '1', file: 'fore'}));
      await layers.dispatch(tag('lyprop', {id: '1', layermode: 'add'}));
      await layers.dispatch(tag('lyc', {id: '2.a', file: 'fore'}));
      await layers.dispatch(
        tag('lyprop', {
          id: '2.a',
          shader: 'warp',
          shaderconstant: 'angle,inter,size',
          angle: '0',
          inter: '0',
          size: '0',
        }),
      );
      await layers.dispatch(tag('lyprop', {id: '2', intermediate_render: '1', clip: '0,0,2,1'}));
      layers.commit();
      const custom = () =>
        graphics
          .drawCommitted(layers.scene)
          .commands.find((c) => c.kind === 'triangles' && c.parameters);
      const add = custom();
      const replace = {source: 'one', destination: 'zero', operation: 'add'};
      assert.deepEqual(
        add.blendState.color,
        hash === dx9 ? {source: 'source-alpha', destination: 'one', operation: 'add'} : replace,
      );
      assert.deepEqual(add.blendState.alpha, add.blendState.color);
      assert.equal(add.discardTransparent, false);
      assert.equal(add.additionalTextures[0].filter, hash === dx9 ? 'nearest' : 'linear');
      await layers.dispatch(tag('lyprop', {id: '1', layermode: 'screen'}));
      await layers.dispatch(tag('lyprop', {id: '2.a', shaderconstant: 'angle', angle: '1'}));
      layers.commit();
      const screen = custom();
      assert.deepEqual(
        screen.blendState.color,
        hash === dx9
          ? {source: 'inverse-destination-color', destination: 'one', operation: 'add'}
          : replace,
      );
      // The group's final ordinary draw sets normal factors; they survive to the next render.
      await layers.dispatch(tag('lydel', {id: '1'}));
      await layers.dispatch(tag('lyprop', {id: '2.a', shaderconstant: 'angle', angle: '2'}));
      layers.commit();
      const next = custom();
      assert.deepEqual(
        next.blendState.color,
        hash === dx9
          ? {source: 'source-alpha', destination: 'inverse-source-alpha', operation: 'add'}
          : replace,
      );
    } finally {
      layers.close();
      shader.dispose();
    }
  }
});
test('Artemis rule transitions upload the gray rule as equal RGBA channels once per revision', async () => {
  const {ArtemisImageGraphics} = await import('../dist/engines/artemis/image-graphics.js');
  const {ArtemisScene} = await import('../dist/engines/artemis/scene.js');
  const prepared = [];
  const target = {
    width: 3,
    height: 2,
    prepareImage: (image) => prepared.push(image),
    prepareRenderSurface() {},
    invalidate() {},
    draw() {},
  };
  const graphics = new ArtemisImageGraphics(
    revision,
    target,
    {
      creationMode: () => 0,
      clearLayerCommands() {},
      resetLayerCommands() {},
      recordLayerProperties() {},
      imageLoadFailed() {},
      layerNotFound() {},
    },
    {filter: 'nearest', blend: straightBlend},
  );
  const gray = [0, 1, 127, 128, 254, 255];
  const rule = {width: 3, height: 2, bytesPerPixel: 1, pixels: Uint8Array.from(gray)};
  const presentation = {state: 2, crossfade: 0, vague: 0, threshold: 0, rule, ruleRevision: 1};
  const scene = new ArtemisScene(revision);
  graphics.drawStage(scene, presentation);
  graphics.drawStage(scene, presentation);
  assert.equal(prepared.length, 1);
  assert.deepEqual(
    [...prepared[0].pixels],
    gray.flatMap((value) => [value, value, value, value]),
  );
  graphics.drawStage(scene, {...presentation, ruleRevision: 2});
  assert.equal(prepared.length, 2);
});

test('Artemis layer owner and graphics share one texture allocation', async () => {
  const {createArtemisBrowserLayers} = await import('../dist/engines/artemis/browser/layers.js');
  const {createArtemisImageLoader} = await import('../dist/engines/artemis/image-loader.js');
  const bytes = await syntheticImage();
  const target = {width: 4, height: 2, prepareImage() {}, invalidate() {}, draw() {}};
  const {owner, graphics} = createArtemisBrowserLayers({
    executableSha256: revision,
    target,
    raster: {filter: 'nearest', blend: straightBlend},
    images: createArtemisImageLoader(revision, async (path) => (path === 'a.png' ? bytes : null)),
    runMode: {},
    loadRule: async () => null,
    readVideoFile: async () => null,
    clock: {now: () => 1},
    glyphs: {},
    textProperties: () => undefined,
    report: (message) => assert.fail(message),
  });
  await owner.layers.dispatch(command('lyc', {id: '1', file: 'a.png'}));
  const layer = owner.layers.scene.entry('1').value;
  // A texture the graphics owner allocates itself (glyphs, rules, captures, shader inputs).
  const own = {width: 1, height: 1, pixels: new Uint8Array(4)};
  const separate = graphics.createImageLayer({image: own}, {x: 0, y: 0});
  assert.notEqual(separate.texture, layer.texture);
  assert.equal(graphics.image(separate.texture), own);
  assert.notEqual(graphics.image(layer.texture), own);
  graphics.releaseImageLayer(separate);
  await owner.layers.dispatch(command('lyprop', {id: '1', left: '1'}));
  assert.equal(graphics.image(owner.layers.scene.entry('1').value.texture).width, 2);
});

async function browserLayerOwner() {
  const {createArtemisBrowserLayers} = await import('../dist/engines/artemis/browser/layers.js');
  const {createArtemisImageLoader} = await import('../dist/engines/artemis/image-loader.js');
  const bytes = await syntheticImage();
  const target = {width: 64, height: 64, prepareImage() {}, invalidate() {}, draw() {}};
  const {owner} = createArtemisBrowserLayers({
    executableSha256: revision,
    target,
    raster: {filter: 'nearest', blend: straightBlend},
    images: createArtemisImageLoader(revision, async () => bytes),
    runMode: {},
    loadRule: async () => null,
    readVideoFile: async () => null,
    clock: {now: () => 1},
    glyphs: {},
    textProperties: () => undefined,
    report: (message) => assert.fail(message),
  });
  return owner;
}
const lyevent = (id, type, extra = {}) =>
  command('lyevent', {id, type, mode: 'init', handler: 'calllua', function: type, ...extra});

test('Artemis draggable layers start on a press inside, follow the pointer within the drag area and end on release', async () => {
  const owner = await browserLayerOwner();
  await owner.layers.dispatch(command('lyc', {id: '1', file: 'a.png'}));
  await owner.layers.dispatch(command('lyc', {id: '2', file: 'a.png'}));
  await owner.layers.dispatch(
    command('lyprop', {id: '1', left: '10', top: '20', draggable: '1', dragarea: '0,0,30,25'}),
  );
  for (const type of ['dragin', 'drag', 'dragout', 'click'])
    await owner.dispatch(lyevent('1', type));
  const position = (id) => {
    const {left, top} = owner.layerInfo(id).display.properties;
    return [left, top];
  };
  const step = (x, y, hits, downEdge, down) =>
    owner.updatePointer({x, y}, hits, {decide: downEdge, downEdge, down});
  // A press outside the layer, or a held key without its down edge, does not start a drag;
  // a draggable layer raises no click.
  assert.deepEqual(step(5, 5, [], true, true), []);
  assert.deepEqual(step(12, 22, ['1'], false, true), []);
  assert.deepEqual(step(12, 22, ['1'], true, true), [{id: '1', type: 'dragin'}]);
  assert.deepEqual(position('1'), [10, 20]);
  // The layer moves by the pointer offset since the press, even outside its hit area.
  assert.deepEqual(step(15, 21, [], false, true), [{id: '1', type: 'drag'}]);
  assert.deepEqual(position('1'), [13, 19]);
  // The drag area clamps left into [0, 30] and top into [0, 25].
  step(100, -50, [], false, true);
  assert.deepEqual(position('1'), [30, 0]);
  assert.deepEqual(step(2, 30, [], false, false), [{id: '1', type: 'dragout'}]);
  assert.deepEqual(position('1'), [0, 25]);
  // Idle again: movement without a new press leaves the layer in place.
  assert.deepEqual(step(20, 20, ['1'], false, true), []);
  assert.deepEqual(position('1'), [0, 25]);
  // A layer without the draggable flag never drags.
  assert.deepEqual(step(1, 1, ['2'], true, true), []);
  // An empty drag area (all edges zero) does not clamp.
  await owner.layers.dispatch(command('lyprop', {id: '1', dragarea: '0,0,0,0'}));
  step(0, 0, ['1'], true, true);
  step(-40, 100, [], false, true);
  assert.deepEqual(position('1'), [-40, 125]);
});

test('Artemis pointer updates raise rollover, rollout and click per layer, and a click without penetration suppresses the layers below it', async () => {
  const {ArtemisScriptEvents} = await import('../dist/engines/artemis/script-events.js');
  const owner = await browserLayerOwner();
  for (const id of ['1', '2', '3'])
    await owner.layers.dispatch(command('lyc', {id, file: 'a.png'}));
  await owner.dispatch(lyevent('3', 'click'));
  await owner.dispatch(lyevent('3', 'rollover'));
  await owner.dispatch(lyevent('3', 'rollout'));
  await owner.dispatch(lyevent('2', 'click', {penetration: '1'}));
  await owner.dispatch(lyevent('1', 'click'));
  await owner.dispatch(lyevent('1', 'rollover'));
  const latches = [false, false],
    delivered = [];
  const events = new ArtemisScriptEvents(revision, {
    nativeMode: () => 1,
    disabled: () => false,
    latched: (mode) => latches[mode],
    latch: (mode) => (latches[mode] = true),
    filter: () => 0,
    report: (kind, _command, error) => assert.fail(`${kind}: ${error}`),
    jump: () => false,
    call: () => false,
    enterHandlerScope: () => {},
    enqueueHandler: () => {},
  });
  const update = (hits) =>
    owner
      .updatePointer({x: 0, y: 0}, hits, {decide: false, downEdge: false, down: false})
      .map(({id, type}) => `${id}:${type}`);
  // Every hit layer gets its own rollover, topmost first; leaving raises rollout.
  assert.deepEqual(update(['3', '1']), ['3:rollover', '1:rollover']);
  assert.deepEqual(update(['3', '1']), []);
  assert.deepEqual(update(['1']), ['3:rollout']);
  // A press raises click on every hit layer in hit order; the stored callbacks decide which
  // reach the script: 3 has no penetration and takes the click latch, 2 penetrates (force)
  // and 1 is suppressed.
  const raised = owner.updatePointer({x: 0, y: 0}, ['3', '2', '1'], {
    decide: true,
    downEdge: true,
    down: true,
  });
  assert.deepEqual(
    raised.map(({id, type}) => `${id}:${type}`),
    ['3:click', '3:rollover', '2:click', '1:click'],
  );
  latches.fill(false);
  const sink = {
    emit: (command, mode, force) => {
      const result = events.emit(command, mode, force);
      delivered.push(`${command.args.get('id')}:${result.status}`);
      return result;
    },
  };
  for (const {id, type} of raised) owner.invokeLayerEvent(id, type, sink);
  assert.deepEqual(delivered, ['3:delivered', '3:delivered', '2:delivered', '1:suppressed']);
});

test('Artemis cache loans belong to outer wrappers across current/retained actor copies and multiple layers', async () => {
  const {cache, layers, loaded, disposed} = await cachedLayerFixture();
  await layers.dispatch(command('lyc', {id: '1', file: 'a'}));
  layers.commit();
  await layers.dispatch(command('lyprop', {id: '1', left: '2'}));
  await layers.dispatch(command('lyc', {id: '2', file: 'a'}));
  assert.equal(loaded.length, 1);
  assert.equal(cache.bytesUsed, 8n);
  await layers.dispatch(command('lydel', {id: '1'}));
  assert.equal(disposed.length, 0);
  layers.commit(); // Releases both versions of wrapper 1; wrapper 2 keeps its own loan.
  assert.equal(disposed.length, 0);
  await layers.dispatch(command('lydel', {id: '2'}));
  assert.equal(disposed.length, 0);
  layers.commit();
  assert.equal(disposed.length, 1);
  assert.equal(cache.bytesUsed, 0n);
  layers.close();
  cache.close();
});

test('Artemis cancelled and rejected layer creation releases the cache loan exactly once', async () => {
  let finish;
  const f = await cachedLayerFixture(0n, {
    load: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const pending = f.layers.dispatch(command('lyc', {id: '1', file: 'pending'}));
  f.layers.cancelPending();
  finish({path: 'pending', image: {width: 1, height: 1, pixels: new Uint8Array(4)}});
  await assert.rejects(pending, /cancelled/);
  assert.equal(f.disposed.length, 1);
  assert.equal(f.cache.bytesUsed, 0n);
  f.layers.close();
  f.cache.close();

  const rejected = await cachedLayerFixture();
  rejected.graphics.createImageLayer = () => {
    throw Error('actor allocation failed');
  };
  await assert.rejects(
    rejected.layers.dispatch(command('lyc', {id: '1', file: 'a'})),
    /allocation failed/,
  );
  assert.equal(rejected.disposed.length, 1);
  assert.equal(rejected.cache.bytesUsed, 0n);
  rejected.layers.close();
  rejected.cache.close();
});

test('Artemis ordinary GPU policy preserves native alpha writes, transparent fragments and clear color', async () => {
  const {createArtemisOrdinaryGpuRaster} = await import('../dist/engines/artemis/gpu-raster.js');
  assert.throws(() => createArtemisOrdinaryGpuRaster('unknown'), /Unsupported Artemis executable/);
  const policy = createArtemisOrdinaryGpuRaster(revision);
  const {layers, graphics} = await rasterFixture(policy);
  try {
    await layers.dispatch(command('lyc', {id: '1', file: 'synthetic'}));
    layers.commit();
    const list = graphics.drawCommitted(layers.scene),
      draw = list.commands[0];
    assert.deepEqual(list.clearColor, [0, 0, 0, 0]);
    assert.equal(draw.filter, 'linear');
    assert.equal(draw.discardTransparent, false);
    assert.deepEqual(draw.blendState.alpha, {
      source: 'source-alpha',
      destination: 'one',
      operation: 'add',
    });
    assert.deepEqual(draw.blendState.color, {
      source: 'source-alpha',
      destination: 'inverse-source-alpha',
      operation: 'add',
    });
  } finally {
    layers.close();
  }
});

test('Artemis layer mode updates preserve the retained raster state and ignore unknown native spellings', async () => {
  const {createArtemisOrdinaryGpuRaster} = await import('../dist/engines/artemis/gpu-raster.js');
  const {layers, graphics} = await rasterFixture(createArtemisOrdinaryGpuRaster(revision));
  try {
    await layers.dispatch(command('lyc', {id: '1', file: 'synthetic'}));
    layers.commit();
    const old = layers.scene.entry('1').value;
    await layers.dispatch(command('lyprop', {id: '1', layermode: 'multiply'}));
    assert.equal(old.raster.layerMode, 'normal');
    assert.equal(layers.scene.entry('1').value.raster.layerMode, 'multiply');
    assert.equal(graphics.drawCommitted(layers.scene).commands[0].fragment, undefined);
    layers.commit();
    assert.match(graphics.drawCommitted(layers.scene).commands[0].fragment, /1\.0-s\.a/);
    await layers.dispatch(command('lyprop', {id: '1', layermode: 'MULTIPLY'}));
    layers.commit();
    assert.equal(layers.scene.entry('1').value.raster.layerMode, 'multiply');
    await layers.dispatch(command('lyprop', {id: '1', layermode: 'normal'}));
    layers.commit();
    assert.equal(graphics.drawCommitted(layers.scene).commands[0].fragment, undefined);
  } finally {
    layers.close();
  }
});

test('Artemis layer modes refuse custom raster fixtures without their required mode owner', async () => {
  const {layers} = await rasterFixture();
  try {
    await layers.dispatch(command('lyc', {id: '1', file: 'synthetic'}));
    layers.commit();
    await assert.rejects(
      layers.dispatch(command('lyprop', {id: '1', left: '10', layermode: 'add'})),
      /raster policy owner/,
    );
    assert.equal(layers.scene.entry('1').value.display.properties.left, 0);
    assert.equal(layers.scene.entry('1').value.raster.layerMode, 'normal');
  } finally {
    layers.close();
  }
});

test('Artemis color effects keep native flag spelling, hexadecimal prefixes and retained state', async () => {
  const {createArtemisOrdinaryGpuRaster} = await import('../dist/engines/artemis/gpu-raster.js');
  const {layers, graphics} = await rasterFixture(createArtemisOrdinaryGpuRaster(revision));
  try {
    await layers.dispatch(command('lyc', {id: '1', file: 'synthetic'}));
    layers.commit();
    const old = layers.scene.entry('1').value;
    await layers.dispatch(
      command('lyprop', {id: '1', negative: '00', grayscale: '', colormultiply: ' +0x4080c0tail'}),
    );
    assert.deepEqual(old.raster, {
      layerMode: 'normal',
      negative: false,
      grayscale: false,
      colorMultiply: 0xffffff,
    });
    assert.deepEqual(layers.scene.entry('1').value.raster, {
      layerMode: 'normal',
      negative: true,
      grayscale: true,
      colorMultiply: 0x4080c0,
    });
    assert.equal(graphics.drawCommitted(layers.scene).commands[0].fragment, undefined);
    layers.commit();
    const draw = graphics.drawCommitted(layers.scene).commands[0];
    assert.deepEqual(
      [...draw.vertices.slice(3, 6)],
      [Math.fround(64 / 255), Math.fround(128 / 255), Math.fround(192 / 255)],
    );
    assert.ok(draw.fragment.indexOf('vec3(1.0)-s.rgb') < draw.fragment.indexOf('float gray'));
    assert.ok(draw.fragment.indexOf('float gray') < draw.fragment.indexOf('s.rgb*=tint.rgb'));
    await layers.dispatch(
      command('lyprop', {id: '1', negative: '0', grayscale: '0', colormultiply: '100000000'}),
    );
    layers.commit();
    assert.equal(layers.scene.entry('1').value.raster.colorMultiply, 0xffffffff);
    await layers.dispatch(command('lyprop', {id: '1', colormultiply: '-1'}));
    layers.commit();
    assert.equal(layers.scene.entry('1').value.raster.colorMultiply, 0xffffffff);
    await layers.dispatch(command('lyprop', {id: '1', colormultiply: 'ffffff'}));
    layers.commit();
    assert.equal(graphics.drawCommitted(layers.scene).commands[0].fragment, undefined);
  } finally {
    layers.close();
  }
});

test('Artemis non-default image effects require an owner before changing geometry or wrapper state', async () => {
  const {layers} = await rasterFixture();
  try {
    await layers.dispatch(command('lyc', {id: '1', file: 'synthetic'}));
    layers.commit();
    for (const properties of [{negative: '1'}, {grayscale: '1'}, {colormultiply: 'ff0000'}]) {
      await assert.rejects(
        layers.dispatch(command('lyprop', {id: '1', left: '2', alpha: '128', ...properties})),
        /effects require/,
      );
      assert.equal(layers.scene.entry('1').value.display.properties.left, 0);
      assert.equal(layers.scene.entry('1').value.wrapper.alpha, 1);
    }
  } finally {
    layers.close();
  }
});

test('Artemis commit releases edited actors in ascending child order before removed children', () => {
  const released = [],
    scene = new ArtemisScene(revision, (value) => released.push(value));
  for (const id of ['10', '2', '0']) scene.set(id, `old-${id}`);
  scene.commit();
  scene.editValue('10', () => 'new-10');
  scene.editValue('2', () => 'new-2');
  scene.remove('0');
  assert.deepEqual(released, []);
  scene.commit();
  assert.deepEqual(released, ['old-2', 'old-10', 'old-0']);
  scene.clear();
  assert.deepEqual(released.slice(3), ['new-10', 'new-2']);
  assert.equal(scene.payloads().size, 0);
  scene.clear();
  assert.equal(released.length, 5);
});

test('Artemis removed groups destroy physical map slots before both actor slots', () => {
  for (const secondCycle of [false, true]) {
    const released = [],
      scene = new ArtemisScene(revision, (value) => released.push(value));
    scene.set('g', 'group-old', true);
    scene.set('g.a', 'a');
    scene.set('g.b', 'b');
    scene.commit();
    if (secondCycle) {
      scene.set('g.temporary', undefined, true);
      scene.remove('g.temporary');
      scene.commit(); // Flip the physical map slot while retaining the same children.
    }
    scene.remove('g.a');
    scene.set('g.c', 'c');
    scene.editValue('g', () => 'group-new');
    scene.remove('g');
    assert.deepEqual(released, []);
    scene.commit();
    assert.deepEqual(released, [
      ...(secondCycle ? ['c', 'b', 'a'] : ['a', 'c', 'b']),
      'group-new',
      'group-old',
    ]);
    assert.equal(scene.payloads().size, 0);
  }
});

test('Artemis shared payloads survive copied maps, actor slots and aliases until their last reference', () => {
  const released = [],
    scene = new ArtemisScene(revision, (value) => released.push(value));
  const shared = {};
  scene.set('1', shared);
  scene.set('2', shared);
  scene.commit();
  scene.editValue('1', (value) => value);
  scene.editValue('1', () => {
    throw Error('must not copy an already edited slot');
  });
  scene.commit();
  scene.remove('1');
  scene.commit();
  assert.deepEqual(released, []);
  assert.deepEqual([...scene.payloads()], [shared]);
  scene.remove('2');
  assert.deepEqual(released, []);
  scene.clear();
  assert.deepEqual(released, [shared]);
  scene.clear();
  assert.equal(released.length, 1);
});

test('Artemis layer release order determines the native over-budget victim and idle FIFO', async () => {
  const {cache, layers, disposed} = await cachedLayerFixture(16n);
  try {
    for (const id of ['0', '2', '10']) await layers.dispatch(command('lyc', {id, file: id}));
    layers.commit();
    for (const id of ['2', '0', '10']) await layers.dispatch(command('lydel', {id}));
    assert.equal(disposed.length, 0);
    layers.commit();
    assert.deepEqual(
      disposed.map((x) => x.path),
      ['10.png'],
    );
    const added = await cache.load('added'); // Current total fits; no reservation trim.
    await cache.load('missing'); // New total exceeds budget: oldest idle is 2, then 0.
    assert.deepEqual(
      disposed.map((x) => x.path),
      ['10.png', '2.png'],
    );
    added.lease.release();
  } finally {
    layers.close();
    cache.close();
  }
});

test('Artemis clip parsing accepts exactly four comma fields and rounds inclusive endpoints', async () => {
  const {artemisLayerProperties} = await import('../dist/engines/artemis/layer-properties.js');
  const parse = (clip) => artemisLayerProperties(new Map([['clip', clip]])).clip;
  assert.deepEqual(parse(' 1px,,1.5,1\0,extra'), {
    left: 1,
    top: 0,
    width: 1.5,
    height: 1,
    right: 1.5,
    bottom: 0,
  });
  for (const value of ['', '1,2,3', '1,2,3,4,5', 'nan,1']) assert.equal(parse(value), undefined);
  assert.throws(() => parse('nan,0,1,1'), /property number/);
  assert.throws(() => parse('3e38,0,3e38,1'), /clip rectangle/);
});

test('Artemis clip keeps retained source UVs and rebases cropped geometry without changing anchors', async () => {
  const {layers, graphics} = await rasterFixture();
  const positions = (draw) => [...draw.vertices].filter((_, i) => i % 9 < 2);
  const uv = (draw) => [...draw.vertices].filter((_, i) => i % 9 >= 7);
  try {
    await layers.dispatch(command('lyc', {id: '1', file: 'synthetic'}));
    layers.commit();
    const old = layers.scene.entry('1').value;
    await layers.dispatch(command('lyprop', {id: '1', clip: '0,0,1,1'}));
    assert.equal(layers.scene.entry('1').value.clip.width, 0); // Default endpoints match.
    layers.commit();
    const full = graphics.drawCommitted(layers.scene).commands[0];
    await layers.dispatch(command('lyprop', {id: '1', clip: '1,0,1,1'}));
    assert.deepEqual(graphics.drawCommitted(layers.scene).commands[0].vertices, full.vertices);
    assert.equal(old.clip.width, 0);
    layers.commit();
    const cropped = graphics.drawCommitted(layers.scene).commands[0];
    assert.deepEqual(positions(cropped), [-1, 1, -0.5, 1, -1, 0, -0.5, 0]);
    assert.deepEqual(uv(cropped), [0.5, 0, 1, 0, 0.5, 1, 1, 1]);
    assert.equal(layers.scene.entry('1').value.display.properties.anchorx, 1);
    await layers.dispatch(command('lyprop', {id: '1', clip: '-1,0,2,1'}));
    layers.commit();
    assert.deepEqual(
      uv(graphics.drawCommitted(layers.scene).commands[0]),
      [0, 0, 0.5, 0, 0, 1, 0.5, 1],
    );
    for (const clip of ['2,0,1,1', '0,1,1,1', '-2,0,1,1', '0,-2,1,1']) {
      await layers.dispatch(command('lyprop', {id: '1', clip}));
      layers.commit();
      assert.equal(graphics.drawCommitted(layers.scene).commands.length, 0);
    }
    await layers.dispatch(command('lyprop', {id: '1', clip: '2,0,0,1'}));
    layers.commit();
    assert.deepEqual(graphics.drawCommitted(layers.scene).commands[0].vertices, full.vertices);
  } finally {
    layers.close();
  }
});

test('Artemis clip setter preserves dimensions when float32 endpoint comparisons are unchanged', async () => {
  const {layers, graphics} = await rasterFixture();
  try {
    await layers.dispatch(command('lyc', {id: '1', file: 'synthetic'}));
    await layers.dispatch(command('lyprop', {id: '1', clip: '33554432,0,0,1'}));
    layers.commit();
    const old = layers.scene.entry('1').value.clip;
    assert.equal(old.width, 0);
    await layers.dispatch(command('lyprop', {id: '1', clip: '33554432,0,1,1'}));
    layers.commit();
    assert.deepEqual(layers.scene.entry('1').value.clip, old);
    assert.equal(graphics.drawCommitted(layers.scene).commands.length, 1);
  } finally {
    layers.close();
  }
});

test('Artemis ordinary groups compose retained transforms and alpha without owning raster textures', async () => {
  const {layers, graphics, prepared, invalidated} = await rasterFixture();
  try {
    await layers.dispatch(command('lyc', {id: '2.sub.10', file: 'synthetic.png'}));
    await layers.dispatch(command('lyc', {id: '2.sub.1', file: 'synthetic.png'}));
    await layers.dispatch(command('lyc', {id: '1', file: 'synthetic.png'}));
    layers.commit();
    const initial = graphics.drawCommitted(layers.scene);
    assert.deepEqual(
      initial.commands.map((c) => c.texture),
      [
        layers.scene.entry('1').value.texture,
        layers.scene.entry('2.sub.1').value.texture,
        layers.scene.entry('2.sub.10').value.texture,
      ],
    );
    assert.equal(layers.scene.entry('2', 'retained').value.texture, null);
    assert.equal(layers.scene.entry('2', 'retained').value.display.properties.left, 0);
    await layers.dispatch(command('lyprop', {id: '02', left: '1', xscale: '200', alpha: '128'}));
    await layers.dispatch(command('lyprop', {id: '2.sub', left: '1', yscale: '200', alpha: '128'}));
    await layers.dispatch(command('lyprop', {id: '2.sub.1', left: '1', alpha: '128'}));
    const group = layers.scene.entry('2').value;
    assert.equal(group.texture, null);
    assert.equal(group.display.properties.anchorx, 0);
    assert.equal(group.display.properties.anchory, 0);
    assert.equal(prepared.length, 3);
    assert.deepEqual(
      graphics.drawCommitted(layers.scene).commands.map((c) => [...c.vertices]),
      initial.commands.map((c) => [...c.vertices]),
    );
    layers.commit();
    const changed = graphics.drawCommitted(layers.scene).commands;
    // Parent scaling places the unchanged image origins at (3,0) and (5,0).
    assert.deepEqual([...changed[2].vertices.slice(0, 3)], [0.5, 1, 0]);
    assert.deepEqual([...changed[1].vertices.slice(0, 3)], [1.5, 1, 0]);
    const alpha = Math.fround(128 / 255),
      groupAlpha = Math.fround(alpha * alpha);
    assert.equal(changed[2].vertices[6], groupAlpha);
    assert.equal(changed[1].vertices[6], Math.fround(groupAlpha * alpha));
    assert.equal(changed[0].vertices[6], 1);
    assert.equal(group.wrapper.alpha, alpha);
    await layers.dispatch(command('lyprop', {id: '2', top: '1'}));
    const copy = layers.scene.entry('2').value;
    assert.notEqual(copy, group);
    assert.equal(copy.wrapper, group.wrapper);
    assert.equal(layers.scene.entry('2', 'retained').value, group);
    assert.equal(graphics.drawCommitted(layers.scene).commands[2].vertices[1], 1);
    layers.commit();
    assert.throws(() => graphics.copyImageLayer(group), /released/);
    assert.equal(graphics.drawCommitted(layers.scene).commands[2].vertices[1], 0);
    await layers.dispatch(command('lydel', {id: '2'}));
    assert.equal(graphics.drawCommitted(layers.scene).commands.length, 3);
    layers.commit();
    assert.equal(graphics.drawCommitted(layers.scene).commands.length, 1);
    assert.equal(invalidated.length, 2);
    assert.throws(() => graphics.copyImageLayer(copy), /released/);
  } finally {
    layers.close();
  }
  assert.equal(invalidated.length, 3);
});

test('Artemis group visibility and positive-scale gates block descendants but preserve siblings', async () => {
  const {layers, graphics, invalidated} = await rasterFixture();
  try {
    await layers.dispatch(command('lyc', {id: '.child.image', file: 'synthetic.png'}));
    await layers.dispatch(command('lyc', {id: 'sibling', file: 'synthetic.png'}));
    layers.commit();
    assert.equal(graphics.drawCommitted(layers.scene).commands.length, 2);
    for (const [patch, restore] of [
      [{visible: '0'}, {visible: '1'}],
      [{xscale: '0'}, {xscale: '100'}],
      [{yscale: '-1'}, {yscale: '100'}],
    ]) {
      await layers.dispatch(command('lyprop', {id: '', ...patch}));
      assert.equal(graphics.drawCommitted(layers.scene).commands.length, 2);
      layers.commit();
      assert.equal(graphics.drawCommitted(layers.scene).commands.length, 1);
      assert.equal(invalidated.length, 0);
      await layers.dispatch(command('lyprop', {id: '', ...restore}));
      layers.commit();
      assert.equal(graphics.drawCommitted(layers.scene).commands.length, 2);
    }
    await layers.dispatch(command('lyprop', {id: '.child', alpha: '0'}));
    layers.commit();
    assert.equal(graphics.drawCommitted(layers.scene).commands.length, 1);
    assert.equal(invalidated.length, 0);
    await layers.dispatch(command('lyprop', {id: '.child', alpha: '255', rotate: '45'}));
    layers.commit();
    assert.throws(() => graphics.drawCommitted(layers.scene), /trigonometry owner/);
  } finally {
    layers.close();
  }
  assert.equal(invalidated.length, 2);
});

test('Artemis groups retain raster metadata while intermediate rendering requires a GPU owner', async () => {
  const {layers, graphics} = await rasterFixture();
  try {
    await layers.dispatch(command('lyc', {id: 'group.child', file: 'synthetic.png'}));
    layers.commit();
    await layers.dispatch(
      command('lyprop', {
        id: 'group',
        clip: '0,0,2,2',
        layermode: 'normal',
        negative: '0',
        colormultiply: 'ffffff',
      }),
    );
    await assert.rejects(
      () => layers.dispatch(command('lyprop', {id: 'group', intermediate_render: '1'})),
      /GPU surface owner/,
    );
    // lyprop never reads `mask` (only lyc does).
    await layers.dispatch(command('lyprop', {id: 'group', mask: 'missing'}));
    layers.commit();
    assert.equal(graphics.drawCommitted(layers.scene).commands.length, 1);
  } finally {
    layers.close();
  }
});

test('Artemis GPU preparation gates group alpha before descending into brighter or negative children', async () => {
  const {layers, graphics} = await rasterFixture();
  try {
    await layers.dispatch(command('lyc', {id: 'group.child', file: 'synthetic.png'}));
    await layers.dispatch(command('lyc', {id: 'sibling', file: 'synthetic.png'}));
    await layers.dispatch(command('lyprop', {id: 'group.child', alpha: '1020'}));
    await layers.dispatch(command('lyprop', {id: 'group', alpha: String(255 * 2 ** -24)}));
    layers.commit();
    assert.equal(graphics.drawCommitted(layers.scene).commands.length, 1);
    await layers.dispatch(command('lyprop', {id: 'group', alpha: String(255 * 2 ** -23)}));
    layers.commit();
    const exact = graphics.drawCommitted(layers.scene).commands;
    assert.equal(exact.length, 2);
    assert.equal(exact[0].vertices[6], 4 * 2 ** -23);
    await layers.dispatch(command('lyprop', {id: 'group', alpha: '-255'}));
    await layers.dispatch(command('lyprop', {id: 'group.child', alpha: '-255'}));
    layers.commit();
    assert.equal(graphics.drawCommitted(layers.scene).commands.length, 1);
  } finally {
    layers.close();
  }
});

test('Artemis parent acceptance holds sub-epsilon changes through actor copies and accepts the exact boundary', async () => {
  const {ArtemisDisplayObject} = await import('../dist/engines/artemis/display-object.js');
  const object = new ArtemisDisplayObject(revision);
  object.apply({left: 2 ** 20});
  const parent = new Float32Array([0.5, 0, 0, 0, 1, 0]);
  assert.equal(object.worldMatrix(parent)[2], 524288);
  const changed = parent.slice();
  changed[0] += 2 ** -24;
  assert.equal(object.worldMatrix(changed)[2], 524288);
  const copy = object.copy();
  copy.apply({left: 2 ** 20 + 2});
  assert.equal(copy.worldMatrix(changed)[2], 524289);
  changed[0] = 0.5 + 2 ** -23;
  assert.equal(object.worldMatrix(changed)[2], 524288.125);
  assert.equal(object.worldMatrix(parent)[2], 524288);
  const borrowed = object.worldMatrix(parent);
  borrowed.fill(0);
  parent[0] = 0.5 + 2 ** -24;
  assert.equal(object.worldMatrix(parent)[2], 524288);
  assert.equal(copy.worldMatrix(parent)[2], 524289);
  assert.throws(
    () => object.worldMatrix(new Float32Array([1, 0, 0, 0, Infinity, 0])),
    /parent matrix/,
  );
});

test('Artemis hidden leaf matrix accepts parent changes before visibility but skipped groups block propagation', async () => {
  const {layers, graphics} = await rasterFixture();
  try {
    await layers.dispatch(command('lyc', {id: 'group.child', file: 'synthetic.png'}));
    await layers.dispatch(
      command('lyprop', {id: 'group.child', visible: '0', left: String(2 ** 20)}),
    );
    await layers.dispatch(command('lyprop', {id: 'group', xscale: '50'}));
    layers.commit();
    assert.equal(graphics.drawCommitted(layers.scene).commands.length, 0);
    const child = layers.scene.entry('group.child').value;
    assert.equal(
      child.display.worldMatrix(new Float32Array([0.5 + 2 ** -24, 0, 0, 0, 1, 0]))[2],
      524288,
    );
    // Visibility does not skip the leaf's parent update in native15b440.
    await layers.dispatch(command('lyprop', {id: 'group', xscale: '75'}));
    layers.commit();
    graphics.drawCommitted(layers.scene);
    assert.equal(
      child.display.worldMatrix(new Float32Array([0.75 + 2 ** -24, 0, 0, 0, 1, 0]))[2],
      786432,
    );
    await layers.dispatch(command('lyprop', {id: 'group', visible: '0', xscale: '100'}));
    layers.commit();
    graphics.drawCommitted(layers.scene);
    // Child's cache remains at .75 because its parent's preparation callback is gated.
    assert.equal(
      child.display.worldMatrix(new Float32Array([0.75 + 2 ** -24, 0, 0, 0, 1, 0]))[2],
      786432,
    );
    await layers.dispatch(command('lyprop', {id: 'group.child', visible: '1'}));
    await layers.dispatch(command('lyprop', {id: 'group', visible: '1'}));
    layers.commit();
    const image = graphics.drawCommitted(layers.scene).commands[0];
    assert.equal(image.vertices[0], 524287);
  } finally {
    layers.close();
  }
});

test('Artemis implicit groups preserve their own accepted parent matrix without allocating GPU images', async () => {
  const {layers, graphics, prepared, invalidated} = await rasterFixture();
  try {
    await layers.dispatch(command('lyc', {id: 'outer.implicit.leaf', file: 'synthetic.png'}));
    await layers.dispatch(command('lyprop', {id: 'outer', xscale: '50'}));
    await layers.dispatch(command('lyprop', {id: 'outer.implicit.leaf', left: String(2 ** 20)}));
    layers.commit();
    const implicit = layers.scene.entry('outer.implicit').value;
    assert.equal(implicit.texture, null);
    assert.equal(prepared.length, 1);
    assert.equal(graphics.drawCommitted(layers.scene).commands[0].vertices[0], 262143);
    await layers.dispatch(
      command('lyprop', {id: 'outer', xscale: String(Math.fround((0.5 + 2 ** -24) * 100))}),
    );
    layers.commit();
    assert.equal(layers.scene.entry('outer.implicit').value, implicit);
    assert.equal(graphics.drawCommitted(layers.scene).commands[0].vertices[0], 262143);
    await layers.dispatch(
      command('lyprop', {id: 'outer', xscale: String(Math.fround((0.5 + 2 ** -23) * 100))}),
    );
    layers.commit();
    assert.equal(graphics.drawCommitted(layers.scene).commands[0].vertices[0], 262143.0625);
    assert.equal(prepared.length, 1);
    assert.equal(invalidated.length, 0);
  } finally {
    layers.close();
  }
  assert.equal(invalidated.length, 1);
});

async function captureFixture() {
  const {createArtemisOrdinaryGpuRaster} = await import('../dist/engines/artemis/gpu-raster.js');
  const fixture = await rasterFixture(createArtemisOrdinaryGpuRaster(revision), true);
  await fixture.layers.dispatch(command('lyc', {id: 'group.1', file: 'synthetic.png'}));
  await fixture.layers.dispatch(
    command('lyprop', {id: 'group', clip: '0,0,2,2', intermediate_render: '1'}),
  );
  fixture.layers.commit();
  return fixture;
}

test('Artemis intermediate groups retain GPU captures and only redraw changed committed descendants', async () => {
  const {layers, graphics, prepared, invalidated, frames} = await captureFixture();
  try {
    let list = graphics.drawCommitted(layers.scene);
    assert.deepEqual(
      list.commands.map((x) => x.kind),
      ['gpu-target', 'gpu-target', 'gpu-copy', 'triangles', 'gpu-target', 'triangles'],
    );
    assert.equal(prepared.length, 3); // Image plus capture and its background copy.
    assert.deepEqual(list.commands[1].clearColor, [0, 0, 0, 0]);
    assert.equal(list.commands[2].source, list.commands[0].surface);
    assert.equal(list.commands[3].additionalTextures[0].texture, 3);
    assert.equal(list.commands[5].texture, 2);
    list = graphics.drawCommitted(layers.scene);
    assert.deepEqual(
      list.commands.map((x) => x.kind),
      ['triangles'],
    );
    await layers.dispatch(command('lyprop', {id: 'group.1', left: '1'}));
    assert.equal(graphics.drawCommitted(layers.scene).commands.length, 1);
    layers.commit();
    assert.equal(
      graphics.drawCommitted(layers.scene).commands.filter((x) => x.kind === 'gpu-copy').length,
      1,
    );
    assert.equal(prepared.length, 3);
    assert.equal(frames.length, 4);
  } finally {
    layers.close();
  }
  assert.equal(invalidated.length, 3);
  assert.equal(new Set(invalidated).size, 3);
});

test('Artemis capture storage keeps its native format until a resize, and grows to requested dimensions', async () => {
  const {layers, graphics, prepared, invalidated} = await captureFixture();
  try {
    graphics.drawCommitted(layers.scene);
    await layers.dispatch(
      command('lyprop', {id: 'group', intermediate_render: '2', clip: '0,0,1,2'}),
    );
    layers.commit();
    let list = graphics.drawCommitted(layers.scene);
    assert.equal(list.commands.filter((x) => x.kind === 'gpu-copy').length, 1); // Still format2.
    assert.equal(prepared.length, 3);
    await layers.dispatch(command('lyprop', {id: 'group', clip: '0,0,1,3'}));
    layers.commit();
    list = graphics.drawCommitted(layers.scene);
    assert.equal(list.commands.filter((x) => x.kind === 'gpu-copy').length, 0);
    assert.deepEqual([prepared.at(-1).width, prepared.at(-1).height], [1, 3]);
    assert.equal(invalidated.length, 2);
    assert.equal(
      list.commands.filter((x) => x.kind === 'triangles')[0].blendState.alpha.source,
      'source-alpha',
    );
  } finally {
    layers.close();
  }
  assert.equal(invalidated.length, 4);
});

test('Artemis explicit group clips translate children before capture and rebase the output quad', async () => {
  const {layers, graphics} = await captureFixture();
  try {
    await layers.dispatch(
      command('lyprop', {id: 'group', clip: '1,1,1.25,1.5', left: '1', top: '0'}),
    );
    layers.commit();
    const draws = graphics
      .drawCommitted(layers.scene)
      .commands.filter((x) => x.kind === 'triangles');
    assert.deepEqual([...draws[0].vertices.slice(0, 2)], [-2, 2]);
    assert.deepEqual([...draws[1].vertices.slice(0, 2)], [-0.5, 1]);
    assert.deepEqual([...draws[1].vertices.slice(9, 11)], [0.125, 1]);
    assert.deepEqual([...draws[1].vertices.slice(16, 18)], [0.625, 0]);
  } finally {
    layers.close();
  }
});

test('Artemis capture auto bounds include zero endpoints, hidden actors and pixel centers', async () => {
  const {createArtemisOrdinaryGpuRaster} = await import('../dist/engines/artemis/gpu-raster.js');
  const {layers, graphics, prepared} = await rasterFixture(
    createArtemisOrdinaryGpuRaster(revision),
    true,
  );
  try {
    await layers.dispatch(command('lyc', {id: 'group.1', file: 'synthetic.png'}));
    await layers.dispatch(command('lyprop', {id: 'group.1', left: '2.5', top: '1', visible: '0'}));
    await layers.dispatch(command('lyprop', {id: 'group', intermediate_render: '1'}));
    layers.commit();
    let list = graphics.drawCommitted(layers.scene);
    assert.deepEqual([prepared[1].width, prepared[1].height], [5, 2]); // ceil((3.5-0)+1), (1-0)+1
    assert.deepEqual(
      list.commands.map((x) => x.kind),
      ['gpu-target', 'gpu-target', 'triangles'],
    ); // Lazy clear: no child drew.
    await layers.dispatch(
      command('lyprop', {id: 'group.1', left: '-2.5', top: '-1', visible: '1'}),
    );
    layers.commit();
    list = graphics.drawCommitted(layers.scene);
    const imageDraw = list.commands.find((x) => x.kind === 'triangles');
    assert.deepEqual([...imageDraw.vertices.slice(0, 2)], [-1, 1]); // Local origin translated by -bounds.
    assert.equal(prepared.length, 3); // Smaller bounds reuse earlier capacity.
    assert.deepEqual([...list.commands.at(-1).vertices.slice(0, 2)], [-2.25, 2]);
  } finally {
    layers.close();
  }
});

test('Artemis nested intermediate groups restore targets and snapshot each format-2 draw', async () => {
  const {layers, graphics, prepared} = await captureFixture();
  try {
    await layers.dispatch(command('lyc', {id: 'group.nested.1', file: 'synthetic.png'}));
    await layers.dispatch(
      command('lyprop', {id: 'group.nested', clip: '0,0,2,2', intermediate_render: '1'}),
    );
    layers.commit();
    const list = graphics.drawCommitted(layers.scene),
      copies = list.commands.filter((x) => x.kind === 'gpu-copy');
    assert.equal(prepared.length, 6); // Two images, two captures, two snapshots.
    assert.equal(copies.length, 3); // Direct image, nested image, nested capture into outer.
    assert.notEqual(copies[0].source, copies[1].source);
    assert.equal(copies[0].source, copies[2].source);
    assert.equal(list.commands.at(-2).surface, null);
    assert.equal(graphics.drawCommitted(layers.scene).commands.length, 1);
  } finally {
    layers.close();
  }
});

async function maskFixture() {
  const {png} = await import('./png-fixtures.mjs');
  const {createArtemisOrdinaryGpuRaster} = await import('../dist/engines/artemis/gpu-raster.js');
  const gray = (width, height) =>
    png({
      width,
      height,
      type: 0,
      raw: Buffer.concat(
        Array.from({length: height}, () => Buffer.from([0, ...Array(width).fill(200)])),
      ),
    });
  return rasterFixture(createArtemisOrdinaryGpuRaster(revision), true, undefined, {
    'gray4x3.png': gray(4, 3),
    'gray2x1.png': gray(2, 1),
    'rgba4x3.png': png({
      width: 4,
      height: 3,
      raw: Buffer.concat(Array.from({length: 3}, () => Buffer.from([0, ...Array(16).fill(200)]))),
    }),
  });
}

test('Artemis intermediate_render_mask sizes a group capture to the mask and applies only a gray mask', async () => {
  const {layers, graphics, prepared, invalidated} = await maskFixture();
  try {
    await layers.dispatch(command('lyc', {id: 'group.1', file: 'synthetic.png'}));
    await layers.dispatch(command('lyprop', {id: 'group.1', left: '1', top: '1'}));
    await layers.dispatch(
      command('lyprop', {
        id: 'group',
        left: '1',
        intermediate_render: '1',
        intermediate_render_mask: 'rgba4x3.png',
      }),
    );
    layers.commit();
    let list = graphics.drawCommitted(layers.scene);
    // The capture is the mask's size and keeps the group origin: the child at 1,1 of a
    // 4x3 target. A format 2 mask never reaches the capture layer (0x1400a4490).
    const capture = list.commands.find((x) => x.kind === 'gpu-target' && x.surface);
    assert.deepEqual([capture.surface.width, capture.surface.height], [4, 3]);
    let draws = list.commands.filter((x) => x.kind === 'triangles');
    assert.deepEqual(
      [...draws[0].vertices.slice(0, 2)].map((x) => +x.toFixed(6)),
      [-0.5, 0.333333],
    );
    assert.deepEqual([...draws[1].vertices.slice(0, 2)], [-0.5, 1]);
    assert.equal(draws[1].additionalTextures, undefined);
    assert.equal(draws[1].fragment, undefined);

    const before = prepared.length;
    await layers.dispatch(
      command('lyprop', {id: 'group', intermediate_render_mask: 'gray4x3.png'}),
    );
    layers.commit();
    list = graphics.drawCommitted(layers.scene);
    draws = list.commands.filter((x) => x.kind === 'triangles');
    assert.equal(prepared.length, before + 1); // The mask texture; the capture is reused.
    const masked = draws.at(-1);
    assert.equal(masked.additionalTextures.length, 1);
    assert.deepEqual([...masked.additionalTextures[0].uv], [0, 0, 1, 0, 0, 1, 1, 1]);
    assert.match(masked.fragment, /sampleColor\.a\*=texture\(additionalAtlas0,additionalUV0\)\.r/);

    // A failed load stores a null mask and releases the mask texture. Without a mask the
    // larger storage is kept (it is reallocated only when too small).
    const released = invalidated.length,
      uploads = prepared.length;
    await layers.dispatch(command('lyprop', {id: 'group', intermediate_render_mask: 'none.png'}));
    layers.commit();
    list = graphics.drawCommitted(layers.scene);
    draws = list.commands.filter((x) => x.kind === 'triangles');
    assert.equal(invalidated.length, released + 1);
    assert.equal(prepared.length, uploads);
    assert.equal(draws.at(-1).additionalTextures, undefined);
  } finally {
    layers.close();
  }
});

test('Artemis image layers keep a gray mask of their own size on both inner actors', async () => {
  const {layers, graphics} = await maskFixture();
  try {
    await layers.dispatch(command('lyc', {id: 'a', file: 'synthetic.png'}));
    await layers.dispatch(command('lyc', {id: 'b', file: 'gray2x1.png'}));
    layers.commit();
    // The retained actor (drawn before commit) receives the mask too.
    await layers.dispatch(command('lyprop', {id: 'a', intermediate_render_mask: 'gray2x1.png'}));
    await layers.dispatch(command('lyprop', {id: 'b', intermediate_render_mask: 'gray2x1.png'}));
    let draws = graphics.drawCommitted(layers.scene).commands;
    assert.equal(draws[0].additionalTextures.length, 1);
    assert.deepEqual([...draws[0].additionalTextures[0].uv], [0, 0, 1, 0, 0, 1, 1, 1]);
    assert.equal(draws[1].additionalTextures, undefined); // A format 0 image keeps none.
    layers.commit();
    // A mask of another size is dropped and the earlier one stays.
    await layers.dispatch(command('lyprop', {id: 'a', intermediate_render_mask: 'gray4x3.png'}));
    layers.commit();
    draws = graphics.drawCommitted(layers.scene).commands;
    assert.equal(draws[0].additionalTextures.length, 1);
    await layers.dispatch(command('lyprop', {id: 'a', intermediate_render_mask: ''}));
    layers.commit();
    draws = graphics.drawCommitted(layers.scene).commands;
    assert.equal(draws[0].additionalTextures, undefined);
  } finally {
    layers.close();
  }
});

test('Artemis lyc mask loads with the image; a missing or non-gray mask fails the creation', async () => {
  const {layers, graphics, effects} = await maskFixture();
  try {
    await layers.dispatch(command('lyc', {id: 'a', file: 'synthetic.png', mask: 'gray2x1.png'}));
    // A gray mask of another size passes the creation check; the CLayer setter drops it.
    await layers.dispatch(command('lyc', {id: 'b', file: 'synthetic.png', mask: 'gray4x3.png'}));
    layers.commit();
    let draws = graphics.drawCommitted(layers.scene).commands;
    assert.equal(draws.length, 2);
    assert.equal(draws[0].additionalTextures.length, 1);
    assert.equal(draws[1].additionalTextures, undefined);
    // Failures report the image load error and keep the earlier layer unmasked or masked.
    effects.length = 0;
    await layers.dispatch(command('lyc', {id: 'a', file: 'synthetic.png', mask: 'none.png'}));
    await layers.dispatch(command('lyc', {id: 'a', file: 'synthetic.png', mask: 'rgba4x3.png'}));
    assert.deepEqual(effects, [
      ['missing image', 'synthetic.png'],
      ['missing image', 'synthetic.png'],
    ]);
    layers.commit();
    draws = graphics.drawCommitted(layers.scene).commands;
    assert.equal(draws[0].additionalTextures.length, 1);
    // lyprop never reads `mask` (the game forwards creation arguments to it).
    await layers.dispatch(command('lyprop', {id: 'b', mask: 'gray2x1.png', left: '1'}));
    layers.commit();
    draws = graphics.drawCommitted(layers.scene).commands;
    assert.equal(draws[1].additionalTextures, undefined);
  } finally {
    layers.close();
  }
});

test('Artemis intermediate enable/disable is shared across retained holder copies, exact zero alone disables', async () => {
  const {layers, graphics, prepared, invalidated} = await captureFixture();
  try {
    graphics.drawCommitted(layers.scene);
    await layers.dispatch(command('lyprop', {id: 'group', intermediate_render: '0'}));
    assert.equal(invalidated.length, 2); // Native node effect precedes holder commit.
    assert.equal(graphics.drawCommitted(layers.scene).commands.length, 1);
    await layers.dispatch(command('lyprop', {id: 'group', intermediate_render: '00'}));
    assert.equal(
      graphics.drawCommitted(layers.scene).commands.filter((x) => x.kind === 'gpu-copy').length,
      1,
    );
    assert.equal(prepared.length, 5);
    await layers.dispatch(command('lyprop', {id: 'group.1', intermediate_render: '1'})); // Native type1 ignores it.
    layers.commit();
    assert.equal(
      graphics.drawCommitted(layers.scene).commands.filter((x) => x.kind === 'gpu-copy').length,
      1,
    );
  } finally {
    layers.close();
  }
  assert.equal(invalidated.length, 5);
});

test('Artemis empty captures preserve lazy-clear contents and empty auto bounds reuse existing capacity', async () => {
  const {layers, graphics, prepared} = await captureFixture();
  try {
    graphics.drawCommitted(layers.scene);
    await layers.dispatch(command('lydel', {id: 'group.1'}));
    await layers.dispatch(command('lyprop', {id: 'group', clip: '0,0,0,0'}));
    layers.commit();
    const list = graphics.drawCommitted(layers.scene);
    assert.deepEqual(
      list.commands.map((x) => x.kind),
      ['gpu-target', 'gpu-target', 'triangles'],
    );
    assert.equal(
      list.commands.some((x) => x.clearColor),
      false,
    );
    assert.equal(list.commands.at(-1).texture, 2);
    assert.equal(prepared.length, 3);
    assert.equal(graphics.drawCommitted(layers.scene).commands.length, 1);
  } finally {
    layers.close();
  }
});

test('Artemis failed capture presentation retries preparation and GPU allocation failures preserve the old surface', async () => {
  const {layers, graphics, prepared, target, setRejectUpload} = await captureFixture();
  try {
    const draw = target.draw;
    target.draw = () => {
      throw Error('presentation failed');
    };
    assert.throws(() => graphics.drawCommitted(layers.scene), /presentation failed/);
    target.draw = draw;
    assert.equal(
      graphics.drawCommitted(layers.scene).commands.filter((x) => x.kind === 'gpu-copy').length,
      1,
    );
    assert.equal(graphics.drawCommitted(layers.scene).commands.length, 1);
    await layers.dispatch(command('lyprop', {id: 'group', clip: '0,0,3,2'}));
    layers.commit();
    setRejectUpload(true);
    assert.throws(() => graphics.drawCommitted(layers.scene), /upload failure/);
    assert.equal(prepared.length, 3);
    setRejectUpload(false);
    assert.equal(
      graphics.drawCommitted(layers.scene).commands.filter((x) => x.kind === 'gpu-copy').length,
      1,
    );
    assert.equal(prepared.length, 5);
  } finally {
    layers.close();
  }
});

test('Artemis node capture snapshots release before child images and retained holder copies', async () => {
  const {layers, graphics, prepared, invalidated} = await captureFixture();
  graphics.drawCommitted(layers.scene);
  await layers.dispatch(command('lyprop', {id: 'group', left: '1'}));
  // Both holder slots remain reachable; native node capture storage is independent.
  await layers.dispatch(command('lydel', {id: 'group'}));
  assert.equal(invalidated.length, 0);
  layers.commit();
  assert.deepEqual(invalidated, [prepared[2], prepared[1], prepared[0]]);
  layers.close();
  assert.equal(invalidated.length, 3);
});

test('Artemis forwarded creation arguments in lyprop preserve the image and record the complete original tag', async () => {
  const {layers, graphics, prepared, effects} = await rasterFixture();
  try {
    await layers.dispatch(command('lyc', {id: '1', file: 'synthetic.png'}));
    const first = layers.scene.entry('1').value;
    await layers.dispatch(
      command('lyprop', {
        id: '1',
        file: 'does-not-load',
        width: 'invalid',
        height: '-1',
        color: 'invalid',
        rule: 'unused',
        x: '-99',
        y: '999',
        zoom: 'invalid',
        left: '1',
      }),
    );
    const copy = layers.scene.entry('1').value;
    assert.notEqual(copy, first);
    assert.equal(copy.texture, first.texture);
    assert.equal(prepared.length, 1);
    assert.equal(copy.display.properties.left, 1);
    assert.equal(copy.display.properties.top, 0);
    assert.equal(copy.display.properties.xscale, 1);
    assert.deepEqual(effects.at(-1), ['record', '1']);
    layers.commit();
    assert.equal(graphics.drawCommitted(layers.scene).commands.length, 1);
  } finally {
    layers.close();
  }
});

test('Artemis metadata-only resource owners use actual layer lifecycle without fake pixel buffers', async () => {
  const {createMetadataLayerFixture} = await import('../tools/artemis-metadata-layer-fixture.mjs');
  const {png} = await import('./png-fixtures.mjs');
  const encoded = png({width: 2, height: 1, raw: Buffer.from([0, 1, 2, 3, 255, 4, 5, 6, 128])});
  const fixture = createMetadataLayerFixture(revision, async (path) =>
    path === 'fixture.png' ? encoded : null,
  );
  try {
    await fixture.dispatch(command('lyc', {id: 'group.1', file: 'fixture'}));
    await fixture.dispatch(command('lyprop', {id: 'group.1', file: 'fixture', alpha: '128'}));
    await fixture.dispatch(command('flip'));
    const state = fixture.snapshot();
    assert.equal(state.pixelDecode, false);
    assert.equal(state.gpuPreparation, false);
    assert.equal(state.presentation, false);
    assert.deepEqual(state.loads, [
      {name: 'fixture', path: 'fixture.png', width: 2, height: 1, pixelDecode: false},
    ]);
    assert.deepEqual([state.layers[1].width, state.layers[1].height], [2, 1]);
    assert.equal(state.layers[1].properties.alpha, Math.fround(128 / 255));
    await fixture.dispatch(command('lydel', {id: 'group'}));
    await fixture.dispatch(command('flip'));
    assert.deepEqual(fixture.snapshot().layers, []);
  } finally {
    fixture.close();
  }
});

test('Artemis captures observe public display mutations without rebuilding for unchanged or parent-only state', async () => {
  const {layers, graphics, prepared} = await captureFixture();
  try {
    graphics.drawCommitted(layers.scene);
    const child = layers.scene.entry('group.1').value;
    child.display.apply({left: 1, alpha: 0.5});
    let list = graphics.drawCommitted(layers.scene);
    assert.equal(list.commands.filter((command) => command.kind === 'gpu-copy').length, 1);
    assert.equal(list.commands.find((command) => command.kind === 'triangles').vertices[6], 0.5);
    const revision = child.display.propertyRevision;
    child.display.apply({left: 1, alpha: 0.5});
    assert.equal(child.display.propertyRevision, revision);
    assert.equal(child.display.copy().propertyRevision, revision);
    assert.equal(graphics.drawCommitted(layers.scene).commands.length, 1);
    layers.scene.entry('group').value.display.apply({left: 1});
    list = graphics.drawCommitted(layers.scene);
    assert.equal(list.commands.length, 1);
    assert.equal(prepared.length, 3);
  } finally {
    layers.close();
  }
});

test('Native grayscale glyph painting preserves outline opacity, float truncation and shifted shadows', async () => {
  const {paintArtemisGrayGlyph} = await import('../dist/engines/artemis/glyph-paint.js');
  const hash = '8953562b80608046662bd8c89015d04236b0ba3afee10c36469c11403de3ebaf';
  const glyph = {width: 1, height: 1, left: 3, top: 5, advance: 2, pixels: Uint8Array.of(128)};
  const style = {
    color: 0xff0000,
    outlineColor: 0x0000ff,
    shadowColor: 0x00ff00,
    outline: 1,
    shadow: 0,
  };
  const edge = paintArtemisGrayGlyph(hash, glyph, style);
  assert.deepEqual(
    [edge.image.width, edge.image.height, edge.left, edge.top, edge.advance],
    [3, 3, 3, 5, 4],
  );
  const pixel = (surface, x, y) =>
    Array.from(
      surface.image.pixels.subarray(
        (y * surface.image.width + x) * 4,
        (y * surface.image.width + x + 1) * 4,
      ),
    );
  assert.deepEqual(pixel(edge, 0, 0), [0, 0, 255, 128]);
  assert.deepEqual(pixel(edge, 1, 1), [128, 0, 126, 255]);
  const plain = paintArtemisGrayGlyph(hash, glyph, {...style, outline: 0});
  assert.deepEqual(pixel(plain, 0, 0), [255, 0, 0, 128]);
  const shifted = paintArtemisGrayGlyph(hash, glyph, {...style, shadow: 1});
  assert.deepEqual(pixel(shifted, 1, 1), [128, 0, 126, 255]);
  assert.deepEqual(pixel(shifted, 2, 2), [0, 126, 128, 255]);
  assert.deepEqual(pixel(shifted, 3, 3), [0, 254, 0, 128]);
  const shadow = paintArtemisGrayGlyph(hash, glyph, {...style, outline: 0, shadow: 1});
  assert.deepEqual(pixel(shadow, 1, 1), [0, 254, 0, 128]);
  glyph.pixels[0] = 0;
  assert.deepEqual(pixel(edge, 1, 1), [128, 0, 126, 255]);
  assert.deepEqual(
    paintArtemisGrayGlyph(
      hash,
      {...glyph, width: 0, height: 0, advance: 10, pixels: new Uint8Array()},
      style,
    ),
    {image: null, left: 0, top: 0, advance: 12},
  );
  assert.throws(() => paintArtemisGrayGlyph(hash, glyph, {...style, outline: 33}), /edge size/);
});

test('Real native glyph worker transfers painted storage without detaching font coverage and cancels pending jobs', async () => {
  const {Worker} = await import('node:worker_threads');
  const {ArtemisGlyphPainter} = await import('../dist/engines/artemis/glyph-paint-client.js');
  const hash = '8953562b80608046662bd8c89015d04236b0ba3afee10c36469c11403de3ebaf';
  const painter = new ArtemisGlyphPainter(hash, () => {
    const raw = new Worker(new URL('./artemis-glyph-node-worker.mjs', import.meta.url));
    const host = {
      onmessage: null,
      onerror: null,
      onmessageerror: null,
      postMessage: (value, transfers) => raw.postMessage(value, transfers),
      terminate: () => raw.terminate(),
    };
    raw.on('message', (data) => host.onmessage?.({data}));
    raw.on('error', (error) => host.onerror?.(error));
    return host;
  });
  const glyph = {width: 1, height: 1, left: 0, top: 0, advance: 1, pixels: Uint8Array.of(128)},
    style = {color: 0xff0000, outlineColor: 0x0000ff, shadowColor: 0, outline: 1, shadow: 0};
  try {
    const painted = await painter.paint(glyph, style);
    assert.deepEqual(Array.from(painted.image.pixels.subarray(16, 20)), [128, 0, 126, 255]);
    assert.deepEqual(Array.from(glyph.pixels), [128]);
    await assert.rejects(painter.paint(glyph, {...style, outline: 33}), /edge size/);
    assert.equal((await painter.paint(glyph, style)).advance, 3);
    const pending = painter.paint(glyph, style);
    painter.close();
    await assert.rejects(pending, /closed/);
  } finally {
    painter.close();
  }
});

test('Native glyph decorations extend bearing bounds and paint underline on whitespace', async () => {
  const {paintArtemisGrayGlyph} = await import('../dist/engines/artemis/glyph-paint.js');
  const hash = '8953562b80608046662bd8c89015d04236b0ba3afee10c36469c11403de3ebaf';
  const metrics = {
    size: 8,
    baseline: 8,
    decorationThickness: 1,
    underlineThickness: 1,
    strikeoutPosition: 3,
    underlinePosition: 4,
  };
  const style = {
    color: 0xff0000,
    outlineColor: 0x0000ff,
    shadowColor: 0,
    outline: 0,
    shadow: 0,
    decorationMetrics: metrics,
  };
  const blank = {width: 0, height: 0, left: 9, top: 9, advance: 3, pixels: new Uint8Array()};
  const space = paintArtemisGrayGlyph(hash, blank, {...style, underline: true});
  assert.deepEqual(
    [space.image.width, space.image.height, space.left, space.top, space.advance],
    [3, 5, 0, 0, 3],
  );
  assert.deepEqual(
    Array.from(space.image.pixels.slice(-12)),
    [255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255],
  );
  assert.ok(
    space.image.pixels
      .slice(0, -12)
      .filter((_, i) => i % 4 === 3)
      .every((alpha) => alpha === 0),
  );
  const glyph = {width: 1, height: 1, left: 2, top: 5, advance: 5, pixels: Uint8Array.of(128)};
  const strike = paintArtemisGrayGlyph(hash, glyph, {...style, strikeout: true});
  assert.deepEqual(
    [strike.image.width, strike.image.height, strike.left, strike.top],
    [5, 3, 0, 3],
  );
  assert.deepEqual(Array.from(strike.image.pixels.slice(0, 4)), [255, 0, 0, 255]);
  assert.deepEqual(Array.from(strike.image.pixels.slice(48, 52)), [255, 0, 0, 128]);
  assert.throws(
    () =>
      paintArtemisGrayGlyph(hash, glyph, {...style, underline: true, decorationMetrics: undefined}),
    /require font metrics/,
  );
});

test('Native text blocks reserve ruby space, compare widths without last kerning and distribute the shorter stream', async () => {
  const {layoutArtemisTextBlock} = await import('../dist/engines/artemis/text-block.js');
  const hash = '8953562b80608046662bd8c89015d04236b0ba3afee10c36469c11403de3ebaf';
  const style = {
    size: 58,
    shadow: 0,
    outline: 1,
    rubysize: 22,
    rubyshadow: 0,
    rubyoutline: 1,
    spacetop: 0,
    spacemiddle: -16,
    spacebottom: -12,
    kerning: -1,
    rubykerning: 0,
  };
  const main = [
      {glyph: '雪', advance: 20},
      {glyph: '人', advance: 20},
    ],
    ruby = [
      {glyph: 'ゆ', advance: 5},
      {glyph: 'き', advance: 5},
    ];
  const block = layoutArtemisTextBlock(hash, main, ruby, style);
  assert.deepEqual([block.width, block.height], [38, 56]);
  assert.deepEqual(
    block.main.map((g) => [g.x, g.y, g.advance]),
    [
      [0, 8, 19],
      [19, 8, 19],
    ],
  );
  assert.deepEqual(
    block.ruby.map((g) => [g.x, g.y, g.advance]),
    [
      [Math.fround(29 / 3), 0, 5],
      [Math.fround(Math.fround(Math.fround(29 / 3) + 5) + Math.fround(29 / 3)), 0, 5],
    ],
  );
  const wider = layoutArtemisTextBlock(
    hash,
    [{glyph: 'A', advance: 5}],
    [{glyph: 'r', advance: 20}],
    {...style, kerning: 0},
  );
  assert.equal(wider.width, 20);
  assert.equal(wider.main[0].x, 7.5);
  assert.equal(wider.ruby[0].x, 0);
  const empty = layoutArtemisTextBlock(hash, [], [], style);
  assert.equal(empty.height, 56);
  assert.equal(empty.width, 0);
  const shifted = layoutArtemisTextBlock(
    hash,
    [{glyph: 'zero', advance: 0}],
    [{glyph: 'r', advance: 2}],
    {...style, kerning: 1, rubykerning: 10},
  );
  assert.equal(shifted.main[0].advance, 0);
  assert.equal(shifted.width, 12);
  assert.equal(shifted.main[0].x, 1.5); // bodyNet=-1, rubyNet=2, shorter stream centered.
  assert.equal(Object.isFrozen(block.main[0]), true);
  assert.throws(() => layoutArtemisTextBlock(hash, main, [], {...style, size: 0}), /zero-size/);
});

test('Native text lines align blocks by their reserved heights and recompute after prohibited-character transfers', async () => {
  const {ArtemisTextLine} = await import('../dist/engines/artemis/text-line.js');
  const hash = '8953562b80608046662bd8c89015d04236b0ba3afee10c36469c11403de3ebaf';
  const block = (width, height, count) =>
    Object.freeze({
      width,
      height,
      main: new Array(count).fill({advance: width, x: 0, y: 0, glyph: 'synthetic'}),
      ruby: [],
    });
  const line = new ArtemisTextLine(hash),
    a = block(10, 20, 1),
    b = block(20, 40, 2),
    c = block(5, 10, 1);
  line.append(a);
  line.append(b);
  line.append(c);
  assert.deepEqual([line.width, line.height, line.characterCount], [35, 40, 4]);
  assert.deepEqual(
    line.finalize(100, 'center', 30).blocks.map((b) => [b.x, b.y]),
    [
      [32.5, 20],
      [42.5, 0],
      [62.5, 30],
    ],
  );
  assert.deepEqual(
    line.finalize(100, 'right', 30).blocks.map((b) => b.x),
    [65, 75, 95],
  );
  assert.deepEqual(
    line.finalize(100, 'equalize', 30).blocks.map((b) => b.x),
    [0, 42.5, 95],
  );
  assert.equal(line.pop(), c);
  assert.equal(line.pop(), b);
  assert.deepEqual([line.width, line.height, line.characterCount], [10, 20, 1]);
  assert.equal(line.finalize(100, 'equalize', 30).blocks[0].x, 0);
  assert.equal(line.pop(), a);
  assert.equal(line.finalize(100, 'left', 30).height, 30);
  assert.throws(() => line.pop(), /underflow/);
  const next = new ArtemisTextLine(hash);
  next.append(c);
  next.append(b);
  assert.deepEqual(
    next.finalize(15, 'equalize', 30).blocks.map((b) => b.x),
    [0, -5],
  );
  assert.equal(next.characterCount, 3);
});

test('Native glyph block pipeline shares file faces and cached painted glyphs across normal/ruby jobs', async () => {
  const {ArtemisTextGlyphs} = await import('../dist/engines/artemis/text-glyphs.js');
  const {ArtemisFileFonts} = await import('../dist/engines/artemis/file-fonts.js');
  const {rectangleFont, createNodeFontWorker, createNodeGlyphPainter} =
    await import('./freetype-fixtures.mjs');
  const hash = '8953562b80608046662bd8c89015d04236b0ba3afee10c36469c11403de3ebaf';
  const worker = await createNodeFontWorker(),
    painter = await createNodeGlyphPainter(hash);
  let reads = 0;
  const fonts = new ArtemisFileFonts(hash, {
    readFontFile: async () => {
      reads++;
      return rectangleFont();
    },
    hasSystemFontFamily: async () => false,
    openFontFace: (bytes) => worker.open(bytes),
  });
  const loader = new ArtemisTextGlyphs(hash, fonts, painter);
  const style = {
    face: 'synthetic.ttf',
    rubyface: 'synthetic.ttf',
    size: 32,
    rubysize: 16,
    shadow: 0,
    outline: 1,
    rubyshadow: 0,
    rubyoutline: 1,
    spacetop: 0,
    spacemiddle: 0,
    spacebottom: 0,
    kerning: 0,
    rubykerning: 0,
    color: 0xff0000,
    shadowcolor: 0,
    outlinecolor: 0x0000ff,
    styleBits: 0,
  };
  try {
    const block = await loader.load('AA', 'A', style);
    assert.deepEqual([block.width, block.height], [52, 52]);
    assert.deepEqual(
      block.main.map((g) => [g.x, g.y, g.advance]),
      [
        [0, 18, 26],
        [26, 18, 26],
      ],
    );
    assert.deepEqual(
      block.ruby.map((g) => [g.x, g.y, g.advance]),
      [[19, 0, 14]],
    );
    assert.equal(block.main[0].glyph, block.main[1].glyph);
    assert.deepEqual(
      [block.main[0].glyph.surface.image.width, block.ruby[0].glyph.surface.image.width],
      [10, 6],
    );
    assert.equal(reads, 1);
    const again = await loader.load('A\0ignored', '', style);
    assert.equal(again.main[0].glyph, block.main[0].glyph);
    const pixels = block.main[0].glyph.surface.image.pixels.slice();
    // More than 512 distinct glyphs evict old entries without destroying frames.
    const distinct = Array.from({length: 512}, (_, i) => String.fromCodePoint(0x100 + i)).join('');
    await loader.load(distinct, '', style);
    assert.notEqual((await loader.load('A', '', style)).main[0].glyph, block.main[0].glyph);
    assert.deepEqual(block.main[0].glyph.surface.image.pixels, pixels);
    await loader.close();
    await loader.close();
    assert.deepEqual(block.main[0].glyph.surface.image.pixels, pixels);
    await assert.rejects(loader.load('A', '', style), /closed/);
  } finally {
    await loader.close();
    await fonts.close();
    painter.close();
    worker.close();
  }
});

test('PE32 restored atlas formats reach normal/ruby layout and missing keys use real FreeType cells', async () => {
  const {ArtemisTextGlyphs} = await import('../dist/engines/artemis/text-glyphs.js');
  const {ArtemisFileFonts} = await import('../dist/engines/artemis/file-fonts.js');
  const {fontCacheFixture} = await import('./artemis-font-cache-fixtures.mjs');
  const {rectangleFont, createNodeFontWorker, createNodeGlyphPainter} =
    await import('./freetype-fixtures.mjs');
  const revisions = await import('../dist/engines/artemis/revision.js');
  for (const [hash, layout] of [
    [revisions.ARTEMIS_2601_EXECUTABLE_SHA256, 'packed'],
    [revisions.ARTEMIS_2762_EXECUTABLE_SHA256, 'packed'],
    [revisions.ARTEMIS_2868_EXECUTABLE_SHA256, 'expanded'],
    [revisions.ARTEMIS_2898_EXECUTABLE_SHA256, 'expanded'],
    [revisions.ARTEMIS_2908_EXECUTABLE_SHA256, 'expanded'],
    [revisions.ARTEMIS_3083_EXECUTABLE_SHA256, 'expanded'],
    [revisions.ARTEMIS_3083_X64_EXECUTABLE_SHA256, 'expanded'],
  ]) {
    const files = {...fontCacheFixture({layout}), 'synthetic.ttf': rectangleFont()};
    const reads = [],
      worker = await createNodeFontWorker(),
      painter = await createNodeGlyphPainter(hash);
    let rasterJobs = 0;
    const fonts = new ArtemisFileFonts(hash, {
      readFontFile: async (path) => {
        reads.push(path);
        return files[path] ?? null;
      },
      hasSystemFontFamily: async () => false,
      openFontFace: async (bytes) => {
        const face = await worker.open(bytes);
        return {
          requestSize: (...args) => face.requestSize(...args),
          close: () => face.close(),
          rasterize: (...args) => {
            rasterJobs++;
            return face.rasterize(...args);
          },
        };
      },
    });
    const loader = new ArtemisTextGlyphs(hash, fonts, painter);
    const style = {
      face: 'synthetic.ttf',
      rubyface: 'synthetic.ttf',
      size: 32,
      rubysize: 32,
      shadow: 0,
      outline: 1,
      rubyshadow: 0,
      rubyoutline: 1,
      spacetop: 0,
      spacemiddle: 0,
      spacebottom: 0,
      kerning: 0,
      rubykerning: 0,
      color: 0xff0000,
      shadowcolor: 0,
      outlinecolor: 0x0000ff,
      styleBits: 0,
    };
    try {
      await loader.restoreFontCache('cache/');
      assert.deepEqual(reads, ['cache/0.png', 'cache/1.png', 'cache/index.dat']);
      const block = await loader.load('AA', 'A', style);
      assert.equal(rasterJobs, 0);
      assert.equal(block.main[0].advance, 2);
      assert.equal(block.ruby[0].advance, 2);
      assert.deepEqual(
        Array.from(block.main[0].glyph.surface.image.pixels),
        [10, 20, 30, 40, 50, 60, 70, 80, 130, 140, 150, 160, 170, 180, 190, 200],
      );
      assert.deepEqual(loader.restoredFontCacheStatistics(), {entries: 1, atlasBytes: 24, hits: 1});
      const miss = await loader.load('A', '', {...style, color: 0xffffff});
      assert.equal(rasterJobs, 1);
      assert.equal(miss.main[0].advance, 26); // 0.75 * 32 cell advance + two 1px outlines.
      assert.deepEqual(
        [miss.main[0].glyph.surface.image.width, miss.main[0].glyph.surface.image.height],
        [26, 34],
      );
      assert.deepEqual([miss.main[0].glyph.surface.left, miss.main[0].glyph.surface.top], [0, 0]);
      files['cache/index.dat'] = fontCacheFixture({layout, clip: [0, 0, 0, 0]})['cache/index.dat'];
      await loader.restoreFontCache('cache/');
      const replaced = await loader.load('A', '', style);
      assert.equal(replaced.main[0].advance, 1);
      await loader.load('A', '', {...style, color: 0xffffff});
      assert.equal(rasterJobs, 1); // An unrelated generated key survives another restore.
      const byteSize = await loader.load('A', '', {...style, size: 300});
      assert.deepEqual(
        [byteSize.main[0].glyph.surface.image.width, byteSize.main[0].glyph.surface.image.height],
        [35, 46],
      ); // Provider size 300 & 255 = 44.
      // Existing insertion blocks retain independent glyph storage through a later restore.
      assert.equal(block.main[0].glyph.surface.image.width, 2);
    } finally {
      await loader.close();
      await fonts.close();
      painter.close();
      worker.close();
    }
  }
});

test('Rev.2601 compact cache keys retain native byte-size and decoration bits without cross-key hits', async () => {
  const {ArtemisRestoredFontCache} = await import('../dist/engines/artemis/font-cache.js');
  const {ARTEMIS_2601_EXECUTABLE_SHA256: hash} =
    await import('../dist/engines/artemis/revision.js');
  const {fontCacheFixture} = await import('./artemis-font-cache-fixtures.mjs');
  // Native ushort: size 44, underline/strike/shadow/outline = 0x3c; character A.
  const files = fontCacheFixture({layout: 'packed', packedKey: 0x3c2c0041});
  const cache = new ArtemisRestoredFontCache(hash, async (path) => files[path] ?? null);
  const key = {
    face: 'synthetic.ttf',
    size: 44,
    shadow: 1,
    outline: 1,
    color: 0xff0000,
    shadowColor: 0,
    outlineColor: 0x0000ff,
    style: 24,
    codePoint: 65,
  };
  try {
    await cache.restore('cache/');
    assert.equal(cache.get(key).advance, 2);
    assert.equal(cache.has({...key, size: 300}), true);
    for (const changed of [
      {size: 45},
      {shadow: 0},
      {outline: 0},
      {style: 8},
      {style: 16},
      {style: 25},
      {codePoint: 66},
      {color: 0xffffff},
    ])
      assert.equal(cache.has({...key, ...changed}), false);
  } finally {
    cache.close();
  }
});

test('Native glyph pipeline validates before allocation, retries failed paint and cancels pending results', async () => {
  const {ArtemisTextGlyphs} = await import('../dist/engines/artemis/text-glyphs.js');
  const {ArtemisFileFonts} = await import('../dist/engines/artemis/file-fonts.js');
  const {rectangleFont, createNodeFontWorker, createNodeGlyphPainter} =
    await import('./freetype-fixtures.mjs');
  const hash = '8953562b80608046662bd8c89015d04236b0ba3afee10c36469c11403de3ebaf';
  const worker = await createNodeFontWorker(),
    painter = await createNodeGlyphPainter(hash);
  let reads = 0,
    paints = 0,
    fail = true,
    gate,
    started;
  const fonts = new ArtemisFileFonts(hash, {
    readFontFile: async () => {
      reads++;
      return rectangleFont();
    },
    hasSystemFontFamily: async () => false,
    openFontFace: (bytes) => worker.open(bytes),
  });
  const loader = new ArtemisTextGlyphs(hash, fonts, {
    paint: async (...args) => {
      paints++;
      if (fail) {
        fail = false;
        throw Error('injected painter failure');
      }
      started?.();
      if (gate) await gate;
      return painter.paint(...args);
    },
  });
  const style = {
    face: 'synthetic.ttf',
    rubyface: 'synthetic.ttf',
    size: 32,
    rubysize: 16,
    shadow: 0,
    outline: 0,
    rubyshadow: 0,
    rubyoutline: 0,
    spacetop: 0,
    spacemiddle: 0,
    spacebottom: 0,
    kerning: 0,
    rubykerning: 0,
    color: 0xff0000,
    shadowcolor: 0,
    outlinecolor: 0,
    styleBits: 0,
  };
  try {
    await assert.rejects(loader.load('A', '\ud800', style), /UTF-8/);
    await assert.rejects(loader.load('A', '', {...style, size: NaN}), /block integer/);
    assert.equal(reads, 0);
    const empty = await loader.load('A', '', {...style, size: 0, rubysize: 0});
    assert.equal(empty.main.length, 0);
    assert.equal(reads, 0);
    await assert.rejects(loader.load('A', '', style), /injected painter failure/);
    const [block, concurrent] = await Promise.all([
      loader.load('A', '', style),
      loader.load('A', '', style),
    ]);
    assert.equal(block.main[0].glyph, concurrent.main[0].glyph);
    assert.equal(paints, 2);
    assert.equal(reads, 1);
    assert.equal((await loader.load('A', '', style)).main[0].glyph, block.main[0].glyph);
    let release;
    gate = new Promise((resolve) => {
      release = resolve;
    });
    const begun = new Promise((resolve) => {
      started = resolve;
    });
    const pending = loader.load('A', '', {...style, color: 0x00ff00});
    const rejected = assert.rejects(pending, /closed/);
    await begun;
    await loader.close();
    release();
    await rejected;
    assert.equal(block.main[0].glyph.surface.image.pixels[0], 255);
  } finally {
    await loader.close();
    await fonts.close();
    painter.close();
    worker.close();
  }
});

test('Native glyph blocks overlap font and paint jobs in a bounded window and keep glyph order', async () => {
  const {ArtemisTextGlyphs} = await import('../dist/engines/artemis/text-glyphs.js');
  const {ArtemisFileFonts} = await import('../dist/engines/artemis/file-fonts.js');
  const {rectangleFont, createNodeFontWorker, createNodeGlyphPainter} =
    await import('./freetype-fixtures.mjs');
  const hash = '8953562b80608046662bd8c89015d04236b0ba3afee10c36469c11403de3ebaf';
  const worker = await createNodeFontWorker(),
    painter = await createNodeGlyphPainter(hash);
  const fonts = new ArtemisFileFonts(hash, {
    readFontFile: async () => rectangleFont(),
    hasSystemFontFamily: async () => false,
    openFontFace: (bytes) => worker.open(bytes),
  });
  let active = 0,
    peak = 0;
  const loader = new ArtemisTextGlyphs(hash, fonts, {
    paint: async (...args) => {
      peak = Math.max(peak, ++active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return await painter.paint(...args);
      } finally {
        active--;
      }
    },
  });
  const text = Array.from({length: 40}, (_, i) => String.fromCodePoint(0x4e00 + i)).join('');
  try {
    const block = await loader.load(text, '', {
      face: 'synthetic.ttf',
      rubyface: 'synthetic.ttf',
      size: 32,
      rubysize: 0,
      shadow: 0,
      outline: 0,
      rubyshadow: 0,
      rubyoutline: 0,
      spacetop: 0,
      spacemiddle: 0,
      spacebottom: 0,
      kerning: 0,
      rubykerning: 0,
      color: 0xffffff,
      shadowcolor: 0,
      outlinecolor: 0,
      styleBits: 0,
    });
    assert.deepEqual(
      block.main.map((g) => g.glyph.codePoint),
      Array.from(text, (c) => c.codePointAt(0)),
    );
    assert.ok(peak > 1 && peak <= 16, `paint jobs in flight: ${peak}`);
  } finally {
    await loader.close();
    await fonts.close();
    painter.close();
    worker.close();
  }
});

test('Native UTF-8 print runs preserve ASCII words, explicit wordparts and overflow byte offsets', async () => {
  const {artemisUtf8TextRuns} = await import('../dist/engines/artemis/text-runs.js');
  const hash = '8953562b80608046662bd8c89015d04236b0ba3afee10c36469c11403de3ebaf';
  const source = 'AbZ あいう12\n😀cd\0ignored';
  const runs = artemisUtf8TextRuns(hash, source);
  assert.deepEqual(
    runs.map((r) => r.text),
    ['AbZ', ' ', 'あ', 'い', 'う', '1', '2', '\n', '😀', 'cd'],
  );
  const bytes = new TextEncoder().encode(source.split('\0')[0]);
  for (const run of runs)
    assert.equal(new TextDecoder().decode(bytes.slice(run.utf8Start, run.utf8End)), run.text);
  assert.equal(runs.at(-1).utf8End, bytes.length);
  assert.deepEqual(
    artemisUtf8TextRuns(hash, 'abあい😀うZ', ['あ', 'い', '😀', 'あ']).map((r) => r.text),
    ['a', 'b', 'あい😀', 'う', 'Z'],
  );
  assert.deepEqual(
    artemisUtf8TextRuns(hash, 'A'.repeat(1024)).map((r) => r.text.length),
    [1023, 1],
  );
  assert.deepEqual(
    artemisUtf8TextRuns(hash, 'あ'.repeat(342), ['あ']).map((r) => r.utf8End - r.utf8Start),
    [1023, 3],
  );
  assert.throws(() => artemisUtf8TextRuns(hash, '😀'.repeat(256), ['😀']), /partial UTF-8/);
  assert.throws(() => artemisUtf8TextRuns(hash, '\ud800'), /UTF-8/);
  assert.throws(() => artemisUtf8TextRuns(hash, 'A', ['ab']), /wordparts/);
  assert.equal(Object.isFrozen(runs), true);
  assert.equal(Object.isFrozen(runs[0]), true);
  assert.deepEqual(artemisUtf8TextRuns(hash, ''), []);
});

test('Native unindented wrapping transfers prohibited blocks, permits hanging and preserves overflow mutation', async () => {
  const {ArtemisUnindentedTextWrapping} = await import('../dist/engines/artemis/text-wrapping.js');
  const hash = '8953562b80608046662bd8c89015d04236b0ba3afee10c36469c11403de3ebaf';
  const style = {width: 20, height: 40, lineHeight: 10, align: 'left', hung: false};
  const block = (
    name,
    width = 10,
    height = 10,
    headProhibited = false,
    footProhibited = false,
  ) => ({
    block: {width, height, main: [{glyph: name, advance: width, x: 0, y: 0}], ruby: []},
    headProhibited,
    footProhibited,
  });
  const names = (text) =>
    text.finalize().map((line) => line.geometry.blocks.map((b) => b.block.main[0].glyph));
  const text = new ArtemisUnindentedTextWrapping(hash, style);
  assert.equal(text.append(block('a')), 'ok');
  text.append(block('(', 10, 10, false, true));
  text.append(block('b'));
  assert.deepEqual(names(text), [['a'], ['(', 'b']]);
  assert.deepEqual(
    text.finalize().map((line) => line.y),
    [0, 10],
  );
  const head = new ArtemisUnindentedTextWrapping(hash, style);
  head.append(block('a'));
  head.append(block('b'));
  head.append(block(')', 10, 10, true));
  assert.deepEqual(names(head), [['a'], ['b', ')']]);
  const hung = new ArtemisUnindentedTextWrapping(hash, {...style, hung: true});
  hung.append(block('a'));
  hung.append(block('b'));
  hung.append(block(')', 10, 10, true));
  assert.deepEqual(names(hung), [['a', 'b', ')']]);
  assert.equal(hung.finalize()[0].geometry.width, 30);
  hung.append(block(']', 10, 10, true));
  // Head transfers recurse before the new line hangs the final punctuation.
  assert.deepEqual(names(hung), [['a'], ['b', ')', ']']]);
  const overflow = new ArtemisUnindentedTextWrapping(hash, {...style, height: 10});
  overflow.append(block('a'));
  overflow.append(block('b'));
  assert.equal(overflow.append(block('c')), 'overflow');
  assert.deepEqual(names(overflow), [['a', 'b'], []]);
  assert.equal(overflow.append(block('wide', 21)), 'unprintable');
  assert.deepEqual(names(overflow), [['a', 'b'], []]);
  const explicitHead = new ArtemisUnindentedTextWrapping(hash, style);
  explicitHead.append(block('a'));
  explicitHead.append(block('b'));
  explicitHead.newline();
  explicitHead.append(block(')', 10, 10, true));
  assert.deepEqual(names(explicitHead), [['a'], ['b', ')']]);
  const newline = new ArtemisUnindentedTextWrapping(hash, style);
  newline.newline();
  newline.newline();
  assert.deepEqual(
    newline.finalize().map((line) => line.y),
    [0, 10, 20],
  );
  assert.deepEqual(
    newline.finalize().map((line) => line.wrapped),
    [false, false, false],
  );
});

test('Native block flags classify whole single-character main streams and suppress prohibition after newline', async () => {
  const {artemisUtf8TextBlockFlags: flags} =
    await import('../dist/engines/artemis/text-block-flags.js');
  const {artemisUtf8Prohibition} = await import('../dist/engines/artemis/text-break-controls.js');
  const hash = '8953562b80608046662bd8c89015d04236b0ba3afee10c36469c11403de3ebaf';
  const state = {
    ...artemisUtf8Prohibition(new Set(), new Set()),
    indentPairs: new Map([['「', '」']]),
    indentClosing: '」',
    afterExplicitNewline: false,
  };
  assert.equal(flags(hash, '」', state).bits, 9);
  assert.equal(flags(hash, '「', state).bits, 6);
  assert.equal(flags(hash, '」', {...state, afterExplicitNewline: true}).bits, 8);
  assert.equal(flags(hash, '「', {...state, afterExplicitNewline: true}).bits, 4);
  assert.equal(flags(hash, '「abc」', state).bits, 0);
  assert.equal(flags(hash, '', state).bits, 0);
  assert.equal(flags(hash, '」\0ignored', state).bits, 9);
  assert.equal(flags(hash, '😀', {...state, head: new Set(['😀'])}).bits, 1);
  assert.equal(flags(hash, '「', {...state, indentClosing: '「'}).bits, 6);
  assert.throws(() => flags(hash, '\ud800', state), /UTF-8/);
  assert.equal(Object.isFrozen(flags(hash, '」', state)), true);
});

async function nativeInsertionFixture() {
  const {ArtemisTextInsertion} = await import('../dist/engines/artemis/text-insertion.js');
  const {ArtemisTextGlyphs} = await import('../dist/engines/artemis/text-glyphs.js');
  const {ArtemisFileFonts} = await import('../dist/engines/artemis/file-fonts.js');
  const {rectangleFont, createNodeFontWorker, createNodeGlyphPainter} =
    await import('./freetype-fixtures.mjs');
  const hash = '8953562b80608046662bd8c89015d04236b0ba3afee10c36469c11403de3ebaf';
  const worker = await createNodeFontWorker(),
    painter = await createNodeGlyphPainter(hash);
  const fonts = new ArtemisFileFonts(hash, {
    readFontFile: async () => rectangleFont(),
    hasSystemFontFamily: async () => false,
    openFontFace: (bytes) => worker.open(bytes),
  });
  const glyphs = new ArtemisTextGlyphs(hash, fonts, painter);
  const style = {
    face: 'synthetic.ttf',
    rubyface: 'synthetic.ttf',
    size: 32,
    rubysize: 16,
    shadow: 0,
    outline: 0,
    rubyshadow: 0,
    rubyoutline: 0,
    spacetop: 0,
    spacemiddle: 0,
    spacebottom: 0,
    kerning: 0,
    rubykerning: 0,
    styleBits: 0,
    color: 0xff0000,
    shadowcolor: 0,
    outlinecolor: 0,
    width: 48,
    height: 104,
    align: 'left',
    hung: false,
    vertical: false,
  };
  const owners = [],
    frames = [];
  return {
    hash,
    style,
    glyphs,
    frames,
    owner: (patch = {}, load = (main, ruby, style) => glyphs.load(main, ruby, style)) => {
      const owner = new ArtemisTextInsertion(
        hash,
        {...style, ...patch},
        {
          loadBlock: load,
          publishFrame: async (frame) => {
            frames.push(frame);
          },
        },
      );
      owners.push(owner);
      return owner;
    },
    close: async () => {
      owners.forEach((owner) => owner.close());
      await glyphs.close();
      await fonts.close();
      painter.close();
      worker.close();
    },
  };
}

test('Native insertion owns actual glyph blocks, counts and UTF-8 overflow cursors through print history', async () => {
  const fixture = await nativeInsertionFixture();
  const {ArtemisPrint} = await import('../dist/engines/artemis/print.js');
  const enc = new TextEncoder();
  try {
    const owner = fixture.owner();
    assert.deepEqual(await owner.insert(enc.encode('A\nA\nA')), {result: -2, consumedBytes: 4});
    assert.deepEqual(owner.measure(), {width: 24, height: 96, lineWidth: 0});
    const frame = await owner.prepareFrame();
    assert.equal(frame.glyphCount, 2);
    assert.deepEqual(
      frame.lines.slice(0, 2).map((l) => l.geometry.blocks[0].block.main[0].glyph.glyphId),
      [0, 1],
    );
    assert.equal(
      frame.lines[0].geometry.blocks[0].block.main[0].glyph.surface,
      frame.lines[1].geometry.blocks[0].block.main[0].glyph.surface,
    );
    assert.equal(frame.lines.at(-1).geometry.height, 0);
    const closedRows = fixture.owner();
    await closedRows.insert(enc.encode('A\n'));
    assert.deepEqual(closedRows.measure(), {width: 24, height: 48, lineWidth: 0});
    closedRows.setStyle({...fixture.style, width: 96, align: 'right'});
    const emptyCurrent = await closedRows.prepareFrame();
    assert.equal(emptyCurrent.lines[0].geometry.blocks[0].x, 0);
    assert.equal(emptyCurrent.lines[1].geometry.height, 0);
    await closedRows.insert(enc.encode('A'));
    const newCurrent = await closedRows.prepareFrame();
    assert.deepEqual(
      newCurrent.lines.map((line) => line.geometry.blocks[0].x),
      [0, 72],
    );
    assert.deepEqual(
      frame.lines.map((line) => [line.y, line.geometry.characterCount]),
      [
        [0, 1],
        [48, 1],
        [96, 0],
      ],
    );
    assert.equal(frame.lines[0].geometry.blocks[0].block.main[0].glyph.surface.image.width, 8);
    const changed = fixture.owner();
    await changed.insert(enc.encode('A'));
    changed.setStyle({...fixture.style, size: 48, width: 96, height: 400});
    assert.deepEqual(await changed.insert(enc.encode('A')), {result: 2, consumedBytes: 1});
    const resized = await changed.prepareFrame();
    assert.deepEqual(
      resized.lines[0].geometry.blocks.map((b) => b.block.main[0].glyph.surface.image.width),
      [8, 12],
    );
    const overflow = fixture.owner({height: 48}),
      history = [],
      queued = [];
    let overflowed = 0;
    const print = new ArtemisPrint(fixture.hash, {
      currentMessageLayer: () => 'message',
      rubyActive: () => false,
      debugSkipActive: () => false,
      print: (_layer, bytes) => overflow.insert(bytes),
      appendRubyBytes: () => assert.fail('unexpected ruby'),
      fontOverflowPolicy: () => 0,
      writeOverflowed: (value) => {
        overflowed = value;
      },
      reportPrintError: () => {},
      enqueue: (tag) => queued.push(tag),
      recordPrintCommand: (_layer, tag) => history.push(tag),
    });
    await print.dispatch({
      kind: 'tag',
      name: 'print',
      sourceLine: 7,
      args: new Map([['data', 'A\n😀']]),
    });
    assert.equal(overflowed, 1);
    assert.equal(history[0].args.get('data'), 'A\n');
    assert.deepEqual(
      queued.map((tag) => tag.name),
      ['@', 'rp', 'print'],
    );
    assert.equal(queued[2].args.get('data'), '😀');
    assert.equal(overflow.glyphCount, 1);
    const bom = fixture.owner();
    assert.deepEqual(await bom.insert(enc.encode('\ufeffA')), {result: 2, consumedBytes: 4});
    await assert.rejects(bom.insert(Uint8Array.of(0xff)), /encoded|encoding/);
    const wide = fixture.owner({width: 20});
    assert.deepEqual(await wide.insert(enc.encode('A')), {result: -1, consumedBytes: 0});
    assert.equal(wide.glyphCount, 0);
  } finally {
    await fixture.close();
  }
});

test('Native insertion cancels pending resources while already published frames remain owned', async () => {
  const fixture = await nativeInsertionFixture();
  let release, started, gate;
  const begun = new Promise((resolve) => {
    started = resolve;
  });
  const owner = fixture.owner({}, async (...args) => {
    const block = await fixture.glyphs.load(...args);
    if (gate) {
      started();
      await gate;
    }
    return block;
  });
  try {
    const bytes = new TextEncoder().encode('A');
    const first = owner.insert(bytes);
    bytes[0] = 66;
    await first;
    const frame = await owner.prepareFrame(),
      glyph = frame.lines[0].geometry.blocks[0].block.main[0].glyph;
    assert.equal(glyph.codePoint, 65);
    const pixels = glyph.surface.image.pixels.slice();
    gate = new Promise((resolve) => {
      release = resolve;
    });
    const pending = owner.insert(new TextEncoder().encode('A'));
    const rejection = assert.rejects(pending, /cancelled/);
    await begun;
    assert.throws(() => owner.setStyle(fixture.style), /Overlapping/);
    owner.close();
    release();
    await rejection;
    await fixture.glyphs.close();
    assert.deepEqual(glyph.surface.image.pixels, pixels);
    await assert.rejects(owner.prepareFrame(), /closed/);
  } finally {
    await fixture.close();
  }
});

test('Rev.3257 unindent clamps pops, clears for any negative count and keeps existing geometry', async () => {
  const {ArtemisTextWrapping} = await import('../dist/engines/artemis/text-wrapping.js');
  const {ARTEMIS_3257_EXECUTABLE_SHA256: hash} =
    await import('../dist/engines/artemis/revision.js');
  const wrap = new ArtemisTextWrapping(hash, {
    width: 100,
    height: 100,
    lineHeight: 10,
    align: 'left',
    hung: false,
  });
  wrap.setIndentation({
    pairs: new Map([
      ['[', ']'],
      ['(', ')'],
    ]),
    range: 0,
    logicalRange: false,
    nest: true,
  });
  const add = (text) =>
    wrap.append({
      text,
      opensIndent: true,
      headProhibited: false,
      footProhibited: false,
      block: {width: 10, height: 10, main: [{glyph: text, advance: 10, x: 0, y: 0}], ruby: []},
    });
  add('[');
  add('(');
  assert.equal(wrap.indentationDepth, 2);
  const before = wrap.prepareFrame();
  wrap.unindent(0);
  assert.equal(wrap.indentationDepth, 2);
  wrap.unindent(1);
  assert.equal(wrap.indentationDepth, 1);
  assert.equal(wrap.indentClosing, ']');
  assert.deepEqual(wrap.prepareFrame(), before);
  wrap.unindent(5);
  assert.equal(wrap.indentationDepth, 0);
  add('[');
  add('(');
  wrap.unindent(-7);
  assert.equal(wrap.indentationDepth, 0);
  assert.throws(() => wrap.unindent(1.5), /Invalid/);
  wrap.dispose();
});

test('Native indentation keeps paired width stacks, one-level wrap pops and physical/logical range counts', async () => {
  const {ArtemisTextWrapping} = await import('../dist/engines/artemis/text-wrapping.js');
  const {artemisUtf8TextBlockFlags: flags} =
    await import('../dist/engines/artemis/text-block-flags.js');
  const hash = '8953562b80608046662bd8c89015d04236b0ba3afee10c36469c11403de3ebaf';
  const pairs = new Map([
    ['[', ']'],
    ['(', ')'],
  ]);
  const make = (width = 30, patch = {}) => {
    const wrap = new ArtemisTextWrapping(hash, {
      width,
      height: 1000,
      lineHeight: 10,
      align: 'left',
      hung: false,
    });
    wrap.setIndentation({pairs, range: 0, logicalRange: false, nest: true, ...patch});
    return {
      wrap,
      add: (text, width = 10) =>
        wrap.append({
          text,
          block: {width, height: 10, main: [{glyph: text, advance: width, x: 0, y: 0}], ruby: []},
          ...flags(hash, text, {
            head: new Set([' ']),
            foot: new Set([' ']),
            indentPairs: pairs,
            indentClosing: wrap.indentClosing,
            afterExplicitNewline: false,
          }),
        }),
    };
  };
  const nested = make();
  nested.add('[');
  nested.add('(');
  nested.add('A');
  assert.equal(nested.wrap.indentationDepth, 2);
  nested.add('B', 20);
  assert.equal(nested.wrap.indentationDepth, 1);
  const moved = nested.wrap.prepareFrame();
  assert.equal(moved[1].geometry.blocks.length, 1);
  assert.equal(moved[1].geometry.blocks[0].block.main[0].glyph, 'B');
  assert.equal(moved[1].geometry.width, 20);
  nested.add(']');
  assert.equal(nested.wrap.indentationDepth, 0);
  const retained = make();
  retained.add('[');
  retained.add('A');
  retained.add('B');
  retained.add('C');
  const rows = retained.wrap.prepareFrame();
  assert.equal(rows[1].geometry.blocks[0].block.main.length, 0);
  assert.equal(rows[1].geometry.blocks[0].block.width, 10);
  assert.equal(rows[1].geometry.characterCount, 1);
  assert.equal(rows[1].geometry.blocks[1].x, 10);
  for (const logicalRange of [false, true]) {
    const range = make(20, {range: 2, logicalRange});
    range.add('[');
    range.add('(');
    range.add('A');
    range.add('(');
    assert.equal(range.wrap.indentationDepth, logicalRange ? 1 : 2);
    assert.equal(range.wrap.prepareFrame()[1].wrapped, true);
  }
  const logicalNewline = make(30, {range: 1, logicalRange: true});
  logicalNewline.add('[');
  logicalNewline.add('A');
  logicalNewline.wrap.newline();
  logicalNewline.add('(');
  assert.equal(logicalNewline.wrap.indentationDepth, 2);
  const nonnest = make(40, {nest: false});
  nonnest.add('[');
  nonnest.add('(');
  assert.equal(nonnest.wrap.indentationDepth, 1);
  nonnest.add(')');
  assert.equal(nonnest.wrap.indentationDepth, 1);
  nonnest.add(']');
  assert.equal(nonnest.wrap.indentationDepth, 0);
});

test('Native glyph insertion preserves active indentation across config replacement and explicit newlines', async () => {
  const fixture = await nativeInsertionFixture();
  try {
    const owner = fixture.owner({width: 96, height: 400});
    owner.setWordParts(new Set(['^']));
    owner.setIndentation({pairs: new Map([['A', 'B']]), range: 0, logicalRange: true, nest: true});
    assert.deepEqual(await owner.insert(new TextEncoder().encode('A\nA\nB')), {
      result: 3,
      consumedBytes: 5,
    });
    const nested = await owner.prepareFrame();
    assert.deepEqual(
      nested.lines.map((line) => line.geometry.blocks[0].block.width),
      [24, 24, 48],
    );
    assert.deepEqual(
      nested.lines.map((line) => line.geometry.characterCount),
      [1, 1, 1],
    );
    owner.setIndentation({pairs: new Map(), range: 0, logicalRange: false, nest: false});
    await owner.insert(new TextEncoder().encode('B\nA'));
    const closed = await owner.prepareFrame();
    assert.equal(closed.glyphCount, 5);
    // The actual .notdef advance for B wraps once before closing the outer level.
    assert.equal(closed.lines[3].geometry.blocks[0].block.main.length, 0);
    assert.equal(closed.lines.at(-1).geometry.blocks.length, 1);
    assert.equal(closed.lines.at(-1).geometry.blocks[0].block.width, 24);
  } finally {
    await fixture.close();
  }
});

test('Native logical text copies retain glyph ids/pixels while line and indentation mutations are independent', async () => {
  const fixture = await nativeInsertionFixture();
  let copied;
  try {
    const source = fixture.owner({width: 96, height: 400});
    source.setWordParts(new Set(['^']));
    source.setIndentation({
      pairs: new Map([['A', 'B']]),
      range: 0,
      logicalRange: false,
      nest: true,
    });
    await source.insert(new TextEncoder().encode('A\nA'));
    const original = await source.prepareFrame();
    copied = source.copy({
      loadBlock: (...args) => fixture.glyphs.load(...args),
      publishFrame: async (frame) => {
        fixture.frames.push(frame);
      },
    });
    const retained = await copied.prepareFrame();
    const oldGlyph = original.lines[0].geometry.blocks[0].block.main[0].glyph,
      newGlyph = retained.lines[0].geometry.blocks[0].block.main[0].glyph;
    assert.notEqual(newGlyph, oldGlyph);
    assert.equal(newGlyph.glyphId, oldGlyph.glyphId);
    assert.equal(newGlyph.surface, oldGlyph.surface);
    source.close();
    assert.deepEqual(await copied.insert(new TextEncoder().encode('B\nB\nA')), {
      result: 5,
      consumedBytes: 5,
    });
    const changed = await copied.prepareFrame();
    assert.equal(changed.lines.at(-1).geometry.blocks.length, 1);
    assert.equal(changed.lines.at(-1).geometry.blocks[0].block.main[0].glyph.glyphId, 4);
    assert.equal(original.glyphCount, 2);
    assert.equal(original.lines.length, 2);
    assert.equal(original.lines[1].geometry.blocks.length, 2);
    const pixels = oldGlyph.surface.image.pixels.slice();
    copied.close();
    await fixture.glyphs.close();
    assert.deepEqual(oldGlyph.surface.image.pixels, pixels);
  } finally {
    copied?.close();
    await fixture.close();
  }
});

test('Native font defaults preserve historical face bytes and keep overflow outside attribute snapshots', async () => {
  const {artemisDefaultFontAttributes: defaults, artemisPatchFontAttributes: patch} =
    await import('../dist/engines/artemis/font-state.js');
  const {ArtemisGlyphRenderer} = await import('../dist/engines/artemis/text-glyphs.js');
  const fixture = await nativeInsertionFixture();
  try {
    const original = defaults(fixture.hash);
    assert.equal(Object.keys(original).length, 37);
    assert.deepEqual(
      [original.size, original.rubysize, original.width, original.height, original.hung],
      [24, 8, 640, 480, true],
    );
    assert.equal(
      new TextDecoder('shift_jis').decode(Uint8Array.from(original.face)),
      'ＭＳ ゴシック',
    );
    assert.equal(Object.isFrozen(original.face), true);
    const next = patch(
      fixture.hash,
      original,
      new Map([
        ['face', 'synthetic.ttf'],
        ['size', '32'],
        ['overflow', '1'],
        ['alpha', '128'],
      ]),
    );
    assert.equal(next.overflow, 1);
    assert.equal('overflow' in next.font, false);
    assert.equal(next.font.alpha, Math.fround(128 / 255));
    assert.equal(original.alpha, 1);
    assert.deepEqual(
      (await fixture.glyphs.load('A', '', next.font)).main.map((g) => g.glyph.codePoint),
      [65],
    );
    await assert.rejects(fixture.glyphs.load('A', '', original), /legacy\/system/);
    // A layer renderer that never opened a face prints empty, zero-advance characters; once a
    // face opened, the renderer keeps that previous provider instead.
    const renderer = new ArtemisGlyphRenderer();
    const empty = await fixture.glyphs.load('AB', '', original, renderer);
    assert.deepEqual(
      empty.main.map((g) => [g.glyph.codePoint, g.advance, g.glyph.surface.image]),
      [
        [65, 0, null],
        [66, 0, null],
      ],
    );
    const opened = await fixture.glyphs.load('A', '', next.font, renderer);
    const kept = await fixture.glyphs.load('A', '', original, renderer);
    assert.equal(kept.main[0].advance, opened.main[0].advance);
    assert.notEqual(kept.main[0].glyph.surface.image, null);
    // An unused legacy ruby face must not prevent actual normal text insertion.
    assert.equal(next.font.rubyface, original.rubyface);
  } finally {
    await fixture.close();
  }
});

test('setFont falls back from a missing font file to a rendered font, then keeps the previous provider', async () => {
  const {ArtemisTextGlyphs, ArtemisGlyphRenderer} =
    await import('../dist/engines/artemis/text-glyphs.js');
  const {ArtemisFileFonts} = await import('../dist/engines/artemis/file-fonts.js');
  const {rectangleFont, createNodeFontWorker, createNodeGlyphPainter} =
    await import('./freetype-fixtures.mjs');
  const {png} = await import('./png-fixtures.mjs');
  const {rft} = await import('./artemis-rft-fixtures.mjs');
  const fixture = await nativeInsertionFixture();
  const hash = fixture.hash;
  const worker = await createNodeFontWorker(),
    painter = await createNodeGlyphPainter(hash);
  const gray = (width, height) =>
    png({
      width,
      height,
      type: 0,
      raw: Buffer.concat(
        Array.from({length: height}, () => Buffer.from([0, ...Array(width).fill(200)])),
      ),
    });
  const ini = (charset) =>
    `[FONT]\r\nCOLOR_32 = 0\r\nCHARSET = ${charset} \r\nSTRIKEOUT_SIZE=2\r\n` +
    'STRIKEOUT_POSITION = 9\r\nUNDERSCORE_SIZE=1\r\nUNDERSCORE_POSITION=14\r\n';
  const files = new Map([
    ['a.ttf', rectangleFont()],
    [
      'r.ttf_16.rft',
      rft({
        ini: ini('UTF-8'),
        entries: new Map([
          [0x41, gray(6, 16)],
          [0x42, Buffer.alloc(0)],
        ]),
      }),
    ],
    // The file layer also tries the name with a second `.rft`; rft0 has no settings entry.
    ['j.ttf_16.rft.rft', rft({version: 0, entries: new Map([[0x41, gray(5, 16)]])})],
    ['x.ttf_16.rft', new Uint8Array(4)],
    [
      'c.ttf_16.rft',
      rft({ini: '[FONT]\nCOLOR_32=1\nCHARSET=UTF-8\n', entries: new Map([[0x41, gray(6, 16)]])}),
    ],
  ]);
  const reads = [];
  const fonts = new ArtemisFileFonts(hash, {
    readFontFile: async (path) => {
      reads.push(path);
      return files.get(path) ?? null;
    },
    hasSystemFontFamily: async (name) => name === 'family',
    openFontFace: (bytes) => worker.open(bytes),
  });
  const glyphs = new ArtemisTextGlyphs(hash, fonts, painter);
  const style = (face, size) => ({...fixture.style, face, size});
  const advances = (block) => block.main.map((g) => g.advance);
  try {
    const renderer = new ArtemisGlyphRenderer();
    const fresh = await glyphs.load('A', '', style('gone.ttf', 32), renderer);
    assert.deepEqual(
      fresh.main.map((g) => [g.advance, g.glyph.surface.image]),
      [[0, null]],
    );
    assert.deepEqual(reads, ['gone.ttf', 'gone.ttf_32.rft', 'gone.ttf_32.rft.rft']);
    const large = await glyphs.load('A', '', style('a.ttf', 32), renderer);
    const small = await glyphs.load('A', '', style('a.ttf', 16), renderer);
    assert.notEqual(large.main[0].advance, small.main[0].advance);
    // The 16-pixel provider stays current with its own size.
    const kept = await glyphs.load('A', '', style('gone.ttf', 32), renderer);
    assert.equal(kept.main[0].advance, small.main[0].advance);
    // An invalid rendered file opens nothing either.
    assert.deepEqual(advances(await glyphs.load('A', '', style('x.ttf', 16), renderer)), [
      small.main[0].advance,
    ]);
    // The rendered font draws its images at the line top and advances by their width. An
    // unindexed U+0020 advances by (size+1)/2; an empty entry (here U+3000 too) or another
    // unindexed code fails as an empty character.
    const rendered = await glyphs.load('A B\u3000C\u{1d49c}', '', style('r.ttf', 16), renderer);
    assert.deepEqual(advances(rendered), [6, 8, 0, 0, 0, 0]);
    assert.equal(rendered.main[0].glyph.surface.top, 0);
    assert.equal(rendered.main[0].glyph.surface.image.width, 6);
    const metrics = (await fonts.loadRendered('r.ttf', 16)).metrics;
    assert.deepEqual(
      [
        metrics.decorationThickness,
        metrics.strikeoutPosition,
        metrics.underlineThickness,
        metrics.underlinePosition,
      ],
      [2, 9, 1, 14],
    );
    // A face that opens nothing keeps the rendered provider.
    assert.deepEqual(advances(await glyphs.load('A', '', style('gone.ttf', 24), renderer)), [6]);
    // Codes look up the Shift-JIS ranges of rft0 unchanged, so U+3000 is unindexed there and
    // advances by the size.
    assert.deepEqual(
      advances(await glyphs.load('A \u3000', '', style('j.ttf', 16), renderer)),
      [5, 8, 16],
    );
    assert.equal((await fonts.loadRendered('j.ttf', 16)).metrics.underlineThickness, 0);
    await assert.rejects(glyphs.load('A', '', style('c.ttf', 16), renderer), /32-bit/);
    await assert.rejects(glyphs.load('A', '', style('family', 16), renderer), /system font/);
    await assert.rejects(glyphs.load('A', '', style('gone.ttf', 32)), /Missing Artemis font file/);
  } finally {
    await glyphs.close();
    await fonts.close();
    painter.close();
    worker.close();
    await fixture.close();
  }
});

test('Rev.2762 32-bit rendered glyphs keep their own pixels and use alpha for the outline', async () => {
  const {ArtemisFileFonts} = await import('../dist/engines/artemis/file-fonts.js');
  const {paintArtemisGrayGlyph} = await import('../dist/engines/artemis/glyph-paint.js');
  const {ARTEMIS_2762_EXECUTABLE_SHA256: hash} =
    await import('../dist/engines/artemis/revision.js');
  const {png} = await import('./png-fixtures.mjs');
  const {rft} = await import('./artemis-rft-fixtures.mjs');
  // 2x1 RGBA: opaque red, half-transparent blue.
  const pixels = [255, 0, 0, 255, 0, 0, 255, 128];
  const rgba = png({width: 2, height: 1, type: 6, raw: Buffer.from([0, ...pixels])});
  const gray = png({width: 2, height: 1, type: 0, raw: Buffer.from([0, 200, 200])});
  const ini = '[FONT]\r\nCOLOR_32 = 1\r\nCHARSET = UTF-8\r\n';
  const files = new Map([
    ['c_16.rft', rft({ini, entries: new Map([[0x41, rgba]])})],
    ['g_16.rft', rft({ini, entries: new Map([[0x41, gray]])})],
  ]);
  const fonts = new ArtemisFileFonts(hash, {
    readFontFile: async (path) => files.get(path) ?? null,
    hasSystemFontFamily: async () => false,
    openFontFace: () => assert.fail('no FreeType face'),
  });
  try {
    const glyph = await (await fonts.loadRendered('c', 16)).glyph(0x41);
    assert.deepEqual([glyph.width, glyph.height, glyph.advance], [2, 1, 2]);
    assert.deepEqual([...glyph.pixels], [255, 128]);
    assert.deepEqual([...glyph.color], pixels);
    const style = {color: 0x00ff00, shadowColor: 0, outlineColor: 0xffffff, shadow: 0, outline: 0};
    // Without an outline the glyph's own RGBA replaces the text color.
    assert.deepEqual([...paintArtemisGrayGlyph(hash, glyph, style).image.pixels], pixels);
    // With an outline the alpha is the coverage and the glyph RGB the foreground.
    const outlined = paintArtemisGrayGlyph(hash, glyph, {...style, outline: 1}).image;
    assert.deepEqual([outlined.width, outlined.height], [4, 3]);
    const at = (x, y) => [...outlined.pixels.subarray((y * 4 + x) * 4, (y * 4 + x) * 4 + 4)];
    assert.deepEqual(at(1, 1), [255, 0, 0, 255]);
    assert.deepEqual(at(2, 1), [126, 126, 255, 255]);
    assert.deepEqual(at(0, 0), [255, 255, 255, 255]);
    await assert.rejects((await fonts.loadRendered('g', 16)).glyph(0x41), /pixel format/);
  } finally {
    await fonts.close();
  }
});

test('Native published text frames retain glyph font attributes and compute automatic whole-text pivots', async () => {
  const fixture = await nativeInsertionFixture();
  try {
    const source = fixture.owner({alpha: 0.5, entirealpha: 0.25});
    await source.insert(new TextEncoder().encode('A'));
    source.setStyle({...fixture.style, alpha: 1, entirealpha: 1});
    await source.insert(new TextEncoder().encode('A'));
    const frame = await source.prepareFrame(),
      blocks = frame.lines[0].geometry.blocks;
    assert.deepEqual(
      blocks.map((b) => b.block.main[0].glyph.font.alpha),
      [0.5, 1],
    );
    assert.deepEqual(
      blocks.map((b) => b.block.main[0].glyph.font.entirealpha),
      [0.25, 1],
    );
    assert.equal(blocks[0].block.main[0].glyph.surface.image.pixels[3], 255);
    assert.deepEqual([frame.font.entireanchorx, frame.font.entireanchory], [24, 24]);
    assert.equal(source.snapshotFont(), frame.font);
    source.setStyle({...fixture.style, width: 96, align: 'right'});
    const right = await source.prepareFrame();
    assert.deepEqual([right.font.entireanchorx, right.font.entireanchory], [72, 24]);
    assert.deepEqual(
      right.lines[0].geometry.blocks.map((b) => b.x),
      [48, 72],
    );
    source.setStyle({...fixture.style, width: 96, align: 'equalize'});
    assert.equal((await source.prepareFrame()).font.entireanchorx, 48);
    source.setStyle({...fixture.style, anchorcenter: false, entireanchorx: 7, entireanchory: 9});
    const manual = await source.prepareFrame();
    assert.deepEqual([manual.font.entireanchorx, manual.font.entireanchory], [7, 9]);
  } finally {
    await fixture.close();
  }
});

test('Native empty-effect clear resets glyph ids but retains active indentation and captured old frames', async () => {
  const fixture = await nativeInsertionFixture();
  try {
    const owner = fixture.owner({width: 96, height: 400});
    owner.setWordParts(new Set(['^']));
    owner.setIndentation({pairs: new Map([['A', 'B']]), range: 0, logicalRange: false, nest: true});
    await owner.insert(new TextEncoder().encode('A\nA'));
    const old = await owner.prepareFrame();
    owner.clearEmptyEffects();
    assert.equal(owner.glyphCount, 0);
    assert.deepEqual(owner.measure(), {width: 48, height: 0, lineWidth: 48});
    const empty = await owner.prepareFrame();
    assert.equal(empty.lines.length, 1);
    assert.equal(empty.lines[0].geometry.characterCount, 0);
    assert.equal(empty.lines[0].geometry.blocks[0].block.width, 48);
    assert.equal(old.glyphCount, 2);
    assert.equal(old.lines.length, 2);
    // With zero count/index a second clear retains this placeholder.
    owner.clearEmptyEffects();
    assert.equal((await owner.prepareFrame()).lines[0].geometry.blocks.length, 1);
    await owner.insert(new TextEncoder().encode('B'));
    const fresh = await owner.prepareFrame();
    assert.equal(fresh.lines[0].geometry.blocks[1].block.main[0].glyph.glyphId, 0);
    assert.equal(owner.glyphCount, 1);
    assert.equal(old.lines[0].geometry.blocks[0].block.main[0].glyph.glyphId, 0);
  } finally {
    await fixture.close();
  }
});

test('Native ruby buffers print data globally and end inserts one real normal/ruby block in the current layer', async () => {
  const fixture = await nativeInsertionFixture();
  const {ArtemisRuby} = await import('../dist/engines/artemis/ruby.js');
  const {ArtemisPrint} = await import('../dist/engines/artemis/print.js');
  const owners = {
      a: fixture.owner({width: 96, height: 400}),
      b: fixture.owner({width: 96, height: 400}),
    },
    history = [],
    errors = [],
    queued = [];
  let selected = 'a';
  const tag = (name, data) => ({
    kind: 'tag',
    name,
    sourceLine: 3,
    args: new Map(data === undefined ? [] : [[name === 'print' ? 'data' : 'text', data]]),
  });
  const ruby = new ArtemisRuby(fixture.hash, {
    currentMessageLayer: () => selected,
    insertRuby: (layer, ...args) => owners[layer].insertRuby(...args),
    fontOverflowPolicy: () => 1,
    writeOverflowed: () => {},
    enqueue: (t) => queued.push(t),
    recordTextCommand: (layer, t) => history.push([layer, t]),
    reportRubyError: (_t, kind) => errors.push(kind),
  });
  const print = new ArtemisPrint(fixture.hash, {
    currentMessageLayer: () => selected,
    rubyActive: () => ruby.active,
    debugSkipActive: () => true,
    print: () => assert.fail('ruby bypassed buffer'),
    appendRubyBytes: (bytes) => ruby.appendRubyBytes(bytes),
    fontOverflowPolicy: () => 1,
    writeOverflowed: () => {},
    reportPrintError: () => {},
    enqueue: () => {},
    recordPrintCommand: (layer, t) => history.push([layer, t]),
  });
  try {
    await ruby.dispatch({
      ...tag('ruby', 'A'),
      args: new Map([
        ['data', 'ignored'],
        ['text', 'A'],
      ]),
    });
    await print.dispatch(tag('print', 'AA\0ignored'));
    await ruby.dispatch(tag('ruby', 'wrong'));
    assert.deepEqual(errors, ['nested']);
    selected = 'b';
    await ruby.dispatch(tag('/ruby'));
    assert.equal(ruby.active, false);
    assert.equal(owners.a.glyphCount, 0);
    assert.equal(owners.b.glyphCount, 3);
    const frame = await owners.b.prepareFrame(),
      block = frame.lines[0].geometry.blocks[0].block;
    assert.deepEqual(
      block.main.map((g) => g.glyph.glyphId),
      [0, 1],
    );
    assert.deepEqual(
      block.ruby.map((g) => g.glyph.glyphId),
      [2],
    );
    assert.equal(frame.lines[0].geometry.characterCount, 2);
    assert.deepEqual(
      history.map(([layer, t]) => [layer, t.name]),
      [
        ['a', 'ruby'],
        ['a', 'print'],
        ['a', 'ruby'],
        ['b', '/ruby'],
      ],
    );
    await ruby.dispatch(tag('/ruby'));
    assert.equal(history.length, 4);
    assert.deepEqual(errors, ['nested', 'inactive']);
    await ruby.dispatch(tag('ruby'));
    assert.equal(history.at(-1)[1].args.get('text'), '');
    await ruby.dispatch(tag('/ruby'));
    assert.equal(queued.length, 0);
  } finally {
    ruby.close();
    await fixture.close();
  }
});

test('Native ruby overflow queues retry with active buffers and distinguishes unprintable/replay/cancellation', async () => {
  const fixture = await nativeInsertionFixture();
  const {ArtemisRuby} = await import('../dist/engines/artemis/ruby.js');
  const tag = (name) => ({kind: 'tag', name, sourceLine: 19, args: new Map([['text', 'A']])});
  const queue = [],
    history = [],
    errors = [];
  let result = -2,
    overflowed = 0,
    gate,
    started;
  const ruby = new ArtemisRuby(fixture.hash, {
    currentMessageLayer: () => '',
    insertRuby: async (_layer, main, annotation) => {
      assert.equal(new TextDecoder().decode(main), 'AA');
      assert.equal(new TextDecoder().decode(annotation), 'A');
      if (gate) {
        started();
        await gate;
      }
      return result;
    },
    fontOverflowPolicy: () => 0,
    writeOverflowed: (v) => {
      overflowed = v;
    },
    enqueue: (t) => queue.push(t),
    recordTextCommand: (_layer, t) => history.push(t),
    reportRubyError: (_t, kind) => errors.push(kind),
  });
  try {
    await ruby.dispatch(tag('ruby'));
    ruby.appendRubyBytes(new TextEncoder().encode('AA'));
    await ruby.dispatch(tag('/ruby'));
    assert.equal(ruby.active, true);
    assert.equal(overflowed, 1);
    assert.equal(history.length, 1);
    assert.deepEqual(
      queue.map((t) => t.name),
      ['@', 'rp', '/ruby'],
    );
    assert.equal(queue[2].sourceLine, 19);
    result = 3;
    await ruby.dispatch(queue[2], false);
    assert.equal(ruby.active, false);
    assert.equal(history.length, 1);
    await ruby.dispatch(tag('ruby'));
    ruby.appendRubyBytes(new TextEncoder().encode('AA'));
    result = -1;
    await ruby.dispatch(tag('/ruby'));
    assert.equal(ruby.active, false);
    assert.equal(history.length, 2);
    assert.deepEqual(errors, ['overflow', 'unprintable']);
    await ruby.dispatch(tag('ruby'));
    ruby.appendRubyBytes(new TextEncoder().encode('AA'));
    let release;
    gate = new Promise((r) => {
      release = r;
    });
    const begun = new Promise((r) => {
      started = r;
    });
    const pending = ruby.dispatch(tag('/ruby')),
      rejected = assert.rejects(pending, /cancelled/);
    await begun;
    assert.throws(() => ruby.appendRubyBytes(new Uint8Array()), /Overlapping/);
    ruby.close();
    release();
    await rejected;
    assert.equal(history.length, 3);
  } finally {
    ruby.close();
    await fixture.close();
  }
});

test('Native rt/rp maintain history/backlog before actual clear and replay suppresses only history effects', async () => {
  const fixture = await nativeInsertionFixture();
  const {ArtemisTextCommands} = await import('../dist/engines/artemis/text-commands.js');
  const owner = fixture.owner(),
    calls = [];
  let force = false;
  const commands = new ArtemisTextCommands(fixture.hash, {
    currentMessageLayer: () => '',
    newline: (_layer, omit) => owner.newline(omit),
    backlogAllowed: () => false,
    backlogIncludeFont: () => true,
    captureBacklog: () => calls.push('backlog'),
    clearCommandHistory: () => calls.push('history'),
    saveCurrentFontHistory: () => calls.push('font'),
    promoteRememberedTextCommands: () => calls.push('promote'),
    forceImmediateClear: () => force,
    clearText: async (_layer, out) => {
      calls.push(out ? 'clear:out' : 'clear:now');
      owner.clearEmptyEffects();
    },
    recordTextCommand: (_layer, tag) => calls.push(tag.name),
  });
  const tag = (name, args = []) => ({kind: 'tag', name, sourceLine: 0, args: new Map(args)});
  try {
    await commands.dispatch(tag('rt', [['omitblankline', '']]));
    assert.equal((await owner.prepareFrame()).lines.length, 1);
    await owner.insert(new TextEncoder().encode('A'));
    await commands.dispatch(tag('rt', [['omitblankline', '0']]));
    assert.equal((await owner.prepareFrame()).lines.length, 2);
    await commands.dispatch(tag('rp', [['backlog', '1']]));
    assert.deepEqual(calls, ['rt', 'rt', 'backlog', 'history', 'font', 'promote', 'clear:out']);
    assert.equal(owner.glyphCount, 0);
    assert.equal((await owner.prepareFrame()).lines.length, 1);
    calls.length = 0;
    force = true;
    await commands.dispatch(tag('rp', [['backlog', '1']]), false);
    assert.deepEqual(calls, ['clear:now']);
  } finally {
    commands.close();
    await fixture.close();
  }
});

test('Opt-in nonvisual glyph fixture performs actual worker jobs without publishing frames', async () => {
  const {createArtemisGlyphLayoutFixture} =
    await import('../tools/artemis-glyph-layout-fixture.mjs');
  const {rectangleFont} = await import('./freetype-fixtures.mjs');
  const hash = '8953562b80608046662bd8c89015d04236b0ba3afee10c36469c11403de3ebaf';
  const fixture = createArtemisGlyphLayoutFixture(hash, async () => rectangleFont());
  const resource = {
    name: 'source',
    font: new Map([
      ['face', 'synthetic.ttf'],
      ['rubyface', 'synthetic.ttf'],
      ['size', 32],
      ['rubysize', 16],
      ['width', 96],
      ['height', 400],
    ]),
  };
  try {
    const owner = fixture.get(resource);
    assert.deepEqual(await owner.insert(new TextEncoder().encode('A')), {
      result: 1,
      consumedBytes: 1,
    });
    const copy = {name: 'copy', font: new Map(resource.font)};
    fixture.copy(resource, copy);
    fixture.release(resource);
    assert.equal(fixture.get(copy).glyphCount, 1);
    // Frames are drawn from the insertion's display lines; preparing one publishes nothing.
    await fixture.get(copy).prepareFrame();
    const summary = fixture.summary();
    assert.equal(summary.rasterJobs, 1);
    assert.equal(summary.sceneRendering, false);
    assert.equal(summary.gameVisualAssetsDisplayed, false);
    assert.equal(summary.samples[0].paintedSha256.length, 1);
    assert.equal(summary.openedFonts[0].path, 'synthetic.ttf');
  } finally {
    await fixture.close();
  }
});

async function preloadFixture(budget = 16n, decode) {
  const {ArtemisSurfaceManager} = await import('../dist/engines/artemis/surface-manager.js');
  const {createSolidImage} = await import('../dist/graphics/solid-image.js');
  const loaded = [],
    disposed = [],
    created = [];
  const manager = new ArtemisSurfaceManager(revision, budget, {
    createSurface() {
      const surface = {id: created.length};
      created.push(surface);
      return surface;
    },
    async decodeSurface(surface, name) {
      loaded.push({name, surface});
      if (decode) await decode(surface, name);
      if (name === 'missing') return null;
      return {path: `${name}.png`, image: createSolidImage(1, 1, [10, 20, 30, 255])};
    },
    storageBytes: () => 8,
    disposeSurface(surface, resource) {
      disposed.push({surface, resource});
    },
  });
  return {manager, loaded, disposed, created};
}

test('Artemis surface eviction forgets the cache entry while holders keep their loans', async () => {
  const {manager, disposed} = await preloadFixture();
  const held = await manager.load('held');
  (await manager.load('idle')).lease.release();
  assert.equal(manager.bytesUsed, 16n);
  manager.evict('idle');
  manager.evict('held');
  manager.evict('absent');
  assert.equal(manager.bytesUsed, 0n);
  assert.equal(disposed.length, 1);
  const fresh = await manager.load('held'); // The forgotten name decodes again.
  assert.notEqual(fresh.image, held.image);
  held.lease.release();
  assert.equal(disposed.length, 2);
  assert.equal(disposed[1].resource.image, held.image);
  fresh.lease.release();
  assert.equal(manager.bytesUsed, 8n);
});

test('Artemis savess writes the scaled screenshot as PNG in the save directory', async () => {
  const {ArtemisScreenshots} = await import('../dist/engines/artemis/screenshot.js');
  const {decodePng} = await import('../dist/formats/png/decode.js');
  const events = [],
    files = new Map();
  let taken = false;
  const owner = new ArtemisScreenshots(revision, {
    stageSize: () => ({width: 4, height: 2}),
    take: () => void (taken = true),
    takePresented: () => assert.fail('Rev.3179 takess renders the scene'),
    read: (width, height) => {
      events.push(['read', width, height]);
      return taken
        ? Uint8Array.from({length: width * height * 4}, (_, index) => index & 0xff)
        : null;
    },
    writeSaveFile: async (name, bytes) => void files.set(name, bytes),
    evictSurface: (name) => events.push(['evict', name]),
    invalidSize: (tag) => events.push(['invalid', tag.name]),
    missingScreenshot: (tag) => events.push(['missing', tag.name]),
  });
  const tag = (name, args = {}) => ({
    kind: 'tag',
    name,
    sourceLine: 1,
    args: new Map(Object.entries(args)),
  });
  assert.equal(await owner.dispatch(tag('savess', {file: 'early'})), true);
  assert.equal(owner.dispatch(tag('takess')), true);
  assert.equal(taken, true);
  await owner.dispatch(tag('savess', {file: 'thumb', width: '0'}));
  await owner.dispatch(tag('savess', {file: 'thumb'}));
  await owner.dispatch(tag('savess', {file: 'big.jpg', width: '3', height: '1'}));
  await owner.dispatch(tag('savess', {file: 'dir.x\\name', width: '1', height: '1'}));
  assert.equal(owner.dispatch(tag('lyc')), false);
  assert.deepEqual(events, [
    ['read', 4, 2],
    ['missing', 'savess'],
    ['invalid', 'savess'],
    ['read', 4, 2],
    ['evict', 'thumb'],
    ['read', 3, 1],
    ['evict', 'big.jpg'],
    ['read', 1, 1],
    ['evict', 'dir.x\\name'],
  ]);
  assert.deepEqual([...files.keys()], ['thumb.png', 'big.jpg', 'dir.x\\name.png']);
  const png = await decodePng(files.get('big.jpg'));
  assert.deepEqual([png.width, png.height], [3, 1]);
  assert.deepEqual([...png.pixels], [...Array(12).keys()]);
});

test('Rev.3139 takess copies the presented frame instead of rendering the scene', async () => {
  const {ArtemisScreenshots} = await import('../dist/engines/artemis/screenshot.js');
  const {ARTEMIS_3139_EXECUTABLE_SHA256: sha} = await import('../dist/engines/artemis/revision.js');
  const events = [];
  const owner = new ArtemisScreenshots(sha, {
    stageSize: () => ({width: 2, height: 1}),
    take: () => assert.fail('Rev.3139 takess copies the presented frame'),
    takePresented: () => events.push('presented'),
    read: () => new Uint8Array(8),
    writeSaveFile: async (name) => void events.push(name),
    evictSurface: () => {},
    invalidSize: () => assert.fail('invalid'),
    missingScreenshot: () => assert.fail('missing'),
  });
  const tag = (name, args = {}) => ({
    kind: 'tag',
    name,
    sourceLine: 1,
    args: new Map(Object.entries(args)),
  });
  assert.equal(owner.dispatch(tag('takess')), true);
  await owner.dispatch(tag('savess', {file: 'x'}));
  assert.deepEqual(events, ['presented', 'x.png']);
});

test('Presented screenshots copy the presentation target into the screenshot surface offscreen', async () => {
  const {graphics, layers, frames} = await rasterFixture(undefined, true);
  try {
    graphics.takePresentedScreenshot();
    assert.equal(frames.length, 1);
    const {list} = frames[0];
    assert.equal(list.offscreen, true);
    assert.deepEqual(list.sprites, []);
    assert.equal(list.commands.length, 1);
    const [copy] = list.commands;
    assert.equal(copy.kind, 'gpu-copy');
    assert.equal(copy.source, null);
    assert.deepEqual([copy.destination.width, copy.destination.height], [4, 2]);
  } finally {
    layers.close();
  }
});

test('Artemis preload queue shares real surfaces with foreground loans and keeps one explicit script binding', async () => {
  const {manager, loaded, disposed} = await preloadFixture();
  manager.bindSurfaceAsync('a');
  manager.bindSurfaceAsync('a');
  manager.bindSurfaceAsync('b');
  assert.equal(manager.isLoadingSurface('a'), true);
  assert.equal(manager.isLoadingSurface(), true);
  const foreground = manager.load('a');
  await manager.waitForLoads();
  const a = await foreground;
  assert.deepEqual(
    loaded.map((x) => x.name),
    ['a', 'b'],
  );
  assert.equal(manager.bytesUsed, 16n);
  assert.equal(manager.isLoadingSurface(), false);
  manager.unbindSurface('a');
  assert.equal(disposed.length, 0);
  a.lease.release();
  const again = await manager.load('a');
  assert.equal(again.image, a.image);
  manager.bindSurfaceAsync('a'); // Cached binding increments native loan count.
  again.lease.release();
  await manager.close(); // Drops script-only bindings, including b.
  assert.equal(manager.bytesUsed, 0n);
  assert.equal(disposed.length, 2);
});

test('Artemis preload mode2 skips at equal budget while mode1 can exceed it, then release trims actual storage', async () => {
  const {manager, loaded, disposed} = await preloadFixture(8n);
  manager.bindSurfaceAsync('a');
  manager.bindSurfaceAsync('conditional', true);
  manager.bindSurfaceAsync('b');
  await manager.waitForLoads();
  assert.deepEqual(
    loaded.map((x) => x.name),
    ['a', 'b'],
  );
  assert.equal(manager.bytesUsed, 16n);
  assert.equal(disposed.length, 1); // Prepared conditional surface, no decoded resource.
  assert.equal(disposed[0].resource, null);
  manager.unbindSurface('b');
  assert.equal(manager.bytesUsed, 8n);
  const a = await manager.load('a');
  await manager.close();
  assert.equal(manager.bytesUsed, 8n); // Held image lease survives close.
  assert.equal(a.image.pixels[0], 10);
  a.lease.release();
  assert.equal(manager.bytesUsed, 0n);
  assert.equal(new Set(disposed.map((x) => x.surface)).size, disposed.length);
});

test('Artemis foreground promotion removes a later preload while the head decoder remains active', async () => {
  let finish, started;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const startedPromise = new Promise((resolve) => {
    started = resolve;
  });
  const {manager, loaded, created, disposed} = await preloadFixture(16n, async (_, name) => {
    if (name === 'head') {
      started();
      await pending;
    }
  });
  manager.bindSurfaceAsync('head');
  manager.bindSurfaceAsync('later');
  await startedPromise;
  const later = await manager.load('later');
  assert.equal(manager.isLoadingSurface('head'), true);
  assert.equal(manager.isLoadingSurface('later'), false);
  assert.equal(disposed[0].surface, created[1]); // Retire queued placeholder.
  assert.equal(disposed[0].resource, null);
  assert.deepEqual(
    loaded.map((x) => x.name),
    ['head', 'later'],
  );
  finish();
  await manager.waitForLoads();
  later.lease.release();
  await manager.close();
  assert.equal(manager.bytesUsed, 0n);
});

test('Artemis cancellation retains the in-flight prepared surface until its decoder finishes and rejects stale publication', async () => {
  let finish, started;
  const gate = new Promise((resolve) => {
    finish = resolve;
  });
  const began = new Promise((resolve) => {
    started = resolve;
  });
  const {manager, disposed} = await preloadFixture(16n, async () => {
    started();
    await gate;
  });
  manager.bindSurfaceAsync('a');
  await began;
  manager.unbindSurface('a');
  assert.equal(manager.isLoadingSurface(), false);
  assert.equal(disposed.length, 0);
  finish();
  await manager.waitForLoads();
  assert.equal(disposed.length, 1);
  assert.ok(disposed[0].resource.image.pixels.length);
  assert.equal(manager.bytesUsed, 0n);
  await manager.close();
});

test('Artemis native front-name revalidation preserves same-name clear/requeue behavior', async () => {
  let finish, started;
  const gate = new Promise((resolve) => {
    finish = resolve;
  });
  const began = new Promise((resolve) => {
    started = resolve;
  });
  const {manager, created, disposed, loaded} = await preloadFixture(16n, async () => {
    started();
    await gate;
  });
  manager.bindSurfaceAsync('a');
  await began;
  manager.clearSurfaceLoadQueue();
  manager.bindSurfaceAsync('a');
  finish();
  await manager.waitForLoads();
  assert.equal(loaded.length, 1); // Old decoder result accepted for matching front name.
  assert.equal(disposed[0].surface, created[1]);
  assert.equal(manager.bytesUsed, 8n);
  await manager.close();
  assert.equal(disposed[1].surface, created[0]);
  assert.equal(manager.bytesUsed, 0n);
});

test('Artemis missing images and unsupported preload hosts are observable without leaked prepared resources', async () => {
  const missing = await preloadFixture();
  missing.manager.bindSurfaceAsync('missing');
  assert.equal(await missing.manager.load('missing'), null);
  await missing.manager.waitForLoads();
  assert.equal(missing.loaded.length, 2); // Queued miss followed by native foreground retry.
  assert.equal(missing.disposed.length, 2);
  await missing.manager.close();
  const failed = await preloadFixture(8n, async () => {
    throw Error('Unsupported decoder');
  });
  failed.manager.bindSurfaceAsync('a');
  await assert.rejects(failed.manager.waitForLoads(), /Unsupported decoder/);
  assert.equal(failed.manager.loadFailures.length, 1);
  assert.equal(failed.manager.isLoadingSurface(), false);
  assert.equal(failed.disposed.length, 1);
  for (const name of ['nul\0', '\ud800', '\udc00']) {
    assert.throws(() => failed.manager.bindSurfaceAsync(name), /surface name/);
    await assert.rejects(failed.manager.load(name), /surface name/);
  }
  await failed.manager.close();
});

test('Lua script cache bindings preload a generated PNG through the actual shared worker and release it by name', async () => {
  const {createArtemisSurfacePreloadFixture} =
    await import('../tools/artemis-surface-preload-fixture.mjs');
  const {ArtemisLua} = await import('../dist/engines/artemis/lua.js');
  const {png} = await import('./png-fixtures.mjs');
  const encoded = png({width: 2, height: 1, raw: Buffer.from([0, 255, 0, 0, 255, 0, 255, 0, 128])});
  const original = Buffer.from(encoded);
  const gray = png({width: 2, height: 1, type: 0, raw: Buffer.from([0, 10, 200])});
  const fixture = createArtemisSurfacePreloadFixture(
    revision,
    async (path) => (path === 'fixture.png' ? encoded : path === 'gray.png' ? gray : null),
    16n,
  );
  const lua = new ArtemisLua({
    readFile: () => null,
    fileExists: () => false,
    now: () => 0,
    tag: () => {},
    enqueueTag: () => {},
    variable: () => '',
    bindSurfaceAsync: (name) => fixture.manager.bindSurfaceAsync(name),
    unbindSurface: (name) => fixture.manager.unbindSurface(name),
    clearSurfaceLoadQueue: () => fixture.manager.clearSurfaceLoadQueue(),
    isLoadingSurface: (name) => fixture.manager.isLoadingSurface(name),
  });
  try {
    lua.vm.execute(
      new TextEncoder().encode(
        'engine:bindSurfaceAsync("fixture"); engine:bindSurfaceAsync("fixture"); assert(engine:isLoadingSurface("fixture")); engine:bindSurfaceAsync("cancelled"); engine:unbindSurface("cancelled")',
      ),
    );
    const foreground = fixture.manager.load('fixture');
    await fixture.manager.waitForLoads();
    const image = await foreground;
    assert.deepEqual([...image.image.pixels], [255, 0, 0, 255, 0, 255, 0, 128]);
    assert.deepEqual(encoded, original);
    lua.vm.execute(
      new TextEncoder().encode(
        'assert(not engine:isLoadingSurface()); engine:clearSurfaceLoadQueue(); engine:unbindSurface("fixture")',
      ),
    );
    assert.equal(fixture.summary().decodedImages, 1);
    assert.equal(fixture.summary().samples[0].pixelsSha256.length, 64);
    assert.equal(fixture.summary().samples[0].format, 2);
    assert.equal(fixture.summary().gameVisualAssetsDisplayed, false);
    // A gray PNG is a native format 0 surface: one byte per pixel, also in storage.
    const grayImage = await fixture.manager.load('gray');
    assert.deepEqual([...grayImage.image.pixels], [10, 200]);
    assert.equal(fixture.summary().samples[1].format, 0);
    assert.equal(fixture.manager.bytesUsed, 10n);
    grayImage.lease.release();
    image.lease.release();
    assert.equal(fixture.manager.bytesUsed, 10n);
  } finally {
    lua.close();
    await fixture.close();
  }
  assert.equal(fixture.manager.bytesUsed, 0n);
});

test('Message-layer scene wrappers share image properties and retained-frame resource ownership', async () => {
  const {createMetadataLayerFixture} = await import('../tools/artemis-metadata-layer-fixture.mjs');
  const {ArtemisMessageLayers} = await import('../dist/engines/artemis/message-layers.js');
  const fixture = createMetadataLayerFixture(revision, async () => null);
  const resources = [],
    freed = [];
  const retain = (layer) => layer.references++;
  const release = (layer) => {
    assert.ok(layer.references > 0);
    if (--layer.references === 0) freed.push(layer);
  };
  const stage = new ArtemisMessageLayers(revision, '', {
    createMessageLayer: (name) => {
      const layer = {name, references: 1};
      resources.push(layer);
      return layer;
    },
    copyMessageLayer: (old) => {
      const layer = {name: old.name, references: 1};
      resources.push(layer);
      return layer;
    },
    retainMessageLayer: retain,
    releaseMessageLayer: release,
    attachMessageLayer: (name, layer) => fixture.attachMessageActor(name, layer, {retain, release}),
    detachMessageLayer: (name) => fixture.detachMessageActor(name),
  });
  try {
    stage.selectMessageLayer('500.z.bt.tx.1.1', 1);
    const original = stage.currentLayer();
    assert.equal(original.references, 3); // Store, selected, current scene wrapper.
    await fixture.dispatch(command('lyprop', {id: original.name, alpha: '255'}));
    assert.equal(original.references, 4); // Native new node retains its original inner slot too.
    await fixture.dispatch(command('flip', {})); // Retain current scene.
    await fixture.dispatch(command('lyprop', {id: original.name, left: '12'}));
    assert.equal(original.references, 4); // Current/retained wrappers own independent loans.
    const actor = fixture.snapshot().layers.find((x) => x.id === original.name);
    assert.equal(actor.properties.left, 12);
    stage.selectMessageLayer(original.name, 1); // Detach/copy/reattach; retained original survives.
    const replacement = stage.currentLayer();
    assert.notEqual(replacement, original);
    assert.equal(original.references, 2); // Detached retained node still owns both inner slots.
    assert.equal(freed.includes(original), false);
    await fixture.dispatch(command('flip', {}));
    assert.equal(original.references, 0);
    assert.equal(freed.includes(original), true);
    stage.selectMessageLayer(original.name, -1);
    assert.equal(
      fixture.snapshot().layers.some((x) => x.id === original.name),
      false,
    );
  } finally {
    stage.close();
    fixture.close();
  }
  assert.equal(freed.length, resources.length);
});

test('External scene attachment rejects reused wrappers and releases blocked actors without command-history side effects', async () => {
  const {ArtemisLayers} = await import('../dist/engines/artemis/layers.js');
  const disposed = [],
    commandEffects = [];
  const layers = new ArtemisLayers(
    revision,
    {load: async () => null},
    {
      creationMode: () => 0,
      createImageLayer: () => ({}),
      copyImageLayer: (old) => ({...old}),
      createGroupLayer: () => ({}),
      releaseImageLayer: (actor) => disposed.push(actor),
      applyImageProperties: () => {},
      recordLayerProperties: () => {},
      layerNotFound: () => {},
      clearLayerCommands: (ids) => commandEffects.push(ids),
      resetLayerCommands: (id) => commandEffects.push(id),
      imageLoadFailed: () => {},
    },
  );
  const parent = {},
    blocked = {},
    invalid = {};
  assert.equal(layers.attachActor('leaf', parent), true);
  assert.throws(() => layers.attachActor('other', parent), /fresh/);
  assert.equal(layers.attachActor('leaf.child', blocked), false);
  assert.deepEqual(disposed, [blocked]);
  assert.throws(() => layers.attachActor('nul\0', invalid), /NUL|key|id/);
  assert.equal(disposed.includes(invalid), true);
  layers.commit();
  layers.detachActor('leaf');
  assert.equal(disposed.includes(parent), false);
  layers.commit();
  assert.equal(disposed.includes(parent), true);
  assert.deepEqual(commandEffects, []);
  layers.close();
  assert.equal(new Set(disposed).size, disposed.length);
});

async function audioEffectFixture() {
  const {BrowserAudioTransport} = await import('../dist/audio/transport.js');
  const {ArtemisEffectVoices} = await import('../dist/engines/artemis/effect-voices.js');
  const nodes = [],
    gains = [];
  const connectable = () => ({
    connections: [],
    connect(...args) {
      this.connections.push(args);
    },
    disconnect() {
      this.connections = [];
    },
  });
  const context = {
    currentTime: 0,
    destination: {},
    resume: async () => {},
    close: async () => {},
    createBuffer() {
      return {copyToChannel() {}};
    },
    createGain() {
      const node = {
        ...connectable(),
        gain: {
          value: 0,
          setValueAtTime(value) {
            this.value = value;
          },
        },
      };
      gains.push(node);
      return node;
    },
    createChannelSplitter: () => connectable(),
    createChannelMerger: () => connectable(),
    createBufferSource() {
      const node = {
        ...connectable(),
        stopCalls: 0,
        stop() {
          this.stopCalls++;
        },
        start(...args) {
          this.args = args;
        },
      };
      nodes.push(node);
      return node;
    },
  };
  const clip = {
    sampleRate: 100,
    sampleCount: 1000,
    channels: [new Float32Array(1000), new Float32Array(1000)],
  };
  const transport = new BrowserAudioTransport(async () => clip, context);
  const effects = new ArtemisEffectVoices(revision, {
    prepareVoice: async () => transport.prepare(0, 0, false),
  });
  return {effects, transport, context, nodes, gains};
}

test('Timed sound waits use the player start tick, preserve time-only flags and ignore inactive players', async () => {
  const {ArtemisTimedWait} = await import('../dist/engines/artemis/wait.js');
  const {ArtemisModes} = await import('../dist/engines/artemis/modes.js');
  const {ArtemisSave} = await import('../dist/engines/artemis/save.js');
  const {ArtemisVariables} = await import('../dist/engines/artemis/variables.js');
  const {effects} = await audioEffectFixture();
  let clock = 100;
  const events = [];
  const unexpected = () => assert.fail('unexpected text/save operation');
  const modes = new ArtemisModes({
    writeStatus() {},
    commandSkipChanged() {},
    controlSkipChanged() {},
    automodeChanged() {},
    releaseScheduler() {},
  });
  const save = new ArtemisSave(new ArtemisVariables(), {
    reportEventError: unexpected,
    beforeScenario: unexpected,
    writeScenario: unexpected,
    writeGlobal: unexpected,
    writeSystem: unexpected,
  });
  let index;
  const wait = new ArtemisTimedWait(modes, save, {
    now: () => clock,
    debugSkipActive: () => false,
    startTextDisplay: unexpected,
    textDisplayComplete: () => true,
    finishTextDisplay: unexpected,
    writeClickSkip: () => events.push('clickskip'),
    beginWait: (input) => events.push(input),
    endWait: () => events.push('end'),
    clickWaitEvent: (kind) => events.push(kind),
    resumeMessageState: () => events.push('message'),
    effectIndex: (id) => (id === 'voice' ? index : undefined),
    effectPlaying: (i) => effects.isPlaying(i),
    effectStartTick: (i) => effects.startTick(i),
  });
  const tag = (args) => ({
    kind: 'tag',
    name: 'wait',
    sourceLine: -1,
    args: new Map(Object.entries(args)),
  });
  try {
    index = await effects.prepareEffect('synthetic', -1);
    assert.equal(effects.startTick(index), 0);
    assert.equal(wait.dispatch(tag({se: 'missing', time: '500'})), true);
    assert.equal(wait.dispatch(tag({se: 'voice', time: '500'})), true);
    assert.equal(wait.pending, false);
    assert.deepEqual(events, []);
    effects.tick(clock);
    effects.startEffect(index, 0, false);
    assert.equal(effects.startTick(index), 100);
    clock = 400;
    effects.tick(clock);
    effects.startEffect(index, 0, false); // Already playing: preserves the original start.
    assert.equal(effects.startTick(index), 100);
    wait.dispatch(tag({se: 'voice', time: '500', scenario: '2', video: 'ignored'}));
    assert.deepEqual(wait.reason, {time: 600});
    assert.equal(wait.soundPending, false);
    const flags = wait.take();
    wait.restore(flags);
    assert.deepEqual(wait.reason, {time: 600});
    assert.equal(wait.tick(600), false);
    assert.equal(wait.tick(601), true);
    assert.equal(effects.isPlaying(index), true); // Deadline is independent of completion.
    wait.dispatch(tag({se: 'voice', time: '0', input: '1'}));
    assert.equal(wait.tick(400, true), true);
    assert.deepEqual(events.slice(-4), ['clickskip', 'end', 'out', 'message']);
    effects.stopEffect(index, 0);
    assert.equal(effects.startTick(index), 0);
    wait.dispatch(tag({se: 'voice', time: '500'}));
    assert.equal(wait.pending, false);
    index = await effects.prepareEffect('synthetic', -1);
    effects.tick(0xfffffff0);
    effects.startEffect(index, 0, false);
    wait.dispatch(tag({se: 'voice', time: '32'}));
    assert.deepEqual(wait.reason, {time: 16});
    wait.clear();
    effects.stopEffect(index, 10);
    effects.tick(20);
    effects.tick(31);
    assert.equal(effects.startTick(index), 0);
  } finally {
    effects.close();
  }
});

test('Native effect voices drive the real shared transport through gain, loop, stereo attenuation and fade completion', async () => {
  const {effects, transport, context, nodes, gains} = await audioEffectFixture();
  try {
    const id = await effects.prepareEffect('generated', 0);
    effects.setEffectGain(id, 0, 500);
    effects.setEffectGain(id, 1, 800);
    assert.ok(Math.abs(gains[0].gain.value - 10 ** (-796 / 2000)) < 1e-12); // Native centidB rounding for gain400.
    effects.setEffectPan(id, 500, 0);
    assert.ok(Math.abs(gains[1].gain.value - 10 ** (-602 / 2000)) < 1e-12);
    assert.equal(gains[2].gain.value, 1); // Attenuation only, no stereo crossfeed.
    effects.startEffect(id, 100, true);
    assert.equal(nodes[0].loop, true);
    effects.tick(1000);
    effects.tick(1050);
    assert.ok(Math.abs(gains[0].gain.value - 10 ** (-1398 / 2000)) < 1e-12); // Fade factor500 → native gain200.
    effects.tick(1100);
    assert.ok(Math.abs(gains[0].gain.value - 10 ** (-796 / 2000)) < 1e-12);
    context.currentTime = 1;
    assert.equal(effects.isPlaying(id), true);
    effects.stopEffect(id, 100);
    effects.tick(1200);
    effects.tick(1250);
    effects.startEffect(id, 0, false); // Cancels stop completion; immediate native start preserves current fade factor.
    effects.tick(1300);
    assert.equal(nodes[0].stopCalls, 0);
    effects.stopEffect(id, 100);
    effects.tick(1400);
    effects.tick(1500);
    assert.equal(effects.isPlaying(id), false);
    assert.equal(nodes[0].stopCalls, 1);
    assert.equal(effects.count, 1); // Native stopped voice remains until preparation-time collection.
    const next = await effects.prepareEffect('next', 0);
    assert.ok(next > id);
    assert.equal(effects.count, 1);
    effects.startEffect(next, 0, false);
    nodes[1].onended();
    assert.equal(effects.isPlaying(next), true); // Native playing flag settles on its frame tick.
    effects.tick(1501);
    assert.equal(effects.isPlaying(next), false);
    await effects.prepareEffect('last', 0);
    assert.equal(effects.count, 1);
  } finally {
    effects.close();
    transport.dispose();
  }
});

test('Native default integer fades preserve first-tick, truncation, cancellation and absolute clock-wrap behavior', async () => {
  const {ArtemisLinearIntegerTween} = await import('../dist/engines/artemis/integer-tween.js');
  const values = [];
  let completed = 0;
  const tween = new ArtemisLinearIntegerTween(
    revision,
    -3,
    3,
    5,
    (value) => values.push(value),
    () => completed++,
  );
  assert.equal(tween.tick(100), false);
  tween.tick(102);
  tween.tick(103);
  assert.equal(tween.tick(105), true);
  assert.deepEqual(values, [-3, 0, 0, 3]);
  tween.finish();
  assert.equal(completed, 1);
  const cancelled = new ArtemisLinearIntegerTween(
    revision,
    10,
    0,
    4,
    (value) => values.push(value),
    () => completed++,
  );
  cancelled.tick(100);
  cancelled.cancel();
  cancelled.finish();
  cancelled.tick(500);
  assert.equal(completed, 1);
  const zero = [];
  const sentinel = new ArtemisLinearIntegerTween(revision, 10, 0, 4, (value) => zero.push(value));
  sentinel.tick(0);
  sentinel.tick(1);
  sentinel.tick(3);
  sentinel.tick(5);
  assert.deepEqual(zero, [10, 10, 5, 0]);
  const wrap = [];
  const wrapping = new ArtemisLinearIntegerTween(revision, 0, 1000, 4, (value) => wrap.push(value));
  wrapping.tick(0xfffffffe);
  assert.equal(wrapping.tick(0xffffffff), true);
  assert.deepEqual(wrap, [0, 1000]);
});

test('Effect-manager gain suppression preserves device values and preparation collects inactive voices across managers', async () => {
  const a = await audioEffectFixture(),
    b = await audioEffectFixture();
  try {
    const id = await a.effects.prepareEffect('a', 0);
    a.effects.startEffect(id, 0, false);
    a.effects.setEffectGain(id, 0, 800);
    const before = a.gains[0].gain.value;
    a.effects.suppressGainUpdates(true);
    a.effects.setGroupGain(0);
    assert.equal(a.gains[0].gain.value, before);
    a.effects.suppressGainUpdates(false);
    a.effects.setGroupGain(1000);
    assert.equal(a.gains[0].gain.value, before);
    a.effects.stopEffect(id, 10);
    a.effects.tick(10);
    a.effects.tick(20);
    assert.equal(a.effects.count, 1);
    await b.effects.prepareEffect('b', 0);
    assert.equal(a.effects.count, 0);
    assert.equal(b.effects.count, 1);
    await a.effects.prepareEffect('c', 0);
    assert.equal(b.effects.count, 0); // Prepared but not playing.
  } finally {
    a.effects.close();
    a.transport.dispose();
    b.effects.close();
    b.transport.dispose();
  }
});

test('Voice-owner shutdown during real transport preparation releases the late resource and prevents a leaked voice', async () => {
  const {ArtemisEffectVoices} = await import('../dist/engines/artemis/effect-voices.js');
  let finish,
    disposed = 0;
  const gate = new Promise((resolve) => {
    finish = resolve;
  });
  const effects = new ArtemisEffectVoices(revision, {prepareVoice: () => gate});
  const operation = effects.prepareEffect('late', 0);
  await assert.rejects(effects.prepareEffect('overlap', 0), /Overlapping/);
  effects.close();
  finish({dispose: () => disposed++, setLoop() {}, stop() {}});
  await assert.rejects(operation, /closed/);
  assert.equal(disposed, 1);
  assert.equal(effects.count, 0);
  await assert.rejects(effects.prepareEffect('after', 0), /closed/);
});

test('lyevent registers tag callbacks, maintains history and propagates group enables', async () => {
  const {ArtemisLayerCommands} = await import('../dist/engines/artemis/layer-commands.js');
  const {ArtemisLayerEvents, ArtemisLayerEventSlots} =
    await import('../dist/engines/artemis/layer-events.js');
  const scene = new ArtemisScene(revision);
  const commands = new ArtemisLayerCommands(revision);
  const slots = new Map();
  const events = new ArtemisLayerEvents(scene, commands, {
    slots: (actor) => {
      if (!slots.has(actor)) slots.set(actor, new ArtemisLayerEventSlots());
      return slots.get(actor);
    },
  });
  const a = {name: 'a'},
    b = {name: 'b'};
  scene.set('600.3.0', a);
  scene.set('600.3.1', b);
  const tag = (args) => ({kind: 'tag', name: 'lyevent', args: new Map(args), sourceLine: 9});
  const click = tag([
    ['id', '600.3.0'],
    ['type', 'click'],
    ['mode', 'init'],
    ['handler', 'calllua'],
    ['function', 'btn_click'],
  ]);
  assert.equal(events.dispatch(click), true);
  const callback = slots.get(a).callback('click');
  assert.equal(callback.penetration, false);
  assert.equal(callback.command.args.get('function'), 'btn_click');
  assert.equal(slots.get(a).callback('rollout'), null);
  // Rollout/drag types always pass through; click/rollover only with penetration != "0".
  events.dispatch(tag([...click.args, ['type', 'rollover'], ['penetration', '1']]));
  assert.equal(slots.get(a).callback('rollover').penetration, true);
  events.dispatch(tag([...click.args, ['type', 'rollout'], ['penetration', '0']]));
  assert.equal(slots.get(a).callback('rollout').penetration, true);
  // A second init of the same type replaces the history entry; reset erases it.
  events.dispatch(tag([...click.args, ['function', 'other']]));
  const types = () => commands.commands('600.3.0').map((x) => x.args.get('type'));
  assert.deepEqual(types(), ['rollover', 'rollout', 'click']);
  events.dispatch(tag([...click.args, ['mode', 'reset']]));
  assert.equal(slots.get(a).callback('click'), null);
  assert.deepEqual(types(), ['rollover', 'rollout']);
  // Disable on a group reaches every child actor and records history for descendants.
  const disable = tag([
    ['id', '600.3'],
    ['type', 'rollover'],
    ['mode', 'disable'],
  ]);
  events.dispatch(disable);
  assert.equal(slots.get(a).isEnabled('rollover'), false);
  assert.equal(slots.get(b).isEnabled('rollover'), false);
  assert.equal(slots.get(a).isEnabled('click'), true);
  assert.equal(commands.commands('600.3').length, 1);
  assert.equal(commands.commands('600.3.1')[0].args.get('mode'), 'disable');
  events.dispatch(tag([...disable.args, ['mode', 'enable']]));
  assert.equal(slots.get(b).isEnabled('rollover'), true);
  assert.deepEqual(commands.commands('600.3'), []);
  assert.deepEqual(commands.commands('600.3.1'), []);
  // Replay applies state without touching history; absent layers and unknown types are ignored.
  events.dispatch(tag([...disable.args, ['id', '600.3.0']]), true);
  assert.equal(slots.get(a).isEnabled('rollover'), false);
  assert.deepEqual(types(), ['rollover', 'rollout']);
  assert.equal(events.dispatch(tag([...click.args, ['id', 'missing']])), true);
  assert.equal(events.dispatch(tag([...click.args, ['type', 'wheel']])), true);
  assert.equal(commands.commands('missing'), undefined);
});

test('Native trans commits, starts crossfade/rule tweens, tiles rule images and selects input run modes', async () => {
  const {ArtemisTransition, tileArtemisRule, artemisTransitionErrors} =
    await import('../dist/engines/artemis/transition.js');
  const tag = (args) => ({name: 'trans', args: new Map(Object.entries(args))});
  const log = [];
  let capture = 0,
    skip = {allowed: true, command: false, control: false},
    rule = null;
  const tweens = [];
  const stageRule = {width: 4, height: 3, bytesPerPixel: 1, pixels: new Uint8Array(12)};
  const transition = new ArtemisTransition(revision, {
    captureMode: () => capture,
    commit: () => log.push('commit'),
    enterRunMode: (mode) => log.push('mode' + mode),
    releaseRunMode: () => log.push('release'),
    now: () => 0x1_0000_0005,
    setWaitStart: (ms) => log.push('wait' + ms),
    skipState: () => skip,
    setTransitionState: (value) => log.push('state' + value),
    setCrossfade: (value) => log.push('fade' + value),
    stageSize: () => ({width: 4, height: 3}),
    loadRule: async (path) => (log.push('load ' + path), rule),
    setRuleImage: () => log.push('ruleImage'),
    ruleImage: () => stageRule,
    setVague: (value) => log.push('vague' + value),
    setRuleThreshold: (value) => log.push('threshold' + value),
    registerTween: (tween) => (tweens.push(tween), log.push('register')),
    reportError: (_tag, message) =>
      log.push(message === artemisTransitionErrors.ruleLoad ? 'loadError' : 'formatError'),
  });
  assert.equal(transition.dispatch({name: 'flip', args: new Map()}), false);
  assert.equal(transition.dispatch(tag({type: '0'})), true);
  assert.deepEqual(log.splice(0), ['commit', 'mode4', 'wait5']);
  assert.equal(transition.dispatch(tag({type: '1', time: '4', input: '1'})), true);
  assert.deepEqual(log.splice(0), ['state1', 'fade0', 'register', 'mode2']);
  tweens[0].tick(10);
  tweens[0].tick(11);
  tweens[0].tick(14);
  assert.deepEqual(log.splice(0), ['fade0', 'fade0.25', 'fade1', 'commit', 'release']);
  transition.dispatch(tag({type: '1', input: '0'}));
  assert.equal(log.at(-1), 'mode4');
  transition.dispatch(tag({type: '1', input: '2'}));
  assert.equal(log.at(-1), 'mode4');
  skip = {allowed: true, command: false, control: true};
  transition.dispatch(tag({type: '1', input: '2'}));
  assert.equal(log.at(-1), 'mode2');
  log.length = 0;
  await transition.dispatch(tag({type: '2', rule: 'r', vague: '64'}));
  assert.deepEqual(log.splice(0), ['load r', 'loadError']);
  rule = {width: 3, height: 2, bytesPerPixel: 1, format: 1, pixels: new Uint8Array(6)};
  await transition.dispatch(tag({type: '2', rule: 'r'}));
  assert.deepEqual(log.splice(0), ['load r', 'formatError']);
  rule = {
    width: 3,
    height: 2,
    bytesPerPixel: 1,
    format: 0,
    pixels: Uint8Array.of(1, 2, 3, 4, 5, 6),
  };
  await transition.dispatch(tag({type: '2', rule: 'r', vague: '64', time: '10'}));
  assert.deepEqual(stageRule.pixels, Uint8Array.of(1, 2, 3, 1, 4, 5, 6, 4, 1, 2, 3, 1));
  assert.deepEqual(log.splice(0), [
    'load r',
    'state2',
    'vague64',
    'threshold-64',
    'register',
    'mode2',
  ]);
  const ruleTween = transition.tween;
  assert.equal(ruleTween, tweens.at(-1));
  ruleTween.finish();
  assert.deepEqual(log.splice(0), ['threshold319', 'commit', 'release']);
  rule = {width: 4, height: 3, bytesPerPixel: 1, format: 0, pixels: new Uint8Array(12)};
  await transition.dispatch(tag({type: '2', rule: 'r'}));
  assert.equal(log[1], 'ruleImage');
  log.length = 0;
  assert.equal(transition.dispatch(tag({type: '3'})), true);
  capture = 1;
  assert.equal(transition.dispatch(tag({type: '0'})), true);
  assert.deepEqual(log, []);
  const target = {width: 2, height: 1, bytesPerPixel: 2, pixels: new Uint8Array(4)};
  tileArtemisRule(target, {
    width: 3,
    height: 1,
    bytesPerPixel: 2,
    pixels: Uint8Array.of(9, 8, 7, 6, 5, 4),
  });
  assert.deepEqual(target.pixels, Uint8Array.of(9, 8, 7, 6));
});

test('Native PNG surfaces keep gray images as one-byte format 0 rule images', async () => {
  const {artemisPngSurface} = await import('../dist/engines/artemis/png-surface.js');
  const {decodePng} = await import('../dist/formats/png/decode.js');
  const {png, chunk} = await import('./png-fixtures.mjs');
  const surface = async (options) => artemisPngSurface(await decodePng(png(options)));
  // 2-bit gray expands by bit replication; tRNS does not reach the gray bytes.
  const low = await surface({
    width: 4,
    height: 1,
    depth: 2,
    type: 0,
    raw: Buffer.from([0, 0b00011011]),
    extras: [chunk('tRNS', Buffer.from([0, 1]))],
  });
  assert.deepEqual(
    {format: low.format, bytesPerPixel: low.bytesPerPixel, pixels: [...low.pixels]},
    {format: 0, bytesPerPixel: 1, pixels: [0, 85, 170, 255]},
  );
  const deep = await surface({
    width: 2,
    height: 1,
    depth: 16,
    type: 0,
    raw: Buffer.from([0, 0x12, 0xff, 0xab, 0x01]),
  });
  assert.deepEqual([...deep.pixels], [0x12, 0xab]);
  for (const [type, raw] of [
    [2, [0, 1, 2, 3]],
    [4, [0, 7, 9]],
  ]) {
    const color = await surface({width: 1, height: 1, type, raw: Buffer.from(raw)});
    assert.deepEqual([color.format, color.bytesPerPixel, color.pixels.length], [2, 4, 4]);
  }
});

test('Layer event slots invoke the stored callback functor with the type index and force', async () => {
  const {ArtemisLayerEventSlots} = await import('../dist/engines/artemis/layer-events.js');
  const slots = new ArtemisLayerEventSlots();
  const emitted = [];
  const sink = {
    emit: (command, mode, force) => emitted.push([command.args.get('function'), mode, force]),
  };
  assert.equal(slots.invoke('click', sink), false);
  const command = {name: 'lyevent', args: new Map([['function', 'f']])};
  slots.setCallback(2, {command, penetration: true});
  assert.equal(slots.invoke('rollout', sink), true);
  command.args.set('function', 'changed');
  slots.invoke('rollout', sink);
  assert.deepEqual(emitted, [
    ['f', 2, true],
    ['f', 2, true],
  ]);
});

test('Artemis tween curves start at b and end at b + c; ease names map to native ids', async () => {
  const {artemisEase, artemisEaseId} = await import('../dist/engines/artemis/tween.js');
  for (let ease = 0; ease <= 31; ease++) {
    assert.ok(Math.abs(artemisEase(ease, 0, 3, 8, 200) - 3) < 1e-5, `start ${ease}`);
    assert.ok(Math.abs(artemisEase(ease, 200, 3, 8, 200) - 11) < 1e-5, `end ${ease}`);
  }
  assert.equal(artemisEase(1, 100, 0, 8, 200), 2);
  assert.equal(artemisEase(29, 50, 0, 8, 200), 0.25 * 7.5625 * 0.25 * 8);
  assert.equal(artemisEase(31, 50, 0, 8, 200), 2);
  assert.ok(artemisEase(22, 20, 0, 100, 200) < 0, 'back overshoots below the start');
  assert.deepEqual(
    ['easein_quad', 'easeout_quad', 'easeinout_bounce', 'linear', undefined].map(artemisEaseId),
    [1, 2, 30, 0, 0],
  );
});

test('Artemis tweens honor delay, yoyo reversal, loop delay and loop overshoot', async () => {
  const {ArtemisFloatTween} = await import('../dist/engines/artemis/tween.js');
  const run = (options, ticks) => {
    const values = [];
    let completions = 0;
    const tween = new ArtemisFloatTween(
      revision,
      0,
      10,
      100,
      (value) => values.push(value),
      () => completions++,
      options,
    );
    const results = ticks.map((now) => tween.tick(now));
    return {
      values,
      results,
      tween,
      get completions() {
        return completions;
      },
    };
  };
  const yoyo = run({delay: 50, yoyo: 1}, [1000, 1100, 1150, 1200, 1250]);
  assert.deepEqual(yoyo.values, [0, 5, 10, 5, 0]);
  assert.deepEqual(yoyo.results, [false, false, false, false, true]);
  assert.equal(yoyo.completions, 1);
  assert.deepEqual(run({loop: 1, loopDelay: 20}, [10, 110, 180, 240]).values, [0, 0, 5, 10]);
  const forever = run({loop: -1}, [10, 135]);
  assert.deepEqual(forever.values, [0, 2.5]);
  assert.equal(forever.tween.done, false);
  // Finishing with an odd yoyo count pending ends on the start value.
  const pending = run({yoyo: 3}, [10]);
  pending.tween.finish();
  assert.deepEqual(pending.values, [0, 0]);
  assert.equal(pending.completions, 1);
});

test('Artemis tween registry defers registrations made while stepping', async () => {
  const {ArtemisTweenRegistry} = await import('../dist/engines/artemis/tween.js');
  const registry = new ArtemisTweenRegistry(revision),
    log = [];
  const later = {
    tick: (now) => (log.push(['later', now]), false),
    finish: () => log.push('finish'),
  };
  const first = {
    tick(now) {
      log.push(['first', now]);
      log.push(['registered', registry.register(later)]);
      return true;
    },
    finish() {},
  };
  assert.equal(registry.register(first), 0);
  registry.tick(5);
  assert.deepEqual(log, [
    ['first', 5],
    ['registered', 1],
  ]);
  assert.equal(registry.size, 1);
  registry.tick(6);
  registry.finish(1);
  registry.finish(99);
  assert.deepEqual(log.slice(2), [['later', 6], 'finish']);
});

test('Artemis lytween animates current and retained actors, then syncs, deletes, emits and records', async () => {
  const {ArtemisLayerTweens} = await import('../dist/engines/artemis/layer-tweens.js');
  const {ArtemisLayerCommands} = await import('../dist/engines/artemis/layer-commands.js');
  const {ArtemisTweenRegistry} = await import('../dist/engines/artemis/tween.js');
  const image = await syntheticImage();
  const {layers} = await layerFixture(async (path) => (path === 'synthetic.png' ? image : null));
  const commands = new ArtemisLayerCommands(revision),
    registry = new ArtemisTweenRegistry(revision),
    log = [];
  const tweens = new ArtemisLayerTweens(revision, layers.scene, registry, commands, {
    applyImageProperties: (id, actor, patch) => log.push([id, actor.number, patch]),
    layerNotFound: (tag) => log.push(['missing', tag.args.get('id')]),
    enterRunMode: (mode) => log.push(['mode', mode]),
    endSyncWait: () => log.push(['syncEnd']),
    deleteLayer: (tag, recordHistory) => {
      log.push(['delete', tag.args.get('id'), recordHistory]);
      layers.deleteLayer(tag.args.get('id'), recordHistory);
    },
    emitEvent: (tag) => log.push(['event', tag.args.get('label')]),
    recordLayerProperties: (tag) => log.push(['lyprop', Object.fromEntries(tag.args)]),
  });
  const take = () => log.splice(0);
  try {
    await layers.dispatch(command('lyc', {id: 'bg', file: 'synthetic'}));
    layers.commit();
    await layers.dispatch(command('lyprop', {id: 'bg', left: '1'}));
    assert.equal(tweens.dispatch(command('unrelated')), false);
    tweens.dispatch(
      command('lytween', {
        id: 'bg',
        param: 'alpha',
        from: '255',
        to: '0',
        time: '100',
        ease: 'easein_quad',
        sync: '1',
      }),
    );
    // The edited copy (2) and the retained original (1) both receive the start value.
    assert.deepEqual(take(), [
      ['bg', 2, {alpha: 1}],
      ['bg', 1, {alpha: 1}],
      ['mode', 4],
      ['lyprop', {id: 'bg', alpha: '0'}],
    ]);
    registry.tick(1000);
    registry.tick(1050);
    registry.tick(1100);
    assert.deepEqual(
      take().filter((entry) => entry[1] === 2 || entry[0] === 'syncEnd'),
      [['bg', 2, {alpha: 1}], ['bg', 2, {alpha: 0.75}], ['bg', 2, {alpha: 0}], ['syncEnd']],
    );

    tweens.dispatch(command('lytween', {id: 'bg', param: 'blur', from: '1', to: '2'}));
    tweens.dispatch(command('lytween', {id: 'none', param: 'left'}));
    assert.deepEqual(take(), [['missing', 'none']]);
    tweens.dispatch(
      command('lytween', {id: 'bg', param: 'xscale', from: '300', to: '100', delete: ''}),
    );
    assert.deepEqual(
      commands.commands('bg').map((tag) => tag.args.get('time')),
      [''],
      'absent time is inserted before the command is appended',
    );
    take();
    registry.tick(2000);
    registry.tick(2001);
    assert.deepEqual(take().slice(-3), [
      ['bg', 2, {xscale: 1}],
      ['bg', 1, {xscale: 1}],
      ['delete', 'bg', true],
    ]);
    assert.equal(layers.scene.entry('bg'), undefined);

    await layers.dispatch(command('lyc', {id: 'fg', file: 'synthetic'}));
    layers.commit();
    tweens.dispatch(
      command('lytween', {
        id: 'fg',
        param: 'top',
        from: '0',
        to: '10',
        time: '1000',
        yoyo: '1',
        label: 'done',
      }),
    );
    tweens.dispatch(command('lytween', {id: 'fg', param: 'left', from: '4', to: '8', loop: '-1'}));
    assert.deepEqual(
      take().filter((entry) => entry[0] === 'lyprop'),
      [['lyprop', {id: 'fg', top: '0'}]],
    );
    assert.equal(commands.commands('fg').length, 1);
    tweens.dispatch(command('lytweendel', {id: 'fg'}));
    assert.deepEqual(take(), [
      ['fg', 3, {top: 0}],
      ['event', 'done'],
      ['fg', 3, {left: 8}],
    ]);
    assert.deepEqual(commands.commands('fg'), []);
    registry.tick(3000);
    assert.equal(registry.size, 0);
  } finally {
    layers.close();
  }
});

test('Artemis drops silent layer tweens once their layer node is destroyed', async () => {
  const {ArtemisLayerTweens} = await import('../dist/engines/artemis/layer-tweens.js');
  const {ArtemisLayerCommands} = await import('../dist/engines/artemis/layer-commands.js');
  const {ArtemisTweenRegistry} = await import('../dist/engines/artemis/tween.js');
  const image = await syntheticImage();
  const {layers} = await layerFixture(async (path) => (path === 'synthetic.png' ? image : null));
  const registry = new ArtemisTweenRegistry(revision),
    log = [];
  const tweens = new ArtemisLayerTweens(
    revision,
    layers.scene,
    registry,
    new ArtemisLayerCommands(revision),
    {
      applyImageProperties: (id, actor, patch) => log.push([id, actor.number, patch]),
      layerNotFound: () => {},
      enterRunMode: () => {},
      endSyncWait: () => {},
      deleteLayer: () => {},
      emitEvent: (tag) => log.push(['event', tag.args.get('label')]),
      recordLayerProperties: () => {},
    },
  );
  const spin = {id: 'g', param: 'rotate', from: '0', to: '360', time: '4000', loop: '-1'};
  try {
    await layers.dispatch(command('lyc', {id: 'g', file: 'synthetic'}));
    layers.commit();
    tweens.dispatch(command('lytween', spin));
    tweens.dispatch(command('lytween', {...spin, loop: '0', time: '100', label: 'end'}));
    registry.tick(1000);
    assert.equal(registry.size, 2);
    // Recreating the layer replaces its node; the old node stays reachable from the
    // retained tree until the commit.
    await layers.dispatch(command('lyc', {id: 'g', file: 'synthetic'}));
    tweens.dispatch(command('lytween', spin));
    registry.tick(1010);
    assert.equal(registry.size, 3);
    layers.commit();
    log.splice(0);
    registry.tick(1020);
    // Only the looping tween without a completion effect on the destroyed node is gone;
    // the labelled one still runs its completion on its own schedule.
    assert.equal(registry.size, 2);
    registry.tick(1200);
    assert.deepEqual(
      log.filter((entry) => entry[0] === 'event'),
      [['event', 'end']],
    );
    assert.equal(registry.size, 1);
    // The live layer's looping tween keeps animating it.
    log.splice(0);
    registry.tick(2010);
    assert.deepEqual(
      log.map((entry) => entry[2]),
      [{rotate: Math.fround(90)}],
    );
  } finally {
    layers.close();
  }
});

test('Artemis tween groups queue layer tweens, play them in order and share one registry id', async () => {
  const {ArtemisLayerTweens} = await import('../dist/engines/artemis/layer-tweens.js');
  const {ArtemisLayerCommands} = await import('../dist/engines/artemis/layer-commands.js');
  const {ArtemisTweenRegistry} = await import('../dist/engines/artemis/tween.js');
  const image = await syntheticImage();
  const {layers} = await layerFixture(async (path) => (path === 'synthetic.png' ? image : null));
  const registry = new ArtemisTweenRegistry(revision),
    log = [];
  const tweens = new ArtemisLayerTweens(
    revision,
    layers.scene,
    registry,
    new ArtemisLayerCommands(revision),
    {
      applyImageProperties: (id, actor, patch) => log.push([id, patch]),
      layerNotFound: (tag) => log.push(['missing', tag.args.get('id')]),
      enterRunMode: () => {},
      endSyncWait: () => {},
      deleteLayer: () => {},
      emitEvent: (tag) => log.push(['event', tag.args.get('label')]),
      recordLayerProperties: (tag) => log.push(['lyprop', Object.fromEntries(tag.args)]),
    },
  );
  const take = () => log.splice(0);
  try {
    for (const id of ['a', 'b']) {
      await layers.dispatch(command('lyc', {id, file: 'synthetic'}));
      layers.commit();
    }
    take();
    tweens.dispatch(command('tweenset'));
    tweens.dispatch(command('lytween', {id: 'a', param: 'left', from: '0', to: '10', time: '10'}));
    tweens.dispatch(command('tweenset'));
    tweens.dispatch(
      command('lytween', {id: 'b', param: 'top', from: '0', to: '20', time: '10', label: 'x'}),
    );
    tweens.dispatch(command('lytween', {id: 'none', param: 'left'}));
    // No start value is applied and nothing is registered while the group is open;
    // the end-state history is still recorded.
    assert.deepEqual(take(), [
      ['lyprop', {id: 'a', left: '10'}],
      ['lyprop', {id: 'b', top: '20'}],
      ['missing', 'none'],
    ]);
    assert.equal(registry.size, 0);
    tweens.dispatch(command('/tweenset'));
    tweens.dispatch(command('/tweenset'));
    assert.equal(registry.size, 1);
    registry.tick(100);
    registry.tick(110);
    // The second tween starts on the step that destroys the first.
    assert.deepEqual(take(), [
      ['a', {left: 0}],
      ['a', {left: 10}],
      ['b', {top: 0}],
    ]);
    // Deleting the tweens of either layer finishes the whole queue in order.
    tweens.dispatch(command('lytweendel', {id: 'b'}));
    assert.deepEqual(take(), [
      ['b', {top: 20}],
      ['event', 'x'],
    ]);
    registry.tick(120);
    assert.equal(registry.size, 0);
  } finally {
    layers.close();
  }
});

test('Artemis text layers give browser text their characters, stage placement and slots; hidden text draws no glyphs but still hits', async () => {
  const {createArtemisBrowserLayers} = await import('../dist/engines/artemis/browser/layers.js');
  const {artemisTextSlots, artemisFitTextRows} =
    await import('../dist/engines/artemis/browser/dom-text.js');
  const {createArtemisImageLoader} = await import('../dist/engines/artemis/image-loader.js');
  const {artemisDefaultFontAttributes} = await import('../dist/engines/artemis/font-state.js');
  const {png} = await import('./png-fixtures.mjs');
  // An opaque 20x20 image for covering the text.
  const cover = png({
    width: 20,
    height: 20,
    raw: Buffer.concat(
      Array.from({length: 20}, () => Buffer.from([0, ...Array(20).fill([9, 9, 9, 255]).flat()])),
    ),
  });
  const font = {
    ...artemisDefaultFontAttributes(revision),
    face: 'font/a.ttf\0',
    rubyface: 'font/r.ttf',
    left: 4,
    top: 6,
    size: 20,
    rubysize: 8,
    outline: 2,
    shadow: 1,
    color: 0x123456,
  };
  const ink = {width: 2, height: 2, pixels: new Uint8Array(16).fill(255)};
  const glyph = (character, x, advance, image = ink) => ({
    x,
    y: 10,
    advance,
    glyph: {
      codePoint: character.codePointAt(0),
      surface: {image, left: 1, top: 3, advance},
      font,
    },
  });
  // Two words on two lines: a word with ruby, and a space without ink before a word.
  const blocks = [
    {main: [glyph('文', 0, 25), glyph('字', 25, 25)], ruby: [{...glyph('も', 0, 10), y: 0}]},
    {main: [glyph(' ', 0, 12, null), glyph('a', 12, 15)], ruby: []},
  ];
  let busy = false;
  const insertion = {
    get busy() {
      return busy;
    },
    displayLines: () => [
      {y: 0, geometry: {blocks: [{x: 5, y: 0, block: blocks[0]}]}},
      {y: 40, geometry: {blocks: [{x: 0, y: 0, block: blocks[1]}]}},
    ],
  };
  const message = {};
  const draws = [];
  const target = {
    width: 200,
    height: 100,
    prepareImage() {},
    prepareRenderSurface() {},
    invalidate() {},
    draw() {},
  };
  const {owner, graphics} = createArtemisBrowserLayers({
    executableSha256: revision,
    target,
    raster: {filter: 'nearest', blend: straightBlend, layerMode: () => undefined},
    images: createArtemisImageLoader(revision, async () => cover),
    runMode: {},
    loadRule: async () => null,
    readVideoFile: async () => null,
    clock: {now: () => 1},
    glyphs: {peek: (resource) => (resource === message ? insertion : undefined)},
    textProperties: () => undefined,
    report: (text) => assert.fail(text),
  });
  owner.attachMessageActor('1', message, {retain() {}, release() {}});
  await owner.layers.dispatch(command('lyprop', {id: '1', left: '100', top: '20', alpha: '128'}));
  owner.layers.commit();
  const [layer, ...others] = graphics.textLayers(owner.layers.scene);
  assert.equal(others.length, 0);
  assert.equal(layer.id, '1');
  assert.equal(layer.alpha, Math.fround(128 / 255));
  assert.deepEqual([layer.matrix[2], layer.matrix[5]], [100, 20]);
  const cells = layer.text.cells();
  assert.deepEqual(
    cells.map((cell) => [cell.text, cell.ruby, cell.line, cell.block]),
    [
      ['文', false, 0, 0],
      ['字', false, 0, 0],
      ['も', true, 0, 0],
      [' ', false, 1, 1],
      ['a', false, 1, 1],
    ],
  );
  // A cell is the sprite without the painted surface offset; ink-less cells have no sprite.
  const sprites = layer.text.sprites();
  assert.equal(sprites.length, 4);
  for (const [index, cell] of cells.filter((cell) => cell.text !== ' ').entries()) {
    assert.equal(sprites[index].matrix[2], cell.matrix[2] + 1);
    assert.equal(sprites[index].matrix[5], cell.matrix[5] + 3);
  }
  assert.deepEqual(
    [cells[1].matrix[2], cells[1].matrix[5], cells[1].size, cells[1].face, cells[2].face],
    [4 + 5 + 25, 6 + 10, 20, 'font/a.ttf', 'font/r.ttf'],
  );
  // While an insertion loads, the text from before it stays.
  busy = true;
  blocks.length = 0;
  assert.equal(layer.text.cells().length, 5);
  busy = false;
  blocks.push(
    {main: [glyph('文', 0, 25), glyph('字', 25, 25)], ruby: [{...glyph('も', 0, 10), y: 0}]},
    {main: [glyph(' ', 0, 12, null), glyph('a', 12, 15)], ruby: []},
  );

  const stage = {width: 200, height: 100};
  assert.deepEqual(layer.covers, []);
  const slots = artemisTextSlots('t', layer, cells, stage);
  assert.deepEqual(
    slots.map(({slot, face}) => [
      slot.id,
      face,
      slot.interactive ?? true,
      slot.glyphs.map((g) => g.text).join(''),
    ]),
    [
      ['t-0', 'font/a.ttf', true, '文字 a'],
      ['t-ruby-0', 'font/r.ttf', false, 'も'],
    ],
  );
  // A change of font size or face starts another slot.
  assert.deepEqual(
    artemisTextSlots(
      't',
      layer,
      cells.map((cell) => (cell.text === 'a' ? {...cell, size: 10} : cell)),
      stage,
    ).map(({slot}) => [slot.id, slot.glyphs.length]),
    [
      ['t-0', 3],
      ['t-3', 1],
      ['t-ruby-0', 1],
    ],
  );
  const first = slots[0].slot.glyphs[0];
  // The em box lies inside the outline; the shadow and outline follow the font.
  assert.deepEqual(
    [first.x, first.y, first.width, first.height, first.line, first.color, first.alpha],
    [100 + 4 + 5 + 2, 20 + 6 + 10 + 2, 25 - 4 - 1, 20, 0, 0x123456, 128],
  );
  assert.deepEqual(first.shadows, [{x: 1, y: 1, color: 0, alpha: 255}]);
  assert.equal(first.outline.radiusX, 2);
  assert.equal(slots[0].slot.glyphs[3].line, 1);
  // Text the stage does not draw has no slots: outside the stage or the layer's clip.
  const moved = (x, clip = null) => ({...layer, matrix: Float32Array.of(1, 0, x, 0, 1, 20), clip});
  assert.deepEqual(artemisTextSlots('t', moved(500), cells, stage), []);
  assert.deepEqual(
    artemisTextSlots('t', moved(100, {x: 0, y: 0, width: 50, height: 100}), cells, stage),
    [],
  );
  const ruby = slots[1].slot.glyphs[0];
  const placed = (shown) =>
    shown.map(({slot}) => [slot.id, slot.glyphs.map((g) => [g.text, g.x, g.y, g.line])]);
  // Partly shown text moves inside: each line starts at the left edge, the ruby with its word.
  assert.deepEqual(placed(artemisTextSlots('t', moved(-30), cells, stage)), [
    [
      't-0',
      [
        ['文', 0, 38, 0],
        ['字', 25, 38, 0],
        [' ', 0, 78, 1],
        ['a', 12, 78, 1],
      ],
    ],
    ['t-ruby-0', [['も', ruby.x - 130 + 19, ruby.y, 0]]],
  ]);
  // Past the right edge a line wraps at its start, the following lines move down, and text
  // ending below the stage moves up.
  assert.deepEqual(placed(artemisTextSlots('t', moved(170), cells, stage)), [
    [
      't-0',
      [
        ['文', 180, 0, 0],
        ['字', 180, 40, 1],
        [' ', 176, 80, 2],
        ['a', 188, 80, 2],
      ],
    ],
    ['t-ruby-0', [['も', ruby.x + 70 - 1, ruby.y - 38, 0]]],
  ]);
  // A row breaks before the word that crosses the edge; added rows take the closest line
  // pitch.
  const row = (x, block, line = 0, y = 0) => ({
    cell: {line, block},
    glyph: {id: x, x, y, width: 10, height: 10, text: 'x', line, color: 0, alpha: 255},
  });
  const words = [row(170, 0), row(180, 1), row(190, 1), row(0, 2, 1, 12), row(0, 3, 2, 42)];
  assert.deepEqual(
    artemisFitTextRows(
      words.map((w) => w.glyph),
      words.map((w) => w.cell),
      {left: 0, top: 0, right: 195, bottom: 100},
    ).glyphs.map((g) => [g.x, g.y, g.line]),
    [
      [170, 0, 0],
      [170, 12, 1],
      [180, 12, 1],
      [0, 24, 2],
      [0, 54, 3],
    ],
  );

  // An image layer drawn over the text hides the characters under it, in proportion to its
  // opacity at the em box centre; text under other blend modes stays.
  await owner.layers.dispatch(command('lyc', {id: '2', file: 'cover.png'}));
  await owner.layers.dispatch(command('lyprop', {id: '2', left: '112', top: '40'}));
  owner.layers.commit();
  const covered = () => {
    const [over] = graphics.textLayers(owner.layers.scene);
    return {
      covers: over.covers.map((c) => [c.id, c.width, c.height]),
      alpha: artemisTextSlots('t', over, over.text.cells(), stage)[0].slot.glyphs.map(
        (g) => g.alpha,
      ),
    };
  };
  assert.deepEqual(covered(), {covers: [['2', 20, 20]], alpha: [0, 128, 128, 128]});
  await owner.layers.dispatch(command('lyprop', {id: '2', alpha: '64'}));
  owner.layers.commit();
  assert.deepEqual(covered().alpha, [
    Math.round(Math.fround(128 / 255) * (1 - Math.fround(64 / 255)) * 255),
    128,
    128,
    128,
  ]);
  await owner.layers.dispatch(command('lyprop', {id: '2', alpha: '255', layermode: 'add'}));
  owner.layers.commit();
  assert.deepEqual(covered(), {covers: [], alpha: [128, 128, 128, 128]});
  await owner.layers.dispatch(command('lydel', {id: '2'}));
  owner.layers.commit();

  const triangles = () =>
    draws.at(-1).commands.filter((entry) => entry.kind === 'triangles').length;
  draws.push(graphics.drawStage(owner.layers.scene, owner.presentation));
  // The stage presentation adds its own quad.
  const shown = triangles();
  graphics.hideText(true);
  draws.push(graphics.drawStage(owner.layers.scene, owner.presentation));
  assert.equal(shown - triangles(), 4);
  const [x, y] = [sprites[0].matrix[2] + 100, sprites[0].matrix[5] + 20];
  assert.deepEqual(graphics.hitTest(owner.layers.scene, x, y), ['1']);
  graphics.hideText(false);
  draws.push(graphics.drawStage(owner.layers.scene, owner.presentation));
  assert.equal(triangles(), shown);
  // Hidden layers have no browser text.
  await owner.layers.dispatch(command('lyprop', {id: '1', visible: '0'}));
  owner.layers.commit();
  assert.deepEqual(graphics.textLayers(owner.layers.scene), []);
});

test('get_layer_info reads an empty group as a CLayer without a surface', async () => {
  const {artemisLayerInfoFields} = await import('../dist/engines/artemis/layer-info.js');
  const owner = await browserLayerOwner();
  await owner.layers.dispatch(command('lyc', {id: '1.g.a', file: 'a.png'}));
  await owner.layers.dispatch(
    command('lyprop', {id: '1.g', left: '7', anchorx: '5', alpha: '128'}),
  );
  const info = owner.layerInfo('1.g');
  assert.equal(info.surface, null);
  assert.deepEqual([info.width, info.height], [0, 0]);
  const fields = new Map(artemisLayerInfoFields(info));
  assert.deepEqual(
    ['left', 'width', 'height', 'alpha', 'anchorx', 'surfacewidth', 'clip', 'layermode'].map(
      (key) => fields.get(key),
    ),
    ['7', '0', '0', '128', '5', undefined, '0,0,0,0', '0'],
  );
  // The image child keeps its surface.
  assert.notEqual(owner.layerInfo('1.g.a').surface, null);
});

test(
  'Nonvisual surface preload decodes actual JPEG pixels without a browser canvas',
  {skip: !process.env.ARTEMIS_PROBE_PYTHON},
  async () => {
    const {createArtemisSurfacePreloadFixture} =
      await import('../tools/artemis-surface-preload-fixture.mjs');
    const {decodeNodeOpaqueJpeg} = await import('../tools/node-opaque-jpeg.mjs');
    const bytes = Buffer.from(
      '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAABAAIDAREAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD8V6/jc/0AP//Z',
      'base64',
    );
    const image = await decodeNodeOpaqueJpeg(bytes);
    assert.deepEqual([image.width, image.height, image.format], [2, 1, 2]);
    for (let i = 0; i < 2; i++) {
      for (let c = 0; c < 3; c++)
        assert.ok(Math.abs(image.pixels[i * 4 + c] - [120, 60, 30][c]) <= 2);
      assert.equal(image.pixels[i * 4 + 3], 255);
    }
    const fixture = createArtemisSurfacePreloadFixture(revision, async (p) =>
      p === 'synthetic.jpg' ? bytes : null,
    );
    try {
      fixture.manager.bindSurfaceAsync('synthetic');
      await fixture.manager.waitForLoads();
      const summary = fixture.summary();
      assert.equal(summary.decodedImages, 1);
      assert.equal(summary.failures.length, 0);
      assert.equal(summary.gameVisualAssetsDisplayed, false);
      assert.deepEqual([summary.samples[0].width, summary.samples[0].height], [2, 1]);
    } finally {
      await fixture.close();
    }
    await assert.rejects(() => decodeNodeOpaqueJpeg(Uint8Array.of(255, 216, 255, 217)));
  },
);

test('DX9 blur source variants keep masks at Fore UV and composite Back alpha before replacing the target', async () => {
  const {artemisDx9ShaderShade: shade, artemisDx9ShaderFragmentSource: fragment} =
    await import('../dist/engines/artemis/dx9-shader.js');
  const f = Math.fround;
  for (const axis of ['h', 'v']) {
    for (const suffix of ['plain', 'mask', 'aa', 'mask_aa']) {
      const kind = `blur_${axis}_${suffix}`;
      const samples = [],
        masks = [],
        backgrounds = [];
      const p = {
        alpha: 0.5,
        weights: [0.5, 0.25, 0, 0, 0, 0, 0, 0],
        step: 0.125,
        mask: (u, v) => {
          masks.push([u, v]);
          return [0.99, 0, 0, 0.5];
        },
        back: (u, v) => {
          backgrounds.push([u, v]);
          return [0.75, 0.25, 0, 0.5];
        },
        backUV: [0.75, 0.875],
      };
      const actual = shade(
        kind,
        (u, v) => {
          samples.push([u, v]);
          return [0.25, 0.5, 0.75, 0.5];
        },
        0.25,
        0.5,
        p,
      );
      const masked = suffix.includes('mask'),
        aa = suffix.endsWith('aa');
      const expected = aa
        ? masked
          ? [f(23 / 36), f(11 / 36), f(1 / 6), 0.5625]
          : [f(0.55), f(0.35), f(0.3), 0.625]
        : [0.25, 0.5, 0.75, masked ? 0.125 : 0.25];
      assert.deepEqual(actual, expected);
      assert.equal(samples.length, 15);
      assert.deepEqual(samples[1], axis === 'h' ? [0.375, 0.5] : [0.25, 0.625]);
      assert.deepEqual(samples[2], axis === 'h' ? [0.125, 0.5] : [0.25, 0.375]);
      assert.deepEqual(masks, masked ? [[0.25, 0.5]] : []);
      assert.deepEqual(backgrounds, aa ? [[0.75, 0.875]] : []);
      const source = fragment(kind);
      assert.equal(source.includes('texture(uMask,vUv).a'), masked);
      assert.equal(source.includes('texture(uBack,vBackUv)'), aa);
      if (aa) assert.throws(() => shade(kind, () => [0, 0, 0, 1], 0, 0, {alpha: 1}), /background/);
    }
  }
});

test('DX9 AA blur capture binds independent background UV and disables blending for its composited output', async () => {
  const {ARTEMIS_2868_EXECUTABLE_SHA256: hash} =
    await import('../dist/engines/artemis/revision.js');
  const {ArtemisImageGraphics} = await import('../dist/engines/artemis/image-graphics.js');
  const {ArtemisLayers} = await import('../dist/engines/artemis/layers.js');
  const {ArtemisDrawShaderResource} = await import('../dist/engines/artemis/draw-shader.js');
  const {createArtemisOrdinaryGpuRaster} = await import('../dist/engines/artemis/gpu-raster.js');
  const tag = (name, args) => ({name, args: new Map(Object.entries(args))});
  const replace = {source: 'one', destination: 'zero', operation: 'add'};
  for (const kind of ['blur_h_plain', 'blur_v_mask', 'blur_h_aa', 'blur_v_mask_aa']) {
    const shader = new ArtemisDrawShaderResource(hash, kind, () => {});
    const graphics = new ArtemisImageGraphics(
      hash,
      {
        width: 3,
        height: 2,
        prepareImage() {},
        prepareRenderSurface() {},
        invalidate() {},
        draw() {},
      },
      {
        creationMode: () => 0,
        clearLayerCommands() {},
        resetLayerCommands() {},
        recordLayerProperties() {},
        imageLoadFailed: () => assert.fail('missing image'),
        layerNotFound: () => assert.fail('missing layer'),
      },
      createArtemisOrdinaryGpuRaster(hash),
      {bind: () => ({shader, release() {}})},
    );
    const image = {
      width: 2,
      height: 1,
      pixels: new Uint8Array([100, 20, 30, 128, 40, 50, 60, 128]),
    };
    const layers = new ArtemisLayers(
      hash,
      {load: async (path) => ({path, image, surfaceFormat: 2})},
      graphics,
    );
    try {
      await layers.dispatch(tag('lyc', {id: '1', file: 'background'}));
      await layers.dispatch(tag('lyprop', {id: '1', layermode: 'add'}));
      await layers.dispatch(tag('lyc', {id: '2.a', file: 'foreground'}));
      await layers.dispatch(
        tag('lyprop', {
          id: '2.a',
          left: '0.5',
          shader: 'blur',
          shaderconstant: 'weights,width,height',
          weights: '0.5,0.25,0,0,0,0,0,0',
          width: '0.125',
          height: '0.25',
        }),
      );
      await layers.dispatch(tag('lyprop', {id: '2', intermediate_render: '1', clip: '0,0,3,2'}));
      layers.commit();
      const command = graphics
        .drawCommitted(layers.scene)
        .commands.find((c) => c.kind === 'triangles' && c.parameters);
      assert.ok(command);
      assert.deepEqual(Array.from(command.parameters.slice(0, 9)), [
        0.5,
        0.25,
        0,
        0,
        0,
        0,
        0,
        0,
        kind.startsWith('blur_h') ? 0.125 : 0.25,
      ]);
      assert.equal(command.filter, 'linear');
      assert.equal(command.additionalTextures[0].filter, 'nearest');
      if (kind.endsWith('_aa')) {
        assert.deepEqual(command.blendState, {color: replace, alpha: replace});
        assert.ok(command.fragment.includes('texture(additionalAtlas0,additionalUV0)'));
        assert.ok(command.additionalTextures[0].uv.some((x) => x > 0 && x < 1));
        assert.notDeepEqual(
          Array.from(command.additionalTextures[0].uv),
          Array.from(command.vertices.filter((_, i) => i % 9 === 7 || i % 9 === 8)),
        );
        await layers.dispatch(tag('lyprop', {id: '2', intermediate_render: '0'}));
        layers.commit();
        assert.throws(
          () => graphics.drawCommitted(layers.scene),
          /alpha blur outside a captured target/,
        );
      } else
        assert.deepEqual(command.blendState.color, {
          source: 'source-alpha',
          destination: 'one',
          operation: 'add',
        });
    } finally {
      layers.close();
      shader.dispose();
    }
  }
});

test('Rev.3257 restored atlases preserve independent style/codepoint, 32-bit sizes and bearing/advance metrics', async () => {
  const {ArtemisRestoredFontCache} = await import('../dist/engines/artemis/font-cache.js');
  const {fontCacheFixture} = await import('./artemis-font-cache-fixtures.mjs');
  const revisions = await import('../dist/engines/artemis/revision.js');
  for (const hash of [
    revisions.ARTEMIS_3257_EXECUTABLE_SHA256,
    revisions.ARTEMIS_3257_WRAPPED_RESOURCE_VARIANT_SHA256,
    revisions.ARTEMIS_3257_RESOURCE_VARIANT_SHA256,
  ]) {
    const files = fontCacheFixture({
      layout: 'expanded-metrics',
      size: 300,
      style: 0x10001,
      codePoint: 0x1f600,
    });
    const cache = new ArtemisRestoredFontCache(hash, async (path) => files[path] ?? null);
    const key = {
      face: 'synthetic.ttf',
      size: 300,
      shadow: 0,
      outline: 1,
      color: 0xff0000,
      shadowColor: 0,
      outlineColor: 0x0000ff,
      style: 0x10001,
      codePoint: 0x1f600,
    };
    try {
      await cache.restore('cache/');
      const glyph = cache.get(key);
      assert.deepEqual(
        [glyph.left, glyph.top, glyph.advance, glyph.image.width, glyph.image.height],
        [-2, 5, 23, 2, 2],
      );
      assert.deepEqual(
        [...glyph.image.pixels],
        [10, 20, 30, 40, 50, 60, 70, 80, 130, 140, 150, 160, 170, 180, 190, 200],
      );
      assert.equal(cache.has({...key, size: 44}), false);
      assert.equal(cache.has({...key, size: 556}), false);
      assert.equal(cache.has({...key, style: 1}), false);
      assert.equal(cache.has({...key, codePoint: 0xf600}), false);
      Object.assign(
        files,
        fontCacheFixture({
          layout: 'expanded-metrics',
          size: 300,
          style: 0x10001,
          codePoint: 0x1f600,
          metrics: [-3, 4, 21],
          clip: [0, 0, 0, 0],
        }),
      );
      await cache.restore('cache/');
      assert.deepEqual(
        [
          cache.get(key).left,
          cache.get(key).top,
          cache.get(key).advance,
          cache.get(key).image.width,
        ],
        [-3, 4, 21, 1],
      );
      assert.equal(glyph.image.width, 2);
      delete files['cache/0.png'];
      await cache.restore('cache/');
      assert.deepEqual(cache.get(key), {image: null, left: -3, top: 4, advance: 21});
      files['cache/index.dat'] = fontCacheFixture({
        layout: 'expanded-metrics',
        metrics: [NaN, 0, 1],
      })['cache/index.dat'];
      await assert.rejects(cache.restore('cache/'), /metrics/);
      assert.equal(cache.get(key).advance, 21);
    } finally {
      cache.close();
    }
  }
});

test('Rev.3257 atlas hits reach normal/ruby layout while misses retain full-size FreeType bearing geometry', async () => {
  const {ArtemisTextGlyphs} = await import('../dist/engines/artemis/text-glyphs.js');
  const {ArtemisFileFonts} = await import('../dist/engines/artemis/file-fonts.js');
  const {fontCacheFixture} = await import('./artemis-font-cache-fixtures.mjs');
  const {rectangleFont, createNodeFontWorker, createNodeGlyphPainter} =
    await import('./freetype-fixtures.mjs');
  const revisions = await import('../dist/engines/artemis/revision.js');
  for (const hash of [
    revisions.ARTEMIS_3257_EXECUTABLE_SHA256,
    revisions.ARTEMIS_3257_WRAPPED_RESOURCE_VARIANT_SHA256,
    revisions.ARTEMIS_3257_RESOURCE_VARIANT_SHA256,
  ]) {
    const files = {
      ...fontCacheFixture({layout: 'expanded-metrics', size: 300}),
      'synthetic.ttf': rectangleFont(),
    };
    const worker = await createNodeFontWorker(),
      painter = await createNodeGlyphPainter(hash);
    let rasterJobs = 0;
    const fonts = new ArtemisFileFonts(hash, {
      readFontFile: async (path) => files[path] ?? null,
      hasSystemFontFamily: async () => false,
      openFontFace: async (bytes) => {
        const face = await worker.open(bytes);
        return {
          requestSize: (...args) => face.requestSize(...args),
          close: () => face.close(),
          rasterize: (...args) => {
            rasterJobs++;
            return face.rasterize(...args);
          },
        };
      },
    });
    const loader = new ArtemisTextGlyphs(hash, fonts, painter);
    const style = {
      face: 'synthetic.ttf',
      rubyface: 'synthetic.ttf',
      size: 300,
      rubysize: 300,
      shadow: 0,
      outline: 1,
      rubyshadow: 0,
      rubyoutline: 1,
      spacetop: 0,
      spacemiddle: 0,
      spacebottom: 0,
      kerning: 0,
      rubykerning: 0,
      color: 0xff0000,
      shadowcolor: 0,
      outlinecolor: 0x0000ff,
      styleBits: 0,
    };
    try {
      await loader.restoreFontCache('cache/');
      const hit = await loader.load('AA', 'A', style);
      assert.equal(rasterJobs, 0);
      assert.equal(hit.main[0].advance, 23);
      assert.equal(hit.ruby[0].advance, 23);
      assert.deepEqual([hit.main[0].glyph.surface.left, hit.main[0].glyph.surface.top], [-2, 5]);
      const miss = await loader.load('A', '', {...style, color: 0xffffff});
      assert.equal(rasterJobs, 1);
      assert.deepEqual(
        [
          miss.main[0].advance,
          miss.main[0].glyph.surface.image.width,
          miss.main[0].glyph.surface.image.height,
        ],
        [227, 77, 152],
      );
      await loader.restoreFontCache('cache/');
      await loader.load('A', '', {...style, color: 0xffffff});
      assert.equal(rasterJobs, 1);
    } finally {
      await loader.close();
      await fonts.close();
      painter.close();
      worker.close();
    }
  }
});

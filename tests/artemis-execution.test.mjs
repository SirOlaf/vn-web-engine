import test from 'node:test';
import assert from 'node:assert/strict';
import {parseIet} from '../dist/formats/artemis/iet.js';
import {ArtemisLua, luaTag} from '../dist/engines/artemis/lua.js';
import {ArtemisScript} from '../dist/engines/artemis/script.js';
import {luaText} from '../dist/core/lua51/runtime.js';
const bytes = (s) => new TextEncoder().encode(s);

test('Release-mode Lua debug skips arbitrary arguments before validation and follows the current debug mode', () => {
  let mode = 0;
  const lua = new ArtemisLua({debugMode: () => mode});
  try {
    lua.vm.execute(
      bytes(`
      local cyclic = {}; cyclic.self = cyclic
      assert(select('#', engine:debug(cyclic)) == 0)
      assert(select('#', engine:debug(function() end)) == 0)
      engine:debug{data='release', raw=true}
      engine:debug()
    `),
    );
    mode = 1;
    assert.throws(() => lua.vm.execute(bytes("engine:debug('enabled')")), /enabled debug console/);
    mode = 0;
    lua.vm.execute(bytes("engine:debug('release again')"));
  } finally {
    lua.close();
  }
});

test('Lua encoding conversion retains Japanese byte strings through activation-style save/restore calls', () => {
  const reports = [];
  const lua = new ArtemisLua({readFile: () => null, reportError: (v) => reports.push(v)});
  try {
    lua.vm.execute(
      bytes(`
      local source = '日本語'..string.char(0)..'名前'
      local raw = engine:convertEncoding{from='utf8', to='sjis', source=source}
      assert(raw == string.char(0x93,0xfa,0x96,0x7b,0x8c,0xea,0,0x96,0xbc,0x91,0x4f))
      local restored = engine:convertEncoding{from='sjis', to='utf8', source=raw}
      assert(restored == source)
      assert(engine:convertEncoding{from='sjis', to='sjis', source=raw} == raw)
      assert(engine:convertEncoding{from='utf8', to='utf8', source=source} == source)
      assert(engine:convertEncoding{from='sjis', to='utf8', source='none'} == 'none')
      assert(engine:convertEncoding{from='utf8', to='sjis', source=17} == '')
      assert(engine:convertEncoding{from='utf8', to='bogus', source='x'} == nil)
      assert(engine:convertEncoding(false) == nil)
      assert(not pcall(function() engine:convertEncoding{to='utf8',source='x'} end))
      assert(not pcall(function() engine:convertEncoding{from='euc',to='utf8',source='x'} end))
      assert(not pcall(function() engine:convertEncoding{from='utf8',to='jis',source='x'} end))
    `),
    );
    assert.equal(reports.length, 2);
    assert.deepEqual(reports[0], reports[1]);
  } finally {
    lua.close();
  }
});

test('HTTP waits keep frame callbacks alive, publish real status/bytes and resume the queued script', async () => {
  const {openArtemisRuntimeFixture} = await import('./artemis-runtime-fixture.mjs');
  const {FetchHttpClient} = await import('../dist/platform/http-client.js');
  let deliver, requestSignal;
  const calls = [];
  const fixture = await openArtemisRuntimeFixture(
    {
      'system/first.iet': `
    [calllua function="start"]
    [var name="t.done" data="1"]
    [stop]
    [lua]
    function start(e)
      e:setEventHandler{onEnterFrame='http_frame'}
      e:tag{'httpget',url='https://example.invalid/patch',varname_code='t.code',varname_data='t.body'}
      started=true
    end
    function http_frame(e) frames=(frames or 0)+1 end
    [/lua]`,
    },
    {
      services: {
        http: new FetchHttpClient(async (url, {signal}) => {
          calls.push(url);
          requestSignal = signal;
          return new Promise((r) => {
            deliver = r;
          });
        }),
      },
    },
  );
  const {runtime} = fixture;
  const frame = () =>
    runtime.frame(runtime.now + 16, {sample: {down: new Set(), pointerInside: true}});
  try {
    await runtime.boot();
    await new Promise((r) => setImmediate(r));
    assert.equal(runtime.runMode, 8);
    assert.equal(runtime.resourcePending, false);
    assert.equal(runtime.lua.vm.getGlobal('started'), true);
    frame();
    frame();
    assert.equal(runtime.lua.vm.getGlobal('frames'), 2);
    assert.equal(runtime.variables.lookup('t.done'), undefined);
    assert.deepEqual(calls, ['https://example.invalid/patch']);
    deliver(new Response(Uint8Array.of(0x93, 0xfa, 0, 0x96, 0x7b), {status: 404}));
    await new Promise((r) => setImmediate(r));
    frame();
    assert.equal(runtime.runMode, 8);
    assert.equal(luaText(runtime.variables.read('t.code')), '404');
    assert.deepEqual(runtime.variables.read('t.body'), Uint8Array.of(0x93, 0xfa));
    frame();
    assert.equal(runtime.runMode, 3);
    assert.equal(luaText(runtime.variables.read('t.done')), '1');
    assert.equal(requestSignal.aborted, false);
  } finally {
    await fixture.close();
  }
});

test('HTTP cancellation aborts the request without fabricating a result or stopping frame input', async () => {
  const {openArtemisRuntimeFixture} = await import('./artemis-runtime-fixture.mjs');
  let deliver, signal;
  const fixture = await openArtemisRuntimeFixture(
    {
      'system/first.iet': `
    [calllua function="start"]
    [var name="t.done" data="1"]
    [stop]
    [lua]
    function start(e)
      e:setEventHandler{onEnterFrame='cancel_request'}
      e:tag{'httpget',url='https://example.invalid/',varname_code='t.code',varname_data='t.body'}
    end
    function cancel_request(e) e:tag{'var',name='s.http.cancel',data='1'} end
    [/lua]`,
    },
    {
      services: {
        http: {
          get: async (_url, s) => {
            signal = s;
            return new Promise((r) => {
              deliver = r;
            });
          },
        },
      },
    },
  );
  try {
    await fixture.runtime.boot();
    await new Promise((r) => setImmediate(r));
    fixture.runtime.frame(17, {sample: {down: new Set(), pointerInside: true}});
    assert.equal(signal.aborted, true);
    assert.equal(fixture.runtime.runMode, 3);
    assert.equal(luaText(fixture.runtime.variables.read('t.done')), '1');
    assert.equal(fixture.runtime.variables.lookup('t.code'), undefined);
    deliver({status: 200, body: bytes('late')});
    await new Promise((r) => setImmediate(r));
    fixture.runtime.frame(33, {sample: {down: new Set(), pointerInside: true}});
    assert.equal(fixture.runtime.variables.lookup('t.body'), undefined);
  } finally {
    await fixture.close();
  }
});

test('HTTP request, connection and receive failures remain distinct native negative results', async () => {
  const {FetchHttpClient} = await import('../dist/platform/http-client.js');
  const {ArtemisHttp} = await import('../dist/engines/artemis/http.js');
  for (const [url, fetcher, code] of [
    ['not a URL', () => assert.fail('Invalid URL must not fetch'), -1],
    [
      'https://example.invalid/',
      async () => {
        throw TypeError('blocked by host');
      },
      -2,
    ],
    [
      'https://example.invalid/',
      async () => ({
        status: 200,
        arrayBuffer: async () => {
          throw Error('body stream lost');
        },
      }),
      -3,
    ],
  ]) {
    const writes = new Map();
    let waiting = false;
    const owner = new ArtemisHttp(new FetchHttpClient(fetcher), {
      beginWait: () => {
        waiting = true;
      },
      endWait: () => {
        waiting = false;
      },
      cancelled: () => false,
      writeVariable: (k, v) => writes.set(k, v),
    });
    assert.equal(
      owner.dispatch({
        name: 'httpget',
        args: new Map(Object.entries({url, varname_code: 't.code', varname_data: 't.body'})),
        sourceLine: 0,
      }),
      true,
    );
    await new Promise((r) => setImmediate(r));
    owner.tick();
    assert.equal(writes.get('t.code'), String(code));
    assert.ok(luaText(writes.get('t.body')).endsWith(' (0,0)'));
    assert.equal(waiting, true);
    owner.tick();
    assert.equal(waiting, false);
    owner.close();
  }
});

test('Repeated scenario loads retain looping layer tweens without adding replay commands to the save', async () => {
  const {openArtemisRuntimeFixture} = await import('./artemis-runtime-fixture.mjs');
  const {ARTEMIS_2601_EXECUTABLE_SHA256} = await import('../dist/engines/artemis/revision.js');
  const {png} = await import('./png-fixtures.mjs');
  const fixture = await openArtemisRuntimeFixture(
    {
      'system/first.iet':
        '[lyc id="1" file="pixel.png"]\n[lytween id="1" param="rotate" from="0" to="360" time="2000" loop="-1"]\n[@]\n[stop]',
      'pixel.png': png({width: 1, height: 1, raw: Buffer.from([0, 255, 255, 255, 255])}),
    },
    {hash: ARTEMIS_2601_EXECUTABLE_SHA256},
  );
  const {runtime} = fixture;
  try {
    await runtime.boot();
    while (runtime.resourcePending) {
      await runtime.settleResource();
      runtime.script.run(1000);
    }
    const commands = runtime.layers.snapshotLayerCommands();
    assert.equal(commands.get('1').filter((t) => t.name === 'lytween').length, 1);
    const expected = runtime.scenarioArchive(true);
    runtime.save.request('loop.dat', true, true);
    await runtime.flushSaves();
    for (let n = 0; n < 3; n++) {
      assert.equal(await runtime.load.load('loop.dat', true), true);
      assert.deepEqual(runtime.layers.snapshotLayerCommands(), commands);
      assert.deepEqual(runtime.scenarioArchive(), expected);
      // Re-save the loaded state as well: duplication must not compound across generations.
      runtime.save.request('loop.dat', true, true);
      await runtime.flushSaves();
    }
  } finally {
    await fixture.close();
  }
});

test('IET boot grammar retains label positions, comments, quoted brackets and positional arguments', () => {
  const program = parseIet(
    bytes(
      `; comment\r\n*top\r\n/* block\ncomment */[loading off logo][print data="a]b\\\"c"]\n*last\n[stop]`,
    ),
  );
  assert.equal(program.labels.get('top'), 0);
  assert.equal(program.labels.get('last'), 2);
  assert.equal(program.tags[0].args.get('0'), 'off');
  assert.equal(program.tags[0].args.get('1'), 'logo');
  assert.equal(program.tags[1].args.get('data'), 'a]b"c');
  assert.equal(program.tags[0].sourceLine, 3);
  for (const source of [
    'plain dialogue',
    '[x data="unterminated]',
    '[lua]bad',
    '/*bad',
    '[x',
    '*label suffix',
    '\0',
  ])
    assert.throws(() => parseIet(bytes(source)), /IET/);
});

test('IET loads all Lua definitions before dispatch, includes real bytes and pauses explicitly', () => {
  const sources = new Map([
    [
      'boot.iet',
      bytes(
        `*top\n[calllua function="boot"][wt][stop]\n[lua]\nfunction boot(e) e:include('module.lua'); result=moduleValue; e:tag{'record', data='雪', n=-1.2}; e:enqueueTag{'queued'} end\n[/lua]`,
      ),
    ],
    ['module.lua', bytes('moduleValue=42')],
    ['empty.lua', new Uint8Array()],
    ['binary', Uint8Array.of(0, 255)],
  ]);
  const events = [];
  const host = {
    readFile: (path) => sources.get(path) ?? null,
    fileExists: (path) => sources.has(path),
    now: () => 0x80000005,
    tag: (t) => events.push(['direct', t.name, t.args.get('data'), t.args.get('n')]),
    enqueueTag: (t) => events.push(['queue', t.name]),
    variable: () => 'value',
  };
  const lua = new ArtemisLua(host);
  try {
    const script = new ArtemisScript(lua, {
      readFile: host.readFile,
      dispatch: (tag) => {
        if (tag.name === 'wt') return 'waiting';
        if (tag.name === 'stop') return 'stopped';
        throw new Error('unsupported');
      },
    });
    script.load('boot.iet', 'top');
    assert.equal(script.run(), 'waiting');
    assert.equal(lua.vm.getGlobal('result'), 42);
    assert.deepEqual(events, [
      ['direct', 'record', '雪', '-2'],
      ['queue', 'queued'],
    ]);
    lua.vm.execute(
      bytes(
        `assert(e:now()==5); assert(e:file('binary')==string.char(0,255)); assert(e:file('absent')==nil); e:include('empty.lua')`.replaceAll(
          'e:',
          'engine:',
        ),
      ),
    );
    assert.equal(luaText(lua.vm.getGlobal('_VERSION')), 'Lua 5.1');
    script.resume();
    assert.equal(script.run(), 'stopped');
    assert.throws(() => script.resume(), /not waiting/);
    assert.throws(() => script.load('boot.iet', 'absent'), /Missing Artemis label/);
  } finally {
    lua.close();
  }
});

test('Unsupported native dispatch faults execution and never silently continues', () => {
  const readFile = () => bytes('[unsupported][stop]');
  const lua = new ArtemisLua({
    readFile,
    fileExists: () => true,
    now: () => 0,
    tag: () => {},
    enqueueTag: () => {},
    variable: () => '',
  });
  try {
    const script = new ArtemisScript(lua, {
      readFile,
      dispatch: (tag) => {
        throw new Error(`unsupported ${tag.name}`);
      },
    });
    script.load('boot');
    assert.throws(() => script.run(), /unsupported/);
    assert.equal(script.state, 'faulted');
    assert.equal(script.step(), 'faulted');
    // 1304d0 converts only string keys with string/number values; other entries are skipped.
    const converted = luaTag(
      new Map([
        [1, bytes('x')],
        [2, bytes('positional')],
        ['boolean', true],
        ['table', new Map()],
        ['text', bytes('t')],
        ['number', 2.75],
      ]),
    );
    assert.equal(converted.name, 'x');
    assert.deepEqual(
      [...converted.args],
      [
        ['text', 't'],
        ['number', '2'],
      ],
    );
  } finally {
    lua.close();
  }
});

test('Live tag filters consume script tags while direct Lua tags bypass the filter', () => {
  const native = [],
    queued = [];
  const source = bytes(
    `[lua]\ntags={}; engine:setTagFilter(tags)\nfunction tags.wt(e,p) e:enqueueTag{'wait',time=0,input=1}; return 1 end\nfunction tags.echo(e,p) engine:tag{'echo',data=p.data}; return 1 end\n[/lua]\n[wt][echo data="雪"][stop]`,
  );
  let lua;
  const readFile = () => source;
  const dispatch = (tag) => {
    if (lua.filterTag(tag)) return;
    native.push(tag.name);
    if (tag.name === 'stop') return 'stopped';
  };
  lua = new ArtemisLua({
    readFile,
    fileExists: () => true,
    now: () => 0,
    tag: dispatch,
    enqueueTag: (t) => queued.push(t),
    variable: () => '',
  });
  try {
    const script = new ArtemisScript(lua, {readFile, dispatch});
    script.load('boot');
    assert.equal(script.run(), 'stopped');
    assert.deepEqual(native, ['echo', 'stop']);
    assert.equal(queued[0].name, 'wait');
    assert.equal(queued[0].args.get('input'), '1');
    assert.equal(queued[0].sourceLine, -1);
  } finally {
    lua.close();
  }
});

test('IET conditionals and loops lower to native goto tags and move the cursor', () => {
  const source = bytes(
    '[if estimate="0"][a][elseif estimate="1"][b][else][c][/if][d][loop estimate="x"][e][/loop]',
  );
  const program = parseIet(source);
  const goto = '\x0bgoto',
    index = '\x0bindex';
  assert.deepEqual(
    program.tags.map((t) => [t.name, t.args.get(index) ?? null]),
    [
      ['if', '3'],
      ['a', null],
      [goto, '7'],
      ['elseif', '6'],
      ['b', null],
      [goto, '7'],
      ['c', null],
      ['d', null],
      ['loop', '11'],
      ['e', null],
      [goto, '8'],
    ],
  );
  assert.equal(program.tags[2].sourceLine, 0);
  assert.throws(() => parseIet(bytes('[else]')), /else without matching if/);
  assert.throws(() => parseIet(bytes('[if][else][elseif]')), /elseif after else/);
  assert.throws(() => parseIet(bytes('[/loop]')), /loop without matching loop/);
  const native = [];
  const readFile = () => source;
  const dispatch = (tag) => void native.push(tag.name);
  const lua = new ArtemisLua({
    readFile,
    fileExists: () => true,
    now: () => 0,
    tag: dispatch,
    enqueueTag: () => {},
    variable: () => '',
  });
  try {
    const script = new ArtemisScript(lua, {readFile, dispatch, emptyReturn: () => 'stopped'});
    script.load('boot');
    assert.equal(script.run(), 'stopped');
    assert.deepEqual(native, ['b', 'd']);
    const expressions = bytes('[x v="$$a" w="b$"]');
    const seen = [];
    const evaluated = new ArtemisScript(lua, {
      readFile: () => expressions,
      dispatch: (tag) => void seen.push(Object.fromEntries(tag.args)),
      evaluateExpression: (e) => `(${e})`,
      emptyReturn: () => 'stopped',
    });
    evaluated.load('expressions');
    evaluated.run();
    assert.deepEqual(seen, [{v: '((a))', w: 'b$'}]);
    // Lua-built tags carry exact argument bytes; byte readers see the evaluated value.
    const built = [];
    new ArtemisScript(lua, {
      readFile,
      dispatch: (tag) =>
        void built.push([tag.args.get('data'), new TextDecoder().decode(tag.bytes.get('data'))]),
      evaluateExpression: (e) => `(${e})`,
    }).executeTag({
      kind: 'tag',
      name: 'var',
      sourceLine: 0,
      args: new Map([['data', '$0==0']]),
      bytes: new Map([['data', bytes('$0==0')]]),
    });
    assert.deepEqual(built, [['(0==0)', '(0==0)']]);
    const strict = new ArtemisScript(lua, {readFile: () => expressions, dispatch});
    strict.load('expressions');
    assert.throws(() => strict.run(), /expression argument without an evaluator/);
  } finally {
    lua.close();
  }
});

test('Expression arguments follow native operator passes, CVariant types and variable leaves', async () => {
  const {ArtemisVariables} = await import('../dist/engines/artemis/variables.js');
  const {artemisExpressionBytes, evaluateArtemisExpression} =
    await import('../dist/engines/artemis/expression.js');
  const variables = new ArtemisVariables();
  const text = (expression) =>
    new TextDecoder().decode(artemisExpressionBytes(expression, variables));
  // Absent leaves are created as integer zero and stay readable afterwards.
  assert.equal(text('t.load != 0'), '0');
  assert.deepEqual(evaluateArtemisExpression('t.load', variables), {kind: 'integer', value: 0});
  assert.equal(new TextDecoder().decode(variables.read('t.load')), '0');
  variables.write('t.load', 'scene.ast');
  assert.equal(text('t.load != 0'), '1');
  assert.equal(text('t.load'), 'scene.ast');
  // + concatenates unless both sides are numeric; == compares strings when either is a string.
  variables.write('t.path', 'ui/menu');
  assert.equal(text("t.path+'02'"), 'ui/menu02');
  variables.write('t.path', '1');
  assert.equal(text("t.path+'02'"), '3');
  assert.equal(text("'01'==1"), '0');
  assert.equal(text('01 == 1'), '1');
  assert.equal(text("'0x10'+1"), '17');
  // Pass order *,/,% then +,- then relational, equality, && and ||, each left to right.
  assert.equal(text('1+2*3'), '7');
  assert.equal(text('(1+2)*3'), '9');
  assert.equal(text('-3+5'), '2');
  assert.equal(text('2*-3'), '-6');
  assert.equal(text('10-4-3'), '3');
  assert.equal(text('-7/2'), '-3');
  assert.equal(text('7%-3'), '1');
  assert.equal(text('1<2&&2>=2||0'), '1');
  assert.equal(text('0x1F'), '31');
  assert.equal(text('2147483648'), '2147483647');
  // Quote character is ' with backslash escapes; an unterminated string yields no value.
  assert.equal(text("'it\\'s'"), "it's");
  assert.equal(text("'abc"), '');
  // name(expr) splices the evaluated text into the variable name.
  variables.write('a2b', 'spliced');
  assert.equal(text('a(1+1)b'), 'spliced');
  // A closing parenthesis ends the outermost level; failures produce an empty argument.
  assert.equal(text('3) + 4'), '3');
  for (const failing of ['1/0', '1 2', '-a', '*2', '()', "x'y'"])
    assert.equal(text(failing), '', failing);
  assert.equal(evaluateArtemisExpression('1/0', variables), null);
  assert.throws(() => text('s.missing'), /Unsupported native Artemis variable/);
});

test('Mode commands disable active skip/auto through status and effect services', async () => {
  const {ArtemisModes} = await import('../dist/engines/artemis/modes.js');
  const events = [];
  let layer = 'mw';
  const modes = new ArtemisModes({
    writeStatus: (name, value) => events.push([name, value]),
    commandSkipChanged: (v) => events.push(['commandSkip', v]),
    controlSkipChanged: (v) => events.push(['controlSkip', v]),
    automodeChanged: (v) => events.push(['auto', v]),
    releaseScheduler: () => events.push(['release']),
    currentMessageLayer: () => layer,
  });
  const tag = (name, args) => ({
    kind: 'tag',
    name,
    args: new Map(Object.entries(args)),
    sourceLine: -1,
  });
  // Native construction leaves automode disallowed (+0x32 = 0) until a game allows it.
  assert.equal(modes.automodeAllowed, false);
  modes.setAutomode(true);
  assert.equal(modes.automode, false);
  modes.automodeAllowed = true;
  modes.setCommandSkip(true);
  modes.setControlSkip(true);
  modes.setAutomode(true);
  events.length = 0;
  modes.dispatch(tag('skip', {allow: '0', unread: '1'}));
  assert.equal(modes.skipAllowed, false);
  assert.equal(modes.skipUnread, true);
  assert.equal(modes.commandSkip, false);
  assert.equal(modes.controlSkip, false);
  modes.setCommandSkip(true);
  assert.equal(modes.commandSkip, false);
  modes.dispatch(tag('automode', {allow: '0', stopbyclick: '0', stopbystop: '1', syncse: ''}));
  assert.equal(modes.automode, false);
  // 0x1400a0770 keeps empty fields: an empty list is one empty id.
  assert.deepEqual(modes.syncSe, ['']);
  modes.dispatch(tag('automode', {syncse: 'v1,,v2'}));
  assert.deepEqual(modes.syncSe, ['v1', '', 'v2']);
  assert.equal(modes.stopAutoByStop, true);
  // +0x38 is keyed by the current message layer; without `layer` the name is kept.
  modes.dispatch(tag('automode', {layer: 'auto'}));
  layer = 'sub';
  modes.dispatch(tag('automode', {}));
  layer = 'mw';
  modes.dispatch(tag('automode', {}));
  assert.deepEqual(
    [...modes.automodeLayers],
    [
      ['mw', {present: false, name: 'auto'}],
      ['sub', {present: false, name: ''}],
    ],
  );
  const fields = modes.saveFields();
  modes.reset();
  modes.loadFields(fields);
  assert.deepEqual(modes.saveFields(), fields);
  assert.equal(modes.automodeLayers.get('mw').name, 'auto');
  modes.automodeAllowed = false;
  assert.deepEqual(events, [
    ['s.status.commandskip', '0'],
    ['commandSkip', false],
    ['s.status.controlskip', '0'],
    ['controlSkip', false],
    ['s.status.automode', '0'],
    ['auto', false],
    ['release'],
  ]);
  modes.dispatch(tag('autosave', {allow: '2'}));
  modes.dispatch(tag('autosave', {allow: 'invalid'}));
  assert.equal(modes.autosave, 2);
  assert.equal(modes.dispatch(tag('unknown', {})), false);
});

test('The caret read check marks tags per file and ends command skip on unread text', async () => {
  const {ArtemisModes} = await import('../dist/engines/artemis/modes.js');
  const {ArtemisReadHistory} = await import('../dist/engines/artemis/global-save.js');
  const events = [];
  let script,
    enterScope = false;
  const modes = new ArtemisModes({
    writeStatus: (name, value) => name === 's.status.alreadyread' && events.push(value),
    commandSkipChanged: (active) => {
      events.push(`skip ${active}`);
      // A setoncommandskipout handler scope leaves an empty caret; the tag waits.
      if (enterScope) script.enterEventHandlerScope();
    },
    controlSkipChanged: () => {},
    automodeChanged: () => {},
    releaseScheduler: () => {},
    currentMessageLayer: () => '',
  });
  const history = new ArtemisReadHistory();
  const ran = [];
  const lua = new ArtemisLua({
    readFile: () => null,
    fileExists: () => false,
    now: () => 0,
    tag: () => {},
    enqueueTag: () => {},
    variable: () => '',
  });
  try {
    script = new ArtemisScript(lua, {
      readFile: () => bytes('[a][alreadyread mode="1"][b][stop]'),
      pushLocal: () => {},
      popLocal: () => {},
      dispatch: (tag) => {
        ran.push(tag.name);
        if (modes.dispatch(tag)) return;
        if (tag.name === 'stop') return 'stopped';
      },
      // The runtime wiring of 0x1400c0560.
      beforeCaretTag: (file, index, tag) => {
        if (!modes.alreadyReadEnabled || tag.name === 'alreadyread') return;
        const read = history.has(file, index);
        modes.readTag(read);
        if (read || script.currentFile !== file) return;
        history.add(file, index);
        modes.markUnread();
      },
    });
    const play = () => {
      ran.length = 0;
      script.load('s.iet');
      return script.run();
    };
    modes.setCommandSkip(true);
    enterScope = true;
    events.length = 0;
    assert.equal(play(), 'stopped');
    assert.deepEqual(ran, ['a', 'alreadyread', 'b', 'stop']);
    assert.deepEqual(events, ['skip false']);
    // The alreadyread tag itself is never marked.
    assert.deepEqual(history.entries(), [['s.iet', [0, 2, 3]]]);
    enterScope = false;
    events.length = 0;
    modes.setCommandSkip(true);
    assert.equal(play(), 'stopped');
    // Read text keeps command skip and writes the status once.
    assert.deepEqual(events, ['skip true', '1']);
    assert.equal(modes.commandSkip, true);
    history.set('s.iet', [0, 3]);
    events.length = 0;
    assert.equal(play(), 'stopped');
    assert.deepEqual(events, ['skip false', '0', '1']);
    // Skip of unread text keeps command skip; a disabled check marks nothing.
    modes.dispatch({kind: 'tag', name: 'skip', args: new Map([['unread', '1']]), sourceLine: -1});
    history.clear();
    modes.setCommandSkip(true);
    play();
    assert.equal(modes.commandSkip, true);
    history.clear();
    modes.alreadyReadEnabled = false;
    script.load('s.iet');
    script.step();
    assert.deepEqual(history.entries(), []);
  } finally {
    lua.close();
  }
});

test('Exec commands force skip/auto, queue frame requests and use window services', async () => {
  const {ArtemisModes} = await import('../dist/engines/artemis/modes.js');
  const {ArtemisExec} = await import('../dist/engines/artemis/exec.js');
  const layer = '';
  const {BrowserWindowStateHost} = await import('../dist/platform/window-state.js');
  const events = [];
  const modes = new ArtemisModes({
    writeStatus: (name, value) => events.push([name, value]),
    commandSkipChanged: (v) => events.push(['commandSkip', v]),
    controlSkipChanged: (v) => events.push(['controlSkip', v]),
    automodeChanged: (v) => events.push(['auto', v]),
    releaseScheduler: () => events.push(['release']),
    currentMessageLayer: () => layer,
  });
  let visibilityState = 'visible';
  let software = false;
  const reports = [];
  const window = new BrowserWindowStateHost(
    {
      get visibilityState() {
        return visibilityState;
      },
    },
    {toggleFullscreen: () => events.push(['toggleFullscreen'])},
    (message) => reports.push(message),
  );
  const exec = new ArtemisExec(modes, {
    window: {
      minimized: () => window.minimized(),
      show: (command) => (events.push(['show', command]), window.show(command)),
      toggleFullscreen: () => window.toggleFullscreen(),
    },
    enterRunMode: (mode) => events.push(['enter', mode]),
    now: () => 2 ** 32 + 7,
    setWaitStart: (ms) => events.push(['waitStart', ms]),
    softwareRenderer: () => software,
    displayModeChanged: () => events.push(['displayModeChanged']),
  });
  const tag = (args) => ({
    kind: 'tag',
    name: 'exec',
    args: new Map(Object.entries(args)),
    sourceLine: -1,
  });
  assert.equal(exec.dispatch({...tag({}), name: 'automode'}), false);
  // Disallowed modes are forced on; only exactly "0" disables; absent skip mode toggles.
  modes.skipAllowed = modes.automodeAllowed = false;
  exec.dispatch(tag({command: 'automode', mode: '0'}));
  exec.dispatch(tag({command: 'automode'}));
  exec.dispatch(tag({command: 'automode', mode: '00'}));
  exec.dispatch(tag({command: 'automode', mode: '0'}));
  exec.dispatch(tag({command: 'skip'}));
  exec.dispatch(tag({command: 'skip'}));
  exec.dispatch(tag({command: 'skip', mode: ''}));
  exec.dispatch(tag({command: 'skip', mode: '0'}));
  assert.deepEqual(events.splice(0), [
    ['s.status.automode', '1'],
    ['auto', true],
    ['s.status.automode', '0'],
    ['auto', false],
    ['s.status.commandskip', '1'],
    ['commandSkip', true],
    ['s.status.commandskip', '0'],
    ['commandSkip', false],
    ['s.status.commandskip', '1'],
    ['commandSkip', true],
    ['s.status.commandskip', '0'],
    ['commandSkip', false],
  ]);
  exec.dispatch(tag({command: 'rclick'}));
  exec.dispatch(tag({command: 'hide'}));
  exec.dispatch(tag({command: 'Backlog'}));
  exec.dispatch(tag({command: 'backlog'}));
  assert.deepEqual(events.splice(0), [
    ['enter', 4],
    ['waitStart', 7],
    ['enter', 4],
    ['waitStart', 7],
    ['enter', 4],
    ['waitStart', 7],
  ]);
  assert.equal(exec.consume('rightClick'), true);
  assert.equal(exec.consume('rightClick'), false);
  assert.equal(exec.requested('hide'), true);
  exec.clearRequests();
  assert.equal(exec.requested('backlog'), false);
  exec.dispatch(tag({command: 'fullscreen'}));
  software = true;
  exec.dispatch(tag({command: 'fullscreen'}));
  exec.dispatch(tag({command: 'minimize'}));
  visibilityState = 'hidden';
  exec.dispatch(tag({command: 'minimize'}));
  assert.deepEqual(events, [
    ['toggleFullscreen'],
    ['displayModeChanged'],
    ['show', 'minimize'],
    ['show', 'restore'],
  ]);
  assert.equal(reports.length, 1);
});

test('Queued tags retain a copy and run before the next script command, across ASB call/return', () => {
  const u32 = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  const str = (s) => {
    const b = Buffer.from(s);
    return Buffer.concat([u32(b.length), b, Buffer.alloc(1)]);
  };
  const asb = Buffer.concat([
    Buffer.from([65, 83, 66, 0, 0]),
    u32(1),
    u32(0),
    str('return'),
    u32(0),
    u32(0),
  ]);
  const sources = new Map([
    [
      'boot',
      bytes(
        `[lua]\nloads=(loads or 0)+1\nfunction start(e) e:enqueueTag{'first'}; e:enqueueTag{'call',file='sub.asb'} end\n[/lua]\n[calllua function="start"][last][stop]`,
      ),
    ],
    ['sub.asb', asb],
  ]);
  let script;
  const events = [];
  const readFile = (p) => sources.get(p) ?? null;
  const lua = new ArtemisLua({
    readFile,
    fileExists: (p) => sources.has(p),
    now: () => 0,
    tag: () => {},
    enqueueTag: (t) => script.enqueue(t),
    variable: () => '',
  });
  try {
    script = new ArtemisScript(lua, {
      readFile,
      dispatch: (tag) => {
        events.push(tag.name);
        if (tag.name === 'stop') return 'stopped';
      },
      pushLocal: () => events.push('push'),
      popLocal: () => events.push('pop'),
    });
    script.load('boot');
    const argument = new Map([['data', 'original']]);
    script.enqueue({kind: 'tag', name: 'copy', args: argument, sourceLine: -1});
    argument.set('data', 'changed');
    script.run(1);
    assert.deepEqual(events, ['copy']);
    assert.equal(script.run(), 'stopped');
    assert.deepEqual(events, ['copy', 'first', 'push', 'pop', 'last', 'stop']);
    assert.equal(script.callDepth, 0);
    assert.equal(script.queuedTags, 0);
    script.load('boot');
    assert.equal(lua.vm.getGlobal('loads'), 1);
  } finally {
    lua.close();
  }
});

test('Each caret keeps its own tag queue; getScriptStack reports saved carets then the current one', () => {
  const sources = new Map([
    [
      'boot',
      bytes(
        `[lua]\nfunction setup(e) e:enqueueTag{'call',file='sub'}; e:enqueueTag{'pending',x='1'} end\nfunction grab(e) e:enqueueTag{'cur',y='2'}; local s = e:getScriptStack(); local out = {} for _, f in ipairs(s) do local c = {} for k, v in pairs(f.reservedCommands) do c[#c+1] = k..'='..v.command..':'..v.line..':'..tostring(v.parameter.x or v.parameter.y) end table.sort(c); out[#out+1] = f.file..'@'..f.index..'['..table.concat(c, ',')..']' end frames = table.concat(out, ' | ') end\n[/lua]\n[calllua function="setup"][last][stop]`,
      ),
    ],
    ['sub', bytes('[calllua function="grab"][inside]')],
  ]);
  let script;
  const events = [];
  const readFile = (p) => sources.get(p) ?? null;
  const lua = new ArtemisLua({
    readFile,
    fileExists: (p) => sources.has(p),
    now: () => 0,
    tag: () => {},
    enqueueTag: (t) => script.enqueue(t),
    variable: () => '',
    scriptStack: () => script.stack(),
  });
  try {
    script = new ArtemisScript(lua, {
      readFile,
      dispatch: (tag) => {
        events.push(tag.name);
        if (tag.name === 'stop') return 'stopped';
      },
      pushLocal: () => {},
      popLocal: () => {},
    });
    script.load('boot');
    assert.equal(script.run(), 'stopped');
    // The queued call saves the remaining queue with its caret; return restores it.
    assert.deepEqual(events, ['cur', 'inside', 'pending', 'last', 'stop']);
    assert.equal(luaText(lua.vm.getGlobal('frames')), 'boot@2[1=pending:-1:1] | sub@1[0=cur:-1:2]');
    script.enqueue({kind: 'tag', name: 'dropped', args: new Map(), sourceLine: -1});
    script.jump('sub');
    assert.equal(script.queuedTags, 0);
  } finally {
    lua.close();
  }
});

test('Artemis Lua bindSurface accepts only strings, truncates at NUL and suspends with an owner', async () => {
  const {ArtemisLua} = await import('../dist/engines/artemis/lua.js');
  const names = [];
  let suspend = false;
  const host = {
    readFile: () => null,
    fileExists: () => false,
    now: () => 0,
    tag: () => {},
    enqueueTag: () => {},
    variable: () => '',
    bindSurface: (name) => {
      names.push(name);
      return suspend ? 'suspended' : undefined;
    },
  };
  const lua = new ArtemisLua(host);
  try {
    lua.vm.execute(bytes('engine:bindSurface("雪.png\\000ignored")'));
    assert.deepEqual(names, ['雪.png']);
    assert.throws(() => lua.vm.execute(bytes('engine:bindSurface(12)')), /surface name string/);
    suspend = true;
    assert.throws(() => lua.vm.execute(bytes('engine:bindSurface("a")')), /coroutine owner/);
  } finally {
    lua.close();
  }
});

test('Literal variables preserve bytes and current-local scope; delete exact key precedes dotted descendants', async () => {
  const {ArtemisVariables} = await import('../dist/engines/artemis/variables.js');
  const variables = new ArtemisVariables();
  const binary = Uint8Array.of(0, 255);
  variables.write('x', binary);
  binary[1] = 1;
  variables.pushLocal();
  variables.write('x', 'local', true);
  variables.pushLocal();
  assert.deepEqual(variables.read('x'), Uint8Array.of(0, 255));
  variables.popLocal();
  assert.equal(luaText(variables.read('x')), 'local');
  variables.popLocal();
  assert.deepEqual(variables.read('x'), Uint8Array.of(0, 255));
  variables.write('tree', 'root');
  variables.write('tree.child', 'leaf');
  variables.write('trees', 'keep');
  variables.delete('tree');
  assert.equal(luaText(variables.read('tree.child')), 'leaf');
  variables.delete('tree');
  assert.equal(variables.read('tree.child').length, 0);
  assert.equal(luaText(variables.read('trees')), 'keep');
  assert.throws(() => variables.delete(''), /Unsupported/);
  assert.throws(() => variables.read('s.unknown'), /Unsupported/);
  assert.throws(() => variables.read('x + 1'), /expression/);
});

test('Stage variable queries use the current host dimensions and preserve local writes', async () => {
  const {ArtemisVariables} = await import('../dist/engines/artemis/variables.js');
  let width = 800;
  const variables = new ArtemisVariables({stageSize: () => ({width, height: 600})});
  const tag = (query) => ({
    kind: 'tag',
    name: 'var',
    sourceLine: -1,
    args: new Map([
      ['name', 'size'],
      ['system', query],
      ['writelocal', '1'],
    ]),
  });
  variables.write('size', 'global');
  variables.pushLocal();
  variables.dispatch(tag('screen_width'));
  assert.equal(luaText(variables.read('size')), '800');
  width = 1920;
  variables.dispatch(tag('screen_width'));
  assert.equal(luaText(variables.read('size')), '1920');
  variables.dispatch(tag('screen_height'));
  assert.equal(luaText(variables.read('size')), '600');
  variables.popLocal();
  assert.equal(luaText(variables.read('size')), 'global');
  const unsupported = new ArtemisVariables();
  assert.throws(() => unsupported.dispatch(tag('screen_width')), /provider/);
});

test('Message layer extent queries truncate the selected layer measure to integers', async () => {
  const {ArtemisVariables} = await import('../dist/engines/artemis/variables.js');
  const variables = new ArtemisVariables({
    stageSize: () => ({width: 1, height: 1}),
    messageLayerMeasure: () => ({width: 412.75, height: 63.5, lineWidth: -0.5}),
  });
  const query = (system) => {
    variables.dispatch({
      kind: 'tag',
      name: 'var',
      sourceLine: -1,
      args: new Map([
        ['name', 't.v'],
        ['system', system],
      ]),
    });
    return luaText(variables.read('t.v'));
  };
  assert.deepEqual(
    ['get_message_layer_width', 'get_message_layer_height', 'get_message_layer_line_width'].map(
      query,
    ),
    ['412', '63', '0'],
  );
  assert.throws(
    () =>
      new ArtemisVariables().dispatch({
        kind: 'tag',
        name: 'var',
        sourceLine: -1,
        args: new Map([
          ['name', 'x'],
          ['system', 'get_message_layer_width'],
        ]),
      }),
    /measure provider/,
  );
});

test('C %g formatting uses the exact binary value with ties to even', async () => {
  const {formatCGeneral} = await import('../dist/core/c-number-format.js');
  const cases = [
    [1, 9, '1'],
    [Math.fround(0.1), 9, '0.100000001'],
    [1234567.125, 9, '1234567.12'],
    [1234567.375, 9, '1234567.38'],
    [0.0001, 9, '0.0001'],
    [0.00001, 9, '1e-05'],
    [123456789012, 9, '1.23456789e+11'],
    [999999999.5, 9, '1e+09'],
    [-0, 9, '-0'],
    [-2.5, 0, '-2'],
    [5e-324, 3, '4.94e-324'],
  ];
  for (const [value, precision, text] of cases)
    assert.equal(formatCGeneral(value, precision), text, `${value} %.${precision}g`);
  assert.throws(() => formatCGeneral(Infinity, 9), /finite/);
});

test('get_message_tags writes a layer history as native tag and font text', async () => {
  const {ArtemisVariables} = await import('../dist/engines/artemis/variables.js');
  const {ArtemisSaveData} = await import('../dist/engines/artemis/save-data.js');
  const {artemisDefaultFontAttributes} = await import('../dist/engines/artemis/font-state.js');
  const {ARTEMIS_3179_EXECUTABLE_SHA256: hash} =
    await import('../dist/engines/artemis/revision.js');
  const saveData = new ArtemisSaveData();
  const variables = new ArtemisVariables({
    stageSize: () => ({width: 1, height: 1}),
    messageTags: (id, fonts) => saveData.messageTags(id, fonts),
  });
  const query = (args) =>
    variables.dispatch({
      kind: 'tag',
      name: 'var',
      sourceLine: -1,
      args: new Map([['name', 'm'], ['system', 'get_message_tags'], ...args]),
    });
  const read = (name) => [...variables.read(name)];
  const text = (name) => new TextDecoder().decode(variables.read(name));
  // No +0x08 history for the layer: nothing is written.
  query([['id', 'msg']]);
  assert.equal(read('m.size').length, 0);

  saveData.recordText('msg', {
    kind: 'tag',
    name: 'print',
    sourceLine: 1,
    args: new Map([
      ['id', 'a,b'],
      ['data', 'x'],
    ]),
    // A comma after a lead byte is inside a character; after a whole one it is escaped.
    bytes: new Map([['data', Uint8Array.of(0xc3, 0x2c, 0xe3, 0x81, 0x82, 0x2c)]]),
  });
  query([
    ['id', 'msg'],
    ['allfont', '0'],
  ]);
  assert.equal(text('m.size'), '1');
  const encoder = new TextEncoder();
  assert.deepEqual(read('m.0'), [
    ...encoder.encode('print,data,'),
    0xc3,
    0x2c,
    0xe3,
    0x81,
    0x82,
    0x5c,
    0x2c,
    ...encoder.encode(',id,a\\,b'),
  ]);
  // allfont creates the +0x18 entry (operator[]) even when it adds nothing.
  query([
    ['id', 'msg'],
    ['allfont', '1'],
  ]);
  assert.deepEqual([...saveData.snapshot().fonts], [['msg', []]]);

  const font = {
    ...artemisDefaultFontAttributes(hash),
    size: 30,
    alpha: 0.5,
    spacebottom: 2.5,
    entirexscale: 1.5,
    color: 0xff8800,
    face: 'F,a',
    rubyface: 'R',
    styleBits: 8 | 16,
  };
  saveData.saveFonts('msg', [{font, overflow: 2}]);
  query([
    ['id', 'msg'],
    ['allfont', '1'],
  ]);
  assert.equal(text('m.size'), '2');
  assert.equal(
    text('m.0'),
    'font,left,0,top,0,width,640,height,480,entirealpha,255,entireanchorx,0,entireanchory,0,' +
      'entirerotate,0,alpha,127.5,rotate,0,size,30,shadow,0,outline,0,rubysize,8,rubyshadow,0,' +
      'rubyoutline,0,spacetop,0,spacemiddle,0,spacebottom,2.5,kerning,0,rubykerning,0,' +
      'overflow,2,entirexscale,150,entireyscale,100,xscale,100,yscale,100,color,0xFF8800,' +
      'shadowcolor,0x0,outlinecolor,0x0,face,F,a,rubyface,R,anchorcenter,1,visible,1,' +
      'vertical,0,hung,1,layermode,normal,align,left,style,bold\\,italic',
  );
  assert.equal(text('m.1').slice(0, 11), 'print,data,');
  assert.throws(
    () =>
      new ArtemisVariables().dispatch({
        kind: 'tag',
        name: 'var',
        sourceLine: -1,
        args: new Map([
          ['name', 'm'],
          ['system', 'get_message_tags'],
        ]),
      }),
    /history provider/,
  );
});

test('End of a called script restores its caller; root end requires an exit provider', () => {
  const sources = new Map([
    ['root', bytes('[call file="sub"][done]')],
    ['sub', bytes('[inside]')],
  ]);
  let script;
  const events = [];
  const readFile = (path) => sources.get(path) ?? null;
  const lua = new ArtemisLua({
    readFile,
    fileExists: (path) => sources.has(path),
    now: () => 0,
    tag: (tag) => script.executeTag(tag),
    enqueueTag: (tag) => script.enqueue(tag),
    variable: () => '',
  });
  try {
    script = new ArtemisScript(lua, {
      readFile,
      dispatch: (tag) => {
        events.push(tag.name);
      },
      pushLocal: () => events.push('push'),
      popLocal: () => events.push('pop'),
    });
    script.load('root');
    assert.throws(() => script.run(), /exit\/save/);
    assert.deepEqual(events, ['push', 'inside', 'pop', 'done']);
    assert.equal(script.callDepth, 0);
    assert.equal(script.state, 'faulted');
  } finally {
    lua.close();
  }
});

test('Native boot constants require an exact executable hash and reject other revisions', async () => {
  const {ArtemisVariables} = await import('../dist/engines/artemis/variables.js');
  const {initializeArtemisVariables, ARTEMIS_3179_EXECUTABLE_SHA256} =
    await import('../dist/engines/artemis/revision.js');
  const variables = new ArtemisVariables();
  assert.throws(
    () => initializeArtemisVariables(variables, '0'.repeat(64)),
    /Unsupported Artemis executable/,
  );
  assert.throws(() => variables.read('s.engineversion'), /Unsupported/);
  initializeArtemisVariables(variables, ARTEMIS_3179_EXECUTABLE_SHA256);
  assert.equal(luaText(variables.read('s.engineversion')), '3179');
  assert.equal(luaText(variables.read('s.savedataversion')), '1003');
  assert.equal(luaText(variables.read('s.status.automode')), '0');
  assert.throws(() => variables.read('s.windowsfeaturelevel'), /Unsupported/);
});

test('Rev.2601/2762 publish their native save version and preserve restored absent DX11 fields', async () => {
  const {ArtemisVariables} = await import('../dist/engines/artemis/variables.js');
  const {
    initializeArtemisVariables,
    initializeArtemisGraphicsFeatureLevel,
    artemisRevision,
    ARTEMIS_2601_EXECUTABLE_SHA256: hash2601,
    ARTEMIS_2762_EXECUTABLE_SHA256: hash2762,
  } = await import('../dist/engines/artemis/revision.js');
  for (const [hash, boot] of [
    [hash2601, ['2601', 'Thu May  9 03:14:56 2019', '1103', '1002']],
    [hash2762, ['2762', 'Tue Jun 2 12:16:51 2020', '1103', '1002']],
  ]) {
    const variables = new ArtemisVariables({executableSha256: hash});
    initializeArtemisVariables(variables, hash);
    assert.deepEqual(
      ['s.engineversion', 's.builddate', 's.minimumsupportversion', 's.savedataversion'].map(
        (key) => luaText(variables.read(key)),
      ),
      boot,
    );
    assert.equal(variables.lookup('s.llp64'), undefined);
    assert.equal(variables.lookup('s.windowsfeaturelevel'), undefined);
    initializeArtemisGraphicsFeatureLevel(variables, hash, () => assert.fail('no DX11 query'));
    assert.equal(luaText(variables.queryLiteral('s.llp64')), '0');
    assert.equal(luaText(variables.queryLiteral('s.windowsfeaturelevel')), '0');
    variables.restore('s.llp64', bytes('7'));
    variables.restore('s.windowsfeaturelevel', bytes('45056'));
    initializeArtemisVariables(variables, hash);
    assert.equal(luaText(variables.read('s.llp64')), '7');
    assert.equal(luaText(variables.read('s.windowsfeaturelevel')), '45056');
    assert.throws(() => artemisRevision(hash.slice(0, 63) + '0'), /Unsupported/);
    assert.throws(() => variables.queryLiteral('s.unimplemented_device'), /Unsupported/);
  }
});

test('Rev.2868/2898/2908 keep absent boot fields absent until real Lua queries create integer zero', async () => {
  const {ArtemisVariables} = await import('../dist/engines/artemis/variables.js');
  const {
    artemisRevision,
    initializeArtemisVariables,
    initializeArtemisGraphicsFeatureLevel,
    ARTEMIS_2868_EXECUTABLE_SHA256: hash2868,
    ARTEMIS_2898_EXECUTABLE_SHA256: hash2898,
    ARTEMIS_2908_EXECUTABLE_SHA256: hash2908,
  } = await import('../dist/engines/artemis/revision.js');
  for (const [hash, version, date] of [
    [hash2868, '2868', 'Sun May 2 21:34:14 2021'],
    [hash2898, '2898', 'Sat Aug 7 22:21:32 2021'],
    [hash2908, '2908', 'Tue Aug 24 23:19:23 2021'],
  ]) {
    const variables = new ArtemisVariables({
      executableSha256: hash,
      stageSize: () => ({width: 8, height: 8}),
    });
    initializeArtemisVariables(variables, hash);
    assert.deepEqual(
      ['s.engineversion', 's.builddate', 's.minimumsupportversion', 's.savedataversion'].map(
        (key) => luaText(variables.read(key)),
      ),
      [version, date, '1103', '1003'],
    );
    assert.equal(variables.lookup('s.llp64'), undefined);
    assert.equal(variables.lookup('s.windowsfeaturelevel'), undefined);
    initializeArtemisGraphicsFeatureLevel(variables, hash, () => {
      throw Error('Absent native graphics query must not call its host');
    });
    assert.equal(variables.lookup('s.windowsfeaturelevel'), undefined);
    const lua = new ArtemisLua({
      readFile: () => null,
      variable: (name) => variables.queryLiteral(name),
    });
    try {
      lua.vm.execute(
        bytes(
          'function fixture(e) result=e:var("s.llp64") .. ":" .. e:var("s.windowsfeaturelevel") end',
        ),
        'fixture',
      );
      lua.call('fixture');
      assert.equal(luaText(lua.vm.getGlobal('result')), '0:0');
      assert.deepEqual(variables.expressionValue('s.llp64'), {kind: 'integer', value: 0});
      assert.equal(variables.globalDirty, false);
      assert.throws(() => variables.queryLiteral('s.unimplemented_device'), /Unsupported/);
      variables.restore('s.llp64', bytes('7'));
      initializeArtemisVariables(variables, hash);
      assert.equal(luaText(variables.read('s.llp64')), '7'); // Native boot neither writes nor deletes it.
    } finally {
      lua.close();
    }
    assert.equal(Object.isFrozen(artemisRevision(hash).absentSystemVariables), true);
    assert.throws(() => artemisRevision('d20ffaa0' + '0'.repeat(56)), /Unsupported/);
  }
});

test('Rev.3083 boot deletes restored DX11 fields while keeping its independent x86 identity', async () => {
  const {ArtemisVariables} = await import('../dist/engines/artemis/variables.js');
  const {
    artemisRevision,
    initializeArtemisVariables,
    initializeArtemisGraphicsFeatureLevel,
    ARTEMIS_3083_EXECUTABLE_SHA256: hash,
  } = await import('../dist/engines/artemis/revision.js');
  const variables = new ArtemisVariables({executableSha256: hash});
  variables.restore('s.llp64', bytes('7'));
  variables.restore('s.windowsfeaturelevel', bytes('45056'));
  variables.restore('s.user_setting', bytes('retained'));
  initializeArtemisVariables(variables, hash);
  assert.deepEqual(
    ['s.engineversion', 's.builddate', 's.minimumsupportversion', 's.savedataversion'].map((key) =>
      luaText(variables.read(key)),
    ),
    ['3083', 'Thu Oct 6 02:52:54 2022', '1103', '1003'],
  );
  assert.equal(variables.lookup('s.llp64'), undefined);
  assert.equal(variables.lookup('s.windowsfeaturelevel'), undefined);
  assert.equal(luaText(variables.lookup('s.user_setting')), 'retained');
  initializeArtemisGraphicsFeatureLevel(variables, hash, () => {
    throw Error('DX9 boot must not query a DX11 feature level');
  });
  assert.equal(luaText(variables.queryLiteral('s.llp64')), '0');
  assert.equal(luaText(variables.queryLiteral('s.windowsfeaturelevel')), '0');
  assert.equal(variables.globalDirty, false);
  assert.equal(artemisRevision(hash).llp64, false);
  assert.throws(() => artemisRevision(hash.slice(0, 63) + '0'), /Unsupported/);
  assert.throws(
    () => artemisRevision('abbaf6524cdaf7ac4c4c5ac50af63a74c6a4f5b22d5a4336f95ab5d85c863a87'),
    /Unsupported/,
  );
});

test('Rev.3083 x64 publishes its own version beside the Rev.3139 DX11 boot fields', async () => {
  const {ArtemisVariables} = await import('../dist/engines/artemis/variables.js');
  const revisions = await import('../dist/engines/artemis/revision.js');
  const hash = revisions.ARTEMIS_3083_X64_EXECUTABLE_SHA256;
  const variables = new ArtemisVariables({executableSha256: hash});
  variables.restore('s.llp64', bytes('7'));
  revisions.initializeArtemisVariables(variables, hash);
  assert.deepEqual(
    [
      's.engineversion',
      's.builddate',
      's.minimumsupportversion',
      's.savedataversion',
      's.llp64',
    ].map((key) => luaText(variables.read(key))),
    ['3083', 'Thu Oct 6 02:52:54 2022', '1103', '1003', '1'],
  );
  const x64 = revisions.artemisRevision(hash);
  const x86 = revisions.artemisRevision(revisions.ARTEMIS_3083_EXECUTABLE_SHA256);
  assert.deepEqual(
    [x64.graphicsApi, x64.glyphGeometry, x64.fontCacheKey, x64.renderedColorGlyphs],
    ['d3d11', 'clipped-cell', 'expanded', true],
  );
  assert.equal(x86.fixedDialogStyle, undefined);
  assert.equal(x64.fixedDialogStyle, true);
});

test('Legacy exact hashes retain their LLP64, graphics and font-size policies beside Rev.2898', async () => {
  const {ArtemisVariables} = await import('../dist/engines/artemis/variables.js');
  const revisions = await import('../dist/engines/artemis/revision.js');
  for (const [hash, sizeBits] of [
    [revisions.ARTEMIS_3083_X64_EXECUTABLE_SHA256, 8],
    [revisions.ARTEMIS_3179_EXECUTABLE_SHA256, 8],
    [revisions.ARTEMIS_3139_EXECUTABLE_SHA256, 8],
    [revisions.ARTEMIS_3139_RESOURCE_VARIANT_SHA256, 8],
    [revisions.ARTEMIS_3257_EXECUTABLE_SHA256, 32],
    [revisions.ARTEMIS_3257_WRAPPED_RESOURCE_VARIANT_SHA256, 32],
    [revisions.ARTEMIS_3257_RESOURCE_VARIANT_SHA256, 32],
    [revisions.ARTEMIS_3248_EXECUTABLE_SHA256, 32],
  ]) {
    const variables = new ArtemisVariables({
      executableSha256: hash,
      stageSize: () => ({width: 8, height: 8}),
    });
    revisions.initializeArtemisVariables(variables, hash);
    assert.equal(luaText(variables.read('s.llp64')), '1');
    let calls = 0;
    revisions.initializeArtemisGraphicsFeatureLevel(variables, hash, () => (++calls, 45056));
    assert.equal(calls, 1);
    assert.equal(luaText(variables.read('s.windowsfeaturelevel')), '45056');
    assert.equal(revisions.artemisRevision(hash).fontSizeBits, sizeBits);
    assert.throws(() => variables.queryLiteral('s.unimplemented_device'), /Unsupported/);
  }
  assert.throws(() => new ArtemisVariables({executableSha256: '0'.repeat(64)}), /Unsupported/);
});

test('Runtime boot publishes touch registration independently of live contacts for every exact hash', async () => {
  const {openArtemisRuntimeFixture} = await import('./artemis-runtime-fixture.mjs');
  const revisions = await import('../dist/engines/artemis/revision.js');
  const all = Object.entries(revisions)
    .filter(([name]) => /^ARTEMIS_.*(?:EXECUTABLE|RESOURCE_VARIANT)_SHA256$/.test(name))
    .map(([, hash]) => hash);
  assert.equal(all.length, 15);
  // E-mote revisions open only with their exact emotedriver.dll, which is game data.
  const hashes = all.filter((hash) => !revisions.artemisRevision(hash).emote);
  for (const hash of all.filter((hash) => revisions.artemisRevision(hash).emote))
    await assert.rejects(
      openArtemisRuntimeFixture({'system/first.iet': '[stop]'}, {hash}),
      /Missing emotedriver\.dll/,
    );
  for (const hash of hashes) {
    for (const device of [
      null,
      {registered: true, contacts: 0},
      {registered: false, contacts: 2},
    ]) {
      const holds = [];
      const fixture = await openArtemisRuntimeFixture(
        {'system/first.iet': '[stop]'},
        {
          hash,
          services: device
            ? {
                touch: {
                  registered: () => device.registered,
                  count: () => device.contacts,
                  setHold: (enabled) => holds.push(enabled),
                },
              }
            : {},
        },
      );
      try {
        fixture.runtime.variables.write('s.windowstouch', '99');
        await fixture.runtime.boot();
        fixture.runtime.lua.vm.execute(
          bytes(`
          registration = engine:var('s.windowstouch')
          contacts = engine:getTouchCount()
          engine:setUseTouchHold(true)
        `),
        );
        assert.equal(
          luaText(fixture.runtime.lua.vm.getGlobal('registration')),
          device?.registered ? '1' : '0',
        );
        assert.equal(fixture.runtime.lua.vm.getGlobal('contacts'), device?.contacts ?? 0);
        assert.deepEqual(holds, device ? [true] : []);
      } finally {
        await fixture.close();
      }
    }
  }
});

test('Game Lua restores real PNG font cache through a suspended runtime call and resumes without a return value', async () => {
  const {openArtemisRuntimeFixture} = await import('./artemis-runtime-fixture.mjs');
  const {fontCacheFixture} = await import('./artemis-font-cache-fixtures.mjs');
  const {ARTEMIS_2898_EXECUTABLE_SHA256: hash} =
    await import('../dist/engines/artemis/revision.js');
  const errors = [];
  const fixture = await openArtemisRuntimeFixture(
    {
      ...fontCacheFixture(),
      'system/first.iet': `[calllua function="bootcache"][stop]
    [lua]
      function bootcache(e)
        cacheResult = e:restoreFontCache('cache/')
        cacheCompleted = true
        e:restoreFontCache(false)
      end
    [/lua]`,
    },
    {hash, services: {reportError: (message) => errors.push(message)}},
  );
  try {
    await fixture.runtime.boot();
    assert.equal(fixture.runtime.lua.vm.getGlobal('cacheCompleted'), null);
    assert.equal(fixture.runtime.resourcePending, true);
    await fixture.runtime.settleResource();
    fixture.runtime.script.run(100);
    assert.equal(fixture.runtime.lua.vm.getGlobal('cacheCompleted'), true);
    assert.equal(fixture.runtime.lua.vm.getGlobal('cacheResult'), null);
    assert.equal(fixture.runtime.resourcePending, false);
    assert.equal(errors.length, 1);
    assert.equal(Buffer.from(errors[0]).subarray(0, 16).toString(), 'restoreFontCache');
    assert.equal(fixture.runtime.script.state, 'waiting');
  } finally {
    await fixture.close();
  }
});

test('PE32 scenario continuation survives a fresh runtime over copied saves', async () => {
  const {openArtemisRuntimeFixture} = await import('./artemis-runtime-fixture.mjs');
  const revisions = await import('../dist/engines/artemis/revision.js');
  for (const hash of [
    revisions.ARTEMIS_2601_EXECUTABLE_SHA256,
    revisions.ARTEMIS_2762_EXECUTABLE_SHA256,
    revisions.ARTEMIS_2868_EXECUTABLE_SHA256,
    revisions.ARTEMIS_2898_EXECUTABLE_SHA256,
    revisions.ARTEMIS_3083_EXECUTABLE_SHA256,
  ]) {
    const files = {
      'system/first.iet':
        '[var name="f.persisted" data="123"][font size="300"][wait time="500"][var name="f.continued" data="456"][stop]',
    };
    let expected, savedFiles;
    const first = await openArtemisRuntimeFixture(files, {hash});
    try {
      await first.runtime.boot();
      assert.equal(first.runtime.runMode, 4);
      first.runtime.save.request('restart.dat', true, true);
      await first.runtime.flushSaves();
      expected = first.runtime.scenarioArchive(true);
      savedFiles = Object.fromEntries(first.saves);
    } finally {
      await first.close();
    }
    const second = await openArtemisRuntimeFixture(files, {hash, savedFiles});
    try {
      await second.runtime.boot();
      let actual;
      second.runtime.scenarioLoaded = () => {
        actual = second.runtime.scenarioArchive();
      };
      assert.equal(await second.runtime.load.load('restart.dat', true), true);
      assert.deepEqual(actual, expected);
      assert.equal(luaText(second.runtime.variables.read('f.persisted')), '123');
      assert.equal(second.runtime.runMode, 0);
      second.runtime.script.run(100);
      assert.equal(luaText(second.runtime.variables.read('f.continued')), '456');
    } finally {
      await second.close();
    }
  }
});

test('Windows version initialization preserves failed platform queries as native zero values', async () => {
  const {ArtemisVariables} = await import('../dist/engines/artemis/variables.js');
  const {initializeArtemisWindowsVersion} = await import('../dist/engines/artemis/revision.js');
  const {BrowserWindowsSystemProfileHost} =
    await import('../dist/platform/browser-windows-system-profile.js');
  const variables = new ArtemisVariables(),
    host = new BrowserWindowsSystemProfileHost();
  initializeArtemisWindowsVersion(variables, () => host.readVersion());
  assert.equal(luaText(variables.read('s.windowsversion')), '0.0');
  initializeArtemisWindowsVersion(variables, () => ({major: 6, minor: 1}));
  assert.equal(luaText(variables.read('s.windowsversion')), '6.1');
  assert.throws(
    () => initializeArtemisWindowsVersion(variables, () => ({major: NaN, minor: 1})),
    /Invalid/,
  );
});

test('Mouse commands preserve visibility order, paired positions and unsigned auto-hide deadlines', async () => {
  const {ArtemisMouse} = await import('../dist/engines/artemis/mouse.js');
  const effects = [];
  let now = 0xfffffff0;
  const mouse = new ArtemisMouse(
    {setVisible: (v) => effects.push(v), setPosition: (x, y) => effects.push([x, y])},
    () => now,
  );
  const tag = (args) => ({
    kind: 'tag',
    name: 'mouse',
    sourceLine: -1,
    args: new Map(Object.entries(args)),
  });
  mouse.dispatch(tag({left: '12px'}));
  assert.deepEqual(effects, []);
  mouse.dispatch(tag({left: '12px', top: '-3', hide: '1', autohide: '0'}));
  assert.deepEqual(effects, [[12, -3], false, true]);
  assert.equal(mouse.explicitHidden, true);
  mouse.dispatch(tag({hide: '0', autohide: '32'}));
  effects.length = 0;
  mouse.tick(15);
  assert.deepEqual(effects, []);
  mouse.tick(16);
  assert.deepEqual(effects, [false]);
  mouse.tick(17);
  assert.deepEqual(effects, [false]);
  now = 0;
  mouse.dispatch(tag({autohide: '1'}));
  effects.length = 0;
  mouse.tick(2);
  assert.deepEqual(effects, []);
  assert.throws(() => mouse.dispatch(tag({autohide: '2147483648'})), /Unsupported/);
});

test('Named event registrations patch copied names, resolve dotted callbacks and disable failed frames', () => {
  const lua = new ArtemisLua({
    readFile: () => null,
    fileExists: () => false,
    now: () => 0,
    tag: () => {},
    enqueueTag: () => {},
    variable: () => '',
  });
  try {
    lua.vm.execute(
      bytes(`handlers={onEnterFrame='callbacks.frame',onSave='saved',onClickWait='clicked',unknown='ignored'}
      engine:setEventHandler(handlers); handlers.onSave='wrong'
      callbacks={frame=function(e,p) frameData=p and p.data; error('frame failed') end}
      function saved(e,p) savedData=p.data end
      function clicked(e) clicks=(clicks or 0)+1; return function() end end
      engine:setEventHandler{onLoad='saved',onSave=false}`),
    );
    assert.equal(lua.events.handler('onSave'), 'saved');
    assert.equal(lua.events.emit('onSave', new Map([['data', '雪']])), true);
    assert.equal(luaText(lua.vm.getGlobal('savedData')), '雪');
    lua.events.emit('onClickWaitIn');
    assert.equal(lua.vm.getGlobal('clicks'), 1);
    assert.throws(
      () => lua.events.emit('onEnterFrame', new Map([['data', 'frame']])),
      /frame failed/,
    );
    assert.equal(lua.events.emit('onEnterFrame'), false);
    lua.vm.execute(bytes(`engine:setEventHandler{onSave=''}`));
    assert.equal(lua.events.emit('onSave'), false);
    lua.vm.execute(bytes(`function clicked(e) error('click failed') end`));
    assert.throws(() => lua.events.emit('onClickWaitIn'), /click failed/);
    assert.equal(lua.events.emit('onClickWaitIn'), false);
  } finally {
    lua.close();
  }
});

test('Dialog suspends script/ASB progress until completion and writes its native result before resuming', async () => {
  const {ArtemisDialog} = await import('../dist/engines/artemis/dialog.js');
  let script, complete;
  const order = [],
    requests = [];
  const readFile = () => bytes('[calllua function="begin"][after][stop]');
  const lua = new ArtemisLua({
    readFile,
    fileExists: () => true,
    now: () => 0,
    tag: (tag) => script.executeTag(tag),
    enqueueTag: (tag) => script.enqueue(tag),
    variable: () => '',
  });
  const dialog = new ArtemisDialog(
    {
      present: (request, done) => {
        requests.push(request);
        complete = done;
      },
    },
    {
      blocked: () => false,
      beginWait: () => script.pause(),
      endWait: () => {
        order.push('resume');
        script.resume();
      },
      writeVariable: (key, value) => order.push([key, value]),
    },
  );
  try {
    lua.vm.execute(
      bytes(
        `function begin(e,p) assert(p['function']=='begin'); e:tag{'dialog',message='雪',varname='answer'} end`,
      ),
    );
    script = new ArtemisScript(lua, {
      readFile,
      dispatch: (tag) => {
        if (dialog.dispatch(tag)) return;
        order.push(tag.name);
        if (tag.name === 'stop') return 'stopped';
      },
    });
    script.load('boot');
    assert.equal(script.run(), 'waiting');
    assert.equal(dialog.pending, true);
    assert.deepEqual(order, []);
    assert.equal(requests[0].message, '雪');
    assert.equal(requests[0].canCancel, true);
    complete({result: 1});
    assert.deepEqual(order, [['answer', '1'], 'resume']);
    assert.equal(script.run(), 'stopped');
    assert.deepEqual(order, [['answer', '1'], 'resume', 'after', 'stop']);
    assert.throws(() => complete({result: 1}), /Stale or repeated/);
  } finally {
    lua.close();
  }
});

test('Synchronous dialog completion leaves no pending wait and preserves native defaults', async () => {
  const {ArtemisDialog} = await import('../dist/engines/artemis/dialog.js');
  const order = [];
  const dialog = new ArtemisDialog(
    {
      present: (request, done) => {
        assert.deepEqual(request, {
          title: '',
          message: '',
          canCancel: false,
          fontSize: 20,
          minimumWidth: 240,
          applyDesktopScale: false,
          textField: false,
          inputDelay: 500,
        });
        done({result: 0, text: ''});
      },
    },
    {
      blocked: () => false,
      beginWait: () => order.push('begin'),
      endWait: () => order.push('end'),
      writeVariable: () => assert.fail(),
    },
  );
  dialog.dispatch({kind: 'tag', name: 'dialog', sourceLine: -1, args: new Map()});
  assert.equal(dialog.pending, false);
  assert.deepEqual(order, ['begin', 'end']);
});

test('A fixed-style dialog revision ignores the font, width and desktop-scale arguments', async () => {
  const {ArtemisDialog} = await import('../dist/engines/artemis/dialog.js');
  const requests = [];
  const args = new Map([
    ['fontsize', '32'],
    ['minwidth', '500'],
    ['applydesktopscale', '1'],
  ]);
  for (const fixed of [false, true]) {
    const dialog = new ArtemisDialog(
      {present: (request, done) => (requests.push(request), done({result: 0, text: ''}))},
      {blocked: () => false, beginWait: () => {}, endWait: () => {}, writeVariable: () => {}},
      fixed,
    );
    dialog.dispatch({kind: 'tag', name: 'dialog', sourceLine: -1, args});
  }
  assert.deepEqual(
    requests.map((r) => [r.fontSize, r.minimumWidth, r.applyDesktopScale]),
    [
      [32, 500, true],
      [20, 240, false],
    ],
  );
});

test('Text-field dialogs write the result, then the field text cut to its size in characters', async () => {
  const {ArtemisDialog} = await import('../dist/engines/artemis/dialog.js');
  const requests = [],
    callbacks = [],
    writes = [];
  const dialog = new ArtemisDialog(
    {
      present: (request, done) => {
        requests.push(request);
        callbacks.push(done);
      },
    },
    {
      blocked: () => false,
      beginWait: () => writes.push('begin'),
      endWait: () => writes.push('end'),
      writeVariable: (k, v) => writes.push([k, v]),
    },
  );
  const run = (args, outcome) => {
    writes.length = 0;
    dialog.dispatch({kind: 'tag', name: 'dialog', sourceLine: -1, args: new Map(args)});
    callbacks.at(-1)(outcome);
    return [...writes];
  };
  const field = [
    ['varname', 'yn'],
    ['textfield', 'tx'],
    ['message', '雪'],
  ];
  assert.deepEqual(run([...field, ['textfieldsize', '3']], {result: 1, text: 'aé雪😀b'}), [
    'begin',
    ['yn', '1'],
    ['tx', 'aé雪'],
    'end',
  ]);
  assert.equal(requests.at(-1).textField, true);
  assert.equal(requests.at(-1).message, '雪');
  assert.equal(requests.at(-1).canCancel, true);
  // A cancelled dialog still hands back its text; 0 keeps everything and a NUL ends it.
  assert.deepEqual(run(field, {result: 0, text: '😀😀😀😀\0x'}), [
    'begin',
    ['yn', '0'],
    ['tx', '😀😀😀😀\0x'],
    'end',
  ]);
  assert.deepEqual(
    run([...field, ['textfieldsize', '-1']], {result: 1, text: 'ab\0c'}).slice(1, 3),
    [
      ['yn', '1'],
      ['tx', 'ab'],
    ],
  );
  assert.deepEqual(run([...field, ['textfieldsize', '1']], {result: 1, text: '😀x'}).slice(2, 3), [
    ['tx', '😀'],
  ]);
  // An empty field name shows the field but writes nothing for it.
  assert.deepEqual(run([['textfield', '']], {result: 1, text: 'z'}), ['begin', 'end']);
  assert.equal(requests.at(-1).textField, true);
  assert.equal(requests.at(-1).canCancel, false);
  dialog.dispatch({kind: 'tag', name: 'dialog', sourceLine: -1, args: new Map(field)});
  assert.throws(() => callbacks.at(-1)({result: 1}), /text is missing/);
});

test('The file tag copies into the save directory, removes files and ignores other commands', async () => {
  const {ArtemisFileCommand} = await import('../dist/engines/artemis/file-command.js');
  const files = new Map([['src.dat', Uint8Array.of(1, 2)]]),
    events = [];
  const command = new ArtemisFileCommand({
    readPackFile: async (path) => files.get(path) ?? null,
    writeFile: async (path, bytes) => {
      if (path.startsWith('ro/')) return false;
      files.set(path, bytes);
      return true;
    },
    removeFile: (path) => {
      events.push(['remove', path]);
      files.delete(path);
    },
    clearArchiveCache: () => events.push(['clear']),
    sourceNotFound: (tag) => events.push(['missing', tag.args.get('src')]),
    destinationNotCreated: (tag) => events.push(['uncreated', tag.args.get('dst')]),
  });
  const tag = (...args) => ({kind: 'tag', name: 'file', sourceLine: -1, args: new Map(args)});
  assert.equal(command.dispatch({...tag(), name: 'dialog'}), false);
  assert.equal(
    await command.dispatch(tag(['command', 'copy'], ['src', 'src.dat'], ['dst', 'dst.dat'])),
    true,
  );
  assert.deepEqual([...files.get('dst.dat')], [1, 2]);
  await command.dispatch(tag(['command', 'copy'], ['src', 'none.dat'], ['dst', 'x.dat']));
  await command.dispatch(tag(['command', 'copy'], ['src', 'src.dat'], ['dst', 'ro/x.dat']));
  assert.equal(command.dispatch(tag(['command', 'delete'], ['target', 'dst.dat'])), true);
  assert.equal(command.dispatch(tag(['command', 'delete'])), true);
  assert.equal(command.dispatch(tag(['command', 'clear_cache'])), true);
  assert.equal(command.dispatch(tag(['command', 'Delete'], ['target', 'src.dat'])), true);
  assert.equal(command.dispatch(tag()), true);
  assert.deepEqual(events, [
    ['missing', 'none.dat'],
    ['uncreated', 'ro/x.dat'],
    ['remove', 'dst.dat'],
    ['remove', ''],
    ['clear'],
  ]);
  assert.deepEqual([...files.keys()], ['src.dat']);
});

test('The save directory shows changes at once and applies them to storage in call order', async () => {
  const {ArtemisSaveDirectory} = await import('../dist/engines/artemis/save-directory.js');
  const records = new Map([['old.dat', Uint8Array.of(9)]]),
    log = [];
  let failNext = false;
  const storage = {
    read: async (name) => (log.push(['read', name]), records.get(name) ?? null),
    write: async (name, bytes) => {
      await new Promise((r) => setTimeout(r, 5));
      if (failNext) {
        failNext = false;
        throw Error('disk full');
      }
      log.push(['write', name]);
      records.set(name, bytes);
    },
    delete: (name) => void (log.push(['delete', name]), records.delete(name)),
    list: async () => [...records.keys()],
  };
  const saves = await ArtemisSaveDirectory.open(storage);
  assert.equal(saves.has('old.dat'), true);
  let pack;
  const packed = new Promise((r) => (pack = r));
  void saves.write('a.dat', packed);
  assert.equal(saves.has('a.dat'), true);
  const firstRead = saves.read('a.dat');
  void saves.remove('a.dat');
  assert.equal(saves.has('a.dat'), false);
  void saves.write('b.dat', Uint8Array.of(2));
  const removedRead = saves.read('a.dat');
  pack(Uint8Array.of(1));
  assert.deepEqual([...(await firstRead)], [1]);
  assert.equal(await removedRead, null);
  assert.deepEqual(log, [
    ['write', 'a.dat'],
    ['read', 'a.dat'],
    ['delete', 'a.dat'],
    ['write', 'b.dat'],
    ['read', 'a.dat'],
  ]);
  failNext = true;
  void saves.write('c.dat', Uint8Array.of(3));
  void saves.remove('old.dat');
  await assert.rejects(saves.flush(), /disk full/);
  assert.deepEqual([...records.keys()], ['b.dat']);
  const readOnly = await ArtemisSaveDirectory.open({read: async () => null, write() {}});
  void readOnly.write('x.dat', Uint8Array.of(0));
  assert.throws(() => readOnly.remove('x.dat'), /cannot delete/);
  assert.equal(readOnly.has('x.dat'), true);
});

test('Stale dialog callbacks cannot complete a subsequent dialog', async () => {
  const {ArtemisDialog} = await import('../dist/engines/artemis/dialog.js');
  const callbacks = [],
    writes = [];
  const dialog = new ArtemisDialog(
    {present: (_, done) => callbacks.push(done)},
    {
      blocked: () => false,
      beginWait: () => {},
      endWait: () => {},
      writeVariable: (k, v) => writes.push([k, v]),
    },
  );
  const tag = {kind: 'tag', name: 'dialog', sourceLine: -1, args: new Map([['varname', 'answer']])};
  dialog.dispatch(tag);
  callbacks[0]({result: 1});
  dialog.dispatch(tag);
  assert.throws(() => callbacks[0]({result: 0}), /Stale or repeated/);
  assert.equal(dialog.pending, true);
  callbacks[1]({result: 0});
  assert.equal(dialog.pending, false);
  assert.deepEqual(writes, [
    ['answer', '1'],
    ['answer', '0'],
  ]);
});

test('Native save-gate tracks changed global g. bytes and orders scenario/global/system effects', async () => {
  const {ArtemisVariables} = await import('../dist/engines/artemis/variables.js');
  const {ArtemisSave} = await import('../dist/engines/artemis/save.js');
  const variables = new ArtemisVariables(),
    calls = [];
  const save = new ArtemisSave(variables, {
    beforeScenario: (file) => calls.push(['before', file]),
    reportEventError: (error) => calls.push(['error', String(error)]),
    writeScenario: (file, transient) => calls.push(['scenario', file, transient]),
    writeGlobal: () => calls.push('global'),
    writeSystem: () => calls.push('system'),
  });
  assert.equal(save.request(''), false);
  assert.deepEqual(calls, []);
  variables.write('g.flag', Uint8Array.of(0, 255));
  assert.equal(variables.globalDirty, true);
  save.request('slot.dat', true);
  assert.deepEqual(calls, [
    ['before', 'slot.dat'],
    ['scenario', 'slot.dat', true],
    'global',
    'system',
  ]);
  assert.equal(variables.globalDirty, false);
  calls.length = 0;
  variables.write('g.flag', Uint8Array.of(0, 255));
  assert.equal(variables.globalDirty, false);
  variables.pushLocal();
  variables.write('g.flag', 'local', true);
  assert.equal(variables.globalDirty, false);
  variables.popLocal();
  variables.delete('g.flag');
  assert.equal(variables.globalDirty, false);
  variables.write('sf', '');
  assert.equal(variables.globalDirty, false);
  variables.write('g.', '');
  assert.equal(variables.globalDirty, true);
  save.request('');
  assert.deepEqual(calls, ['global', 'system']);
});

test('The exit tag enters run mode 14, writes fullscreenatexit and forces the global save', async () => {
  const {ArtemisSave} = await import('../dist/engines/artemis/save.js');
  const {ArtemisExit} = await import('../dist/engines/artemis/exit.js');
  const {ArtemisVariables} = await import('../dist/engines/artemis/variables.js');
  const calls = [];
  let mode = 1;
  const save = new ArtemisSave(new ArtemisVariables(), {
    beforeScenario: (file) => calls.push(['before', file]),
    reportEventError: (error) => calls.push(['error', String(error)]),
    writeScenario: (file) => calls.push(['scenario', file]),
    writeGlobal: () => calls.push('global'),
    writeSystem: () => calls.push('system'),
  });
  const exit = new ArtemisExit(save, {
    runMode: () => mode,
    enterExitMode: () => calls.push(['mode', (mode = 14)]),
    fullscreen: () => true,
    writeStatus: (name, value) => calls.push([name, value]),
  });
  const tag = (name) => ({kind: 'tag', name, args: new Map(), sourceLine: 1});
  assert.equal(exit.dispatch(tag('return')), false);
  assert.equal(exit.dispatch(tag('exit')), true);
  // Clean global variables are still written: the exit forces the global save.
  assert.deepEqual(calls, [['mode', 14], ['s.status.fullscreenatexit', '1'], 'global', 'system']);
  // A load holding run mode 13 keeps it.
  calls.length = 0;
  mode = 13;
  exit.exit();
  assert.deepEqual(calls, []);
});

test('Exact-hash exit saves preserve absent or restored fullscreen status for the older PE32 profiles', async () => {
  const {openArtemisRuntimeFixture} = await import('./artemis-runtime-fixture.mjs');
  const revision = await import('../dist/engines/artemis/revision.js');
  const hashes = [
    revision.ARTEMIS_2601_EXECUTABLE_SHA256,
    revision.ARTEMIS_2762_EXECUTABLE_SHA256,
    revision.ARTEMIS_2868_EXECUTABLE_SHA256,
    revision.ARTEMIS_2898_EXECUTABLE_SHA256,
    revision.ARTEMIS_2908_EXECUTABLE_SHA256,
    revision.ARTEMIS_3083_EXECUTABLE_SHA256,
    revision.ARTEMIS_3083_X64_EXECUTABLE_SHA256,
    revision.ARTEMIS_3179_EXECUTABLE_SHA256,
    revision.ARTEMIS_3139_EXECUTABLE_SHA256,
    revision.ARTEMIS_3139_RESOURCE_VARIANT_SHA256,
    revision.ARTEMIS_3257_EXECUTABLE_SHA256,
    revision.ARTEMIS_3257_WRAPPED_RESOURCE_VARIANT_SHA256,
    revision.ARTEMIS_3257_RESOURCE_VARIANT_SHA256,
    revision.ARTEMIS_3248_EXECUTABLE_SHA256,
  ];
  const key = 's.status.fullscreenatexit';
  for (const hash of hashes) {
    for (const restored of [false, true]) {
      const prefix = restored ? `[var name="${key}" data="retained"]` : '';
      const first = await openArtemisRuntimeFixture(
        {'system/first.iet': `${prefix}[exit]`},
        {hash},
      );
      let savedFiles;
      const expected = [
        revision.ARTEMIS_2601_EXECUTABLE_SHA256,
        revision.ARTEMIS_2762_EXECUTABLE_SHA256,
        revision.ARTEMIS_2868_EXECUTABLE_SHA256,
        revision.ARTEMIS_2898_EXECUTABLE_SHA256,
        revision.ARTEMIS_2908_EXECUTABLE_SHA256,
      ].includes(hash)
        ? restored
          ? 'retained'
          : undefined
        : '0';
      try {
        await first.runtime.boot();
        assert.equal(first.runtime.runMode, revision.artemisRevision(hash).exitRunMode);
        await first.runtime.flushSaves();
        const value = first.runtime.variables.lookup(key);
        assert.equal(value === undefined ? undefined : luaText(value), expected);
        // Even clean globals must be saved when exit omits the status write.
        assert.ok(first.saves.has('saveg.dat'));
        assert.ok(first.saves.has('system.dat'));
        savedFiles = Object.fromEntries(first.saves);
      } finally {
        await first.close();
      }
      const fresh = await openArtemisRuntimeFixture(
        {'system/first.iet': '[stop]'},
        {hash, savedFiles},
      );
      try {
        await fresh.runtime.boot();
        const value = fresh.runtime.variables.lookup(key);
        assert.equal(value === undefined ? undefined : luaText(value), expected);
      } finally {
        await fresh.close();
      }
    }
  }
});

test('Rev.2898 exit needs no fullscreen owner and still respects the replay hold', async () => {
  const {ArtemisSave} = await import('../dist/engines/artemis/save.js');
  const {ArtemisExit} = await import('../dist/engines/artemis/exit.js');
  const {ArtemisVariables} = await import('../dist/engines/artemis/variables.js');
  const {artemisRevision, ARTEMIS_2898_EXECUTABLE_SHA256} =
    await import('../dist/engines/artemis/revision.js');
  const profile = artemisRevision(ARTEMIS_2898_EXECUTABLE_SHA256);
  const calls = [];
  let mode = profile.loadRunMode;
  const save = new ArtemisSave(new ArtemisVariables(), {
    beforeScenario: () => assert.fail('exit is not a scenario save'),
    reportEventError: () => assert.fail('unexpected save callback'),
    writeScenario: () => assert.fail('exit is not a scenario save'),
    writeGlobal: () => calls.push('global'),
    writeSystem: () => calls.push('system'),
  });
  const exit = new ArtemisExit(
    save,
    {
      runMode: () => mode,
      enterExitMode: () => calls.push(['mode', (mode = profile.exitRunMode)]),
      fullscreen: () => assert.fail('this native exit never queries fullscreen'),
      writeStatus: () => assert.fail('this native exit never writes fullscreen status'),
    },
    profile.loadRunMode,
    profile.publishesFullscreenAtExit,
  );
  exit.exit();
  assert.deepEqual(calls, []);
  mode = 1;
  exit.exit();
  assert.deepEqual(calls, [['mode', 14], 'global', 'system']);
});

test('Timed wait preserves strict deadline, event/save/message ordering and zero sentinel', async () => {
  const {ArtemisTimedWait} = await import('../dist/engines/artemis/wait.js');
  const {ArtemisModes} = await import('../dist/engines/artemis/modes.js');
  const {ArtemisSave} = await import('../dist/engines/artemis/save.js');
  const {ArtemisVariables} = await import('../dist/engines/artemis/variables.js');
  const calls = [];
  let clock = 100;
  const modes = new ArtemisModes({
    writeStatus: () => {},
    commandSkipChanged: () => {},
    controlSkipChanged: () => {},
    automodeChanged: () => {},
    releaseScheduler: () => {},
  });
  modes.autosave = 2;
  const save = new ArtemisSave(new ArtemisVariables(), {
    reportEventError: (error) => calls.push(String(error)),
    beforeScenario: (file) => calls.push(['saveEvent', file]),
    writeScenario: (file) => calls.push(['save', file]),
    writeGlobal: () => calls.push('global'),
    writeSystem: () => calls.push('system'),
  });
  const wait = new ArtemisTimedWait(modes, save, {
    now: () => clock,
    debugSkipActive: () => false,
    startTextDisplay: (skip) => calls.push(['display', skip]),
    textDisplayComplete: () => true,
    finishTextDisplay: () => calls.push('finish'),
    writeClickSkip: () => calls.push('clickskip'),
    beginWait: (input) => calls.push(['begin', input]),
    endWait: () => calls.push('end'),
    clickWaitEvent: (kind) => calls.push(kind),
    resumeMessageState: () => calls.push('message'),
  });
  const tag = (args) => ({
    kind: 'tag',
    name: 'wait',
    sourceLine: -1,
    args: new Map(Object.entries(args)),
  });
  wait.dispatch(tag({time: '10', input: '1'}));
  assert.deepEqual(calls, [
    ['display', false],
    ['begin', true],
    'in',
    ['saveEvent', 'autosave.dat'],
    ['save', 'autosave.dat'],
  ]);
  assert.equal(wait.tick(110), false);
  assert.equal(wait.tick(111), true);
  assert.deepEqual(calls.slice(-3), ['end', 'out', 'message']);
  assert.equal(wait.tick(112), false);
  clock = 0;
  calls.length = 0;
  modes.autosave = 0;
  wait.dispatch(tag({time: '0'}));
  assert.equal(wait.tick(1), false);
  assert.equal(wait.pending, true);
});

test('Input=2 skip bypasses setup; unowned video, se and scenario=2 waits fail before effects', async () => {
  const {ArtemisTimedWait} = await import('../dist/engines/artemis/wait.js');
  const {ArtemisModes} = await import('../dist/engines/artemis/modes.js');
  const {ArtemisSave} = await import('../dist/engines/artemis/save.js');
  const {ArtemisVariables} = await import('../dist/engines/artemis/variables.js');
  const modes = new ArtemisModes({
    writeStatus: () => {},
    commandSkipChanged: () => {},
    controlSkipChanged: () => {},
    automodeChanged: () => {},
    releaseScheduler: () => {},
  });
  const unexpected = () => assert.fail('unexpected effect');
  const save = new ArtemisSave(new ArtemisVariables(), {
    reportEventError: unexpected,
    beforeScenario: unexpected,
    writeScenario: unexpected,
    writeGlobal: unexpected,
    writeSystem: unexpected,
  });
  const wait = new ArtemisTimedWait(modes, save, {
    now: () => 1,
    debugSkipActive: () => false,
    startTextDisplay: unexpected,
    textDisplayComplete: unexpected,
    finishTextDisplay: unexpected,
    writeClickSkip: unexpected,
    beginWait: unexpected,
    endWait: unexpected,
    clickWaitEvent: unexpected,
    resumeMessageState: unexpected,
  });
  const tag = (args) => ({
    kind: 'tag',
    name: 'wait',
    sourceLine: -1,
    args: new Map(Object.entries(args)),
  });
  modes.setCommandSkip(true);
  assert.equal(wait.dispatch(tag({input: '2', video: 'x'})), true);
  assert.equal(wait.pending, false);
  modes.setCommandSkip(false);
  assert.throws(() => wait.dispatch(tag({video: 'x'})), /video wait owner/);
  assert.throws(() => wait.dispatch(tag({se: 'x', video: 'x'})), /se wait owner/);
  assert.throws(() => wait.dispatch(tag({scenario: '2'})), /scenario=2/);
  assert.equal(wait.pending, false);
});

test('Automode gives a completed click-wait the s.automodewait deadline; syncse se holds it; skip clicks', async () => {
  const {ArtemisTimedWait} = await import('../dist/engines/artemis/wait.js');
  const {ArtemisModes} = await import('../dist/engines/artemis/modes.js');
  const {ArtemisSave} = await import('../dist/engines/artemis/save.js');
  const {ArtemisVariables} = await import('../dist/engines/artemis/variables.js');
  const calls = [];
  let complete = false;
  const playing = new Set();
  const modes = new ArtemisModes({
    writeStatus: () => {},
    commandSkipChanged: () => {},
    controlSkipChanged: () => {},
    automodeChanged: (active) => calls.push(['auto', active]),
    releaseScheduler: () => {},
    currentMessageLayer: () => 'mw',
  });
  const save = new ArtemisSave(new ArtemisVariables(), {
    reportEventError: () => {},
    beforeScenario: () => {},
    writeScenario: () => {},
    writeGlobal: () => {},
    writeSystem: () => {},
  });
  const wait = new ArtemisTimedWait(modes, save, {
    now: () => 0,
    debugSkipActive: () => false,
    startTextDisplay: (skip) => calls.push(['display', skip]),
    textDisplayComplete: () => complete,
    finishTextDisplay: () => ((complete = true), calls.push('finish')),
    writeClickSkip: () => calls.push('clickskip'),
    beginWait: () => {},
    endWait: () => calls.push('end'),
    clickWaitEvent: () => {},
    resumeMessageState: () => {},
    effectIndex: (id) => ({voice: 3})[id],
    effectPlaying: (index) => playing.has(index),
    automodeWait: () => 500,
    placeClickGlyph: () => calls.push('glyph'),
  });
  const tag = (name, args = {}) => ({
    kind: 'tag',
    name,
    sourceLine: -1,
    args: new Map(Object.entries(args)),
  });
  modes.automodeAllowed = true;
  modes.dispatch(tag('automode', {syncse: 'missing,voice'}));
  modes.setAutomode(true);
  wait.dispatch(tag('@'));
  calls.length = 0;
  // No deadline while the display runs or outside run mode 1.
  assert.equal(wait.tick(1000, false, true), false);
  complete = true;
  assert.equal(wait.tick(1000), false);
  assert.equal(wait.deadlineTick, 0);
  assert.equal(wait.tick(1000, false, true), false);
  assert.equal(wait.deadlineTick, 1500);
  // The click glyph is placed when the deadline is armed.
  assert.deepEqual(calls.splice(0), ['glyph']);
  // A playing syncse id holds the passed deadline until the sound stops.
  playing.add(3);
  assert.equal(wait.tick(1501, false, true), false);
  playing.delete(3);
  assert.equal(wait.tick(1502, false, true), true);
  assert.deepEqual(calls.splice(0), ['end']);
  // Turning automode off clears the deadline of a flagless wait.
  wait.dispatch(tag('@'));
  wait.tick(2000, false, true);
  assert.equal(wait.deadlineTick, 2500);
  modes.setAutomode(false);
  wait.clearAutomodeDeadline();
  assert.equal(wait.deadlineTick, 0);
  assert.equal(wait.tick(3000, false, true), false);
  // An active skip is the click: an incomplete display finishes, then the wait ends.
  complete = false;
  assert.equal(wait.tick(3001, true, true), false);
  assert.equal(wait.tick(3002, true, true), true);
  calls.length = 0;
  modes.dispatch(tag('skip', {allow: '1'}));
  modes.setCommandSkip(true);
  wait.dispatch(tag('wait', {time: '1000', input: '1'}));
  assert.deepEqual(calls.splice(0), [['display', true]]);
});

test('A trans type=0 deadline ends its run mode 4 wait once passed, without input events', async () => {
  const {ArtemisTimedWait} = await import('../dist/engines/artemis/wait.js');
  const {ArtemisModes} = await import('../dist/engines/artemis/modes.js');
  const {ArtemisSave} = await import('../dist/engines/artemis/save.js');
  const {ArtemisVariables} = await import('../dist/engines/artemis/variables.js');
  const calls = [];
  const modes = new ArtemisModes({
    writeStatus: () => {},
    commandSkipChanged: () => {},
    controlSkipChanged: () => {},
    automodeChanged: () => {},
    releaseScheduler: () => {},
    currentMessageLayer: () => 'mw',
  });
  const save = new ArtemisSave(new ArtemisVariables(), {
    reportEventError: () => {},
    beforeScenario: () => {},
    writeScenario: () => {},
    writeGlobal: () => {},
    writeSystem: () => {},
  });
  const wait = new ArtemisTimedWait(modes, save, {
    now: () => 0,
    debugSkipActive: () => false,
    startTextDisplay: () => calls.push('display'),
    textDisplayComplete: () => true,
    finishTextDisplay: () => calls.push('finish'),
    writeClickSkip: () => calls.push('clickskip'),
    beginWait: () => calls.push('begin'),
    endWait: () => calls.push('end'),
    clickWaitEvent: (kind) => calls.push(kind),
    resumeMessageState: () => calls.push('message'),
  });
  wait.setDeadline(100);
  assert.equal(wait.pending, true);
  assert.deepEqual(wait.reason, {time: 100});
  assert.equal(wait.tick(100), false);
  assert.equal(wait.tick(101), true);
  assert.equal(wait.pending, false);
  assert.deepEqual(calls, ['end', 'message']);
});

test('wait se= follows the seplay index until the sound stops; unknown ids set no wait', async () => {
  const {ArtemisTimedWait} = await import('../dist/engines/artemis/wait.js');
  const {ArtemisModes} = await import('../dist/engines/artemis/modes.js');
  const {ArtemisSave} = await import('../dist/engines/artemis/save.js');
  const {ArtemisVariables} = await import('../dist/engines/artemis/variables.js');
  const modes = new ArtemisModes({
    writeStatus: () => {},
    commandSkipChanged: () => {},
    controlSkipChanged: () => {},
    automodeChanged: () => {},
    releaseScheduler: () => {},
  });
  const unexpected = () => assert.fail('unexpected effect');
  const effects = [],
    saves = [];
  const save = new ArtemisSave(new ArtemisVariables(), {
    reportEventError: unexpected,
    beforeScenario: unexpected,
    writeScenario: unexpected,
    writeGlobal: unexpected,
    writeSystem: unexpected,
  });
  save.request = (name) => saves.push(name);
  let playing = true,
    complete = true;
  const wait = new ArtemisTimedWait(modes, save, {
    now: () => 1,
    debugSkipActive: () => false,
    startTextDisplay: unexpected,
    textDisplayComplete: () => complete,
    finishTextDisplay: () => effects.push('finish'),
    writeClickSkip: () => effects.push('clickskip'),
    beginWait: (input) => effects.push({begin: input}),
    endWait: () => effects.push('end'),
    clickWaitEvent: (kind) => effects.push({event: kind}),
    resumeMessageState: () => effects.push('resume'),
    effectIndex: (id) => ({3: 7})[id],
    effectPlaying: (index) => (effects.push({query: index}), playing),
  });
  const tag = (args) => ({
    kind: 'tag',
    name: 'wait',
    sourceLine: -1,
    args: new Map(Object.entries(args)),
  });
  // An id seplay never registered returns before any wait state, even with `time`.
  assert.equal(wait.dispatch(tag({se: '9', time: '100', input: '1'})), true);
  assert.equal(wait.pending, false);
  assert.deepEqual(effects, []);
  assert.throws(() => wait.dispatch(tag({se: '3', time: '100'})), /timed se/);

  assert.equal(wait.dispatch(tag({se: '3', input: '1', video: 'v', scenario: '1'})), true);
  assert.equal(wait.soundPending, true);
  assert.equal(wait.videoPending, false);
  assert.deepEqual(wait.reason, {sound: '3'});
  assert.equal(wait.tick(16), false);
  playing = false;
  assert.equal(wait.tick(32), true);
  assert.deepEqual(effects, [
    {begin: true},
    {event: 'in'},
    {query: 7},
    {query: 7},
    'end',
    {event: 'out'},
    'resume',
  ]);
  assert.deepEqual(saves, ['']);

  // input=1: a click on a complete display ends it and writes s.clickskip (flag b9b).
  effects.length = 0;
  playing = true;
  wait.dispatch(tag({se: '3', input: '1'}));
  assert.equal(wait.tick(48, true), true);
  assert.deepEqual(effects, [
    {begin: true},
    {event: 'in'},
    'clickskip',
    'end',
    {event: 'out'},
    'resume',
  ]);
  assert.equal(wait.pending, false);
});

const TEXT_DISPLAY_HASH = '8953562b80608046662bd8c89015d04236b0ba3afee10c36469c11403de3ebaf';
function textDisplayFixture(ArtemisTextDisplay, registry) {
  const actors = new Map();
  const actor = (key) => {
    if (!actors.has(key)) {
      const values = {left: 0, top: 0, alpha: 1, xscale: 1, yscale: 1, rotate: 0};
      actors.set(key, {
        values,
        property: (name) => values[name],
        setProperty: (name, value) => (values[name] = value),
      });
    }
    return actors.get(key);
  };
  const glyph = (id) => ({glyph: {id}, x: 0, y: 0, advance: 10});
  const lines = [
    [
      {width: 20, height: 10, main: [glyph(0), glyph(1)], ruby: []},
      {width: 10, height: 10, main: [glyph(2)], ruby: [glyph(3), glyph(4)]},
    ],
  ];
  let count = 5;
  const display = new ArtemisTextDisplay(TEXT_DISPLAY_HASH, registry, {
    lines: () => lines,
    glyphIndex: (g) => g.id,
    glyphCount: () => count,
    glyphActor: (g) => actor(g.id),
    blockActor: (block) => actor(block),
  });
  return {
    display,
    lines,
    alpha: (id) => actor(id).values.alpha,
    blockAlpha: (block) => actor(block).values.alpha,
    append(id) {
      lines.push([{width: 10, height: 10, main: [glyph(id)], ruby: []}]);
      count = id + 1;
    },
  };
}
const alphaIn = (overrides = {}) => ({
  parameter: 'alpha',
  entire: false,
  ease: 0,
  diff: -1,
  time: 100,
  delay: 10,
  randomDelay: false,
  outgoing: false,
  ...overrides,
});

test('Text display staggers in-tweens per glyph, continues from the display start and finishes on demand', async () => {
  const {ArtemisTextDisplay} = await import('../dist/engines/artemis/text-display.js');
  const {ArtemisTweenRegistry} = await import('../dist/engines/artemis/tween.js');
  const registry = new ArtemisTweenRegistry(TEXT_DISPLAY_HASH);
  const fixture = textDisplayFixture(ArtemisTextDisplay, registry);
  const {display} = fixture;
  display.show([alphaIn()], true);
  // In-tweens jump to value + diff at creation.
  for (const id of [0, 1, 2, 3, 4]) assert.equal(fixture.alpha(id), 0);
  assert.equal(display.tweens.length, 5);
  assert.equal(display.start, 5);
  assert.equal(display.complete, false);
  registry.tick(1000);
  registry.tick(1070);
  // Main glyph delays 0/10/20; ruby glyphs spread their block's main count: 20 and 25.
  const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual}`);
  close(fixture.alpha(0), 0.7);
  close(fixture.alpha(1), 0.6);
  close(fixture.alpha(2), 0.5);
  close(fixture.alpha(3), 0.5);
  close(fixture.alpha(4), 0.45);
  registry.tick(1124);
  assert.equal(display.complete, false);
  // The last ruby tween ends at 1025 + 100; the step that reaches it unregisters it.
  registry.tick(1125);
  assert.equal(display.complete, true);
  for (const id of [0, 1, 2, 3, 4]) assert.equal(fixture.alpha(id), 1);

  // A continued start only animates glyphs at or after the display start, from order 0.
  fixture.append(5);
  display.show([alphaIn()], true);
  assert.equal(display.tweens.length, 6);
  assert.equal(fixture.alpha(5), 0);
  assert.equal(fixture.alpha(0), 1);
  assert.equal(display.complete, false);
  display.finish();
  assert.equal(fixture.alpha(5), 1);
  assert.equal(display.tweens.length, 0);
  assert.equal(display.complete, true);

  // `entire*` animates blocks with the cumulative main count of all blocks as order.
  display.show([alphaIn({entire: true, delay: 100})], false);
  assert.equal(display.tweens.length, 3);
  const blocks = fixture.lines.flat();
  registry.tick(2000);
  registry.tick(2050);
  close(fixture.blockAlpha(blocks[0]), 0.5);
  assert.equal(fixture.blockAlpha(blocks[1]), 0);
  registry.tick(2250);
  close(fixture.blockAlpha(blocks[1]), 0.5);
  assert.equal(fixture.blockAlpha(blocks[2]), 0);
  display.clear();
  assert.equal(display.start, 0);
  assert.equal(display.complete, true);
  assert.throws(() => display.show([alphaIn({randomDelay: true})], true), /random text display/);
});

test('Scenario waits end with the text display; @ click-waits finish the display before a click ends them', async () => {
  const {ArtemisTextDisplay} = await import('../dist/engines/artemis/text-display.js');
  const {ArtemisTweenRegistry} = await import('../dist/engines/artemis/tween.js');
  const {ArtemisTimedWait} = await import('../dist/engines/artemis/wait.js');
  const {ArtemisModes} = await import('../dist/engines/artemis/modes.js');
  const {ArtemisSave} = await import('../dist/engines/artemis/save.js');
  const {ArtemisVariables} = await import('../dist/engines/artemis/variables.js');
  const registry = new ArtemisTweenRegistry(TEXT_DISPLAY_HASH);
  const fixture = textDisplayFixture(ArtemisTextDisplay, registry);
  const calls = [];
  const modes = new ArtemisModes({
    writeStatus: () => {},
    commandSkipChanged: () => {},
    controlSkipChanged: () => {},
    automodeChanged: () => {},
    releaseScheduler: () => {},
  });
  const save = new ArtemisSave(new ArtemisVariables(), {
    reportEventError: (error) => calls.push(String(error)),
    beforeScenario: () => {},
    writeScenario: (file) => calls.push(['save', file]),
    writeGlobal: () => {},
    writeSystem: () => {},
  });
  const wait = new ArtemisTimedWait(modes, save, {
    now: () => 500,
    debugSkipActive: () => false,
    startTextDisplay: (skip) => {
      calls.push(['display', skip]);
      fixture.display.show(skip ? [] : [alphaIn()], true);
    },
    textDisplayComplete: () => fixture.display.complete,
    finishTextDisplay: () => {
      calls.push('finish');
      fixture.display.finish();
    },
    writeClickSkip: () => calls.push('clickskip'),
    beginWait: (input) => calls.push(['begin', input]),
    endWait: () => calls.push('end'),
    clickWaitEvent: (kind) => calls.push(kind),
    resumeMessageState: () => calls.push('message'),
  });
  const tag = (name, args = {}) => ({
    kind: 'tag',
    name,
    sourceLine: -1,
    args: new Map(Object.entries(args)),
  });
  wait.dispatch(tag('wait', {scenario: '1', input: '1'}));
  assert.equal(wait.scenarioPending, true);
  assert.equal(wait.deadlineTick, 0);
  assert.deepEqual(calls.splice(0), [['display', false], ['begin', true], 'in']);
  registry.tick(1000);
  assert.equal(wait.tick(1000), false);
  registry.tick(1126);
  assert.equal(wait.tick(1126), true);
  assert.deepEqual(calls.splice(0), ['end', 'out', 'message']);

  fixture.append(5);
  wait.dispatch(tag('@'));
  assert.equal(wait.clickPending, true);
  assert.deepEqual(calls.splice(0), [['display', false], ['begin', true], 'in']);
  // Without flags the wait never ends by itself.
  registry.tick(2000);
  registry.tick(3000);
  assert.equal(wait.tick(3000), false);
  assert.equal(wait.tick(3001, true), true);
  // A complete display ends `@` on the click without s.clickskip.
  assert.deepEqual(calls.splice(0), ['end', 'out', 'message']);

  // An early click finishes the display and marks s.clickskip; the next click ends it.
  fixture.append(6);
  wait.dispatch(tag('@'));
  calls.length = 0;
  assert.equal(fixture.alpha(6), 0);
  assert.equal(wait.tick(4000, true), false);
  assert.deepEqual(calls.splice(0), ['finish', 'clickskip']);
  assert.equal(fixture.alpha(6), 1);
  assert.equal(wait.tick(4016, true), true);
  assert.deepEqual(calls.splice(0), ['end', 'out', 'message']);

  // An early click on a scenario wait finishes the display; the same frame then ends it.
  fixture.append(7);
  wait.dispatch(tag('wait', {scenario: '1', input: '1'}));
  calls.length = 0;
  assert.equal(wait.tick(5000, true), true);
  assert.deepEqual(calls.splice(0), ['finish', 'clickskip', 'end', 'out', 'message']);
  // Timed waits also end on a click once the display is complete, marking s.clickskip.
  wait.dispatch(tag('wait', {time: '1000', input: '1'}));
  calls.length = 0;
  assert.equal(wait.tick(5016, true), true);
  assert.deepEqual(calls.splice(0), ['clickskip', 'end', 'out', 'message']);
});
test('Save callback errors are reported before native save continues, and dirty clears before system failure', async () => {
  const {ArtemisSave} = await import('../dist/engines/artemis/save.js');
  const {ArtemisVariables} = await import('../dist/engines/artemis/variables.js');
  const variables = new ArtemisVariables();
  variables.write('g.dirty', '1');
  const calls = [];
  const save = new ArtemisSave(variables, {
    beforeScenario: () => {
      throw Error('callback');
    },
    reportEventError: (error) => calls.push(error.message),
    writeScenario: () => calls.push('scenario'),
    writeGlobal: () => calls.push('global'),
    writeSystem: () => {
      assert.equal(variables.globalDirty, false);
      throw Error('system failure');
    },
  });
  assert.throws(() => save.request('slot'), /system failure/);
  assert.deepEqual(calls, ['callback', 'scenario', 'global']);
});

test('Lua literal expression lookup creates absent zero variables and participates in g. dirty tracking', async () => {
  const {ArtemisVariables} = await import('../dist/engines/artemis/variables.js');
  const variables = new ArtemisVariables();
  assert.equal(variables.read('f.config').length, 0);
  assert.equal(luaText(variables.queryLiteral('f.config')), '0');
  assert.equal(luaText(variables.read('f.config')), '0');
  assert.equal(variables.globalDirty, false);
  variables.pushLocal();
  variables.write('f.config', 'local', true);
  assert.equal(luaText(variables.queryLiteral('f.config')), 'local');
  variables.popLocal();
  assert.equal(luaText(variables.queryLiteral('g.new')), '0');
  assert.equal(variables.globalDirty, true);
  assert.throws(() => variables.queryLiteral('s.unsupported'), /Unsupported/);
});

test('Fullscreen variable queries read the shared window geometry owner on every query', async () => {
  const {ArtemisVariables} = await import('../dist/engines/artemis/variables.js');
  let fullscreen = false;
  const variables = new ArtemisVariables({
    stageSize: () => ({width: 800, height: 600}),
    windowDisplay: () => ({width: 800, height: 600, fullscreen}),
  });
  const tag = {
    kind: 'tag',
    name: 'var',
    sourceLine: -1,
    args: new Map([
      ['name', 'mode'],
      ['system', 'fullscreen'],
    ]),
  };
  variables.dispatch(tag);
  assert.equal(luaText(variables.read('mode')), '0');
  fullscreen = true;
  variables.dispatch(tag);
  assert.equal(luaText(variables.read('mode')), '1');
  assert.throws(() => new ArtemisVariables().dispatch(tag), /display provider/);
});

test('Lua magic-path tuples update the host in native numeric-key iteration order', () => {
  const calls = [];
  const lua = new ArtemisLua({
    readFile: () => null,
    fileExists: () => false,
    now: () => 0,
    tag: () => {},
    enqueueTag: () => {},
    variable: () => '',
    setMagicPath: (name, root) => calls.push([name, root]),
  });
  try {
    lua.vm.execute(
      bytes(
        `engine:setMagicPath{'ui','system/雪'}; engine:setMagicPath{'ui',''}; engine:setMagicPath{ignored='value'}`,
      ),
    );
    assert.deepEqual(calls, [
      ['ui', 'system/雪'],
      ['ui', ''],
      ['', ''],
    ]);
    assert.throws(() => lua.vm.execute(bytes(`engine:setMagicPath('bad')`)), /tuple/);
  } finally {
    lua.close();
  }
});

test('Application argument query copies native dotted keys into the selected scope without clearing old entries', async () => {
  const {ArtemisVariables} = await import('../dist/engines/artemis/variables.js');
  let argumentsMap = new Map([
    ['recovery', 'save'],
    ['日本語', '雪'],
  ]);
  const variables = new ArtemisVariables({
    stageSize: () => ({width: 800, height: 600}),
    applicationArguments: {readApplicationArguments: () => argumentsMap},
  });
  const tag = {
    kind: 'tag',
    name: 'var',
    sourceLine: -1,
    args: new Map([
      ['name', 'params'],
      ['system', 'get_exe_parameter'],
      ['writelocal', '1'],
    ]),
  };
  variables.write('params.recovery', 'global');
  variables.pushLocal();
  variables.dispatch(tag);
  assert.equal(luaText(variables.read('params.recovery')), 'save');
  assert.equal(luaText(variables.read('params.日本語')), '雪');
  argumentsMap = new Map();
  variables.dispatch(tag);
  assert.equal(luaText(variables.read('params.recovery')), 'save');
  variables.popLocal();
  assert.equal(luaText(variables.read('params.recovery')), 'global');
  assert.throws(() => new ArtemisVariables().dispatch(tag), /argument provider/);
});

test('Recording/right-click controls preserve native missing-option and retained-script rules', async () => {
  const {ArtemisModes} = await import('../dist/engines/artemis/modes.js');
  const modes = new ArtemisModes({
    writeStatus: () => {},
    commandSkipChanged: () => {},
    controlSkipChanged: () => {},
    automodeChanged: () => {},
    releaseScheduler: () => {},
  });
  const tag = (name, args = {}) => ({
    kind: 'tag',
    name,
    sourceLine: -1,
    args: new Map(Object.entries(args)),
  });
  modes.dispatch(tag('alreadyread'));
  assert.equal(modes.alreadyReadEnabled, true);
  modes.dispatch(tag('writebacklog'));
  assert.equal(modes.writeBacklog, false);
  modes.dispatch(tag('alreadyread', {mode: '0'}));
  assert.equal(modes.alreadyReadEnabled, false);
  modes.dispatch(tag('writebacklog', {mode: '00'}));
  assert.equal(modes.writeBacklog, true);
  modes.dispatch(tag('rclick', {file: 'menu.iet', allow: '0'}));
  assert.equal(modes.rightClickAllowed, false);
  modes.dispatch(tag('rclick'));
  assert.equal(modes.rightClickAllowed, true);
  assert.equal(modes.rightClickScript, 'menu.iet');
  modes.dispatch(tag('rclick', {file: ''}));
  assert.equal(modes.rightClickScript, '');
});

test('Backlog configuration selects missing message layers, resets override use and preserves native lists', async () => {
  const {ArtemisTextControls} = await import('../dist/engines/artemis/text-controls.js');
  let current = 'message';
  const layers = new Set(['message']),
    calls = [];
  const controls = new ArtemisTextControls({
    currentMessageLayer: () => current,
    messageLayerExists: (id) => layers.has(id),
    selectMessageLayer: (id) => {
      layers.add(id);
      calls.push(id);
    },
    clearBacklog: () => calls.push('clear'),
  });
  const tag = (name, args = {}) => ({
    kind: 'tag',
    name,
    sourceLine: -1,
    args: new Map(Object.entries(args)),
  });
  controls.dispatch(
    tag('backlog', {
      allow: '0',
      messagelayer: 'log',
      layer: 'override',
      hide: 'a,, a,a',
      includefont: '0',
    }),
  );
  assert.deepEqual(calls, ['log', 'message']);
  assert.equal(controls.backlogAllowed, false);
  assert.equal(controls.backlogIncludeFont, false);
  assert.deepEqual(controls.backlogLayer('message'), {useOverride: true, layer: 'override'});
  assert.deepEqual([...controls.hiddenBacklogLayers], ['a', '', ' a']);
  controls.dispatch(tag('backlog', {messagelayer: 'log'}));
  assert.equal(controls.backlogAllowed, true);
  assert.deepEqual(controls.backlogLayer('message'), {useOverride: false, layer: 'override'});
  assert.deepEqual(calls, ['log', 'message']);
  current = 'second';
  controls.dispatch(tag('backlog', {clear: '00'}));
  assert.deepEqual(controls.backlogLayer('second'), {useOverride: false, layer: ''});
  assert.equal(calls.at(-1), 'clear');
  controls.dispatch(tag('hide', {allow: '0', window: ''}));
  assert.equal(controls.hideAllowed, false);
  assert.deepEqual([...controls.hiddenWindows], ['']);
  controls.dispatch(tag('hide'));
  assert.equal(controls.hideAllowed, true);
  assert.deepEqual([...controls.hiddenWindows], ['']);
});

test('Key configuration replaces ordinary keys and special flags; delonpush removes both copied handlers', async () => {
  const {ArtemisKeyBindings} = await import('../dist/engines/artemis/key-bindings.js');
  const bindings = new ArtemisKeyBindings();
  const tag = (name, args = {}) => ({
    kind: 'tag',
    name,
    sourceLine: -1,
    args: new Map(Object.entries(args)),
  });
  bindings.dispatch(tag('keyconfig', {role: '0', keys: '1,13,136,137,13,, -2'}));
  assert.deepEqual([...bindings.role(0).keys], [-2, 0, 1, 13]);
  assert.equal(bindings.role(0).special136, true);
  assert.equal(bindings.role(0).special137, true);
  const copy = bindings.role(0);
  copy.keys.clear();
  assert.equal(bindings.role(0).keys.size, 4);
  bindings.dispatch(tag('keyconfig', {role: '0'}));
  assert.equal(bindings.role(0).keys.size, 0);
  assert.equal(bindings.role(0).special136, false);
  bindings.dispatch(tag('keyconfig', {role: '0', keys: ''}));
  assert.deepEqual([...bindings.role(0).keys], [0]);
  const command = tag('call', {file: 'sub'});
  bindings.storePushHandler(3, 0, command);
  bindings.storePushHandler(3, 1, command);
  command.args.set('file', 'changed');
  assert.equal(bindings.pushHandler(3, 0).args.get('file'), 'sub');
  bindings.dispatch(tag('delonpush', {key: '3'}));
  assert.equal(bindings.pushHandler(3, 0), undefined);
  assert.equal(bindings.pushHandler(3, 1), undefined);
  bindings.storePushHandler(0, 0, command);
  bindings.dispatch(tag('delonpush'));
  assert.equal(bindings.pushHandler(0, 0), undefined);
  assert.throws(() => bindings.dispatch(tag('keyconfig')), /Missing/);
});

test('Native multi-touch configuration accepts numeric limits and truncates toward zero', () => {
  const limits = [];
  const lua = new ArtemisLua({
    readFile: () => null,
    fileExists: () => false,
    now: () => 0,
    tag: () => {},
    enqueueTag: () => {},
    variable: () => '',
    setTouchLimit: (limit) => limits.push(limit),
  });
  try {
    lua.vm.execute(bytes(`engine:setUseMultiTouch(3); engine:setUseMultiTouch(-2.9)`));
    assert.deepEqual(limits, [3, -2]);
    assert.throws(() => lua.vm.execute(bytes(`engine:setUseMultiTouch(true)`)), /touch limit/);
    assert.throws(() => lua.vm.execute(bytes(`engine:setUseMultiTouch('3')`)), /touch limit/);
  } finally {
    lua.close();
  }
});

test('Event filters retain the function and preserve native numeric outcomes separately from tags', () => {
  const lua = new ArtemisLua({
    readFile: () => null,
    fileExists: () => false,
    now: () => 0,
    tag: () => {},
    enqueueTag: () => {},
    variable: () => '',
  });
  const event = {kind: 'tag', name: 'click', args: new Map([['code', '2']]), sourceLine: -1};
  try {
    assert.equal(lua.filterEvent(event), 0);
    lua.vm.execute(
      bytes(`
      local offset = 0
      function selected(e,n,p)
        assert(e == engine and n == 'click')
        return tonumber(p.code) + offset
      end
      engine:setEventFilter(selected)
      selected = function() return 99 end
      function change() offset = -1 end
    `),
    );
    assert.equal(lua.filterEvent(event), 2);
    lua.call('change');
    assert.equal(lua.filterEvent(event), 1);
    assert.equal(lua.filterTag(event), false);
    assert.equal(lua.filterEvent({...event, name: ''}), 0);
    lua.vm.execute(bytes(`engine:setEventFilter(function() return -2.9 end)`));
    assert.equal(lua.filterEvent(event), -2);
    lua.vm.execute(bytes(`engine:setEventFilter(function() return 4294967298 end)`));
    assert.equal(lua.filterEvent(event), 2);
    lua.vm.execute(bytes(`engine:setEventFilter(function() return '2' end)`));
    assert.throws(() => lua.filterEvent(event), /event filter result/);
    lua.vm.execute(bytes(`engine:setEventFilter(function() error('filter failed') end)`));
    assert.throws(() => lua.filterEvent(event), /filter failed/);
    assert.throws(() => lua.vm.execute(bytes(`engine:setEventFilter({})`)), /filter function/);
  } finally {
    lua.close();
  }
});

test('A held event filter resumes after its resource tag; its status then decides the default dispatch', async () => {
  const {ArtemisScriptEvents} = await import('../dist/engines/artemis/script-events.js');
  const {artemisEventFilterResult} = await import('../dist/engines/artemis/lua.js');
  const hash = '8953562b80608046662bd8c89015d04236b0ba3afee10c36469c11403de3ebaf';
  const tags = [],
    effects = [];
  const source = bytes('[record]');
  let script;
  // Frame-phase tags reach the script owner as frame calls.
  const lua = new ArtemisLua({
    readFile: () => source,
    fileExists: () => false,
    now: () => 0,
    variable: () => '',
    suspendableTags: true,
    tag: (tag) => script.executeTag(tag, true),
    enqueueTag: () => {},
  });
  script = new ArtemisScript(lua, {
    readFile: () => source,
    // A click sound loads asynchronously, like seplay in the runtime.
    dispatch: (tag) => (tags.push(tag.name), tag.name === 'seplay' ? 'suspended' : undefined),
  });
  let held = null;
  const events = new ArtemisScriptEvents(hash, {
    nativeMode: () => 1,
    disabled: () => false,
    latched: () => false,
    latch: () => {},
    filter: (command, resume) => {
      const task = lua.createEventFilterCall(command);
      const result = task.resume();
      if (result.status === 'yielded') {
        held = {task, resume};
        return 'held';
      }
      task.close();
      return artemisEventFilterResult(result.values[0]);
    },
    report: (kind, command, error) => effects.push(['report', kind, String(error)]),
    jump: () => assert.fail('unexpected jump'),
    call: () => assert.fail('unexpected call'),
    enterHandlerScope: () => effects.push(['scope']),
    enqueueHandler: (command) => effects.push(['handler', command.name]),
  });
  const finish = () => {
    const {task, resume} = held;
    held = null;
    let result;
    try {
      result = task.resume();
    } catch (error) {
      task.close();
      resume({error});
      return;
    }
    task.close();
    resume({status: artemisEventFilterResult(result.values[0])});
  };
  const push = (result) => ({
    kind: 'tag',
    name: 'setonpush',
    sourceLine: -1,
    args: new Map([
      ['handler', 'calllua'],
      ['result', result],
    ]),
  });
  try {
    lua.vm.execute(
      bytes(`engine:setEventFilter(function(e, name, p)
        e:tag{'seplay', id='9', file='click'}
        if p.result == 'error' then error('filter failed') end
        e:tag{'exec', command='automode', mode='0'}
        return tonumber(p.result)
      end)`),
    );
    script.load('main.iet');
    assert.equal(script.state, 'ready');
    // Fallthrough: the event counts as delivered while held; the handler follows the status.
    assert.deepEqual(events.emit(push('0'), 0, true), {status: 'delivered', failed: false});
    assert.deepEqual(tags, ['seplay']);
    assert.deepEqual(effects, []);
    // The frame holds, not the script.
    assert.equal(script.state, 'ready');
    finish();
    assert.deepEqual(tags, ['seplay', 'exec']);
    assert.deepEqual(effects, [['scope'], ['handler', 'calllua']]);
    // A consuming status skips the default dispatch.
    tags.length = effects.length = 0;
    assert.equal(events.dispatch(push('1')), false);
    finish();
    assert.deepEqual(tags, ['seplay', 'exec']);
    assert.deepEqual(effects, []);
    // A failure after the resource is reported, and the default dispatch still runs.
    tags.length = 0;
    assert.equal(events.dispatch(push('error')), false);
    finish();
    assert.deepEqual(tags, ['seplay']);
    assert.equal(effects[0][0], 'report');
    assert.match(effects[0][2], /filter failed/);
    assert.deepEqual(effects.slice(1), [['scope'], ['handler', 'calllua']]);
    // Without suspension the filter returns at once.
    lua.vm.execute(bytes(`engine:setEventFilter(function() return 2 end)`));
    assert.equal(events.dispatch(push('0')), true);
    assert.equal(held, null);
    // A script tag that suspends makes the script wait.
    const seplay = {kind: 'tag', name: 'seplay', sourceLine: -1, args: new Map()};
    assert.equal(script.executeTag(seplay), 'suspended');
    assert.equal(script.state, 'waiting');
  } finally {
    lua.close();
  }
});

test('Command event registrations capture label-only filenames and keep both push slots', async () => {
  const {ArtemisEventCommands} = await import('../dist/engines/artemis/event-commands.js');
  const {ArtemisKeyBindings} = await import('../dist/engines/artemis/key-bindings.js');
  let current = 'system/first.iet';
  const events = new ArtemisEventCommands(() => current);
  const keys = new ArtemisKeyBindings(() => current);
  const tag = (name, args = {}) => ({
    kind: 'tag',
    name,
    args: new Map(Object.entries(args)),
    sourceLine: -1,
  });
  const original = tag('setoncontrolskipin', {label: 'last'});
  events.dispatch(original);
  current = 'other.asb';
  original.args.set('label', 'changed');
  assert.equal(events.command('setoncontrolskipin').args.get('label'), 'last');
  assert.equal(events.command('setoncontrolskipin').args.get('file'), 'system/first.iet');
  events.dispatch(tag('setoncontrolskipout', {file: '', label: 'last'}));
  assert.equal(events.command('setoncontrolskipout').args.get('file'), '');
  events.dispatch(tag('setoncontrolskipin', {handler: 'calllua', function: 'callback'}));
  assert.equal(events.command('setoncontrolskipin').args.has('file'), false);
  assert.equal(events.dispatch(tag('deloncontrolskipin', {label: 'ignored'})), true);
  assert.equal(events.command('setoncontrolskipin'), undefined);
  assert.equal(events.command('setoncontrolskipout').args.get('label'), 'last');
  assert.equal(events.dispatch(tag('delonautomodeout')), true);
  assert.equal(events.dispatch(tag('delonclick')), false);
  events.dispatch(tag('setonwindowbutton', {button: ' 01x', handler: 'calllua', function: 'f'}));
  events.dispatch(tag('setonwindowbutton', {label: 'close'}));
  assert.equal(events.windowButton(1).args.get('function'), 'f');
  assert.equal(events.windowButton(null).args.get('file'), 'other.asb');
  events.dispatch(tag('delonwindowbutton', {button: '1'}));
  assert.equal(events.windowButton(1), undefined);
  assert.equal(events.windowButton(null).args.get('label'), 'close');
  events.dispatch(tag('delonwindowbutton'));
  assert.equal(events.windowButton(null), undefined);
  keys.dispatch(tag('setonpush', {key: '13', label: 'enter'}));
  keys.dispatch(tag('setonpush', {key: '13', keyrepeat: '00', label: 'repeat'}));
  assert.equal(keys.pushHandler(13, 0).args.get('label'), 'enter');
  assert.equal(keys.pushHandler(13, 1).args.get('label'), 'repeat');
  assert.equal(keys.pushHandler(13, 1).args.get('file'), 'other.asb');
  keys.dispatch(tag('setonpush', {key: '13', keyrepeat: '0', label: 'replace'}));
  assert.equal(keys.pushHandler(13, 0).args.get('label'), 'replace');
  assert.equal(keys.pushHandler(13, 1).args.get('label'), 'repeat');
  keys.dispatch(tag('delonpush', {key: '13'}));
  assert.equal(keys.pushHandler(13, 0), undefined);
  assert.equal(keys.pushHandler(13, 1), undefined);
});

test('Native DLL strings are copied before Delete; missing modules, methods and Delete return empty', async () => {
  const {ArtemisNativeLibrary} = await import('../dist/engines/artemis/native-library.js');
  const {BrowserWindowsDynamicLibraryHost} =
    await import('../dist/platform/windows-dynamic-library.js');
  const output = [];
  const browser = new ArtemisNativeLibrary(new BrowserWindowsDynamicLibraryHost(), (name, bytes) =>
    output.push([name, luaText(bytes)]),
  );
  browser.dispatch({
    kind: 'tag',
    name: 'callnative',
    sourceLine: -1,
    args: new Map([
      ['module', 'example.dll'],
      ['method', 'Version'],
      ['result', 't.result'],
    ]),
  });
  assert.deepEqual(output, [['t.result', '']]);
  const library = {},
    procedure = {},
    release = {},
    calls = [],
    returned = bytes('version');
  let hasDelete = true;
  const native = new ArtemisNativeLibrary(
    {
      loadLibraryA: (path) => {
        calls.push(['load', luaText(path)]);
        return library;
      },
      getProcAddress: (owner, name) => {
        assert.equal(owner, library);
        calls.push(['lookup', name]);
        return name === 'Version' ? procedure : name === 'Delete' && hasDelete ? release : null;
      },
      invoke: (fn, args) => {
        if (fn === procedure) {
          assert.equal(args[0].kind, 'memory');
          assert.deepEqual([...args[0].pointer.bytes], [...bytes('parameter'), 0]);
          calls.push(['call']);
          return 123n;
        }
        assert.equal(fn, release);
        assert.equal(args[0].value, 123n);
        calls.push(['delete']);
        returned.fill(0);
        return undefined;
      },
      readCString: (pointer) => {
        assert.equal(pointer, 123n);
        calls.push(['read']);
        return returned;
      },
      freeLibrary: () => {
        throw new Error('unexpected release');
      },
      mainWindowHandle: () => null,
    },
    () => {},
  );
  assert.equal(luaText(native.call('example.dll', 'Version', 'parameter')), 'version');
  assert.deepEqual(
    calls.map((c) => c[0]),
    ['load', 'lookup', 'call', 'read', 'lookup', 'delete'],
  );
  assert.equal(native.call('example.dll', 'Absent', '').length, 0);
  assert.equal(calls.filter((c) => c[0] === 'load').length, 1);
  hasDelete = false;
  assert.equal(native.call('example.dll', 'Version', 'parameter').length, 0);
  assert.equal(calls.filter((c) => c[0] === 'delete').length, 1);
  assert.throws(() => native.call('日本語.dll', 'Version', ''), /ANSI/);
});

test('Native string-call arguments preserve Unicode and exact Lua bytes through the host ABI', async () => {
  const {ArtemisNativeLibrary} = await import('../dist/engines/artemis/native-library.js');
  const library = {},
    procedure = {},
    release = {},
    seen = [];
  const native = new ArtemisNativeLibrary(
    {
      loadLibraryA: () => library,
      getProcAddress: (_library, name) => (name === 'Delete' ? release : procedure),
      invoke: (fn, args) => {
        if (fn === release) return;
        seen.push(args[0].pointer.bytes.slice());
        return 1n;
      },
      readCString: () => Uint8Array.of(65),
      freeLibrary: () => {},
      mainWindowHandle: () => null,
    },
    () => {},
  );
  native.call('sample.dll', 'Echo', '仮想/保存');
  assert.deepEqual(seen[0], Uint8Array.from([...bytes('仮想/保存'), 0]));
  const exact = Uint8Array.of(0xff, 0x82, 0xa0, 0, 0x33);
  native.dispatch({
    kind: 'tag',
    name: 'callnative',
    sourceLine: -1,
    args: new Map([
      ['module', 'sample.dll'],
      ['method', 'Echo'],
      ['param', 'decoded placeholder'],
    ]),
    bytes: new Map([['param', exact]]),
  });
  assert.deepEqual(seen[1], Uint8Array.from([...exact, 0]));
  assert.deepEqual(exact, Uint8Array.of(0xff, 0x82, 0xa0, 0, 0x33));
});

test('Native module teardown releases the sorted registry once and permits later loading', async () => {
  const {ArtemisNativeLibrary} = await import('../dist/engines/artemis/native-library.js');
  const released = [],
    loaded = [];
  const owner = new ArtemisNativeLibrary(
    {
      loadLibraryA: (path) => {
        const library = {path: luaText(path)};
        loaded.push(library);
        return library;
      },
      getProcAddress: () => null,
      invoke: () => 0n,
      freeLibrary: (library) => released.push(library.path),
      mainWindowHandle: () => null,
    },
    () => {},
  );
  owner.call('z.dll', 'none', '');
  owner.call('a.dll', 'none', '');
  owner.reset();
  owner.reset();
  assert.deepEqual(released, ['a.dll', 'z.dll']);
  owner.call('a.dll', 'none', '');
  assert.equal(loaded.length, 3);
  owner.reset();
  assert.deepEqual(released, ['a.dll', 'z.dll', 'a.dll']);
});

test('Script callbacks await resource work, resume nested calls, then consume queued tags', async () => {
  const source = bytes(`[lua]
    function child(e,p)
      local path=p.file
      e:tag{'asset',file=path}
      assert(e:var('asset.ready')=='yes')
      e:enqueueTag{'record',data=path}
      return function() end
    end
    function parent(e)
      e:tag{'calllua',['function']='child',file='synthetic.png'}
      e:enqueueTag{'record',data='parent'}
      return function() end
    end
  [/lua][calllua function="parent"][stop]`);
  let script;
  let ready = '';
  const records = [],
    requests = [];
  const lua = new ArtemisLua({
    readFile: () => source,
    fileExists: () => true,
    now: () => 0,
    variable: () => ready,
    suspendableTags: true,
    tag: (tag) => script.executeTag(tag),
    enqueueTag: (tag) => script.enqueue(tag),
  });
  script = new ArtemisScript(lua, {
    readFile: () => source,
    dispatch: (tag) => {
      if (tag.name === 'asset') {
        requests.push(tag.args.get('file'));
        return 'suspended';
      }
      if (tag.name === 'record') records.push(tag.args.get('data'));
      if (tag.name === 'stop') return 'stopped';
    },
  });
  try {
    script.load('boot');
    assert.equal(script.run(), 'waiting');
    assert.equal(script.pendingLuaCalls, 2);
    assert.equal(script.queuedTags, 0);
    assert.deepEqual(requests, ['synthetic.png']);
    assert.throws(() => script.resume(), /resumeLua/);
    ready = await Promise.resolve('yes');
    assert.equal(script.resumeLua(), 'ready');
    assert.equal(script.pendingLuaCalls, 0);
    assert.equal(script.run(), 'stopped');
    assert.deepEqual(records, ['synthetic.png', 'parent']);
  } finally {
    script.cancelLuaCalls();
    lua.close();
  }
});

test('Resource failures propagate through suspended callbacks and a new script cancels old continuations', () => {
  const source = bytes(`[lua]
    function child(e) e:tag{'asset'} end
    function parent(e) e:tag{'calllua',['function']='child'}; should_not_run=true end
  [/lua][calllua function="parent"][stop]`);
  let script;
  const lua = new ArtemisLua({
    readFile: () => source,
    fileExists: () => true,
    now: () => 0,
    variable: () => '',
    suspendableTags: true,
    tag: (tag) => script.executeTag(tag),
    enqueueTag: () => {},
  });
  script = new ArtemisScript(lua, {
    readFile: () => source,
    dispatch: (tag) =>
      tag.name === 'asset' ? 'suspended' : tag.name === 'stop' ? 'stopped' : undefined,
  });
  try {
    script.load('boot');
    script.run();
    assert.throws(() => script.resumeLua([false, bytes('asset failed')]), /asset failed/);
    assert.equal(script.state, 'faulted');
    assert.equal(script.pendingLuaCalls, 0);
    assert.equal(lua.vm.getGlobal('should_not_run'), null);
    script.load('boot');
    script.run();
    assert.equal(script.pendingLuaCalls, 2);
    script.load('replacement');
    assert.equal(script.pendingLuaCalls, 0);
    assert.throws(() => script.resumeLua(), /No suspended/);
  } finally {
    script.cancelLuaCalls();
    lua.close();
  }
});

test('Image loaders try exact case-sensitive extensions before native appended candidates', async () => {
  const {ArtemisImageLoader} = await import('../dist/engines/artemis/image-loader.js');
  const opened = [],
    decoded = [];
  const image = {width: 1, height: 1, pixels: new Uint8Array([1, 2, 3, 255])};
  const files = new Map([
    ['name.png', bytes('bad')],
    ['name.png.jpg', bytes('good')],
    ['name.PNG', bytes('good')],
  ]);
  const codecs = [
    {
      extensions: ['png'],
      decode: async (value) => {
        decoded.push(['png', luaText(value)]);
        return null;
      },
    },
    {
      extensions: ['jpg', 'jpeg'],
      decode: async (value) => {
        decoded.push(['jpg', luaText(value)]);
        return luaText(value) === 'good' ? image : null;
      },
    },
  ];
  const loader = new ArtemisImageLoader(async (path) => {
    opened.push(path);
    return files.get(path) ?? null;
  }, codecs);
  const loaded = await loader.load('name.png');
  assert.equal(loaded.path, 'name.png.jpg');
  assert.equal(loaded.image, image);
  assert.deepEqual(opened, ['name.png', 'name.png.png', 'name.png.jpg']);
  assert.deepEqual(decoded, [
    ['png', 'bad'],
    ['png', 'bad'],
    ['jpg', 'bad'],
    ['jpg', 'good'],
  ]);
  opened.length = 0;
  decoded.length = 0;
  assert.equal((await loader.load('name.PNG')).path, 'name.PNG');
  assert.deepEqual(opened, ['name.PNG']);
  assert.deepEqual(decoded, [
    ['png', 'good'],
    ['jpg', 'good'],
  ]);
  await assert.rejects(() => loader.load('bad\0name'), /NUL/);
});

test('Asynchronous image loading preserves Unicode aliases and stops on owner refusal', async () => {
  const {ArtemisImageLoader} = await import('../dist/engines/artemis/image-loader.js');
  const image = {width: 1, height: 1, pixels: new Uint8Array(4)},
    opened = [];
  const loader = new ArtemisImageLoader(
    async (path) => {
      opened.push(path);
      return path === ':bg/雪.png' ? bytes('image') : null;
    },
    [{extensions: ['png'], decode: async () => image}],
  );
  assert.equal((await loader.load(':bg/雪')).path, ':bg/雪.png');
  assert.deepEqual(opened, [':bg/雪', ':bg/雪.png']);
  const refused = new ArtemisImageLoader(async () => {
    throw new Error('unsupported root');
  }, []);
  await assert.rejects(() => refused.load('unknown'), /unsupported root/);
});

test('Artemis PNG loads drop an ancillary chunk whose CRC fails, as libpng 0x14005ccf0 does', async () => {
  const {createArtemisImageLoader} = await import('../dist/engines/artemis/image-loader.js');
  const {artemisPngDecodeOptions} = await import('../dist/engines/artemis/png-surface.js');
  const {ARTEMIS_3139_EXECUTABLE_SHA256: sha} = await import('../dist/engines/artemis/revision.js');
  const {png, chunk} = await import('./png-fixtures.mjs');
  assert.deepEqual(
    {...artemisPngDecodeOptions},
    {ancillaryCrcErrors: 'discard', trailingBytes: 'ignore'},
  );
  const iccp = chunk('iCCP', Buffer.from('p\0\0xyz'));
  iccp[iccp.length - 1] ^= 1;
  const encoded = png({width: 1, height: 1, raw: Buffer.from([0, 1, 2, 3, 4]), extras: [iccp]});
  const loader = createArtemisImageLoader(sha, async (path) => (path === 'a.png' ? encoded : null));
  const loaded = await loader.load('a');
  assert.deepEqual(
    [loaded.image.width, loaded.image.height, [...loaded.image.pixels]],
    [1, 1, [1, 2, 3, 4]],
  );
  const critical = Buffer.from(encoded);
  critical[critical.length - 13] ^= 1;
  const strict = createArtemisImageLoader(sha, async (path) =>
    path === 'a.png' ? critical : null,
  );
  await assert.rejects(() => strict.load('a'), /IDAT CRC mismatch/);
  const {createArtemisSurfacePreloadFixture} =
    await import('../tools/artemis-surface-preload-fixture.mjs');
  const padded = Buffer.concat([encoded, Buffer.from([17, 23, 42])]);
  const fixture = createArtemisSurfacePreloadFixture(sha, async (path) =>
    path === 'a.png' ? padded : null,
  );
  try {
    const surface = await fixture.manager.load('a');
    assert.deepEqual([...surface.image.pixels], [1, 2, 3, 4]);
    assert.equal(fixture.summary().decodedImages, 1);
    surface.lease.release();
  } finally {
    await fixture.close();
  }
});

test('Revision-selected image pipeline decodes synthetic PNGs through suspended Lua work', async () => {
  const {createArtemisImageLoader} = await import('../dist/engines/artemis/image-loader.js');
  const {ARTEMIS_3179_EXECUTABLE_SHA256: sha} = await import('../dist/engines/artemis/revision.js');
  const {png} = await import('./png-fixtures.mjs');
  const encoded = png({width: 2, height: 1, raw: Buffer.from([0, 255, 0, 0, 0, 0, 255, 0, 128])});
  const opened = [];
  const loader = createArtemisImageLoader(sha, async (path) => {
    opened.push(path);
    await Promise.resolve();
    return path === ':bg/synthetic.PNG' ? encoded : null;
  });
  assert.throws(
    () => createArtemisImageLoader('0'.repeat(64), async () => null),
    /Unsupported Artemis executable/,
  );
  let script, pending, loaded;
  const source = bytes(
    `[lua]function prepare(e) e:tag{'asset',file=':bg/synthetic'}; width=tonumber(e:var('width')) end[/lua][calllua function="prepare"][stop]`,
  );
  const lua = new ArtemisLua({
    readFile: () => source,
    fileExists: () => true,
    now: () => 0,
    variable: () => String(loaded?.image.width ?? 0),
    suspendableTags: true,
    tag: (tag) => script.executeTag(tag),
    enqueueTag: () => {},
  });
  script = new ArtemisScript(lua, {
    readFile: () => source,
    dispatch: (tag) => {
      if (tag.name === 'asset') {
        pending = loader.load(tag.args.get('file')).then((result) => {
          loaded = result;
        });
        return 'suspended';
      }
      if (tag.name === 'stop') return 'stopped';
    },
  });
  try {
    script.load('boot');
    assert.equal(script.run(), 'waiting');
    assert.equal(lua.vm.getGlobal('width'), null);
    await pending;
    assert.deepEqual(opened, [':bg/synthetic', ':bg/synthetic.png', ':bg/synthetic.PNG']);
    assert.equal(loaded.image.width, 2);
    assert.deepEqual([...loaded.image.pixels], [255, 0, 0, 0, 0, 255, 0, 128]);
    script.resumeLua();
    assert.equal(script.run(), 'stopped');
    assert.equal(lua.vm.getGlobal('width'), 2);
    const unsupported = createArtemisImageLoader(sha, async (path) =>
      path === 'image.jpg' ? bytes('jpeg') : null,
    );
    await assert.rejects(() => unsupported.load('image'), /JPEG image decoder/);
  } finally {
    script.cancelLuaCalls();
    lua.close();
  }
});

test('Suspended tag filters preserve original native arguments and first-result consume/fallthrough', () => {
  const source = bytes(`[lua]
    engine:setTagFilter({asset=function(e,p)
      e:tag{'prepare',id=p.id}
      e:enqueueTag{'record',data=p.id}
      local consumed=p.consume=='1'
      p.id='changed'
      return consumed and 1 or 0, function() end
    end})
  [/lua][asset id="original" consume="0"][asset id="consumed" consume="1"][stop]`);
  let script;
  const records = [],
    prepared = [],
    native = [];
  const lua = new ArtemisLua({
    readFile: () => source,
    fileExists: () => true,
    now: () => 0,
    variable: () => '',
    suspendableTags: true,
    tag: (tag) => script.executeTag(tag),
    enqueueTag: (tag) => script.enqueue(tag),
  });
  script = new ArtemisScript(lua, {
    readFile: () => source,
    dispatch: (tag) => {
      if (tag.name === 'prepare') {
        prepared.push(tag.args.get('id'));
        return 'suspended';
      }
      if (tag.name === 'asset') {
        native.push(tag.args.get('id'));
        return 'suspended';
      }
      if (tag.name === 'record') records.push(tag.args.get('data'));
      if (tag.name === 'stop') return 'stopped';
    },
  });
  try {
    script.load('boot');
    assert.equal(script.run(), 'waiting');
    assert.equal(script.pendingLuaCalls, 1);
    // Filter completion falls through to a distinct native resource operation.
    assert.equal(script.resumeLua(), 'waiting');
    assert.equal(script.pendingLuaCalls, 0);
    assert.deepEqual(native, ['original']);
    script.resume();
    assert.equal(script.run(), 'waiting');
    assert.deepEqual(records, ['original']);
    assert.equal(script.resumeLua(), 'ready');
    assert.equal(script.run(), 'stopped');
    assert.deepEqual(prepared, ['original', 'consumed']);
    assert.deepEqual(native, ['original']);
    assert.deepEqual(records, ['original', 'consumed']);
    lua.vm.execute(bytes(`engine:setEventFilter(function() return 2,function() end end)`));
    assert.equal(lua.filterEvent({kind: 'tag', name: 'event', args: new Map(), sourceLine: -1}), 2);
    lua.vm.execute(
      bytes(`engine:setTagFilter({event=function() return 4294967296,function() end end})`),
    );
    assert.equal(
      lua.filterTag({kind: 'tag', name: 'event', args: new Map(), sourceLine: 0}),
      false,
    );
  } finally {
    script.cancelLuaCalls();
    lua.close();
  }
});

test('Artemis Lua random, wait reasons and PNG comments follow the native engine methods', async () => {
  const {Mt19937} = await import('../dist/core/mt19937.js');
  const {ArtemisRandom} = await import('../dist/engines/artemis/random.js');
  const {artemisLuaErrors} = await import('../dist/engines/artemis/lua.js');
  const {ARTEMIS_3179_EXECUTABLE_SHA256} = await import('../dist/engines/artemis/revision.js');
  const {png, chunk} = await import('./png-fixtures.mjs');
  // Reference MT19937 outputs for the default seed 5489.
  const mt = new Mt19937(5489);
  assert.deepEqual([mt.next(), mt.next()], [3499211612, 581869302]);
  for (let i = 2; i < 9999; i++) mt.next();
  assert.equal(mt.next(), 4123659995);
  const random = new ArtemisRandom(ARTEMIS_3179_EXECUTABLE_SHA256, 5489.9);
  assert.equal(random.next(), 3499211612 % 0x10000);
  const text = (keyword, value) =>
    chunk('tEXt', Buffer.concat([Buffer.from(keyword + '\0'), value]));
  const files = new Map([
    [
      'fg.png',
      png({
        width: 1,
        height: 1,
        raw: Buffer.from([0, 1, 2, 3, 4]),
        extras: [
          text('comment', Buffer.from('old')),
          text('comment', Buffer.from('pos,10,20\0ignored')),
          text('Title', Buffer.from([0x82, 0xa0])),
        ],
      }),
    ],
    ['bad.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0])],
  ]);
  const reports = [];
  let reason = {};
  const lua = new ArtemisLua({
    readFile: () => null,
    fileExists: () => false,
    now: () => 0,
    variable: () => '',
    tag: () => {},
    enqueueTag: () => {},
    random: () => random.next(),
    scriptWaitReason: () => reason,
    readResource: (path) => files.get(path) ?? null,
    reportError: (message) => reports.push(message),
  });
  try {
    lua.vm.execute(
      bytes(`r = engine:random()
        p = engine:loadPngComments('fg.png'); c = p.comment; t = p.Title
        missing = engine:loadPngComments('none.png')
        bad = engine:loadPngComments('bad.png')
        arg = engine:loadPngComments(1)
        w0 = engine:getScriptWaitReason()`),
      'methods',
    );
    assert.equal(lua.vm.getGlobal('r'), 581869302 % 0x10000);
    assert.deepEqual(new TextDecoder().decode(lua.vm.getGlobal('c')), 'pos,10,20');
    assert.deepEqual([...lua.vm.getGlobal('t')], [0x82, 0xa0]);
    assert.equal(lua.vm.getGlobal('missing'), null);
    assert.equal(lua.vm.getGlobal('bad'), null);
    assert.equal(lua.vm.getGlobal('arg'), null);
    assert.deepEqual(reports, [
      artemisLuaErrors.pngCommentsMissing,
      artemisLuaErrors.pngCommentsUnreadable,
      artemisLuaErrors.pngCommentsArgument,
    ]);
    reason = {time: 0xfffffff0};
    lua.vm.execute(
      bytes(`w = engine:getScriptWaitReason(); time = w.time; tween = w.textTween`),
      'w',
    );
    assert.equal(lua.vm.getGlobal('time'), 0xfffffff0);
    assert.equal(lua.vm.getGlobal('tween'), null);
    reason = {textTween: true};
    lua.vm.execute(
      bytes(`w = engine:getScriptWaitReason(); time = w.time; tween = w.textTween`),
      'w',
    );
    assert.deepEqual([lua.vm.getGlobal('time'), lua.vm.getGlobal('tween')], [null, 1]);
    reason = {sound: new TextEncoder().encode('voice')};
    lua.vm.execute(bytes(`w = engine:getScriptWaitReason(); s = w.sound .. '!'`), 'w');
    assert.equal(new TextDecoder().decode(lua.vm.getGlobal('s')), 'voice!');
  } finally {
    lua.close();
  }
});

test('Artemis Lua mouse points use live providers, native float32 widening and fresh named coordinate tables', () => {
  let reads = 0;
  const point = {x: 16777217, y: -0.1};
  const lua = new ArtemisLua({
    readFile: () => null,
    fileExists: () => false,
    now: () => 0,
    variable: () => '',
    tag: () => {},
    enqueueTag: () => {},
    pointerPosition: {
      readPointerPosition: () => {
        reads++;
        return {...point};
      },
    },
  });
  try {
    lua.vm.execute(bytes(`a=engine:getMousePoint(); oldx=a.x; oldy=a.y; a.x=99`), 'mouse');
    assert.equal(lua.vm.getGlobal('oldx'), Math.fround(16777217));
    assert.equal(lua.vm.getGlobal('oldy'), Math.fround(-0.1));
    assert.equal(reads, 2);
    point.x = -12.5;
    point.y = 7.25;
    lua.vm.execute(
      bytes(`b=engine:getMousePoint(); newx=b.x; newy=b.y; independent=(a~=b and a.x==99)`),
      'mouse',
    );
    assert.equal(lua.vm.getGlobal('newx'), -12.5);
    assert.equal(lua.vm.getGlobal('newy'), 7.25);
    assert.equal(lua.vm.getGlobal('independent'), true);
    assert.equal(reads, 4);
    point.x = Infinity;
    assert.throws(
      () => lua.vm.execute(bytes('engine:getMousePoint()'), 'invalid'),
      /pointer position/,
    );
  } finally {
    lua.close();
  }
});

test('Artemis caption uses the selected window, Unicode/NUL semantics and native ignored failure results', async () => {
  const {ArtemisCaption} = await import('../dist/engines/artemis/caption.js');
  const {BrowserWindowCaptionHost} = await import('../dist/platform/window-caption.js');
  const tag = (name, args = {}) => ({
    kind: 'tag',
    name,
    sourceLine: -1,
    args: new Map(Object.entries(args)),
  });
  const document = {title: 'initial'},
    caption = new ArtemisCaption(new BrowserWindowCaptionHost(document));
  assert.equal(caption.dispatch(tag('other')), false);
  assert.equal(caption.dispatch(tag('caption', {data: '雪🌸\0ignored'})), true);
  assert.equal(document.title, '雪🌸');
  caption.dispatch(tag('caption'));
  assert.equal(document.title, '');
  const calls = [],
    failed = new ArtemisCaption({
      setCaption: (title) => {
        calls.push(title);
        return false;
      },
    });
  assert.equal(failed.dispatch(tag('caption', {data: 'title'})), true);
  assert.deepEqual(calls, ['title']);
  assert.equal(new BrowserWindowCaptionHost(null).setCaption('no selected document'), false);
});

async function messageSelectionFixture() {
  const {ArtemisMessageLayers, ArtemisMessageSelection} =
    await import('../dist/engines/artemis/message-layers.js');
  const {ARTEMIS_3179_EXECUTABLE_SHA256} = await import('../dist/engines/artemis/revision.js');
  let serial = 0;
  const effects = [],
    resources = [],
    frames = new Map(),
    history = new Set(),
    published = [];
  const fresh = (font = 'native synthetic font') => {
    const layer = {serial: ++serial, font, references: 1};
    resources.push(layer);
    return layer;
  };
  const stage = new ArtemisMessageLayers(ARTEMIS_3179_EXECUTABLE_SHA256, 'initial', {
    createMessageLayer: (name) => {
      effects.push(['create', name]);
      return fresh();
    },
    copyMessageLayer: (old) => {
      effects.push(['copy', old.serial]);
      return fresh(old.font);
    },
    retainMessageLayer: (layer) => layer.references++,
    releaseMessageLayer: (layer) => {
      layer.references--;
      assert.ok(layer.references >= 0);
    },
    attachMessageLayer: (name, layer) => {
      effects.push(['attach', name, layer.serial]);
      frames.set(name, layer);
      layer.references++;
    },
    detachMessageLayer: (name) => {
      effects.push(['detach', name]);
      const layer = frames.get(name);
      if (layer) {
        layer.references--;
        frames.delete(name);
      }
    },
  });
  const selection = new ArtemisMessageSelection(stage, {
    nextMessageLayerId: () => 'automatic',
    ensureMessageHistory: (name) => {
      if (!history.has(name)) {
        effects.push(['history seed', name]);
        history.add(name);
      }
    },
    deleteMessageHistory: (name) => {
      effects.push(['history delete', name]);
      history.delete(name);
    },
    publishCurrentMessageLayer: (name) => published.push(name),
    selectionChanged: (_tag, name) => effects.push(['selected', name]),
    stackUnderflow: (_tag, name) => effects.push(['underflow', name]),
    messageStateUpdated: () => effects.push(['message state']),
  });
  return {
    stage,
    selection,
    effects,
    resources,
    frames,
    history,
    published,
    tag: (name, args = {}) => ({
      kind: 'tag',
      name,
      sourceLine: -1,
      args: new Map(Object.entries(args)),
    }),
  };
}

test('Artemis message selection defaults stack on, keeps byte-exact layered flags and restores without mode changes', async () => {
  const f = await messageSelectionFixture();
  try {
    f.selection.dispatch(f.tag('chgmsg', {id: 'name', layered: '1'}));
    const original = f.stage.currentLayer();
    original.font = 'retained font';
    assert.equal(f.frames.get('name'), original);
    assert.equal(f.selection.depth, 1);
    f.selection.dispatch(f.tag('chgmsg', {id: 'name', layered: '00', stack: '0'}));
    const copy = f.stage.currentLayer();
    assert.notEqual(copy, original);
    assert.equal(copy.font, 'retained font');
    assert.equal(original.references, 0);
    assert.equal(copy.references, 3); // Map, selected pointer, attached wrapper.
    assert.equal(f.selection.depth, 1);
    f.selection.dispatch(f.tag('/chgmsg'));
    assert.equal(f.selection.currentMessageLayer(), 'initial');
    assert.equal(f.stage.currentMessageLayer(), 'initial');
    assert.equal(f.frames.get('name'), copy); // Restore mode0 preserves attachment.
    const before = f.published.length;
    f.selection.dispatch(f.tag('/chgmsg'));
    assert.equal(f.published.length, before);
    assert.deepEqual(f.effects.at(-1), ['underflow', 'initial']);
  } finally {
    f.stage.close();
  }
  assert.ok(f.resources.every((layer) => layer.references === 0));
});

test('Artemis explicit layered zero detaches/clones text and resets history before reseeding selected style', async () => {
  const f = await messageSelectionFixture();
  try {
    f.selection.dispatch(f.tag('chgmsg', {id: 'text', layered: '1'}));
    const old = f.stage.currentLayer(),
      start = f.effects.length;
    f.selection.dispatch(f.tag('chgmsg', {id: 'text', layered: '0', stack: '0'}));
    assert.notEqual(f.stage.currentLayer(), old);
    assert.equal(f.frames.has('text'), false);
    assert.equal(f.stage.currentLayer().references, 2);
    assert.equal(old.references, 0);
    assert.deepEqual(
      f.effects.slice(start).map((event) => event[0]),
      ['detach', 'copy', 'history delete', 'history seed', 'selected', 'message state'],
    );
    f.selection.dispatch(f.tag('chgmsg', {stack: '00'}));
    assert.equal(f.selection.currentMessageLayer(), 'automatic');
    assert.equal(f.selection.depth, 2);
    assert.equal(f.frames.has('automatic'), false);
  } finally {
    f.stage.close();
  }
  assert.ok(f.resources.every((layer) => layer.references === 0));
});

test('Artemis stage/backlog selection preserves the script message stack and does not invent history', async () => {
  const f = await messageSelectionFixture();
  try {
    f.selection.dispatch(f.tag('chgmsg', {id: 'text'}));
    f.stage.selectMessageLayer('backlog');
    f.stage.selectMessageLayer('text');
    assert.equal(f.selection.currentMessageLayer(), 'text');
    assert.equal(f.selection.depth, 1);
    assert.equal(f.history.has('backlog'), false);
    const creates = f.effects.filter((event) => event[0] === 'create').length;
    f.selection.dispatch(f.tag('chgmsg', {id: 'text', stack: '0'}));
    assert.equal(f.effects.filter((event) => event[0] === 'create').length, creates);
    assert.throws(() => f.stage.selectMessageLayer('bad\0id'), /message-layer id/);
  } finally {
    f.stage.close();
    f.stage.close();
  }
  assert.ok(f.resources.every((layer) => layer.references === 0));
  assert.throws(() => f.stage.currentLayer(), /closed/);
});

test('Artemis fontinit snapshots current font, font stack zero replaces its top, and pop preserves the base', async () => {
  const {ArtemisFontStack} = await import('../dist/engines/artemis/font-stack.js');
  let layer = 'name',
    current = {size: 10},
    sequence = 0;
  const released = new Set(),
    history = [],
    snapshots = [];
  const snapshot = (value) => {
    const result = {...value, id: ++sequence};
    snapshots.push(result);
    return result;
  };
  const fonts = new ArtemisFontStack({
    currentMessageLayer: () => layer,
    snapshotCurrentFont: () => snapshot(current),
    createFontCommandSnapshot: (tag) => snapshot({...current, size: Number(tag.args.get('size'))}),
    applyFontSnapshot: (value) => {
      current = {size: value.size};
    },
    releaseFontSnapshot: (value) => {
      assert.equal(released.has(value.id), false);
      released.add(value.id);
    },
    recordFontCommand: (name, tag) => history.push([name, tag]),
    stackUnderflow: (name) => history.push([name, 'underflow']),
  });
  const tag = (name, args = {}) => ({
    kind: 'tag',
    name,
    sourceLine: -1,
    args: new Map(Object.entries(args)),
  });
  try {
    fonts.dispatch(tag('fontinit'));
    assert.equal(fonts.depth(), 1);
    assert.equal(current.size, 10);
    fonts.dispatch(tag('font', {size: '20'}));
    assert.equal(fonts.depth(), 2);
    const command = tag('font', {size: '30', stack: '0'});
    fonts.dispatch(command);
    command.args.set('size', '99');
    assert.equal(current.size, 30);
    assert.equal(fonts.depth(), 2);
    assert.equal(history.at(-1)[1].args.get('size'), '30');
    fonts.dispatch(tag('/font'));
    assert.equal(current.size, 10);
    assert.equal(fonts.depth(), 1);
    const count = history.length;
    fonts.dispatch(tag('/font'));
    assert.equal(history.length, count + 1);
    assert.equal(history.at(-1)[1], 'underflow');
    current = {size: 45};
    fonts.dispatch(tag('fontinit'), false);
    assert.equal(fonts.depth(), 1);
    assert.equal(current.size, 45);
    assert.equal(history.length, count + 1);
    fonts.dispatch(tag('font', {size: '50', stack: '0'}));
    assert.equal(fonts.depth(), 1);
    fonts.dispatch(tag('/font'));
    assert.equal(current.size, 50);
    layer = 'other';
    fonts.dispatch(tag('font', {size: '60', stack: '0'}));
    assert.equal(fonts.depth(), 1);
    assert.equal(fonts.depth('name'), 1);
  } finally {
    fonts.close();
    fonts.close();
  }
  assert.equal(released.size, snapshots.length);
});

test('Nested runtime includes preserve Lua locals across real asynchronous layer preparation', async () => {
  const {openArtemisRuntimeFixture} = await import('./artemis-runtime-fixture.mjs');
  const {encodePng} = await import('../dist/formats/png/encode.js');
  const fixture = await openArtemisRuntimeFixture({
    'system/first.iet': `[lua]
      function fixture(e) e:include('system/outer.lua'); callerContinued=true end
      [/lua][calllua function="fixture"][stop]`,
    'system/outer.lua':
      "outerStarted=true; engine:include('system/nested.lua'); outerFinished=true",
    'system/nested.lua':
      "local saved=41; engine:tag{'lyc',id='1',file='pixel.png'}; nestedResult=saved+1",
    'pixel.png': await encodePng(1, 1, Uint8Array.of(7, 11, 13, 255)),
  });
  try {
    await fixture.runtime.boot();
    assert.equal(fixture.runtime.resourcePending, true);
    assert.equal(fixture.runtime.lua.vm.getGlobal('outerStarted'), true);
    assert.equal(fixture.runtime.lua.vm.getGlobal('callerContinued'), null);
    for (let n = 0; n < 10 && fixture.runtime.resourcePending; n++) {
      await fixture.runtime.settleResource();
      fixture.runtime.script.run(100);
    }
    assert.equal(fixture.runtime.resourcePending, false);
    assert.equal(fixture.runtime.lua.vm.getGlobal('nestedResult'), 42);
    assert.equal(fixture.runtime.lua.vm.getGlobal('outerFinished'), true);
    assert.equal(fixture.runtime.lua.vm.getGlobal('callerContinued'), true);
    assert.equal(fixture.runtime.script.state, 'waiting');
  } finally {
    await fixture.close();
  }
});

test('Suspendable includes retry after protected Lua errors, report final host causes and keep fatal budgets', () => {
  const reports = [],
    reads = [];
  const hostFailure = Error('include host failure');
  const lua = new ArtemisLua({
    suspendableTags: true,
    readPlainFile: (path) => {
      reads.push(['plain', path]);
      return path === 'retry.lua'
        ? bytes("partial=1; engine:tag{'resource'}; error('plain failed')")
        : null;
    },
    readFile: (path) => {
      reads.push(['packed', path]);
      return path === 'retry.lua'
        ? bytes("assert(partial==1); engine:tag{'resource'}; retried=true")
        : path === 'failed.lua'
          ? bytes("engine:tag{'hostFailure'}")
          : path === 'nil.lua'
            ? bytes('error(nil)')
            : path === 'loop.lua'
              ? bytes('while true do end')
              : null;
    },
    tag: (tag) => {
      if (tag.name === 'hostFailure') throw hostFailure;
      return 'suspended';
    },
    reportIncludeError: (path, error) => reports.push([path, error]),
  });
  let call;
  try {
    lua.vm.execute(
      bytes(`function fixture(e)
      e:include('retry.lua'); e:include('failed.lua'); e:include('nil.lua'); continued=true
    end
    function loop(e) e:include('loop.lua') end`),
    );
    call = lua.createCall('fixture');
    assert.equal(call.resume().status, 'yielded');
    assert.equal(call.resume().status, 'yielded');
    assert.equal(call.resume().status, 'done');
    assert.equal(lua.vm.getGlobal('partial'), 1);
    assert.equal(lua.vm.getGlobal('retried'), true);
    assert.equal(lua.vm.getGlobal('continued'), true);
    assert.deepEqual(reads.slice(0, 2), [
      ['plain', 'retry.lua'],
      ['packed', 'retry.lua'],
    ]);
    assert.equal(reports.length, 2);
    assert.equal(reports[0][0], 'failed.lua');
    assert.equal(reports[0][1].hostCause, hostFailure);
    assert.equal(reports[1][0], 'nil.lua');
    assert.equal(reports[1][1].message, 'Lua error 2');
    call.close();
    call = lua.createCall('loop');
    assert.throws(() => call.resume(), /instruction budget exceeded/);
    assert.equal(lua.vm.usable, false);
    assert.equal(reports.length, 2);
  } finally {
    call?.close();
    lua.close();
  }
});

test('Runtime prepares binary Lua includes without executing them until each include call', async () => {
  const {openArtemisRuntimeFixture} = await import('./artemis-runtime-fixture.mjs');
  const {ARTEMIS_2601_EXECUTABLE_SHA256: hash} =
    await import('../dist/engines/artemis/revision.js');
  const compiler = new ArtemisLua({readFile: () => null});
  let binary;
  try {
    compiler.vm.execute(
      bytes(`binary=string.dump(function()
        compiledLoads=(compiledLoads or 0)+1
        csvText=engine:file('system/table/data.csv')
      end)`),
      'fixture',
    );
    binary = compiler.vm.getGlobal('binary');
    assert.ok(binary instanceof Uint8Array);
  } finally {
    compiler.close();
  }
  const fixture = await openArtemisRuntimeFixture(
    {
      'system/first.iet': `[lua]
        function fixture(e)
          e:include('system/fixture.lub')
          e:include('system/fixture.lub')
        end
        [/lua][calllua function="fixture"][stop]`,
      'system/fixture.lub': binary,
      'system/unused-foreign.lub': Uint8Array.of(27, 76, 117, 97, 81, 0, 1, 4, 8, 4, 8, 0),
      'system/table/data.csv': 'name,value\r\n雪,73\r\n',
    },
    {hash},
  );
  try {
    assert.equal(fixture.runtime.lua.vm.getGlobal('compiledLoads'), null);
    await fixture.runtime.boot();
    assert.equal(fixture.runtime.lua.vm.getGlobal('compiledLoads'), 2);
    assert.deepEqual(fixture.runtime.lua.vm.getGlobal('csvText'), bytes('name,value\r\n雪,73\r\n'));
    assert.equal(fixture.runtime.script.state, 'waiting');
  } finally {
    await fixture.close();
  }
});

test('Forwarded Lua ruby aliases preserve resolved ruby faces in every runtime font stack', async () => {
  const {openArtemisRuntimeFixture} = await import('./artemis-runtime-fixture.mjs');
  const revisions = await import('../dist/engines/artemis/revision.js');
  const hashes = Object.entries(revisions)
    .filter(([name]) => /^ARTEMIS_.*(?:EXECUTABLE|RESOURCE_VARIANT)_SHA256$/.test(name))
    .map(([, hash]) => hash)
    // E-mote revisions open only with their exact emotedriver.dll.
    .filter((hash) => !revisions.artemisRevision(hash).emote);
  for (const hash of hashes) {
    const fixture = await openArtemisRuntimeFixture(
      {
        'system/first.iet':
          '[chgmsg id="text"][fontinit][font ruby="lua-alias" rubyface="font/ruby.ttf" rubysize="28" size="54"][stop]',
      },
      {hash},
    );
    try {
      await fixture.runtime.boot();
      assert.equal(fixture.runtime.script.state, 'waiting');
      const font = fixture.runtime.fontStack.borrowFrames('text').at(-1).font;
      assert.equal(font.get('rubyface'), 'font/ruby.ttf');
      assert.equal(font.get('rubysize'), 28);
      assert.equal(font.get('size'), 54);
      assert.equal(font.has('ruby'), false);
    } finally {
      await fixture.close();
    }
  }
});

test('Artemis font attributes use integer sizes/flags, double-before-float ratios and style override order', async () => {
  const {artemisFontProperties} = await import('../dist/engines/artemis/font-properties.js');
  const patch = artemisFontProperties(
    new Map(
      Object.entries({
        size: '58.9px',
        outline: '3',
        rubyoutline: '9',
        alpha: '128.3',
        xscale: '128.3',
        hung: '00',
        visible: 'junk',
        vertical: '-2',
        color: '0xfbfbfb',
        face: 'font/雪.ttf',
        align: 'equalize',
        style: 'bold,italic,outline_shadow',
        show: '250',
        layered: '1',
        overflow: '1',
      }),
    ),
  );
  assert.equal(patch.size, 58);
  assert.equal(patch.alpha, Math.fround(128.3 / 255));
  assert.notEqual(patch.alpha, Math.fround(Math.fround(128.3) / 255));
  assert.equal(patch.xscale, Math.fround(128.3 / 100));
  assert.equal(patch.hung, false);
  assert.equal(patch.visible, false);
  assert.equal(patch.vertical, true);
  assert.equal(patch.outline, 1);
  assert.equal(patch.rubyoutline, 1);
  assert.equal(patch.shadow, 1);
  assert.equal(patch.styleBits, 24);
  assert.equal(patch.face, 'font/雪.ttf');
  assert.equal(patch.color, 0xfbfbfb);
  assert.equal(patch.align, 'equalize');
  assert.equal(patch.overflow, 1);
  assert.equal(patch.show, undefined);
  assert.deepEqual(
    artemisFontProperties(
      new Map([
        ['align', 'unknown'],
        ['layermode', 'unknown'],
      ]),
    ),
    {},
  );
  assert.deepEqual(artemisFontProperties(new Map([['style', 'bold, italic']])), {styleBits: 8});
  assert.deepEqual(
    artemisFontProperties(
      new Map([
        ['range', '1'],
        ['logicalrange', '1'],
        ['indent', 'indent'],
        ['prohibit', '1'],
        ['wordparts', '1'],
      ]),
    ),
    {},
  );
  assert.throws(() => artemisFontProperties(new Map([['size', '2147483648']])), /integer/);
  assert.throws(() => artemisFontProperties(new Map([['unimplemented', '1']])), /font property/);
});

test('Native text tween configuration isolates message vectors, preserves snapshots and shares backlog vectors', async () => {
  const {ArtemisSceneTweens, artemisTweenTypes} =
    await import('../dist/engines/artemis/scene-tweens.js');
  const hash = '8953562b80608046662bd8c89015d04236b0ba3afee10c36469c11403de3ebaf';
  let current = 'a';
  const tweens = new ArtemisSceneTweens(hash, () => current);
  const tag = (args) => ({name: 'scetween', args: new Map(Object.entries(args)), sourceLine: -1});
  assert.equal(tweens.dispatch({name: 'other', args: new Map(), sourceLine: -1}), false);
  for (const type of artemisTweenTypes) {
    tweens.dispatch(
      tag({
        mode: 'add',
        type,
        param: 'entirealpha',
        diff: '128',
        time: '40ms',
        msec: '999',
        delay: '-2',
        randomdelay: '00',
        ease: 'easeinout_quad',
      }),
    );
    const frame = tweens.snapshot(type);
    assert.deepEqual(frame, [
      {
        parameter: 'alpha',
        entire: true,
        diff: Math.fround(Math.fround(128) / 255),
        time: 40,
        delay: -2,
        randomDelay: true,
        ease: 3,
        outgoing: type === 'out' || type === 'hide' || type.endsWith('_out'),
      },
    ]);
    tweens.dispatch(tag({mode: 'init', type}));
    assert.equal(tweens.snapshot(type).length, 0);
    assert.equal(frame.length, 1);
  }
  tweens.dispatch(
    tag({mode: 'add', type: 'show', param: 'left', diff: '7', ease: 'none', msec: '23'}),
  );
  const saved = tweens.snapshot('show');
  current = 'b';
  assert.equal(tweens.snapshot('show').length, 0);
  assert.deepEqual(tweens.snapshot('show', 'a'), saved);
  tweens.dispatch(tag({mode: 'add', type: 'backlog_down_in', param: 'bad', randomdelay: '0'}));
  current = 'a';
  assert.deepEqual(tweens.snapshot('backlog_down_in'), [
    {
      parameter: 'unknown',
      entire: false,
      ease: 31,
      diff: 0,
      time: 0,
      delay: 0,
      randomDelay: false,
      outgoing: false,
    },
  ]);
  tweens.dispatch(tag({mode: 'init', type: 'show', diff: 'nan'}));
  assert.equal(tweens.snapshot('show').length, 0);
  assert.equal(saved[0].time, 23);
  tweens.dispatch(tag({mode: 'unknown', type: 'show', diff: 'nan'}));
  assert.equal(tweens.snapshot('show').length, 0);
  assert.throws(() => new ArtemisSceneTweens('bad', () => ''), /Unsupported/);
});

test('UTF-8 text break controls preserve paired characters, native exact flags and replay history slots', async () => {
  const {ArtemisTextBreakControls} = await import('../dist/engines/artemis/text-break-controls.js');
  const effects = [],
    history = [],
    remembered = [];
  const controls = new ArtemisTextBreakControls({
    setIndentation: (value) => effects.push(value),
    setProhibitedCharacters: (head, foot) => effects.push({head, foot}),
    setWordParts: (parts) => effects.push({parts}),
    currentMessageLayer: () => '雪',
    recordTextCommand: (layer, tag) => history.push({layer, tag}),
    rememberTextCommand: (layer, slot, tag) => remembered.push({layer, slot, tag}),
  });
  const tag = (name, args = {}) => ({name, args: new Map(Object.entries(args)), sourceLine: 4});
  const indent = tag('indent', {
    pair: '「」😀😁「』x',
    range: '-12px',
    nest: '00',
    logicalrange: '',
  });
  controls.dispatch(indent);
  assert.deepEqual(effects[0], {
    pairs: new Map([
      ['「', '』'],
      ['😀', '😁'],
    ]),
    range: -12,
    logicalRange: true,
    nest: true,
  });
  indent.args.set('pair', 'changed');
  assert.equal(history[0].tag.args.get('pair'), '「」😀😁「』x');
  assert.equal(history[0].layer, '雪');
  assert.equal(remembered[0].slot, 'indent');
  controls.dispatch(tag('indent'), false);
  assert.deepEqual(effects[1], {pairs: new Map(), range: 0, logicalRange: false, nest: false});
  assert.equal(history.length, 1);
  controls.dispatch(tag('prohibit', {head: '、😀、\0ignored', foot: '「「'}));
  assert.deepEqual(effects[2], {head: new Set(['、', '😀']), foot: new Set(['「'])});
  assert.equal(remembered[1].slot, 'prohibit');
  controls.dispatch(tag('prohibit'));
  assert.deepEqual(effects[3], {head: new Set(), foot: new Set()});
  controls.dispatch(tag('wordparts', {parts: 'AあA'}));
  assert.deepEqual(effects[4], {parts: new Set(['A', 'あ'])});
  assert.equal(remembered.at(-1).slot, 'indent');
  assert.throws(() => controls.dispatch(tag('wordparts', {parts: '\ud800'})), /UTF-8/);
  assert.equal(controls.dispatch(tag('other')), false);
});

test('Native UTF-8 prohibited characters restore separate defaults and keep explicit whitespace', async () => {
  const {artemisUtf8Prohibition} = await import('../dist/engines/artemis/text-break-controls.js');
  const defaults = artemisUtf8Prohibition(new Set(), new Set());
  assert.deepEqual(
    defaults.head,
    new Set(Array.from('!?%)]},.:;、。，．・：；！？」』）｝〕］】')),
  );
  assert.deepEqual(defaults.foot, new Set(Array.from('([{「『（｛〔［【')));
  const explicit = new Set([' ']);
  const partial = artemisUtf8Prohibition(explicit, new Set());
  assert.deepEqual(partial.head, explicit);
  assert.notEqual(partial.head, explicit);
  assert.deepEqual(partial.foot, defaults.foot);
  partial.foot.clear();
  assert.equal(artemisUtf8Prohibition(new Set(), new Set()).foot.size, 10);
});

test('Native file fonts share resources but keep cell-size metrics and raster jobs independent', async () => {
  const {ArtemisFileFonts, artemisFileFontMetrics} =
    await import('../dist/engines/artemis/file-fonts.js');
  const {rectangleFont, createNodeFontWorker} = await import('./freetype-fixtures.mjs');
  const worker = await createNodeFontWorker();
  let reads = 0,
    opens = 0,
    closes = 0;
  const owner = new ArtemisFileFonts(
    '8953562b80608046662bd8c89015d04236b0ba3afee10c36469c11403de3ebaf',
    {
      readFontFile: async (path) => {
        reads++;
        return path === 'synthetic.ttf' ? rectangleFont() : null;
      },
      hasSystemFontFamily: async () => false,
      openFontFace: async (bytes) => {
        opens++;
        const face = await worker.open(bytes);
        return {
          requestSize: (...args) => face.requestSize(...args),
          rasterize: (...args) => face.rasterize(...args),
          close: async () => {
            closes++;
            await face.close();
          },
        };
      },
    },
  );
  try {
    const [a, b] = await Promise.all([
      owner.load('synthetic.ttf', 32),
      owner.load('synthetic.ttf', 64),
    ]);
    assert.deepEqual([reads, opens], [1, 1]);
    assert.deepEqual(a.metrics, {
      size: 32,
      baseline: 32,
      decorationThickness: 1,
      underlineThickness: 1,
      strikeoutPosition: 22,
      underlinePosition: 31,
    });
    const [small, large] = await Promise.all([a.glyph(65), b.glyph(65)]);
    assert.deepEqual([small.width, small.height, small.top, small.advance], [8, 16, 0, 24]);
    assert.deepEqual([large.width, large.height, large.top, large.advance], [16, 32, 0, 48]);
    const italic = await owner.load('synthetic.ttf', 32, 16);
    assert.deepEqual(await italic.glyph(65), small);
    const byte = await owner.load('synthetic.ttf', 288);
    assert.equal(byte.metrics.size, 32);
    await a.close();
    assert.equal(closes, 0);
    assert.equal((await b.glyph(65)).width, 16);
    await b.close();
    await italic.close();
    await byte.close();
    assert.equal(closes, 1);
    const reopened = await owner.load('synthetic.ttf', 32);
    assert.deepEqual([reads, opens], [2, 2]);
    await assert.rejects(owner.load('missing', 32), /Missing/);
    await assert.rejects(owner.load('synthetic.ttf', 256), /zero/);
    await owner.close();
    await owner.close();
    assert.equal(closes, 2);
    await assert.rejects(reopened.glyph(65), /closed/);
    await reopened.close();
    assert.equal(closes, 2);
    await assert.rejects(owner.load('synthetic.ttf', 32), /closed/);
    const narrow = artemisFileFontMetrics(10, {
      unitsPerEm: 1000,
      yPpem: 10,
      ascender: 1000,
      descender: -1000,
      underlineThickness: 100,
      underlinePosition: -1000,
    });
    assert.equal(narrow.underlinePosition, 9);
  } finally {
    await owner.close();
    worker.close();
  }
});

test('Native print overflow records UTF-8 prefixes and appends @/rp/remainder after pending FIFO tags', async () => {
  const {ArtemisPrint} = await import('../dist/engines/artemis/print.js');
  const effects = [],
    queue = [{name: 'alreadyQueued'}],
    history = [];
  let ruby = false,
    skip = false,
    policy = 0,
    result = {result: -2, consumedBytes: 3};
  const printer = new ArtemisPrint(
    '8953562b80608046662bd8c89015d04236b0ba3afee10c36469c11403de3ebaf',
    {
      currentMessageLayer: () => 'adv',
      rubyActive: () => ruby,
      debugSkipActive: () => skip,
      print: async (layer, data) => {
        effects.push(['print', layer, new TextDecoder().decode(data)]);
        return result;
      },
      appendRubyBytes: (bytes) => effects.push(['ruby', Array.from(bytes)]),
      fontOverflowPolicy: () => policy,
      writeOverflowed: (value) => effects.push(['overflowed', value]),
      reportPrintError: (_tag, kind, tail) => effects.push([kind, new TextDecoder().decode(tail)]),
      enqueue: (tag) => queue.push({...tag, args: new Map(tag.args)}),
      recordPrintCommand: (layer, tag) => history.push({layer, tag}),
    },
  );
  const tag = {
    kind: 'tag',
    name: 'print',
    sourceLine: 22,
    args: new Map([
      ['data', '雪人'],
      ['extra', 'keep'],
    ]),
  };
  await printer.dispatch(tag);
  assert.deepEqual(
    queue.map((tag) => tag.name),
    ['alreadyQueued', '@', 'rp', 'print'],
  );
  assert.equal(queue[1].sourceLine, 0);
  assert.equal(queue[2].sourceLine, 0);
  assert.equal(queue[3].sourceLine, 22);
  assert.equal(queue[3].args.get('data'), '人');
  assert.equal(queue[3].args.get('extra'), 'keep');
  assert.equal(history[0].tag.args.get('data'), '雪');
  assert.equal(tag.args.get('data'), '雪人');
  const oldQueue = queue.length;
  policy = 1;
  await printer.dispatch(tag);
  assert.equal(queue.length, oldQueue);
  assert.equal(history.at(-1).tag.args.get('data'), '雪');
  result = {result: -1, consumedBytes: 0};
  const oldHistory = history.length;
  await printer.dispatch(tag);
  assert.equal(history.length, oldHistory);
  assert.equal(effects.at(-1)[0], 'unprintable');
  ruby = true;
  await printer.dispatch({...tag, args: new Map([['data', 'A\0雪']])}, false);
  assert.deepEqual(effects.at(-1), ['ruby', [65, 0, 233, 155, 170]]);
  assert.equal(history.length, oldHistory);
  ruby = false;
  skip = true;
  await printer.dispatch({...tag, args: new Map()});
  assert.equal(history.at(-1).tag.args.has('data'), false);
  skip = false;
  result = {result: 0, consumedBytes: 0};
  await printer.dispatch({...tag, args: new Map([['data', 'A\0B']])});
  assert.deepEqual(effects.at(-1), ['print', 'adv', 'A']);
  assert.equal(history.at(-1).tag.args.get('data'), 'A\0B');
  result = {result: -2, consumedBytes: 1};
  await assert.rejects(printer.dispatch(tag), /encoded data/);
  result = {result: 1, consumedBytes: 3};
  assert.equal(await printer.dispatch(tag, false), true);
  assert.equal(await printer.dispatch({...tag, name: 'other'}), false);
});

test('Cancelling an asynchronous print prevents stale history and keeps a newer operation pending', async () => {
  const {ArtemisPrint} = await import('../dist/engines/artemis/print.js');
  const completions = [],
    effects = [];
  const printer = new ArtemisPrint(
    '8953562b80608046662bd8c89015d04236b0ba3afee10c36469c11403de3ebaf',
    {
      currentMessageLayer: () => 'adv',
      rubyActive: () => false,
      debugSkipActive: () => false,
      print: () => new Promise((resolve) => completions.push(resolve)),
      appendRubyBytes: () => {},
      fontOverflowPolicy: () => 0,
      writeOverflowed: () => effects.push('overflow'),
      reportPrintError: () => effects.push('error'),
      enqueue: () => effects.push('queue'),
      recordPrintCommand: () => effects.push('history'),
    },
  );
  const tag = {kind: 'tag', name: 'print', sourceLine: 0, args: new Map([['data', 'A']])};
  const old = printer.dispatch(tag);
  await assert.rejects(printer.dispatch(tag), /Overlapping/);
  printer.cancelPending();
  const current = printer.dispatch(tag);
  completions[0]({result: -2, consumedBytes: 0});
  await assert.rejects(old, /cancelled/);
  assert.deepEqual(effects, []);
  await assert.rejects(printer.dispatch(tag), /Overlapping/);
  completions[1]({result: 1, consumedBytes: 1});
  await current;
  assert.deepEqual(effects, ['history']);
});

test('Artemis Lua surface preload binding requires an actual queue owner and preserves native string/NUL rules', async () => {
  const {ArtemisLua} = await import('../dist/engines/artemis/lua.js');
  const names = [],
    released = [],
    queries = [];
  const lua = new ArtemisLua({
    readFile: () => null,
    fileExists: () => false,
    now: () => 0,
    tag: () => {},
    enqueueTag: () => {},
    variable: () => '',
    bindSurfaceAsync: (name) => names.push(name),
    unbindSurface: (name) => released.push(name),
    isLoadingSurface: (name) => {
      queries.push(name);
      return name === undefined || name === '雪.png';
    },
  });
  try {
    lua.vm.execute(
      bytes('engine:bindSurfaceAsync("font.png\\000ignored"); engine:bindSurfaceAsync("雪.png")'),
    );
    assert.deepEqual(names, ['font.png', '雪.png']);
    lua.vm.execute(
      bytes(
        'engine:unbindSurface("雪.png\\000ignored"); assert(engine:isLoadingSurface("雪.png\\000ignored") == true); assert(engine:isLoadingSurface("absent") == false); assert(engine:isLoadingSurface() == true); assert(engine:isLoadingSurface(12) == true); assert(engine:isLoadingSurface({}) == true)',
      ),
    );
    assert.deepEqual(released, ['雪.png']);
    assert.deepEqual(queries, ['雪.png', 'absent', undefined, undefined, undefined]);
    assert.throws(() => lua.vm.execute(bytes('engine:unbindSurface(12)')), /surface name string/);
    assert.throws(
      () => lua.vm.execute(bytes('engine:bindSurfaceAsync(12)')),
      /surface name string/,
    );
    assert.throws(
      () => lua.vm.execute(bytes('engine:bindSurfaceAsync({})')),
      /surface name string/,
    );
  } finally {
    lua.close();
  }
});

test('Artemis SE stop/fade-out resolves exact slots, delegates actual timing and preserves replay history', async () => {
  const {ArtemisSeStop} = await import('../dist/engines/artemis/se-stop.js');
  const hash = '8953562b80608046662bd8c89015d04236b0ba3afee10c36469c11403de3ebaf';
  const slots = new Map([
      ['01', 4],
      ['', 7],
    ]),
    history = new Set(['01', 'missing', '']),
    calls = [];
  const commands = new ArtemisSeStop(hash, {
    effectIndex: (id) => slots.get(id),
    stopEffect: (slot, time) => calls.push([slot, time]),
    hasEffectHistory: (id) => history.has(id),
    deleteEffectHistory: (id) => history.delete(id),
  });
  const tag = (name, args) => ({
    kind: 'tag',
    name,
    sourceLine: 0,
    args: new Map(Object.entries(args)),
  });
  assert.equal(commands.dispatch(tag('sefadeout', {id: '01', time: '  +250tail'})), true);
  assert.deepEqual(calls, [[4, 250]]);
  assert.equal(history.has('01'), false);
  history.add('01');
  commands.dispatch(tag('sestop', {id: '01'}), false);
  assert.deepEqual(calls[1], [4, 0]);
  assert.equal(history.has('01'), true);
  commands.dispatch(tag('sestop', {id: 'missing', time: '999999999999999999'}));
  assert.equal(history.has('missing'), false); // Missing slot never parses time.
  commands.dispatch(tag('sestop', {}));
  assert.deepEqual(calls[2], [7, 0]);
  assert.equal(history.has(''), false);
  assert.equal(commands.dispatch(tag('seplay', {id: '01'})), false);
  assert.throws(
    () => commands.dispatch(tag('sestop', {id: '01', time: '999999999999999999'})),
    /integer/,
  );
  assert.throws(() => new ArtemisSeStop('unknown', {}), /executable/);
  const failed = new ArtemisSeStop(hash, {
    effectIndex: () => 0,
    stopEffect: () => {
      throw Error('voice failure');
    },
    hasEffectHistory: () => true,
    deleteEffectHistory: () => {
      throw Error('must not clear after failure');
    },
  });
  assert.throws(() => failed.dispatch(tag('sestop', {id: '01'})), /voice failure/);
});

async function sePlayFixture(overrides = {}) {
  const {ArtemisSePlay} = await import('../dist/engines/artemis/se-play.js');
  const slots = new Map([['01', 1]]),
    calls = [],
    history = new Map();
  const host = {
    debugSkipActive: () => false,
    commandSkipActive: () => false,
    effectIndex: (id) => slots.get(id),
    stopEffect: (i, ms) => calls.push(['stop', i, ms]),
    prepareEffect: async (file, buffer) => {
      calls.push(['prepare', file, buffer]);
      return 2;
    },
    discardPreparedEffect: (i) => calls.push(['discard', i]),
    setEffectIndex: (id, i) => {
      slots.set(id, i);
      calls.push(['slot', id, i]);
    },
    setEffectGain: (i, scope, gain) => calls.push(['gain', i, scope, gain]),
    setEffectPan: (i, pan, ms) => calls.push(['pan', i, pan, ms]),
    effectGainVariable: () => 800,
    startEffect: (i, ms, loop) => calls.push(['start', i, ms, loop]),
    replaceEffectHistory: (id, tag) => {
      history.set(id, tag);
      calls.push(['history', id, tag?.name ?? null]);
    },
    effectLoadFailed: () => calls.push(['missing']),
    ...overrides,
  };
  const controller = new ArtemisSePlay(
    '8953562b80608046662bd8c89015d04236b0ba3afee10c36469c11403de3ebaf',
    host,
  );
  const tag = (args = {}, name = 'seplay') => ({
    kind: 'tag',
    name,
    sourceLine: 7,
    args: new Map(Object.entries(args)),
  });
  return {controller, calls, history, slots, tag};
}

test('Artemis sefade/sepan move a known voice over time and copy the value into its save-object block', async () => {
  const {ArtemisSeAdjust} = await import('../dist/engines/artemis/se-adjust.js');
  const {ArtemisSaveData} = await import('../dist/engines/artemis/save-data.js');
  const data = new ArtemisSaveData(),
    calls = [];
  const slots = new Map([['vo', 4]]);
  const adjust = new ArtemisSeAdjust(
    '8953562b80608046662bd8c89015d04236b0ba3afee10c36469c11403de3ebaf',
    {
      effectIndex: (id) => slots.get(id),
      setEffectGain: (...args) => calls.push(['gain', ...args]),
      setEffectPan: (...args) => calls.push(['pan', ...args]),
      setEffectHistoryArgument: (id, key, value) => data.setEffectArgument(id, key, value),
    },
  );
  const tag = (name, args) => ({
    kind: 'tag',
    name,
    sourceLine: 1,
    args: new Map(Object.entries(args)),
  });
  data.replaceEffect('vo', tag('seplay', {id: 'vo', file: 'a.ogg', loop: '1', gain: '1000'}));
  assert.equal(adjust.dispatch(tag('sefade', {id: 'vo', gain: '500', time: '200'})), true);
  assert.equal(adjust.dispatch(tag('sepan', {id: 'vo', pan: '-300'})), true);
  // An unknown id moves no voice; operator[] still creates its block.
  adjust.dispatch(tag('sefade', {id: 'gone', time: 'x'}));
  // Replay moves the voice and leaves the history alone.
  adjust.dispatch(tag('sefade', {id: 'vo', gain: '700'}), false);
  assert.equal(adjust.dispatch(tag('sestop', {id: 'vo'})), false);
  assert.deepEqual(calls, [
    ['gain', 4, 0, 500, 200],
    ['pan', 4, -300, 0],
    ['gain', 4, 0, 700, 0],
  ]);
  const effects = data.snapshot().effects;
  assert.deepEqual(Object.fromEntries(effects.get('vo').args), {
    id: 'vo',
    file: 'a.ogg',
    loop: '1',
    gain: '500',
    pan: '-300',
  });
  assert.equal(effects.get('vo').name, 'seplay');
  assert.equal(effects.get('gone').name, '');
  assert.deepEqual([...effects.get('gone').args], [['gain', '']]);
});

test('Artemis SE preparation, dual gains, pan, fade-in and loop replay history follow native service order', async () => {
  const {controller, calls, history, slots, tag} = await sePlayFixture();
  const input = tag({
    id: '01',
    file: 'effect.ogg',
    buffer: '0',
    gain: ' +1000tail',
    pan: '-25',
    time: '10ms',
    loop: '',
  });
  await controller.dispatch(input);
  assert.deepEqual(calls, [
    ['stop', 1, 0],
    ['prepare', 'effect.ogg', 0],
    ['slot', '01', 2],
    ['gain', 2, 0, 1000],
    ['pan', 2, -25, 0],
    ['gain', 2, 1, 800],
    ['start', 2, 10, true],
    ['history', '01', 'seplay'],
  ]);
  assert.equal(slots.get('01'), 2);
  input.args.set('file', 'mutated');
  assert.equal(history.get('01').args.get('file'), 'effect.ogg');
  calls.length = 0;
  await controller.dispatch(tag({id: '01', file: 'second.ogg', loop: '0'}, 'sefadein'), false);
  assert.equal(
    calls.some((x) => x[0] === 'history'),
    false,
  );
  assert.deepEqual(calls.at(-1), ['start', 2, 0, false]);
  await controller.dispatch(tag({id: '01', file: 'third.ogg', loop: '0'}));
  assert.equal(history.get('01'), null); // Native replaces with empty history block.
});

test('Artemis debugskip preserves loop history without audio, while skippable playback stops the old voice before returning', async () => {
  const debug = await sePlayFixture({debugSkipActive: () => true});
  await debug.controller.dispatch(
    debug.tag({id: '01', loop: '1', buffer: 'bad', gain: '999999999999999'}),
  );
  assert.deepEqual(debug.calls, [['history', '01', 'seplay']]);
  const skip = await sePlayFixture({commandSkipActive: () => true});
  await skip.controller.dispatch(
    skip.tag({id: '01', skippable: '1', file: 'unused', time: '999999999999999'}),
  );
  assert.deepEqual(skip.calls, [['stop', 1, 0]]);
  assert.equal(skip.history.size, 0);
  const missing = await sePlayFixture({prepareEffect: async () => 0});
  await missing.controller.dispatch(missing.tag({id: '01', file: 'absent'}));
  assert.deepEqual(missing.calls, [['stop', 1, 0], ['missing']]);
  assert.equal(missing.slots.get('01'), 1);
});

test('Closing Artemis SE preparation disposes the completed resource without starting or recording it', async () => {
  let finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const {controller, calls, tag} = await sePlayFixture({prepareEffect: () => pending});
  const operation = controller.dispatch(tag({id: '01', file: 'pending'}));
  await assert.rejects(controller.dispatch(tag({id: '01'})), /Overlapping/);
  controller.close();
  finish(9);
  await assert.rejects(operation, /cancelled/);
  assert.deepEqual(calls, [
    ['stop', 1, 0],
    ['discard', 9],
  ]);
  await assert.rejects(controller.dispatch(tag()), /closed/);
});

test('Native optional variable lookup preserves absence, local shadowing and owned bytes', async () => {
  const {ArtemisVariables} = await import('../dist/engines/artemis/variables.js');
  const variables = new ArtemisVariables();
  assert.equal(variables.lookup('s.segain.1'), undefined);
  assert.throws(() => variables.read('s.segain.1'), /Unsupported native/);
  variables.write('s.segain.1', '800');
  variables.pushLocal();
  variables.write('s.segain.1', '500', true);
  const value = variables.lookup('s.segain.1');
  value[0] = 0;
  assert.equal(new TextDecoder().decode(variables.read('s.segain.1')), '500');
  variables.popLocal();
  assert.equal(new TextDecoder().decode(variables.lookup('s.segain.1')), '800');
});

test('Nonvisual sound preparation decodes real synthetic Vorbis PCM but refuses playback without a device owner', async () => {
  const {createArtemisSoundDecodeFixture} =
    await import('../tools/artemis-sound-decode-fixture.mjs');
  const {readFile} = await import('node:fs/promises');
  const encoded = await readFile(
    new URL('./fixtures/audio/vorbis-boundaries.ogg', import.meta.url),
  );
  const snapshot = Buffer.from(encoded);
  const fixture = createArtemisSoundDecodeFixture(async (name) =>
    name === 'fixture.ogg' ? encoded : null,
  );
  try {
    const index = await fixture.prepareEffect('fixture.ogg', 0);
    assert.ok(index > 0);
    const sample = fixture.summary().samples[0];
    assert.ok(sample.frames > 0);
    assert.ok(sample.sampleRate > 0);
    assert.ok(sample.channels > 0);
    assert.equal(sample.pcmSha256.length, sample.channels);
    assert.equal(fixture.summary().audioGraph, false);
    assert.deepEqual(encoded, snapshot);
    fixture.setEffectGain(index, 0, 1000);
    fixture.setEffectGain(index, 1, 800);
    fixture.setEffectPan(index, 0, 0);
    assert.throws(() => fixture.startEffect(index, 10, false), /playback owner/);
    assert.equal(await fixture.prepareEffect('missing', 0), 0);
    await assert.rejects(fixture.prepareEffect('fixture.ogg', 1), /buffered/);
    fixture.discardPreparedEffect(index);
    assert.equal(fixture.summary().retainedSounds, 0);
  } finally {
    await fixture.close();
  }
});

test('Lua SE commands suspend until actual preparation finishes, before executing the next Lua statement', async () => {
  const f = await sePlayFixture();
  const source = bytes(
    `[lua]function boot(e) e:tag{'seplay',id='01',file='fixture.ogg'}; completed=1 end[/lua][calllua function="boot"][stop]`,
  );
  let script, pending;
  const lua = new ArtemisLua({
    readFile: () => source,
    fileExists: () => true,
    now: () => 0,
    variable: () => '',
    suspendableTags: true,
    tag: (tag) => script.executeTag(tag),
    enqueueTag: () => {},
  });
  script = new ArtemisScript(lua, {
    readFile: () => source,
    dispatch: (tag) => {
      if (tag.name === 'seplay') {
        pending = f.controller.dispatch(tag);
        return 'suspended';
      }
      if (tag.name === 'stop') return 'stopped';
    },
  });
  try {
    script.load('boot');
    assert.equal(script.run(), 'waiting');
    assert.equal(lua.vm.getGlobal('completed'), null);
    await pending;
    assert.deepEqual(f.calls.at(-2), ['start', 2, 0, false]);
    script.resumeLua();
    assert.equal(script.run(), 'stopped');
    assert.equal(lua.vm.getGlobal('completed'), 1);
  } finally {
    f.controller.close();
    script.cancelLuaCalls();
    lua.close();
  }
});

test('Sound filename lookup preserves native preference, rewind, and candidate ownership', async () => {
  const {ArtemisSoundLoader} = await import('../dist/engines/artemis/sound-loader.js');
  const opened = [],
    attempts = [],
    sound = {frames: 12};
  const files = new Map([
    ['name.ogg', bytes('bad')],
    ['name.ogg.wav', bytes('good')],
    [':voice/雪.ogg', bytes('good')],
    ['dir\\part.OGG', bytes('good')],
  ]);
  const codecs = [
    {
      extensions: ['wav'],
      decode: async (value, mode) => {
        attempts.push(['wav', luaText(value), mode]);
        if (luaText(value) === 'good') return sound;
        value.fill(0); // A consuming/transfer-capable host cannot corrupt the next attempt.
        return null;
      },
    },
    {
      extensions: ['ogg', 'ogg'],
      decode: async (value, mode) => {
        attempts.push(['ogg', luaText(value), mode]);
        return null;
      },
    },
  ];
  const loader = new ArtemisSoundLoader(async (path) => {
    opened.push(path);
    return files.get(path) ?? null;
  }, codecs);
  assert.deepEqual(await loader.load('name.ogg\0ignored', -7), {path: 'name.ogg.wav', sound});
  assert.deepEqual(opened, ['name.ogg', 'name.ogg.wav']);
  assert.deepEqual(attempts, [
    ['ogg', 'bad', -7],
    ['wav', 'bad', -7],
    ['ogg', 'bad', -7],
    ['wav', 'good', -7],
  ]);
  opened.length = attempts.length = 0;
  // Appended candidates only use their corresponding codec, not all sniffers.
  assert.equal(await loader.load(':voice/雪', 0), null);
  assert.deepEqual(opened, [':voice/雪', ':voice/雪.wav', ':voice/雪.ogg', ':voice/雪.ogg']);
  assert.deepEqual(attempts, [
    ['ogg', 'good', 0],
    ['ogg', 'good', 0],
  ]);
  attempts.length = 0;
  assert.deepEqual(await loader.load('dir\\part.OGG', 0), {path: 'dir\\part.OGG', sound});
  assert.deepEqual(attempts, [['wav', 'good', 0]]); // Suffix matching is case-sensitive.
  await assert.rejects(() => loader.load('name', 2147483648), /int32/);
  const refused = new ArtemisSoundLoader(
    async () => bytes('good'),
    [
      {
        extensions: ['ogg'],
        decode: async () => {
          throw Error('decoder unavailable');
        },
      },
    ],
  );
  await assert.rejects(() => refused.load('name.ogg', 0), /decoder unavailable/);
});

test('Revision-selected sound plugins search Vorbis before WAVE with native uppercase aliases', async () => {
  const {createArtemisSoundLoader} = await import('../dist/engines/artemis/sound-loader.js');
  const {ARTEMIS_3179_EXECUTABLE_SHA256: sha} = await import('../dist/engines/artemis/revision.js');
  const opened = [],
    decoded = [],
    sound = {sampleRate: 48000};
  const loader = createArtemisSoundLoader(
    sha,
    async (path) => {
      opened.push(path);
      return ['voice.OGG', 'voice.wav'].includes(path) ? bytes('ogg') : null;
    },
    {
      vorbis: async (value, mode, path) => {
        decoded.push(['vorbis', luaText(value), mode, path]);
        return sound;
      },
      wave: async () => {
        throw Error('WAVE should not run');
      },
    },
  );
  assert.deepEqual(await loader.load('voice', 3), {path: 'voice.OGG', sound});
  assert.deepEqual(opened, ['voice', 'voice.ogg', 'voice.OGG']);
  assert.deepEqual(decoded, [['vorbis', 'ogg', 3, 'voice.OGG']]);
  assert.throws(
    () =>
      createArtemisSoundLoader('0'.repeat(64), async () => null, {
        vorbis: async () => null,
        wave: async () => null,
      }),
    /Unsupported Artemis/,
  );
});

test('Artemis revisions are selected by executable hash with explicit Rev.3139 differences', async () => {
  const {artemisRevision, ARTEMIS_3139_EXECUTABLE_SHA256, ARTEMIS_3179_EXECUTABLE_SHA256} =
    await import('../dist/engines/artemis/revision.js');
  const r3179 = artemisRevision(ARTEMIS_3179_EXECUTABLE_SHA256),
    r3139 = artemisRevision(ARTEMIS_3139_EXECUTABLE_SHA256.toUpperCase());
  assert.deepEqual(
    [r3179.engineVersion, r3179.screenshot, r3179.soundLoaderRewinds],
    [3179, 'scene', true],
  );
  assert.deepEqual(
    [r3139.engineVersion, r3139.screenshot, r3139.soundLoaderRewinds],
    [3139, 'presented', false],
  );
  assert.deepEqual(
    [r3139.minimumSupportVersion, r3139.saveDataVersion],
    [r3179.minimumSupportVersion, r3179.saveDataVersion],
  );
  assert.equal(Object.isFrozen(r3139), true);
  // A second Rev.3139 executable (code sections identical, only .rsrc differs) gets every
  // Rev.3139 field under its own hash.
  const {ARTEMIS_3139_RESOURCE_VARIANT_SHA256: variantSha} =
    await import('../dist/engines/artemis/revision.js');
  const variant = artemisRevision(variantSha);
  assert.deepEqual({...variant, executableSha256: r3139.executableSha256}, {...r3139});
  assert.equal(variant.executableSha256, variantSha);
  assert.notEqual(variantSha, ARTEMIS_3139_EXECUTABLE_SHA256);
  assert.equal(Object.isFrozen(variant), true);
  assert.throws(() => artemisRevision('1'.repeat(64)), /Unsupported Artemis executable/);
  const {initializeArtemisVariables} = await import('../dist/engines/artemis/revision.js');
  const written = new Map();
  initializeArtemisVariables(
    {write: (key, value) => written.set(key, value)},
    ARTEMIS_3139_EXECUTABLE_SHA256,
  );
  assert.deepEqual(
    ['s.engineversion', 's.builddate', 's.minimumsupportversion', 's.savedataversion'].map((key) =>
      written.get(key),
    ),
    ['3139', 'Wed Aug 30 19:57:57 2023', '1103', '1003'],
  );
});

test('Rev.3257 publishes its own boot record only for its exact executable hash', async () => {
  const {
    artemisRevision,
    initializeArtemisVariables,
    ARTEMIS_3257_EXECUTABLE_SHA256: sha,
  } = await import('../dist/engines/artemis/revision.js');
  const revision = artemisRevision(sha.toUpperCase());
  assert.equal(revision.engineVersion, 3257);
  assert.equal(revision.screenshot, 'scene');
  assert.equal(revision.soundLoaderRewinds, true);
  assert.equal(Object.isFrozen(revision), true);
  const written = new Map();
  initializeArtemisVariables({write: (key, value) => written.set(key, value)}, sha);
  assert.deepEqual(
    ['s.engineversion', 's.builddate', 's.minimumsupportversion', 's.savedataversion'].map((key) =>
      written.get(key),
    ),
    ['3257', 'Thu Apr 17 21:58:09 2025', '1103', '1003'],
  );
  assert.throws(() => artemisRevision('3257'), /Unsupported Artemis executable/);
  assert.throws(
    () => artemisRevision('7c604c92' + '0'.repeat(56)),
    /Unsupported Artemis executable/,
  );
});

test('Wrapped Rev.3257 resource variant boots the same native profile under its exact root identity', async () => {
  const {openArtemisRuntimeFixture} = await import('./artemis-runtime-fixture.mjs');
  const {
    artemisRevision,
    ARTEMIS_3257_EXECUTABLE_SHA256: original,
    ARTEMIS_3257_WRAPPED_RESOURCE_VARIANT_SHA256: wrapped,
  } = await import('../dist/engines/artemis/revision.js');
  assert.deepEqual(
    {...artemisRevision(wrapped), executableSha256: original},
    {...artemisRevision(original)},
  );
  assert.throws(
    () => artemisRevision('c0e25d283b3f838dddf456eb26e4846bef9316cebfe1cb52054c55be6d21f4b4'),
    /Unsupported Artemis executable/,
  );
  assert.throws(
    () => artemisRevision(wrapped.slice(0, 63) + '0'),
    /Unsupported Artemis executable/,
  );
  const fixture = await openArtemisRuntimeFixture({'system/first.iet': '[stop]'}, {hash: wrapped});
  try {
    await fixture.runtime.boot();
    assert.equal(fixture.runtime.runMode, 3);
    assert.deepEqual(
      ['s.engineversion', 's.builddate', 's.savedataversion', 's.llp64'].map((key) =>
        luaText(fixture.runtime.variables.lookup(key)),
      ),
      ['3257', 'Thu Apr 17 21:58:09 2025', '1003', '1'],
    );
  } finally {
    await fixture.close();
  }
});

test('Rev.3248 boots the Rev.3257 profile under its own version and build date', async () => {
  const {openArtemisRuntimeFixture} = await import('./artemis-runtime-fixture.mjs');
  const {
    artemisRevision,
    ARTEMIS_3257_EXECUTABLE_SHA256: rev3257,
    ARTEMIS_3248_EXECUTABLE_SHA256: hash,
  } = await import('../dist/engines/artemis/revision.js');
  assert.deepEqual(
    {...artemisRevision(hash), executableSha256: rev3257, engineVersion: 3257, buildDate: ''},
    {...artemisRevision(rev3257), buildDate: ''},
  );
  assert.throws(() => artemisRevision(hash.slice(0, 63) + '0'), /Unsupported Artemis executable/);
  const fixture = await openArtemisRuntimeFixture({'system/first.iet': '[stop]'}, {hash});
  try {
    await fixture.runtime.boot();
    assert.deepEqual(
      ['s.engineversion', 's.builddate', 's.minimumsupportversion', 's.savedataversion'].map(
        (key) => luaText(fixture.runtime.variables.lookup(key)),
      ),
      ['3248', 'Mon Jan 6 19:35:50 2025', '1103', '1003'],
    );
  } finally {
    await fixture.close();
  }
});

test('Rev.3139 sound loaders do not rewind: a further loader of a failed exact file is refused', async () => {
  const {createArtemisSoundLoader} = await import('../dist/engines/artemis/sound-loader.js');
  const {ARTEMIS_3139_EXECUTABLE_SHA256: sha} = await import('../dist/engines/artemis/revision.js');
  const decoded = [],
    sound = {sampleRate: 44100};
  const loader = createArtemisSoundLoader(
    sha,
    async (path) => (['a.ogg', 'b', 'c.wav', 'd.ogg'].includes(path) ? bytes(path) : null),
    {
      vorbis: async (value) => {
        decoded.push(['vorbis', luaText(value)]);
        return luaText(value) === 'a.ogg' ? sound : null;
      },
      wave: async (value) => {
        decoded.push(['wave', luaText(value)]);
        return luaText(value) === 'c.wav' ? sound : null;
      },
    },
  );
  // A first loader succeeding needs no rewind.
  assert.deepEqual(await loader.load('a.ogg', 0), {path: 'a.ogg', sound});
  // Rev.3179 would sniff the same file again from offset 0 after the failed Vorbis loader.
  await assert.rejects(() => loader.load('b', 0), /without the rewind/);
  assert.deepEqual(decoded, [
    ['vorbis', 'a.ogg'],
    ['vorbis', 'b'],
  ]);
  decoded.length = 0;
  // Appended suffixes open a fresh file each.
  assert.deepEqual(await loader.load('c', 0), {path: 'c.wav', sound});
  assert.deepEqual(decoded, [['wave', 'c.wav']]);
  await assert.rejects(() => loader.load('d.ogg', 0), /without the rewind/);
});

test('Native WAVE sources stream paired files and rewind only the active segment', async () => {
  const {ArtemisWaveSource} = await import('../dist/engines/artemis/wave-source.js');
  const {ARTEMIS_3179_EXECUTABLE_SHA256: sha} = await import('../dist/engines/artemis/revision.js');
  const {encodeWav} = await import('../dist/audio/pcm.js');
  const wave = (values) =>
    encodeWav({
      sampleRate: 48000,
      sampleCount: values.length,
      channels: [Float32Array.from(values)],
    });
  const a = wave([0.25, 0.5]),
    b = wave([-0.25, -0.5]),
    opened = [];
  const files = new Map([
    ['dir\\music_a.wav', a],
    ['dir\\music_b.wav', b],
    ['single.WAV', a],
  ]);
  const readFile = async (path) => {
    opened.push(path);
    return files.get(path) ?? null;
  };
  const source = await ArtemisWaveSource.load(sha, 'dir\\music_a.wav', readFile);
  assert.deepEqual(opened, ['dir\\music_a.wav', 'dir\\music_b.wav']);
  assert.deepEqual(source.format, {
    sampleRate: 48000,
    channels: 1,
    bitsPerSample: 16,
    blockAlign: 2,
  });
  assert.equal(source.dataSize, 4);
  assert.deepEqual(source.read(2), a.slice(44, 46));
  source.reset();
  assert.deepEqual(source.read(6), Uint8Array.from([...a.slice(44), ...b.slice(44, 46)]));
  source.reset(); // Once switched, native loops B; it does not replay the intro A.
  assert.deepEqual(source.read(20), b.slice(44));
  source.reset();
  assert.deepEqual(source.read(0), new Uint8Array());
  assert.deepEqual(source.read(2), b.slice(44, 46));
  assert.throws(() => source.read(-1), /length/);
  const single = await ArtemisWaveSource.load(sha, 'single.WAV', readFile);
  assert.deepEqual(single.read(99), a.slice(44));
  single.reset();
  assert.deepEqual(single.read(99), a.slice(44));
  const withoutPair = await ArtemisWaveSource.load(sha, 'missing_a.wav', async (path) =>
    path.endsWith('_a.wav') ? a : bytes('not a wave'),
  );
  assert.deepEqual(withoutPair.read(99), a.slice(44));
  const upperPaths = [];
  const upper = await ArtemisWaveSource.load(sha, 'music_A.wav', async (path) => {
    upperPaths.push(path);
    return a;
  });
  assert.deepEqual(upperPaths, ['music_A.wav']);
  assert.deepEqual(upper.read(99), a.slice(44));
  const invalid = Uint8Array.from(a);
  new DataView(invalid.buffer).setUint32(28, 1, true);
  assert.equal(await ArtemisWaveSource.load(sha, 'bad.wav', async () => invalid), null);
  // Native ignores declared RIFF size and skips odd chunks without RIFF padding.
  const odd = new Uint8Array(a.length + 9);
  odd.set(a.slice(0, 12));
  odd.set(bytes('JUNK'), 12);
  odd[16] = 1;
  odd[20] = 7;
  odd.set(a.slice(12), 21);
  new DataView(odd.buffer).setUint32(4, 4, true);
  const oddSource = await ArtemisWaveSource.load(sha, 'odd.wav', async () => odd);
  assert.deepEqual(oddSource.read(99), a.slice(44));
  const truncated = a.slice(0, 46);
  const short = await ArtemisWaveSource.load(sha, 'short.wav', async () => truncated);
  assert.equal(short.dataSize, 4);
  assert.deepEqual(short.read(99), truncated.slice(44));
  assert.deepEqual(short.read(99), new Uint8Array());
  await assert.rejects(
    () => ArtemisWaveSource.load('0'.repeat(64), 'a.wav', readFile),
    /Unsupported Artemis/,
  );
});

test('Native Vorbis PCM16 conversion preserves rounding, saturation and encoded channel order', async () => {
  const {artemisVorbisPcm16} = await import('../dist/engines/artemis/vorbis-pcm.js');
  const {ARTEMIS_3179_EXECUTABLE_SHA256: sha} = await import('../dist/engines/artemis/revision.js');
  const left = Float32Array.from([
    0.5 / 32768,
    1.5 / 32768,
    -0.5 / 32768,
    -1.5 / 32768,
    1,
    -1,
    Infinity,
    NaN,
  ]);
  const right = Float32Array.from([
    3.5 / 32768,
    2.5 / 32768,
    -3.5 / 32768,
    -2.5 / 32768,
    2,
    -2,
    -Infinity,
    65536,
  ]);
  const pcm = {sampleRate: 48000, frames: 8, planes: [left, right]};
  const result = artemisVorbisPcm16(sha, pcm, 'nearest-even'),
    view = new DataView(result.buffer);
  const actual = Array.from({length: 16}, (_, i) => view.getInt16(i * 2, true));
  assert.deepEqual(
    actual,
    [0, 4, 2, 2, 0, -4, -2, -2, 32767, 32767, -32768, -32768, -32768, -32768, -32768, -32768],
  );
  const one = {
    sampleRate: 48000,
    frames: 2,
    planes: [Float32Array.from([0.5 / 32768, -0.5 / 32768])],
  };
  const values = (mode) => {
    const b = artemisVorbisPcm16(sha, one, mode);
    const v = new DataView(b.buffer);
    return [v.getInt16(0, true), v.getInt16(2, true)];
  };
  assert.deepEqual(values('down'), [0, -1]);
  assert.deepEqual(values('up'), [1, 0]);
  assert.deepEqual(values('toward-zero'), [0, 0]);
  assert.throws(() => values('invented'), /rounding/);
});

test('Vorbis exact-end reads retain intro ownership until decoder EOF is actually observed', async () => {
  const {ArtemisVorbisSource} = await import('../dist/engines/artemis/vorbis-source.js');
  const {ARTEMIS_3179_EXECUTABLE_SHA256: sha} = await import('../dist/engines/artemis/revision.js');
  const files = new Map([
      ['音_a.OGG', new Uint8Array([1])],
      ['音_b.OGG', new Uint8Array([2])],
    ]),
    opened = [];
  const decode = async (bytes) => ({
    sampleRate: 48000,
    channels: 1,
    bytes: new Uint8Array([bytes[0], 0]),
  });
  const source = await ArtemisVorbisSource.load(
    sha,
    '音_a.OGG',
    async (path) => {
      opened.push(path);
      return files.get(path) ?? null;
    },
    decode,
  );
  assert.deepEqual(opened, ['音_a.OGG', '音_b.OGG']);
  assert.equal(source.totalDataSize, 4);
  assert.equal(source.loopStartBytes, 2);
  assert.deepEqual(source.read(2), new Uint8Array([1, 0]));
  source.reset();
  assert.deepEqual(source.read(2), new Uint8Array([1, 0]));
  source.read(0);
  source.reset();
  assert.deepEqual(source.read(2), new Uint8Array([1, 0]));
  assert.deepEqual(source.read(2), new Uint8Array([2, 0]));
  source.reset();
  assert.deepEqual(source.read(4), new Uint8Array([2, 0]));
  assert.throws(() => source.read(1), /sub-frame/);
  const failed = await ArtemisVorbisSource.fromBytes(
    sha,
    'bad.ogg',
    new Uint8Array(),
    async () => null,
    async () => null,
  );
  assert.equal(failed, null);
  await assert.rejects(
    () =>
      ArtemisVorbisSource.fromBytes(
        sha,
        'bad.ogg',
        new Uint8Array(),
        async () => null,
        async () => {
          throw Error('worker unavailable');
        },
      ),
    /unavailable/,
  );
});

test('Buffered native sound loading resolves codecs and caches complete paired PCM without a streaming loop window', async () => {
  const {createArtemisBufferedSoundDecoder} =
    await import('../dist/engines/artemis/buffered-sound-decoder.js');
  const {ARTEMIS_3179_EXECUTABLE_SHA256: sha} = await import('../dist/engines/artemis/revision.js');
  const {encodeWav} = await import('../dist/audio/pcm.js');
  const wav = (values) =>
    encodeWav({
      sampleRate: 48000,
      sampleCount: values.length,
      channels: [Float32Array.from(values)],
    });
  const files = new Map([
      ['音_a.wav', wav([0.25, 0.5])],
      ['音_b.wav', wav([-0.25, -0.5])],
    ]),
    opened = [];
  const decoder = createArtemisBufferedSoundDecoder(
    sha,
    async (path) => {
      opened.push(path);
      return files.get(path) ?? null;
    },
    'nearest-even',
  );
  try {
    const clip = await decoder.decode('音_a', -1);
    assert.deepEqual(opened, ['音_a', '音_a.ogg', '音_a.OGG', '音_a.wav', '音_b.wav']);
    assert.equal(clip.sampleCount, 4);
    assert.equal(clip.sampleRate, 48000);
    assert.deepEqual([...clip.channels[0]], [0.25, 0.5, -0.25, -0.5]);
    assert.equal(clip.loop, undefined); // -1 uses the complete hardware buffer on repeat.
    await assert.rejects(() => decoder.decode('音_a', 0), /progressive/);
    await assert.rejects(() => decoder.decode('音_a', 100), /progressive/);
    assert.equal(await decoder.decode('missing', -1), null);
    decoder.close();
    await assert.rejects(() => decoder.decode('音_a', -1), /closed/);
  } finally {
    decoder.close();
  }
});

test('Rolling audio refills the inactive half and preserves native trailing-half completion', async () => {
  const {ArtemisRollingSoundBuffer} =
    await import('../dist/engines/artemis/rolling-sound-buffer.js');
  const {ArtemisWaveSource} = await import('../dist/engines/artemis/wave-source.js');
  const {encodeWav} = await import('../dist/audio/pcm.js');
  const {ARTEMIS_3179_EXECUTABLE_SHA256: sha} = await import('../dist/engines/artemis/revision.js');
  const a = encodeWav({sampleRate: 1000, sampleCount: 1, channels: [Float32Array.from([0.25])]});
  const source = await ArtemisWaveSource.fromBytes(sha, 'one.wav', a, async () => null);
  const ring = new ArtemisRollingSoundBuffer(sha, source, 2);
  assert.equal(ring.halfSize, 4);
  assert.equal(ring.start(false), true);
  assert.deepEqual(ring.snapshot().slice(0, 4), new Uint8Array([0, 32, 0, 0]));
  assert.deepEqual(ring.tick(0), {half: 1, bytes: new Uint8Array(4), stopped: false});
  assert.equal(ring.tick(0), null);
  assert.equal(ring.tick(4), null);
  assert.deepEqual(ring.tick(5), {half: 0, bytes: new Uint8Array(4), stopped: true});
  assert.equal(ring.playing, false);
  assert.equal(ring.tick(0), null);
  const files = new Map([
    ['loop_a.wav', a],
    [
      'loop_b.wav',
      encodeWav({sampleRate: 1000, sampleCount: 1, channels: [Float32Array.from([-0.25])]}),
    ],
  ]);
  const paired = await ArtemisWaveSource.load(
    sha,
    'loop_a.wav',
    async (path) => files.get(path) ?? null,
  );
  const looping = new ArtemisRollingSoundBuffer(sha, paired, 2);
  assert.equal(looping.start(true), true);
  assert.deepEqual(looping.snapshot().slice(0, 4), new Uint8Array([0, 32, 0, 224]));
  assert.deepEqual(looping.tick(0), {
    half: 1,
    bytes: new Uint8Array([0, 224, 0, 224]),
    stopped: false,
  });
  assert.deepEqual(looping.tick(5), {
    half: 0,
    bytes: new Uint8Array([0, 224, 0, 224]),
    stopped: false,
  });
  looping.stop();
  assert.equal(looping.tick(0), null);
  const defaultRing = new ArtemisRollingSoundBuffer(sha, source, 0);
  assert.equal(defaultRing.halfSize, 4000);
  assert.throws(() => new ArtemisRollingSoundBuffer(sha, source, -1), /mode/);
});

test('Device-driven rolling PCM renderer preserves pause, cursor, scheduler refill and native completion', async () => {
  const {ArtemisRollingAudioProcessor} =
    await import('../dist/engines/artemis/rolling-audio-processor.js');
  const {ArtemisWaveSource} = await import('../dist/engines/artemis/wave-source.js');
  const {encodeWav} = await import('../dist/audio/pcm.js');
  const {ARTEMIS_3179_EXECUTABLE_SHA256: sha} = await import('../dist/engines/artemis/revision.js');
  const bytes = encodeWav({
    sampleRate: 1000,
    sampleCount: 1,
    channels: [Float32Array.from([0.25])],
  });
  const source = await ArtemisWaveSource.fromBytes(sha, 'voice.wav', bytes, async () => null),
    events = [];
  const renderer = new ArtemisRollingAudioProcessor(
    {hash: sha, resource: source.snapshot(), bufferMode: 2},
    1000,
    (event) => events.push(event),
  );
  const block = () => [new Float32Array(3), new Float32Array(3)];
  renderer.receive({id: 1, command: {kind: 'start', loop: false}});
  const first = block();
  assert.equal(renderer.render(first), true);
  assert.deepEqual([...first[0]], [0.25, 0, 0]);
  assert.deepEqual(first[1], first[0]);
  renderer.receive({id: 2, command: {kind: 'pause', paused: true}});
  const paused = block();
  renderer.render(paused);
  assert.deepEqual([...paused[0]], [0, 0, 0]);
  assert.equal(events.at(-1).position, 3);
  renderer.receive({id: 3, command: {kind: 'pump'}});
  assert.equal(events.at(-1).finished, true);
  assert.equal(events.at(-1).playing, false);
  renderer.receive({id: 4, command: {kind: 'stop'}});
  assert.equal(events.at(-1).position, 0);
  assert.equal(events.at(-1).finished, false);
  renderer.receive({id: 5, command: {kind: 'start', loop: true}});
  const looped = block();
  renderer.render(looped);
  assert.deepEqual([...looped[0]], [0.25, 0.25, 0.25]);
  renderer.receive({id: 6, command: {kind: 'dispose'}});
  assert.equal(renderer.render(block()), false);
});

test('Progressive Vorbis decodes partial reads to the eager PCM, and its voice refills only decoded halves', async () => {
  const {readFile} = await import('node:fs/promises');
  const {ARTEMIS_3179_EXECUTABLE_SHA256: sha} = await import('../dist/engines/artemis/revision.js');
  const {decodeArtemisVorbisBytes} = await import('../dist/engines/artemis/vorbis-byte-decode.js');
  const {ArtemisVorbisPcmChunks} = await import('../dist/engines/artemis/vorbis-pcm-stream.js');
  const {ArtemisVorbisStream, ArtemisVorbisStreamDecoder} =
    await import('../dist/engines/artemis/vorbis-stream-source.js');
  const {ArtemisRollingAudioProcessor} =
    await import('../dist/engines/artemis/rolling-audio-processor.js');
  const {BlobSource} = await import('../dist/core/source.js');
  const encoded = new Uint8Array(
    await readFile(new URL('./fixtures/audio/vorbis-boundaries.ogg', import.meta.url)),
  );
  const eager = (
    await decodeArtemisVorbisBytes({hash: sha, rounding: 'nearest-even', bytes: encoded})
  ).bytes;
  const join = (parts) => Buffer.concat(parts.map((part) => Buffer.from(part)));

  // Reads of 97 bytes split pages and packets across pushes.
  const outputs = [];
  const chunks = new ArtemisVorbisPcmChunks(
    {hash: sha, rounding: 'nearest-even', firstFrames: 300, chunkFrames: 300},
    (output) => outputs.push(output),
  );
  for (let offset = 0; offset < encoded.length; offset += 97)
    await chunks.push(encoded.slice(offset, offset + 97), offset + 97 >= encoded.length);
  assert.deepEqual(outputs[0], {kind: 'open', sampleRate: 48000, channels: 1});
  assert.equal(outputs.at(-1).kind, 'done');
  // The fixture's audio packets all sit on its EOS page, so the trim applies to one batch.
  const pcm = outputs.filter((output) => output.kind === 'pcm');
  assert.equal(pcm.length, 1);
  assert.deepEqual(join(pcm.map((output) => output.bytes)), Buffer.from(eager));
  const truncated = [];
  const damaged = new ArtemisVorbisPcmChunks(
    {hash: sha, rounding: 'nearest-even', firstFrames: 300, chunkFrames: 300},
    (output) => truncated.push(output),
  );
  await damaged.push(encoded.slice(0, encoded.length - 5), true);
  assert.deepEqual(truncated.at(-1), {
    kind: 'error',
    message: 'Incomplete Ogg page',
    encodedDataError: true,
  });

  // The source settles once the voice's start bytes exist; its follower receives the rest.
  const decoder = new ArtemisVorbisStreamDecoder(sha, 'nearest-even');
  try {
    const stream = await ArtemisVorbisStream.open(
      sha,
      new BlobSource(new Blob([encoded])),
      decoder,
      (format) => format.blockAlign * 100,
    );
    const later = [];
    let resource;
    const ended = new Promise((resolve) => {
      resource = stream.follow((bytes) => (bytes === null ? resolve() : later.push(bytes)));
    });
    assert.equal(resource.complete, false);
    assert.ok(resource.bytes.length >= 200);
    await ended;
    assert.deepEqual(join([resource.bytes, ...later]), Buffer.from(eager));
    assert.equal(stream.decodedBytes, eager.length);
    assert.equal(
      await ArtemisVorbisStream.open(
        sha,
        new BlobSource(new Blob([new Uint8Array(64)])),
        decoder,
        () => 2,
      ),
      null,
    );
  } finally {
    decoder.close();
  }

  // A 2 ms half is 96 frames. Two halves are decoded; the third arrives after it is needed.
  const format = {sampleRate: 48000, channels: 1, bitsPerSample: 16, blockAlign: 2},
    half = 192,
    events = [];
  const renderer = new ArtemisRollingAudioProcessor(
    {
      hash: sha,
      bufferMode: 2,
      resource: {
        kind: 'vorbis',
        format,
        declaredSize: 2 * half,
        bytes: eager.slice(0, 2 * half),
        complete: false,
      },
    },
    48000,
    (event) => events.push(event),
  );
  const view = new DataView(eager.buffer, eager.byteOffset);
  const expected = (from, count) =>
    Array.from({length: count}, (_, i) => view.getInt16((from + i) * 2, true) / 32768);
  const render = (count) => {
    const output = [new Float32Array(count), new Float32Array(count)];
    renderer.render(output);
    return [...output[0]];
  };
  renderer.receive({id: 1, command: {kind: 'start', loop: false}});
  assert.deepEqual(render(100), expected(0, 100));
  // The cursor is in the second half, so native refills the first; nothing is decoded yet.
  renderer.receive({id: 2, command: {kind: 'pump'}});
  assert.equal(events.at(-1).playing, true);
  assert.equal(events.at(-1).finished, false);
  renderer.receive({id: 3, command: {kind: 'append', bytes: eager.slice(2 * half, 3 * half)}});
  renderer.receive({id: 4, command: {kind: 'pump'}});
  assert.deepEqual(render(92), expected(100, 92));
  assert.deepEqual(render(96), expected(192, 96));
});

test('Offline PCM voices render actual cached gain/pan and progressive native completion', async () => {
  const {createArtemisOfflineSoundVoices} =
    await import('../dist/engines/artemis/offline-sound-voices.js');
  const {encodeWav} = await import('../dist/audio/pcm.js');
  const {ARTEMIS_3179_EXECUTABLE_SHA256: sha} = await import('../dist/engines/artemis/revision.js');
  const data = encodeWav({
    sampleRate: 1000,
    sampleCount: 2,
    channels: [Float32Array.from([0.25, 0.5])],
  });
  const owner = createArtemisOfflineSoundVoices(
    sha,
    async (path) => (path === 'voice.wav' ? data : null),
    'nearest-even',
    1000,
  );
  try {
    const cached = await owner.effects.prepareEffect('voice.wav', -1);
    owner.effects.setEffectGain(cached, 0, 500);
    owner.effects.setEffectPan(cached, 500, 0);
    owner.effects.startEffect(cached, 0, false);
    const output = owner.render(2),
      gain = 10 ** (-602 / 2000);
    assert.ok(Math.abs(output[0][0] - 0.25 * gain * gain) < 1e-6);
    assert.ok(Math.abs(output[1][0] - 0.25 * gain) < 1e-6);
    assert.equal(owner.effects.isPlaying(cached), true);
    owner.effects.tick(1);
    assert.equal(owner.effects.isPlaying(cached), false);
    const stream = await owner.effects.prepareEffect('voice.wav', 2);
    owner.effects.startEffect(stream, 0, false);
    const first = owner.render(3);
    assert.deepEqual([...first[0]], [0.25, 0.5, 0]);
    assert.equal(owner.effects.isPlaying(stream), true);
    owner.effects.tick(3);
    owner.render(1);
    owner.effects.tick(4);
    assert.equal(owner.effects.isPlaying(stream), false);
    assert.deepEqual([...owner.render(2)[0]], [0, 0]);
  } finally {
    owner.close();
  }
});

test('Sound-finish registration selects exact native slots and captures independent event commands', async () => {
  const {ArtemisSoundFinish} = await import('../dist/engines/artemis/sound-finish.js');
  const {ARTEMIS_3179_EXECUTABLE_SHA256: sha} = await import('../dist/engines/artemis/revision.js');
  const effects = new Map([
      ['', 11],
      ['se', 12],
    ]),
    handlers = new Map(),
    events = [];
  const controller = new ArtemisSoundFinish(sha, {
    currentFile: () => 'system/first.iet',
    musicIndex: () => 7,
    effectIndex: (id) => effects.get(id),
    setMusicFinish: (index, cb) => handlers.set('m' + index, cb),
    setEffectFinish: (index, cb) => handlers.set('s' + index, cb),
    emit: (tag) => events.push(tag),
  });
  const tag = {
    name: 'setonsoundfinish',
    sourceLine: 9,
    args: new Map([
      ['id', ''],
      ['label', 'done'],
    ]),
  };
  assert.equal(controller.dispatch(tag), true);
  tag.args.set('label', 'mutated');
  handlers.get('s11')();
  assert.equal(events[0].args.get('label'), 'done');
  assert.equal(events[0].args.get('file'), 'system/first.iet');
  events[0].args.set('label', 'event mutation');
  handlers.get('s11')();
  assert.equal(events[1].args.get('label'), 'done');
  controller.dispatch({
    name: 'setonsoundfinish',
    sourceLine: 0,
    args: new Map([
      ['function', 'musicdone'],
      ['handler', 'calllua'],
    ]),
  });
  assert.equal(typeof handlers.get('m7'), 'function');
  controller.dispatch({name: 'delonsoundfinish', sourceLine: 0, args: new Map([['id', '']])});
  assert.equal(handlers.get('s11'), null);
  controller.dispatch({
    name: 'setonsoundfinish',
    sourceLine: 0,
    args: new Map([['id', 'missing']]),
  });
  assert.equal(handlers.size, 2);
});

test('Sound completion callbacks are frame-driven, reusable and never emitted by explicit stop', async () => {
  const {createArtemisOfflineSoundVoices} =
    await import('../dist/engines/artemis/offline-sound-voices.js');
  const {encodeWav} = await import('../dist/audio/pcm.js');
  const {ARTEMIS_3179_EXECUTABLE_SHA256: sha} = await import('../dist/engines/artemis/revision.js');
  const data = encodeWav({sampleRate: 1000, sampleCount: 1, channels: [Float32Array.from([0.25])]});
  const owner = createArtemisOfflineSoundVoices(sha, async () => data, 'nearest-even', 1000),
    finished = [];
  try {
    const index = await owner.effects.prepareEffect('one.wav', -1);
    owner.effects.setFinishCallback(index, () => finished.push(index));
    owner.effects.startEffect(index, 0, false);
    owner.render(1);
    assert.equal(owner.effects.isPlaying(index), true);
    assert.deepEqual(finished, []);
    owner.effects.tick(1);
    assert.equal(owner.effects.isPlaying(index), false);
    assert.deepEqual(finished, [index]);
    owner.effects.tick(2);
    assert.deepEqual(finished, [index]);
    owner.effects.startEffect(index, 0, false);
    assert.deepEqual([...owner.render(1)[0]], [0.25]);
    owner.effects.tick(3);
    assert.deepEqual(finished, [index, index]);
    owner.effects.startEffect(index, 0, false);
    owner.effects.stopEffect(index, 0);
    owner.effects.tick(4);
    assert.deepEqual(finished, [index, index]);
  } finally {
    owner.close();
  }
});

test('Graphics feature publication requires an explicit revision-selected owner value', async () => {
  const {initializeArtemisGraphicsFeatureLevel, ARTEMIS_3179_EXECUTABLE_SHA256: sha} =
    await import('../dist/engines/artemis/revision.js');
  const {ArtemisVariables} = await import('../dist/engines/artemis/variables.js');
  const variables = new ArtemisVariables();
  assert.throws(() => variables.queryLiteral('s.windowsfeaturelevel'), /Unsupported native/);
  initializeArtemisGraphicsFeatureLevel(variables, sha, () => 45056);
  assert.equal(new TextDecoder().decode(variables.read('s.windowsfeaturelevel')), '45056');
  assert.throws(
    () => initializeArtemisGraphicsFeatureLevel(variables, sha, () => NaN),
    /feature level/,
  );
  assert.throws(
    () =>
      initializeArtemisGraphicsFeatureLevel(variables, sha, () => {
        throw Error('no graphics owner');
      }),
    /no graphics owner/,
  );
  assert.throws(
    () => initializeArtemisGraphicsFeatureLevel(variables, '0'.repeat(64), () => 45056),
    /Unsupported Artemis/,
  );
});

test('Named shader loading compiles real resources, retains actor loans and preserves old programs on failure', async () => {
  const {ArtemisShaderLibrary} = await import('../dist/engines/artemis/shader-library.js');
  const {ARTEMIS_3179_EXECUTABLE_SHA256: sha} = await import('../dist/engines/artemis/revision.js');
  const disposed = [],
    reports = [],
    opens = [];
  let sequence = 0;
  const library = new ArtemisShaderLibrary(
    sha,
    async (path) => {
      opens.push(path);
      return path === 'shader' ? new Uint8Array([1]) : null;
    },
    {
      compile: async () => ({shader: {generation: ++sequence}}),
      dispose: (resource) => disposed.push(resource.generation),
    },
    (tag, reason, error) => reports.push({tag, reason, error}),
  );
  const tag = {
    name: 'lyshader',
    sourceLine: 0,
    args: new Map([
      ['id', 'raster'],
      ['file', 'shader\0ignored'],
    ]),
  };
  assert.equal(await library.dispatch(tag), true);
  assert.deepEqual(opens, ['shader']);
  const first = library.bind('raster');
  assert.equal(first.shader.generation, 1);
  await library.dispatch(tag);
  assert.deepEqual(disposed, []);
  const second = library.bind('raster');
  assert.equal(second.shader.generation, 2);
  first.release();
  first.release();
  assert.deepEqual(disposed, [1]);
  await library.dispatch({
    ...tag,
    args: new Map([
      ['id', 'raster'],
      ['file', 'missing'],
    ]),
  });
  assert.equal(reports[0].reason, 'file');
  assert.equal(library.bind('unknown'), null);
  library.close();
  assert.deepEqual(disposed, [1]);
  second.release();
  assert.deepEqual(disposed, [1, 2]);
  await assert.rejects(() => library.dispatch(tag), /closed/);
});

test('Executable raster shader uses native UV1 displacement and alpha without changing RGB', async () => {
  const {artemisRasterCoordinates, artemisRasterShade} =
    await import('../dist/engines/artemis/raster-shader.js');
  const p = {alpha: 0.5, angle: 0, inter: 360, size: 0.125};
  const uv = artemisRasterCoordinates(0.5, 0.25, p);
  assert.ok(Math.abs(uv[0] - 0.625) < 1e-6);
  assert.equal(uv[1], 0.25);
  const seen = [];
  const pixel = artemisRasterShade(
    (u, v) => {
      seen.push([u, v]);
      return [0.2, 0.4, 0.6, 0.8];
    },
    0.5,
    0.25,
    p,
  );
  assert.deepEqual(seen, [uv]);
  assert.deepEqual(pixel.slice(0, 3), [0.2, 0.4, 0.6]);
  assert.ok(Math.abs(pixel[3] - 0.4) < 1e-6);
});

test('Screen shader uses user alpha in screen RGB while retaining foreground alpha semantics', async () => {
  const {artemisScreenShade} = await import('../dist/engines/artemis/screen-shader.js');
  const color = artemisScreenShade(
    () => [0.2, 0.4, 0.6, 0.8],
    () => [0.5, 0.25, 0, 0.5],
    0.5,
    0.25,
    {alpha: 0.5},
  );
  const expected = [0.4, 0.475, 0.6, 0.4];
  color.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-6));
  const neutral = artemisScreenShade(
    () => [0.2, 0.4, 0.6, 0.8],
    () => [1, 1, 1, 0],
    0.5,
    0.25,
    {alpha: 1},
  );
  neutral.forEach((value, index) =>
    assert.ok(Math.abs(value - [0.2, 0.4, 0.6, 0.8][index]) < 1e-6),
  );
});

test('Color presets preserve luminance weights and sepia2 adds only the red channel', async () => {
  const {artemisColorShade} = await import('../dist/engines/artemis/color-shader.js');
  const sample = () => [0.2, 0.4, 0.6, 0.8],
    p = {alpha: 0.5, red: 0.1, green: 0.8, blue: 0.6};
  const gray = artemisColorShade('gray', sample, 0.5, 0.25, {alpha: 0.5});
  assert.ok(Math.abs(gray[0] - (0.2 * 0.298912 + 0.4 * 0.586611 + 0.6 * 0.114478)) < 1e-7);
  assert.equal(gray[0], gray[1]);
  assert.equal(gray[1], gray[2]);
  const sepia = artemisColorShade('sepia', sample, 0.5, 0.25, p),
    added = artemisColorShade('sepia2', sample, 0.5, 0.25, p);
  assert.ok(Math.abs(sepia[0] - gray[0] * 0.1) < 1e-7);
  assert.ok(Math.abs(added[0] - (gray[0] + 0.1)) < 1e-7);
  assert.deepEqual(added.slice(1), sepia.slice(1));
  assert.equal(added[3], Math.fround(0.4));
  assert.throws(() => artemisColorShade('sepia', sample, 0, 0, {alpha: 1}), /uniforms/);
});

test('Blur samples all fifteen taps in native positive-negative order and scales accumulated alpha', async () => {
  const {artemisBlurShade} = await import('../dist/engines/artemis/blur-shader.js');
  for (const kind of ['blur_h', 'blur_v']) {
    const calls = [],
      p = {alpha: 0.5, step: 0.125, weights: [0, 0.25, 0, 0, 0, 0, 0, 0.25]};
    const out = artemisBlurShade(
      kind,
      (u, v) => {
        calls.push([u, v]);
        return [u * u, v * v, 1, 0.8];
      },
      0.5,
      0.5,
      p,
    );
    assert.equal(calls.length, 15);
    assert.deepEqual(calls[1], kind === 'blur_h' ? [0.625, 0.5] : [0.5, 0.625]);
    assert.equal(out[2], 1);
    assert.equal(out[3], Math.fround(0.4));
    assert.ok(out[kind === 'blur_h' ? 0 : 1] > 0.25);
    assert.equal(out[kind === 'blur_h' ? 1 : 0], 0.25);
  }
});

test('RGB preset zeros negative channels, adds nonnegative offsets and nega preserves alpha', async () => {
  const {artemisColorShade} = await import('../dist/engines/artemis/color-shader.js');
  const sample = () => [0.2, 0.4, 0.6, 0.8];
  assert.deepEqual(
    artemisColorShade('rgb', sample, 0, 0, {alpha: 0.5, red: -0.01, green: 0, blue: 0.2}),
    [0, Math.fround(0.4), Math.fround(Math.fround(0.6) + Math.fround(0.2)), Math.fround(0.4)],
  );
  const n = artemisColorShade('nega', sample, 0, 0, {alpha: 0.5});
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(n[i] - (1 - sample()[i])) < 1e-7);
  assert.equal(n[3], Math.fround(0.4));
});

test('Radial center and zero-size conserve color; zero-fade keeps foreground', async () => {
  const {artemisRadialShade} = await import('../dist/engines/artemis/radial-shader.js');
  const p = {alpha: 0.5, ax: 0.5, ay: 0.5, size: 0.5, fade: 1};
  const center = artemisRadialShade((u, v) => [u, v, 1, 1], 0.5, 0.5, p);
  assert.deepEqual(center, [0.5, 0.5, 1, 0.5]);
  const orig = artemisRadialShade((u, v) => [u, v, 1, 1], 0.75, 0.25, {...p, size: 0});
  assert.deepEqual(orig, [0.75, 0.25, 1, 0.5]);
  const untouched = artemisRadialShade((u, v) => [u, v, 1, 1], 0.75, 0.25, {...p, fade: 0});
  assert.deepEqual(untouched, [0.75, 0.25, 1, 0.5]);
  const inward = artemisRadialShade((u, v) => [u, v, 1, 1], 0.75, 0.25, p);
  assert.ok(inward[0] < 0.75 && inward[1] > 0.25);
});

test('Composite presets preserve source alpha, user weighting and singular transparent division', async () => {
  const {artemisCompositeShade} = await import('../dist/engines/artemis/composite-shader.js');
  const a = () => [0.2, 0.4, 0.6, 0.8],
    b = () => [0.5, 0.25, 0, 0.5],
    p = {alpha: 0.5, param: 0.75};
  const out = (k) => artemisCompositeShade(k, a, b, 0, 0, p),
    base = 0.8 * 0.5 + 0.5;
  const close = (x, y) => assert.ok(Math.abs(x - y) < 1e-7, `${x} vs ${y}`);
  close(out('add')[0], 0.2 + 0.5 * 0.5 * 0.75);
  close(out('mul')[0], 0.2 * ((0.2 * 0.8 * 0.5 + 0.5 * 0.5) / base + 0.25));
  close(out('compbr')[0], ((0.2 * 0.8 * 0.5 + 0.5 * 0.5) / base) * 0.75);
  close(out('compdk')[0], ((0.2 * 0.8 * 0.5 + 0.2 * 0.5) / base) * 0.75);
  assert.deepEqual(out('compbr'), out('compbrc'));
  assert.deepEqual(out('compdk'), out('compdkc'));
  for (const k of ['add', 'mul', 'compbr', 'compdk']) close(out(k)[3], 0.4);
  const zero = () => [0, 0, 0, 0];
  assert.ok(Number.isNaN(artemisCompositeShade('mul', zero, zero, 0, 0, p)[0]));
  assert.equal(artemisCompositeShade('add', zero, zero, 0, 0, p)[0], 0);
});
test('Mosaic uses grid counts and floor coordinates without half-cell or source-size adjustment', async () => {
  const {artemisMosaicShade} = await import('../dist/engines/artemis/mosaic-shader.js');
  let uv;
  const pixel = artemisMosaicShade(
    (u, v) => {
      uv = [u, v];
      return [u, v, 0.3, 0.8];
    },
    0.55,
    0.35,
    {alpha: 0.5, size: 4, ratio: 2},
  );
  assert.deepEqual(uv, [0.5, 0.25]);
  assert.equal(pixel[3], Math.fround(0.4));
  artemisMosaicShade(
    (u, v) => {
      assert.ok(Number.isNaN(u) && Number.isNaN(v));
      return [0, 0, 0, 0];
    },
    0.5,
    0.5,
    {alpha: 1, size: 0, ratio: 1},
  );
});
test('Cadd allows negative offsets unlike RGB; Cmul and reset keep their own equations', async () => {
  const {artemisColorShade} = await import('../dist/engines/artemis/color-shader.js');
  const sample = () => [0.2, 0.4, 0.6, 0.8],
    p = {alpha: 0.5, red: -0.1, green: 2, blue: 0};
  const add = artemisColorShade('cadd', sample, 0, 0, p);
  assert.ok(Math.abs(add[0] - 0.1) < 1e-7);
  assert.ok(add[1] > 1);
  const mul = artemisColorShade('cmul', sample, 0, 0, p);
  assert.ok(Math.abs(mul[0] + 0.02) < 1e-7);
  assert.equal(mul[2], 0);
  assert.deepEqual(artemisColorShade('reset', sample, 0, 0, {alpha: 0.5}), [
    0.2,
    0.4,
    0.6,
    Math.fround(0.4),
  ]);
});

test('Shader parameter lists preserve order, duplicate names, empty fields and native numeric prefixes', async () => {
  const {artemisShaderProperties} = await import('../dist/engines/artemis/shader-properties.js');
  const patch = artemisShaderProperties(
    new Map([
      ['shader', 'raster\0suffix'],
      ['shaderconstant', 'size,missing,size, '],
      ['size', '0.125tail,,2e1\0,99'],
      [' ', '-0'],
      ['shadertexture', 'user,missing,user'],
      ['user', ':sys/user.png'],
    ]),
  );
  assert.equal(patch.shader, 'raster\0suffix');
  assert.deepEqual(patch.constants, [
    {name: 'size', values: [0.125, 0, 20]},
    {name: 'size', values: [0.125, 0, 20]},
    {name: ' ', values: [-0]},
  ]);
  assert.deepEqual(patch.textures, [
    {name: 'user', path: ':sys/user.png'},
    {name: 'user', path: ':sys/user.png'},
  ]);
  assert.deepEqual(artemisShaderProperties(new Map([['size', '7']])), {});
});
test('Copied shader state retains texture resources and distinguishes native float equality from texture invalidation', async () => {
  const {ArtemisShaderProperties} = await import('../dist/engines/artemis/shader-properties.js');
  const state = new ArtemisShaderProperties(
      '8953562b80608046662bd8c89015d04236b0ba3afee10c36469c11403de3ebaf',
    ),
    resource = {},
    counts = {refs: 1};
  const make = () => {
    let live = true;
    return {
      resource,
      retain() {
        assert.ok(live);
        counts.refs++;
        return make();
      },
      release() {
        assert.ok(live);
        live = false;
        counts.refs--;
      },
    };
  };
  const source = make();
  state.setShader('raster');
  state.setConstants([{name: 'size', values: [0.1]}]);
  const revision = state.propertyRevision;
  state.setConstants([{name: 'size', values: [Math.fround(0.1)]}]);
  assert.equal(state.propertyRevision, revision);
  state.setTextures([{name: 'user', lease: source}]);
  assert.equal(counts.refs, 2);
  const copy = state.copy();
  assert.equal(counts.refs, 3);
  state.setTextures([{name: 'user', lease: source}]);
  assert.equal(counts.refs, 3);
  assert.equal(state.propertyRevision, copy.propertyRevision + 1);
  state.setConstants([{name: 'size', values: [-0]}]);
  const zeros = state.propertyRevision;
  state.setConstants([{name: 'size', values: [0]}]);
  assert.equal(state.propertyRevision, zeros);
  state.setConstants([{name: 'size', values: [NaN]}]);
  const nan = state.propertyRevision;
  state.setConstants([{name: 'size', values: [NaN]}]);
  assert.equal(state.propertyRevision, nan + 1);
  assert.equal(copy.constantValues()[0].values[0], Math.fround(0.1));
  state.close();
  state.close();
  assert.equal(counts.refs, 2);
  copy.close();
  source.release();
  assert.equal(counts.refs, 0);
  assert.throws(() => state.copy(), /closed/);
});

test('Draw-list shader binding requires explicit constants and packs blur arrays across vector slots', async () => {
  const {createArtemisDrawShaderPreset} = await import('../dist/engines/artemis/draw-shader.js');
  const hash = '8953562b80608046662bd8c89015d04236b0ba3afee10c36469c11403de3ebaf';
  const blur = createArtemisDrawShaderPreset(hash, 'blur_h');
  assert.throws(() => blur.parameters(new Map()), /weights/);
  const p = blur.parameters(
    new Map([
      ['weights', [1, 2, 3, 4, 5, 6, 7, 8]],
      ['width', [0.125]],
    ]),
  );
  assert.deepEqual([...p.slice(0, 9)], [1, 2, 3, 4, 5, 6, 7, 8, 0.125]);
  assert.ok(blur.fragment.includes('parameters[2].x'));
  assert.ok(!blur.fragment.includes('uniform'));
  const screen = createArtemisDrawShaderPreset(hash, 'screen', 1);
  assert.ok(screen.fragment.includes('additionalAtlas1,additionalUV1'));
  assert.ok(screen.needsUserTexture);
  assert.equal(screen.fields.length, 0);
  assert.throws(() => createArtemisDrawShaderPreset(hash, 'unknown'), /Unsupported/);
});

test('Named DX9 effects keep partial array writes and alpha overrides in their own program state', async () => {
  const {
    ArtemisDrawShaderResource,
    createArtemisDrawShaderPreset,
    createArtemisDrawShaderCompiler,
  } = await import('../dist/engines/artemis/draw-shader.js');
  const {ARTEMIS_2898_EXECUTABLE_SHA256: hash, ARTEMIS_3179_EXECUTABLE_SHA256: legacy} =
    await import('../dist/engines/artemis/revision.js');
  const resource = new ArtemisDrawShaderResource(hash, 'blur_v', () => {});
  const p = resource.namedParameters(
    [
      {name: 'height', values: [0.125]},
      {name: 'unknown', values: [100]},
      {name: 'weights', values: [1, 2, 3, 4, 5, 6, 7, 8, 99]},
    ],
    0.75,
  );
  assert.deepEqual([...p.slice(0, 9)], [1, 2, 3, 4, 5, 6, 7, 8, 0.125]);
  assert.equal(p[31], 0.75);
  const reused = resource.namedParameters(
    [
      {name: 'weights', values: [9, 10]},
      {name: 'weights[3]', values: [20, 21]},
      {name: 'alpha', values: [0.5, 99]},
    ],
    0.25,
  );
  assert.deepEqual([...reused.slice(0, 9)], [9, 10, 3, 20, 5, 6, 7, 8, 0.125]);
  assert.equal(reused[31], 0.5);
  const empty = resource.namedParameters(
    [
      {name: 'weights', values: []},
      {name: 'height[0]', values: [999]},
    ],
    1,
  );
  assert.deepEqual([...empty.slice(0, 9)], [9, 10, 3, 20, 5, 6, 7, 8, 0.125]);
  assert.equal(empty[31], 1);
  p.fill(100); // Command snapshots do not mutate effect state.
  assert.equal(resource.namedParameters([], 1)[0], 9);
  const separate = new ArtemisDrawShaderResource(hash, 'blur_v', () => {});
  assert.deepEqual([...separate.namedParameters([], 1).slice(0, 9)], new Array(9).fill(0));
  assert.throws(() => createArtemisDrawShaderPreset(hash, 'noise'), /Unsupported.*DX9/);
  const old = new ArtemisDrawShaderResource(legacy, 'blur_v', () => {});
  assert.throws(() => old.namedParameters([], 1), /owner missing/);
  await assert.rejects(
    createArtemisDrawShaderCompiler(hash, () => {}).compile('bad', new Uint8Array([1])),
    /Unsupported/,
  );
  resource.dispose();
  separate.dispose();
  old.dispose();
  assert.throws(() => resource.namedParameters([], 1), /owner missing/);
});
test('Native shader constant buffer uses list order rather than parameter-name reflection', async () => {
  const {createArtemisDrawShaderPreset} = await import('../dist/engines/artemis/draw-shader.js');
  const hash = '8953562b80608046662bd8c89015d04236b0ba3afee10c36469c11403de3ebaf';
  const raster = createArtemisDrawShaderPreset(hash, 'raster');
  assert.deepEqual(
    [
      ...raster
        .nativeParameters([
          {name: 'irrelevant', values: [90, 0]},
          {name: 'angle', values: [0.125]},
        ])
        .slice(0, 3),
    ],
    [90, 0, 0.125],
  );
  assert.deepEqual(
    [...raster.nativeParameters([{name: 'size', values: [0.125]}]).slice(0, 3)],
    [0.125, 0, 0],
  );
  const blur = createArtemisDrawShaderPreset(hash, 'blur_v');
  assert.deepEqual(
    [
      ...blur
        .nativeParameters([
          {name: 'height', values: [1, 2, 3, 4, 5, 6, 7, 8]},
          {name: 'weights', values: [0.25]},
        ])
        .slice(0, 9),
    ],
    [1, 2, 3, 4, 5, 6, 7, 8, 0.25],
  );
});

test('Native constant storage grows to sixteen-byte capacity and preserves trailing values on reuse', async () => {
  const {ArtemisShaderConstantStorage} =
    await import('../dist/engines/artemis/shader-properties.js');
  const storage = new ArtemisShaderConstantStorage(
    '8953562b80608046662bd8c89015d04236b0ba3afee10c36469c11403de3ebaf',
  );
  assert.equal(storage.update([]), null);
  assert.equal(storage.capacityBytes, 0);
  assert.deepEqual([...storage.update([{name: 'x', values: [1]}])], [1, 0, 0, 0]);
  assert.equal(storage.capacityBytes, 16);
  assert.deepEqual(
    [...storage.update([{name: 'x', values: [2, 3, 4, 5, 6]}])],
    [2, 3, 4, 5, 6, 0, 0, 0],
  );
  assert.equal(storage.capacityBytes, 32);
  const reduced = storage.update([{name: 'ignored', values: [7]}]);
  assert.deepEqual([...reduced], [7, 3, 4, 5, 6, 0, 0, 0]);
  reduced[1] = 999;
  assert.equal(storage.update([{name: 'x', values: [8]}])[1], 3);
  assert.equal(storage.update([]), null);
  assert.equal(storage.capacityBytes, 32);
});

test('Copied native constant storage shares reused coefficients and detaches on capacity growth', async () => {
  const {ArtemisShaderConstantStorage} =
    await import('../dist/engines/artemis/shader-properties.js');
  const {createArtemisDrawShaderPreset} = await import('../dist/engines/artemis/draw-shader.js');
  const hash = '8953562b80608046662bd8c89015d04236b0ba3afee10c36469c11403de3ebaf';
  const old = new ArtemisShaderConstantStorage(hash);
  old.update([{name: 'x', values: [1, 2, 3, 4]}]);
  const copy = old.copy();
  copy.update([{name: 'y', values: [7, 8]}]);
  assert.deepEqual([...old.update([{name: 'x', values: [9]}])], [9, 8, 3, 4]);
  copy.update([{name: 'x', values: [1, 2, 3, 4, 5]}]);
  assert.equal(old.capacityBytes, 16);
  assert.equal(copy.capacityBytes, 32);
  assert.deepEqual([...old.update([{name: 'x', values: [10]}])], [10, 8, 3, 4]);
  const raster = createArtemisDrawShaderPreset(hash, 'raster');
  const short = new ArtemisShaderConstantStorage(hash);
  const buf = short.update([{name: 'ignored', values: [90]}]);
  assert.deepEqual([...raster.bufferParameters(buf).slice(0, 3)], [90, 0, 0]);
  assert.deepEqual([...raster.bufferParameters(null)], new Array(32).fill(0));
});

test('Layer shader properties admit only named coefficient keys and require a real owner before mutation', async () => {
  const {artemisLayerProperties} = await import('../dist/engines/artemis/layer-properties.js');
  const {createArtemisDrawShaderPreset, createArtemisDrawShaderCompiler} =
    await import('../dist/engines/artemis/draw-shader.js');
  const p = artemisLayerProperties(
    new Map([
      ['id', '1'],
      ['shader', 'warp'],
      ['shaderconstant', 'a,b'],
      ['a', '90,0'],
      ['b', '.25'],
    ]),
  );
  assert.deepEqual(p.customShader, {
    shader: 'warp',
    constants: [
      {name: 'a', values: [90, 0]},
      {name: 'b', values: [0.25]},
    ],
  });
  assert.throws(
    () =>
      artemisLayerProperties(
        new Map([
          ['id', '1'],
          ['unlisted', '2'],
        ]),
      ),
    /property unlisted/,
  );
  const hash = '8953562b80608046662bd8c89015d04236b0ba3afee10c36469c11403de3ebaf';
  const nullTexture = createArtemisDrawShaderPreset(hash, 'screen', 0, false);
  assert.equal(nullTexture.needsUserTexture, false);
  assert.ok(nullTexture.fragment.includes('vec4(0.0)'));
  assert.ok(!nullTexture.fragment.includes('texture(additionalAtlas'));
  let prepared = 0;
  const compiler = createArtemisDrawShaderCompiler(hash, () => prepared++);
  await assert.rejects(compiler.compile('bad', new Uint8Array([1])), /Unsupported/);
  assert.equal(prepared, 0);
});
test('Exact revision layer dispatch ignores absent shader properties and preserves texture ownership', async () => {
  const {ArtemisLayers} = await import('../dist/engines/artemis/layers.js');
  const revision = await import('../dist/engines/artemis/revision.js');
  const hashes = [
    revision.ARTEMIS_2601_EXECUTABLE_SHA256,
    revision.ARTEMIS_2762_EXECUTABLE_SHA256,
    revision.ARTEMIS_2868_EXECUTABLE_SHA256,
    revision.ARTEMIS_2898_EXECUTABLE_SHA256,
    revision.ARTEMIS_2908_EXECUTABLE_SHA256,
    revision.ARTEMIS_3083_EXECUTABLE_SHA256,
    revision.ARTEMIS_3083_X64_EXECUTABLE_SHA256,
    revision.ARTEMIS_3179_EXECUTABLE_SHA256,
    revision.ARTEMIS_3139_EXECUTABLE_SHA256,
    revision.ARTEMIS_3139_RESOURCE_VARIANT_SHA256,
    revision.ARTEMIS_3257_EXECUTABLE_SHA256,
    revision.ARTEMIS_3257_WRAPPED_RESOURCE_VARIANT_SHA256,
    revision.ARTEMIS_3257_RESOURCE_VARIANT_SHA256,
    revision.ARTEMIS_3248_EXECUTABLE_SHA256,
  ];
  const tag = (name, args) => ({name, args: new Map(Object.entries(args))});
  for (const hash of hashes) {
    const shaderAbsent = [
      revision.ARTEMIS_2601_EXECUTABLE_SHA256,
      revision.ARTEMIS_2762_EXECUTABLE_SHA256,
    ].includes(hash);
    const absent =
      shaderAbsent ||
      [
        revision.ARTEMIS_2868_EXECUTABLE_SHA256,
        revision.ARTEMIS_2898_EXECUTABLE_SHA256,
        revision.ARTEMIS_2908_EXECUTABLE_SHA256,
      ].includes(hash);
    const reads = [],
      patches = [],
      imagePatches = [];
    let acquired = 0,
      released = 0;
    const host = {
      creationMode: () => 0,
      createImageLayer: () => ({}),
      releaseImageLayer: () => {},
      copyImageLayer: () => ({}),
      applyImageProperties: (_id, _actor, patch) => imagePatches.push(patch),
      recordLayerProperties: () => {},
      layerNotFound: () => assert.fail('missing layer'),
      clearLayerCommands: () => {},
      resetLayerCommands: () => {},
      imageLoadFailed: () => assert.fail('failed image'),
      supportsShaderProperties: () => true,
      createShaderTexture: () => {
        acquired++;
        return {resource: {}, release: () => released++};
      },
      applyShaderProperties: (_actor, patch, textures) => patches.push({patch, textures}),
    };
    const layers = new ArtemisLayers(
      hash,
      {
        load: async (path) => {
          reads.push(path);
          return {path, image: {width: 1, height: 1, pixels: new Uint8Array(4)}, surfaceFormat: 1};
        },
      },
      host,
    );
    await layers.dispatch(tag('lyc', {id: '1', file: 'fore'}));
    layers.commit();
    // The absent property alone has no shader-owner dependency.
    if (absent) host.supportsShaderProperties = () => false;
    await layers.dispatch(tag('lyprop', {id: '1', shadertexture: 'user', user: 'user-image'}));
    assert.deepEqual(reads, absent ? ['fore'] : ['fore', 'user-image']);
    assert.equal(acquired, absent ? 0 : 1);
    assert.equal(released, acquired);
    assert.equal(patches.length, absent ? 0 : 1);
    host.supportsShaderProperties = () => !shaderAbsent;
    await layers.dispatch(
      tag('lyprop', {
        id: '1',
        left: '12',
        shader: 'raster',
        shaderconstant: 'size',
        size: shaderAbsent ? '1e99999' : '.25',
        shadertexture: 'user',
        user: 'user-image',
      }),
    );
    assert.equal(imagePatches.at(-1).left, 12);
    if (shaderAbsent) {
      assert.deepEqual(reads, ['fore']);
      assert.equal(patches.length, 0);
      assert.equal(acquired, 0);
      assert.equal(imagePatches.at(-1).customShader, undefined);
      layers.close();
      continue;
    }
    const last = patches.at(-1).patch;
    assert.equal(last.shader, 'raster');
    assert.deepEqual(last.constants, [{name: 'size', values: [0.25]}]);
    assert.deepEqual(last.textures, absent ? undefined : [{name: 'user', path: 'user-image'}]);
    layers.close();
  }
});
test('Cancelled shader texture loading releases real resources before creating a GPU lease or editing the layer', async () => {
  const {ArtemisLayers} = await import('../dist/engines/artemis/layers.js');
  const hash = '8953562b80608046662bd8c89015d04236b0ba3afee10c36469c11403de3ebaf';
  let resolveTexture,
    resourceReleased = 0,
    actorsReleased = 0,
    shaderApplied = 0,
    properties = 0;
  const host = {
    creationMode: () => 0,
    createImageLayer: () => ({value: 1}),
    releaseImageLayer: () => actorsReleased++,
    copyImageLayer: (old) => ({...old}),
    applyImageProperties: () => properties++,
    recordLayerProperties: () => {},
    layerNotFound: () => assert.fail('layer missing'),
    clearLayerCommands: () => {},
    resetLayerCommands: () => {},
    imageLoadFailed: () => assert.fail('load failed'),
    supportsShaderProperties: () => true,
    createShaderTexture: () => assert.fail('cancelled resource uploaded'),
    applyShaderProperties: () => shaderApplied++,
  };
  const source = {
    load: async (path) =>
      path === 'fore'
        ? {path, image: {width: 1, height: 1, pixels: new Uint8Array(4)}, surfaceFormat: 1}
        : new Promise((resolve) => (resolveTexture = resolve)),
  };
  const layers = new ArtemisLayers(hash, source, host),
    tag = (name, args) => ({name, args: new Map(Object.entries(args))});
  await layers.dispatch(tag('lyc', {id: '1', file: 'fore'}));
  layers.commit();
  const priorProperties = properties;
  const pending = layers.dispatch(
    tag('lyprop', {id: '1', shader: 'screen', shadertexture: 'user', user: 'texture'}),
  );
  layers.cancelPending();
  resolveTexture({
    path: 'texture',
    image: {width: 1, height: 1, pixels: new Uint8Array(4)},
    surfaceFormat: 1,
    lease: {release: () => resourceReleased++},
  });
  await pending;
  assert.equal(resourceReleased, 1);
  assert.equal(shaderApplied, 0);
  assert.equal(properties, priorProperties);
  layers.close();
  assert.equal(actorsReleased, 1);
});

test('Native script event producer preserves deferred copies, force/latch rules and filter/default result semantics', async () => {
  const {ArtemisScriptEvents} = await import('../dist/engines/artemis/script-events.js');
  const hash = '8953562b80608046662bd8c89015d04236b0ba3afee10c36469c11403de3ebaf';
  let mode = 2,
    disabled = false,
    status = 0;
  const latches = [false, false],
    effects = [];
  const host = {
    nativeMode: () => mode,
    disabled: () => disabled,
    latched: (i) => latches[i],
    latch: (i) => (latches[i] = true),
    filter: () => {
      if (status === 'error') throw Error('filter failed');
      return status;
    },
    report: (kind) => effects.push(['error', kind]),
    jump: (file, label) => {
      effects.push(['jump', file, label]);
      return false;
    },
    call: (file, label) => {
      effects.push(['call', file, label]);
      return false;
    },
    enterHandlerScope: () => effects.push(['scope']),
    enqueueHandler: (tag) => effects.push(['handler', tag]),
  };
  const events = new ArtemisScriptEvents(hash, host),
    args = new Map([
      ['handler', 'callback'],
      ['id', '1'],
    ]),
    tag = {kind: 'tag', name: 'setonsoundfinish', sourceLine: -1, args};
  assert.deepEqual(events.emit(tag, 0, false), {status: 'queued'});
  args.set('id', 'changed');
  assert.deepEqual(events.emit(tag, 0, false), {status: 'suppressed'});
  mode = 1;
  assert.deepEqual(events.releasePending(), [false]);
  assert.equal(events.queuedEvents, 0);
  assert.deepEqual(effects[0], ['scope']);
  const queued = effects[1][1];
  assert.equal(queued.name, 'callback');
  assert.equal(queued.sourceLine, 0);
  assert.equal(queued.args.get('id'), '1');
  effects.length = 0;
  status = 1;
  assert.deepEqual(events.emit(tag, 0, true), {status: 'delivered', failed: false});
  assert.equal(effects.length, 0);
  status = 2;
  assert.equal(events.dispatch(tag), true);
  status = -1;
  assert.equal(events.dispatch(tag), false);
  status = 'error';
  assert.equal(
    events.dispatch({
      ...tag,
      args: new Map([
        ['file', ''],
        ['call', '00'],
        ['handler', 'callback'],
      ]),
    }),
    false,
  );
  assert.deepEqual(effects.slice(0, 2), [
    ['error', 'filter'],
    ['call', '', ''],
  ]);
  assert.equal(effects[2][0], 'handler');
  effects.length = 0;
  status = 0;
  events.dispatch({
    ...tag,
    args: new Map([
      ['label', 'last'],
      ['call', '0'],
    ]),
  });
  assert.deepEqual(effects, [['jump', '', 'last']]);
  disabled = true;
  assert.deepEqual(events.emit(tag, 0, true), {status: 'suppressed'});
  assert.equal(events.dispatch({...tag, name: ''}), true);
});
test('Run mode and wait flags belong to each caret across calls, handler scopes and saves', () => {
  const sources = new Map([
    ['main.iet', bytes('[call file="sub.iet"][wait][return]')],
    ['sub.iet', bytes('[wait][return]')],
  ]);
  let flags;
  const lua = new ArtemisLua({readFile: () => null, fileExists: () => true, now: () => 0});
  const script = new ArtemisScript(lua, {
    readFile: (path) => sources.get(path) ?? null,
    pushLocal: () => {},
    popLocal: () => {},
    emptyReturn: () => 'ended',
    dispatch: (tag) => (tag.name === 'wait' ? 'waiting' : assert.fail(tag.name)),
    caretFields: {
      take: () => {
        const taken = flags;
        flags = undefined;
        return taken;
      },
      restore: (restored) => (flags = restored),
    },
  });
  try {
    script.load('main.iet');
    script.enterRunMode(4);
    flags = 'main wait';
    assert.equal(script.step(), 'ready');
    // A call installs a new caret: mode 0 and no wait flags.
    assert.deepEqual([script.currentFile, script.runMode, flags], ['sub.iet', 0, undefined]);
    assert.equal(script.step(), 'waiting');
    script.enterRunMode(1);
    flags = 'sub wait';
    script.enterEventHandlerScope();
    assert.deepEqual([script.runMode, flags], [0, undefined]);
    script.enterRunMode(3);
    const carets = script.carets();
    assert.deepEqual(
      carets.map((c) => [
        c.file,
        c.runMode,
        c.previousRunMode,
        c.fields ?? null,
        c.resumeState ?? null,
      ]),
      [
        ['main.iet', 4, 0, 'main wait', null],
        ['sub.iet', 1, 0, 'sub wait', 'waiting'],
        ['', 3, 0, null, null],
      ],
    );
    // Restored carets keep their modes; the loader clears every wait flag.
    script.restoreCarets(carets);
    assert.deepEqual(
      script.carets().map((c) => [c.runMode, c.fields ?? null]),
      [
        [4, null],
        [1, null],
        [3, null],
      ],
    );
    script.restoreCarets(carets.slice(0, -1).concat({...carets[2], runMode: 0}));
    script.return();
    assert.deepEqual([script.currentFile, script.runMode, script.state], ['sub.iet', 1, 'waiting']);
    script.releaseRunMode();
    assert.equal(script.runMode, 0);
  } finally {
    lua.close();
  }
});
test('Default event handlers use a fresh local scope and filtered priority tag, then restore a waiting script', async () => {
  const {ArtemisScriptEvents} = await import('../dist/engines/artemis/script-events.js');
  const {ArtemisVariables} = await import('../dist/engines/artemis/variables.js');
  const source = bytes('[wait]\n[mark phase=after]\n[wait]\n[mark phase=end]\n[return]'),
    vars = new ArtemisVariables();
  vars.pushLocal();
  vars.write('local', 'outer', true);
  const marks = [];
  let script;
  const lua = new ArtemisLua({
    readFile: (path) => (path === 'main.iet' ? source : null),
    fileExists: () => true,
    now: () => 0,
    readVariable: (name) => vars.read(name),
    writeVariable: (name, value) => vars.write(name, value),
    tag: (tag) => script.executeTag(tag),
  });
  script = new ArtemisScript(lua, {
    readFile: (path) => (path === 'main.iet' ? source : null),
    pushLocal: () => vars.pushLocal(),
    popLocal: () => vars.popLocal(),
    emptyReturn: () => 'ended',
    dispatch: (tag) => {
      if (tag.name === 'wait') return 'waiting';
      if (tag.name === 'mark') {
        marks.push([tag.args.get('phase'), luaText(vars.read('local'))]);
        vars.write('local', 'handler', true);
      } else throw Error(tag.name);
    },
  });
  lua.vm.execute(
    bytes('engine:setTagFilter{callback=function(e,p) e:tag{"mark",phase=p.id}; return 1 end}'),
  );
  script.load('main.iet');
  assert.equal(script.step(), 'waiting');
  const events = new ArtemisScriptEvents(
    '8953562b80608046662bd8c89015d04236b0ba3afee10c36469c11403de3ebaf',
    {
      nativeMode: () => 3,
      disabled: () => false,
      latched: () => false,
      latch: () => {},
      filter: (tag) => lua.filterEvent(tag),
      report: () => assert.fail('event error'),
      jump: (f, l) => {
        script.jump(f, l);
        return false;
      },
      call: (f, l) => {
        script.call(f, l);
        return false;
      },
      enterHandlerScope: () => script.enterEventHandlerScope(),
      enqueueHandler: (tag) => script.enqueue(tag),
    },
  );
  events.emit(
    {
      kind: 'tag',
      name: 'setonsoundfinish',
      sourceLine: -1,
      args: new Map([
        ['handler', 'callback'],
        ['id', 'from-event'],
      ]),
    },
    0,
    true,
  );
  assert.equal(script.currentFile, '');
  assert.equal(script.callDepth, 1);
  // Save sections 3/4: the interrupted caret keeps its resume state and the handler caret
  // its queued handler; restoring them continues identically.
  const carets = script.carets();
  assert.deepEqual(
    carets.map((caret) => [caret.file, caret.resumeState ?? null, caret.queue.map((t) => t.name)]),
    [
      ['main.iet', 'waiting', []],
      ['', null, ['callback']],
    ],
  );
  assert.equal(carets[1].tag, null);
  script.restoreCarets(carets);
  assert.deepEqual(script.carets(), carets);
  assert.equal(script.step(), 'ready');
  assert.deepEqual(marks, [['from-event', '']]);
  assert.equal(script.step(), 'waiting');
  assert.equal(script.currentFile, 'main.iet');
  assert.equal(luaText(vars.read('local')), 'outer');
  assert.equal(script.callDepth, 0);
  script.resume();
  script.step();
  assert.deepEqual(marks.at(-1), ['after', 'outer']);
  assert.equal(script.step(), 'waiting');
  // Sound/music frame ticks dispatch the event before the wait deadline ends the wait in the
  // same frame: the interrupted cursor resumes ready once the handler returns.
  events.emit(
    {
      kind: 'tag',
      name: 'setonsoundfinish',
      sourceLine: -1,
      args: new Map([
        ['handler', 'callback'],
        ['id', 'same-frame'],
      ]),
    },
    0,
    true,
  );
  script.resume();
  assert.equal(script.step(), 'ready');
  assert.deepEqual(marks.at(-1), ['same-frame', '']);
  assert.equal(script.step(), 'ready');
  assert.equal(script.currentFile, 'main.iet');
  script.step();
  assert.deepEqual(marks.at(-1), ['end', 'handler']);
  assert.throws(() => new ArtemisScript(lua, {readFile: () => null}).resume(), /not waiting/);
  lua.close();
});

test('PCM EOF waits for script and frame resource loads before entering its scoped handler', async () => {
  const {openArtemisRuntimeFixture} = await import('./artemis-runtime-fixture.mjs');
  const revisions = await import('../dist/engines/artemis/revision.js');
  const {encodeWav} = await import('../dist/audio/pcm.js');
  const hashes = Object.entries(revisions)
    .filter(([name]) => /^ARTEMIS_.*(?:EXECUTABLE|RESOURCE_VARIANT)_SHA256$/.test(name))
    .map(([, hash]) => hash)
    // E-mote revisions open only with their exact emotedriver.dll.
    .filter((hash) => !revisions.artemisRevision(hash).emote);
  const pcm = encodeWav({sampleRate: 48000, sampleCount: 48, channels: [new Float32Array(48)]});
  const input = {sample: {down: new Set(), wheel: [], pointerInside: true, foreground: true}};
  for (const hash of hashes) {
    for (const phase of ['script', 'frame']) {
      let release,
        requested = 0;
      const resource = new Promise((resolve) => (release = resolve));
      const fixture = await openArtemisRuntimeFixture(
        {
          'one.wav': pcm,
          'system/first.iet': `[seplay id="voice" file="one.wav" buffer="-1"]
            [setonsoundfinish id="voice" handler="calllua" function="finished"]
            ${phase === 'script' ? '[calllua function="loadcache"]' : ''}[stop]
            [lua]
              function finished(e)
                assert(cacheCompleted)
                e:tag{'var', name='f.finished', data='1'}
              end
              function loadcache(e)
                e:setEventHandler{onEnterFrame=''}
                e:restoreFontCache('cache/')
                cacheCompleted = true
              end
              ${phase === 'frame' ? "engine:setEventHandler{onEnterFrame='loadcache'}" : ''}
            [/lua]`,
        },
        {
          hash,
          glyphsOverrides: {
            restoreFontCache: () => (++requested, resource),
          },
        },
      );
      try {
        const {runtime, sound, effects} = fixture;
        await runtime.boot();
        await runtime.settleResource(); // Actual PCM preparation, then registration/load.
        if (phase === 'frame') runtime.frame(1, input);
        assert.equal(requested, 1);
        assert.equal(runtime.resourcePending, true);
        runtime.advanceTo(10); // Resource still pending.
        assert.equal(sound.summary().renderedFrames, 0);
        const settled = runtime.settleResource();
        assert.equal(runtime.resourcePending, false);
        runtime.advanceTo(20); // Promise taken by the owner, still awaiting it.
        assert.equal(sound.summary().renderedFrames, 0);
        assert.equal(runtime.lua.vm.getGlobal('cacheCompleted'), null);
        release();
        await settled;
        assert.equal(runtime.lua.vm.getGlobal('cacheCompleted'), true);
        runtime.frame(30, input);
        runtime.frame(31, input); // Offline rendering exposes EOF to the next manager poll.
        assert.ok(sound.summary().renderedFrames > 0);
        assert.equal(
          luaText(runtime.variables.read('f.finished')),
          '1',
          JSON.stringify({hash, phase, effects, state: runtime.script.state}),
        );
        assert.equal(runtime.script.callDepth, 0);
        assert.equal(runtime.script.state, 'waiting');
        assert.equal(runtime.script.currentFile, 'system/first.iet');
        assert.equal(effects.filter((event) => event.soundFinishCommand).length, 1);
        assert.deepEqual(
          effects.filter((event) => event.eventError || event.enterFrameError),
          [],
        );
      } finally {
        release();
        await fixture.close();
      }
    }
  }
});

test('Actual PCM EOF flows through captured sound-finish event into a filtered scoped script handler', async () => {
  const {createArtemisOfflineSoundVoices} =
    await import('../dist/engines/artemis/offline-sound-voices.js');
  const {ArtemisSoundFinish} = await import('../dist/engines/artemis/sound-finish.js');
  const {createArtemisScriptEvents} = await import('../dist/engines/artemis/script-events.js');
  const {ArtemisVariables} = await import('../dist/engines/artemis/variables.js');
  const {encodeWav} = await import('../dist/audio/pcm.js');
  const hash = '8953562b80608046662bd8c89015d04236b0ba3afee10c36469c11403de3ebaf';
  const data = encodeWav({sampleRate: 1000, sampleCount: 1, channels: [Float32Array.from([0.25])]});
  const owner = createArtemisOfflineSoundVoices(hash, async () => data, 'nearest-even', 1000),
    vars = new ArtemisVariables(),
    seen = [];
  const source = bytes('[wait]');
  let script;
  const lua = new ArtemisLua({
    readFile: () => source,
    fileExists: () => true,
    now: () => 0,
    tag: (tag) => script.executeTag(tag),
    enqueueTag: () => assert.fail('unexpected direct queue'),
    variable: () => '',
  });
  script = new ArtemisScript(lua, {
    readFile: () => source,
    pushLocal: () => vars.pushLocal(),
    popLocal: () => vars.popLocal(),
    dispatch: (tag) => {
      if (tag.name === 'wait') return 'waiting';
      if (tag.name === 'observed') seen.push(tag.args.get('id'));
      else assert.fail(tag.name);
    },
  });
  lua.vm.execute(
    bytes('engine:setTagFilter{finished=function(e,p) e:tag{"observed",id=p.id}; return 1 end}'),
  );
  const events = createArtemisScriptEvents(hash, lua, script, {
    nativeMode: () => 3,
    disabled: () => false,
    latched: () => false,
    latch: () => {},
    report: () => assert.fail('event dispatch failed'),
  });
  try {
    script.load('main.iet');
    script.step();
    const index = await owner.effects.prepareEffect('one.wav', -1);
    const finish = new ArtemisSoundFinish(hash, {
      currentFile: () => script.currentFile,
      musicIndex: () => index,
      effectIndex: (id) => (id === 'voice' ? index : undefined),
      setMusicFinish: (i, cb) => owner.effects.setFinishCallback(i, cb),
      setEffectFinish: (i, cb) => owner.effects.setFinishCallback(i, cb),
      emit: (tag) => events.emit(tag, 0, true),
    });
    finish.dispatch({
      kind: 'tag',
      name: 'setonsoundfinish',
      sourceLine: -1,
      args: new Map([
        ['id', 'voice'],
        ['handler', 'finished'],
      ]),
    });
    owner.effects.startEffect(index, 0, false);
    assert.deepEqual([...owner.render(1)[0]], [0.25]);
    assert.deepEqual(seen, []);
    owner.effects.tick(1);
    assert.equal(script.queuedTags, 1);
    assert.equal(script.callDepth, 1);
    script.step();
    assert.deepEqual(seen, ['voice']);
    script.step();
    assert.equal(script.state, 'waiting');
    assert.equal(script.currentFile, 'main.iet');
    assert.equal(script.callDepth, 0);
  } finally {
    owner.close();
    lua.close();
  }
});

test('Native Lua includes load plain text first and retry the normal file owner after load or pcall failure', () => {
  const plain = new Map([
      ['empty.lua', bytes('')],
      ['script.lua', bytes('#!/lua\r\nvalue=[[a\r\nb]]\x1athis is not Lua')],
      ['syntax.lua', bytes('not valid Lua!')],
      ['runtime.lua', bytes('partial=(partial or 0)+1; error("first error")')],
      ['twice.lua', bytes('attempts=(attempts or 0)+1; error("retry error")')],
    ]),
    packed = new Map([
      ['empty.lua', bytes('error("must not fallback")')],
      ['syntax.lua', bytes('value=17')],
      ['runtime.lua', bytes('assert(partial==1); value=18')],
      ['twice.lua', plain.get('twice.lua')],
      ['archive.lua', bytes('value=19')],
    ]),
    reads = [];
  const lua = new ArtemisLua({
    readPlainFile: (path) => {
      reads.push(['plain', path]);
      if (path === 'open-error.lua') throw Error('plain open failed');
      return plain.get(path) ?? null;
    },
    readFile: (path) => {
      reads.push(['packed', path]);
      return path === 'open-error.lua' ? bytes('value=20') : (packed.get(path) ?? null);
    },
    fileExists: () => false,
    now: () => 0,
    tag: () => {},
    enqueueTag: () => {},
    variable: () => '',
  });
  try {
    lua.vm.execute(bytes('engine:include("empty.lua"); engine:include("script.lua")'));
    assert.deepEqual(reads, [
      ['plain', 'empty.lua'],
      ['plain', 'script.lua'],
    ]);
    assert.equal(luaText(lua.vm.getGlobal('value')), 'a\nb');
    for (const [path, value] of [
      ['syntax.lua', 17],
      ['runtime.lua', 18],
      ['archive.lua', 19],
      ['open-error.lua', 20],
    ]) {
      lua.include(path);
      assert.equal(lua.vm.getGlobal('value'), value);
    }
    assert.throws(() => lua.include('twice.lua'), /retry error/);
    assert.equal(lua.vm.getGlobal('attempts'), 2); // CPack remains loose-first.
    assert.throws(() => lua.include('missing.lua'), /Missing Artemis Lua include/);
    lua.vm.execute(bytes('assert(partial==1); recovered=true'));
    assert.equal(lua.vm.getGlobal('recovered'), true);
  } finally {
    lua.close();
  }
});

test('Native include reporting returns to Lua after the final failure and preserves VM fatal guards', () => {
  const reports = [];
  const host = {
    readFile: (path) =>
      path === 'broken.lua'
        ? bytes('partial=9; error("script failed")')
        : path === 'loop.lua'
          ? bytes('while true do end')
          : null,
    readPlainFile: () => null,
    reportIncludeError: (path, error) => reports.push([path, error.message]),
    fileExists: () => false,
    now: () => 0,
    tag: () => {},
    enqueueTag: () => {},
    variable: () => '',
  };
  const lua = new ArtemisLua(host);
  try {
    lua.vm.execute(
      bytes(
        'engine:include("broken.lua"); assert(partial==9); continued=1; engine:include("missing.lua"); continued=2',
      ),
    );
    assert.equal(lua.vm.getGlobal('continued'), 2);
    assert.equal(reports.length, 2);
    assert.match(reports[0][1], /\[string "broken.lua"\]:1: script failed/);
    assert.match(reports[1][1], /Missing Artemis Lua include/);
    host.reportIncludeError = () => {
      throw Error('required error owner refused');
    };
    assert.throws(() => lua.include('missing.lua'), /owner refused/);
  } finally {
    lua.close();
  }
  const guarded = new ArtemisLua(
    {...host, reportIncludeError: () => assert.fail('fatal VM cannot recover')},
    1000,
  );
  try {
    assert.throws(() => guarded.include('loop.lua'), /instruction budget/);
    assert.equal(guarded.vm.usable, false);
  } finally {
    guarded.close();
  }
});

test('Native calllua reports Lua and lookup failures at severity 1, then continues the script', () => {
  const source = bytes(`[lua]
    function broken(e) partial=1; authentication(); unreachable=1 end
    function outer(e) e:tag{'calllua',['function']='missing.deep'}; e:tag{'calllua',['function']='broken'}; outer_done=1 end
    function valueError(e) error({}) end
    function embedded(e) error('first\\0second', 0) end
    notcallable={}
    [/lua][calllua function="broken"][calllua function="missing"][calllua function="notcallable"][calllua function="outer"][calllua function="embedded"][after][calllua function="valueError"][stop]`);
  const run = (reporting) => {
    let script;
    const reports = [],
      dispatched = [];
    const lua = new ArtemisLua({
      readFile: () => source,
      fileExists: () => true,
      now: () => 0,
      variable: () => '',
      tag: (tag) => script.executeTag(tag),
      enqueueTag: () => {},
    });
    script = new ArtemisScript(lua, {
      readFile: () => source,
      dispatch: (tag) => {
        if (tag.name === 'unsupported') throw new Error('Unsupported native Artemis tag');
        dispatched.push(tag.name);
        if (tag.name === 'stop') return 'stopped';
      },
      ...(reporting
        ? {
            reportLuaCallError: (report) =>
              reports.push({
                file: report.file,
                function: report.tag.args.get('function'),
                line: report.tag.sourceLine,
                message: luaText(report.message),
                severity: report.severity,
              }),
          }
        : {}),
    });
    script.load('boot');
    return {script, lua, reports, dispatched};
  };
  const strict = run(false);
  try {
    assert.throws(() => strict.script.run(), /authentication/);
    assert.equal(strict.script.state, 'faulted');
  } finally {
    strict.lua.close();
  }
  const reported = run(true);
  try {
    assert.throws(() => reported.script.run(), /Lua error 2/);
    assert.equal(reported.script.state, 'faulted');
    const notFound = '指定されたfunctionが見つかりません';
    assert.deepEqual(
      reported.reports.map(({function: name, message, severity}) => [name, message, severity]),
      [
        ['broken', reported.reports[0].message, 1],
        ['missing', notFound, 1],
        ['notcallable', notFound, 1],
        ['missing.deep', notFound, 1],
        ['broken', reported.reports[0].message, 1],
        ['embedded', 'first', 1],
      ],
    );
    assert.match(reported.reports[0].message, /attempt to call global 'authentication'/);
    assert.equal(reported.reports[0].file, 'boot');
    assert.equal(reported.reports[3].line, -1);
    assert.equal(reported.lua.vm.getGlobal('partial'), 1);
    assert.equal(reported.lua.vm.getGlobal('unreachable'), null);
    assert.equal(reported.lua.vm.getGlobal('outer_done'), 1);
    assert.deepEqual(reported.dispatched, ['after']);
  } finally {
    reported.lua.close();
  }
  const refusalSource = bytes(
    `[lua]function refused(e) e:tag{'unsupported'} end[/lua][calllua function="refused"][stop]`,
  );
  let script;
  const reports = [];
  const lua = new ArtemisLua({
    readFile: () => refusalSource,
    fileExists: () => true,
    now: () => 0,
    variable: () => '',
    tag: (tag) => script.executeTag(tag),
    enqueueTag: () => {},
  });
  script = new ArtemisScript(lua, {
    readFile: () => refusalSource,
    dispatch: (tag) => {
      if (tag.name === 'unsupported') throw new Error('Unsupported native Artemis tag');
    },
    reportLuaCallError: (report) => reports.push(report),
  });
  try {
    script.load('boot');
    assert.throws(() => script.run(), /Unsupported native Artemis tag/);
    assert.equal(script.state, 'faulted');
    assert.equal(reports.length, 0);
  } finally {
    lua.close();
  }
});

test('Names outside the native command map report the unknown-tag error and continue', () => {
  const source = bytes(`[achievements name="a"][caption data="c"][stop]`);
  const run = (host) => {
    let script;
    const dispatched = [];
    const lua = new ArtemisLua({
      readFile: () => source,
      fileExists: () => true,
      now: () => 0,
      variable: () => '',
      tag: (tag) => script.executeTag(tag),
      enqueueTag: () => {},
    });
    script = new ArtemisScript(lua, {
      readFile: () => source,
      dispatch: (tag) => {
        dispatched.push(tag.name);
        if (tag.name === 'stop') return 'stopped';
      },
      ...host,
    });
    try {
      script.load('boot');
      script.run();
      return {dispatched, state: script.state};
    } finally {
      lua.close();
    }
  };
  const reports = [];
  assert.deepEqual(run({reportUnknownTag: (report) => reports.push(report)}), {
    dispatched: ['caption', 'stop'],
    state: 'stopped',
  });
  assert.equal(reports.length, 1);
  assert.equal(reports[0].tag.name, 'achievements');
  assert.equal(reports[0].severity, 1);
  assert.equal(
    new TextDecoder('shift_jis').decode(reports[0].message),
    '未知のタグ、または未定義のマクロです。',
  );
  // Without a report owner the host receives the name and decides.
  assert.deepEqual(run({}).dispatched, ['achievements', 'caption', 'stop']);
});

test('A Lua tag named only by a tags handler bypasses the filter and reports the unknown-tag error', () => {
  // 0x1400c5710 consults the filter only for script lines (line > -1); e:tag carries -1.
  const source = bytes(
    `[lua]\ntags={}; engine:setTagFilter(tags); handled=0\nfunction tags.custom(e,p) handled=handled+1; return 1 end\nfunction tags.relay(e,p) e:tag{'custom'}; return 1 end\n[/lua]\n[custom][relay][stop]`,
  );
  let script;
  const dispatched = [],
    reports = [];
  const lua = new ArtemisLua({
    readFile: () => source,
    fileExists: () => true,
    now: () => 0,
    variable: () => '',
    tag: (tag) => script.executeTag(tag),
    enqueueTag: () => {},
  });
  try {
    script = new ArtemisScript(lua, {
      readFile: () => source,
      dispatch: (tag) => {
        if (lua.filterTag(tag)) return;
        dispatched.push(tag.name);
        if (tag.name === 'stop') return 'stopped';
      },
      reportUnknownTag: (report) => reports.push(report),
    });
    script.load('boot');
    assert.equal(script.run(), 'stopped');
    assert.equal(lua.vm.getGlobal('handled'), 1);
    assert.deepEqual(dispatched, ['stop']);
    assert.deepEqual(
      reports.map((r) => [r.tag.name, r.tag.sourceLine, r.severity]),
      [['custom', -1, 1]],
    );
  } finally {
    lua.close();
  }
});

test('Suspended calllua failures close their coroutine, report once and resume the caller', () => {
  const source = bytes(`[lua]
    function child(e) e:tag{'asset'}; child_after=1; authentication() end
    function parent(e) e:tag{'calllua',['function']='child'}; parent_done=1 end
    function failing(e) e:tag{'asset'} end
    function failingParent(e) e:tag{'calllua',['function']='failing'}; should_not_run=1 end
  [/lua][calllua function="parent"][calllua function="child"][after][stop]
  *resource
  [calllua function="failingParent"][stop]`);
  let script;
  const reports = [],
    dispatched = [];
  const lua = new ArtemisLua({
    readFile: () => source,
    fileExists: () => true,
    now: () => 0,
    variable: () => '',
    suspendableTags: true,
    tag: (tag) => script.executeTag(tag),
    enqueueTag: () => {},
  });
  script = new ArtemisScript(lua, {
    readFile: () => source,
    dispatch: (tag) => {
      if (tag.name === 'asset') return 'suspended';
      dispatched.push(tag.name);
      if (tag.name === 'stop') return 'stopped';
    },
    reportLuaCallError: (report) =>
      reports.push([report.tag.args.get('function'), luaText(report.message)]),
  });
  try {
    script.load('boot');
    assert.equal(script.run(), 'waiting');
    assert.equal(script.pendingLuaCalls, 2);
    assert.equal(script.resumeLua(), 'ready');
    assert.equal(script.pendingLuaCalls, 0);
    assert.equal(lua.vm.getGlobal('child_after'), 1);
    assert.equal(lua.vm.getGlobal('parent_done'), 1);
    assert.equal(script.run(), 'waiting');
    assert.equal(script.pendingLuaCalls, 1);
    assert.equal(script.resumeLua(), 'ready');
    assert.equal(script.run(), 'stopped');
    assert.deepEqual(dispatched, ['after', 'stop']);
    assert.deepEqual(
      reports.map(([name]) => name),
      ['child', 'child'],
    );
    assert.match(reports[0][1], /attempt to call global 'authentication'/);
    // Resource failures are host refusals and remain strict through every caller.
    script.load('boot', 'resource');
    assert.equal(script.run(), 'waiting');
    assert.equal(script.pendingLuaCalls, 2);
    assert.throws(() => script.resumeLua([false, bytes('asset failed')]), /asset failed/);
    assert.equal(script.state, 'faulted');
    assert.equal(script.pendingLuaCalls, 0);
    assert.equal(lua.vm.getGlobal('should_not_run'), null);
    assert.equal(reports.length, 2);
  } finally {
    script.cancelLuaCalls();
    lua.close();
  }
});

test('Native stop shows the wait indicator, enters run mode 3 with the save gate and stops automode', async () => {
  const {ArtemisStop} = await import('../dist/engines/artemis/stop.js');
  const {ArtemisModes} = await import('../dist/engines/artemis/modes.js');
  const log = [];
  const modes = new ArtemisModes({
    writeStatus: (name, value) => log.push(name + '=' + value),
    automodeChanged: () => {},
    commandSkipChanged: () => {},
    controlSkipChanged: () => {},
    releaseScheduler: () => {},
    currentMessageLayer: () => 'mw',
  });
  let entered = true;
  const stop = new ArtemisStop(
    modes,
    {request: (file, transient, force) => (log.push(['save', file, transient, force]), true)},
    {
      debugSkipActive: () => false,
      startTextDisplay: (skip) => log.push(skip ? 'skipIndicator' : 'messageIndicator'),
      enterStopMode: () => (log.push('mode3'), entered),
    },
  );
  assert.equal(stop.dispatch({name: 'wait', args: new Map()}), false);
  modes.autosave = 2;
  modes.setAutomode(true, true);
  log.length = 0;
  assert.equal(stop.dispatch({name: 'stop', args: new Map()}), true);
  assert.deepEqual(log.splice(0), [
    'messageIndicator',
    'mode3',
    ['save', 'autosave.dat', undefined, undefined],
    's.status.automode=0',
  ]);
  modes.setCommandSkip(true);
  log.length = 0;
  stop.dispatch({name: 'stop', args: new Map()});
  assert.deepEqual(log, ['skipIndicator', 'mode3']);
  modes.setCommandSkip(false);
  entered = false;
  log.length = 0;
  stop.dispatch({name: 'stop', args: new Map()});
  assert.deepEqual(log, ['messageIndicator', 'mode3']);
});

test('Native push handlers deliver slot 0 then slot 1 in key order until a command is delivered', async () => {
  const {ArtemisKeyBindings} = await import('../dist/engines/artemis/key-bindings.js');
  const bindings = new ArtemisKeyBindings(() => 'f.iet');
  const tag = (key, extra = {}) => ({
    name: 'setonpush',
    args: new Map(Object.entries({key, handler: 'calllua', ...extra})),
  });
  bindings.dispatch(tag('13'));
  bindings.dispatch(tag('1'));
  bindings.dispatch(tag('2', {keyrepeat: '1'}));
  const seen = [];
  const all = () => true;
  assert.equal(
    bindings.deliverPushed(all, (command) => (seen.push(command.args.get('key')), true)),
    false,
  );
  assert.deepEqual(seen, ['1', '13', '2']);
  seen.length = 0;
  assert.equal(
    bindings.deliverPushed(all, (command) => (seen.push(command.args.get('key')), false)),
    true,
  );
  assert.deepEqual(seen, ['1']);
  seen.length = 0;
  bindings.deliverPushed(
    (key, slot) => slot === 1 && key === 2,
    (command) => (seen.push(command.args.get('key')), false),
  );
  assert.deepEqual(seen, ['2']);
});

test('Scenario load replays the save-object histories in native loader order', async () => {
  const {ArtemisSaveData, replayArtemisScenario} =
    await import('../dist/engines/artemis/save-data.js');
  const {ArtemisLayerCommands} = await import('../dist/engines/artemis/layer-commands.js');
  const {ARTEMIS_3179_EXECUTABLE_SHA256} = await import('../dist/engines/artemis/revision.js');
  const block = (name, args = {}) => ({
    kind: 'tag',
    name,
    sourceLine: 1,
    args: new Map(Object.entries(args)),
  });
  const data = new ArtemisSaveData();
  // Layer "b" is cleared: its indent is promoted to the retained slot and its text restarts.
  data.recordText('b', block('print', {data: 'old'}));
  data.rememberText('b', 'indent', block('indent', {pair: '「」'}));
  data.clearText('b');
  data.saveFonts('b', [{size: 20}, {size: 24}]);
  data.promoteText('b');
  data.rememberText('b', 'prohibit', block('prohibit', {head: '、'}));
  data.recordText('b', block('sceout'));
  data.recordText('b', block('print', {data: 'B'}));
  // "a" sorts first (std::map byte order); its scein cancels nothing seen before it.
  data.recordText('a', block('print', {data: 'A'}));
  data.recordText('a', block('scein'));
  data.saveFonts('a', []);
  data.replaceEffect('rain', block('seplay', {id: 'rain', loop: '1'}));
  data.replaceEffect('door', null);
  const commands = new ArtemisLayerCommands(ARTEMIS_3179_EXECUTABLE_SHA256);
  commands.append('1', block('lyprop', {id: '1', alpha: '0'}));
  commands.append('1', block('lyc', {id: '1', file: 'x'}));
  commands.append('0', block('anime', {id: '0'}));

  const calls = [];
  let current = 'msg';
  const snapshot = data.snapshot();
  assert.deepEqual([...snapshot.text.keys()], ['a', 'b']);
  assert.deepEqual([...snapshot.retainedIndent.keys()], ['b']);
  assert.deepEqual([...snapshot.pendingProhibit.keys()], ['b']);
  assert.equal(snapshot.retainedProhibit.size, 0);
  await replayArtemisScenario(
    snapshot,
    ['backlog'],
    commands.snapshot(),
    {playing: true, tag: block('splay', {file: 'bgm'})},
    {
      selectMessageLayer: (name, mode) => calls.push(`select ${name} ${mode}`),
      currentMessageLayer: () => current,
      setCurrentMessageLayer: (name) => (current = name),
      replaceFontFrames: (fonts) => calls.push(`fonts ${[...fonts.keys()]}`),
      applyFontFrame: (name, frame) => calls.push(`font ${name} ${frame.size}`),
      dispatch: (tag) => calls.push(`${tag.name} ${[...tag.args.values()].join(',')}`),
      applySceneTween: (out) => calls.push(`tween ${current} ${out ? 'out' : 'in'}`),
      writeCurrentMessageLayerVariable: (name) => calls.push(`variable ${name}`),
    },
  );
  assert.deepEqual(calls, [
    'select backlog 1',
    'fonts a,b',
    'select b 0',
    'font b 24',
    'select b 0',
    'indent 「」',
    'select a 0',
    'print A',
    'tween a in',
    'select b 0',
    'print B',
    'tween b out',
    'select msg 0',
    'variable msg',
    'anime 0',
    'lyc 1,x',
    'lyprop 1,0',
    'splay bgm',
    'seplay rain,1',
  ]);
  assert.equal(current, 'msg');
  const restored = new ArtemisSaveData();
  restored.restore(snapshot);
  assert.deepEqual(restored.snapshot(), snapshot);
  data.clear();
  assert.equal(data.hasEffect('rain'), false);
  assert.equal(data.textCommands('b'), undefined);
});

test('Scenario save object sections round-trip in the native archive layout', async () => {
  const {ArtemisSaveArchiveReader, ArtemisSaveArchiveWriter} =
    await import('../dist/formats/artemis/save-file.js');
  const {writeArtemisScriptBlock, writeArtemisSaveObject, readArtemisSaveObject} =
    await import('../dist/engines/artemis/scenario-save.js');
  const block = (name, args = {}, line = 1) => ({
    kind: 'tag',
    name,
    sourceLine: line,
    args: new Map(Object.entries(args)),
  });
  // CScriptBlock: section 2 line, 3 name, 4 count then key/value strings.
  const single = new ArtemisSaveArchiveWriter();
  single.section(0, true);
  writeArtemisScriptBlock(single, block('ab', {k: 'v'}, 7));
  single.close();
  const bytes = single.finish();
  const words = new DataView(bytes.buffer, bytes.byteOffset);
  assert.deepEqual(
    [...bytes.subarray(0, 24)],
    [7, 0, 0, 0, 2, 0, 0, 0, 0x61, 0x62, 1, 0, 0, 0, 1, 0, 0, 0, 0x6b, 1, 0, 0, 0, 0x76],
  );
  // Table: the object scope (start 0, sections 2→0, 3→4, 4→10), then the empty root.
  const table = [];
  for (let offset = 24; offset < bytes.length; offset += 4)
    table.push(words.getUint32(offset, true));
  assert.deepEqual(table, [2, 0, 3, 2, 0, 3, 4, 4, 10, 0, 0, 24]);

  const {artemisDefaultFontAttributes, writeArtemisFontFrame, readArtemisFontFrame} =
    await import('../dist/engines/artemis/font-state.js');
  const {ARTEMIS_3179_EXECUTABLE_SHA256: hash} =
    await import('../dist/engines/artemis/revision.js');
  const codec = {
    write: writeArtemisFontFrame,
    read: (archive) => readArtemisFontFrame(hash, archive),
  };
  const base = artemisDefaultFontAttributes(hash);
  // Defaults include the Shift-JIS face bytes, which are kept as bytes.
  const frame = (patch, overflow) => ({font: {...base, ...patch}, overflow});
  const state = {
    data: {
      text: new Map([['msg', [block('print', {data: 'x'}), block('sceout')]]]),
      fonts: new Map([
        [
          'msg',
          [
            frame({}, 0),
            frame(
              {
                face: 'Noto',
                size: 30,
                layermode: 'screen',
                align: 'right',
                alpha: 0.5,
                hung: false,
                color: 0xff112233,
              },
              -1,
            ),
          ],
        ],
        ['sub', []],
      ]),
      retainedIndent: new Map([['msg', block('indent', {pair: '「」'})]]),
      pendingIndent: new Map(),
      retainedProhibit: new Map(),
      pendingProhibit: new Map([['msg', block('prohibit', {head: '、'})]]),
      effects: new Map([
        ['door', null],
        ['rain', block('seplay', {id: 'rain', loop: '1'})],
      ]),
    },
    layerCommands: new Map([
      ['1', [block('lyc', {id: '1', file: 'x'}), block('lyprop', {id: '1'})]],
    ]),
    music: {playing: true, tag: block('splay', {file: 'bgm', loop: '1'}, 9)},
  };
  const writer = new ArtemisSaveArchiveWriter();
  writeArtemisSaveObject(writer, state, codec);
  const read = readArtemisSaveObject(new ArtemisSaveArchiveReader(writer.finish()), codec);
  assert.deepEqual(read, state);
  // A missing BGM block and absent sections keep the reset values.
  const quiet = new ArtemisSaveArchiveWriter();
  writeArtemisSaveObject(quiet, {...state, music: {playing: false, tag: block('')}}, codec);
  assert.equal(
    readArtemisSaveObject(new ArtemisSaveArchiveReader(quiet.finish()), codec).music.playing,
    false,
  );
  const empty = new ArtemisSaveArchiveWriter();
  empty.section(9);
  const none = readArtemisSaveObject(new ArtemisSaveArchiveReader(empty.finish()), codec);
  assert.equal(none.data.text.size + none.layerCommands.size + none.data.effects.size, 0);
});

test('Scenario variables section keeps scenario names and local frames, not g./s./t.', async () => {
  const {ArtemisSaveArchiveReader, ArtemisSaveArchiveWriter} =
    await import('../dist/formats/artemis/save-file.js');
  const {writeArtemisScenarioVariables, readArtemisScenarioVariables} =
    await import('../dist/engines/artemis/scenario-save.js');
  const {ArtemisVariables} = await import('../dist/engines/artemis/variables.js');
  const text = (value) => new TextDecoder().decode(value);
  const source = new ArtemisVariables();
  for (const [name, value] of [
    ['f.flag', '1'],
    ['g.done', '1'],
    ['s.vol', '5'],
    ['t.tmp', 'x'],
  ])
    source.write(name, value);
  source.pushLocal();
  source.write('arg', 'local', true);
  const writer = new ArtemisSaveArchiveWriter();
  writer.section(1);
  writer.u8(0);
  writeArtemisScenarioVariables(writer, source);
  const bytes = writer.finish();

  const target = new ArtemisVariables();
  for (const [name, value] of [
    ['f.flag', '0'],
    ['f.other', '9'],
    ['g.done', '0'],
    ['t.tmp', 'y'],
  ])
    target.write(name, value);
  target.clearGlobalDirty();
  readArtemisScenarioVariables(new ArtemisSaveArchiveReader(bytes), target);
  assert.equal(text(target.read('f.flag')), '1');
  assert.equal(target.lookup('f.other'), undefined);
  // The reset tail keeps g./s.; t. names are neither saved nor kept.
  assert.equal(text(target.read('g.done')), '0');
  assert.equal(target.lookup('t.tmp'), undefined);
  assert.equal(target.globalDirty, false);
  assert.equal(text(target.lookup('arg')), 'local');
  target.popLocal();
  assert.equal(target.lookup('arg'), undefined);
  assert.throws(() => target.popLocal(), /underflow/);
});

test('Scenario archive script fields round-trip in native writer order', async () => {
  const {ArtemisSaveArchiveReader, ArtemisSaveArchiveWriter} =
    await import('../dist/formats/artemis/save-file.js');
  const {
    writeArtemisCaret,
    readArtemisCaret,
    writeArtemisScenarioArchive,
    readArtemisScenarioArchive,
  } = await import('../dist/engines/artemis/scenario-archive.js');
  const {ArtemisVariables} = await import('../dist/engines/artemis/variables.js');
  const {artemisDefaultFontAttributes, writeArtemisFontFrame, readArtemisFontFrame} =
    await import('../dist/engines/artemis/font-state.js');
  const {ARTEMIS_3179_EXECUTABLE_SHA256: hash} =
    await import('../dist/engines/artemis/revision.js');
  const fonts = {
    write: writeArtemisFontFrame,
    read: (archive) => readArtemisFontFrame(hash, archive),
  };
  const block = (name, args = {}, line = 1) => ({
    kind: 'tag',
    name,
    sourceLine: line,
    args: new Map(Object.entries(args)),
  });
  const empty = block('', {}, 0);
  const caret = (patch = {}) => ({
    file: 'a',
    index: 5,
    runMode: 6,
    previousRunMode: 2,
    waiting: false,
    queue: [],
    tag: empty,
    ...patch,
  });
  // CCaret: run mode 6 (>= 5) saves the previous mode in section 1; a wait saves 0, mode.
  const caretBytes = (value) => {
    const writer = new ArtemisSaveArchiveWriter();
    writeArtemisCaret(writer, value);
    return [...writer.finish().subarray(0, 21)];
  };
  assert.deepEqual(
    caretBytes(caret()),
    [2, 0, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0, 0x61, 5, 0, 0, 0, 0, 0, 0, 0],
  );
  assert.deepEqual(caretBytes(caret({waiting: true})).slice(0, 8), [0, 0, 0, 0, 6, 0, 0, 0]);
  assert.deepEqual(caretBytes(caret({runMode: 3})).slice(0, 8), [3, 0, 0, 0, 2, 0, 0, 0]);
  const deadline = new ArtemisSaveArchiveWriter();
  deadline.section(5);
  deadline.u32(9);
  assert.throws(
    () => readArtemisCaret(new ArtemisSaveArchiveReader(deadline.finish())),
    /deadline/,
  );

  const tween = (parameter, patch = {}) =>
    Object.freeze({
      parameter,
      entire: false,
      ease: 3,
      diff: 0.5,
      time: 300,
      delay: -1,
      randomDelay: true,
      outgoing: false,
      ...patch,
    });
  const glyph = {
    homing: true,
    layer: false,
    rplayer: true,
    layerName: 'g',
    rplayerName: 'r',
    left: -4,
    top: 8,
    rpleft: 0,
    rptop: 12,
  };
  const record = {
    automodeAllowed: true,
    automode: false,
    automodeLayers: new Map([
      ['mw', {present: true, name: 'auto'}],
      ['sub', {present: false, name: 'kept'}],
    ]),
    skipAllowed: true,
    commandSkip: false,
    controlSkip: true,
    macroFiles: ['macro.iet'],
    alreadyRead: true,
    caret: caret({queue: [block('print', {data: 'x'}, 4)], tag: block('wait', {time: '1'}, 5)}),
    callStack: [caret({file: 'b', index: 9, runMode: 0, previousRunMode: 0})],
    rightClickAllowed: false,
    rightClickScript: 'menu.iet',
    autosaveFlag: 1,
    autosaveValue: 2,
    autosave: 1,
    debugMode: 0,
    debugLevel: 3,
    stopAutoByClick: true,
    stopAutoByStop: false,
    syncSe: ['voice'],
    skipUnread: false,
    field35b8: 'x',
    field35d8: 7,
    currentMessageLayer: 'mw',
    messageSelection: ['mw', 'sub'],
    font: {font: {...artemisDefaultFontAttributes(hash), size: 30}, overflow: 0},
    sceneTweens: {
      in: new Map([['mw', [tween('alpha'), tween('left', {entire: true, outgoing: true})]]]),
      out: new Map(),
      show: new Map([['mw', []]]),
      hide: new Map([['b', [tween('rotate', {diff: -90})]]]),
    },
    hideFlag: true,
    hidden: ['sub', 'mw'],
    backlogLayer: 'backlog',
    writeBacklog: false,
    backlogFlag: false,
    backlogAllowed: false,
    backlogNames: [],
    backlogIcons: new Map(),
    glyphs: new Map([['mw', glyph]]),
    field3880: 0,
    pushHandlers: [new Map([[-1, block('call', {file: 'x'})]]), new Map()],
    eventSlots: Array.from({length: 10}, (_, index) => (index === 2 ? block('jump') : empty)),
    windowButtons: new Map([[4, block('exit')]]),
    block3c80: empty,
    block3ce0: block('setonclick'),
    luaEventNames: ['a', '', '', '', '', '', 'g'],
    saveObject: {
      data: {
        text: new Map(),
        fonts: new Map(),
        retainedIndent: new Map(),
        pendingIndent: new Map(),
        retainedProhibit: new Map(),
        pendingProhibit: new Map(),
        effects: new Map(),
      },
      layerCommands: new Map(),
      music: {playing: false, tag: empty},
    },
    keyRoles: new Map([
      [1, [13, 32]],
      [5, []],
    ]),
    layeredNames: ['mw'],
    backlog: {
      tweens: {
        backlog_down_in: [tween('top')],
        backlog_down_out: [],
        backlog_up_in: [],
        backlog_up_out: [],
      },
    },
  };
  const variables = new ArtemisVariables();
  variables.write('f.route', '2');
  const writer = new ArtemisSaveArchiveWriter();
  writeArtemisScenarioArchive(writer, record, variables, fonts);
  const read = readArtemisScenarioArchive(new ArtemisSaveArchiveReader(writer.finish()), fonts);
  const {variables: table, caret: readCaret, callStack, hidden, ...rest} = read;
  const {caret: _caret, callStack: _stack, hidden: _hidden, ...expected} = record;
  assert.deepEqual(rest, expected);
  // Sections 1/2 load into +0x108/+0x10c: run modes >= 5 come back as the previous mode.
  const loaded = ({waiting, runMode, previousRunMode, ...value}) => ({
    ...value,
    runMode: waiting ? 0 : runMode < 5 ? runMode : previousRunMode,
    previousRunMode: waiting ? runMode : previousRunMode,
  });
  assert.deepEqual(readCaret, loaded(record.caret));
  assert.deepEqual(callStack, record.callStack.map(loaded));
  // std::set<std::string> is written in byte order.
  assert.deepEqual(hidden, ['mw', 'sub']);
  assert.deepEqual(
    table.global.map(([name, value]) => [name, new TextDecoder().decode(value)]),
    [['f.route', '2']],
  );

  // Missing sections stay undefined; saved backlog pages are refused.
  const partial = new ArtemisSaveArchiveWriter();
  partial.section(0xb);
  partial.string(new TextEncoder().encode('mw'));
  const sparse = readArtemisScenarioArchive(new ArtemisSaveArchiveReader(partial.finish()), fonts);
  assert.equal(sparse.currentMessageLayer, 'mw');
  assert.equal(sparse.caret, undefined);
  assert.equal(sparse.backlog, undefined);
  const pages = new ArtemisSaveArchiveWriter();
  pages.section(1);
  pages.u8(1);
  pages.section(0x1f, true);
  pages.section(7);
  pages.u32(1);
  pages.close();
  assert.throws(
    () => readArtemisScenarioArchive(new ArtemisSaveArchiveReader(pages.finish()), fonts),
    /backlog pages/,
  );
});

test('Save archive scopes: scoped sections nest, close in order and are entered by start', async () => {
  const {ArtemisSaveArchiveReader, ArtemisSaveArchiveWriter} =
    await import('../dist/formats/artemis/save-file.js');
  const writer = new ArtemisSaveArchiveWriter();
  writer.section(1);
  writer.u8(7);
  // Section 3 opens a scope at its own offset; inside it, two unnamed object scopes.
  writer.section(3, true);
  writer.u32(2);
  for (const value of [10, 20]) {
    writer.section(0, true);
    writer.section(2);
    writer.u32(value);
    writer.close();
  }
  writer.close();
  writer.section(4);
  writer.u32(99);
  const bytes = writer.finish();
  const view = new DataView(bytes.buffer);
  const table = view.getUint32(bytes.length - 4, true);
  // Scopes in closing order: the two objects, section 3's scope, then the root.
  assert.deepEqual(
    [...Array(19)].map((_, index) => view.getUint32(table + index * 4, true)),
    [4, 5, 1, 2, 5, 9, 1, 2, 9, 1, 0, 0, 3, 1, 0, 3, 1, 4, 13],
  );
  const reader = new ArtemisSaveArchiveReader(bytes);
  assert.equal(reader.seek(4), true);
  assert.equal(reader.u32(), 99);
  assert.equal(reader.seek(1), true);
  assert.equal(reader.u8(), 7);
  assert.equal(reader.seek(2), false);
  assert.equal(reader.seek(3, true), true);
  assert.equal(reader.u32(), 2);
  const values = [];
  for (let count = 2; count > 0; count--) {
    reader.seek(0, true);
    assert.equal(reader.seek(2), true);
    values.push(reader.u32());
    reader.close();
  }
  reader.close();
  assert.deepEqual(values, [10, 20]);
  assert.throws(() => reader.close(), /underflow/);
  assert.throws(() => writer.close(), /underflow/);
});

test('Global and system saves round-trip through native BOW archives and reset keeps g./s. variables', async () => {
  const {ArtemisVariables} = await import('../dist/engines/artemis/variables.js');
  const {
    ArtemisReadHistory,
    readArtemisSaveArchive,
    writeArtemisGlobalArchive,
    writeArtemisSystemArchive,
  } = await import('../dist/engines/artemis/global-save.js');
  const {packArtemisSaveFile, unpackArtemisSaveFile, ArtemisSaveArchiveReader} =
    await import('../dist/formats/artemis/save-file.js');
  const variables = new ArtemisVariables();
  variables.write('g.clear', Uint8Array.of(0xe3, 0x81, 0x82));
  variables.write('s.bgmvol', '800');
  variables.write('f.scene', '1');
  const history = new ArtemisReadHistory();
  history.add('script/a.ast', 3);
  history.add('script/a.ast', 7);
  const global = writeArtemisGlobalArchive(history, variables);
  const view = new DataView(global.buffer);
  // Section 1 at 0: one file entry; section 2 follows; the scope table closes the archive.
  assert.equal(view.getUint32(0, true), 1);
  const table = view.getUint32(global.length - 4, true);
  assert.deepEqual(
    [...Array(7)].map((_, index) => view.getUint32(table + index * 4, true)),
    [1, 0, 2, 1, 0, 2, 4 + 4 + 12 + 4 + 8],
  );
  const file = await packArtemisSaveFile('G', global);
  assert.deepEqual([...file.subarray(0, 4)], [0x42, 0x4f, 0x57, 0x47]);
  assert.equal(new DataView(file.buffer).getUint32(4, true), 1003);
  assert.equal(new DataView(file.buffer).getUint32(8, true), global.length);
  const unpacked = await unpackArtemisSaveFile(file);
  assert.deepEqual(unpacked.archive, global);
  const system = await unpackArtemisSaveFile(
    await packArtemisSaveFile('X', writeArtemisSystemArchive(variables)),
  );
  assert.equal(system.kind, 'X');
  assert.equal(new ArtemisSaveArchiveReader(system.archive).seek(2), false);

  const loaded = new ArtemisVariables();
  const loadedHistory = new ArtemisReadHistory();
  loadedHistory.add('stale', 1);
  readArtemisSaveArchive(unpacked, loadedHistory, loaded);
  readArtemisSaveArchive(system, loadedHistory, loaded);
  assert.deepEqual(loadedHistory.entries(), [['script/a.ast', [3, 7]]]);
  assert.deepEqual([...loaded.read('g.clear')], [0xe3, 0x81, 0x82]);
  assert.equal(new TextDecoder().decode(loaded.read('s.bgmvol')), '800');
  assert.equal(loaded.lookup('f.scene'), undefined);
  assert.equal(loaded.globalDirty, false);
  assert.equal(
    await unpackArtemisSaveFile(Uint8Array.of(0x42, 0x4f, 0x57, 0x47, 0, 0, 0, 0)),
    null,
  );
  assert.equal(await unpackArtemisSaveFile(file.subarray(0, 7)), null);

  variables.resetScenario();
  assert.equal(variables.lookup('f.scene'), undefined);
  assert.notEqual(variables.lookup('g.clear'), undefined);
  assert.notEqual(variables.lookup('s.bgmvol'), undefined);
});

test('Native reset saves globals, restarts the boot script and boot loads saved state', async () => {
  const {ArtemisLua} = await import('../dist/engines/artemis/lua.js');
  const {ArtemisScript} = await import('../dist/engines/artemis/script.js');
  const {ArtemisVariables} = await import('../dist/engines/artemis/variables.js');
  const {ArtemisModes} = await import('../dist/engines/artemis/modes.js');
  const {ArtemisSave} = await import('../dist/engines/artemis/save.js');
  const {ArtemisReset} = await import('../dist/engines/artemis/reset.js');
  const {ArtemisReadHistory, writeArtemisGlobalArchive, writeArtemisSystemArchive} =
    await import('../dist/engines/artemis/global-save.js');
  const {packArtemisSaveFile} = await import('../dist/formats/artemis/save-file.js');
  const files = new Map([
    [
      'boot.iet',
      bytes(
        `[lua]\nloads = (loads or 0) + 1\nfunction go(e) if not done then done = true; engine:tag{'reset'} end end\n[/lua]\n[mark][call file="sub.iet"][stop]`,
      ),
    ],
    ['sub.iet', bytes('[calllua function="go"][after]')],
  ]);
  const variables = new ArtemisVariables();
  const history = new ArtemisReadHistory();
  const log = [];
  const modes = new ArtemisModes({
    writeStatus: (name, value) => log.push(name + '=' + value),
    commandSkipChanged: () => {},
    controlSkipChanged: () => {},
    automodeChanged: () => {},
    releaseScheduler: () => {},
    currentMessageLayer: () => 'mw',
  });
  const writes = [];
  const save = new ArtemisSave(variables, {
    beforeScenario: () => assert.fail(),
    reportEventError: () => assert.fail(),
    writeScenario: () => assert.fail(),
    writeGlobal: () =>
      writes.push(['saveg.dat', 'G', writeArtemisGlobalArchive(history, variables)]),
    writeSystem: () => writes.push(['system.dat', 'X', writeArtemisSystemArchive(variables)]),
  });
  let lua, script;
  const stored = new Map();
  const host = {
    bootPath: () => 'boot.iet',
    updateMessageState: () => log.push('message'),
    releaseScheduler: () => log.push('scheduler'),
    resetOwners: () => log.push('owners'),
    applyVolumes: (music, effect) => log.push(['volumes', music, effect]),
    resetSaveObject: () => log.push('saveObject'),
    loadBoot: (path) => (log.push('boot'), script.reset(path)),
    readSaveFile: async (name) => stored.get(name) ?? null,
    initializeStaticVariables: () => {
      log.push('statics');
      variables.write('s.engineversion', '3179');
    },
  };
  const reset = new ArtemisReset(modes, save, variables, history, host);
  const native = [];
  const dispatch = (tag) => {
    if (reset.dispatch(tag)) return;
    native.push(tag.name);
    if (tag.name === 'stop') return 'stopped';
  };
  lua = new ArtemisLua({
    readFile: (path) => files.get(path) ?? null,
    fileExists: () => true,
    now: () => 0,
    tag: (tag) => script.executeTag(tag),
    enqueueTag: (tag) => script.enqueue(tag),
    variable: () => '',
  });
  try {
    script = new ArtemisScript(lua, {
      readFile: (path) => files.get(path) ?? null,
      dispatch,
      pushLocal: () => variables.pushLocal(),
      popLocal: () => variables.popLocal(),
    });
    // Boot (bf210 flag 0): default volumes, saved files, then the c37e0 statics.
    variables.write('g.clear', '1');
    variables.write('s.bgmvol', '640');
    stored.set(
      'saveg.dat',
      await packArtemisSaveFile('G', writeArtemisGlobalArchive(history, variables)),
    );
    stored.set('system.dat', await packArtemisSaveFile('X', writeArtemisSystemArchive(variables)));
    const booted = new ArtemisVariables();
    const bootReset = new ArtemisReset(modes, save, booted, history, {
      ...host,
      initializeStaticVariables: () => log.push('statics'),
      loadBoot: (path) => log.push(['bootPath', path]),
    });
    await bootReset.boot();
    assert.equal(new TextDecoder().decode(booted.read('s.bgmvol')), '640');
    assert.equal(new TextDecoder().decode(booted.read('s.sevol')), '1000');
    assert.equal(new TextDecoder().decode(booted.read('g.clear')), '1');
    assert.deepEqual(log, [
      'message',
      'scheduler',
      'owners',
      'statics',
      ['volumes', 640, 1000],
      'saveObject',
      ['bootPath', 'boot.iet'],
    ]);

    // Reset tag (caad0): forced global save, mode defaults, boot restart, scenario erase.
    modes.automodeAllowed = true;
    modes.setAutomode(true);
    log.length = 0;
    modes.skipAllowed = false;
    modes.rightClickAllowed = true;
    variables.write('f.scene', '1');
    script.reset('boot.iet');
    assert.equal(script.run(), 'stopped');
    assert.equal(lua.vm.getGlobal('loads'), 1); // cached program: inline Lua is not rerun
    // The interrupted call is dropped; only the second pass reaches [after] and returns.
    assert.deepEqual(native, ['mark', 'mark', 'after', 'stop']);
    assert.equal(script.callDepth, 0);
    assert.deepEqual(
      writes.map(([name]) => name),
      ['saveg.dat', 'system.dat'],
    );
    assert.deepEqual(log, [
      'message',
      's.status.automode=0',
      'scheduler',
      'owners',
      ['volumes', 640, 0],
      'saveObject',
      'boot',
    ]);
    assert.equal(modes.automodeAllowed, false);
    assert.equal(modes.skipAllowed, true);
    assert.equal(modes.rightClickAllowed, false);
    assert.equal(modes.rightClickScript, 'rclick.iet');
    assert.equal(variables.lookup('f.scene'), undefined);
    assert.notEqual(variables.lookup('g.clear'), undefined);
  } finally {
    lua.close();
  }
});

test('Lua var tags store Pluto bytes exactly and the save tag forces a global save', async () => {
  const {ArtemisSave} = await import('../dist/engines/artemis/save.js');
  const {ArtemisVariables} = await import('../dist/engines/artemis/variables.js');
  const lua = new ArtemisLua({readFile: () => null});
  const variables = new ArtemisVariables();
  const calls = [];
  const save = new ArtemisSave(variables, {
    reportEventError: (error) => calls.push(String(error)),
    beforeScenario: (file) => calls.push(['saveEvent', file]),
    writeScenario: (file, transient) => calls.push(['scenario', file, transient]),
    writeGlobal: () => calls.push('global'),
    writeSystem: () => calls.push('system'),
  });
  try {
    lua.vm.execute(
      new TextEncoder().encode(`
      sys = {langselect = 1, name = string.char(0, 255, 0x80)}
      data = pluto.persist({}, sys)
      binaryTag = {"var", name="g.sys", data=data}
    `),
    );
    const data = lua.vm.getGlobal('data');
    const tag = luaTag(lua.vm.getGlobal('binaryTag'));
    assert.match(tag.args.get('data'), /�/);
    assert.equal(variables.dispatch(tag), true);
    assert.deepEqual(variables.lookup('g.sys'), data);
    assert.equal(variables.globalDirty, true);
    lua.vm.setGlobal('stored', variables.lookup('g.sys'));
    lua.vm.execute(
      new TextEncoder().encode(`
      local copy = pluto.unpersist({}, stored)
      assert(copy.langselect == 1 and copy.name == string.char(0, 255, 0x80))
    `),
    );
  } finally {
    lua.close();
  }
  const saveTag = (args) => ({kind: 'tag', name: 'save', sourceLine: 1, args: new Map(args)});
  // Empty file: no scenario, but saveg.dat/system.dat are forced even when g. is clean.
  variables.clearGlobalDirty();
  assert.equal(save.dispatch(saveTag([])), true);
  assert.equal(save.dispatch({...saveTag([]), name: 'load'}), false);
  assert.deepEqual(calls, ['global', 'system']);
  calls.length = 0;
  save.dispatch(saveTag([['file', 'save001.dat']]));
  assert.deepEqual(calls, [
    ['saveEvent', 'save001.dat'],
    ['scenario', 'save001.dat', true],
    'global',
    'system',
  ]);
});

test('Glyph tags configure the current message layer and copy the layer glyph to rplayer', async () => {
  const {ArtemisClickGlyphs} = await import('../dist/engines/artemis/click-glyph.js');
  let current = 'mw';
  const cleared = [];
  const glyphs = new ArtemisClickGlyphs({
    currentMessageLayer: () => current,
    setLayerDraggable: (name, value) => cleared.push([name, value]),
  });
  const glyph = (args) => ({kind: 'tag', name: 'glyph', sourceLine: 1, args: new Map(args)});
  assert.equal(glyphs.dispatch({...glyph([]), name: 'trans'}), false);
  assert.equal(
    glyphs.dispatch(
      glyph([
        ['layer', 'mw.glyph'],
        ['left', '16'],
        ['top', '-4'],
        ['homing', '2'],
      ]),
    ),
    true,
  );
  assert.deepEqual(
    {...glyphs.get('mw')},
    {
      homing: true,
      layer: true,
      layerName: 'mw.glyph',
      left: 16,
      top: -4,
      rplayer: true,
      rplayerName: 'mw.glyph',
      rpleft: 16,
      rptop: -4,
    },
  );
  assert.deepEqual(cleared, [['mw.glyph', false]]);
  // Without layer the flag clears but the name stays; explicit rplayer keeps its own position.
  glyphs.dispatch(
    glyph([
      ['rplayer', 'mw.rp'],
      ['rptop', '7'],
      ['homing', '0'],
    ]),
  );
  assert.deepEqual(
    {...glyphs.get('mw')},
    {
      homing: false,
      layer: false,
      layerName: 'mw.glyph',
      left: 16,
      top: -4,
      rplayer: true,
      rplayerName: 'mw.rp',
      rpleft: 16,
      rptop: 7,
    },
  );
  assert.deepEqual(cleared.at(-1), ['mw.rp', false]);
  current = 'sub';
  glyphs.dispatch(glyph([]));
  assert.equal(glyphs.get('sub').rplayer, false);
  assert.equal(glyphs.get('mw').rplayerName, 'mw.rp');
  glyphs.reset();
  assert.equal(glyphs.get('mw'), undefined);
});

test('Click glyph placement marks the selected layer draggable until release', async () => {
  const {ArtemisClickGlyphs} = await import('../dist/engines/artemis/click-glyph.js');
  const flags = [];
  const glyphs = new ArtemisClickGlyphs({
    currentMessageLayer: () => 'mw',
    setLayerDraggable: (name, value) => flags.push([name, value]),
  });
  const glyph = (args) => ({kind: 'tag', name: 'glyph', sourceLine: 1, args: new Map(args)});
  glyphs.dispatch(glyph([['rplayer', 'mw.rp']]));
  flags.length = 0;
  // The layer flag is clear, so a wait not followed by `rp` places nothing.
  glyphs.place(false);
  assert.equal(glyphs.placed, '');
  glyphs.release();
  assert.deepEqual(flags, []);
  glyphs.place(true);
  glyphs.place(false);
  assert.equal(glyphs.placed, 'mw.rp');
  assert.deepEqual(flags.splice(0), [['mw.rp', true]]);
  glyphs.release();
  glyphs.release();
  assert.equal(glyphs.placed, '');
  assert.deepEqual(flags.splice(0), [['mw.rp', false]]);
  glyphs.dispatch(
    glyph([
      ['layer', 'mw.glyph'],
      ['homing', '1'],
    ]),
  );
  assert.throws(() => glyphs.place(false), /homing click glyph/);
});

test('s.clickskip has no startup value and queries create it as integer zero', async () => {
  const {ArtemisVariables} = await import('../dist/engines/artemis/variables.js');
  const variables = new ArtemisVariables();
  assert.equal(variables.lookup('s.clickskip'), undefined);
  assert.deepEqual(variables.expressionValue('s.clickskip'), {kind: 'integer', value: 0});
  assert.deepEqual(variables.lookup('s.clickskip'), new TextEncoder().encode('0'));
  assert.throws(
    () => variables.queryLiteral('s.unknown'),
    /Unsupported native Artemis variable s\.unknown/,
  );
});

test('Music commands follow native splay/sxfade/sstop/sfade/span order, slots and replay history', async () => {
  const {ArtemisMusic} = await import('../dist/engines/artemis/music.js');
  const calls = [];
  let next = 1,
    debugSkip = false;
  const music = new ArtemisMusic(
    '8953562b80608046662bd8c89015d04236b0ba3afee10c36469c11403de3ebaf',
    {
      debugSkipActive: () => debugSkip,
      stopMusic: (...a) => calls.push(['stop', ...a]),
      prepareMusic: async (file, buffer) => {
        calls.push(['prepare', file, buffer]);
        return file === 'missing' ? 0 : next++;
      },
      discardPreparedMusic: (i) => calls.push(['discard', i]),
      setMusicGain: (...a) => calls.push(['gain', ...a]),
      setMusicPan: (...a) => calls.push(['pan', ...a]),
      startMusic: (...a) => calls.push(['start', ...a]),
      musicLoadFailed: (tag) => calls.push(['failed', tag.args.get('file')]),
    },
  );
  const tag = (name, args) => ({kind: 'tag', name, sourceLine: 1, args: new Map(args)});
  // Absent loop loops; only an exact "0" plays once.
  assert.equal(
    await music.dispatch(
      tag('splay', [
        ['file', 'a'],
        ['gain', '500'],
        ['pan', '-3'],
        ['time', '200'],
        ['buffer', '2'],
      ]),
    ),
    true,
  );
  assert.deepEqual(calls.splice(0), [
    ['stop', 0, 0],
    ['stop', 0, 0],
    ['prepare', 'a', 2],
    ['gain', 1, 0, 500, 0],
    ['pan', 1, -3, 0],
    ['start', 1, 200, true],
  ]);
  assert.equal(music.currentIndex, 1);
  assert.equal(music.history.playing, true);
  assert.equal(music.history.tag.args.get('file'), 'a');
  // sfade inserts an empty gain (atoi 0) and rewrites the stored tag's gain.
  assert.equal(music.dispatch(tag('sfade', [['time', '30']])), true);
  assert.deepEqual(calls.splice(0), [['gain', 1, 0, 0, 30]]);
  assert.equal(music.history.tag.args.get('gain'), '');
  // span pans the current slot over time and rewrites the stored tag's pan.
  assert.equal(
    music.dispatch(
      tag('span', [
        ['pan', '7'],
        ['time', '40'],
      ]),
    ),
    true,
  );
  assert.equal(music.dispatch(tag('span', []), false), true);
  assert.deepEqual(calls.splice(0), [
    ['pan', 1, 7, 40],
    ['pan', 1, 0, 0],
  ]);
  assert.equal(music.history.tag.args.get('pan'), '7');
  // sxfade fades the old slot out over time after loading the new one.
  await music.dispatch(
    tag('sxfade', [
      ['file', 'b'],
      ['time', '100'],
      ['loop', '0'],
    ]),
  );
  assert.deepEqual(calls.splice(0), [
    ['stop', 0, 0],
    ['prepare', 'b', 0],
    ['stop', 1, 100],
    ['start', 2, 100, false],
  ]);
  assert.deepEqual([music.currentIndex, music.fadingIndex], [2, 1]);
  assert.equal(music.history.playing, false);
  assert.equal(music.history.tag.args.get('file'), 'a');
  // A failed load leaves slot 0, reports and records no history.
  await music.dispatch(tag('sfadein', [['file', 'missing']]));
  assert.deepEqual(calls.splice(0), [
    ['stop', 2, 0],
    ['stop', 1, 0],
    ['prepare', 'missing', 0],
    ['failed', 'missing'],
  ]);
  assert.deepEqual([music.currentIndex, music.fadingIndex], [0, 0]);
  assert.equal(music.history.playing, false);
  // Debug skip bypasses audio but records history; replay records nothing.
  debugSkip = true;
  await music.dispatch(tag('splay', [['file', 'c']]));
  assert.deepEqual(calls.splice(0), []);
  assert.equal(music.history.playing, true);
  assert.equal(music.history.tag.args.get('file'), 'c');
  assert.equal(music.dispatch(tag('sstop', []), false), true);
  assert.equal(music.history.playing, true);
  assert.equal(music.dispatch(tag('sfadeout', [['time', '9']])), true);
  assert.deepEqual(calls.splice(0), [
    ['stop', 0, 0],
    ['stop', 0, 9],
  ]);
  assert.equal(music.history.playing, false);
  assert.equal(music.dispatch(tag('seplay', [])), false);
  music.clearHistory();
  assert.deepEqual([music.history.playing, music.history.tag.args.size], [false, 0]);
});

test('Scenario save captures every owner and load restores them through the archive', async () => {
  const {ArtemisSaveArchiveReader, ArtemisSaveArchiveWriter} =
    await import('../dist/formats/artemis/save-file.js');
  const {writeArtemisScenarioArchive, readArtemisScenarioArchive} =
    await import('../dist/engines/artemis/scenario-archive.js');
  const {captureArtemisScenario, applyArtemisScenario} =
    await import('../dist/engines/artemis/scenario-state.js');
  const {ArtemisModes} = await import('../dist/engines/artemis/modes.js');
  const {ArtemisKeyBindings} = await import('../dist/engines/artemis/key-bindings.js');
  const {ArtemisEventCommands} = await import('../dist/engines/artemis/event-commands.js');
  const {ArtemisMessageLayers, ArtemisMessageSelection} =
    await import('../dist/engines/artemis/message-layers.js');
  const {ArtemisTextControls} = await import('../dist/engines/artemis/text-controls.js');
  const {ArtemisSceneTweens} = await import('../dist/engines/artemis/scene-tweens.js');
  const {ArtemisClickGlyphs} = await import('../dist/engines/artemis/click-glyph.js');
  const {ArtemisEvents} = await import('../dist/engines/artemis/events.js');
  const {ArtemisSaveData} = await import('../dist/engines/artemis/save-data.js');
  const {ArtemisLayerCommands} = await import('../dist/engines/artemis/layer-commands.js');
  const {ArtemisVariables} = await import('../dist/engines/artemis/variables.js');
  const {artemisDefaultFontAttributes, writeArtemisFontFrame, readArtemisFontFrame} =
    await import('../dist/engines/artemis/font-state.js');
  const {ARTEMIS_3179_EXECUTABLE_SHA256: hash} =
    await import('../dist/engines/artemis/revision.js');
  const fonts = {write: writeArtemisFontFrame, read: (a) => readArtemisFontFrame(hash, a)};
  const font = (size) => ({font: {...artemisDefaultFontAttributes(hash), size}, overflow: 0});
  const tag = (name, args = {}, sourceLine = 1) => ({
    kind: 'tag',
    name,
    sourceLine,
    args: new Map(Object.entries(args)),
  });
  const owners = () => {
    const stage = new ArtemisMessageLayers(hash, '', {
      createMessageLayer: (id) => ({id}),
      copyMessageLayer: (layer) => ({...layer}),
      retainMessageLayer() {},
      releaseMessageLayer() {},
      attachMessageLayer() {},
      detachMessageLayer() {},
    });
    let carets = [];
    const selection = new ArtemisMessageSelection(stage, {
      nextMessageLayerId: () => 'auto',
      ensureMessageHistory() {},
      deleteMessageHistory() {},
      publishCurrentMessageLayer() {},
      selectionChanged() {},
      stackUnderflow() {},
      messageStateUpdated() {},
    });
    const current = () => selection.currentMessageLayer();
    let history = {playing: false, tag: tag('', {}, 0)};
    return {
      modes: new ArtemisModes({
        writeStatus() {},
        commandSkipChanged() {},
        controlSkipChanged() {},
        automodeChanged() {},
        releaseScheduler() {},
        currentMessageLayer: current,
      }),
      script: {
        carets: () => carets,
        restoreCarets: (value) => (carets = value),
      },
      keyBindings: new ArtemisKeyBindings(() => 'main.ast'),
      eventCommands: new ArtemisEventCommands(() => 'main.ast'),
      messageLayers: stage,
      messageSelection: selection,
      textControls: new ArtemisTextControls({
        currentMessageLayer: current,
        messageLayerExists: (id) => stage.messageLayerExists(id),
        selectMessageLayer: (id) => stage.selectMessageLayer(id),
        clearBacklog() {},
      }),
      sceneTweens: new ArtemisSceneTweens(hash, current),
      clickGlyphs: new ArtemisClickGlyphs({currentMessageLayer: current, setLayerDraggable() {}}),
      events: new ArtemisEvents(() => {}),
      saveData: new ArtemisSaveData(),
      layerCommands: new ArtemisLayerCommands(hash),
      music: {
        get history() {
          return history;
        },
        restoreHistory: (value) => (history = value),
      },
      variables: new ArtemisVariables(),
    };
  };
  const a = owners();
  a.script.restoreCarets([
    {
      file: 'sub.ast',
      index: 4,
      queue: [],
      tag: tag('call', {file: 'x'}),
      resumeState: 'waiting',
      runMode: 4,
    },
    {
      file: 'main.ast',
      index: 9,
      queue: [tag('print', {data: 'q'})],
      tag: tag('@', {}, 7),
      runMode: 1,
    },
  ]);
  for (const t of [
    tag('automode', {allow: '1', layer: 'auto'}),
    tag('skip', {allow: '1', unread: '1'}),
    tag('rclick', {allow: '1', file: 'r.ast'}),
    tag('autosave', {allow: '2'}),
    tag('writebacklog', {mode: '0'}),
  ])
    a.modes.dispatch(t);
  a.keyBindings.dispatch(tag('keyconfig', {role: '3', keys: '5,136'}));
  a.keyBindings.dispatch(tag('setonpush', {key: '27', label: 'esc'}));
  a.keyBindings.dispatch(tag('setonpush', {key: '13', keyrepeat: '1', file: 'k.ast'}));
  a.eventCommands.dispatch(tag('setonhidein', {label: 'h'}));
  a.eventCommands.dispatch(tag('setondirchg', {file: 'd.ast'}));
  a.eventCommands.dispatch(tag('setonwindowbutton', {button: '2', label: 'w'}));
  a.eventCommands.dispatch(tag('setonwindowbutton', {label: 'none'}));
  a.messageSelection.dispatch(tag('chgmsg', {id: 'mw', layered: '1'}));
  a.messageSelection.dispatch(tag('chgmsg', {id: 'sub'}));
  a.textControls.dispatch(tag('hide', {allow: '1', window: 'mw,sub'}));
  a.textControls.dispatch(tag('backlog', {allow: '1', layer: 'bl', hide: 'x', includefont: '0'}));
  a.sceneTweens.dispatch(
    tag('scetween', {mode: 'add', type: 'in', param: 'alpha', diff: '255', time: '300'}),
  );
  a.sceneTweens.dispatch(tag('scetween', {mode: 'init', type: 'hide'}));
  a.clickGlyphs.dispatch(tag('glyph', {layer: 'g', left: '3', top: '4'}));
  a.events.register([
    ['onSave', 'sv_save'],
    ['onClickWait', 'cw'],
  ]);
  a.saveData.recordText('sub', tag('print', {data: 'hello'}));
  a.saveData.saveFonts('mw', [font(24), font(28)]);
  a.layerCommands.append('bg', tag('lyc', {id: 'bg', file: 'bg01'}));
  a.music.restoreHistory({playing: true, tag: tag('splay', {file: 'bgm01', loop: '1'})});
  a.variables.write('f.flag', '7');

  const scalars = {
    macroFiles: ['macro.iet'],
    autosaveFlag: 0,
    autosaveValue: 0,
    debugMode: 1,
    debugLevel: 2,
    field35b8: '',
    field35d8: 0,
    field3880: 0,
    font: font(26),
  };
  const runMode = {waiting: false, frameWaiting: (fields) => fields !== undefined};
  const saved = captureArtemisScenario(a, scalars, runMode, null);
  assert.deepEqual(
    saved.callStack.map((c) => c.runMode),
    [4],
  );
  assert.equal(saved.caret.tag.name, '@');
  assert.deepEqual([...saved.keyRoles.get(3)], [5]);
  assert.equal(saved.eventSlots[6].args.get('label'), 'h');
  assert.equal(saved.eventSlots[0].name, '');
  assert.deepEqual(saved.layeredNames, ['mw']);
  assert.deepEqual(saved.messageSelection, ['', 'mw']);
  assert.deepEqual(saved.luaEventNames, ['', 'cw', '', 'sv_save', '', '', '']);

  const writer = new ArtemisSaveArchiveWriter();
  writeArtemisScenarioArchive(writer, saved, a.variables, fonts);
  const loaded = readArtemisScenarioArchive(new ArtemisSaveArchiveReader(writer.finish()), fonts);
  const b = owners();
  b.modes.dispatch(tag('skip', {allow: '0'}));
  b.keyBindings.dispatch(tag('setonpush', {key: '1', label: 'stale'}));
  const effects = [];
  let restoredScalars = null;
  let loadMode = null;
  await applyArtemisScenario(b, loaded, {
    reset: () => effects.push('reset'),
    loadScalars: (value) => (restoredScalars = value),
    loadBacklog: (value) => effects.push(['backlog', value ?? null]),
    enterLoadMode: (caret) => {
      loadMode = {mode: caret.runMode, previous: caret.previousRunMode};
      effects.push('mode13');
    },
    frameState: (mode) => (mode ? 'waiting' : undefined),
    refreshGlyphLayer: (name) => effects.push(['glyph', name]),
    finishLoad: () => effects.push('release'),
    selectMessageLayer: (name, mode) => b.messageLayers.selectMessageLayer(name, mode),
    currentMessageLayer: () => b.messageSelection.currentMessageLayer(),
    setCurrentMessageLayer: (name) => b.messageSelection.loadFields({current: name}),
    replaceFontFrames() {},
    applyFontFrame() {},
    dispatch: (t) => effects.push(['replay', t.name]),
    applySceneTween() {},
    writeCurrentMessageLayerVariable() {},
  });
  assert.deepEqual(effects, [
    'reset',
    ['backlog', null],
    'mode13',
    ['replay', 'print'],
    ['replay', 'lyc'],
    // The glyph refresh visits the layer name, then the rplayer name it was copied to.
    ['glyph', 'g'],
    ['glyph', 'g'],
    ['replay', 'splay'],
    'release',
  ]);
  assert.deepEqual(loadMode, {mode: 1, previous: 0});
  // The saved +0x3628 font and the other host scalars come back as written.
  const reloaded = captureArtemisScenario(b, restoredScalars, runMode, null);
  assert.deepEqual(reloaded, saved);
  // A caret saved inside a wait loads in run mode 0 with its mode as the previous mode;
  // the as-loaded capture writes exactly that caret.
  const waitingWriter = new ArtemisSaveArchiveWriter();
  writeArtemisScenarioArchive(
    waitingWriter,
    captureArtemisScenario(a, scalars, {...runMode, waiting: true}, null),
    a.variables,
    fonts,
  );
  const waitingLoaded = readArtemisScenarioArchive(
    new ArtemisSaveArchiveReader(waitingWriter.finish()),
    fonts,
  ).caret;
  const asLoaded = captureArtemisScenario(
    a,
    scalars,
    {...runMode, waiting: true, asLoaded: true},
    null,
  ).caret;
  assert.deepEqual([waitingLoaded.runMode, waitingLoaded.previousRunMode], [0, 1]);
  assert.deepEqual([asLoaded.runMode, asLoaded.previousRunMode, asLoaded.waiting], [0, 1, false]);
  const ready = captureArtemisScenario(a, scalars, {...runMode, asLoaded: true}, null).caret;
  assert.deepEqual([ready.runMode, ready.previousRunMode, ready.waiting], [1, 0, false]);
  assert.equal(new TextDecoder().decode(b.variables.read('f.flag')), '7');
  assert.equal(b.keyBindings.pushHandler(1, 0), undefined);
  // Ordinary keys come from the save; the 136/137 flags keep the constructor defaults.
  assert.deepEqual(b.keyBindings.role(3), {
    keys: new Set([5]),
    special136: false,
    special137: false,
  });
  assert.equal(b.keyBindings.role(0).special136, true);
});

test('Load tag forces a global save, dispatches the archive kind, calls onLoad and continues as trans', async () => {
  const {ArtemisSaveArchiveWriter, packArtemisSaveFile} =
    await import('../dist/formats/artemis/save-file.js');
  const {ArtemisLoad} = await import('../dist/engines/artemis/load.js');
  const {ArtemisSave} = await import('../dist/engines/artemis/save.js');
  const {ArtemisEvents} = await import('../dist/engines/artemis/events.js');
  const {ArtemisVariables} = await import('../dist/engines/artemis/variables.js');
  const {ArtemisReadHistory, writeArtemisSystemArchive} =
    await import('../dist/engines/artemis/global-save.js');
  const tag = (name, args = {}) => ({
    kind: 'tag',
    name,
    sourceLine: 1,
    args: new Map(Object.entries(args)),
  });
  const effects = [];
  const variables = new ArtemisVariables();
  const save = new ArtemisSave(variables, {
    beforeScenario() {},
    reportEventError() {},
    writeScenario: (file) => effects.push(['scenario', file]),
    writeGlobal: () => effects.push('saveg'),
    writeSystem: () => effects.push('system'),
  });
  let failOnLoad = false;
  const events = new ArtemisEvents(() => assert.fail('onLoad runs through the load host'));
  const source = new ArtemisVariables();
  source.write('s.vol', '3');
  const scenario = new ArtemisSaveArchiveWriter();
  scenario.section(2);
  scenario.u32(9);
  const files = new Map([
    ['sys.dat', await packArtemisSaveFile('X', writeArtemisSystemArchive(source))],
    ['00.dat', await packArtemisSaveFile('S', scenario.finish())],
    ['bad.dat', new Uint8Array([0x42, 0x4f, 0x57, 0x53, 0xe7, 3, 0, 0])],
  ]);
  const load = new ArtemisLoad(save, new ArtemisReadHistory(), variables, events, {
    readSaveFile: async (name) => files.get(name) ?? null,
    loadScenario: async (archive) => {
      assert.ok(archive.seek(2));
      effects.push(['loader', archive.u32()]);
    },
    // The handler's resource work settles before the load continues.
    callEvent: async (name, args) => {
      effects.push(['lua', name, args.get('file')]);
      await Promise.resolve();
      if (failOnLoad) throw new Error('boom');
      effects.push('lua-done');
    },
    reportEventError: (handler, error) => effects.push(['error', handler, error.message]),
    transition: (t) => {
      effects.push(['trans', t.name, t.args.get('type')]);
      return true;
    },
  });
  events.register([['onLoad', 'on_load']]);

  assert.equal(await load.dispatch(tag('load', {file: 'missing.dat', type: '1'})), true);
  // The forced global save runs before the open; a failed open neither calls Lua nor trans.
  assert.deepEqual(effects.splice(0), ['saveg', 'system']);
  await load.dispatch(tag('load', {file: 'bad.dat'}));
  assert.deepEqual(effects.splice(0), ['saveg', 'system']);

  await load.dispatch(tag('load', {file: 'sys.dat'}));
  assert.equal(new TextDecoder().decode(variables.read('s.vol')), '3');
  assert.deepEqual(effects.splice(0), [
    'saveg',
    'system',
    ['lua', 'on_load', 'sys.dat'],
    'lua-done',
  ]);

  await load.dispatch(tag('load', {file: '00.dat', type: '1', time: '300'}));
  assert.deepEqual(effects.splice(0), [
    'saveg',
    'system',
    ['loader', 9],
    ['lua', 'on_load', '00.dat'],
    'lua-done',
    ['trans', 'trans', '1'],
  ]);

  failOnLoad = true;
  assert.equal(await load.load('00.dat', false), true);
  assert.deepEqual(effects.splice(0), [
    ['loader', 9],
    ['lua', 'on_load', '00.dat'],
    ['error', 'on_load', 'boom'],
  ]);
  // The failed handler is cleared.
  await load.load('00.dat', false);
  assert.deepEqual(effects.splice(0), [['loader', 9]]);
});

test('Volume variables reach the sound managers each frame when they change', async () => {
  const {ArtemisVolumes} = await import('../dist/engines/artemis/volumes.js');
  const {ArtemisVariables} = await import('../dist/engines/artemis/variables.js');
  const variables = new ArtemisVariables();
  const calls = [];
  const playing = new Set([4]);
  const gains = new Map([[4, 1000]]);
  const effectSlots = new Map([
    ['voice', 4],
    ['done', 5],
  ]);
  const volumes = new ArtemisVolumes(variables, {
    effectSlots,
    applyGroupVolumes: (music, effect) => calls.push(['group', music, effect]),
    effectPlaying: (index) => playing.has(index),
    effectGain: (index, scope) => (assert.equal(scope, 1), gains.get(index) ?? -1),
    setEffectGain: (index, scope, gain, time) => {
      calls.push(['gain', index, scope, gain, time]);
      gains.set(index, gain);
    },
  });
  // The reset applies the values it read; absent variables read 0 in a frame.
  volumes.applyAfterReset(1000, 1000);
  assert.deepEqual(calls, [['group', 1000, 1000]]);
  assert.deepEqual([...effectSlots.keys()], ['voice']); // no playing player: removed
  calls.length = 0;
  variables.write('s.bgmvol', '1000');
  variables.write('s.sevol', '1000');
  volumes.apply();
  assert.deepEqual(calls, []);
  // A configuration slider writes s.bgmvol: the next frame applies it once.
  variables.write('s.bgmvol', '640');
  volumes.apply();
  volumes.apply();
  assert.deepEqual(calls, [['group', 640, 1000]]);
  calls.length = 0;
  // s.segain.<id> moves a playing effect's scope 1 gain once.
  variables.write('s.segain.voice', '300');
  volumes.apply();
  volumes.apply();
  assert.deepEqual(calls, [['gain', 4, 1, 300, 0]]);
  playing.clear();
  volumes.apply();
  assert.equal(effectSlots.size, 0);
});

test('Artemis Lua opens the os library like luaL_openlibs over the browser platform', async () => {
  const {BrowserWindowsProcessHost} = await import('../dist/platform/browser-windows-process.js');
  const {BrowserWindowsSystemProfileHost} =
    await import('../dist/platform/browser-windows-system-profile.js');
  const process = new BrowserWindowsProcessHost(),
    profile = new BrowserWindowsSystemProfileHost();
  const base = {readFile: () => null, fileExists: () => false, now: () => 0};
  const lua = new ArtemisLua({
    ...base,
    wallClock: () => 1693425477123,
    os: {
      system: (command) => process.system(command),
      getenv: (name) => profile.readEnvironmentVariable(name),
    },
  });
  const run = (code) => {
    lua.vm.execute(new TextEncoder().encode(`probe_out = ${code}`), 'probe');
    return lua.vm.getGlobal('probe_out');
  };
  const text = (code) => luaText(run(code));
  // 2001-02-03 04:05:06 UTC, a Saturday.
  const t = 981173106;
  assert.equal(
    text(`os.date('!%Y-%m-%d %H:%M:%S|%j|%a %A|%b %B %h|%p|%y %C|%e|%D|%F|%T|%R|%r|%u %w', ${t})`),
    '2001-02-03 04:05:06|034|Sat Saturday|Feb February Feb|AM|01 20| 3|02/03/01|2001-02-03|04:05:06|04:05|04:05:06 AM|6 6',
  );
  assert.equal(text(`os.date('!%U %W %V %G %g', ${t})`), '04 05 05 2001 01');
  assert.equal(text(`os.date('!%U %W %V %G %g', 1104537600)`), '00 00 53 2004 04'); // 2005-01-01.
  assert.equal(text(`os.date('!100%% and %', ${t})`), '100% and %');
  assert.equal(text(`os.date('!%Y\\0%m', ${t})`), '2001'); // A C string format.
  const fields = run(`os.date('!*t', ${t})`);
  assert.deepEqual(Object.fromEntries(fields), {
    sec: 6,
    min: 5,
    hour: 4,
    day: 3,
    month: 2,
    year: 2001,
    wday: 7,
    yday: 34,
    isdst: false,
  });
  const local = new Date(t * 1000);
  assert.equal(
    text(`os.date('%H:%M', '${t}')`),
    `${String(local.getHours()).padStart(2, '0')}:${String(local.getMinutes()).padStart(2, '0')}`,
  );
  assert.equal(run(`os.time()`), 1693425477);
  assert.equal(text(`os.date('!%Y')`), '2023');
  assert.equal(
    run(`os.time{year=2023, month=8, day=30, hour=19, min=57, sec=57}`),
    new Date(2023, 7, 30, 19, 57, 57).getTime() / 1000,
  );
  assert.equal(
    run(`os.time{year='2023', month=13, day=1.9}`),
    new Date(2024, 0, 1, 12, 0, 0).getTime() / 1000,
  );
  assert.equal(run(`os.time{year=1960, month=1, day=1}`), null);
  assert.equal(run(`os.difftime(10, 4.9)`), 6);
  assert.equal(run(`os.difftime(10)`), 10);
  assert.equal(run(`os.execute()`), 0); // No command interpreter in the browser.
  assert.equal(run(`os.execute('dir')`), -1);
  assert.equal(run(`os.getenv('USERNAME')`), null);
  assert.equal(text(`os.setlocale()`), 'C');
  assert.equal(
    text(`select(2, pcall(os.date, {}))`),
    "bad argument #1 to 'date' (string expected, got table)",
  );
  assert.equal(
    text(`select(2, pcall(os.difftime))`),
    "bad argument #1 to 'difftime' (number expected, got no value)",
  );
  assert.equal(
    text(`select(2, pcall(os.time, {year=2000, month=1}))`),
    "field 'day' missing in date table",
  );
  assert.equal(
    text(`select(2, pcall(os.setlocale, nil, 'bad'))`),
    "bad argument #2 to 'setlocale' (invalid option 'bad')",
  );
  for (const code of [
    `os.date('!%c', ${t})`,
    `os.date('!%Z', ${t})`,
    `os.date('%Y', -1)`,
    `os.time{year=2000, month=1, day=1, isdst=false}`,
    `os.clock()`,
    `os.exit()`,
    `os.remove('a')`,
    `os.rename('a', 'b')`,
    `os.tmpname()`,
    `os.setlocale('')`,
  ])
    assert.throws(() => run(code), /Unsupported Artemis/, code);
  // The hidden engine methods are not left on the engine table.
  assert.equal(
    run(`rawget(engine, 'artemisOsDate') == nil and rawget(engine, 'artemisOsUnsupported') == nil`),
    true,
  );
  // Without a platform, commands and the environment are refused.
  const bare = new ArtemisLua(base);
  bare.vm.execute(new TextEncoder().encode(`probe_out = os.date('!%Y', 0 + ${t})`), 'probe');
  assert.equal(luaText(bare.vm.getGlobal('probe_out')), '2001');
  for (const code of [`os.execute()`, `os.getenv('PATH')`])
    assert.throws(
      () => bare.vm.execute(new TextEncoder().encode(code), 'probe'),
      /Unsupported Artemis Lua os/,
    );
});

test('Rev.3257 indentmodify reaches its owner, records history without a replay slot and exposes depth', async () => {
  const {ArtemisTextBreakControls} = await import('../dist/engines/artemis/text-break-controls.js');
  const {ArtemisVariables} = await import('../dist/engines/artemis/variables.js');
  const {artemisNativeTagNamesForExecutable} =
    await import('../dist/engines/artemis/native-tags.js');
  const {
    ARTEMIS_3257_EXECUTABLE_SHA256: newHash,
    ARTEMIS_3179_EXECUTABLE_SHA256: oldHash,
    artemisRevision,
  } = await import('../dist/engines/artemis/revision.js');
  const history = [],
    replay = [],
    counts = [];
  const host = {
    currentMessageLayer: () => '1',
    unindent: (n) => counts.push(n),
    recordTextCommand: (id, tag) => history.push([id, tag]),
    rememberTextCommand: (...args) => replay.push(args),
  };
  const tag = {
    kind: 'tag',
    name: 'indentmodify',
    sourceLine: 0,
    args: new Map([['unindent', '-1']]),
  };
  const modern = new ArtemisTextBreakControls(host, artemisRevision(newHash).indentModify);
  assert.equal(modern.dispatch(tag), true);
  assert.deepEqual(counts, [-1]);
  assert.equal(history.length, 1);
  assert.equal(replay.length, 0);
  modern.dispatch(tag, false);
  assert.deepEqual(counts, [-1, -1]);
  assert.equal(history.length, 1);
  assert.equal(
    new ArtemisTextBreakControls(host, artemisRevision(oldHash).indentModify).dispatch(tag),
    false,
  );
  for (const [hash, expected] of [
    [newHash, 1],
    [oldHash, 0],
  ]) {
    const unknown = [],
      seen = [];
    const lua = new ArtemisLua({readFile: () => null, variable: () => bytes('0'), tag: () => {}});
    const script = new ArtemisScript(lua, {
      nativeTagNames: artemisNativeTagNamesForExecutable(hash),
      emptyReturn: () => 'stopped',
      readFile: () => bytes('[indentmodify unindent=-1]'),
      dispatch: (t) => seen.push(t.name),
      reportUnknownTag: (r) => unknown.push(r),
    });
    script.load('synthetic.iet');
    script.run(20);
    assert.equal(seen.length, expected);
    assert.equal(unknown.length, 1 - expected);
    lua.close();
  }
  const variables = new ArtemisVariables({
    stageSize: () => ({width: 1, height: 1}),
    messageLayerIndentationDepth: () => 3,
  });
  variables.dispatch({
    kind: 'tag',
    name: 'var',
    sourceLine: 0,
    args: new Map([
      ['name', 'depth'],
      ['system', 'get_message_layer_indent_nest'],
    ]),
  });
  assert.equal(luaText(variables.read('depth')), '3');
  const older = new ArtemisVariables({stageSize: () => ({width: 1, height: 1})});
  older.write('depth', 'keep');
  older.dispatch({
    kind: 'tag',
    name: 'var',
    sourceLine: 0,
    args: new Map([
      ['name', 'depth'],
      ['system', 'get_message_layer_indent_nest'],
    ]),
  });
  assert.equal(luaText(older.read('depth')), 'keep');
});

test('Noise shader reads background UV2, offsets both axes equally and respects a missing back texture', async () => {
  const {artemisNoiseShade} = await import('../dist/engines/artemis/noise-shader.js');
  const samples = [];
  const sample = (x, y) => {
    samples.push([x, y]);
    return [0.2, 0.4, 0.6, 0.8];
  };
  const result = artemisNoiseShade(sample, 0.25, 0.5, {alpha: 0.5, size: 0});
  assert.deepEqual(samples, [[0.25, 0.5]]);
  assert.deepEqual(result.slice(0, 3), [0.2, 0.4, 0.6]);
  assert.ok(Math.abs(result[3] - 0.4) < 1e-7);
  artemisNoiseShade(sample, 0.25, 0.5, {alpha: 1, size: 0.1});
  assert.ok(samples[1][0] >= 0.25 && samples[1][0] <= 0.35);
  assert.ok(Math.abs(samples[1][0] - 0.25 - (samples[1][1] - 0.5)) < 1e-7);
  const {createArtemisDrawShaderPreset} = await import('../dist/engines/artemis/draw-shader.js');
  const {ARTEMIS_3257_EXECUTABLE_SHA256: hash} =
    await import('../dist/engines/artemis/revision.js');
  const ordinary = createArtemisDrawShaderPreset(hash, 'noise');
  const captured = createArtemisDrawShaderPreset(hash, 'noise', 1);
  assert.equal(captured.needsUserTexture, false);
  assert.match(captured.fragment, /texture\(additionalAtlas0,uv\)/);
  assert.match(captured.fragment, /dot\(additionalUV0/);
  assert.ok(!ordinary.fragment.includes('texture(additionalAtlas'));
  assert.match(ordinary.fragment, /vec4\(0.0\)/);
});

test('Diagonal blur averages four RGB samples and retains the center alpha before adding them', async () => {
  const {artemisDiagonalBlurShade} = await import('../dist/engines/artemis/blur-shader.js');
  const samples = [];
  const pixel = artemisDiagonalBlurShade(
    (x, y) => {
      samples.push([x, y]);
      return [x, y, 0.6, 0.8];
    },
    0.5,
    0.5,
    {alpha: 0.5, offset: 0.25, size: 1},
  );
  assert.deepEqual(samples, [
    [0.5, 0.5],
    [0.75, 0.75],
    [0.25, 0.75],
    [0.25, 0.25],
    [0.75, 0.25],
  ]);
  assert.equal(pixel[0], 0.5);
  assert.equal(pixel[1], 0.5);
  assert.ok(Math.abs(pixel[2] - 0.6) < 1e-7);
  assert.ok(Math.abs(pixel[3] - 0.8) < 1e-7);
  for (const [kind, expected] of [
    [
      'blur_pair_h',
      [
        [0.5, 0.5],
        [0.75, 0.5],
        [0.25, 0.5],
      ],
    ],
    [
      'blur_pair_v',
      [
        [0.5, 0.5],
        [0.5, 0.75],
        [0.5, 0.25],
      ],
    ],
  ]) {
    const seen = [];
    const pair = artemisDiagonalBlurShade(
      (x, y) => {
        seen.push([x, y]);
        return [x, y, 0.6, 0.8];
      },
      0.5,
      0.5,
      {alpha: 0.5, offset: 0.25, size: 1},
      kind,
    );
    assert.deepEqual(seen, expected);
    assert.deepEqual(pair.slice(0, 2), [0.5, 0.5]);
    assert.ok(Math.abs(pair[3] - 0.8) < 1e-7);
  }
  assert.throws(
    () => artemisDiagonalBlurShade(() => [0, 0, 0, 0], 0, 0, {alpha: 1, offset: NaN, size: 1}),
    /Invalid/,
  );
  const {createArtemisDrawShaderPreset} = await import('../dist/engines/artemis/draw-shader.js');
  const {ARTEMIS_3257_EXECUTABLE_SHA256: hash} =
    await import('../dist/engines/artemis/revision.js');
  assert.deepEqual(
    [
      ...createArtemisDrawShaderPreset(hash, 'blur_diag').nativeParameters([
        {name: 'a', values: [0.25]},
        {name: 'b', values: [2]},
      ]),
    ].slice(0, 2),
    [0.25, 2],
  );
});

test('Premultiplied kawase blurs scale each accumulated sample, colour included, by alpha', async () => {
  const {artemisDiagonalBlurShade, artemisOffsetBlurFragmentSource} =
    await import('../dist/engines/artemis/blur-shader.js');
  const sample = (x, y) => [x, y, 0.6, 0.8];
  const p = {alpha: 0.5, offset: 0.25, size: 0.5};
  for (const base of ['blur_k', 'blur_kx', 'blur_ky']) {
    const plain = artemisDiagonalBlurShade(sample, 0.5, 0.25, p, base);
    const scaled = artemisDiagonalBlurShade(sample, 0.5, 0.25, p, `${base}_premultiplied`);
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(scaled[i] - plain[i] * 0.5) < 1e-7, base);
    assert.ok(Math.abs(scaled[3] - plain[3]) < 1e-7, base);
    const source = artemisOffsetBlurFragmentSource(`${base}_premultiplied`);
    assert.match(source, /\*uAlpha;/);
    assert.doesNotMatch(source, /c\.a\*=uAlpha/);
    assert.match(artemisOffsetBlurFragmentSource(base), /c\.a\*=uAlpha/);
  }
});

test('Perspective shader preserves identity, warps UVs, clips X and fades the native Y edges', async () => {
  const {artemisPerspectiveShade} = await import('../dist/engines/artemis/perspective-shader.js');
  const p = {alpha: 0.5, centerX: 0.5, centerY: 0.9, scale: 1, fade: 0.1};
  const sample = (x, y) => [x, y, 0.3, 0.8];
  const identity = artemisPerspectiveShade(sample, 0.25, 0.5, p);
  assert.deepEqual(identity.slice(0, 3), [0.25, 0.5, 0.3]);
  assert.ok(Math.abs(identity[3] - 0.4) < 1e-7);
  const warped = artemisPerspectiveShade(sample, 0.6, 0.6, {...p, scale: 0.5});
  assert.ok(Math.abs(warped[0] - 0.7) < 1e-7);
  assert.ok(Math.abs(warped[1] - 0.6052631578947368) < 1e-7);
  assert.equal(artemisPerspectiveShade(sample, 0.2, 0.5, {...p, scale: 0.5})[3], 0);
  assert.ok(Math.abs(artemisPerspectiveShade(sample, 0.5, -0.05, p)[3] - 0.2) < 1e-7);
  assert.ok(Math.abs(artemisPerspectiveShade(sample, 0.5, 0.95, p)[3] - 0.2) < 3e-7);
  assert.deepEqual(artemisPerspectiveShade(sample, 0.25, 0.5, {...p, centerY: -12}), identity);
  assert.equal(artemisPerspectiveShade(sample, 0.5, 1.1, p)[3], 0);
  const anchored = artemisPerspectiveShade(
    sample,
    0.6,
    0.6,
    {...p, scale: 0.5, centerY: 0.3},
    'perspective_anchored',
  );
  assert.ok(Math.abs(anchored[1] - 0.5857142857142857) < 1e-7);
  assert.ok(artemisPerspectiveShade(sample, 1.2, 0.5, p, 'perspective_anchored')[3] > 0);
  assert.equal(artemisPerspectiveShade(sample, 1.2, 0.5, p)[3], 0);
  const vertical = artemisPerspectiveShade(
    sample,
    0.6,
    0.6,
    {...p, scale: 0.5, centerY: 0.5},
    'perspective_vertical',
  );
  assert.ok(Math.abs(vertical[0] - 0.6052631578947368) < 1e-7);
  assert.ok(Math.abs(vertical[1] - 0.7) < 1e-7);
  const verticalAnchored = artemisPerspectiveShade(
    sample,
    0.6,
    0.6,
    {...p, scale: 0.5, centerX: 0.3, centerY: 0.5},
    'perspective_vertical_anchored',
  );
  assert.ok(Math.abs(verticalAnchored[0] - 0.5857142857142857) < 1e-7);
  assert.equal(artemisPerspectiveShade(sample, 0.5, 1.2, p, 'perspective_vertical_anchored')[3], 0);
  const {createArtemisDrawShaderPreset} = await import('../dist/engines/artemis/draw-shader.js');
  const {ARTEMIS_3257_EXECUTABLE_SHA256: hash} =
    await import('../dist/engines/artemis/revision.js');
  const adapter = createArtemisDrawShaderPreset(hash, 'perspective');
  // Native fields are concatenated in order; the unused second field still occupies a slot.
  assert.deepEqual(
    [
      ...adapter.nativeParameters([
        {name: 'a', values: [0.5]},
        {name: 'b', values: [0.9]},
        {name: 'c', values: [1]},
        {name: 'd', values: [0.1]},
      ]),
    ].slice(0, 4),
    [0.5, Math.fround(0.9), 1, Math.fround(0.1)],
  );
  assert.match(adapter.fragment, /float uScale=parameters\[0\]\.z/);
});

test('Artemis runtime selects native load and exit modes by exact revision without changing older modes', async () => {
  const {openArtemisRuntimeFixture} = await import('./artemis-runtime-fixture.mjs');
  const {
    artemisRevision,
    ARTEMIS_3179_EXECUTABLE_SHA256,
    ARTEMIS_3139_EXECUTABLE_SHA256,
    ARTEMIS_3257_EXECUTABLE_SHA256,
    ARTEMIS_3248_EXECUTABLE_SHA256,
  } = await import('../dist/engines/artemis/revision.js');
  for (const [hash, loadMode, exitMode] of [
    [ARTEMIS_3179_EXECUTABLE_SHA256, 13, 14],
    [ARTEMIS_3139_EXECUTABLE_SHA256, 13, 14],
    [ARTEMIS_3257_EXECUTABLE_SHA256, 14, 15],
    [ARTEMIS_3248_EXECUTABLE_SHA256, 14, 15],
  ]) {
    assert.deepEqual(
      [artemisRevision(hash).loadRunMode, artemisRevision(hash).exitRunMode],
      [loadMode, exitMode],
    );
    const fixture = await openArtemisRuntimeFixture({'system/first.iet': '[stop]'}, {hash});
    try {
      const {runtime} = fixture;
      await runtime.boot();
      runtime.save.request('synthetic.dat');
      await runtime.flushSaves();
      fixture.effects.length = 0;
      assert.equal(await runtime.load.load('synthetic.dat', false), true);
      assert.ok(fixture.effects.some((e) => e.runMode === loadMode));
      assert.equal(runtime.runMode, 3);
      assert.equal(runtime.exited, false);
      runtime.lua.vm.execute(
        new TextEncoder().encode(`engine:setScriptStatus(${loadMode}); engine:tag{'exit'}`),
      );
      assert.equal(runtime.runMode, loadMode);
      assert.equal(runtime.exited, false);
      runtime.lua.vm.execute(
        new TextEncoder().encode("engine:setScriptStatus(0); engine:tag{'exit'}"),
      );
      assert.equal(runtime.runMode, exitMode);
      assert.equal(runtime.exited, true);
      await runtime.flushSaves();
      assert.ok(fixture.saves.has('saveg.dat'));
    } finally {
      await fixture.close();
    }
  }
});

test('Artemis runtime lets Lua read sound-loop sidecars synchronously with exact bytes', async () => {
  const {openArtemisRuntimeFixture} = await import('./artemis-runtime-fixture.mjs');
  const fixture = await openArtemisRuntimeFixture({
    'system/first.iet': '[stop]',
    'sound/loop.ogg.sli': Uint8Array.of(0, 255, 13, 10, 49, 50),
    'sound/empty.ogg.sli': new Uint8Array(),
    'sound/loop.ogg': Uint8Array.of(79, 103, 103, 83),
  });
  try {
    await fixture.runtime.boot();
    fixture.runtime.lua.vm.execute(
      new TextEncoder().encode(
        `local e=engine
       assert(e:file('SOUND\\\\loop.ogg.sli')==string.char(0,255,13,10,49,50))
       assert(e:file('sound/empty.ogg.sli')=='')
       assert(e:file('sound/missing.ogg.sli')==nil)`,
      ),
    );
    // Binary audio stays lazy; adding sidecars must not preload the media corpus.
    assert.equal(fixture.runtime.prepared.has('sound/loop.ogg'), false);
  } finally {
    await fixture.close();
  }
});

test('Artemis CSIDL saves use the mounted virtual folder for publication, writes and reads', async () => {
  const {openArtemisRuntimeFixture} = await import('./artemis-runtime-fixture.mjs');
  const {VirtualWindowsFolderPaths, joinVirtualWindowsDirectory} =
    await import('../dist/platform/windows-folder-path.js');
  const folderPaths = new VirtualWindowsFolderPaths(new Map([[26, 'virtual/roaming']]));
  const fixture = await openArtemisRuntimeFixture(
    {
      'system.ini':
        '[WINDOWS]\nWIDTH=640\nHEIGHT=360\nBOOT=system/first.iet\nSAVEPATH=.\\sub\\child\\..\\saves\nSAVEPATH_CSIDL=26\n',
      'system/first.iet':
        '[file command="copy" src="input.dat" dst="virtual/roaming/sub/saves/payload.dat"]\n[var name="t.exists" system="file_exists" file="virtual/roaming/sub/saves/payload.dat"]\n[stop]',
      'input.dat': Uint8Array.of(17, 29, 41),
    },
    {services: {folderPaths}},
  );
  try {
    await fixture.runtime.boot();
    for (let i = 0; i < 8 && fixture.runtime.resourcePending; i++) {
      await fixture.runtime.settleResource();
      fixture.runtime.script.run(1000);
    }
    assert.equal(
      new TextDecoder().decode(fixture.runtime.variables.read('s.savepath')),
      'virtual/roaming/sub/saves',
    );
    assert.equal(new TextDecoder().decode(fixture.runtime.variables.read('t.exists')), '1');
    assert.deepEqual([...fixture.saves.get('payload.dat')], [17, 29, 41]);
    assert.deepEqual(
      [
        ...(await fixture.runtime.readSaveDirectoryFile(
          'virtual\\roaming\\sub\\saves\\payload.dat',
        )),
      ],
      [17, 29, 41],
    );
    assert.equal(fixture.runtime.readSaveDirectoryFile('installation/payload.dat'), undefined);
    assert.equal(folderPaths.folderPath(12345), null);
    assert.equal(
      joinVirtualWindowsDirectory('virtual/roaming', './子/./saves'),
      'virtual/roaming/子/saves',
    );
    assert.throws(() => joinVirtualWindowsDirectory('virtual/roaming', '../outside'), /escapes/);
    assert.throws(
      () => joinVirtualWindowsDirectory('virtual/roaming', 'C:\\outside'),
      /explicit virtual mount/,
    );
  } finally {
    await fixture.close();
  }
});

test('Artemis runtime reports missing seplay and splay sounds like c7260 and continues', async () => {
  const {openArtemisRuntimeFixture} = await import('./artemis-runtime-fixture.mjs');
  const {artemisTagErrorMessages} = await import('../dist/engines/artemis/native-tags.js');
  const first =
    '[seplay id="1" file=":missing/se.ogg" gain="500"]\n[splay file="missing/bgm.ogg"]\n[var name="t.done" data="1"]\n[stop]';
  const reports = [];
  const {runtime, close} = await openArtemisRuntimeFixture(
    {'system/first.iet': first},
    {services: {reportTagError: (report) => reports.push(report)}},
  );
  await runtime.boot();
  for (let i = 0; i < 8 && runtime.resourcePending; i++) {
    await runtime.settleResource();
    runtime.script.run(1000);
  }
  assert.deepEqual(
    reports.map(({file, tag, message, severity}) => [
      file,
      tag.name,
      tag.sourceLine,
      message,
      severity,
    ]),
    [
      ['system/first.iet', 'seplay', 0, artemisTagErrorMessages.soundNotLoaded, 1],
      ['system/first.iet', 'splay', 1, artemisTagErrorMessages.soundNotLoaded, 1],
    ],
  );
  assert.equal(new TextDecoder().decode(runtime.variables.read('t.done')), '1');
  // [stop]: run mode 3.
  assert.equal(runtime.runMode, 3);
  await close();
  // The owner without a report service keeps the failure strict.
  const strict = await openArtemisRuntimeFixture({'system/first.iet': first});
  await strict.runtime.boot();
  await assert.rejects(async () => {
    for (let i = 0; i < 8 && strict.runtime.resourcePending; i++) {
      await strict.runtime.settleResource();
      strict.runtime.script.run(1000);
    }
  }, /Artemis sound load failed/);
  await strict.close();
});

test('Artemis runtime reports a missing or non-gray trans rule like c7260 and continues', async () => {
  const {openArtemisRuntimeFixture} = await import('./artemis-runtime-fixture.mjs');
  const {artemisTransitionErrors} = await import('../dist/engines/artemis/transition.js');
  const {png} = await import('./png-fixtures.mjs');
  // 0x1400e10c0: a rule that fails to load reports 0x1403723c8; a rule that is not gray
  // (format 0) reports 0x140372420. Both return without a transition.
  const first =
    '[trans type="2" time="100" rule="rule/missing"]\n[trans type="2" time="100" rule="rule/rgba"]\n[var name="t.done" data="1"]\n[stop]';
  const files = {
    'system/first.iet': first,
    'rule/rgba.png': png({width: 1, height: 1, raw: Buffer.from([0, 1, 2, 3, 4])}),
  };
  const reports = [];
  const {runtime, close} = await openArtemisRuntimeFixture(files, {
    services: {reportTagError: (report) => reports.push(report)},
  });
  await runtime.boot();
  for (let i = 0; i < 8 && runtime.resourcePending; i++) {
    await runtime.settleResource();
    runtime.script.run(1000);
  }
  assert.deepEqual(
    reports.map(({file, tag, message, severity}) => [
      file,
      tag.name,
      tag.sourceLine,
      message,
      severity,
    ]),
    [
      ['system/first.iet', 'trans', 0, artemisTransitionErrors.ruleLoad, 1],
      ['system/first.iet', 'trans', 1, artemisTransitionErrors.ruleFormat, 1],
    ],
  );
  assert.equal(new TextDecoder().decode(runtime.variables.read('t.done')), '1');
  assert.equal(runtime.runMode, 3);
  await close();
  // The owner without a report service keeps the failure strict.
  const strict = await openArtemisRuntimeFixture(files);
  await strict.runtime.boot();
  await assert.rejects(async () => {
    for (let i = 0; i < 8 && strict.runtime.resourcePending; i++) {
      await strict.runtime.settleResource();
      strict.runtime.script.run(1000);
    }
  }, /Unsupported Artemis trans error report/);
  await strict.close();
});

test('CIni sections, keys and values follow the native tokenizer', async () => {
  const {ArtemisIni, artemisAtoi} = await import('../dist/engines/artemis/ini.js');
  const text = [
    'top = 1',
    '; comment = 9',
    '[FONT]',
    '  KEY   =  a b  \r',
    'SPLIT',
    'KEY = 2',
    'esc\\=aped = 3',
    'value = x\\y ; z',
    '[OTHER]',
    'KEY = 4',
    '[FONT]',
    'LAST = 5',
    'ＫＥＹ = ６',
    'TAIL',
  ].join('\n');
  const ini = ArtemisIni.parse(new TextEncoder().encode(text));
  const get = (section, key) => new TextDecoder().decode(ini.get(section, key));
  assert.equal(get('', 'top'), '1');
  assert.equal(get('', 'comment'), '');
  // The repeated [FONT] section replaces the first one whole.
  assert.equal(get('FONT', 'KEY'), '');
  assert.equal(get('FONT', 'LAST'), '5');
  assert.equal(get('FONT', 'ＫＥＹ'), '６');
  assert.equal(get('FONT', 'TAIL'), '');
  assert.equal(get('OTHER', 'KEY'), '4');
  const first = ArtemisIni.parse(new TextEncoder().encode(text.split('[OTHER]')[0]));
  const value = (key) => new TextDecoder().decode(first.get('FONT', key));
  assert.equal(value('KEY'), 'a b');
  // A key without `=` runs on over the line end; `\` escapes key bytes only.
  assert.equal(value('SPLIT\nKEY'), '2');
  assert.equal(value('esc=aped'), '3');
  assert.equal(value('value'), 'x\\y ; z');
  assert.deepEqual(
    [' 42x', '-7', '+', '99999999999', '\t-99999999999'].map((v) =>
      artemisAtoi(new TextEncoder().encode(v)),
    ),
    [42, -7, 0, 0x7fffffff, -0x80000000],
  );
});

test('var url, file and font queries follow the native handler', async () => {
  const {ArtemisVariables} = await import('../dist/engines/artemis/variables.js');
  const {enumerateGdiFontFamiliesW} = await import('../dist/text/gdi-font-families.js');
  const pack = new Map([
    ['a.dat', new TextEncoder().encode('123456789')],
    ['b.dat', new TextEncoder().encode('f157')],
  ]);
  const saves = new Map([['s.dat', new Uint8Array(1)]]);
  const reads = [];
  // Families as EnumFontFamiliesExW reports them from three installed faces.
  const name = (unicode, language) => ({id: 1, platform: 3, language, unicode});
  const face = (family, fixedPitch, pages, names = []) => ({
    family,
    fullName: family,
    postscriptName: family,
    data: {fixedPitch, codePageRanges: [pages, 0], names},
  });
  const sjis = 1 << 17;
  const families = [
    ...enumerateGdiFontFamiliesW(
      [
        face('Zeta', false, sjis | 1),
        face('MS Gothic', true, sjis, [name('MS Gothic', 0x409), name('ＭＳ ゴシック', 0x411)]),
        face('Alpha', true, sjis),
        face('Latin', true, 1),
        face('L'.repeat(40), true, sjis),
      ],
      true,
    ),
    // Not TrueType: left out.
    {name: 'Raster', charset: 0x80, fixedPitch: true, fontType: 1},
  ];
  const variables = new ArtemisVariables({
    stageSize: () => ({width: 1, height: 1}),
    readPackFile: async (path) => (reads.push(['pack', path]), pack.get(path) ?? null),
    readSaveFile: async (path) => (reads.push(['save', path]), saves.get(path) ?? null),
    fontFamilies: async () => families,
  });
  const query = (system, args, bytes) =>
    variables.dispatch({
      kind: 'tag',
      name: 'var',
      sourceLine: -1,
      args: new Map([['name', 'v'], ['system', system], ...args]),
      bytes,
    });
  const bytes = (name) => [...variables.read(name)];
  const text = (name) => new TextDecoder().decode(variables.read(name));

  // RFC 3986 unreserved bytes stay; the source ends at its first NUL.
  const source = Uint8Array.from([0x41, 0x20, 0xc3, 0xa9, 0x7e, 0x2f, 0x5f, 0x2d, 0x2e, 0, 0x41]);
  assert.equal(query('url_encode', [['source', '']], new Map([['source', source]])), true);
  assert.equal(text('v'), 'A%20%C3%A9~%2F_-.');
  // `+` is a space; each escape is strtol base 16 of two bytes, cut to a byte.
  query('url_decode', [['source', 'a+%41%e3%81%82%zz% 5%-1%0x']]);
  assert.deepEqual(bytes('v'), [0x61, 0x20, 0x41, 0xe3, 0x81, 0x82, 0, 5, 0xff, 0]);
  assert.throws(() => query('url_decode', [['source', 'x%4']]), /url_decode escape/);

  // file_exists/file_exist: 1 or 0 through the integer setter; `save` reads SaveDataPath.
  const exists = query('file_exist', [['file', 'a.dat']]);
  assert.ok(exists instanceof Promise);
  await exists;
  assert.equal(text('v'), '1');
  await query('file_exists', [
    ['file', 'c.dat'],
    ['save', '0'],
  ]);
  assert.equal(text('v'), '0');
  await query('file_exists', [
    ['file', 's.dat'],
    ['save', '1'],
  ]);
  assert.equal(text('v'), '1');
  await query('file_exist', [
    ['file', 'a.dat'],
    ['save', 'yes'],
  ]);
  assert.equal(text('v'), '0');

  // file_crc: CRC-32 as %x, %X with `caps`, 0x with `zerox`; no zero padding.
  await query('file_crc', [['file', 'a.dat']]);
  assert.equal(text('v'), 'cbf43926');
  await query('file_crc', [
    ['file', 'a.dat'],
    ['caps', '1'],
    ['zerox', '1'],
  ]);
  assert.equal(text('v'), '0xCBF43926');
  await query('file_crc', [
    ['file', 'b.dat'],
    ['caps', '0'],
    ['zerox', '1'],
  ]);
  assert.equal(text('v'), '0x2c9fdd');
  await query('file_crc', [['file', 'missing']]);
  assert.equal(bytes('v').length, 0);
  assert.deepEqual(reads, [
    ['pack', 'a.dat'],
    ['pack', 'c.dat'],
    ['save', 's.dat'],
    ['save', 'a.dat'],
    ['pack', 'a.dat'],
    ['pack', 'a.dat'],
    ['pack', 'b.dat'],
    ['pack', 'missing'],
  ]);

  // get_font: TrueType Shift-JIS families once each in UTF-8 byte order; `@` faces only
  // with `vertical`; LOGFONTW names keep 31 UTF-16 units.
  const fonts = async (args) => {
    await query('get_font', args);
    const size = Number(text('v.size'));
    return Array.from({length: size}, (_, index) => text(`v.${index}`));
  };
  const long = 'L'.repeat(31);
  assert.deepEqual(await fonts([]), ['Alpha', long, 'Zeta', 'ＭＳ ゴシック']);
  assert.deepEqual(await fonts([['monospace', '1']]), ['Alpha', long, 'ＭＳ ゴシック']);
  assert.deepEqual(
    await fonts([
      ['vertical', '1'],
      ['monospace', '0'],
    ]),
    ['@Alpha', '@' + 'L'.repeat(30), '@Zeta', '@ＭＳ ゴシック'],
  );
  assert.deepEqual(await fonts([['vertical', '0']]), ['Alpha', long, 'Zeta', 'ＭＳ ゴシック']);
});

test('Browser Lua compatibility requires both exact identities and leaves unknown or absent modules alone', async () => {
  const {prepareArtemisLuaCompatibility: prepare} = await import('../ui/game-profiles/artemis.ts');
  const {createHash} = await import('node:crypto');
  const source = bytes(
    '\ufeff-- 合成\r\nfunction gate()\r\n  error("BLOCKED")\r\nend\r\n-- retained helper\r\nfunction helper() return 42 end\r\n',
  );
  const before = source.slice();
  const policy = [
    {
      executableSha256: 'verified-exe',
      path: 'system/check.lua',
      sourceSha256: createHash('sha256').update(source).digest('hex'),
      begin: 'function gate()',
      end: 'function helper()',
      replacement: 'function gate()\nend\n',
    },
  ];
  const reads = [];
  assert.equal(
    (
      await prepare(
        'other-exe',
        async (p) => {
          reads.push(p);
          return source;
        },
        policy,
      )
    ).size,
    0,
  );
  assert.equal(reads.length, 0);
  assert.equal((await prepare('verified-exe', async () => null, policy)).size, 0);
  assert.equal(
    (await prepare('verified-exe', async () => bytes('unprotected edition'), policy)).size,
    0,
  );
  const overrides = await prepare('verified-exe', async () => source, policy);
  const rewritten = new TextDecoder('utf-8', {ignoreBOM: true}).decode(
    overrides.get('system/check.lua'),
  );
  assert.ok(rewritten.startsWith('\ufeff-- 合成\r\nfunction gate()\nend\n'));
  assert.ok(rewritten.endsWith('function helper() return 42 end\r\n'));
  assert.equal(rewritten.split('\n').length, new TextDecoder().decode(source).split('\n').length);
  assert.ok(!rewritten.includes('BLOCKED'));
  assert.deepEqual(source, before);
});

test('Lua-only host substitutions survive plain/packed repeated includes while raw file and CRC reads stay original', async () => {
  const {prepareArtemisLuaCompatibility: prepare} = await import('../ui/game-profiles/artemis.ts');
  const {openArtemisRuntimeFixture} = await import('./artemis-runtime-fixture.mjs');
  const {createHash} = await import('node:crypto');
  const {crc32} = await import('../dist/core/crc32.js');
  const source = bytes(
    'included=(included or 0)+1\nfunction gate()\n error("BLOCKED")\nend\nfunction helper() return 42 end\n',
  );
  const overrides = await prepare('fixture-exe', async () => source, [
    {
      executableSha256: 'fixture-exe',
      path: 'system/check.lua',
      sourceSha256: createHash('sha256').update(source).digest('hex'),
      begin: 'function gate()',
      end: 'function helper()',
      replacement: 'function gate()\nend\n',
    },
  ]);
  for (const plain of [true, false]) {
    const entries = {
      'system.ini': bytes('[WINDOWS]\nWIDTH=640\nHEIGHT=360\nBOOT=system/first.iet\n'),
      'system/check.lua': source,
      'system/first.iet': bytes(`[calllua function="verify"][stop]
[lua]
function verify(e)
  e:include('system/check.lua')
  gate()
  assert(helper()==42)
  e:include('system/check.lua')
  gate()
  assert(included==2)
  assert(string.find(e:file('system/check.lua'),'BLOCKED',1,true))
  e:tag{'var',name='f.rawcrc',system='file_crc',file='system/check.lua'}
  verified=true
end
[/lua]`),
    };
    const fixture = await openArtemisRuntimeFixture(entries, {
      services: {
        luaSourceOverrides: overrides,
        files: {
          paths: new Set(Object.keys(entries)),
          resolvePath: (p) => p.replaceAll('\\', '/'),
          setMagicPath() {},
          read: async (p) => entries[p] ?? null,
          readPlain: async (p) => (plain ? (entries[p] ?? null) : null),
        },
      },
    });
    try {
      await fixture.runtime.boot();
      while (fixture.runtime.resourcePending) {
        await fixture.runtime.settleResource();
        fixture.runtime.script.run(100);
      }
      assert.equal(fixture.runtime.lua.vm.getGlobal('verified'), true);
      assert.equal(fixture.runtime.lua.vm.getGlobal('included'), 2);
      assert.equal(fixture.runtime.runMode, 3);
      assert.equal(
        luaText(fixture.runtime.variables.lookup('f.rawcrc')),
        crc32(source).toString(16),
      );
      assert.deepEqual(fixture.runtime.prepared.get('system/check.lua'), source);
    } finally {
      await fixture.close();
    }
  }
});

test('Source-selected DX9 multiply interpolation keeps strength, mask and transparent colors independent', async () => {
  const {artemisDx9ShaderShade} = await import('../dist/engines/artemis/dx9-shader.js');
  const {createArtemisDrawShaderPreset} = await import('../dist/engines/artemis/draw-shader.js');
  const {ARTEMIS_2908_EXECUTABLE_SHA256: hash} =
    await import('../dist/engines/artemis/revision.js');
  const fore = () => [0.2, 0.4, 0.8, 0];
  const user = () => [0.6, 0.3, 0.9, 0.5];
  for (const param of [0, 0.75, 1, 2]) {
    for (const mask of [0, 0.25, 1]) {
      const actual = artemisDx9ShaderShade('mul_lerp', fore, 0.5, 0.5, {
        param,
        alpha: 0.7,
        user,
        mask: () => [0, 0, 0, mask],
      });
      for (let i = 0; i < 3; i++)
        assert.ok(
          Math.abs(actual[i] - fore()[i] * (1 - 0.5 * param + user()[i] * 0.5 * param)) < 1e-7,
        );
      assert.equal(actual[3], 0); // RGB is defined even with zero foreground alpha.
    }
  }
  const p = {param: 0.75, alpha: 0.7, mask: () => [0, 0, 0, 0.25]};
  const actual = artemisDx9ShaderShade('mul_lerp', () => [0.2, 0.4, 0.8, 0.8], 0, 0, p);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(actual[i] - fore()[i] * 0.25) < 1e-7); // Native unbound User is opaque black.
  assert.ok(Math.abs(actual[3] - 0.8 * 0.25 * 0.7) < 1e-7);
  const preset = createArtemisDrawShaderPreset(hash, 'mul_lerp');
  assert.deepEqual(preset.fields, [{name: 'param', size: 1}]);
  const values = preset.nativeParameters([{name: 'param', values: [0.75]}], 0.7);
  assert.equal(values[0], 0.75);
  assert.equal(preset.needsUserTexture, false);
});

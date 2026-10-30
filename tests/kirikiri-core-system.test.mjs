import assert from 'node:assert/strict';
import test from 'node:test';
import {adler32} from '../dist/core/inflate.js';
import {KirikiriCore} from '../dist/engines/kirikiri/core/kirikiri-core.js';
import {
  dataPathDirectory,
  parseCommandLineOne,
  ProgramArguments,
  readConfigLines,
} from '../dist/engines/kirikiri/core/options.js';
import {
  osName,
  splitRegistryPath,
  toActualColor,
} from '../dist/engines/kirikiri/core/classes/system.js';
import {KIRIKIRI_CORE_REVISIONS} from '../dist/engines/kirikiri/revision.js';
import {NativeFunction} from '../dist/engines/kirikiri/tjs2/runtime/native.js';
import * as V from '../dist/engines/kirikiri/tjs2/runtime/variant.js';
import {defaultWindowsSysColor} from '../dist/platform/windows-system-colors.js';
import {buildXp3} from './kirikiri-xp3-fixtures.mjs';

class MemoryFiles {
  constructor(entries) {
    this.files = new Map(Object.entries(entries).map(([k, v]) => [k.toLowerCase(), v]));
  }
  exists(local) {
    return this.files.has(local.toLowerCase());
  }
  list(dir) {
    const d = dir.toLowerCase();
    return [...this.files.keys()]
      .filter((k) => k.startsWith(d) && !k.slice(d.length).includes('\\'))
      .map((k) => k.slice(d.length));
  }
  async open(local) {
    const bytes = this.files.get(local.toLowerCase());
    return {size: bytes.length, read: async (o, n) => bytes.slice(o, o + n)};
  }
  write(local, data) {
    this.files.set(local.toLowerCase(), data);
  }
}

/** A message loop the test drives: posted and idle tasks run on `flush`, timers on `advance`. */
class ManualLoop {
  posts = [];
  idles = [];
  timers = new Set();
  now = 0;
  post(task) {
    this.posts.push(task);
  }
  idle(task) {
    this.idles.push(task);
  }
  every(interval, tick) {
    const t = {due: this.now + interval, interval, tick};
    this.timers.add(t);
    return () => this.timers.delete(t);
  }
  after(delay, task) {
    const t = {due: this.now + delay, interval: 0, tick: task};
    this.timers.add(t);
    return () => this.timers.delete(t);
  }
  /** Runs posted tasks (not idle passes) until none are left, letting top-level calls finish. */
  async flush(core) {
    for (let i = 0; i < 100; i++) {
      await core.events.runTopLevel(() => 0);
      const tasks = this.posts.splice(0);
      if (!tasks.length) return;
      for (const t of tasks) t();
    }
  }
  /** One idle pass. */
  async idlePass(core) {
    const tasks = this.idles.splice(0);
    for (const t of tasks) t();
    await this.flush(core);
  }
  /** Advances the clock, firing due timers in order. */
  async advance(core, ms) {
    const end = this.now + ms;
    for (;;) {
      const due = [...this.timers].filter((t) => t.due <= end).sort((a, b) => a.due - b.due)[0];
      if (!due) break;
      this.now = due.due;
      if (due.interval) due.due += due.interval;
      else this.timers.delete(due);
      due.tick();
      await this.flush(core);
    }
    this.now = end;
    await this.flush(core);
  }
}

/** Boots a core whose startup.tjs is `startup`; the global `log(…)` collects lines. */
async function boot(startup, {system = {}, commandLine = [], files: extra = {}} = {}) {
  const plain = new TextEncoder().encode('\ufeff' + startup);
  const data = buildXp3([
    {name: 'startup.tjs', adler: adler32(plain), segments: [{bytes: plain, compress: true}]},
  ]);
  const loop = new ManualLoop();
  const lines = [];
  const boxes = [];
  let exitCode = null;
  const core = await KirikiriCore.create({
    revision: [...KIRIKIRI_CORE_REVISIONS.values()][0],
    executablePath: 'c:\\game\\game.exe',
    uiLanguage: 0x0409,
    files: new MemoryFiles({
      'c:\\game\\game.exe': new Uint8Array(0),
      'c:\\game\\data.xp3': data,
      ...extra,
    }),
    libraries: [],
    clock: {
      tickCount: () => loop.now,
      time: () => 0,
      localTime: () => ({hours: 1, minutes: 2, seconds: 3}),
    },
    commandLine,
    specialFolders: {appData: 'c:\\users\\me\\appdata\\roaming'},
    loop,
    output: (line) => lines.push(line.slice(9)),
    system: {
      informationBox: async (text, caption) => void boxes.push(`${caption}: ${text}`),
      ...system,
    },
    showError: async (text) => void boxes.push(`error: ${text}`),
    onExit: (code) => (exitCode = code),
    randomBits128: () => Uint8Array.from({length: 16}, (_, i) => i * 17),
  });
  // A window keeps the core running after start-up.
  core.windowCount = () => 1;
  const logs = [];
  core.engine.global.propSet(
    0x200,
    'log',
    {type: 1, object: logFunction(logs), objthis: null},
    core.engine.global,
  );
  await core.start();
  return {core, loop, logs, lines, boxes, exit: () => exitCode};
}

function logFunction(logs) {
  return new NativeFunction((_r, args) => (logs.push(args.map((a) => V.asString(a)).join(' ')), 0));
}

test('options: TJS string values, priorities, the -- stopper, data path macros', () => {
  assert.equal(parseCommandLineOne('-debugwin="\\x6E\\x6F"'), '-debugwin=no');
  assert.equal(parseCommandLineOne("-a='x' 'y'"), '-a=xy');
  assert.equal(parseCommandLineOne('-plain'), '-plain=yes');
  const args = ProgramArguments.build(
    ['-a=cmd', 'folder', '--', '-x'],
    ['a=user\n'],
    ['; comment', 'b="cf"'],
    ['a=embedded', 'c=1'],
  );
  assert.deepEqual(args.list, ['-a=cmd', '-arg0=-x', '-a=user\n', '-b=cf', '-a=embedded', '-c=1']);
  assert.equal(args.get('-a'), 'cmd');
  assert.equal(args.get('-c'), '1');
  args.set('-new', 'v');
  args.set('-c', '2');
  assert.equal(args.list[0], '-new=v');
  assert.equal(args.get('-c'), '2');
  const folders = {personal: '', appData: 'c:\\ad\\', savedGames: ''};
  assert.equal(dataPathDirectory('', 'c:\\g\\a.exe', folders, true), 'c:\\g\\savedata\\');
  assert.equal(dataPathDirectory('$(vistapath)\\x', 'c:\\g\\a.exe', folders, true), 'c:\\ad\\x\\');
  assert.equal(dataPathDirectory('$(vistapath)\\x', 'c:\\g\\a.exe', folders, false), 'c:\\g\\x\\');
  assert.equal(dataPathDirectory('$(personalpath)', 'c:\\g\\a.exe', folders, true), 'c:\\g\\');
  const decode = (b) => new TextDecoder('latin1').decode(b);
  assert.deepEqual(readConfigLines(new TextEncoder().encode('a=1\r\nb=2\x1az'), decode), [
    'a=1\n',
    'b=2',
  ]);
});

test('System helpers: colours, OS name, registry paths', () => {
  assert.equal(toActualColor(0x80000005, defaultWindowsSysColor), 0xffffff);
  assert.equal(toActualColor(0x8000000d, defaultWindowsSysColor), 0x0078d7);
  assert.equal(toActualColor(0x123456, defaultWindowsSysColor), 0x123456);
  assert.equal(toActualColor(0x01123456, defaultWindowsSysColor), 0x563412, 'byte order swapped');
  const v = {platformId: 2, major: 6, minor: 2, build: 9200, productType: 1, csdVersion: ''};
  assert.equal(osName(v), 'Windows 8 6.2.1008 ', 'build & 0xfff, as natively');
  assert.equal(osName({...v, major: 10, minor: 0}), 'Windows NT 10.0.1008 ');
  assert.deepEqual(splitRegistryPath('HKEY_LOCAL_MACHINE\\Software\\A\\v'), {
    root: 'HKEY_LOCAL_MACHINE',
    key: 'Software\\A',
    value: 'v',
  });
  assert.deepEqual(splitRegistryPath('v'), {root: 'HKEY_CURRENT_USER', key: '', value: 'v'});
});

test('System: arguments, paths, app lock, inform and readRegValue suspend', async () => {
  const reads = [];
  const {core, logs, boxes, lines} = await boot(
    `
    log(System.getArgument("-opt"), System.getArgument("-none") === void);
    System.setArgument("-opt", "changed");
    log(System.getArgument("-opt"));
    log(System.exePath, System.dataPath, System.appDataPath, System.personalPath);
    log(System.exeName, System.platformName, System.versionString);
    log(System.createAppLock("lock"), System.createAppLock("lock"));
    log(System.toActualColor(0x8000000f), typeof global.gcsAuto);
    System.inform("hello");
    System.inform("text", "caption");
    log(System.readRegValue("HKEY_LOCAL_MACHINE\\\\Software\\\\Game\\\\Path"));
    log(System.createUUID());
    log(System.title);
    System.title = "Game";
    log(System.title, System.getTickCount());
    `,
    {
      commandLine: ['-opt=cmd'],
      system: {
        readRegValue: async (root, key, value) => (reads.push([root, key, value]), 'c:\\game'),
      },
    },
  );
  assert.deepEqual(boxes, ['Information: hello', 'caption: text']);
  assert.deepEqual(reads, [['HKEY_LOCAL_MACHINE', 'Software\\Game', 'Path']]);
  assert.deepEqual(logs, [
    'cmd 1',
    'changed',
    'file://./c/game/ file://./c/game/savedata/ file://./c/users/me/appdata/roaming/ file://./c/users/me/appdata/roaming/',
    'file://./c/game/game.exe Win32 1.2.0.3',
    '1 0',
    // Without the executable there is no TVPInitTJSScript (gcsAuto, clBtnFace, …).
    '15790320 undefined',
    'c:\\game',
    '00112233-4455-4677-8899-aabbccddeeff',
    'Kirikiri',
    'Game 0',
  ]);
  assert.ok(lines.includes('(info) Data path : file://./c/game/savedata/'), lines.join('\n'));
  core.shutdown();
});

test('uncaught errors go to System.exceptionHandler, else are shown and end the core', async () => {
  const handled = await boot(`
    System.exceptionHandler = function(e) { log("handler", e.message); return true; };
    throw new Exception("boom");
  `);
  assert.deepEqual(handled.logs, ['handler boom']);
  assert.deepEqual(handled.boxes, []);
  assert.equal(handled.core.exitCode, null);
  handled.core.shutdown();

  const shown = await boot(`
    System.exceptionHandler = function(e) { return false; };
    function f() { null.x; }
    f();
  `);
  assert.equal(shown.boxes.length, 1);
  assert.match(shown.boxes[0], /^error: Script exception raised\nAccessing to null object/);
  assert.equal(shown.core.exitCode, 1);
  assert.equal(shown.exit(), 1);
  assert.ok(shown.lines.some((l) => l.startsWith('trace : ') && l.endsWith('<-- startup')));
  shown.core.shutdown();
});

test('AsyncTrigger posts onFire; cached triggers collapse; events wait while disabled', async () => {
  const {core, loop, logs} = await boot(`
    var owner = %[ action: function(ev) { log(ev.type, ev.target === global.t); } ];
    var t = new AsyncTrigger(owner);
    t.trigger(); t.trigger();
    log("posted");
    var u = new AsyncTrigger(owner, "action");
    u.cached = false;
    u.trigger(); u.trigger();
  `);
  assert.deepEqual(logs, ['posted']);
  await loop.flush(core);
  assert.deepEqual(logs, ['posted', 'onFire 1', 'onFire 0', 'onFire 0']);

  logs.length = 0;
  await core.events.runTopLevel(() =>
    core.engine.runScript(
      {
        text: 'System.eventDisabled = true; t.trigger(); log("disabled", System.eventDisabled);',
        name: '',
        lineOffset: 0,
        mode: 'statements',
      },
      null,
      null,
    ),
  );
  await loop.flush(core);
  assert.deepEqual(logs, ['disabled 1']);
  // Enabling delivers the pending events inside the setter.
  await core.events.runTopLevel(() =>
    core.engine.runScript(
      {
        text: 'System.eventDisabled = false; log("after");',
        name: '',
        lineOffset: 0,
        mode: 'statements',
      },
      null,
      null,
    ),
  );
  assert.deepEqual(logs, ['disabled 1', 'onFire 1', 'after']);
  core.shutdown();
});

test('Timer fires onTimer at its interval, up to its capacity of queued events', async () => {
  const {core, loop, logs} = await boot(`
    // A Dictionary context reads missing members as void, so globals need global.
    var owner = %[ action: function(ev) { log(ev.type, global.System.getTickCount()); } ];
    var t = new Timer(owner);
    log(t.interval, t.enabled, t.capacity);
    t.interval = 100;
    t.enabled = true;
  `);
  assert.deepEqual(logs, ['0.0152587890625 0 6']);
  logs.length = 0;
  await loop.advance(core, 250);
  // A timer is due when the tick has passed its due time; the thread sleeps at least 3 ms.
  assert.deepEqual(logs, ['onTimer 103', 'onTimer 203']);
  logs.length = 0;
  // Events stay queued while event delivery is disabled; at most `capacity` accumulate.
  core.events.setSystemEventDisabled(true);
  await loop.advance(core, 1000);
  assert.deepEqual(logs, []);
  await core.events.runTopLevel(() => core.events.setSystemEventDisabled(false));
  assert.equal(logs.length, 0, 'onTimer events are discardable: none were queued while disabled');
  await loop.advance(core, 100);
  assert.equal(logs.length, 1);
  core.shutdown();
});

test('continuous handlers run on idle passes with the tick until removed', async () => {
  const {core, loop, logs} = await boot(`
    var count = 0;
    function h(tick) { log("tick", tick); if (++count == 2) System.removeContinuousHandler(h); }
    System.addContinuousHandler(h);
    System.addContinuousHandler(h);
  `);
  // Every delivery pass calls them while they exist: the delivery posted at start-up, then
  // idle passes.
  await loop.flush(core);
  loop.now = 10;
  await loop.idlePass(core);
  loop.now = 20;
  await loop.idlePass(core);
  assert.deepEqual(logs, ['tick 0', 'tick 10']);
  assert.equal(loop.idles.length, 0, 'no idle passes without handlers');
  core.shutdown();
});

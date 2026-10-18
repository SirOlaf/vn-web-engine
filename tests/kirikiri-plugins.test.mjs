import assert from 'node:assert/strict';
import test from 'node:test';
import {adler32} from '../dist/core/inflate.js';
import {sha256} from '../dist/core/sha256.js';
import {KirikiriCore} from '../dist/engines/kirikiri/core/kirikiri-core.js';
import {KIRIKIRI_CORE_REVISIONS} from '../dist/engines/kirikiri/revision.js';
import {NativeFunction} from '../dist/engines/kirikiri/tjs2/runtime/native.js';
import * as V from '../dist/engines/kirikiri/tjs2/runtime/variant.js';
import {advapi32Library} from '../dist/native/advapi32/library.js';
import {comctl32Library} from '../dist/native/comctl32/library.js';
import {comdlg32Library} from '../dist/native/comdlg32/library.js';
import {gdi32Library} from '../dist/native/gdi32/library.js';
import {K2COMPAT} from '../dist/native/k2compat/library.js';
import {KAGPARSEREX} from '../dist/native/KAGParserEx/library.js';
import {kernel32Library} from '../dist/native/kernel32/library.js';
import {PACKINONE} from '../dist/native/PackinOne/library.js';
import {user32Library} from '../dist/native/user32/library.js';
import {WIN32DIALOG} from '../dist/native/win32dialog/library.js';
import {headlessUserInterfaceHost} from '../dist/platform/windows-user-interface.js';
import {WindowsTopLevelWindow} from '../dist/platform/windows-top-level-window.js';
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

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Boots a core whose startup.tjs is `startup` (and `storages`, name → text, in data.xp3), with the
 * plugin implementations bound to stand-in files in `plugin\`; the global `log(…)` collects
 * lines.
 */
async function boot(startup, options = {}, storages = {}) {
  const member = (name, text) => {
    const plain = new TextEncoder().encode('\ufeff' + text);
    return {name, adler: adler32(plain), segments: [{bytes: plain, compress: true}]};
  };
  const data = buildXp3([
    member('startup.tjs', startup),
    ...Object.entries(storages).map(([name, text]) => member(name, text)),
  ]);
  const files = {
    'c:\\game\\game.exe': new Uint8Array(0),
    'c:\\game\\data.xp3': data,
  };
  const plugins = [];
  for (const [name, library] of [
    ['win32dialog.dll', WIN32DIALOG],
    ['k2compat.dll', K2COMPAT],
    ['PackinOne.dll', PACKINONE],
    ['KAGParserEx.dll', KAGPARSEREX],
  ]) {
    const bytes = new TextEncoder().encode(`stand-in for ${name}`);
    files[`c:\\game\\plugin\\${name}`] = bytes;
    plugins.push({...library, identities: [{kind: 'image', sha256: hex(await sha256(bytes))}]});
  }
  const lines = [];
  const core = await KirikiriCore.create({
    revision: [...KIRIKIRI_CORE_REVISIONS.values()][0],
    executablePath: 'c:\\game\\game.exe',
    uiLanguage: 0x0411,
    files: new MemoryFiles(files),
    libraries: [
      ...plugins,
      kernel32Library({userLanguage: 0x0411}),
      gdi32Library(),
      user32Library(headlessUserInterfaceHost()),
      comctl32Library(),
      comdlg32Library(),
      advapi32Library(null),
    ],
    clock: {
      tickCount: () => 0,
      time: () => 0,
      localTime: () => ({hours: 1, minutes: 2, seconds: 3}),
    },
    // Posted tasks run; timers and idle passes do not (nothing here waits for them).
    loop: {
      post: (task) => void setImmediate(task),
      idle() {},
      every: () => () => {},
      after: () => () => {},
    },
    output: (line) => lines.push(line.slice(9)),
    system: {informationBox: async () => {}},
    showError: async (text) => void lines.push(`error: ${text}`),
    randomBits128: () => new Uint8Array(16),
    ...options,
  });
  core.windowCount = () => 1;
  const logs = [];
  const log = new NativeFunction((_r, args) => {
    logs.push(args.map((a) => V.asString(a)).join(' '));
    return 0;
  });
  core.engine.global.propSet(
    0x200,
    'log',
    {type: 1, object: log, objthis: null},
    core.engine.global,
  );
  await core.start();
  return {core, logs, lines};
}

test('win32dialog: a modal dialog from a template runs its handlers and returns', async () => {
  const {core, logs, lines} = await boot(`
    Plugins.link("win32dialog.dll");
    var W = WIN32Dialog;
    log(typeof W.Header, W.WS_POPUP, W.IDOK);
    var h = new W.Header();
    h.store(%[style: W.WS_POPUP | W.DS_SETFONT, cx: 100, cy: 40, title: "T",
              pointSize: 9, typeFace: "MS UI Gothic"]);
    h.dlgItems = 1;
    var it = new W.Items();
    it.store(%[style: W.WS_CHILD | W.WS_VISIBLE, x: 4, y: 4, cx: 50, cy: 12, id: 1000,
               windowClass: 0x81, title: "hello"]);
    class D extends WIN32Dialog {
      function D() { super.WIN32Dialog(); makeTemplate(h, it); }
      function onInit(msg, wp, lp) {
        log("init", getItemText(1000), isExistentItem(1000), isExistentItem(1001));
        setItemText(1000, "changed");
        log(getItemText(1000), getItemWidth(1000) > 0);
        close(W.IDOK);
        return true;
      }
    }
    var d = new D();
    log("result", d.open());
    invalidate d;
  `);
  assert.deepEqual(
    lines.filter((l) => l.startsWith('error')),
    [],
  );
  assert.deepEqual(logs, ['Object -2147483648 1', 'init hello 1 0', 'changed 1', 'result 1']);
  core.shutdown();
});

test('k2compat: the modeless owner window and its stayOnTop style', async () => {
  const {core, logs, lines} = await boot(`
    Plugins.link("k2compat.dll");
    var w = new System.ModelessOwnerWindow();
    log(w.HWND > 0, w.stayOnTop);
    w.stayOnTop = true;
    log(w.stayOnTop);
    w.show(true);
    w.show(false);
    invalidate w;
  `);
  assert.deepEqual(
    lines.filter((l) => l.startsWith('error')),
    [],
  );
  assert.deepEqual(logs, ['1 0', '1']);
  core.shutdown();
});

test('PackinOne: bundled plugins link as no-ops; functions and CSVParser; unlink restores', async () => {
  const {core, logs, lines} = await boot(`
    Plugins.link("PackinOne.dll");
    Plugins.link("fstat.dll");
    Plugins.link("plugin/LAYEREXIMAGE.DLL");
    log(Plugins.PackinOneList.join(","));
    try { Plugins.link("other.dll"); } catch (e) { log("other fails"); }
    log(Scripts.getObjectKeys(%[a: 1, b: 2]).join(","), Scripts.getObjectCount(%[a: 1, b: 2, c: 3]));
    log(Scripts.equalStruct(%[a: [1, "x"]], %[a: [1, "x"]]), Scripts.equalStruct([1], [2]));
    log(System.urlencode("a b/ん"), System.urldecode("a%20b"));
    log([1, "a", %[k: 2]].toStructString());
    var csv = new CSVParser();
    csv.init("x,\\"y,z\\"\\n1,2\\n");
    var row;
    while ((row = csv.getNextLine()) !== void) log(csv.currentLineNumber, row.join("|"));
    log(typeof Storages.isExistentDirectory, typeof Layer.shrinkCopy, typeof Layer.copyRaster);
    Plugins.unlink("PackinOne.dll");
    log(typeof global.CSVParser, Plugins.PackinOneList === void);
    try { Plugins.link("fstat.dll"); } catch (e) { log("fstat fails after unlink"); }
  `);
  assert.deepEqual(
    lines.filter((l) => l.startsWith('error')),
    [],
  );
  assert.ok(lines.some((l) => l.includes('CxImage Copyright START')));
  assert.deepEqual(logs, [
    'fstat.dll,savestruct.dll,scriptsEx.dll,systemEx.dll,addFont.dll,shrinkCopy.dll,' +
      'layerExBTOA.dll,layerExImage.dll,layerExRaster.dll,csvParser.dll',
    'other fails',
    'a,b 3',
    '1 0',
    'a%20b%2F%E3%82%93 a b',
    '[int 1,"a",%["k"=>int 2]]',
    '1 x|y,z',
    '2 1|2',
    'Object Object Object',
    'undefined 1',
    'fstat fails after unlink',
  ]);
  core.shutdown();
});

/** A window host whose client areas present into memory. */
const windowHost = {
  createWindow: (caption, w, h, style, exStyle) =>
    new WindowsTopLevelWindow(caption, w, h, style, exStyle),
  surfaceOf: () => ({
    resizeTexture: (w, h) => new Uint8Array(w * h * 4),
    present() {},
  }),
  cursorPos: () => ({x: 0, y: 0}),
};

test('PackinOne: layer functions write layer images in process memory', async () => {
  const {core, logs, lines} = await boot(
    `
    Plugins.link("PackinOne.dll");
    var px = function(l, x, y) { return "%02x%06x".sprintf(l.getMaskPixel(x, y), l.getMainPixel(x, y)); };
    var w = new Window();
    var p = new Layer(w, null);
    p.setSize(8, 8);
    var a = new Layer(w, p);
    a.setImageSize(4, 4);
    a.fillRect(0, 0, 4, 4, 0x00102030);
    a.fillAlpha();
    log("fillAlpha", px(a, 1, 1));
    var src = new Layer(w, p);
    src.setImageSize(4, 4);
    src.fillRect(0, 0, 2, 4, 0xff000000);
    src.fillRect(2, 0, 2, 4, 0x80ff0000);
    var b = new Layer(w, p);
    b.setImageSize(1, 1);
    b.shrinkCopyFast(src, 2);
    log("shrinkCopyFast", b.imageWidth, b.imageHeight, px(b, 0, 0), px(b, 1, 0));
    var c = new Layer(w, p);
    c.setImageSize(2, 1);
    c.fillRect(0, 0, 2, 1, 0);
    c.shrinkCopy(0, 0, 1, 1, src, 1, 0, 2, 2);
    log("shrinkCopy", px(c, 0, 0), px(c, 1, 0));
  `,
    {windowHost, bitmapMemory: 16 * 1024 * 1024},
  );
  assert.deepEqual(
    lines.filter((l) => l.startsWith('error')),
    [],
  );
  assert.deepEqual(logs, [
    'fillAlpha ff102030',
    // Step reduction keeps the colour channels and sets the alpha to 255.
    'shrinkCopyFast 2 2 ff000000 ffff0000',
    // Area averaging over one black and one half-transparent red column, alpha averaged too.
    'shrinkCopy bf7f0000 00000000',
  ]);
  core.shutdown();
});

test('KAGParserEx: replaces KAGParser and parses KAG scenarios through scripts', async () => {
  const main = [
    '; comment',
    '*start|First page',
    '[macro name=greet][ch text=%who|nobody][endmacro]',
    '@macro name=wrap',
    '\t[inner *]',
    '@endmacro',
    '[pmacro name=pos x=10 y=&f+1]',
    '[greet who=Ann][greet][greet v=&void]',
    '[wrap a=1 b="two words"]',
    "@line style='q`'s' flag",
    '[if exp="f==1"]yes[elsif exp="f==2"]two[else]no[endif]',
    '[ignore exp="true"]A[endignore][ignore exp="false"]B[endignore]',
    '[emb exp="\'[\' + (f*3)"]',
    'a[[b\\',
    '[tag pos z=3]',
    '[multi a=1 \\',
    ';   b=2]',
    '[iscript]',
    'f = 2;',
    '[endscript]',
    '[if exp="f==2"]after[endif]',
    '[call storage=sub.ks target=*sub]',
    'back[p]',
    '*end',
    '[jump target=*start cond="f==3"]',
  ].join('\r\n');
  const sub = ['*sub', 'in sub', '[return]'].join('\n');
  // A class extending KAGParser is defined by a script run after linking, as KAG does.
  const parser = `
    class P extends KAGParser {
      var inline;
      function P() { super.KAGParser(); }
      function onScenarioLoad(name) { return inline; }
      function onLabel(label, page) { log("label", label, page === void ? "-" : page); }
      function onScript(script, storage, line) {
        log("script", storage, line, script.trim());
        Scripts.exec(script);
      }
      function onScenarioLoaded(name) { log("loaded", name); }
      function onAfterReturn() { log("returned", callStackDepth); }
    }
    function run(p) {
      var text = "", t;
      while ((t = p.getNextTag()) !== void) {
        if (t.tagname == "ch") { text += t.text; continue; }
        if (text != "") { log("text", text); text = ""; }
        var s = [t.tagname];
        for (var i = 0; i < t.taglist.count; i++) {
          var n = t.taglist[i];
          if (n == "") s.add("(empty)"); else if (n != "tagname") s.add(n + "=" + t[n]);
        }
        log(s.join(" "));
      }
      if (text != "") log("text", text);
    }
  `;
  const {core, logs, lines} = await boot(
    `
    Plugins.link("KAGParserEx.dll");
    Scripts.execStorage("parser.tjs");
    global.f = 1;
    var p = new P();
    p.debugLevel = 0;
    p.multiLineTagEnabled = true;
    p.loadScenario("main.ks");
    run(p);
    log("end", p.curLabel, p.callStackDepth, p.macros.greet);
    try { p.goToLabel("*none"); } catch (e) { log("label error", e.message === ""); }

    var q = new P();
    q.debugLevel = 0;
    q.restore(p.store());
    log("restored", q.curStorage, q.curLabel, q.curLine, q.macros.wrap);
    q.inline = "a\\r\\nb[l]\\r\\n@x y=1\\r\\n";
    q.ignoreCR = true;
    q.loadScenario("inline");
    run(q);

    Plugins.unlink("KAGParserEx.dll");
    log(typeof global.KAGParser);
  `,
    {},
    {'parser.tjs': parser, 'main.ks': main, 'sub.ks': sub},
  );
  assert.deepEqual(
    lines.filter((l) => l.startsWith('error')),
    [],
  );
  assert.deepEqual(logs, [
    'loaded main.ks',
    'label *start First page',
    'r eol=true', // after [endmacro]; @ lines end without one
    'r eol=true',
    // A missing macro argument reads as void (dictionary), so the default applies.
    'text Annnobodynobody',
    'r eol=true',
    'inner a=1 b=two words',
    'r eol=true', // recorded in the macro
    'r eol=true',
    "line style=q's flag=true",
    'text yes',
    'r eol=true',
    'text B',
    'r eol=true',
    'text [3',
    'r eol=true',
    // The trailing backslash joins the next line.
    'text a[b',
    // The parameter macro's attributes, its entity evaluated at [pmacro].
    'tag x=10 y=2 z=3',
    'r eol=true',
    // The space after the continuation ';' makes an empty attribute name.
    'multi a=1 (empty) b=2',
    'script main.ks 18 f = 2;',
    'text after',
    'r eol=true',
    'loaded sub.ks',
    'label *sub -',
    'text in sub',
    'r eol=true',
    'loaded main.ks',
    'returned 0',
    'r eol=true',
    'text back',
    'p', // a line ending with [p] has no r
    'label *end -',
    'r eol=true', // the [jump] with a false cond is skipped
    'end *end 0 [ch text=%who|nobody][macropop]',
    // The reference core's message map has no KAG messages.
    'label error 1',
    'loaded main.ks',
    'restored main.ks *end 23 [inner *][r eol=true][macropop]',
    'loaded inline',
    'text ab',
    'l',
    'x y=1',
    'undefined',
  ]);
  core.shutdown();
});

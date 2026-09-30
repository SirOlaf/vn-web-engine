// Persistent CDP controller for a player tab in a separately launched Chrome (see
// docs/buriko-rendering-handoff.md, "Measuring"). It never enables the CDP Debugger domain,
// which switches WebAssembly to slow debug code; DevTools and the chrome-devtools MCP do.
// It suppresses the page's beforeunload prompt, auto-accepts dialogs, disables the HTTP cache
// and bypasses the service worker, so reloads always run the current build.
//
//   node tools/profile-harness/controller.mjs [--chrome-port 9333] [--port 9444]
//     [--origin http://127.0.0.1:8001] [--user-data-dir <profile with DevToolsActivePort>]
//
// Commands on http://127.0.0.1:<port>/<cmd>?args:
//   eval?js=...                      evaluate (awaited, returned by value as JSON)
//   nav?url=... / reload             navigate the attached tab
//   click?x=&y=                      trusted left click (CSS px)
//   key?key=Enter                    trusted key press (names in the table below)
//   shot?file=path                   PNG of the viewport. Game frames can show licensed
//                                    art: use only when needed to navigate, and keep the
//                                    files out of the repository.
//   throttle?rate=6                  CPU throttling (1 disables)
//   profstart / profstop?file=path   sampling CPU profile (.cpuprofile JSON)
//   recstart / recstop?file=path     in-game Performance diagnostics timings JSON
import {createServer} from 'node:http';
import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
};
const chromePort = Number(option('--chrome-port', 9333)),
  port = Number(option('--port', 9444));
// Chrome's in-browser remote-debugging toggle serves no /json endpoints; its profile's
// DevToolsActivePort names the port and browser socket path instead.
const profile = option('--user-data-dir', null);
const endpoint = profile
  ? (() => {
      const [activePort, path] = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split(
        '\n',
      );
      return `ws://127.0.0.1:${activePort}${path}`;
    })()
  : (await (await fetch(`http://127.0.0.1:${chromePort}/json/version`)).json())
      .webSocketDebuggerUrl;
const socket = new WebSocket(endpoint);
await new Promise((r, j) => ((socket.onopen = r), (socket.onerror = j)));
let nextId = 0;
const pending = new Map();
socket.onmessage = ({data}) => {
  const m = JSON.parse(data);
  if (m.method === 'Page.javascriptDialogOpening')
    socket.send(
      JSON.stringify({
        id: ++nextId,
        method: 'Page.handleJavaScriptDialog',
        params: {accept: true},
        sessionId: m.sessionId,
      }),
    );
  const p = pending.get(m.id);
  if (p) {
    pending.delete(m.id);
    m.error ? p.j(new Error(m.error.message)) : p.r(m.result);
  }
};
const cmd = (method, params = {}, sessionId) =>
  new Promise((r, j) => {
    const id = ++nextId;
    pending.set(id, {r, j});
    socket.send(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})}));
  });
const {targetInfos} = await cmd('Target.getTargets');
const origin = option('--origin', 'http://127.0.0.1:8001');
const page = targetInfos.find((t) => t.type === 'page' && t.url.startsWith(origin));
if (page === undefined) throw new Error(`No tab at ${origin}; open the player first`);
const {sessionId} = await cmd('Target.attachToTarget', {targetId: page.targetId, flatten: true});
const s = (method, params) => cmd(method, params, sessionId);
await s('Page.enable');
await s('Network.enable');
await s('Network.setCacheDisabled', {cacheDisabled: true});
await s('Network.setBypassServiceWorker', {bypass: true});
const hook = `(() => { if (window.__blobs) return; const addListener = EventTarget.prototype.addEventListener; EventTarget.prototype.addEventListener = function (type, ...rest) { if (type === 'beforeunload') return; return addListener.call(this, type, ...rest); }; Object.defineProperty(window, 'onbeforeunload', {configurable: true, get: () => null, set: () => {}}); const orig = URL.createObjectURL; window.__blobs = []; URL.createObjectURL = function (b) { if (b instanceof Blob) window.__blobs.push(b); return orig.call(URL, b); }; const click = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { if (this.download && /\\.json$/i.test(this.download)) return; return click.call(this); }; })();`;
await s('Page.addScriptToEvaluateOnNewDocument', {source: hook});
const evaluate = async (expression) => {
  const r = await s('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval');
  return r.result.value;
};
await evaluate(hook);
const keys = {
  Enter: {code: 'Enter', keyCode: 13, text: '\r'},
  Space: {key: ' ', code: 'Space', keyCode: 32, text: ' '},
  Escape: {code: 'Escape', keyCode: 27},
  ArrowUp: {code: 'ArrowUp', keyCode: 38},
  ArrowDown: {code: 'ArrowDown', keyCode: 40},
  ArrowLeft: {code: 'ArrowLeft', keyCode: 37},
  ArrowRight: {code: 'ArrowRight', keyCode: 39},
  Control: {code: 'ControlLeft', keyCode: 17},
};
const panel = async (open) => {
  await evaluate(
    `(() => { const b = [...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') ?? b.textContent).trim() === 'Toggle game options'); if (b && (b.getAttribute('aria-expanded') === 'true') !== ${open}) b.click(); return true; })()`,
  );
  if (open) {
    await new Promise((r) => setTimeout(r, 200));
    await evaluate(
      `(() => { const d = [...document.querySelectorAll('details')].find(x => x.querySelector('summary')?.textContent.includes('Performance diagnostics')); if (d && !d.open) d.querySelector('summary').click(); return true; })()`,
    );
    await new Promise((r) => setTimeout(r, 200));
  }
};
const button = (label) =>
  evaluate(
    `(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`,
  );
createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const q = Object.fromEntries(url.searchParams);
  try {
    let out = 'ok';
    switch (url.pathname.slice(1)) {
      case 'eval':
        out = JSON.stringify(await evaluate(q.js));
        break;
      case 'click':
        for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
          await s('Input.dispatchMouseEvent', {
            type,
            x: Number(q.x),
            y: Number(q.y),
            button: type === 'mouseMoved' ? 'none' : 'left',
            clickCount: 1,
          });
        break;
      case 'key': {
        const k = {key: q.key, ...keys[q.key]};
        await s('Input.dispatchKeyEvent', {
          type: 'keyDown',
          ...k,
          windowsVirtualKeyCode: k.keyCode,
        });
        await new Promise((r) => setTimeout(r, Number(q.hold ?? 60)));
        await s('Input.dispatchKeyEvent', {
          type: 'keyUp',
          ...k,
          text: undefined,
          windowsVirtualKeyCode: k.keyCode,
        });
        break;
      }
      case 'shot': {
        const {data} = await s('Page.captureScreenshot', {format: 'png'});
        writeFileSync(q.file, Buffer.from(data, 'base64'));
        break;
      }
      case 'throttle':
        await s('Emulation.setCPUThrottlingRate', {rate: Number(q.rate)});
        break;
      case 'profstart':
        await s('Profiler.enable');
        await s('Profiler.setSamplingInterval', {interval: 200});
        await s('Profiler.start');
        break;
      case 'profstop': {
        const {profile} = await s('Profiler.stop');
        writeFileSync(q.file, JSON.stringify(profile));
        break;
      }
      case 'recstart':
        await panel(true);
        out = String(await button('Start recording'));
        await panel(false);
        break;
      case 'recstop': {
        await panel(true);
        await button('Stop recording');
        await new Promise((r) => setTimeout(r, 300));
        await button('Download timings JSON');
        await new Promise((r) => setTimeout(r, 500));
        writeFileSync(q.file, await evaluate('window.__blobs.at(-1).text()'));
        await panel(false);
        break;
      }
      case 'nav':
        await s('Page.navigate', {url: q.url});
        break;
      case 'reload':
        await s('Page.reload', {ignoreCache: true});
        break;
      default:
        out = 'unknown';
    }
    res.end(out);
  } catch (error) {
    res.statusCode = 500;
    res.end(String(error));
  }
}).listen(port, '127.0.0.1');
console.log(`Controller ready on http://127.0.0.1:${port}/`);

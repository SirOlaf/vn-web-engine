import {spawn} from 'node:child_process';
import {createWriteStream} from 'node:fs';
import {access, mkdtemp, writeFile, realpath, readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {delimiter, join, resolve, sep} from 'node:path';

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

class DevToolsConnection {
  nextId = 0;
  pending = new Map();
  constructor(socket) {
    this.socket = socket;
    socket.addEventListener('message', ({data}) => {
      const message = JSON.parse(data);
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      clearTimeout(request.timeout);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    });
    socket.addEventListener('close', () => this.cancel(new Error('Browser disconnected')));
    socket.addEventListener('error', () => {});
  }
  cancel(error) {
    for (const request of this.pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    this.pending.clear();
  }
  static async connect(endpoint) {
    const socket = new WebSocket(endpoint);
    const connection = new DevToolsConnection(socket);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error('DevTools connection timed out'));
      }, 10000);
      const finish = (callback) => (event) => {
        clearTimeout(timeout);
        callback(event);
      };
      socket.addEventListener('open', finish(resolve), {once: true});
      socket.addEventListener(
        'error',
        finish(() => reject(new Error('DevTools connection failed'))),
        {once: true},
      );
      socket.addEventListener(
        'close',
        finish(() => reject(new Error('DevTools connection closed'))),
        {once: true},
      );
    });
    return connection;
  }
  command(method, params = {}, sessionId, timeoutMs = 20000) {
    if (this.socket.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error('DevTools connection closed'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(method + ' timed out'));
      }, timeoutMs);
      this.pending.set(id, {resolve, reject, timeout});
      try {
        this.socket.send(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})}));
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
}

export function parseSyntheticBrowserOptions(args) {
  const values = {smoke: false, iterations: 3};
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (name === '--smoke') values.smoke = true;
    else if (
      ['--browser', '--output', '--iterations'].includes(name) &&
      args[index + 1] &&
      !args[index + 1].startsWith('--')
    )
      values[name.slice(2)] = args[++index];
    else throw new Error('Unknown or incomplete argument: ' + name);
  }
  if (!args.includes('--iterations') && values.smoke) values.iterations = 1;
  values.iterations = Number(values.iterations);
  if (!Number.isSafeInteger(values.iterations) || values.iterations < 1 || values.iterations > 20)
    throw new Error('--iterations must be an integer from 1 to 20');
  return values;
}

async function findBrowser(explicit) {
  const requested = explicit || process.env.BROWSER || process.env.CHROME_BIN;
  const candidates = requested
    ? [requested]
    : [
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        'brave-browser',
        'google-chrome',
        'google-chrome-stable',
        'chromium',
        'chromium-browser',
        ...[process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']]
          .filter(Boolean)
          .flatMap((root) => [
            join(root, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
            join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
          ]),
      ];
  for (const candidate of candidates) {
    const paths =
      candidate.includes('/') || candidate.includes('\\')
        ? [resolve(candidate)]
        : (process.env.PATH ?? '')
            .split(delimiter)
            .map((directory) => resolve(directory, candidate));
    for (const path of paths) {
      try {
        await access(path);
        return path;
      } catch {}
    }
  }
  throw new Error(
    requested
      ? 'Browser not found: ' + requested
      : 'No Chromium browser found; set --browser /path/to/browser, BROWSER, or CHROME_BIN',
  );
}

export async function runSyntheticBrowserProbe({
  options,
  fixture = {},
  pageMain,
  runtimeRoot = null,
  name = 'vn-webgl-affine',
}) {
  if (typeof WebSocket !== 'function')
    throw new Error(
      'This tool requires Node.js with built-in WebSocket support (Node 22 or newer).',
    );
  const browserExecutable = await findBrowser(options.browser);
  const root = await mkdtemp(join(tmpdir(), name + '-'));
  const runtimeDirectory = runtimeRoot === null ? null : await realpath(runtimeRoot);
  const outputPath = options.output ? resolve(options.output) : join(root, 'results.json');
  // Reserve the result before launching so an existing report is never overwritten.
  await writeFile(outputPath, '', {flag: 'wx'});
  const profile = join(root, 'profile');
  const browserArgs = [
    '--headless=new',
    '--remote-debugging-port=0',
    '--user-data-dir=' + profile,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-extensions',
    'about:blank',
  ];
  const page =
    '<!doctype html><meta charset="utf-8"><title>Synthetic numeric affine probe</title><p>Numeric diagnostics only</p><script>window.ready = fetch("/cases").then(r=>r.json()).then(d=>{window.runProbe=()=>(' +
    pageMain.toString() +
    ')(d.fixture,d.options)});</script>';
  const server = createServer(async (request, response) => {
    if (request.url === '/progress' && request.method === 'POST') {
      let text = '';
      try {
        for await (const chunk of request) {
          text += chunk;
          if (text.length > 8192) {
            response.writeHead(413);
            response.end();
            return;
          }
        }
      } catch {
        response.destroy();
        return;
      }
      console.log(text);
      response.writeHead(204);
      response.end();
      return;
    }
    // This optional route serves compiled JavaScript only, never assets or arbitrary files.
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (
      runtimeDirectory !== null &&
      /^\/runtime\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.js$/.test(path)
    ) {
      try {
        const file = await realpath(join(runtimeDirectory, path.slice('/runtime/'.length)));
        if (!file.startsWith(runtimeDirectory + sep)) throw new Error('Runtime path escapes root');
        const code = await readFile(file);
        response.writeHead(200, {'Content-Type': 'text/javascript', 'Cache-Control': 'no-store'});
        response.end(code);
      } catch {
        response.writeHead(404);
        response.end('Compiled runtime module unavailable; build dist first.');
      }
      return;
    }
    if (request.url !== '/' && request.url !== '/cases') {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, {
      'Content-Type': request.url === '/' ? 'text/html' : 'application/json',
      'Cache-Control': 'no-store',
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
    });
    response.end(
      request.url === '/'
        ? page
        : JSON.stringify({
            fixture,
            options: {smoke: options.smoke, iterations: options.iterations},
          }),
    );
  });
  let browser,
    cdp,
    browserClosed,
    completedResult,
    interrupted = false,
    stderrTail = '';
  const browserLog = join(root, 'browser.log');
  const log = createWriteStream(browserLog);
  const interrupt = () => {
    interrupted = true;
    cdp?.cancel(new Error('Benchmark interrupted'));
    if (browser && browser.exitCode === null && browser.signalCode === null)
      browser.kill('SIGTERM');
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  const metadata = {
    createdAt: new Date().toISOString(),
    browserExecutable,
    browserArgs,
    profile,
    browserLog,
    outputPath,
    smoke: options.smoke,
  };
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    if (interrupted) throw new Error('Benchmark interrupted');
    const url = 'http://127.0.0.1:' + server.address().port + '/';
    metadata.url = url;
    console.log('Isolated synthetic probe; no screenshots or game assets. Profile: ' + profile);
    browser = spawn(browserExecutable, browserArgs, {stdio: ['ignore', 'ignore', 'pipe']});
    browserClosed = new Promise((resolve) => {
      browser.once('exit', resolve);
      browser.once('error', resolve);
    });
    const endpoint = await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('DevTools endpoint timed out; see ' + browserLog)),
        20000,
      );
      browser.stderr.on('data', (data) => {
        log.write(data);
        stderrTail = (stderrTail + data).slice(-32768);
        const match = stderrTail.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) {
          clearTimeout(timeout);
          resolve(match[1]);
        }
      });
      browser.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      browser.once('exit', (code, signal) => {
        clearTimeout(timeout);
        reject(new Error(`Browser exited ${code}/${signal}; see ${browserLog}`));
      });
    });
    cdp = await DevToolsConnection.connect(endpoint);
    metadata.version = await cdp.command('Browser.getVersion');
    const {targetId} = await cdp.command('Target.createTarget', {url});
    const {sessionId} = await cdp.command('Target.attachToTarget', {targetId, flatten: true});
    await cdp.command('Runtime.enable', {}, sessionId);
    let ready = false;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const state = await cdp.command(
        'Runtime.evaluate',
        {expression: 'Boolean(window.ready)', returnByValue: true},
        sessionId,
      );
      if (state.result.value) {
        ready = true;
        break;
      }
      await delay(50);
    }
    if (!ready) throw new Error('Synthetic fixture did not load');
    const output = await cdp.command(
      'Runtime.evaluate',
      {
        expression: 'window.ready.then(()=>window.runProbe())',
        awaitPromise: true,
        returnByValue: true,
      },
      sessionId,
      180000,
    );
    if (output.exceptionDetails)
      throw new Error(
        output.exceptionDetails.exception?.description ?? JSON.stringify(output.exceptionDetails),
      );
    const result = {...metadata, ...output.result.value, finishedAt: new Date().toISOString()};
    completedResult = result;
    await writeFile(outputPath, JSON.stringify(result, null, 2) + '\n');
    const {casesDetail: _casesDetail, ...parity} = result.parity ?? {};
    console.log(
      JSON.stringify({
        resultPath: outputPath,
        adapter: result.adapter,
        parity,
        available: result.available,
      }),
    );
    if (!result.available) throw new Error(result.reason ?? 'WebGL2 unavailable');
    return result;
  } catch (error) {
    await writeFile(
      outputPath,
      JSON.stringify(
        {
          ...(completedResult ?? metadata),
          error: error.message,
          finishedAt: new Date().toISOString(),
        },
        null,
        2,
      ) + '\n',
    );
    throw error;
  } finally {
    if (cdp?.socket.readyState === WebSocket.OPEN)
      await cdp.command('Browser.close', {}, undefined, 2000).catch(() => {});
    cdp?.socket.close();
    cdp?.cancel(new Error('Benchmark finished'));
    if (browser && browser.exitCode === null && browser.signalCode === null) {
      await Promise.race([browserClosed, delay(1000)]);
      if (browser.exitCode === null && browser.signalCode === null) browser.kill('SIGTERM');
      await Promise.race([browserClosed, delay(2000)]);
      if (browser.exitCode === null && browser.signalCode === null) browser.kill('SIGKILL');
      await Promise.race([browserClosed, delay(1000)]);
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => log.end(resolve));
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    console.log('Results: ' + outputPath);
  }
}

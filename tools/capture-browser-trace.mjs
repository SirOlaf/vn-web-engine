import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {createWriteStream, closeSync, openSync, renameSync, writeFileSync} from 'node:fs';
import {access, mkdir, mkdtemp, open, readFile, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {createInterface} from 'node:readline';
import {pathToFileURL} from 'node:url';

const delay = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));
const baseCategories = [
  'devtools.timeline',
  'blink.user_timing',
  'v8',
  'v8.execute',
  'disabled-by-default-v8.inspector',
  'disabled-by-default-v8.gc',
  'cppgc',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
];
const screenshotCategory = 'disabled-by-default-devtools.screenshot';

class DevToolsConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    socket.addEventListener('message', ({data}) => {
      const message = JSON.parse(data);
      const request = this.pending.get(message.id);
      if (request !== undefined) {
        this.pending.delete(message.id);
        clearTimeout(request.timeout);
        if (message.error) request.reject(new Error(message.error.message));
        else request.resolve(message.result);
      } else if (message.method) this.emit('event', message);
    });
    socket.addEventListener('close', (event) => {
      for (const request of this.pending.values()) {
        clearTimeout(request.timeout);
        request.reject(new Error('DevTools connection closed'));
      }
      this.pending.clear();
      this.emit('disconnected', {code: event.code, reason: event.reason});
    });
    // Closing the socket is the actionable signal after an established connection fails.
    socket.addEventListener('error', () => {});
  }
  static async connect(endpoint) {
    const socket = new WebSocket(endpoint);
    const connection = new DevToolsConnection(socket);
    await new Promise((done, reject) => {
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error('DevTools connection timed out'));
      }, 15000);
      socket.addEventListener(
        'open',
        () => {
          clearTimeout(timeout);
          done();
        },
        {once: true},
      );
      socket.addEventListener(
        'error',
        () => {
          clearTimeout(timeout);
          reject(new Error('DevTools connection failed'));
        },
        {once: true},
      );
      socket.addEventListener(
        'close',
        () => {
          clearTimeout(timeout);
          reject(new Error('DevTools connection closed before opening'));
        },
        {once: true},
      );
    });
    return connection;
  }
  command(method, params = {}, sessionId, timeoutMs = 20000) {
    if (this.socket.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error('DevTools connection is not open'));
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

/** Records a user-operated isolated browser; no page script or screenshot commands are issued. */
export async function captureBrowserTrace({
  browserExecutable,
  url,
  output,
  samples = 'off',
  headless = false,
}) {
  if (typeof WebSocket !== 'function')
    throw new Error('This tool requires Node.js with built-in WebSocket support.');
  const address = new URL(url);
  if (
    address.protocol !== 'http:' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(address.hostname) ||
    address.username ||
    address.password
  )
    throw new Error('--url must be a loopback HTTP URL without credentials');
  if (samples !== 'off' && samples !== 'on') throw new Error('--samples must be off or on');
  browserExecutable = resolve(browserExecutable);
  await access(browserExecutable);
  output = resolve(output);
  await mkdir(dirname(output), {recursive: true});
  try {
    await stat(output);
    throw new Error('Output already exists: ' + output);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const metadataPath = output + '.metadata.json';
  closeSync(openSync(metadataPath, 'wx'));
  const profile = await mkdtemp(join(tmpdir(), 'vn-browser-trace-'));
  const categories = [...baseCategories];
  if (samples === 'on') categories.push('disabled-by-default-v8.cpu_profiler');
  const metadata = {
    createdAt: new Date().toISOString(),
    browserExecutable,
    url: address.href,
    profile,
    output,
    samples,
    headless,
    traceConfig: {
      // Keep the events nearest a late failure instead of silently filling at startup.
      recordMode: 'recordContinuously',
      traceBufferSizeInKb: 32768,
      enableSampling: samples === 'on',
      includedCategories: categories,
      excludedCategories: [
        screenshotCategory,
        ...(samples === 'off'
          ? ['disabled-by-default-v8.cpu_profiler', 'disabled-by-default-v8.cpu_profiler.hires']
          : []),
      ],
    },
    trace: {status: 'not-started'},
    events: [],
  };
  const saveMetadata = () => {
    writeFileSync(metadataPath + '.tmp', JSON.stringify(metadata, null, 2) + '\n');
    renameSync(metadataPath + '.tmp', metadataPath);
  };
  const event = (kind, details = {}) => {
    metadata.events.push({at: new Date().toISOString(), kind, ...details});
    saveMetadata();
  };
  saveMetadata();
  console.log('Isolated browser profile (retained): ' + profile);
  console.log('Termination metadata: ' + metadataPath);
  const input = createInterface({input: process.stdin, crlfDelay: Infinity});
  const lines = [];
  let inputEnded = false;
  let nextLine;
  input.on('line', () => {
    if (nextLine) {
      const done = nextLine;
      nextLine = undefined;
      done('enter');
    } else lines.push('enter');
  });
  input.on('close', () => {
    inputEnded = true;
    if (nextLine) {
      const done = nextLine;
      nextLine = undefined;
      done('eof');
    }
  });
  const enter = (prompt) => {
    console.log(prompt);
    if (lines.length) return Promise.resolve(lines.shift());
    if (inputEnded) return Promise.resolve('eof');
    return new Promise((done) => {
      nextLine = done;
    });
  };
  let stopped;
  let resolveStop;
  const stopSignal = new Promise((done) => {
    resolveStop = done;
  });
  const stop = (reason) => {
    if (stopped !== undefined) return;
    stopped = reason;
    resolveStop(reason);
  };
  const interrupt = () => {
    event('interrupt');
    stop('interrupt');
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  const stderrPath = join(profile, 'browser-stderr.log');
  const stderr = createWriteStream(stderrPath);
  stderr.on('error', (error) => {
    event('browser-log-error', {message: error.message});
    stop('browser-log-error');
  });
  metadata.browserLog = stderrPath;
  const browser = spawn(
    browserExecutable,
    [
      ...(headless ? ['--headless=new'] : []),
      '--remote-debugging-port=0',
      '--user-data-dir=' + profile,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    {stdio: ['ignore', 'ignore', 'pipe']},
  );
  metadata.browserPid = browser.pid;
  browser.stderr.pipe(stderr);
  const browserClosed = new Promise((done) => {
    browser.once('exit', (code, signal) => {
      event('browser-exit', {code, signal});
      stop('browser-exit');
    });
    browser.once('error', (error) => {
      event('browser-error', {message: error.message});
      stop('browser-error');
    });
    // `exit` can precede the final stderr data; keep the crash log open until stdio closes.
    browser.once('close', done);
  });
  let cdp;
  let recording = false;
  let tracingComplete;
  let failure;
  try {
    let endpoint;
    const deadline = Date.now() + 20000;
    while (!endpoint && Date.now() < deadline && stopped === undefined) {
      try {
        const [port, path] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8'))
          .trim()
          .split('\n');
        if (/^\d+$/.test(port) && path?.startsWith('/devtools/browser/'))
          endpoint = 'ws://127.0.0.1:' + port + path;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (!endpoint) await delay(100);
    }
    if (!endpoint) throw new Error(stopped ?? 'Browser startup timed out');
    metadata.browserWSEndpoint = endpoint;
    cdp = await DevToolsConnection.connect(endpoint);
    cdp.on('disconnected', (details) => {
      event('devtools-disconnected', details);
      stop('devtools-disconnected');
    });
    cdp.on('event', (message) => {
      if (message.method === 'Tracing.tracingComplete') {
        tracingComplete = message.params;
        metadata.trace.completedAt = new Date().toISOString();
        metadata.trace.dataLossOccurred = message.params.dataLossOccurred ?? false;
        event('trace-complete', {dataLossOccurred: metadata.trace.dataLossOccurred});
        stop('trace-complete');
      }
      if (message.method === 'Tracing.bufferUsage') {
        const usage = message.params.percentFull ?? message.params.value;
        metadata.trace.buffer = {
          ...message.params,
          at: new Date().toISOString(),
          peakFraction: Math.max(metadata.trace.buffer?.peakFraction ?? 0, usage ?? 0),
        };
        saveMetadata();
      }
      if (
        message.method === 'Target.targetDestroyed' &&
        message.params.targetId === metadata.targetId
      ) {
        event('target-closed', {targetId: message.params.targetId});
        stop('target-closed');
      }
      if (
        message.method === 'Target.targetCrashed' ||
        message.method === 'Inspector.targetCrashed'
      ) {
        event(message.method, {
          details: message.params,
          ...(message.sessionId ? {sessionId: message.sessionId} : {}),
        });
        console.error('Renderer termination received: ' + JSON.stringify(message.params));
        stop('renderer-crash');
      }
    });
    metadata.browserVersion = await cdp.command('Browser.getVersion');
    await cdp.command('Target.setDiscoverTargets', {discover: true});
    const {targetId} = await cdp.command('Target.createTarget', {url: address.href});
    metadata.targetId = targetId;
    const {sessionId} = await cdp.command('Target.attachToTarget', {targetId, flatten: true});
    metadata.sessionId = sessionId;
    await cdp.command('Inspector.enable', {}, sessionId);
    await cdp.command('Target.activateTarget', {targetId});
    event('ready');
    console.log(
      'Browser: ' + metadata.browserVersion.product + '; V8 ' + metadata.browserVersion.jsVersion,
    );
    console.log('CPU samples: ' + samples + '. Screenshots are excluded.');
    console.log('Trace buffer: 32 MiB, retaining recent events when full. Keep captures short.');
    const firstInput = await Promise.race([
      enter('Prepare the game in the isolated browser, then press Enter to start recording.'),
      stopSignal,
    ]);
    if (firstInput === 'enter' && stopped === undefined) {
      await cdp.command('Tracing.start', {
        transferMode: 'ReturnAsStream',
        streamFormat: 'json',
        bufferUsageReportingInterval: 1000,
        traceConfig: metadata.traceConfig,
      });
      recording = true;
      metadata.trace = {status: 'recording', startedAt: new Date().toISOString()};
      event('recording-started');
      const nextInput = await Promise.race([
        enter('Recording. Press Enter to stop; renderer termination also stops automatically.'),
        stopSignal,
      ]);
      if (stopped === undefined) stop(nextInput === 'eof' ? 'stdin-closed' : 'manual-stop');
    } else if (stopped === undefined) stop('stdin-closed');
  } catch (error) {
    failure = error;
    event('recorder-error', {message: error.message});
    stop('recorder-error');
  } finally {
    input.close();
    metadata.stopReason = stopped ?? 'finished';
    if (recording) {
      metadata.trace.status = 'saving';
      saveMetadata();
      let file;
      let handle;
      try {
        if (!tracingComplete) await cdp.command('Tracing.end');
        const deadline = Date.now() + 30000;
        while (!tracingComplete && Date.now() < deadline) {
          if (cdp.socket.readyState !== WebSocket.OPEN)
            throw new Error('Browser disconnected before trace became available');
          await delay(50);
        }
        if (!tracingComplete?.stream) throw new Error('Timed out waiting for trace stream');
        handle = tracingComplete.stream;
        metadata.trace.dataLossOccurred = tracingComplete.dataLossOccurred ?? false;
        file = await open(output, 'wx');
        let bytes = 0;
        for (;;) {
          const chunk = await cdp.command('IO.read', {handle, size: 1024 * 1024});
          const data = Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8');
          await file.writeFile(data);
          bytes += data.byteLength;
          metadata.trace.bytes = bytes;
          if (chunk.eof) break;
        }
        await file.sync();
        metadata.trace.status = 'saved';
        metadata.trace.savedAt = new Date().toISOString();
        console.log('Trace saved: ' + output);
        if (metadata.trace.dataLossOccurred)
          console.warn('The browser reports lost trace data; earlier events may have rolled out.');
      } catch (error) {
        metadata.trace.status = file ? 'incomplete' : 'unavailable';
        metadata.trace.error = error.message;
        failure ??= error;
        console.error('Trace capture: ' + error.message);
      } finally {
        await file?.close().catch((error) => {
          metadata.trace.status = 'incomplete';
          metadata.trace.error = error.message;
          failure ??= error;
        });
        if (handle) await cdp.command('IO.close', {handle}, undefined, 3000).catch(() => {});
        saveMetadata();
      }
    }
    // This process owns the temporary browser; close it after preserving the trace and events.
    if (cdp?.socket.readyState === WebSocket.OPEN) {
      event('browser-close-requested');
      await cdp.command('Browser.close', {}, undefined, 3000).catch(() => {});
    }
    cdp?.socket.close();
    if (browser.exitCode === null && browser.signalCode === null) {
      await Promise.race([browserClosed, delay(1000)]);
      if (browser.exitCode === null && browser.signalCode === null) browser.kill('SIGTERM');
    }
    await Promise.race([browserClosed, delay(3000)]);
    metadata.finishedAt = new Date().toISOString();
    saveMetadata();
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    console.log('Metadata saved: ' + metadataPath);
    console.log('Temporary profile retained for crash reports: ' + profile);
  }
  if (failure) throw failure;
  return metadata;
}

function options(args) {
  const values = {samples: 'off', headless: false};
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (name === '--headless') values.headless = true;
    else if (
      ['--browser', '--url', '--output', '--samples'].includes(name) &&
      args[index + 1] &&
      !args[index + 1].startsWith('--')
    )
      values[name.slice(2)] = args[++index];
    else throw new Error('Unknown or incomplete argument: ' + name);
  }
  if (!values.browser || !values.url || !values.output)
    throw new Error('--browser, --url, and --output are required');
  return {browserExecutable: values.browser, ...values};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes('--help')) {
    console.log(
      'Usage: node tools/capture-browser-trace.mjs --browser /path/to/browser --url http://127.0.0.1:8001/buriko.html --output /path/to/trace.json [--samples off|on] [--headless]',
    );
    console.log(
      'Uses an isolated temporary profile. Enter starts/stops recording. Renderer crashes stop automatically. Screenshots are always excluded.',
    );
  } else {
    try {
      await captureBrowserTrace(options(process.argv.slice(2)));
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}

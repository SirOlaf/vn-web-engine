import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const modulePaths = [
  'engines/buriko/native/bitmap-alpha-wasm.js',
  'engines/buriko/native/bitmap-alpha-wasm-binary.js',
  'core/wasm.js',
  'graphics/wasm-pixel-workspace.js',
  'platform/runtime-advisories.js',
];

/** Runs generated numeric buffers or optional offscreen glyphs; never starts a game or loads assets. */
function browserMain() {
  const button = document.getElementById('run');
  const status = document.getElementById('status');
  const result = document.getElementById('result');
  const previous = document.getElementById('previous');
  const key = 'vn-bitmap-wasm-diagnostic:last-run';
  const query = new URLSearchParams(location.search).get('case') ?? 'all';
  const selected = ['all', 'affine', 'fused', 'alpha', 'canvas'].includes(query) ? query : 'all';
  const stages = selected === 'all' ? ['affine', 'fused', 'alpha'] : [selected];
  const probe = (window.__bitmapWasmProbe = {state: 'idle', result: null});
  let record = null;
  let buffers = null;
  document.getElementById('environment').textContent = JSON.stringify(
    {userAgent: navigator.userAgent, case: selected, build: document.body.dataset.build},
    null,
    2,
  );
  try {
    previous.textContent = localStorage.getItem(key) ?? 'No previous run.';
  } catch {
    previous.textContent = 'Local storage is unavailable; last-stage recovery is disabled.';
  }
  const save = () => {
    result.textContent = JSON.stringify(record, null, 2);
    probe.result = record;
    try {
      localStorage.setItem(key, JSON.stringify(record));
    } catch {
      // Storage availability must not alter the kernel workload.
    }
  };
  const fail = (error) => {
    if (record === null) record = {case: selected, userAgent: navigator.userAgent};
    record.status = 'failed';
    record.error = String(error?.stack ?? error).slice(0, 4000);
    probe.state = 'failed';
    status.textContent = 'Failed: ' + String(error?.message ?? error);
    save();
  };
  window.addEventListener('error', (event) => fail(event.error ?? event.message));
  window.addEventListener('unhandledrejection', (event) => fail(event.reason));
  const yieldToBrowser = () => new Promise((done) => setTimeout(done, 0));
  const checksum = (bytes) => {
    let hash = 2166136261;
    for (let index = 0; index < bytes.length; index++)
      hash = Math.imul(hash ^ bytes[index], 16777619);
    return (hash >>> 0).toString(16).padStart(8, '0');
  };

  async function runCanvas() {
    const started = performance.now();
    let calls = 0;
    let hash = 2166136261;
    let kernelMs = 0;
    performance.mark('bitmap-diagnostic-canvas-start');
    do {
      record.lastStage = 'canvas';
      record.lastGroup = {
        firstCall: calls,
        cases: ['eight disposable 256x64 offscreen glyph canvases'],
      };
      status.textContent = 'canvas: ' + calls + ' disposable surfaces';
      save();
      await yieldToBrowser();
      const groupStarted = performance.now();
      for (let index = 0; index < 8; index++) {
        const canvas = new OffscreenCanvas(256, 64);
        const context = canvas.getContext('2d', {willReadFrequently: true});
        if (context === null) throw new Error('OffscreenCanvas 2D is unavailable');
        context.fillStyle = '#19304f';
        context.fillRect(0, 0, 256, 64);
        context.fillStyle = '#e7be67';
        context.font = '24px monospace';
        context.fillText('A ' + calls, 5, 38);
        const bytes = context.getImageData(0, 0, 256, 64).data;
        for (let sample = 0; sample < bytes.length; sample += 257)
          hash = Math.imul(hash ^ bytes[sample], 16777619);
        // Drop the backing surface immediately; no canvas, context, or ImageData escapes this loop.
        canvas.width = 0;
        calls++;
      }
      kernelMs += performance.now() - groupStarted;
    } while (performance.now() - started < 5000 && calls < 2048);
    performance.mark('bitmap-diagnostic-canvas-end');
    record.results.push({
      stage: 'canvas',
      calls,
      elapsedMs: Math.round(performance.now() - started),
      kernelMs: Math.round(kernelMs),
      checksum: (hash >>> 0).toString(16).padStart(8, '0'),
    });
    record.status = 'passed';
    record.lastStage = 'complete';
    record.elapsedMs = Math.round(performance.now() - started);
    record.completedAt = new Date().toISOString();
    probe.state = 'complete';
    status.textContent = 'Completed. Synthetic offscreen surfaces were discarded after each call.';
    save();
  }

  async function run() {
    button.disabled = true;
    probe.state = 'running';
    record = {
      status: 'running',
      case: selected,
      userAgent: navigator.userAgent,
      build: document.body.dataset.build,
      startedAt: new Date().toISOString(),
      lastStage: selected === 'canvas' ? 'canvas' : 'import',
      results: [],
    };
    status.textContent =
      selected === 'canvas'
        ? 'Preparing synthetic offscreen glyphs.'
        : 'Loading the allowlisted bitmap module.';
    save();
    await yieldToBrowser();
    if (selected === 'canvas') {
      await runCanvas();
      return;
    }
    const kernel = await import('/dist/engines/buriko/native/bitmap-alpha-wasm.js');
    record.lastStage = 'allocate synthetic buffers';
    save();
    if (buffers === null) {
      const size = 1280 * 720 * 4;
      buffers = [new Uint8Array(size), new Uint8Array(size), new Uint8Array(size)];
      let seed = 0x67ba381d;
      for (const bytes of buffers.slice(0, 2)) {
        const pixels = new Uint32Array(bytes.buffer);
        for (let index = 0; index < pixels.length; index++) {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          // Include zero-alpha pairs and single pixels alongside arbitrary channel values.
          pixels[index] = index % 16 < 3 ? seed & 0xffffff : seed;
        }
      }
    }
    const [firstBytes, secondBytes, outputBytes] = buffers;
    const firstView = new DataView(firstBytes.buffer);
    const secondView = new DataView(secondBytes.buffer);
    const outputView = new DataView(outputBytes.buffer);
    const bitmap = (width, height) => ({
      storage: null,
      offset: 0,
      stride: 1280 * 4,
      width,
      height,
      format: 2,
      bytesPerPixel: 4,
    });
    const fullSource = bitmap(1280, 720);
    const fixtures = [
      {name: '1280x720', bitmap: bitmap(1280, 720)},
      {name: '1279x719 padded odd', bitmap: bitmap(1279, 719)},
      {name: '1278x720 padded pair tail', bitmap: bitmap(1278, 720)},
      {name: '1023x511 padded odd', bitmap: bitmap(1023, 511)},
    ];
    const coordinates = [
      {startX: 0, startY: 0, columnX: 65536, columnY: 0, rowX: 0, rowY: 65536},
      {startX: 32768, startY: 16384, columnX: 57344, columnY: 2048, rowX: -1024, rowY: 61440},
    ];
    const factors = [0, 1, 64, 127, 128, 255, 256];
    const transparencies = [0, 1, 127, 255];
    const started = performance.now();
    for (const stage of stages) {
      outputBytes.set(secondBytes);
      const begin = performance.now();
      let calls = 0;
      let kernelMs = 0;
      performance.mark('bitmap-diagnostic-' + stage + '-start');
      do {
        const group = [];
        for (let index = 0; index < 4; index++) {
          const call = calls + index;
          const fixture = fixtures[call % fixtures.length];
          const bilinear = (Math.floor(call / fixtures.length) & 1) === 1;
          group.push({
            call,
            fixture,
            bilinear,
            label: fixture.name + (stage === 'affine' ? (bilinear ? ' bilinear' : ' nearest') : ''),
          });
        }
        record.lastStage = stage;
        record.lastGroup = {firstCall: calls, cases: group.map((item) => item.label)};
        status.textContent = stage + ': ' + calls + ' calls, ' + group[0].label;
        save();
        await yieldToBrowser();
        const groupStarted = performance.now();
        for (const {call, fixture, bilinear} of group) {
          const target = fixture.bitmap;
          let usedWasm;
          if (stage === 'affine')
            usedWasm = kernel.tryBurikoBitmapAffineWasm(
              target,
              fullSource,
              outputView,
              firstView,
              coordinates[call & 1],
              bilinear,
            );
          else if (stage === 'fused')
            usedWasm = kernel.tryBurikoBitmapFusedWasm(
              target,
              fullSource,
              fullSource,
              outputView,
              firstView,
              secondView,
              target.width,
              target.height,
              factors[call % factors.length],
              transparencies[call % transparencies.length],
            );
          else
            usedWasm = kernel.tryBurikoBitmapAlphaWasm(
              target,
              fullSource,
              outputView,
              firstView,
              target.width,
              target.height,
              call % 5 === 0 ? null : transparencies[call % transparencies.length],
            );
          if (!usedWasm) throw new Error(stage + ' did not execute WebAssembly');
          calls++;
        }
        kernelMs += performance.now() - groupStarted;
      } while (performance.now() - begin < 5000 && calls < 2048);
      performance.mark('bitmap-diagnostic-' + stage + '-end');
      record.results.push({
        stage,
        calls,
        elapsedMs: Math.round(performance.now() - begin),
        kernelMs: Math.round(kernelMs),
        checksum: checksum(outputBytes),
      });
    }
    record.status = 'passed';
    record.lastStage = 'complete';
    record.elapsedMs = Math.round(performance.now() - started);
    record.completedAt = new Date().toISOString();
    record.syntheticBufferBytes = buffers.reduce((sum, bytes) => sum + bytes.byteLength, 0);
    probe.state = 'complete';
    status.textContent = 'Completed. All requested calls used WebAssembly.';
    save();
  }
  button.addEventListener('click', () =>
    run()
      .catch(fail)
      .finally(() => {
        button.disabled = false;
      }),
  );
}

/** Serves one text page and five specific runtime modules, bound exclusively to loopback. */
export async function createBitmapWasmDiagnosticServer() {
  const routes = new Map();
  const hash = createHash('sha256');
  for (const path of modulePaths) {
    const bytes = await readFile(new URL('../dist/' + path, import.meta.url));
    hash.update(path).update(bytes);
    routes.set('/dist/' + path, {type: 'text/javascript; charset=utf-8', bytes});
  }
  const build = hash.digest('hex');
  routes.set('/diagnostic.js', {
    type: 'text/javascript; charset=utf-8',
    bytes: Buffer.from('(' + browserMain.toString() + ')();\n'),
  });
  routes.set('/health', {
    type: 'application/json; charset=utf-8',
    bytes: Buffer.from(JSON.stringify({ok: true, build, modules: modulePaths})),
  });
  routes.set('/', {
    type: 'text/html; charset=utf-8',
    bytes: Buffer.from(`<!doctype html>
<html lang="en"><meta charset="utf-8"><title>Synthetic bitmap WebAssembly diagnostic</title>
<body data-build="${build}">
<h1>Synthetic bitmap WebAssembly diagnostic</h1>
<p>This page exercises generated numeric buffers. It loads no game assets.</p>
<p>Start a Performance recording, then press Run. Each selected kernel runs for about five seconds.
Use ?case=affine, ?case=fused, ?case=alpha, or ?case=all for WebAssembly.
The separate ?case=canvas workload creates and discards small offscreen glyph canvases using a system font.
Reload after a tab crash to read the last saved stage.</p>
<button id="run" type="button">Run</button>
<p id="status">Ready.</p>
<h2>Environment</h2><pre id="environment"></pre>
<h2>Current result</h2><pre id="result">No run yet.</pre>
<h2>Previous saved run</h2><pre id="previous"></pre>
<script src="/diagnostic.js"></script></body></html>`),
  });
  return createServer((request, response) => {
    const headers = {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy':
        "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, {...headers, Allow: 'GET, HEAD'}).end();
      return;
    }
    let route;
    try {
      route = routes.get(new URL(request.url, 'http://127.0.0.1').pathname);
    } catch {
      response.writeHead(400, headers).end();
      return;
    }
    if (route === undefined) {
      response.writeHead(404, headers).end();
      return;
    }
    response.writeHead(200, {
      ...headers,
      'Content-Type': route.type,
      'Content-Length': route.bytes.length,
    });
    response.end(request.method === 'HEAD' ? undefined : route.bytes);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const port = args.length === 0 ? 8002 : args[0] === '--port' ? Number(args[1]) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535 || args.length > 2) {
    console.error(`Usage: node ${fileURLToPath(import.meta.url)} [--port 8002]`);
    process.exitCode = 1;
  } else {
    try {
      const server = await createBitmapWasmDiagnosticServer();
      server.on('error', (error) => {
        console.error(error.message);
        process.exitCode = 1;
      });
      server.listen(port, '127.0.0.1', () => {
        console.log(`Synthetic bitmap diagnostic: http://127.0.0.1:${port}/?case=all`);
      });
    } catch (error) {
      console.error(
        error.code === 'ENOENT'
          ? 'Runtime modules are missing; build the runtime first.'
          : error.message,
      );
      process.exitCode = 1;
    }
  }
}

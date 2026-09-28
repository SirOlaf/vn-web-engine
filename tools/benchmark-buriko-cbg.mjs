import {resolve} from 'node:path';
import {
  parseSyntheticBrowserOptions,
  runSyntheticBrowserProbe,
} from './lib/synthetic-browser-probe.mjs';

// Run against a pre-change dist copy with --runtime-root to retain an independent
// timing and parity baseline. No filesystem other than compiled JavaScript is served.
const args = process.argv.slice(2);
let runtimeRoot = resolve('dist');
const rootIndex = args.indexOf('--runtime-root');
if (rootIndex !== -1) {
  if (!args[rootIndex + 1] || args[rootIndex + 1].startsWith('--'))
    throw new Error('--runtime-root requires a compiled runtime directory');
  runtimeRoot = resolve(args[rootIndex + 1]);
  args.splice(rootIndex, 2);
}
const options = parseSyntheticBrowserOptions(args);

async function pageMain(_fixture, options) {
  const codec = await import('/runtime/formats/buriko/compressed-bg.js');
  const {randomByteGenerator} = await import('/runtime/formats/buriko/binary.js');
  const diagnostics = await import('/runtime/platform/runtime-performance.js');
  // Production decoding enters through the engine's Wasm stages; older baselines lack them.
  const engine = await import('/runtime/engines/buriko/native/compressed-bg-wasm.js').catch(
    () => null,
  );
  const asyncDecode =
    engine?.decodeBurikoCompressedBgLegacyAsync ?? codec.decodeCompressedBgLegacyAsync;
  const round = (value) => Math.round(value * 100) / 100;
  const varint = (value) => {
    const output = [];
    do {
      output.push((value & 127) | (value >= 128 ? 128 : 0));
      value >>>= 7;
    } while (value);
    return output;
  };
  function intermediate(size, pattern) {
    if (pattern === 'zero') return Uint8Array.from([0, ...varint(size)]);
    if (pattern === 'dense' || pattern === 'skewed') {
      const count = varint(size);
      const result = new Uint8Array(count.length + size);
      result.set(count);
      let state = 0x187341f9;
      for (let i = count.length; i < result.length; i++) {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        result[i] =
          pattern === 'skewed' ? ((state & 15) === 0 ? ((state >>> 16) & 3) + 2 : 1) : state >>> 24;
      }
      return result;
    }
    const result = [];
    let position = 0;
    while (position < size) {
      const count = Math.min(257, size - position);
      result.push(...varint(count));
      for (let i = 0; i < count; i++) result.push((position + i * 13 + 7) & 255);
      position += count;
      if (position === size) break;
      const zeros = Math.min(4093, size - position);
      result.push(...varint(zeros));
      position += zeros;
    }
    return Uint8Array.from(result);
  }
  function encoded(width, height, depth, payload, version = 1, frequencyWeights) {
    const frequencies = new Array(256).fill(0);
    for (const value of payload) frequencies[value]++;
    const codingFrequencies = frequencyWeights ?? frequencies;
    const table = Uint8Array.from(codingFrequencies.flatMap(varint));
    const tree = codec.frequencyTree(codingFrequencies);
    const codes = Array.from({length: 256}, () => []);
    const pending = [{node: tree.root, bits: []}];
    while (pending.length) {
      const {node, bits} = pending.pop();
      if (node < 256) codes[node] = bits;
      else
        tree.children[node].forEach((child, bit) =>
          pending.push({node: child, bits: [...bits, bit]}),
        );
    }
    let bitCount = 0;
    for (let i = 0; i < 256; i++) bitCount += frequencies[i] * codes[i].length;
    const bytes = new Uint8Array(48 + table.length + Math.ceil(bitCount / 8));
    const view = new DataView(bytes.buffer);
    bytes.set(new TextEncoder().encode('CompressedBG___\0'));
    view.setUint16(16, width, true);
    view.setUint16(18, height, true);
    view.setUint16(20, depth, true);
    view.setUint16(24, 3, true);
    view.setUint32(32, payload.length, true);
    view.setUint32(36, 1, true);
    view.setUint32(40, table.length, true);
    view.setUint16(46, version, true);
    const random = randomByteGenerator(1);
    for (let i = 0; i < table.length; i++) {
      bytes[44] = (bytes[44] + table[i]) & 255;
      bytes[45] ^= table[i];
      bytes[48 + i] = (table[i] + random()) & 255;
    }
    let bitPosition = (48 + table.length) * 8;
    for (const value of payload)
      for (const bit of codes[value]) {
        bytes[bitPosition >>> 3] |= bit << (7 - (bitPosition & 7));
        bitPosition++;
      }
    return bytes;
  }
  const make = (width, height, depth, pattern = 'dense', version = 1) =>
    encoded(width, height, depth, intermediate(width * height * (depth >>> 3), pattern), version);
  function buffers(input, layout = 'separate') {
    const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
    const depth = view.getUint16(20, true);
    const size =
      16 + view.getUint16(16, true) * view.getUint16(18, true) * (depth === 24 ? 4 : depth >>> 3);
    const shift = layout === 'unaligned' ? 1 : 0;
    const bytes = new Uint8Array(size + shift).fill(0xa5).subarray(shift);
    const initialized = new Uint8Array(size).fill(0x59);
    if (layout === 'mask-alias')
      return {input: input.slice(), destination: {bytes, initialized: bytes}, backing: bytes};
    if (layout === 'mask-overlap') {
      const backing = new Uint8Array(size + 7).fill(0xa5);
      return {
        input: input.slice(),
        destination: {bytes: backing.subarray(0, size), initialized: backing.subarray(7)},
        backing,
      };
    }
    if (layout === 'source-overlap') {
      const backing = new Uint8Array(Math.max(input.length, size + 16)).fill(0xa5);
      backing.set(input);
      return {
        input: backing.subarray(0, input.length),
        destination: {bytes: backing.subarray(16, 16 + size), initialized},
        backing,
      };
    }
    return {
      input: input.slice(),
      destination: {
        bytes: layout === 'short-destination' ? bytes.subarray(1) : bytes,
        initialized: layout === 'short-mask' ? initialized.subarray(1) : initialized,
      },
      backing: bytes,
    };
  }
  async function digest(bytes) {
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return Array.from(hash, (value) => value.toString(16).padStart(2, '0')).join('');
  }
  function assertEqual(a, b, label) {
    if (a.length !== b.length) throw new Error(label + ' length differs');
    for (let i = 0; i < a.length; i++)
      if (a[i] !== b[i]) throw new Error(label + ' differs at ' + i);
  }
  function sameImage(a, b, label) {
    for (const field of ['width', 'height', 'bitDepth', 'flags'])
      if (a[field] !== b[field]) throw new Error(label + ' ' + field + ' differs');
    assertEqual(a.header, b.header, label + ' header');
    assertEqual(a.pixels, b.pixels, label + ' pixels');
  }
  function runSync(state) {
    try {
      return {image: codec.decodeCompressedBgLegacy(state.input, state.destination), error: null};
    } catch (error) {
      return {image: null, error: error.name + ': ' + error.message};
    }
  }
  async function runAsync(state) {
    try {
      return {image: await asyncDecode(state.input, state.destination), error: null};
    } catch (error) {
      return {image: null, error: error.name + ': ' + error.message};
    }
  }
  async function measure(input, mode, heartbeat = false) {
    const state = buffers(input);
    let resumes = 0;
    let timerTicks = 0,
      portTicks = 0,
      timerMaxGap = 0,
      portMaxGap = 0,
      timerLastAt = performance.now(),
      portLastAt = timerLastAt,
      timer,
      messages;
    if (heartbeat) {
      messages = new MessageChannel();
      messages.port1.onmessage = () => {
        const now = performance.now();
        portTicks++;
        portMaxGap = Math.max(portMaxGap, now - portLastAt);
        portLastAt = now;
      };
      const tick = () => {
        const now = performance.now();
        timerTicks++;
        timerMaxGap = Math.max(timerMaxGap, now - timerLastAt);
        timerLastAt = now;
        messages.port2.postMessage(null);
        timer = setTimeout(tick, 0);
      };
      messages.port2.postMessage(null);
      timer = setTimeout(tick, 0);
    }
    diagnostics.startRuntimePerformanceRecording();
    const startedAt = performance.now();
    const image =
      mode === 'sync'
        ? codec.decodeCompressedBgLegacy(state.input, state.destination)
        : await asyncDecode(state.input, state.destination, () => resumes++);
    const wallMs = performance.now() - startedAt;
    diagnostics.stopRuntimePerformanceRecording();
    if (heartbeat) {
      clearTimeout(timer);
      messages.port1.close();
      messages.port2.close();
      if (resumes > 1 && (!timerTicks || !portTicks))
        throw new Error('Cooperative decode starved queued timer or MessagePort callbacks');
    }
    const snapshot = diagnostics.getRuntimePerformanceSnapshot();
    const slices = snapshot.aggregates.find((entry) => entry.name === 'host.cooperative.slice');
    return {
      wallMs: round(wallMs),
      phases: snapshot.aggregates
        .filter((entry) => entry.name.startsWith('buriko.decode.cbg.'))
        .map(({name, count, total, max}) => ({name, count, totalMs: total, maxMs: max})),
      sliceCount: slices?.count ?? 1,
      sliceTotalMs: slices?.total ?? round(wallMs),
      sliceMaxMs: slices?.max ?? round(wallMs),
      hostYields: Math.max(0, resumes - 1),
      pixelsSha256: await digest(image.pixels),
      ...(heartbeat
        ? {
            heartbeat: {
              timerCallbacksBeforeCompletion: timerTicks,
              messageCallbacksBeforeCompletion: portTicks,
              timerMaxGapMs: round(timerMaxGap),
              messageMaxGapMs: round(portMaxGap),
            },
          }
        : {}),
    };
  }
  const workloads = options.smoke
    ? [{name: 'smoke-rgba', width: 512, height: 384, depth: 32, pattern: 'dense'}]
    : [
        {name: 'large-rgba-dense', width: 2790, height: 2056, depth: 32, pattern: 'dense'},
        {name: 'large-rgba-skewed', width: 2790, height: 2056, depth: 32, pattern: 'skewed'},
        {name: 'large-rgb-runs', width: 2048, height: 1536, depth: 24, pattern: 'runs'},
        {name: 'large-rgba-zero', width: 2790, height: 2056, depth: 32, pattern: 'zero'},
      ];
  const performanceResults = [];
  let borrowInput;
  for (const workload of workloads) {
    const input = make(workload.width, workload.height, workload.depth, workload.pattern);
    if (borrowInput === undefined) borrowInput = input;
    const first = {sync: await measure(input, 'sync')};
    if (asyncDecode) first.async = await measure(input, 'async', performanceResults.length === 0);
    const warmed = {sync: [], async: []};
    for (let iteration = 0; iteration < options.iterations; iteration++) {
      warmed.sync.push(await measure(input, 'sync'));
      if (asyncDecode) warmed.async.push(await measure(input, 'async'));
    }
    const expected = first.sync.pixelsSha256;
    for (const sample of [...Object.values(first), ...warmed.sync, ...warmed.async])
      if (sample.pixelsSha256 !== expected) throw new Error(workload.name + ' output differs');
    performanceResults.push({...workload, inputBytes: input.length, first, warmed});
  }
  const cases = [];
  for (const depth of [8, 16, 24, 32, 48])
    for (const pattern of ['dense', 'runs', 'zero', 'skewed'])
      cases.push({name: 'depth-' + depth + '-' + pattern, input: make(53, 31, depth, pattern)});
  for (const layout of ['unaligned', 'mask-alias', 'mask-overlap', 'source-overlap'])
    for (const depth of [24, 32])
      cases.push({name: 'depth-' + depth + '-' + layout, input: make(53, 31, depth), layout});
  // The decoder accepts arbitrary frequency weights. Fibonacci weights force
  // valid codes deeper than the sixteen-bit prefix without an enormous payload.
  const longPayload = new Uint8Array(65539);
  longPayload.set(varint(65536));
  for (let i = 3; i < longPayload.length; i++) longPayload[i] = (i % 20) + 1;
  const longWeights = new Array(256).fill(0);
  let previous = 1,
    current = 1;
  for (const symbol of new Set(longPayload)) {
    longWeights[symbol] = previous;
    [previous, current] = [current, previous + current];
  }
  const longInput = encoded(256, 256, 8, longPayload, 1, longWeights);
  cases.push(
    {name: 'long-codes', input: longInput},
    {name: 'fault-long-codes-truncated', input: longInput.subarray(0, longInput.length - 3)},
  );
  cases.push({name: 'legacy-version-7', input: make(53, 31, 32, 'dense', 7)});
  const valid = make(53, 31, 32);
  const checksum = valid.slice();
  checksum[44] ^= 1;
  const singleton = encoded(1, 1, 8, Uint8Array.of(0));
  singleton[singleton.length - 1] = 0x80;
  cases.push(
    {name: 'fault-checksum', input: checksum},
    {name: 'fault-truncated-table', input: valid.subarray(0, 100)},
    {name: 'fault-truncated-entropy', input: valid.subarray(0, valid.length - 10)},
    {name: 'fault-singleton-branch', input: singleton},
    {name: 'fault-residual-size', input: encoded(2, 1, 32, Uint8Array.of(0, 7))},
    {name: 'fault-residual-overflow', input: encoded(2, 1, 32, Uint8Array.of(0, 9))},
    {name: 'fault-truncated-varint', input: encoded(2, 1, 32, Uint8Array.of(128))},
    {name: 'fault-truncated-literal', input: encoded(2, 1, 32, Uint8Array.of(8, 1))},
    {name: 'fault-short-destination', input: valid, layout: 'short-destination'},
    {name: 'fault-short-mask', input: valid, layout: 'short-mask'},
  );
  const casesDetail = [];
  for (const fixture of cases) {
    const syncState = buffers(fixture.input, fixture.layout);
    const sync = runSync(syncState);
    if (asyncDecode) {
      const asyncState = buffers(fixture.input, fixture.layout);
      const async = await runAsync(asyncState);
      if (async.error !== sync.error) throw new Error(fixture.name + ' fault differs');
      if (sync.image) sameImage(sync.image, async.image, fixture.name);
      assertEqual(syncState.backing, asyncState.backing, fixture.name + ' backing');
      assertEqual(
        syncState.destination.initialized,
        asyncState.destination.initialized,
        fixture.name + ' initialized',
      );
      assertEqual(syncState.input, asyncState.input, fixture.name + ' source');
    }
    casesDetail.push({
      name: fixture.name,
      error: sync.error,
      header: sync.image ? Array.from(sync.image.header) : null,
      pixelsSha256: sync.image ? await digest(sync.image.pixels) : null,
      backingSha256: await digest(syncState.backing),
      initializedSha256: await digest(syncState.destination.initialized),
      sourceSha256: await digest(syncState.input),
    });
  }
  let borrowInvalidation = null;
  if (asyncDecode) {
    const state = buffers(options.smoke ? make(2048, 1536, 32) : borrowInput);
    const invalidated = new Error('Synthetic borrowed storage invalidation');
    let resumes = 0,
      stoppedBytes,
      stoppedInitialized,
      caught;
    try {
      await asyncDecode(state.input, state.destination, () => {
        if (++resumes === 2) {
          stoppedBytes = state.destination.bytes.slice();
          stoppedInitialized = state.destination.initialized.slice();
          throw invalidated;
        }
      });
    } catch (error) {
      caught = error;
    }
    if (caught !== invalidated || resumes !== 2)
      throw new Error('Borrow invalidation did not stop the first host resumption');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEqual(state.destination.bytes, stoppedBytes, 'Invalidated destination');
    assertEqual(state.destination.initialized, stoppedInitialized, 'Invalidated mask');
    borrowInvalidation = {passed: true, resumes, noWritesAfterInvalidation: true};
  }
  return {
    available: true,
    generatedInputsOnly: true,
    asyncAvailable: typeof asyncDecode === 'function',
    measurement:
      'Milliseconds. First is the first measured invocation of each mode per workload; warmed samples follow. Setup, output hashing and caller allocation are excluded. Async wall time includes host scheduling waits. Slice time uses shared runtime diagnostics. Decode phase spans include host scheduling waits. Compare casesDetail and pixel hashes against a pre-change --runtime-root report for independent parity.',
    performance: performanceResults,
    parity: {
      cases: casesDetail.length,
      passed: true,
      comparedAsync: !!asyncDecode,
      borrowInvalidation,
      casesDetail,
    },
  };
}

await runSyntheticBrowserProbe({options, pageMain, runtimeRoot, name: 'vn-cbg-generated'});
